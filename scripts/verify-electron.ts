/**
 * 端到端自检：真实 Electron + 真实 preload + 真实 IPC + 真实磁盘。
 *
 * 为什么需要它（另外两个脚本都覆盖不到这条链路）：
 *   - 浏览器预览版（preview/）验证的是「界面 + mock 后端」，链路里没有 IPC；
 *   - verify:store 验证的是「数据层」，链路里没有渲染进程和 preload。
 *   「渲染进程 → contextBridge → IPC → 主进程 → 磁盘 → 再读回渲染进程」
 *   只有真的把 Electron 跑起来才能验。本脚本用**隐藏窗口**跑通它，
 *   不需要可见 GUI，因此可以无人值守执行。
 *
 * 数据全部写在临时 userData 目录，绝不触碰真实应用数据。
 *
 * 运行：npm run verify:electron
 * 退出码：0 全部通过 / 1 有失败项
 */
import { app, BrowserWindow, dialog } from 'electron'
import { mkdtempSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  DB,
  DeleteItemResult,
  DeleteRecordResult,
  ImportResult,
  RenameItemResult,
  ReorderItemsResult,
  SetNoteResult,
  SetQuantityResult,
  SetUnitResult,
  TransactionResult
} from '@shared/types'
import { QUANTITY_EDIT_PASSWORD } from '@shared/utils'
import { registerIpcHandlers } from '../src/main/ipc'
import { getDataFilePath, getLoadReport, initStore, load } from '../src/main/store/db'

let passed = 0
let failed = 0
const failures: string[] = []

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    console.log(`  \u2713 ${label}`)
  } else {
    failed++
    failures.push(label + (detail ? ` \u2014 ${detail}` : ''))
    console.log(`  \u2717 ${label}${detail ? ` \u2014 ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n${title}`)
}

/** 临时 userData —— 必须在 app ready 之前设置 */
const dataDir = mkdtempSync(join(tmpdir(), 'wh-electron-test-'))
app.setPath('userData', dataDir)

// 无头/受限环境下 Chromium 的子进程沙箱和 GPU 进程起不来
// （GPU 进程会以 exit_code=6 反复崩溃，最终 FATAL 拖垮整个进程）。
// 本脚本只做数据链路验证，不渲染像素，因此关掉硬件加速与子进程沙箱。
// 这些开关必须在 app ready 之前设置。
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-sandbox')
app.commandLine.appendSwitch('disable-software-rasterizer')
app.commandLine.appendSwitch('disable-dev-shm-usage')

const dataFile = join(dataDir, 'data.json')
const bakFile = `${dataFile}.bak`
const exportFile = join(dataDir, 'export-probe.xlsx')

const rendererErrors: string[] = []
let win: BrowserWindow | null = null

function makeWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1180,
    height: 800,
    show: false, // 隐藏：无需 GUI 也能跑
    webPreferences: {
      preload: join(__dirname, 'preload/index.js'),
      sandbox: false
    }
  })
  // Electron 新版把 console 信息包在 details 对象里，旧版是位置参数 —— 两种都兼容，
  // 免得升级 Electron 时这段静默失效（静默失效比报错更糟：会假装「零错误」）
  const wc = w.webContents as unknown as {
    on: (ev: string, cb: (...args: unknown[]) => void) => void
  }
  wc.on('console-message', (...args: unknown[]) => {
    const second = args[1] as { level?: string; message?: string } | number
    let level: string
    let message: string
    if (second && typeof second === 'object') {
      level = String(second.level ?? '')
      message = String(second.message ?? '')
    } else {
      level = Number(second) >= 3 ? 'error' : Number(second) >= 2 ? 'warning' : 'info'
      message = String(args[2] ?? '')
    }
    if (level === 'error') rendererErrors.push(message)
  })
  wc.on('render-process-gone', (...args: unknown[]) => {
    const details = args[1] as { reason?: string }
    rendererErrors.push(`render-process-gone: ${details?.reason ?? '未知'}`)
  })
  return w
}

function evalIn<T>(w: BrowserWindow, expr: string): Promise<T> {
  return w.webContents.executeJavaScript(expr, true) as Promise<T>
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (await fn()) return true
    } catch {
      /* 页面还没就绪，继续等 */
    }
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 80))
  }
}

/** 起窗口 → 载入真实构建产物 → 等 preload 注入 → 等 React 挂载 */
async function openWindow(): Promise<BrowserWindow> {
  const w = makeWindow()
  await w.loadFile(join(__dirname, 'renderer/index.html'))
  const injected = await waitFor(() => evalIn<boolean>(w, 'typeof window.api === "object"'))
  if (!injected) throw new Error('preload 未注入 window.api')
  const mounted = await waitFor(() =>
    evalIn<boolean>(w, '(document.querySelector("#root")?.childElementCount ?? 0) > 0')
  )
  if (!mounted) throw new Error('React 未挂载')
  return w
}

/**
 * 仓库页第一行，返回 `{ 表头名: 单元格值 }`。
 *
 * 刻意不用下标取值：加一列就会让所有下标**静默错位**。
 * 新增「警戒值」列时就是这样让 4 处断言同时失效的，
 * 而且报出来的是「值不对」，看不出根因是列错位，排查很费时间。
 *
 * 表头名本身也会随内容变化（「本月入库（9月）」带月份、「单位（已锁定）」带锁定标记），
 * 所以统一去掉括号内容作为规范名。
 */
function firstRow(w: BrowserWindow): Promise<Record<string, string>> {
  return evalIn<Record<string, string>>(
    w,
    `(() => {
       const tr = document.querySelector("tbody tr")
       if (!tr) return {}
       const ths = [...tr.closest("table").querySelectorAll("thead th")]
       const out = {}
       ths.forEach((th, i) => {
         const key = th.textContent.trim().replace(/（[^）]*）|\\([^)]*\\)/g, "").trim()
         const td = tr.querySelectorAll("td")[i]
         if (!td) return
         // 警戒值单元格里是 <input>，textContent 恒为空串，必须读 .value
         const input = td.querySelector("input")
         out[key] = input ? input.value : (td.textContent ?? "").trim()
       })
       return out
     })()`
  )
}

/**
 * 今天（本地时区）的 `YYYY-MM-DD`。
 *
 * 第 3~7 节的测试数据**必须落在当前月**：那几节要验仓库页的
 * 「本月入库 / 本月出库」两列，而「本月」是相对今天算的。
 * 原来这些数据写死成 `2026-09-19` —— 一进 10 月，「本月」就成了空，
 * 两条断言必然变红，而报出来的是「本月入库 = —」，看着像统计功能坏了。
 */
function todayStr(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 把 { 表头名: 值 } 打成一行，失败信息里能看清到底取到了什么 */
function rowText(row: Record<string, string>): string {
  const keys = Object.keys(row)
  if (keys.length === 0) return '(没有这一行)'
  return keys.map((k) => `${k}=${row[k]}`).join(' / ')
}

/** 数量单元格是否带负库存高亮 */
function quantityIsNegative(w: BrowserWindow): Promise<boolean> {
  return evalIn<boolean>(w, 'Boolean(document.querySelector("tbody tr td.num.negative"))')
}

async function readJSON(path: string): Promise<DB> {
  return JSON.parse(await readFile(path, 'utf8')) as DB
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

const TX = (o: Record<string, unknown>): string => `window.api.applyTransaction(${JSON.stringify(o)})`

async function run(): Promise<void> {
  // ── 1. 冷启动 ────────────────────────────────────────────────
  section('1. 冷启动：真实主进程加载数据')
  initStore(app.getPath('userData'))
  let loadErr: string | null = null
  try {
    await load()
  } catch (e) {
    loadErr = e instanceof Error ? e.message : String(e)
  }
  check('首次启动 load() 不抛异常', loadErr === null, loadErr ?? '')
  check('首次启动未标记「已从备份恢复」', getLoadReport().recoveredFromBackup === false)
  check('数据文件落在临时 userData 内', getDataFilePath() === dataFile, getDataFilePath())
  check('首次启动时数据文件尚不存在', (await fileExists(dataFile)) === false)

  registerIpcHandlers()

  // 导出要弹保存对话框，会把自动化卡住 —— 换成固定路径才能验
  ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async (): Promise<{
    filePath: string
    canceled: boolean
  }> => ({ filePath: exportFile, canceled: false })

  // ── 2. 桥接 ──────────────────────────────────────────────────
  section('2. 真实窗口：contextBridge + IPC 往返')
  win = await openWindow()
  const pong = await evalIn<string>(win, 'window.api.ping()')
  check('IPC 往返 ping → pong', pong === 'pong', `实际 ${pong}`)
  const dataPathFromPage = await evalIn<string>(win, 'window.api.getDataPath()')
  check('界面拿到的数据路径与主进程一致', dataPathFromPage === dataFile, dataPathFromPage)

  const headerBtns = await evalIn<string>(
    win,
    '[...document.querySelectorAll("header button")].map(b => b.textContent || "").join("|")'
  )
  check('头部「打开数据文件夹」按钮已渲染', headerBtns.includes('打开数据文件夹'), headerBtns)

  /*
   * 原来这条读的是标题旁那行「主进程通道正常（返回 pong）」。
   * 2026-10-02 把那行小字隐藏了（用户不需要看），所以改成**直接探桥接本身** ——
   * 比「看界面上有没有字」更接近真正要验的东西。
   */
  // ping() 返回 Promise，得 await 之后才能拿到 'pong' 这个字符串
  const pingOk = await waitFor(async () =>
    (await evalIn<string>(win!, '(async () => String(await window.api.ping()))()')).includes('pong')
  )
  check('渲染进程能调到主进程（ping 返回 pong）', pingOk)
  const bridgeText = await evalIn<string>(
    win,
    'document.querySelector(".bridge-status")?.textContent ?? ""'
  )
  check('正常状态下标题旁不显示状态小字', bridgeText === '', JSON.stringify(bridgeText))

  // ── 3. 从界面提交 → 落盘 ─────────────────────────────────────
  // 本脚本的账目（后续断言都按这张表推）：
  //   #1 入库 100        → 100
  //   #2 入库  50（单位填「箱」，应被锁为「个」）→ 150
  //   #3 出库 200        → -50   （负库存，仅警告）
  //   #4 入库  10        → -40
  //   #5 入库   5        → -35
  //   #6 撤销 #3         → 165
  section('3. 经 IPC 提交入库 → 真实落盘')
  const t1 = await evalIn<TransactionResult>(
    win,
    TX({ time: `${todayStr()}T10:00`, name: 'M3×8 螺丝', quantity: 100, unit: '个', operator: '张三', handler: '赵六', type: 'in' })
  )
  check('入库返回 ok', t1.ok === true, t1.ok ? '' : t1.error)
  check('库存 = 100', t1.ok && t1.item.quantity === 100, t1.ok ? `${t1.item.quantity}` : '')
  check('操作人快照 = 张三', t1.ok && t1.record.operator === '张三')
  check('经手人快照 = 赵六', t1.ok && t1.record.handler === '赵六', t1.ok ? JSON.stringify(t1.record.handler) : '')
  check('data.json 已写入磁盘', await fileExists(dataFile))
  const onDisk1 = await readJSON(dataFile)
  check('磁盘上记录数 = 1', onDisk1.records.length === 1, `${onDisk1.records.length}`)
  check('磁盘上物品数 = 1', onDisk1.items.length === 1, `${onDisk1.items.length}`)
  // 快照字段要真落盘，不能只活在返回值和内存里
  check(
    '经手人已落盘（磁盘上 handler = 赵六）',
    onDisk1.records[0]?.handler === '赵六',
    JSON.stringify(onDisk1.records[0]?.handler)
  )

  // ── 4. 单位锁定 ──────────────────────────────────────────────
  section('4. 单位锁定经 IPC 生效')
  const t2 = await evalIn<TransactionResult>(
    win,
    TX({ time: `${todayStr()}T11:00`, name: 'M3×8 螺丝', quantity: 50, unit: '箱', operator: '李四', type: 'in' })
  )
  check('第二笔入库 ok', t2.ok === true, t2.ok ? '' : t2.error)
  check('单位被锁定为「个」而非「箱」', t2.ok && t2.item.unit === '个', t2.ok ? t2.item.unit : '')
  check('库存累加到 150', t2.ok && t2.item.quantity === 150, t2.ok ? `${t2.item.quantity}` : '')

  // ── 5. 负库存警告 ────────────────────────────────────────────
  section('5. 负库存只警告不阻断')
  const t3 = await evalIn<TransactionResult>(
    win,
    TX({ time: `${todayStr()}T12:00`, name: 'M3×8 螺丝', quantity: 200, unit: '个', operator: '王五', handler: '孙八', type: 'out' })
  )
  check('出库 200 仍成功', t3.ok === true, t3.ok ? '' : t3.error)
  check('库存变为 -50', t3.ok && t3.item.quantity === -50, t3.ok ? `${t3.item.quantity}` : '')
  check('返回了负库存提示', t3.ok && Boolean(t3.warning), t3.ok ? String(t3.warning) : '')
  // 出库走的是**同一个 handler 字段**，只是语义从「经手人」变成「领取人」
  check('出库的领取人也落在 handler 字段上', t3.ok && t3.record.handler === '孙八', t3.ok ? JSON.stringify(t3.record.handler) : '')

  // ── 6. 变更广播 ──────────────────────────────────────────────
  section('6. 数据变更广播到渲染进程')
  await evalIn<void>(
    win,
    `(() => { window.__chg = 0; window.__sub = window.api.onChanged(() => { window.__chg++ }) })()`
  )
  await evalIn<TransactionResult>(
    win,
    TX({ time: `${todayStr()}T13:00`, name: 'M3×8 螺丝', quantity: 10, unit: '个', type: 'in' })
  )
  await new Promise((r) => setTimeout(r, 250))
  const chgAfter = await evalIn<number>(win, 'window.__chg')
  check('提交后订阅者收到变更通知', chgAfter >= 1, `收到 ${chgAfter} 次`)

  await evalIn<void>(win, '(() => { window.api.offChanged(window.__sub); window.__chg = 0 })()')
  await evalIn<TransactionResult>(
    win,
    TX({ time: `${todayStr()}T14:00`, name: 'M3×8 螺丝', quantity: 5, unit: '个', type: 'in' })
  )
  await new Promise((r) => setTimeout(r, 250))
  const chgAfterOff = await evalIn<number>(win, 'window.__chg')
  check('取消订阅后不再收到通知', chgAfterOff === 0, `收到 ${chgAfterOff} 次`)

  // ── 7. 界面随广播自动刷新 ────────────────────────────────────
  section('7. 界面自动刷新（无需手动切页）')
  const rowReady = await waitFor(async () => (await firstRow(win!))['名称'] === 'M3×8 螺丝')
  check('仓库页自动出现该物品', rowReady)
  const cells = await firstRow(win)
  check('数量单元格 = -35', cells['数量'] === '-35', rowText(cells))
  check('单位单元格 = 个（单位锁定生效）', cells['单位'] === '个', rowText(cells))
  // 警戒值单元格里是 <input>，textContent 恒为空串 —— firstRow 内部已改为读 .value，
  // 直接用 textContent 比会得到一个假失败（这个坑踩过一次）。
  check('新物品警戒值默认为 100', cells['警戒值'] === '100', rowText(cells))
  check('本月入库 = +165', cells['本月入库'] === '+165', rowText(cells))
  check('本月出库 = -200', cells['本月出库'] === '-200', rowText(cells))
  check('负库存带高亮类名', await quantityIsNegative(win))

  // ── 8. 撤销反向冲销 ──────────────────────────────────────────
  section('8. 撤销经 IPC 反向冲销')
  const snapBefore = await evalIn<DB>(win, 'window.api.getSnapshot()')
  const outRec = snapBefore.records.find((r) => r.type === 'out')
  check('找到那笔出库记录', Boolean(outRec))
  // 撤销自 2026-10-02 起要口令 —— 先验「绕过界面、口令不对」这条路被拒
  const undoBad = await evalIn<DeleteRecordResult>(
    win,
    `window.api.deleteRecord(${JSON.stringify(outRec?.id ?? '')}, "000000")`
  )
  check(
    '撤销：口令错 → 绕过界面同样被拒',
    undoBad.ok === false && undoBad.wrongPassword === true,
    JSON.stringify(undoBad)
  )
  check('口令错 → 磁盘上记录还在', (await readJSON(dataFile)).records.length === 5)

  const del = await evalIn<DeleteRecordResult>(
    win,
    `window.api.deleteRecord(${JSON.stringify(outRec?.id ?? '')}, ${JSON.stringify(QUANTITY_EDIT_PASSWORD)})`
  )
  check('撤销返回 ok', del.ok === true, del.ok ? '' : del.error)
  check('库存回到 165（-35 + 200）', del.ok && del.item?.quantity === 165, del.ok ? `${del.item?.quantity}` : '')
  const onDiskAfterUndo = await readJSON(dataFile)
  check('磁盘上该记录已移除', onDiskAfterUndo.records.every((r) => r.id !== outRec?.id))
  const uiAfterUndo = await waitFor(async () => (await firstRow(win!))['数量'] === '165')
  check('界面同步显示 165', uiAfterUndo, rowText(await firstRow(win)))
  check('负库存高亮随之消失', (await quantityIsNegative(win)) === false)

  // ── 9. 导出 ──────────────────────────────────────────────────
  section('9. 导出 Excel 经 IPC 由主进程写盘')
  const exp = await evalIn<{ ok: boolean; path?: string }>(
    win,
    `window.api.exportXlsx([80, 75, 3, 4], "库存导出.xlsx")`
  )
  check('导出返回 ok', exp.ok === true)
  check('主进程确实写出了文件', await fileExists(exportFile))
  const bytes = await readFile(exportFile)
  check('写入内容与传入字节一致', bytes.length === 4 && bytes[0] === 80 && bytes[3] === 4)

  ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async (): Promise<{
    filePath: undefined
    canceled: boolean
  }> => ({ filePath: undefined, canceled: true })
  const expCancel = await evalIn<{ ok: boolean; cancelled?: boolean }>(
    win,
    `window.api.exportXlsx([1], "x.xlsx")`
  )
  check('用户取消保存时返回 cancelled', expCancel.ok === false && expCancel.cancelled === true)

  // ── 10. 模拟重启 ─────────────────────────────────────────────
  section('10. 模拟重启：数据从磁盘读回')
  win.destroy()
  win = null
  initStore(dataDir) // 清空内存缓存，强制走磁盘
  await load()
  check('重启后未标记「已从备份恢复」', getLoadReport().recoveredFromBackup === false)
  const reloaded = await readJSON(dataFile)
  check('磁盘记录数 = 4（5 笔中撤销掉 1 笔）', reloaded.records.length === 4, `${reloaded.records.length}`)
  check('磁盘库存 = 165', reloaded.items[0]?.quantity === 165, `${reloaded.items[0]?.quantity}`)

  win = await openWindow()
  const persisted = await waitFor(async () => (await firstRow(win!))['数量'] === '165')
  check('重启后界面显示持久化的 165', persisted, rowText(await firstRow(win)))
  const persistedRows = await evalIn<number>(win, 'document.querySelectorAll("tbody tr").length')
  check('重启后界面只有 1 行物品', persistedRows === 1, `${persistedRows}`)
  const noBanner = await evalIn<boolean>(win, '!document.querySelector(".warn-banner")')
  check('正常启动不显示恢复提示条', noBanner)

  // ── 11. 损坏恢复 ─────────────────────────────────────────────
  section('11. 主文件损坏 → 从备份恢复（真实启动路径）')
  const goodBak = await readFile(bakFile, 'utf8')
  await writeFile(dataFile, '这不是 JSON { 坏掉了')
  win.destroy()
  win = null
  initStore(dataDir)
  let recoverErr: string | null = null
  try {
    await load()
  } catch (e) {
    recoverErr = e instanceof Error ? e.message : String(e)
  }
  check('恢复成功时 load() 不抛异常（原缺陷会让应用起不来）', recoverErr === null, recoverErr ?? '')
  check('loadReport 标记「已从备份恢复」', getLoadReport().recoveredFromBackup === true)

  const restoredRaw = await readFile(dataFile, 'utf8')
  let restoredValid = false
  try {
    JSON.parse(restoredRaw)
    restoredValid = true
  } catch {
    /* 保持 false */
  }
  check('恢复后 data.json 是合法 JSON', restoredValid)
  const bakAfter = await readFile(bakFile, 'utf8')
  check('好备份未被损坏的主文件覆盖（原缺陷会毁掉备份）', bakAfter === goodBak)
  const restored = await readJSON(dataFile)
  check('恢复后记录数 = 5（备份是撤销前的状态）', restored.records.length === 5, `${restored.records.length}`)
  check('恢复后库存 = -35，确实回退了最后一次操作', restored.items[0]?.quantity === -35, `${restored.items[0]?.quantity}`)
  check('恢复后那笔已撤销的出库又回来了', restored.records.some((r) => r.type === 'out'))

  win = await openWindow()
  const bannerShown = await waitFor(() => evalIn<boolean>(win!, 'Boolean(document.querySelector(".warn-banner"))'))
  check('界面显示「已从备份恢复」提示条', bannerShown)
  const bannerText = await evalIn<string>(win, 'document.querySelector(".warn-banner")?.textContent ?? ""')
  check('提示条文案说明了风险', bannerText.includes('可能丢失最后一次操作'), bannerText.replace(/\s+/g, ' ').trim())
  const recoveredQty = await waitFor(async () => (await firstRow(win!))['数量'] === '-35')
  check('界面显示的是恢复后的 -35', recoveredQty, rowText(await firstRow(win)))

  // ── 12. 主文件与备份都坏 ─────────────────────────────────────
  section('12. 主文件与备份都不可用 → 明确报错而非静默空库')
  win.destroy()
  win = null
  await writeFile(dataFile, '坏掉了')
  await writeFile(bakFile, '也坏掉了')
  initStore(dataDir)
  let bothErr = ''
  try {
    await load()
  } catch (e) {
    bothErr = e instanceof Error ? e.message : String(e)
  }
  check('确实抛出了错误', bothErr !== '')
  check('错误信息说明是数据文件损坏', bothErr.includes('数据文件损坏'), bothErr.replace(/\s+/g, ' ').slice(0, 80))
  check('错误信息给出了两个路径', bothErr.includes(dataFile) && bothErr.includes(bakFile))

  // ── 13. 改名经 IPC（独立数据目录） ───────────────────────────
  /*
   * 这一节**刻意另开一个数据目录**，不和前面共用。
   *
   * 原因是改名要写盘，而每次写盘都会轮转 `.bak` —— 第 11 节的前提是
   * 「备份 = 撤销前的状态」，一旦被搅动，那一整组恢复断言就会以「值不对」的
   * 形式变红，完全看不出根因是这里多写了一次。
   * （第一版把本节插在第 8 节之后就正是这么挂的：记录数 4→5、库存 165→172。）
   *
   * 这一节也是**唯一**验得到「db:renameItem 这条通道真的接上了」的地方：
   * verify:ui 跑的是预览版的内存 mock（preview/mock.ts），
   * 通道名写错、主进程忘了注册 handler、preload 没暴露 —— 那边**全都是绿的**。
   */
  section('13. 重命名经 IPC 落到磁盘')
  const rnDir = mkdtempSync(join(tmpdir(), 'wm-rename-'))
  initStore(rnDir)
  await load()
  win = await openWindow()
  const rnDataFile = getDataFilePath()

  const seedA1 = await evalIn<TransactionResult>(
    win,
    TX({ time: '2026-09-20T09:00', name: '改名甲', quantity: 10, unit: '个', type: 'in' })
  )
  const seedA2 = await evalIn<TransactionResult>(
    win,
    TX({ time: '2026-09-20T09:30', name: '改名甲', quantity: 5, unit: '个', type: 'in' })
  )
  const seedB = await evalIn<TransactionResult>(
    win,
    TX({ time: '2026-09-20T10:00', name: '改名乙', quantity: 7, unit: '盒', type: 'in' })
  )
  check('铺好改名用的数据（甲 2 条、乙 1 条）', seedA1.ok && seedA2.ok && seedB.ok)
  if (!seedA1.ok || !seedB.ok) throw new Error('改名用例的前置数据没造出来')
  const rnItemAId = seedA1.item.id
  const rnItemBId = seedB.item.id

  // 单纯改名
  const rn1 = await evalIn<RenameItemResult>(
    win,
    `window.api.renameItem(${JSON.stringify(rnItemAId)}, "改名甲·新")`
  )
  check('改名经 IPC 返回 ok', rn1.ok === true, rn1.ok ? '' : rn1.error)
  check('标记为「不是合并」', rn1.ok && rn1.merged === false)
  check(
    '该物品的 2 条历史记录名称快照一起改了',
    rn1.ok && rn1.renamedRecords === 2,
    rn1.ok ? `${rn1.renamedRecords}` : ''
  )
  check('数量不受改名影响（10 + 5）', rn1.ok && rn1.item.quantity === 15, rn1.ok ? `${rn1.item.quantity}` : '')

  const rnDisk1 = await readJSON(rnDataFile)
  check('磁盘上物品名已更新', rnDisk1.items.some((i) => i.name === '改名甲·新'))
  check(
    '磁盘上旧名字的记录一条不剩',
    rnDisk1.records.every((r) => r.name !== '改名甲'),
    rnDisk1.records.map((r) => r.name).join('/')
  )
  check('改名不写新流水（磁盘记录数仍是 3）', rnDisk1.records.length === 3, `${rnDisk1.records.length}`)
  check(
    '界面同步显示新名字（改名广播到了渲染进程）',
    await waitFor(async () => (await firstRow(win!))['名称'] === '改名甲·新'),
    rowText(await firstRow(win))
  )

  // 撞名合并：刻意让两边单位不同（个 / 盒），把 unitConflict 也走一遍
  const rn2 = await evalIn<RenameItemResult>(
    win,
    `window.api.renameItem(${JSON.stringify(rnItemBId)}, "改名甲·新", "箱")`
  )
  check('撞名合并经 IPC 返回 ok', rn2.ok === true, rn2.ok ? '' : rn2.error)
  check('标记为「合并」', rn2.ok && rn2.merged === true)
  check('数量累加 15 + 7 = 22', rn2.ok && rn2.item.quantity === 22, rn2.ok ? `${rn2.item.quantity}` : '')
  check(
    '带回单位冲突（保留方「个」/ 被并方「盒」）',
    rn2.ok && rn2.unitConflict?.keptUnit === '个' && rn2.unitConflict?.otherUnit === '盒',
    JSON.stringify(rn2.ok ? rn2.unitConflict : rn2)
  )
  check('调用方指定的单位生效（箱）', rn2.ok && rn2.item.unit === '箱', rn2.ok ? rn2.item.unit : '')

  const rnDisk2 = await readJSON(rnDataFile)
  check('磁盘上物品数从 2 变成 1', rnDisk2.items.length === 1, `${rnDisk2.items.length}`)
  check('磁盘上源物品已删除', !rnDisk2.items.some((i) => i.id === rnItemBId))
  check(
    '磁盘上源物品的记录都归到目标物品名下',
    rnDisk2.records.length === 3 && rnDisk2.records.every((r) => r.itemId === rnItemAId),
    rnDisk2.records.map((r) => r.itemId).join('/')
  )
  check(
    '被并记录的 unit 快照保持原样（「7 盒」是当时的计量事实，不能改写成「箱」）',
    rnDisk2.records.some((r) => r.unit === '盒'),
    rnDisk2.records.map((r) => r.unit).join('/')
  )
  const rnBad = await evalIn<RenameItemResult>(
    win,
    `window.api.renameItem(${JSON.stringify(rnItemAId)}, "   ")`
  )
  check('非法输入经 IPC 被拒绝（空名）', rnBad.ok === false, JSON.stringify(rnBad))

  win.destroy()
  win = null
  await rm(rnDir, { recursive: true, force: true })

  // ── 13b. 强行修改数量经 IPC ──────────────────────────────────
  /*
   * 这一节验的是「绕过界面」这条路径。
   *
   * 界面上那道口令框只是交互，真正的防线在数据层 —— 所以这里**不经过界面**，
   * 直接 invoke `db:setQuantity`，口令错了必须照样被拒。
   * 只在界面上拦、数据层放行的实现，在浏览器自检（verify:ui）里能全绿，
   * 却挡不住任何直接调 IPC 的路径。
   */
  section('13b. 强行修改数量经 IPC 落到磁盘（含口令）')
  const qtyDir = mkdtempSync(join(tmpdir(), 'wm-qty-'))
  initStore(qtyDir)
  await load()
  win = await openWindow()
  const qtyDataFile = getDataFilePath()

  const qSeed = await evalIn<TransactionResult>(
    win,
    TX({ time: '2026-09-20T11:00', name: '改数甲', quantity: 20, unit: '个', type: 'in' })
  )
  check('铺好改数用的数据（改数甲 20 个）', qSeed.ok === true)
  if (!qSeed.ok) throw new Error('改数量用例的前置数据没造出来')
  const qItemId = qSeed.item.id

  // 口令错：绕过界面直接调 IPC 也必须被拒
  const qBad = await evalIn<SetQuantityResult>(
    win,
    `window.api.setItemQuantity(${JSON.stringify(qItemId)}, 999, "000000")`
  )
  check('口令错误 → 绕过界面直接调 IPC 同样被拒', qBad.ok === false, JSON.stringify(qBad))
  check('口令错误 → 带 wrongPassword（界面据此退回第一步）', !qBad.ok && qBad.wrongPassword === true)
  const qDiskAfterBad = await readJSON(qtyDataFile)
  check(
    '口令错误 → 磁盘上的数量没动（仍是 20）',
    qDiskAfterBad.items[0].quantity === 20,
    `${qDiskAfterBad.items[0].quantity}`
  )

  // 口令对：负数 / 小数都要能改，且要真的落盘
  const qOk = await evalIn<SetQuantityResult>(
    win,
    `window.api.setItemQuantity(${JSON.stringify(qItemId)}, -12.5, ${JSON.stringify(QUANTITY_EDIT_PASSWORD)})`
  )
  check(
    '口令正确 → 改成 -12.5（负数与小数都允许）',
    qOk.ok && qOk.item.quantity === -12.5,
    JSON.stringify(qOk)
  )

  const qDisk = await readJSON(qtyDataFile)
  check('数量已落盘（-12.5）', qDisk.items[0].quantity === -12.5, `${qDisk.items[0].quantity}`)
  check('强行改数不写流水（磁盘记录数仍是 1）', qDisk.records.length === 1, `${qDisk.records.length}`)
  check(
    '界面同步显示新数量（改数广播到了渲染进程）',
    await waitFor(async () => (await firstRow(win!))['数量'] === '-12.5'),
    rowText(await firstRow(win))
  )
  check('负数量在界面上带负库存高亮', await quantityIsNegative(win))

  win.destroy()
  win = null
  await rm(qtyDir, { recursive: true, force: true })

  // ── 13c. 备注 / 单位 / 排序 / 删除物品 / 导入 经 IPC ──────────
  /*
   * 与 13b 同一个道理：口令与校验的防线在**数据层**。
   * 这一节全部**绕过界面**直接 invoke —— 界面上有没有那个按钮、
   * 拦没拦，都不该影响这里的结果。
   */
  section('13c. 备注 / 单位 / 排序 / 删除物品 / 导入经 IPC')
  const v16Dir = mkdtempSync(join(tmpdir(), 'wm-v16-'))
  initStore(v16Dir)
  await load()
  win = await openWindow()
  const v16File = getDataFilePath()

  const ipcSeedA = await evalIn<TransactionResult>(
    win,
    TX({ time: '2026-09-24T10:00', name: 'IPC甲', quantity: 10, unit: '个', type: 'in' })
  )
  const ipcSeedB = await evalIn<TransactionResult>(
    win,
    TX({ time: '2026-09-24T11:00', name: 'IPC乙', quantity: 20, unit: '米', type: 'in' })
  )
  check('铺好 IPC 用例的数据（2 个物品）', ipcSeedA.ok === true && ipcSeedB.ok === true)
  if (!ipcSeedA.ok || !ipcSeedB.ok) throw new Error('IPC 用例的前置数据没造出来')

  const noteR = await evalIn<SetNoteResult>(
    win,
    `window.api.setItemNote(${JSON.stringify(ipcSeedA.item.id)}, "IPC 备注")`
  )
  check('改备注经 IPC 生效', noteR.ok && noteR.item.note === 'IPC 备注', JSON.stringify(noteR))

  const unitR = await evalIn<SetUnitResult>(
    win,
    `window.api.setItemUnit(${JSON.stringify(ipcSeedA.item.id)}, "箱")`
  )
  check('改单位经 IPC 生效', unitR.ok && unitR.item.unit === '箱', JSON.stringify(unitR))
  const unitBad = await evalIn<SetUnitResult>(
    win,
    `window.api.setItemUnit(${JSON.stringify(ipcSeedA.item.id)}, "  ")`
  )
  check('空单位经 IPC 被拒（界面不拦也拦得住）', unitBad.ok === false, JSON.stringify(unitBad))

  const newOrder = [ipcSeedB.item.id, ipcSeedA.item.id]
  const orderR = await evalIn<ReorderItemsResult>(
    win,
    `window.api.reorderItems(${JSON.stringify(newOrder)})`
  )
  check('排序经 IPC 生效', orderR.ok === true, JSON.stringify(orderR).slice(0, 110))
  check(
    '磁盘上的顺序也变了',
    (await readJSON(v16File)).items.map((i) => i.id).join(',') === newOrder.join(',')
  )
  const orderBad = await evalIn<ReorderItemsResult>(
    win,
    `window.api.reorderItems(${JSON.stringify([newOrder[0]])})`
  )
  check('数量不一致的顺序列表经 IPC 被拒', orderBad.ok === false, JSON.stringify(orderBad))

  const delBad = await evalIn<DeleteItemResult>(
    win,
    `window.api.deleteItem(${JSON.stringify(ipcSeedA.item.id)}, "000000")`
  )
  check(
    '删除物品：口令错 → 绕过界面同样被拒',
    delBad.ok === false && delBad.wrongPassword === true,
    JSON.stringify(delBad)
  )
  check('口令错 → 磁盘上物品还在', (await readJSON(v16File)).items.length === 2)

  const delOk = await evalIn<DeleteItemResult>(
    win,
    `window.api.deleteItem(${JSON.stringify(ipcSeedA.item.id)}, ${JSON.stringify(QUANTITY_EDIT_PASSWORD)})`
  )
  check('删除物品：口令对 → 成功', delOk.ok === true, JSON.stringify(delOk))
  const delDisk = await readJSON(v16File)
  check('磁盘上物品少 1', delDisk.items.length === 1, `${delDisk.items.length}`)
  check(
    '连带删掉它名下的记录（不留孤儿）',
    delDisk.records.every((r) => r.itemId !== ipcSeedA.item.id),
    delDisk.records.map((r) => r.itemId).join(',')
  )

  const impBad = await evalIn<ImportResult>(
    win,
    'window.api.importTable("000000", [{name:"X",unit:"个",quantity:1}], "", "")'
  )
  check(
    '导入：口令错 → 拒绝',
    impBad.ok === false && impBad.wrongPassword === true,
    JSON.stringify(impBad)
  )
  check('导入被拒 → 旧数据原封不动', (await readJSON(v16File)).items.length === 1)

  const impOk = await evalIn<ImportResult>(
    win,
    `window.api.importTable(${JSON.stringify(QUANTITY_EDIT_PASSWORD)}, ` +
      '[{name:"导入甲",unit:"个",quantity:11,note:"n1"},{name:"导入乙",unit:"米",quantity:22}], ' +
      '"张三", "李四")'
  )
  check('导入：口令对 → 成功', impOk.ok === true, JSON.stringify(impOk))
  const impDisk = await readJSON(v16File)
  check('磁盘上物品数 = 表格行数', impDisk.items.length === 2, `${impDisk.items.length}`)
  check(
    '磁盘上物品顺序 = 表格顺序',
    impDisk.items.map((i) => i.name).join('|') === '导入甲|导入乙',
    impDisk.items.map((i) => i.name).join('|')
  )
  check(
    '磁盘上的记录带上了操作人 / 经手人',
    impDisk.records.every((r) => r.operator === '张三' && r.handler === '李四'),
    JSON.stringify(impDisk.records.map((r) => [r.operator, r.handler]))
  )

  win.destroy()
  win = null
  await rm(v16Dir, { recursive: true, force: true })

  // ── 14. 控制台 ───────────────────────────────────────────────
  section('14. 渲染进程控制台')
  check('无 console.error', rendererErrors.length === 0, rendererErrors.slice(0, 3).join(' | '))

  console.log(`\n${'─'.repeat(56)}`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  if (failures.length) {
    console.log('\n失败明细：')
    for (const f of failures) console.log(`  \u2717 ${f}`)
  }
  console.log(`临时数据目录：${dataDir}`)
}

const bail = setTimeout(() => {
  console.error('\n自检超时（120 秒），强制退出')
  app.exit(1)
}, 120000)

app.whenReady().then(async () => {
  let code = 1
  try {
    await run()
    code = failed === 0 ? 0 : 1
  } catch (err) {
    console.error('\n自检中断：', err)
    code = 1
  }
  clearTimeout(bail)
  try {
    await rm(dataDir, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
  app.exit(code)
})

app.on('window-all-closed', () => {
  /* 由 run() 控制退出时机，这里不自动退出 */
})
