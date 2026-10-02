#!/usr/bin/env node
/**
 * 真应用自检：启动 `out/main/index.js`（**就是双击时跑的那个入口**），
 * 再用 CDP 连上它的真实窗口，验证「应用真的能打开、真的能用」。
 *
 * 与 verify:electron 的区别：
 *   verify:electron  自己写 harness，用**隐藏窗口**验证 IPC + 磁盘链路
 *   verify:app       跑**真实入口 + 真实窗口**，验证「双击能起来」这件事本身
 *                    额外覆盖：preload 路径是否正确、单实例锁、真实重启后数据是否还在
 *
 * 为什么要单独测这个：`createWindow()` 里的 `join(__dirname, '../preload/index.js')`
 * 这类路径写错了不会报错 —— 窗口照开，只是 `window.api` 是 undefined，
 * 界面一片空白。这种错只有真跑一次真实入口才能发现。
 *
 * 隔离措施：
 *   - `--user-data-dir` 指向临时目录，**绝不碰你的真实应用数据**
 *   - `--window-position=-3000,-3000` 把窗口挪到屏幕外，不打断你手头的事
 *   - 只连 127.0.0.1 的调试端口，跑完即杀进程、删临时目录
 *
 * 用法：npm run verify:app
 * 退出码：0 全部通过 / 1 有失败项
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CDP_PORT = Number(process.env.VERIFY_APP_CDP_PORT ?? 9223)
const ENDPOINT = `http://127.0.0.1:${CDP_PORT}`
const SHOT_DIR = join(ROOT, 'out', 'verify-app')
const WANT_SHOTS = process.env.VERIFY_APP_SHOTS === '1'

let chromium
try {
  ;({ chromium } = require('playwright'))
} catch {
  console.error('\n  未找到 playwright。安装方式：')
  console.error('    npm i -D playwright && npx playwright install chromium\n')
  process.exit(2)
}

let passed = 0
let failed = 0
const failures = []

function check(label, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  \u2713 ${label}`)
  } else {
    failed++
    failures.push(label + (detail ? ` \u2014 ${detail}` : ''))
    console.log(`  \u2717 ${label}${detail ? ` \u2014 ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

/**
 * 启动真实入口。
 *
 * 开关必须放在**脚本路径之后** —— 放前面会被 Electron 自己的参数解析器拒掉
 * （表现为 `bad option: --no-sandbox`）。Chromium 会解析整条命令行，
 * 所以放后面照样生效。
 */
function launch(userDataDir) {
  const args = [
    join(ROOT, 'out', 'main', 'index.js'),
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    // 受限环境下子进程沙箱与 GPU 进程起不来，会反复崩到 FATAL
    '--no-sandbox',
    '--disable-gpu',
    '--disable-gpu-sandbox',
    '--disable-software-rasterizer',
    // 窗口挪到屏幕外，不打断用户
    '--window-position=-3000,-3000'
  ]
  const child = spawn(join(ROOT, 'node_modules', '.bin', 'electron'), args, {
    cwd: ROOT,
    env: { ...process.env, NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  child.stdout.on('data', (d) => {
    out += String(d)
  })
  child.stderr.on('data', (d) => {
    out += String(d)
  })
  return { child, getLog: () => out }
}

async function waitForCdp(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ENDPOINT}/json/version`)
      if (res.ok) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(300)
  }
  return false
}

/** 连上真实窗口，返回它的页面对象 */
async function attach() {
  const browser = await chromium.connectOverCDP(ENDPOINT)
  const ctx = browser.contexts()[0]
  const deadline = Date.now() + 15000
  while (ctx.pages().length === 0 && Date.now() < deadline) await sleep(200)
  const page = ctx.pages()[0]
  if (!page) throw new Error('连上了调试端口，但没有找到任何窗口')
  return { browser, page }
}

/** 等窗口里的界面挂载完成（真实应用启动比预览慢一点） */
async function waitForUi(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ready = await page
      .evaluate(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0)
      .catch(() => false)
    if (ready) return true
    await sleep(200)
  }
  return false
}

/** React 受控输入用原生 setter，跟真人输入等价 */
const setInput = (page, selector, value) =>
  page.evaluate(
    ([sel, val]) => {
      const el = document.querySelector(sel)
      if (!el) throw new Error('找不到 ' + sel)
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    },
    [selector, value]
  )

const switchTab = (page, name) =>
  page.evaluate((t) => {
    const b = [...document.querySelectorAll('button.tab')].find((x) => x.textContent.trim() === t)
    if (b) b.click()
  }, name)

const rowCount = (page) => page.evaluate(() => document.querySelectorAll('tbody tr').length)

/**
 * 仓库页某个物品所在行，返回 `{ 表头名: 单元格值 }`。
 *
 * 刻意不用下标取值：加一列就会让所有下标**静默错位**。
 * 新增「警戒值」列时就是这样让 4 处断言同时失效的，
 * 而且报出来的是「值不对」，看不出根因是列错位，排查很费时间。
 *
 * 表头名会随内容变化（「本月入库（9月）」带月份、「单位（已锁定）」带锁定标记），
 * 统一去掉括号内容作为规范名。
 */
const warehouseRow = (page, name) =>
  page.evaluate((n) => {
    const read = (row) => {
      const ths = [...row.closest('table').querySelectorAll('thead th')]
      const out = {}
      ths.forEach((th, i) => {
        const key = th.textContent.trim().replace(/（[^）]*）|\([^)]*\)/g, '').trim()
        const td = row.querySelectorAll('td')[i]
        if (!td) return
        // 警戒值单元格里是 <input>，textContent 恒为空串，必须读 .value
        const input = td.querySelector('input')
        out[key] = input ? input.value : td.textContent.trim()
      })
      return out
    }
    const tr = [...document.querySelectorAll('tbody tr')].find(
      (r) => r.querySelector('td.name-col')?.textContent?.trim() === n
    )
    return tr ? read(tr) : null
  }, name)

/** 把 { 表头名: 值 } 打成一行，失败信息里能看清到底取到了什么 */
const rowText = (row) =>
  row ? Object.entries(row).map(([k, v]) => `${k}=${v}`).join(' / ') : '(没有这一行)'

/** 真实窗口里某物品的库存是否低于警戒值（看「数量」单元格的类名） */
const quantityIsLow = (page, name) =>
  page.evaluate((n) => {
    const tr = [...document.querySelectorAll('tbody tr')].find(
      (r) => r.querySelector('td.name-col')?.textContent?.trim() === n
    )
    if (!tr) return null
    // 按表头名定位「数量」列，不按下标 —— 加列时下标会静默错位
    const ths = [...tr.closest('table').querySelectorAll('thead th')]
    const i = ths.findIndex((th) => th.textContent.trim() === '数量')
    if (i < 0) throw new Error('仓库表里找不到「数量」列')
    return tr.querySelectorAll('td')[i].classList.contains('below-threshold')
  }, name)

/**
 * 真实窗口里某物品的警戒值。
 *
 * 专门读输入框的 .value：单元格里是 <input>，它的 textContent 恒为空串。
 * warehouseRow 现在也会对含 input 的单元格返回 .value，两种写法都对；
 * 这里保留独立访问器，是为了让「警戒值取自输入框」这件事在断言处一眼可见。
 */
const thresholdOf = (page, name) =>
  page.evaluate((n) => {
    const tr = [...document.querySelectorAll('tbody tr')].find(
      (r) => r.querySelector('td.name-col')?.textContent?.trim() === n
    )
    const input = tr && tr.querySelector('.threshold-input')
    return input ? input.value : null
  }, name)

/** 真实窗口里改警戒值：聚焦 → 改值 → 失焦（提交发生在 onBlur） */
async function setThresholdViaUi(page, name, value) {
  await page.evaluate(
    ([n, v]) => {
      const tr = [...document.querySelectorAll('tbody tr')].find(
        (r) => r.querySelector('td.name-col')?.textContent?.trim() === n
      )
      if (!tr) throw new Error('找不到物品行：' + n)
      const input = tr.querySelector('.threshold-input')
      if (!input) throw new Error('找不到警戒值输入框')
      input.focus()
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(input, String(v))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.blur()
    },
    [name, value]
  )
  await sleep(600)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

/** 用真实界面提交一笔出入库。type='out' 时要点右边那个表单，别拿左边的入库表单凑数 */
async function submitViaUi(page, { type = 'in', name, quantity, unit, operator, handler }) {
  await switchTab(page, '操作')
  await sleep(400)
  const form = page.locator('.tx-form').nth(type === 'out' ? 1 : 0)
  await form.locator('input[type="text"]').nth(0).fill(name)
  await sleep(200)
  await form.locator('input[type="number"]').fill(String(quantity))
  const unitInput = form.locator('input[type="text"]').nth(1)
  const readonly = (await unitInput.getAttribute('readonly')) !== null
  if (!readonly) await unitInput.fill(unit)
  if (operator) await form.locator('input[type="text"]').nth(2).fill(operator)
  // nth(3) = 经手人（入库）/ 领取人（出库）
  if (handler) await form.locator('input[type="text"]').nth(3).fill(handler)
  await sleep(150)
  await form.locator('button[type="submit"]').click()
  await sleep(700)
}

const consoleErrors = []
const dialogs = []

/** 可选截图：窗口在屏幕外也能截，截的是页面内容而不是屏幕 */
async function shot(page, name) {
  if (!WANT_SHOTS) return
  await mkdir(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`) })
}

/**
 * 给窗口挂上控制台与对话框监听。
 *
 * 每个窗口都要挂 —— 重启后是新窗口，漏挂的后果很隐蔽：
 * Playwright 在没有 dialog 监听时会**自动取消**对话框，
 * 于是 `window.confirm` 返回 false，撤销被静默放弃，
 * 看起来就像「撤销功能坏了」，其实是测试脚本没接。
 */
function wire(page) {
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))
  page.on('dialog', (d) => {
    dialogs.push(d.message())
    d.accept()
  })
}

// ── 主流程 ──────────────────────────────────────────────────
let userDataDir = null
let instance = null
let browser = null

try {
  userDataDir = await mkdtemp(join(tmpdir(), 'wh-app-'))
  // macOS 上 /tmp 是符号链接，Electron 报的是解析后的 /private/var/... ——
  // 用 realpath 归一化，否则同一个目录会被判成不同
  const realUserData = await realpath(userDataDir)
  const dataFile = join(realUserData, 'data.json')

  // ── 1. 启动 ──────────────────────────────────────────────
  section('1. 真实入口能否启动')
  instance = launch(userDataDir)
  const cdpOk = await waitForCdp()
  check('应用进程起来了并挂上调试端口', cdpOk, cdpOk ? '' : `端口 ${CDP_PORT} 未就绪\n${instance.getLog().slice(-400)}`)
  if (!cdpOk) throw new Error('应用未能启动')

  const attached = await attach()
  browser = attached.browser
  const page = attached.page
  wire(page)

  check('窗口标题为「库存管理系统」', (await page.title()) === '库存管理系统', await page.title())
  check(
    '窗口加载的是打包后的渲染产物',
    page.url().includes('out/renderer/index.html'),
    page.url().replace(/^file:\/\//, '')
  )
  check('界面挂载完成', await waitForUi(page))

  // ── 2. 真实 IPC ──────────────────────────────────────────
  section('2. 真实 preload 与 IPC（窗口开了但 api 没注入的话，界面是空白）')
  const hasApi = await page.evaluate(() => typeof window.api === 'object' && !!window.api)
  check('window.api 已由 preload 注入', hasApi)
  if (!hasApi) throw new Error('preload 未注入，后续无法验证')

  const pong = await page.evaluate(() => window.api.ping())
  check('IPC 往返 ping → pong', pong === 'pong', String(pong))

  /*
   * 原来这条读的是标题旁那行「主进程通道正常（返回 pong）」。
   * 2026-10-02 把那行小字隐藏了（用户不需要看），所以改成验「正常时不显示」——
   * 桥接本身在上一条 `ping → pong` 里已经验过了。
   */
  const bridge = await page.evaluate(
    () => document.querySelector('.bridge-status')?.textContent ?? ''
  )
  check('正常状态下标题旁不显示状态小字', bridge === '', JSON.stringify(bridge))

  const dataPath = await page.evaluate(() => window.api.getDataPath())
  check('数据文件落在临时目录内（未碰真实数据）', dataPath === dataFile, dataPath)
  check('首次启动尚无数据文件', !(await readFile(dataFile).then(() => true).catch(() => false)))
  check('空库时仓库页给出引导文案', (await page.evaluate(() => document.querySelector('.empty')?.textContent ?? '')).includes('还没有任何物品'))

  // ── 3. 通过真实界面录入 → 真实磁盘 ───────────────────────
  section('3. 通过界面录入 → 真实落盘')
  await submitViaUi(page, { type: 'in', name: 'M3×8 螺丝', quantity: 100, unit: '个', operator: '张三', handler: '赵六' })
  check('data.json 已由真实主进程写出', await readFile(dataFile).then(() => true).catch(() => false))
  const after1 = await readJson(dataFile)
  check('磁盘上 1 个物品', after1.items.length === 1, `${after1.items.length}`)
  check('磁盘上 1 条记录', after1.records.length === 1, `${after1.records.length}`)
  check('名称 / 数量 / 单位 / 操作人 正确', after1.items[0]?.name === 'M3×8 螺丝' && after1.items[0]?.quantity === 100 && after1.items[0]?.unit === '个' && after1.records[0]?.operator === '张三', JSON.stringify(after1.items[0]))
  check('新物品的警戒值落盘为默认 100', after1.items[0]?.threshold === 100, `${after1.items[0]?.threshold}`)
  // 经手人是后加的字段：要证明它真的走完了「界面 → preload → IPC → 磁盘」这条链路
  check(
    '界面填的经手人「赵六」真实落盘',
    after1.records[0]?.handler === '赵六',
    JSON.stringify(after1.records[0]?.handler)
  )

  await switchTab(page, '仓库')
  await sleep(400)
  const row1 = await warehouseRow(page, 'M3×8 螺丝')
  check('仓库页显示库存 100', row1?.['数量'] === '100', rowText(row1))
  check('仓库页显示警戒值 100', (await thresholdOf(page, 'M3×8 螺丝')) === '100', await thresholdOf(page, 'M3×8 螺丝'))
  check('库存 100 不低于警戒值 100，不标红', (await quantityIsLow(page, 'M3×8 螺丝')) === false)
  await shot(page, '1-after-in')

  // 通过真实窗口改警戒值 → 真实落盘
  await setThresholdViaUi(page, 'M3×8 螺丝', 300)
  const afterThreshold = await readJson(dataFile)
  check(
    '界面改警戒值 → 真实落盘为 300',
    afterThreshold.items[0]?.threshold === 300,
    `${afterThreshold.items[0]?.threshold}`
  )
  check('改警戒值没有新增流水', afterThreshold.records.length === 1, `${afterThreshold.records.length}`)
  check('库存 100 < 300，真实窗口里标红', await quantityIsLow(page, 'M3×8 螺丝') === true)
  await shot(page, '1b-threshold-low')
  // 改回去，避免影响后面的负库存用例
  await setThresholdViaUi(page, 'M3×8 螺丝', 100)

  // 出库超过库存 → 负库存，只警告不阻断（走真实 alert）
  await submitViaUi(page, { type: 'out', name: 'M3×8 螺丝', quantity: 130, unit: '个' })
  await sleep(300)
  check('出库走的是右侧出库表单（库存应为负）', (await readJson(dataFile)).items[0]?.quantity === -30, `${(await readJson(dataFile)).items[0]?.quantity}`)
  check('负库存时弹出警告（走真实 alert）', dialogs.some((m) => m.includes('负')), dialogs.at(-1) ?? '(无)')
  await switchTab(page, '仓库')
  await sleep(400)
  const row2 = await warehouseRow(page, 'M3×8 螺丝')
  check('库存变为 -30', row2?.['数量'] === '-30', rowText(row2))

  const after2 = await readJson(dataFile)
  check('磁盘上 2 条记录', after2.records.length === 2, `${after2.records.length}`)
  await shot(page, '2-negative-stock')

  // ── 4. 真实重启 ──────────────────────────────────────────
  section('4. 真实重启后数据是否还在')
  await browser.close().catch(() => {})
  browser = null
  instance.child.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((r) => instance.child.once('exit', () => r(true))),
    sleep(8000).then(() => false)
  ])
  check('应用进程已退出', exited)
  if (!exited) instance.child.kill('SIGKILL')
  await sleep(600)

  instance = launch(userDataDir)
  check('重启后再次挂上调试端口', await waitForCdp())
  const again = await attach()
  browser = again.browser
  const page2 = again.page
  wire(page2) // 新窗口必须重新挂监听，否则 confirm 会被自动取消
  check('重启后界面挂载完成', await waitForUi(page2))

  await switchTab(page2, '仓库')
  await sleep(500)
  const restored = await warehouseRow(page2, 'M3×8 螺丝')
  check('重启后仓库页仍有该物品', restored !== null, rowText(restored))
  check('重启后库存仍为 -30', restored?.['数量'] === '-30', rowText(restored))
  const snap = await page2.evaluate(() => window.api.getSnapshot())
  check('重启后记录数仍为 2', snap.records.length === 2, `${snap.records.length}`)
  check('重启后未标记「已从备份恢复」', (await page2.evaluate(() => window.api.getLoadReport())).recoveredFromBackup === false)
  check('正常启动不显示恢复提示条', await page2.evaluate(() => !document.querySelector('.warn-banner')))
  await shot(page2, '3-after-restart')

  // ── 5. 撤销 ──────────────────────────────────────────────
  section('5. 撤销（真实窗口）')
  await switchTab(page2, '记录')
  await sleep(400)
  check('记录页 2 条', (await rowCount(page2)) === 2, `${await rowCount(page2)}`)
  const undoBtnText = await page2.evaluate(
    () => [...document.querySelectorAll('tbody tr')][0]?.querySelector('button')?.textContent?.trim() ?? ''
  )
  check('首行按钮是「撤销」', undoBtnText === '撤销', undoBtnText)
  await page2.evaluate(() => {
    ;[...document.querySelectorAll('tbody tr')][0].querySelector('button').click()
  })
  // 撤销自 2026-10-02 起要口令：原来的 window.confirm 换成了口令框
  await page2.waitForSelector('.modal-overlay')
  await sleep(300)
  check('撤销弹出口令框（不再是浏览器 confirm）', (await page2.locator('.modal-overlay').count()) === 1)
  check(
    '口令框标题是「撤销这条记录？」',
    ((await page2.locator('.modal h3').textContent()) ?? '').trim() === '撤销这条记录？',
    await page2.locator('.modal h3').textContent()
  )

  // 口令错 → 不许撤销
  await page2.locator('.modal input[type="password"]').fill('000000')
  await page2.locator('.modal .btn-danger').click()
  await sleep(400)
  check('口令错误 → 对话框不关', (await page2.locator('.modal-overlay').count()) === 1)
  check('口令错误 → 记录仍是 2 条', (await rowCount(page2)) === 2, `${await rowCount(page2)}`)

  await page2.locator('.modal input[type="password"]').fill('771204')
  await page2.locator('.modal .btn-danger').click()
  await sleep(900)
  check('口令正确 → 对话框关闭', (await page2.locator('.modal-overlay').count()) === 0)
  check('撤销后记录 1 条', (await rowCount(page2)) === 1, `${await rowCount(page2)}`)
  await switchTab(page2, '仓库')
  await sleep(400)
  const undone = await warehouseRow(page2, 'M3×8 螺丝')
  check('库存 -30 → 100（反向冲销）', undone?.['数量'] === '100', rowText(undone))
  const finalDisk = await readJson(dataFile)
  check('磁盘同步为 1 条记录', finalDisk.records.length === 1, `${finalDisk.records.length}`)

  // ── 6. 控制台 ────────────────────────────────────────────
  section('6. 渲染进程控制台')
  check('无 console.error / pageerror', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

  console.log(`\n${'─'.repeat(56)}`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  if (failures.length) {
    console.log('\n失败明细：')
    for (const f of failures) console.log(`  \u2717 ${f}`)
  }
} catch (err) {
  console.error('\n自检中断：', err)
  if (instance) console.error('应用日志尾部：\n' + instance.getLog().slice(-800))
  failed++
} finally {
  if (browser) await browser.close().catch(() => {})
  if (instance) {
    instance.child.kill('SIGTERM')
    await sleep(500)
    if (instance.child.exitCode === null) instance.child.kill('SIGKILL')
  }
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
}

process.exit(failed === 0 ? 0 : 1)
