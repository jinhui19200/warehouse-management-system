#!/usr/bin/env node
/**
 * 界面自检：在真实浏览器里驱动界面 —— 既**量几何**，也**跑交互**。
 *
 * 三个验证层各管一段，互不替代：
 *   verify:store     数据层   纯 Node 直接调 store 模块
 *   verify:electron  端到端   隐藏窗口跑真 Electron：IPC + 磁盘
 *   verify:ui        界面     真实浏览器：布局几何 + 点得动 / 筛得对
 *
 * 布局部分刻意**量数字而不是看截图**：表头与数据是否对齐、列分割线在不在、
 * 有没有意外的横向滚动 —— 这些「看着差不多」的问题只有量出来才能判定，
 * 截图也证明不了「修好了」。
 *
 * 用法：npm run verify:ui   （npm 脚本会先构建，保证测的是当前代码）
 * 退出码：0 全部通过 / 1 有失败项
 *
 * 可选环境变量：
 *   VERIFY_UI_PORT    预览服务端口（默认 8791，刻意避开 8765，免得和手动开的预览打架）
 *   VERIFY_UI_SHOTS=1 把截图写到 out/verify-ui/（out/ 已在 .gitignore 里）
 */
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.VERIFY_UI_PORT ?? 8791)
const BASE = `http://127.0.0.1:${PORT}/preview/`
const SHOT_DIR = join(ROOT, 'out', 'verify-ui')
const WANT_SHOTS = process.env.VERIFY_UI_SHOTS === '1'

let chromium
try {
  ;({ chromium } = require('playwright'))
} catch {
  console.error('\n  未找到 playwright。安装方式：')
  console.error('    npm i -D playwright && npx playwright install chromium\n')
  process.exit(2)
}

// ── 断言与输出 ──────────────────────────────────────────────
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

// ── 预览服务生命周期 ────────────────────────────────────────
async function newestMtime(dir) {
  let newest = 0
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  for (const e of entries) {
    if (!e.isFile()) continue
    const p = join(e.parentPath ?? dir, e.name)
    const s = await stat(p)
    if (s.mtimeMs > newest) newest = s.mtimeMs
  }
  return newest
}

async function startServer() {
  const child = spawn(process.execPath, [join(ROOT, 'preview', 'build-preview.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PREVIEW_NO_OPEN: '1', PREVIEW_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += String(d)
  })

  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) {
      throw new Error(`预览服务启动失败（退出码 ${child.exitCode}）\n${stderr.trim()}`)
    }
    try {
      const res = await fetch(BASE)
      if (res.ok) return child
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  child.kill()
  throw new Error('预览服务 15 秒内未就绪')
}

// ── 页面操作辅助 ────────────────────────────────────────────
const switchTab = (page, name) =>
  page.evaluate((t) => {
    const b = [...document.querySelectorAll('button.tab')].find((x) => x.textContent.trim() === t)
    if (b) b.click()
  }, name)

/** React 受控输入必须用原生 setter 才能触发 onChange */
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

const rowCount = (page) => page.evaluate(() => document.querySelectorAll('tbody tr').length)

const countLabel = (page) =>
  page.evaluate(() => document.querySelector('.count')?.textContent?.trim() ?? '')

/**
 * 仓库页某个物品所在行，返回 `{ 表头名: 单元格值 }`。
 *
 * 刻意不用下标取值：加一列就会让所有下标**静默错位**。
 * 新增「警戒值」列时就是这样让 4 处断言同时失效的，
 * 而且报出来的是「值不对」，看不出根因是列错位，排查很费时间。
 *
 * 表头名本身也会随内容变化（「本月入库（9月）」带月份、「单位（已锁定）」带锁定标记），
 * 所以统一去掉括号内容作为规范名。
 *
 * 注意：读取逻辑必须在 page.evaluate 内部重新写一遍 —— 这个文件跑在 Node 里，
 * 定义在模块顶层的函数进不了页面上下文。
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
        // 单元格里可能是 <input>（如警戒值），它的 textContent 恒为空串，必须读 .value
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

/*
 * ── 月份相关的期望值，一律**按当天算**，绝不写死 ──────────────
 *
 * 报表页的默认窗口是「最近 12 个自然月」，而种子数据固定在 2025-10 ~ 2026-09。
 * 于是「窗口里有哪些月份」是**相对今天**的：一进 10 月，窗口就整体前移成
 * 2025-11 ~ 2026-10，原来写死的 '2025-10|…|2026-09' 必然变红 ——
 * 而功能其实一点没坏。
 *
 * 这种「到日子就红」的断言比没有断言更糟：用两次就没人信了，
 * 真出问题时也没人去看。所以下面全部改成按当天推算。
 */

/** 最近 count 个自然月（算法与 src/shared/utils.ts 的 recentMonths 一致） */
const recentMonths = (count, from = new Date()) => {
  const out = []
  const y = from.getFullYear()
  const m = from.getMonth()
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(y, m - i, 1)
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  return out
}

/** 界面上「2025-10 ~ 2026-09」这种区间文案 */
const rangeText = (months) => `${months[0]} ~ ${months[months.length - 1]}`

const MONTHS12 = recentMonths(12)
const RANGE_DEFAULT = rangeText(MONTHS12)

/** 整窗口往更早的方向平移 n 个月之后的月份数组 */
const monthsShifted = (n) => {
  const d = new Date()
  return recentMonths(12, new Date(d.getFullYear(), d.getMonth() - n, 1))
}

/** 同上，但要的是界面上那种区间文案 */
const RANGE_SHIFTED = (n) => rangeText(monthsShifted(n))

/**
 * 种子数据里记录的月份跨度是 2025-10 ~ 2026-09（见 preview/mock.ts）。
 * 「窗口外还有 N 个月」这类提示要拿它跟窗口两端比 —— 所以这两条依赖种子数据，
 * 种子改了这里也要跟着改。
 */
const SEED_EARLIEST_MONTH = '2025-10'
const SEED_LATEST_MONTH = '2026-09'

/** 两个 `YYYY-MM` 相差的月数（to 晚于 from 时为正） */
const monthDiff = (from, to) => {
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  return (ty - fy) * 12 + (tm - fm)
}

/**
 * 某个窗口 [start, end] 之外还剩多少个月的种子数据。
 * 两侧都算：更早的 + 更晚的（这正是界面那句提示的语义）。
 */
const monthsOutside = (start, end) =>
  Math.max(0, monthDiff(SEED_EARLIEST_MONTH, start)) + Math.max(0, monthDiff(end, SEED_LATEST_MONTH))

/**
 * 量表格：每列的表头与数据是否对齐、有没有列分割线。
 *
 * 判据要点（踩过坑）：
 *  - 不能拿「表头文字框」和「数据文字框」直接比左右边缘 —— 两边文字长度不同，
 *    左对齐列比右边缘必然不等。只看**对齐属性所指的那条边**。
 *  - JSX 里 `本月入库（{monthLabel}）` 会拆成多个文本节点，只取首个节点会量到
 *    残缺的「本月入库（」。必须取整个元素内容的并集框。
 *  - 数据侧若是元素（按钮/标签），以那个元素的框为基准，别比它内部的文字。
 */
const MEASURE_TABLE = () => {
  const contentBox = (el) => {
    if (!el) return null
    const r = document.createRange()
    r.selectNodeContents(el)
    const b = r.getBoundingClientRect()
    return b.width > 0 ? { left: Math.round(b.left), right: Math.round(b.right) } : null
  }
  return [...document.querySelectorAll('table.table')].map((t) => {
    const ths = [...t.querySelectorAll('thead th')]
    const tr = t.querySelector('tbody tr')
    const tds = tr ? [...tr.querySelectorAll('td')] : []
    return ths.map((th, i) => {
      const td = tds[i]
      const child = td && td.firstElementChild ? td.firstElementChild : null
      const anchor = child
        ? (() => {
            const b = child.getBoundingClientRect()
            return { left: Math.round(b.left), right: Math.round(b.right) }
          })()
        : contentBox(td)
      const h = contentBox(th)
      const hAlign = getComputedStyle(th).textAlign
      const rightAligned = hAlign === 'right' || hAlign === 'end'
      return {
        i,
        head: th.textContent.trim(),
        data: td ? td.textContent.trim().slice(0, 14) : '(无)',
        hAlign,
        dAlign: td ? getComputedStyle(td).textAlign : null,
        rightAligned,
        thBorderRight: parseFloat(getComputedStyle(th).borderRightWidth),
        tdBorderRight: td ? parseFloat(getComputedStyle(td).borderRightWidth) : null,
        isLast: i === ths.length - 1,
        edgeDelta: h && anchor ? (rightAligned ? anchor.right - h.right : anchor.left - h.left) : null
      }
    })
  })
}

// ── 主流程 ──────────────────────────────────────────────────
async function run(page, shot) {
  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))

  const dialogs = []
  page.on('dialog', (d) => {
    dialogs.push({ type: d.type(), message: d.message() })
    d.accept()
  })

  await page.goto(BASE, { waitUntil: 'load' })
  await page.waitForTimeout(1200)

  // ── 1. 首屏 ──────────────────────────────────────────────
  section('1. 首屏与桥接')
  check('界面已挂载', (await page.evaluate(() => document.querySelectorAll('#root *').length)) > 0)
  /*
   * 原来这条读的是标题旁那行「主进程通道正常（返回 pong）」。
   * 2026-10-02 把那行小字隐藏了（用户不需要看），所以改成**直接探桥接本身** ——
   * 比「看界面上有没有字」更接近真正要验的东西。
   */
  const ping = await page.evaluate(async () => {
    try {
      return String(await window.api.ping())
    } catch (e) {
      return `ERR:${String(e)}`
    }
  })
  check('渲染进程能调到主进程桥接（ping 有返回）', !ping.startsWith('ERR:'), ping)
  const bridgeText = await page.evaluate(
    () => document.querySelector('.bridge-status')?.textContent ?? ''
  )
  check('正常状态下标题旁不显示状态小字', bridgeText.length === 0, JSON.stringify(bridgeText))
  check('无「已从备份恢复」提示条', (await page.evaluate(() => !document.querySelector('.warn-banner'))))
  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll('button.tab')].map((b) => b.textContent.trim())
  )
  check('四个页签：仓库 / 记录 / 报表 / 操作', tabs.join('|') === '仓库|记录|报表|操作', tabs.join('|'))
  check('仓库页默认渲染 6 种物品', (await rowCount(page)) === 6, `${await rowCount(page)}`)
  const overflow = await page.evaluate(() => {
    const el = document.querySelector('.content')
    return { s: el.scrollWidth, c: el.clientWidth }
  })
  check('无意外横向滚动', overflow.s <= overflow.c + 1, `scrollWidth=${overflow.s} clientWidth=${overflow.c}`)
  await shot(page, '1-warehouse')

  // ── 2. 仓库页布局 ────────────────────────────────────────
  section('2. 仓库页：表头对齐与列分割线')
  let tables = await page.evaluate(MEASURE_TABLE)
  check('页面上有且只有一个表格', tables.length === 1, `${tables.length}`)
  let cols = tables[0]
  const numeric = cols.filter(
    (c) => c.head === '数量' || c.head === '警戒值' || c.head.startsWith('本月')
  )
  check(
    '数值列表头右对齐（历史缺陷：被 .table th 的选择器权重压成左对齐）',
    numeric.every((c) => c.rightAligned),
    numeric.map((c) => `${c.head}=${c.hAlign}`).join('  ')
  )
  check('数值列表头与数据的对齐属性一致', numeric.every((c) => c.hAlign === c.dAlign))
  for (const c of cols) {
    // 拖动柄列没有表头文字（它是一列操作控件，不是数据列），无从比对边缘
    if (!c.head) continue
    check(
      `「${c.head}」表头与数据对齐（比${c.rightAligned ? '右' : '左'}边缘）`,
      c.edgeDelta !== null && Math.abs(c.edgeDelta) <= 2,
      `差 ${c.edgeDelta}px`
    )
  }
  check(
    '除末列外每列都有 1px 列分割线（表头与数据一致）',
    cols.filter((c) => !c.isLast).every((c) => c.thBorderRight === 1 && c.tdBorderRight === 1),
    cols.map((c) => `${c.head}:${c.thBorderRight}/${c.tdBorderRight}`).join(' ')
  )
  check('末列不画右边框（避免与卡片边框叠成双线）', cols[cols.length - 1].thBorderRight === 0)

  // ── 2b. 警戒值 ───────────────────────────────────────────
  section('2b. 仓库页：警戒值')

  /** 仓库页某物品「数量」单元格的样式与文本 */
  const qtyCell = (page, name) =>
    page.evaluate((n) => {
      const tr = [...document.querySelectorAll('tbody tr')].find(
        (r) => r.querySelector('td.name-col')?.textContent?.trim() === n
      )
      if (!tr) return null
      // 按表头名定位「数量」列，不按下标 —— 加列时下标会静默错位
      const ths = [...tr.closest('table').querySelectorAll('thead th')]
      const i = ths.findIndex((th) => th.textContent.trim() === '数量')
      if (i < 0) throw new Error('仓库表里找不到「数量」列')
      const td = tr.querySelectorAll('td')[i]
      const cs = getComputedStyle(td)
      return {
        text: td.textContent.trim(),
        bg: cs.backgroundColor,
        color: cs.color,
        weight: cs.fontWeight,
        low: td.classList.contains('below-threshold'),
        negative: td.classList.contains('negative')
      }
    }, name)

  const thresholdValue = (page, name) =>
    page.evaluate((n) => {
      const tr = [...document.querySelectorAll('tbody tr')].find(
        (r) => r.querySelector('td.name-col')?.textContent?.trim() === n
      )
      return tr ? tr.querySelector('.threshold-input').value : null
    }, name)

  /** 改警戒值：走真实输入 + 失焦（提交发生在 onBlur） */
  const setThreshold = async (page, name, value) => {
    await page.evaluate(
      ([n, v]) => {
        const tr = [...document.querySelectorAll('tbody tr')].find(
          (r) => r.querySelector('td.name-col')?.textContent?.trim() === n
        )
        const input = tr.querySelector('.threshold-input')
        input.focus()
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        set.call(input, String(v))
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.blur()
      },
      [name, value]
    )
    await page.waitForTimeout(350)
  }

  const lowRows = (page) =>
    page.evaluate(() =>
      [...document.querySelectorAll('tbody tr')]
        .filter((r) => r.querySelector('td.below-threshold'))
        .map((r) => r.querySelector('td.name-col')?.textContent?.trim())
    )

  check('首列是拖动柄（没有表头文字）', cols[0]?.head === '', JSON.stringify(cols[0]?.head))
  /*
   * 列顺序断言刻意**不写死月份**。
   *
   * 表头是「本月入库（10月）」这种带月份的文字，写死月份就等于
   * 「每到下一个月必然红一次」—— 那种会定期变红的断言用两次就没人信了。
   * 所以把「本月…」统一折算成一个标记再比顺序。
   */
  const headKey = (h) => (h.startsWith('本月') ? '本月' : h)
  check(
    '列顺序：名称 / 数量 / 单位 / 备注 / 警戒值 / 本月入库 / 本月出库 / 操作',
    cols.map((c) => headKey(c.head)).filter(Boolean).join('|') ===
      '名称|数量|单位|备注|警戒值|本月|本月|操作',
    cols.map((c) => c.head).join('|')
  )
  // 按下标取列是脆的（加一列就错位），按表头名找
  const thresholdCol = cols.find((c) => c.head === '警戒值')
  check('警戒值列是数值列（右对齐）', thresholdCol?.rightAligned === true, thresholdCol?.hAlign)

  // 种子里的警戒值：螺丝 100 / 电阻 100 / 铜线 50 / 焊锡丝 10 / PCB 5
  check('螺丝警戒值显示 100', (await thresholdValue(page, 'M3×8 螺丝')) === '100', await thresholdValue(page, 'M3×8 螺丝'))
  check('铜线警戒值显示 50', (await thresholdValue(page, '铜线 1.5mm²')) === '50', await thresholdValue(page, '铜线 1.5mm²'))

  // 种子状态：245/100 不低、80/100 低、-15/50 低、12/10 不低、0/5 低 → 3 种
  const low0 = await lowRows(page)
  check(
    '低于警戒值的行共 3 种（电阻 / 铜线 / PCB）',
    low0.length === 3,
    low0.join('、')
  )
  check(
    '螺丝 245 ≥ 100，不标红',
    (await qtyCell(page, 'M3×8 螺丝')).low === false
  )
  const dianceCell = await qtyCell(page, '贴片电阻 10kΩ')
  check('电阻 80 < 100，数量单元格标红', dianceCell.low === true)
  check(
    '标红单元格底色是浅红',
    dianceCell.bg === 'rgb(253, 236, 235)',
    dianceCell.bg
  )
  check(
    '标红单元格数字加粗',
    Number(dianceCell.weight) >= 600,
    dianceCell.weight
  )
  const copperCell = await qtyCell(page, '铜线 1.5mm²')
  check(
    '负库存同时带 negative 与 below-threshold 两个类',
    copperCell.negative === true && copperCell.low === true,
    `negative=${copperCell.negative} low=${copperCell.low}`
  )
  check(
    '顶部显示「3 种低于警戒值」',
    (await page.evaluate(() => document.querySelector('.count-warn')?.textContent?.trim() ?? '')).includes('3 种低于警戒值'),
    await page.evaluate(() => document.querySelector('.count-warn')?.textContent?.trim() ?? '(无)')
  )
  await shot(page, '2b-threshold')

  // 改警戒值：把螺丝从 100 提到 300 → 245 < 300，应立刻变红
  await setThreshold(page, 'M3×8 螺丝', 300)
  check('改警戒值后输入框显示 300', (await thresholdValue(page, 'M3×8 螺丝')) === '300', await thresholdValue(page, 'M3×8 螺丝'))
  check('螺丝 245 < 300，数量变红', (await qtyCell(page, 'M3×8 螺丝')).low === true)
  check('低于警戒值数量变为 4 种', (await lowRows(page)).length === 4, `${(await lowRows(page)).length}`)
  await shot(page, '2b-threshold-changed')

  // 调低回去：螺丝警戒值设 1 → 245 ≥ 1，红应消失
  await setThreshold(page, 'M3×8 螺丝', 1)
  check('警戒值调回 1 后螺丝不再标红', (await qtyCell(page, 'M3×8 螺丝')).low === false)
  check('低于警戒值数量回到 3 种', (await lowRows(page)).length === 3, `${(await lowRows(page)).length}`)

  // 非法输入：清空 → 失焦后回到「上一次生效的值」，不把空值写进数据。
  // 这里刻意不做「清空 = 恢复默认 100」：用户清空多半是想取消这次修改，
  // 静默把它改成 100 等于替用户改了数据。（数据层仍有 100 兜底，防直接调 IPC）
  await setThreshold(page, 'M3×8 螺丝', '')
  check(
    '清空后失焦：回到上一次生效的值 1，不写空值',
    (await thresholdValue(page, 'M3×8 螺丝')) === '1',
    await thresholdValue(page, 'M3×8 螺丝')
  )
  check('清空没有改变低于警戒值的判定（245 ≥ 1）', (await qtyCell(page, 'M3×8 螺丝')).low === false)

  // 负数输入同理：不写进数据，回到原值
  await setThreshold(page, '焊锡丝 0.8mm', -3)
  check(
    '负数输入失焦后回到 10，不写负数',
    (await thresholdValue(page, '焊锡丝 0.8mm')) === '10',
    await thresholdValue(page, '焊锡丝 0.8mm')
  )
  check('焊锡丝 12 ≥ 10，不标红', (await qtyCell(page, '焊锡丝 0.8mm')).low === false)

  // 非数字输入（type=number 在真实浏览器里会挡掉字母，用超长数值模拟非法）
  await setThreshold(page, 'M3×8 螺丝', '1e999')
  check(
    '溢出数值（Infinity）失焦后回到原值',
    (await thresholdValue(page, 'M3×8 螺丝')) === '1',
    await thresholdValue(page, 'M3×8 螺丝')
  )

  // 恢复种子状态，避免影响后续用例
  await setThreshold(page, 'M3×8 螺丝', 100)
  check('螺丝警戒值恢复 100', (await thresholdValue(page, 'M3×8 螺丝')) === '100', await thresholdValue(page, 'M3×8 螺丝'))

  // 改警戒值不该产生流水
  const recordsAfterThreshold = await page.evaluate(async () => {
    const snap = await window.api.getSnapshot()
    return snap.records.length
  })
  check('改警戒值没有写进出库记录', recordsAfterThreshold === 33, `${recordsAfterThreshold}`)

  // 数据层确实存下了新警戒值（不是只改了界面）
  const persisted = await page.evaluate(async () => {
    const snap = await window.api.getSnapshot()
    return snap.items.map((i) => `${i.name}:${i.threshold}`).join(' ')
  })
  check(
    '快照里警戒值与界面一致',
    persisted.includes('M3×8 螺丝:100') && persisted.includes('铜线 1.5mm²:50'),
    persisted
  )

  // ── 2b-2. 仓库页搜索与导出 ───────────────────────────────
  section('2b-2. 仓库页：搜索置顶（不隐藏其余）与导出 Excel')

  const whOrder = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('tbody tr')].map((r) =>
        r.querySelector('td.name-col')?.textContent?.trim()
      )
    )
  const whHits = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('tbody tr')]
        .filter((r) => r.classList.contains('row-hit'))
        .map((r) => r.querySelector('td.name-col')?.textContent?.trim())
    )
  const clickToolbar = (text) =>
    page.evaluate((t) => {
      const b = [...document.querySelectorAll('.card-toolbar button')].find(
        (x) => x.textContent.trim() === t
      )
      if (b) b.click()
      return Boolean(b)
    }, text)

  const seedOrder = ['M3×8 螺丝', '贴片电阻 10kΩ', '铜线 1.5mm²', '焊锡丝 0.8mm', 'PCB 打样板', '闲置物料 X']
  check(
    '未搜索时是物品的原始顺序',
    (await whOrder()).join('|') === seedOrder.join('|'),
    (await whOrder()).join('|')
  )

  await setInput(page, '.search-input', '丝')
  await page.waitForTimeout(250)
  const hitOrder = await whOrder()
  check('搜「丝」时仍显示全部 6 行（其余没被隐藏）', hitOrder.length === 6, hitOrder.join('|'))
  check(
    '命中的两种排到最前，未命中的保持原有相对顺序',
    hitOrder.join('|') ===
      ['M3×8 螺丝', '焊锡丝 0.8mm', '贴片电阻 10kΩ', '铜线 1.5mm²', 'PCB 打样板', '闲置物料 X'].join('|'),
    hitOrder.join('|')
  )
  check(
    '命中的行带 row-hit 标记（否则看不出哪几行是命中的）',
    (await whHits()).join('|') === 'M3×8 螺丝|焊锡丝 0.8mm',
    (await whHits()).join('|')
  )
  check(
    '计数显示「匹配 2 / 共 6 种」',
    (await countLabel(page)).includes('匹配 2 / 共 6 种'),
    await countLabel(page)
  )
  await shot(page, '2b2-warehouse-search')

  // 把原本排第 5 的物品顶到第一 —— 这是「置顶」最直观的用例
  await setInput(page, '.search-input', '板')
  await page.waitForTimeout(250)
  const boardOrder = await whOrder()
  check(
    '搜「板」把原本排第 5 的 PCB 打样板顶到第一位',
    boardOrder[0] === 'PCB 打样板' && boardOrder.length === 6,
    boardOrder.join('|')
  )
  check(
    '只有一个命中时，其余 5 种仍在下面且顺序不变',
    boardOrder.slice(1).join('|') === 'M3×8 螺丝|贴片电阻 10kΩ|铜线 1.5mm²|焊锡丝 0.8mm|闲置物料 X',
    boardOrder.join('|')
  )

  await setInput(page, '.search-input', 'pcb')
  await page.waitForTimeout(250)
  check('搜索大小写不敏感（pcb 命中 PCB）', (await whHits()).join('|') === 'PCB 打样板', (await whHits()).join('|'))

  await setInput(page, '.search-input', 'zzz')
  await page.waitForTimeout(250)
  check('搜不到时仍显示全部 6 行（不隐藏）', (await rowCount(page)) === 6, `${await rowCount(page)}`)
  check('搜不到时没有行被标成命中', (await whHits()).length === 0, (await whHits()).join('|'))
  check(
    '搜不到时计数显示「匹配 0 / 共 6 种」',
    (await countLabel(page)).includes('匹配 0 / 共 6 种'),
    await countLabel(page)
  )
  const whNote = await page.evaluate(() => document.querySelector('.search-note')?.textContent?.trim() ?? '')
  check(
    '搜不到时明确说明一句，而不是默默显示全部',
    whNote.includes('没有名称包含') && whNote.includes('6 种'),
    whNote || '(没有提示)'
  )

  check('点「清除」按钮可用', (await clickToolbar('清除')) === true)
  await page.waitForTimeout(250)
  check(
    '清除后顺序复原为原始顺序',
    (await whOrder()).join('|') === seedOrder.join('|'),
    (await whOrder()).join('|')
  )
  check(
    '清除后「清除」按钮自己消失（只在搜索时出现）',
    (await clickToolbar('清除')) === false
  )

  // 导出 Excel。手法与第 9 节相同：预览版的 window.api 是普通对象，可以换掉
  // exportXlsx 截下渲染进程**已经算好**的字节，再拿回 Node 用 xlsx 真解析。
  // alert 一并换掉（导出成功会弹一个），用完还原 —— 后面几节还要靠真 dialog。
  await page.evaluate(() => {
    window.__origAlert = window.alert
    window.alert = () => {}
    window.__whExport = null
    window.api.exportXlsx = async (data, name) => {
      const bytes = Uint8Array.from(data)
      let bin = ''
      for (const b of bytes) bin += String.fromCharCode(b)
      window.__whExport = { name, len: bytes.length, b64: btoa(bin) }
      return { ok: true, path: '（已拦截，未真的写文件）' }
    }
  })
  check('点「导出 Excel」按钮可用', (await clickToolbar('导出 Excel')) === true)
  await page.waitForFunction(() => window.__whExport !== null, null, { timeout: 5000 }).catch(() => {})
  const whExp = await page.evaluate(() => window.__whExport)
  await page.evaluate(() => {
    if (window.__origAlert) window.alert = window.__origAlert
  })
  check(
    '点「导出 Excel」后渲染进程产出了字节',
    whExp !== null && whExp.len > 0,
    whExp ? `${whExp.name} / ${whExp.len} 字节` : '没截到'
  )
  check('默认文件名是「仓库台账.xlsx」', whExp?.name === '仓库台账.xlsx', String(whExp?.name))

  if (whExp?.b64) {
    const wbuf = Buffer.from(whExp.b64, 'base64')
    check(
      '字节以 ZIP 魔数 PK 03 04 开头（xlsx 就是 zip）',
      wbuf[0] === 0x50 && wbuf[1] === 0x4b && wbuf[2] === 0x03 && wbuf[3] === 0x04,
      [...wbuf.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ')
    )
    const WXLSX = require('xlsx')
    const wbW = WXLSX.read(wbuf, { type: 'buffer' })
    check(
      '工作表名是「仓库台账」',
      wbW.SheetNames.length === 1 && wbW.SheetNames[0] === '仓库台账',
      wbW.SheetNames.join(' | ')
    )
    const wrows = WXLSX.utils.sheet_to_json(wbW.Sheets['仓库台账'], { header: 1 })
    // 月份列名按当天算（见文件上方 MONTHS12 的说明）；
    // 「备注」是 v1.6.0 新增的列，夹在「单位」和「警戒值」之间
    const exportMonth = `${Number(MONTHS12[11].slice(5))}月`
    check(
      '表头为 名称/数量/单位/备注/警戒值/本月入库/本月出库/状态',
      JSON.stringify(wrows[0]) ===
        JSON.stringify([
          '名称',
          '数量',
          '单位',
          '备注',
          '警戒值',
          `本月入库（${exportMonth}）`,
          `本月出库（${exportMonth}）`,
          '状态'
        ]),
      JSON.stringify(wrows[0])
    )
    check('数据行数与仓库物品数一致（6 行 + 表头）', wrows.length - 1 === 6, `${wrows.length - 1} 行`)
    check(
      '数量与界面一致（螺丝 245 / 铜线 -15）',
      wrows.slice(1).some((r) => r[0] === 'M3×8 螺丝' && r[1] === 245) &&
        wrows.slice(1).some((r) => r[0] === '铜线 1.5mm²' && r[1] === -15),
      JSON.stringify(wrows.slice(1).map((r) => [r[0], r[1]]))
    )
    // 界面上低库存是浅红底色，导出成文件后颜色没了 —— 必须落成一列文字，否则这条信息就丢了
    //
    // 「状态」列的下标按**表头名**找，不写死 r[6]：
    // 加一列（比如这次的「备注」）就会让写死的下标静默指向别列，
    // 报出来的却是「状态列没标出」，看着像功能坏了
    const statusIdx = wrows[0].indexOf('状态')
    check('导出表里找得到「状态」列', statusIdx >= 0, JSON.stringify(wrows[0]))
    check(
      '低于警戒值的 3 种在「状态」列被标出',
      wrows.slice(1).filter((r) => r[statusIdx] === '低于警戒值').length === 3,
      JSON.stringify(wrows.slice(1).map((r) => [r[0], r[statusIdx]]))
    )
    check(
      '未低于警戒值的行状态列为空',
      wrows
        .slice(1)
        .filter((r) => ['M3×8 螺丝', '焊锡丝 0.8mm', '闲置物料 X'].includes(r[0]))
        .every((r) => r[statusIdx] === ''),
      JSON.stringify(wrows.slice(1).map((r) => [r[0], r[statusIdx]]))
    )
    check(
      '备注列导出的是物品备注（螺丝有、电阻为空）',
      wrows
        .slice(1)
        .some((r) => r[0] === 'M3×8 螺丝' && r[wrows[0].indexOf('备注')] === '常用规格，注意防潮') &&
        wrows
          .slice(1)
          .some((r) => r[0] === '贴片电阻 10kΩ' && r[wrows[0].indexOf('备注')] === ''),
      JSON.stringify(wrows.slice(1).map((r) => [r[0], r[wrows[0].indexOf('备注')]]))
    )
  }

  // ── 2e. v1.6.0 新增：备注 / 单位 / 只看低库存 / 拖动柄 / 表头置顶 ──
  section('2e. 仓库页：备注、单位、只看低库存、拖动柄、表头置顶')

  /** 取某一行某列的文本。列用**类名**定位，不按下标 —— 加一列就会错位 */
  const cellText = (name, cls) =>
    page.evaluate(
      ([n, c]) =>
        [...document.querySelectorAll('table.table tbody tr')]
          .filter((r) => r.querySelector('td.name-col')?.textContent?.trim() === n)
          .map((r) => r.querySelector(`td.${c}`)?.textContent?.trim())[0] ?? null,
      [name, cls]
    )

  /*
   * 名称列等于 name 的行下标。
   * 刻意不复用后面的 whRowIdx：它是 const，在这里还处于暂时性死区
   * （TDZ），调它只会抛 ReferenceError —— 报错信息看着像脚本写错了，
   * 其实是「定义位置在使用之后」。
   */
  const rowIdxByName = (name) =>
    page.evaluate(
      (n) =>
        [...document.querySelectorAll('table.table tbody tr')].findIndex(
          (r) => r.querySelector('td.name-col')?.textContent?.trim() === n
        ),
      name
    )

  check(
    '备注列显示物品备注',
    (await cellText('M3×8 螺丝', 'note-cell')) === '常用规格，注意防潮',
    String(await cellText('M3×8 螺丝', 'note-cell'))
  )
  check(
    '没填备注的显示「—」（不是空白）',
    (await cellText('贴片电阻 10kΩ', 'note-cell')) === '—',
    String(await cellText('贴片电阻 10kΩ', 'note-cell'))
  )

  // 双击备注 → 行内编辑 → 回车保存（与改名同一套交互）
  const screwIdx = await rowIdxByName('M3×8 螺丝')
  await page.locator('table.table tbody tr').nth(screwIdx).locator('td.note-cell .editable-text').dblclick()
  check('双击备注进入编辑态', (await page.locator('td.note-cell input.name-input').count()) === 1)
  await page.locator('td.note-cell input.name-input').fill('改成新的备注')
  await page.locator('td.note-cell input.name-input').press('Enter')
  await page.waitForTimeout(400)
  check(
    '备注保存成功（界面上已变）',
    (await cellText('M3×8 螺丝', 'note-cell')) === '改成新的备注',
    String(await cellText('M3×8 螺丝', 'note-cell'))
  )

  // 右键也要能改（第二个入口）
  await page.locator('table.table tbody tr').nth(await rowIdxByName('M3×8 螺丝')).locator('td.note-cell .editable-text').click({ button: 'right' })
  check('右键备注 → 弹出菜单', await page.locator('.ctx-menu').isVisible())
  check(
    '菜单里有「修改备注」',
    (await page.locator('.ctx-menu .ctx-item').allTextContents()).includes('修改备注'),
    (await page.locator('.ctx-menu .ctx-item').allTextContents()).join('|')
  )
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)

  // 单位双击可改（改完立刻改回去，免得影响后面记录页/报表页的断言）
  await page.locator('table.table tbody tr').nth(await rowIdxByName('M3×8 螺丝')).locator('td.unit-col .editable-text').dblclick()
  check('双击单位进入编辑态', (await page.locator('td.unit-col input.name-input').count()) === 1)
  await page.locator('td.unit-col input.name-input').fill('盒')
  await page.locator('td.unit-col input.name-input').press('Enter')
  await page.waitForTimeout(400)
  check(
    '单位改成功（个 → 盒）',
    (await cellText('M3×8 螺丝', 'unit-col')) === '盒',
    String(await cellText('M3×8 螺丝', 'unit-col'))
  )
  await page.locator('table.table tbody tr').nth(await rowIdxByName('M3×8 螺丝')).locator('td.unit-col .editable-text').dblclick()
  await page.locator('td.unit-col input.name-input').fill('个')
  await page.locator('td.unit-col input.name-input').press('Enter')
  await page.waitForTimeout(400)
  check(
    '单位改回「个」',
    (await cellText('M3×8 螺丝', 'unit-col')) === '个',
    String(await cellText('M3×8 螺丝', 'unit-col'))
  )

  // ── 只看低于警戒值（「N 种低于警戒值」旁的小方框） ──────────
  /*
   * 勾选框的位置是用户明确要求的：「N 种低于警戒值」旁边，
   * 不是表头的「警戒值」旁边。这条断言就是钉位置的 ——
   * 光验「勾上能筛」的话，放回表头也一样绿。
   */
  const inHeader = await page.locator('.card-header .low-only-toggle input[type="checkbox"]').count()
  const inThead = await page.locator('thead input[type="checkbox"]').count()
  check(
    '勾选框在标题行的「N 种低于警戒值」旁边，不在表头',
    inHeader === 1 && inThead === 0,
    `标题区 ${inHeader} 个 / 表头 ${inThead} 个`
  )
  check('默认不勾选「只看低库存」，6 种全显示', (await rowCount(page)) === 6, `${await rowCount(page)}`)
  await page.locator('.low-only-toggle input[type="checkbox"]').check()
  await page.waitForTimeout(300)
  check('勾选后只剩低于警戒值的 3 种', (await rowCount(page)) === 3, `${await rowCount(page)}`)
  const lowOnlyNames = await page.evaluate(() =>
    [...document.querySelectorAll('table.table tbody tr')].map(
      (r) => r.querySelector('td.name-col')?.textContent?.trim()
    )
  )
  check(
    '剩下的是电阻 / 铜线 / PCB（不是随便三行）',
    ['贴片电阻 10kΩ', '铜线 1.5mm²', 'PCB 打样板'].every((n) => lowOnlyNames.includes(n)),
    lowOnlyNames.join('、')
  )
  await page.locator('.low-only-toggle input[type="checkbox"]').uncheck()
  await page.waitForTimeout(300)
  check('取消勾选后恢复 6 种', (await rowCount(page)) === 6, `${await rowCount(page)}`)

  // ── 拖动柄 ───────────────────────────────────────────────
  const handle = await page.evaluate(() => {
    const h = document.querySelector('tbody tr td.drag-cell .drag-handle')
    if (!h) return null
    return {
      draggable: h.getAttribute('draggable'),
      bars: h.querySelectorAll('.drag-bars').length,
      rows: document.querySelectorAll('tbody tr td.drag-cell').length
    }
  })
  check('每行最左端都有拖动柄', handle !== null && handle.rows === 6, JSON.stringify(handle))
  check('拖动柄是可拖动的（draggable=true）', handle?.draggable === 'true', JSON.stringify(handle))

  // ── 表头置顶 ─────────────────────────────────────────────
  /*
   * 要验「滚动时表头不动」，前提是表格**真的能滚** ——
   * 而 6 行数据在正常视口下根本撑不满容器。
   * 所以临时把视口压矮，逼出滚动条，测完再恢复。
   */
  const vp = page.viewportSize()
  await page.setViewportSize({ width: vp?.width ?? 1180, height: 360 })
  await page.waitForTimeout(300)
  const sticky = await page.evaluate(async () => {
    const box = document.querySelector('.table-scroll')
    if (!box) return null
    const th = box.querySelector('thead th')
    const before = Math.round(th.getBoundingClientRect().top)
    box.scrollTop = 200
    await new Promise((r) => requestAnimationFrame(r))
    return {
      before,
      after: Math.round(th.getBoundingClientRect().top),
      boxTop: Math.round(box.getBoundingClientRect().top),
      scrollTop: box.scrollTop,
      position: getComputedStyle(th).position
    }
  })
  check('表格区域可独立滚动（内容超出容器）', sticky !== null && sticky.scrollTop > 0, JSON.stringify(sticky))
  check('表头是 sticky 定位', sticky?.position === 'sticky', String(sticky?.position))
  check(
    '滚动后表头仍贴在容器顶部（置顶生效）',
    sticky !== null && Math.abs(sticky.after - sticky.boxTop) <= 2,
    JSON.stringify(sticky)
  )
  await page.setViewportSize(vp ?? { width: 1180, height: 800 })
  await page.waitForTimeout(300)

  // ── 2c. 报表页：双向柱状图 ───────────────────────────────
  section('2c. 报表页：入库在上 / 出库在下')
  await switchTab(page, '报表')
  await page.waitForTimeout(400)

  /** 某物品卡片的图表几何。柱高只量高度，位置用来判断在零轴哪一侧 */
  const reportCard = (name) =>
    page.evaluate((n) => {
      const card = [...document.querySelectorAll('.report-card')].find(
        (c) => c.querySelector('.report-name')?.textContent?.trim() === n
      )
      if (!card) return null
      const box = (el) => {
        const r = el.getBoundingClientRect()
        return {
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          h: Math.round(r.height)
        }
      }
      const readBars = (sel) =>
        [...card.querySelectorAll(sel)].map((b) => {
          const lab = b.querySelector('.plot-value')
          return {
            ...box(b),
            title: b.getAttribute('title'),
            // 柱子上标注的数值。0 的月份不标，所以这里是 null 而不是 '0'
            value: lab ? lab.textContent.trim() : null,
            labelBox: lab ? box(lab) : null
          }
        })
      return {
        // 短标签（4月）与完整月份（2026-04）都要：断言用完整月份定位，
        // 短标签只用来验显示。**不要用下标定位柱子** —— 窗口月数一改下标全错位。
        labels: [...card.querySelectorAll('.plot-label')].map((e) => e.textContent.trim()),
        months: [...card.querySelectorAll('.plot-label')].map((e) => e.getAttribute('title')),
        // 两个刻度列各自的标签。正常是 [上半: 最大值] / [下半: 0, 最大值]；
        // 窗口内零出入库时上半为空、下半只剩「0」（见 .plot-idle 的处理）
        gutters: [...card.querySelectorAll('.plot-gutter')].map((g) =>
          [...g.querySelectorAll('span')].map((s) => s.textContent.trim())
        ),
        // 「近 N 个月无出入库」，只在零出入库的卡片上出现
        idleText: card.querySelector('.plot-idle')?.textContent?.trim() ?? null,
        axis: box(card.querySelector('.plot-axis')),
        // 上半绘图区高度 = 满刻度对应的像素高度，用来反推每根柱子该多高
        halfH: Math.round(card.querySelector('.plot-in').getBoundingClientRect().height),
        barsIn: readBars('.plot-in .plot-bar'),
        barsOut: readBars('.plot-out .plot-bar')
      }
    }, name)

  /**
   * 按**月份**取柱子，而不是按下标。
   *
   * 原来写的是 barsIn[2] 表示 6 月 —— 那是按「窗口 = 最近 6 个月」算出来的下标。
   * 窗口改成 12 个月后同一个下标指向完全不同的月份，一批断言会静默错位
   * （值不对但报错信息看起来像数据问题）。按月份查就没有这个问题。
   */
  const barAt = (c, month, dir) => {
    const i = c.months.indexOf(month)
    if (i < 0) return null
    return dir === 'in' ? c.barsIn[i] : c.barsOut[i]
  }

  const cardCount = await page.evaluate(() => document.querySelectorAll('.report-card').length)
  check('仓库里每个物品一张卡片（6 个物品 → 6 张）', cardCount === 6, `${cardCount}`)

  const card = await reportCard('M3×8 螺丝')
  check('找到「M3×8 螺丝」的图表', card !== null)

  if (card) {
    check(
      '横轴是最近 12 个自然月（默认窗口）',
      card.months.join('|') ===
        MONTHS12.join('|'),
      card.months.join('|')
    )
    check(
      '月份短标签正确（12 月是两位数）',
      card.labels.join('|') === MONTHS12.map((m) => `${Number(m.slice(5))}月`).join('|'),
      card.labels.join('|')
    )

    // 上下两半若各自按自己的最大值缩放，柱子长度就不可比了 —— 必须共用同一刻度
    check(
      '上下两半共用同一刻度（最大值 300）',
      card.gutters[0][0] === '300' && card.gutters[1][1] === '300',
      JSON.stringify(card.gutters)
    )

    // `every()` 在空数组上恒为 true —— 柱子要是因为回归全没了，
    // 下面两条「全在轴某侧」会**静默通过**。所以先把非空性钉死。
    const nonZeroIn = card.barsIn.filter((b) => b.h > 0)
    const nonZeroOut = card.barsOut.filter((b) => b.h > 0)
    check(
      '确有非零入库柱（否则「全在轴上方」是空集上的真命题）',
      nonZeroIn.length > 0,
      `${nonZeroIn.length}/${card.barsIn.length} 根非零`
    )
    check(
      '确有非零出库柱（同上）',
      nonZeroOut.length > 0,
      `${nonZeroOut.length}/${card.barsOut.length} 根非零`
    )

    const inAbove = nonZeroIn.every((b) => b.bottom <= card.axis.top + 1)
    const outBelow = nonZeroOut.every((b) => b.top >= card.axis.bottom - 1)
    check('入库柱全部在零轴上方', inAbove, JSON.stringify(card.barsIn.map((b) => [b.h, b.bottom])))
    check('出库柱全部在零轴下方', outBelow, JSON.stringify(card.barsOut.map((b) => [b.h, b.top])))

    // 月份标签必须落在对应柱子的正下方。
    // 12 列时偏差才看得出来，而肉眼判断不可靠 —— 量出来。
    // 比的是「列」的中心而不是柱子的中心：柱子只占列宽的 56%。
    const align = await page.evaluate(() => {
      const c = [...document.querySelectorAll('.report-card')].find(
        (x) => x.querySelector('.report-name')?.textContent?.trim() === 'M3×8 螺丝'
      )
      const mid = (el) => {
        const r = el.getBoundingClientRect()
        return r.x + r.width / 2
      }
      const cols = [...c.querySelectorAll('.plot-in .plot-col')].map(mid)
      const labels = [...c.querySelectorAll('.plot-label')].map(mid)
      const bars = [...c.querySelectorAll('.plot-in .plot-bar')].map(mid)
      return {
        n: cols.length,
        labelDev: Math.max(...labels.map((x, i) => Math.abs(x - cols[i]))),
        barDev: Math.max(...bars.map((x, i) => Math.abs(x - cols[i])))
      }
    })
    check(
      '12 个月标签与柱子逐列对齐（偏差 <1px）',
      align.n === 12 && align.labelDev < 1,
      `${align.n} 列，最大偏差 ${align.labelDev.toFixed(1)}px`
    )
    check(
      '柱子在各列内居中',
      align.barDev < 1,
      `最大偏差 ${align.barDev.toFixed(1)}px`
    )

    // 数值取自 title：顺带验证「按物品 + 按月聚合」算对了。
    // 全部按月份查，不再按下标 —— 窗口月数变化不会让这些断言错位
    const j6in = barAt(card, '2026-06', 'in')
    const j7out = barAt(card, '2026-07', 'out')
    const j9in = barAt(card, '2026-09', 'in')
    const j9out = barAt(card, '2026-09', 'out')
    check('6 月入库 300', j6in?.title === '2026-06 入库 300', String(j6in?.title))
    check('7 月出库 150', j7out?.title === '2026-07 出库 150', String(j7out?.title))
    check('9 月入库 150（同月两笔 100+50 合并）', j9in?.title === '2026-09 入库 150', String(j9in?.title))
    check('9 月出库 20', j9out?.title === '2026-09 出库 20', String(j9out?.title))

    // 挑一个确定没有记录的月份。不能用窗口首月 ——
    // 种子数据铺满 12 个月后首月（2025-10）也有记录了。
    // 「M3×8 螺丝」在 2025-12 没有任何记录（当月只有电阻的出入库）
    const emptyIn = barAt(card, '2025-12', 'in')
    const emptyOut = barAt(card, '2025-12', 'out')
    check(
      '没有数据的月份柱高为 0（不是留空不画）',
      emptyIn?.h === 0 && emptyOut?.h === 0,
      `${emptyIn?.h}/${emptyOut?.h}`
    )

    // ── 柱子上的数值标注 ──
    // 标注的数值应与 title 里的数字一致（两处都源自同一条月度聚合，
    // 但渲染路径不同，标注写错的话这里能抓到）
    const numOf = (s) => (s ? s.match(/(\d+(?:\.\d+)?)\s*$/)?.[1] ?? null : null)
    const labelled = card.barsIn.filter((b) => b.value !== null)
    check(
      '确有柱子带数值标注（否则下面的断言是空集上的真命题）',
      labelled.length > 0,
      `${labelled.length}/${card.barsIn.length} 根有标注`
    )
    check(
      '入库柱标注的数值与 title 一致',
      labelled.every((b) => b.value === numOf(b.title)),
      JSON.stringify(labelled.map((b) => [b.value, numOf(b.title)]))
    )
    check('6 月入库柱标注 300', j6in?.value === '300', String(j6in?.value))
    check('7 月出库柱标注 150', j7out?.value === '150', String(j7out?.value))

    // 值为 0 不标：12 个月 × 上下两半，满屏的「0」比不标更难看
    check(
      '没有数据的月份不显示标注（避免满屏 0）',
      emptyIn?.value === null && emptyOut?.value === null,
      `${emptyIn?.value}/${emptyOut?.value}`
    )

    // 标注要贴在**自己那根柱子**外侧：入库在上、出库在下。
    // 若改成统一飘在某一行上，短柱的数字会离柱子很远，读不出对应关系。
    const inLabelled = card.barsIn.filter((b) => b.labelBox)
    const outLabelled = card.barsOut.filter((b) => b.labelBox)
    check(
      '入库柱的标注在柱子正上方',
      inLabelled.length > 0 && inLabelled.every((b) => b.labelBox.bottom <= b.top + 1),
      JSON.stringify(inLabelled.map((b) => [b.labelBox.bottom, b.top]))
    )
    check(
      '出库柱的标注在柱子正下方',
      outLabelled.length > 0 && outLabelled.every((b) => b.labelBox.top >= b.bottom - 1),
      JSON.stringify(outLabelled.map((b) => [b.labelBox.top, b.bottom]))
    )
    // 最高那根柱子的标注会溢出 92px 绘图区，靠卡片内控制条的下外边距让位 ——
    // 有人把那段外边距调小的话，这里会失败。
    // 比的是**控制条**而不是卡片头部：控制条现在紧贴在绘图区上方，
    // 标注先撞到的是它。（早先没有控制条时比的是 .report-head）
    const topLabel = inLabelled.reduce((a, b) => (b.h > a.h ? b : a), inLabelled[0])
    const barBottom = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.report-card')].find(
        (c) => c.querySelector('.report-name')?.textContent?.trim() === 'M3×8 螺丝'
      )
      return Math.round(el.querySelector('.report-card-bar').getBoundingClientRect().bottom)
    })
    check(
      '最高柱的标注没有压到卡片内的时间窗控制条',
      topLabel.labelBox.top >= barBottom,
      `标注顶 ${topLabel.labelBox.top} vs 控制条底 ${barBottom}`
    )

    // 柱高与数值成比例：300 的柱应约为 150 的两倍（各留 3px 舍入误差）
    const h300 = j6in?.h
    const h150 = j9in?.h
    check(
      '柱高与数值成比例（300 的柱 ≈ 150 的两倍）',
      h300 > 0 && h150 > 0 && Math.abs(h300 - 2 * h150) <= 3,
      `300→${h300}px，150→${h150}px`
    )

    // 上面那条只盯了两根柱子。这里把**每根带标注的柱子**都按
    // 满刻度（上半刻度标签 = 最大值）反推一遍，避免只有某两根碰巧对
    const scaleMax = Number(card.gutters[0][0])
    const allLabelled = [...card.barsIn, ...card.barsOut].filter((b) => b.value !== null)
    const expectH = (v) => Math.max(2, (Number(v) / scaleMax) * card.halfH)
    const off = allLabelled.filter((b) => Math.abs(b.h - expectH(b.value)) > 2)
    check(
      '每根带标注的柱子都与自身数值成比例（满刻度 300 → 92px）',
      allLabelled.length > 0 && off.length === 0,
      off.length === 0
        ? `${allLabelled.length} 根全部吻合`
        : JSON.stringify(off.map((b) => [b.value, b.h, Math.round(expectH(b.value))]))
    )

    const totals = await page.evaluate(() => {
      const c = [...document.querySelectorAll('.report-card')].find(
        (x) => x.querySelector('.report-name')?.textContent?.trim() === 'M3×8 螺丝'
      )
      if (!c) return null
      // 两个 <b> 之间没有空白节点，整块 textContent 会粘成「入 1095出 380」，
      // 分别取元素比按整串比更稳
      return [...c.querySelectorAll('.report-total b')].map((b) => b.textContent.trim())
    })
    /*
     * 合计栏**不能写死数字**：它算的是「窗口内」的出入库总和，
     * 而窗口是最近 12 个月 —— 月份一滑，某些记录就进出窗口了
     * （种子数据固定，窗口却是相对今天的）。
     *
     * 改成自洽性检查：合计 ≈ 各柱数值之和（按刻度从柱高反推）。
     * 每根柱高都取整过，12 根累积起来给一点容差；
     * 这个容差远小于「整月算错」（一个月的量级是几百），所以照样能抓住真错。
     */
    const sumOfBars = (bars) => bars.reduce((s, b) => s + (b.h / card.halfH) * scaleMax, 0)
    const expectIn = Math.round(sumOfBars(card.barsIn))
    const expectOut = Math.round(sumOfBars(card.barsOut))
    const toNum = (t) => Number(String(t).replace(/[^\d.-]/g, ''))
    check(
      `卡片头部合计与窗口内柱子之和一致（入 ≈ ${expectIn} / 出 ≈ ${expectOut}）`,
      totals !== null &&
        Math.abs(toNum(totals[0]) - expectIn) <= 60 &&
        Math.abs(toNum(totals[1]) - expectOut) <= 60,
      `${JSON.stringify(totals)} vs 柱子推算 入 ${expectIn} / 出 ${expectOut}`
    )
  }

  // ── 窗口内零出入库（慢周转物料，是个正常状态） ──
  // 修之前这张卡会显示刻度「1 / 0 / 1」，一根柱子都没有 ——
  // 一个空图表标个「1」是纯噪音，看着还像渲染坏了
  const idle = await reportCard('闲置物料 X')
  check('找到「闲置物料 X」的卡片（窗口内零出入库）', idle !== null)
  if (idle) {
    check(
      '零出入库时不显示刻度数字（不是标一个无意义的「1」）',
      idle.gutters[0].length === 0 && idle.gutters[1].join('|') === '0',
      JSON.stringify(idle.gutters)
    )
    check(
      '零出入库时给出说明文字',
      /^近 12 个月无出入库$/.test(idle.idleText ?? ''),
      String(idle.idleText)
    )
    check(
      '零出入库时没有柱子',
      idle.barsIn.every((b) => b.h === 0) && idle.barsOut.every((b) => b.h === 0),
      `入 ${idle.barsIn.map((b) => b.h).join(',')} / 出 ${idle.barsOut.map((b) => b.h).join(',')}`
    )
    check(
      '零出入库时也没有数值标注',
      [...idle.barsIn, ...idle.barsOut].every((b) => b.value === null)
    )
    // 月份标签要照常显示 —— 否则用户分不清「没数据」和「图没画出来」
    check('零出入库时横轴月份仍在', idle.months.length === 12 && idle.months[0] === MONTHS12[0], idle.months.join('|'))
  }
  check(
    '有出入库的卡片不显示「无出入库」说明',
    card === null || card.idleText === null,
    String(card?.idleText)
  )

  // ── 2d. 时间窗口平移（每张卡各自独立） ────────────────────
  section('2d. 报表页：时间窗口左右平移（每张卡各自独立）')

  /**
   * 某张卡片的控制条状态。
   *
   * 全部按**卡片名**取，不按 `.report-range` 的文档顺序取 ——
   * 顺序取法在「卡片数量或排序变了」时会静默指向另一张卡，
   * 而报出来的错看起来像时间窗算错了，很难定位。
   */
  const cardBar = (name) =>
    page.evaluate((n) => {
      const card = [...document.querySelectorAll('.report-card')].find(
        (c) => c.querySelector('.report-name')?.textContent?.trim() === n
      )
      if (!card) return null
      const btns = [...card.querySelectorAll('.report-card-bar .range-btn')]
      const find = (t) => btns.find((b) => b.textContent.trim() === t)
      const earlier = find('◀ 更早')
      const later = find('更晚 ▶')
      return {
        range: card.querySelector('.report-range')?.textContent?.trim() ?? '',
        months: [...card.querySelectorAll('.plot-label')].map((e) => e.getAttribute('title')),
        earlierDisabled: earlier ? earlier.disabled : null,
        laterDisabled: later ? later.disabled : null,
        hasReset: Boolean(find('回到最新')),
        note: card.querySelector('.report-note')?.textContent?.trim() ?? null
      }
    }, name)

  const clickCardBtn = async (name, label) => {
    await page.evaluate(
      ([n, t]) => {
        const card = [...document.querySelectorAll('.report-card')].find(
          (c) => c.querySelector('.report-name')?.textContent?.trim() === n
        )
        const b = [...card.querySelectorAll('.report-card-bar .range-btn')].find(
          (x) => x.textContent.trim() === t
        )
        if (b) b.click()
      },
      [name, label]
    )
    await page.waitForTimeout(250)
  }

  const SCREW = 'M3×8 螺丝'
  const RESISTOR = '贴片电阻 10kΩ'
  const DEFAULT_RANGE = RANGE_DEFAULT

  let screwBar = await cardBar(SCREW)
  check('默认区间是最近 12 个月', screwBar.range === DEFAULT_RANGE, screwBar.range)
  check('「更晚」默认禁用（不能滑向未来）', screwBar.laterDisabled === true)
  check('「更早」默认可用（有更早的数据）', screwBar.earlierDisabled === false)
  check('默认不显示「回到最新」', screwBar.hasReset === false)
  /*
   * 「默认有没有窗口外提示」**取决于当天是几月**：
   * 默认窗口是最近 12 个月，而种子数据只铺到 2026-09 ——
   * 今天是 2026-09 时窗口刚好全覆盖（无提示），今天是 10 月时
   * 2025-10 那批记录就滑到窗口外了（**该**有提示）。
   * 所以这条不能写死「没有提示」，否则每月都会假红一次。
   */
  const outsideDefault = monthsOutside(MONTHS12[0], MONTHS12[11])
  check(
    outsideDefault > 0
      ? `默认窗口外确实还有 ${outsideDefault} 个月的种子数据，界面给出提示`
      : '默认窗口已覆盖全部种子数据，不显示「窗口外」提示',
    outsideDefault > 0
      ? /^窗口外还有 \d+ 个月的记录$/.test(screwBar.note ?? '')
      : screwBar.note === null,
    String(screwBar.note)
  )

  await clickCardBtn(SCREW, '◀ 更早')
  screwBar = await cardBar(SCREW)
  check('点一次「更早」，这张卡的区间前移一个月', screwBar.range === RANGE_SHIFTED(1), screwBar.range)
  check('平移后「更晚」变为可用', screwBar.laterDisabled === false)
  check('平移后出现「回到最新」', screwBar.hasReset === true)
  // 前移一个月后，窗口外还剩多少**取决于当天**（同上面那条），所以按实际情况断言
  const shiftedWindow = monthsShifted(1)
  const outsideShifted = monthsOutside(shiftedWindow[0], shiftedWindow[11])
  check(
    outsideShifted > 0
      ? `前移一个月后窗口外还有 ${outsideShifted} 个月的记录，界面给出提示`
      : '前移一个月后窗口仍覆盖全部种子数据，不显示「窗口外」提示',
    outsideShifted > 0
      ? /^窗口外还有 \d+ 个月的记录$/.test(screwBar.note ?? '')
      : screwBar.note === null,
    String(screwBar.note)
  )

  // ★ 这一条是本次改动的核心：另一张卡必须**完全不受影响**。
  // 早先所有卡片共用一个窗口，拖一张等于拖全部 —— 断言就是盯着这个回归。
  const resBar0 = await cardBar(RESISTOR)
  check(
    '★ 另一张卡（贴片电阻）的区间纹丝不动 —— 各卡窗口相互独立',
    resBar0.range === DEFAULT_RANGE && resBar0.hasReset === false && resBar0.laterDisabled === true,
    `区间=${resBar0.range} 回到最新=${resBar0.hasReset} 更晚禁用=${resBar0.laterDisabled}`
  )

  // 一直往前滑到**这个物品**最早一条记录所在月（螺丝最早是 2025-10-14）
  for (let i = 0; i < 30; i++) {
    if ((await cardBar(SCREW)).earlierDisabled === true) break
    await clickCardBtn(SCREW, '◀ 更早')
  }
  screwBar = await cardBar(SCREW)
  // 可滑范围 = 该物品最早记录所在月到当前月 = 2025-10 ~ 2026-09 共 11 步。
  // 滑到头时窗口是 2024-11 ~ 2025-10，最早那条记录正好落在窗口末月
  check(
    '滑到该物品最早数据处即停住（不会滑进全是空白的窗口）',
    screwBar.earlierDisabled === true && screwBar.range === '2024-11 ~ 2025-10',
    screwBar.range
  )
  // 停住之后图表里应该真的能看到最早那条数据 —— 否则「滑到位」是假的
  const slid = await reportCard(SCREW)
  check(
    '滑到最早处时 2025-10 入库 200 仍在窗口内',
    barAt(slid, '2025-10', 'in')?.title === '2025-10 入库 200',
    String(barAt(slid, '2025-10', 'in')?.title)
  )
  check(
    '滑到最早处时 2026-09 已滑出窗口',
    barAt(slid, '2026-09', 'in') === null,
    String(barAt(slid, '2026-09', 'in'))
  )

  await clickCardBtn(SCREW, '回到最新')
  screwBar = await cardBar(SCREW)
  check(
    '「回到最新」把这张卡复位',
    screwBar.range === DEFAULT_RANGE && screwBar.laterDisabled === true && screwBar.hasReset === false,
    screwBar.range
  )

  // ★ 可滑范围也必须按各自的记录算。
  // 「闲置物料 X」一条记录都没有 → 一步都滑不动。
  // 若沿用全局可滑范围（早先的写法），它照样能被滑到十几年前的空白窗口。
  const idleBar = await cardBar('闲置物料 X')
  check(
    '★ 没有任何记录的物品「更早」直接禁用（可滑范围按各自的记录算）',
    idleBar.earlierDisabled === true && idleBar.hasReset === false,
    JSON.stringify(idleBar)
  )

  // 拖动：往右拖应当看到更早的数据（和拖动地图的方向一致）。
  // 拖的是**这一张卡**的绘图区。
  const plotBox = await page.evaluate((n) => {
    const card = [...document.querySelectorAll('.report-card')].find(
      (c) => c.querySelector('.report-name')?.textContent?.trim() === n
    )
    const r = card.querySelector('.report-plot').getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 40) }
  }, SCREW)
  await page.mouse.move(plotBox.x, plotBox.y)
  await page.mouse.down()
  await page.mouse.move(plotBox.x + 130, plotBox.y, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  screwBar = await cardBar(SCREW)
  check('在螺丝卡片上往右拖 130px ≈ 前移 2 个月', screwBar.range === RANGE_SHIFTED(2), screwBar.range)
  const resBar1 = await cardBar(RESISTOR)
  check(
    '★ 拖动之后另一张卡仍未受影响',
    resBar1.range === DEFAULT_RANGE,
    resBar1.range
  )
  await clickCardBtn(SCREW, '回到最新')

  await shot(page, '2c-reports')
  await switchTab(page, '仓库')
  await page.waitForTimeout(300)

  // ── 3. 记录页布局 ────────────────────────────────────────
  section('3. 记录页：表头与数据一一对应')
  await switchTab(page, '记录')
  await page.waitForTimeout(400)
  tables = await page.evaluate(MEASURE_TABLE)
  check('页面上有且只有一个表格', tables.length === 1, `${tables.length}`)
  cols = tables[0]
  check(
    '表头为 时间/名称/数量/单位/备注/操作人/经手人/领取人/类型/操作',
    cols.map((c) => c.head).join('|') === '时间|名称|数量|单位|备注|操作人|经手人/领取人|类型|操作',
    cols.map((c) => c.head).join('|')
  )
  check('没有空表头（历史缺陷：按钮列没有表头）', cols.every((c) => c.head !== ''))
  // 按表头名取列，不按下标 —— 加「经手人/领取人」这一列时，
  // 原来的 cols[5] / cols[6] 会静默指向别的列，报出来却是「内容不对」
  const colByHead = (h) => cols.find((c) => c.head === h)
  check('「类型」压在 出库/入库 标签上', colByHead('类型')?.data === '出库', colByHead('类型')?.data)
  check('「操作」压在 撤销 按钮上', colByHead('操作')?.data === '撤销', colByHead('操作')?.data)
  check(
    '「经手人/领取人」紧跟在「操作人」之后',
    cols.findIndex((c) => c.head === '经手人/领取人') ===
      cols.findIndex((c) => c.head === '操作人') + 1,
    cols.map((c) => c.head).join('|')
  )
  for (const c of cols) {
    check(`「${c.head}」表头与数据对齐`, Math.abs(c.edgeDelta) <= 2, `差 ${c.edgeDelta}px`)
  }
  check(
    '除末列外每列都有 1px 列分割线',
    cols.filter((c) => !c.isLast).every((c) => c.thBorderRight === 1 && c.tdBorderRight === 1)
  )
  check('记录页共 33 条种子数据', (await rowCount(page)) === 33, `${await rowCount(page)}`)

  // 种子里前几条刻意带了经手人 / 领取人。不验一下的话，这一列全空也照样「通过」。
  const handlerCells = await page.evaluate(() => {
    const ths = [...document.querySelector('table.table').querySelectorAll('thead th')]
    const i = ths.findIndex((th) => th.textContent.trim() === '经手人/领取人')
    return [...document.querySelectorAll('tbody tr')]
      .slice(0, 8)
      .map((row) => row.querySelectorAll('td')[i]?.textContent?.trim())
  })
  check(
    '「经手人/领取人」列取到了值（不是整列空）',
    handlerCells.some((v) => v && v !== '—'),
    handlerCells.join(',')
  )
  check('入库记录的经手人显示为 赵六', handlerCells.includes('赵六'), handlerCells.join(','))
  check('出库记录的领取人显示为 孙八', handlerCells.includes('孙八'), handlerCells.join(','))
  check('出库记录的领取人显示为 周九', handlerCells.includes('周九'), handlerCells.join(','))
  check('未填的记录显示 —', handlerCells.includes('—'), handlerCells.join(','))
  await shot(page, '2-records')

  // ── 4. 名称 / 类型筛选 ───────────────────────────────────
  section('4. 名称与类型筛选')
  await setInput(page, '.search-input', '螺丝')
  await page.waitForTimeout(250)
  check('搜「螺丝」→ 11 条', (await rowCount(page)) === 11, `${await rowCount(page)}`)
  await setInput(page, '.search-input', '')
  await page.waitForTimeout(250)

  // 种子 33 条的构成（先 grep 数过）：入库 21 条、出库 12 条
  await page.evaluate(() => {
    ;[...document.querySelectorAll('.filter-group button')]
      .find((b) => b.textContent.trim() === '出库')
      .click()
  })
  await page.waitForTimeout(250)
  check('筛「出库」→ 12 条', (await rowCount(page)) === 12, `${await rowCount(page)}`)
  await page.evaluate(() => {
    ;[...document.querySelectorAll('.filter-group button')]
      .find((b) => b.textContent.trim() === '全部')
      .click()
  })
  await page.waitForTimeout(250)

  // ── 5. 时间范围（含当日） ────────────────────────────────
  // 种子数据的日期分布（先用 grep 数过，别凭印象）：
  //   09-19 六条（08:00 / 09:30 / 10:00 / 11:00 / 13:00 / 15:00）
  //   09-18 一条、09-17 一条、08-20 一条；另有 6/7/8 月共 8 条，
  //   再加上铺满 12 个月窗口时补的 2025-10 ~ 2026-05 共 16 条，合计 33 条
  section('5. 时间范围筛选（含当日）')
  const setRange = async (from, to) => {
    await setInput(page, 'input[aria-label="起始日期"]', from)
    await setInput(page, 'input[aria-label="截止日期"]', to)
    await page.waitForTimeout(250)
  }

  await setRange('2026-09-19', '2026-09-19')
  check('起止同为 09-19 → 6 条', (await rowCount(page)) === 6, `${await rowCount(page)}`)
  const times = await page.evaluate(() =>
    [...document.querySelectorAll('tbody tr td:first-child')].map((td) =>
      td.textContent.trim().slice(11)
    )
  )
  check(
    '含当日最早 08:00 与最晚 15:00（闭区间，不是半开）',
    times.includes('08:00') && times.includes('15:00'),
    times.join(',')
  )
  check(
    '标题显示「筛选出 6 / 共 33 条」',
    (await countLabel(page)).includes('筛选出 6 / 共 33 条'),
    await countLabel(page)
  )
  await shot(page, '3-date-single-day')

  await setRange('2026-09-17', '2026-09-19')
  check('09-17 ~ 09-19 → 8 条', (await rowCount(page)) === 8, `${await rowCount(page)}`)

  await setRange('', '2026-09-18')
  check('只填截止 09-18 → 27 条（该日及更早）', (await rowCount(page)) === 27, `${await rowCount(page)}`)

  await setRange('2026-08-20', '2026-08-20')
  check('单日 08-20 → 1 条（边界日当天命中）', (await rowCount(page)) === 1, `${await rowCount(page)}`)

  await setRange('2026-09-20', '2026-09-25')
  check('未来区间 → 0 条', (await rowCount(page)) === 0, `${await rowCount(page)}`)

  await setRange('2026-09-19', '2026-09-01')
  const emptyMsg = await page.evaluate(() => document.querySelector('.empty')?.textContent ?? '')
  check('起始晚于截止时明确提示，而不是笼统说「没有记录」', emptyMsg.includes('起始日期晚于截止日期'), emptyMsg)

  await setRange('2026-09-19', '2026-09-19')
  await setInput(page, '.search-input', '螺丝')
  await page.waitForTimeout(250)
  check('09-19 + 名称「螺丝」→ 3 条', (await rowCount(page)) === 3, `${await rowCount(page)}`)
  const exportLabel = await page.evaluate(() =>
    [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).find((t) => t.startsWith('导出'))
  )
  check('筛选时导出按钮标明条数', exportLabel === '导出 Excel（3 条）', exportLabel)
  await shot(page, '4-date-combined')

  await setInput(page, '.search-input', '')
  await page.evaluate(() => {
    ;[...document.querySelectorAll('.date-range button')]
      .find((b) => b.textContent.trim() === '清除')
      .click()
  })
  await page.waitForTimeout(250)
  const cleared = await page.evaluate(() => ({
    from: document.querySelector('input[aria-label="起始日期"]').value,
    to: document.querySelector('input[aria-label="截止日期"]').value
  }))
  check('「清除」按钮清空两端日期', cleared.from === '' && cleared.to === '', JSON.stringify(cleared))
  check('清除后恢复 33 条', (await rowCount(page)) === 33, `${await rowCount(page)}`)

  // ── 6. 操作页表单 ────────────────────────────────────────
  section('6. 操作页表单')
  await switchTab(page, '操作')
  await page.waitForTimeout(400)

  const formWidths = await page.evaluate(() =>
    [...document.querySelectorAll('.tx-form')].map((f) =>
      [...f.querySelectorAll('input')].map((i) => Math.round(i.getBoundingClientRect().width))
    )
  )
  check(
    '入库表单六个输入框等宽（历史缺陷：名称/操作人在定位容器里没撑满）',
    formWidths[0].length === 6 && new Set(formWidths[0]).size === 1,
    formWidths[0].join(', ')
  )
  check(
    '出库表单六个输入框等宽',
    formWidths[1].length === 6 && new Set(formWidths[1]).size === 1,
    formWidths[1].join(', ')
  )

  const inForm = page.locator('.tx-form').first()
  const outForm = page.locator('.tx-form').nth(1)
  const nameInput = inForm.locator('input[type="text"]').nth(0)
  const unitInput = inForm.locator('input[type="text"]').nth(1)
  const opInput = inForm.locator('input[type="text"]').nth(2)
  const handlerInput = inForm.locator('input[type="text"]').nth(3)
  const qtyInput = inForm.locator('input[type="number"]')
  const submitBtn = inForm.locator('button[type="submit"]')

  // 6a 单位锁定
  await nameInput.fill('铜线 1.5mm²')
  await page.waitForTimeout(300)
  check('名称填已存在物品 → 单位自动带出「米」', (await unitInput.inputValue()) === '米', await unitInput.inputValue())
  check('单位框变为只读', (await unitInput.getAttribute('readonly')) !== null)
  const lockHint = await page.evaluate(() => document.querySelector('.tx-locked')?.textContent ?? '')
  check('单位标签显示「（已锁定）」', lockHint.includes('已锁定'), lockHint)

  // 6b 操作人补全
  // 补全提示必须**按表单取**：操作页两个表单同时在 DOM 里，
  // 用 document 全局查会把另一个表单的提示也收进来，
  // 「出库不该建议入库经手人」这类断言就会假失败。
  const formSuggestions = (idx) =>
    page.evaluate((i) => {
      const f = document.querySelectorAll('.tx-form')[i]
      return [...f.querySelectorAll('.tx-suggestion')].map((b) => b.textContent.trim())
    }, idx)

  await opInput.fill('张')
  await page.waitForTimeout(250)
  let suggestions = await formSuggestions(0)
  check('操作人输入「张」→ 提示含「张三」', suggestions.includes('张三'), suggestions.join(',') || '(无提示)')
  await opInput.fill('张三')
  await page.waitForTimeout(250)
  suggestions = await formSuggestions(0)
  check('已输入完整姓名后不再推荐自身（历史缺陷）', !suggestions.includes('张三'), suggestions.join(',') || '(无提示)')
  await opInput.fill('')

  // 6b-2 经手人 / 领取人（新增字段，与操作人并存）
  const inLabels = await page.evaluate(() =>
    [...document.querySelectorAll('.tx-form')[0].querySelectorAll('.tx-field label')].map((l) =>
      l.textContent.trim()
    )
  )
  const outLabels = await page.evaluate(() =>
    [...document.querySelectorAll('.tx-form')[1].querySelectorAll('.tx-field label')].map((l) =>
      l.textContent.trim()
    )
  )
  check(
    '入库表单标签是「经手人」',
    inLabels.includes('经手人') && !inLabels.includes('领取人'),
    inLabels.join('|')
  )
  check(
    '出库表单标签是「领取人」',
    outLabels.includes('领取人') && !outLabels.includes('经手人'),
    outLabels.join('|')
  )
  check('两个表单都保留了「操作人」这一格（并存，不是替换）', inLabels.includes('操作人') && outLabels.includes('操作人'), inLabels.join('|'))

  // 补全只在本方向的记录里找：入库建议历来的经手人，出库建议历来的领取人
  await handlerInput.fill('赵')
  await page.waitForTimeout(250)
  const inHandlerSug = await formSuggestions(0)
  check('入库的经手人输入「赵」→ 提示含「赵六」', inHandlerSug.includes('赵六'), inHandlerSug.join(',') || '(无提示)')

  const outHandlerInput = outForm.locator('input[type="text"]').nth(3)
  await outHandlerInput.fill('孙')
  await page.waitForTimeout(250)
  const outHandlerSug = await formSuggestions(1)
  check('出库的领取人输入「孙」→ 提示含「孙八」', outHandlerSug.includes('孙八'), outHandlerSug.join(',') || '(无提示)')
  // 反向：出库表单不该建议入库的经手人（两个角色不互相串）。
  // 注意查的是**出库那个表单内部**的提示 —— 入库表单此时还留着「赵」，
  // 全局查会把它自己的提示也算进来。
  check(
    '出库的领取人补全里没有入库的经手人「赵六」（两个角色不串）',
    !outHandlerSug.includes('赵六'),
    outHandlerSug.join(',') || '(无提示)'
  )
  await outHandlerInput.fill('')
  await handlerInput.fill('')

  // 入库表单填上经手人，后面的提交会把它带进记录
  await handlerInput.fill('赵六')
  await page.waitForTimeout(200)
  check('经手人输入框取到了「赵六」', (await handlerInput.inputValue()) === '赵六', await handlerInput.inputValue())

  // 6c 新物品自动建立
  await nameInput.fill('排针 2.54mm')
  await qtyInput.fill('300')
  await unitInput.fill('排')
  await page.waitForTimeout(200)
  check('新物品时提交按钮可用', !(await submitBtn.isDisabled()))
  await submitBtn.click()
  await page.waitForTimeout(600)
  check('提交后表单清空名称', (await nameInput.inputValue()) === '', await nameInput.inputValue())
  check(
    '提交后经手人**保留**（同一批货通常由同一个人经手，不必每次重填）',
    (await handlerInput.inputValue()) === '赵六',
    await handlerInput.inputValue()
  )
  await switchTab(page, '仓库')
  await page.waitForTimeout(400)
  check('仓库页物品数 6 → 7', (await rowCount(page)) === 7, `${await rowCount(page)}`)
  const newRow = await warehouseRow(page, '排针 2.54mm')
  check(
    '新物品库存 = 300，单位 = 排',
    newRow?.['数量'] === '300' && newRow?.['单位'] === '排',
    rowText(newRow)
  )
  await shot(page, '5-new-item')

  // 6d 已有物品累加
  const before = await warehouseRow(page, '铜线 1.5mm²')
  check('铜线当前库存 -15（负数高亮）', before?.['数量'] === '-15', rowText(before))
  await switchTab(page, '操作')
  await page.waitForTimeout(300)
  // 切页签会让表单重新挂载，所以「保留经手人」只在同一次挂载内成立 —— 这里重新填
  check(
    '切页签后表单重新挂载，经手人回到空白（保留只限同一次挂载内）',
    (await handlerInput.inputValue()) === '',
    await handlerInput.inputValue()
  )
  await nameInput.fill('铜线 1.5mm²')
  await qtyInput.fill('45')
  await handlerInput.fill('赵六')
  await page.waitForTimeout(200)
  await submitBtn.click()
  await page.waitForTimeout(600)
  await switchTab(page, '仓库')
  await page.waitForTimeout(400)
  const after = await warehouseRow(page, '铜线 1.5mm²')
  check('入库 45 后铜线库存 -15 → 30（跨页自动刷新）', after?.['数量'] === '30', rowText(after))

  // ── 7. 撤销反向冲销 ──────────────────────────────────────
  // 上一节提交了两笔（排针新建 + 铜线入库 45），所以 33 → 35
  section('7. 撤销记录（反向冲销）')
  await switchTab(page, '记录')
  await page.waitForTimeout(400)
  check('记录数 33 → 35（上一节新增两笔）', (await rowCount(page)) === 35, `${await rowCount(page)}`)
  const firstRow = await page.evaluate(() => {
    const tr = document.querySelector('tbody tr')
    if (!tr) return null
    const ths = [...tr.closest('table').querySelectorAll('thead th')]
    const out = {}
    ths.forEach((th, i) => {
      const key = th.textContent.trim().replace(/（[^）]*）|\([^)]*\)/g, '').trim()
      const td = tr.querySelectorAll('td')[i]
      if (td) out[key] = td.textContent.trim()
    })
    return out
  })
  check(
    '最新一条是刚提交的铜线入库 45',
    firstRow?.['名称'] === '铜线 1.5mm²' &&
      firstRow?.['数量'] === '45' &&
      firstRow?.['类型'] === '入库',
    rowText(firstRow)
  )
  // 界面填的经手人必须真的落到记录里（走的是 渲染进程 → IPC → 磁盘 这条完整链路）
  check(
    '界面填的经手人「赵六」落进了记录',
    firstRow?.['经手人/领取人'] === '赵六',
    rowText(firstRow)
  )

  /*
   * 撤销自 2026-10-02 起要口令 —— 原来的 `window.confirm` 换成了口令框，
   * 而且**合并成一步**：既确认（写清是哪条记录、货交给了谁）又输口令。
   */
  dialogs.length = 0
  await page.evaluate(() => {
    ;[...document.querySelectorAll('tbody tr')][0].querySelector('button').click()
  })
  await page.waitForSelector('.modal-overlay')
  await page.waitForTimeout(300)
  check('点撤销 → 弹出口令框（不再是浏览器 confirm）', (await page.locator('.modal-overlay').count()) === 1)
  check(
    '口令框标题是「撤销这条记录？」',
    ((await page.locator('.modal h3').textContent()) ?? '').trim() === '撤销这条记录？',
    await page.locator('.modal h3').textContent()
  )
  const undoText = (await page.locator('.modal-text').textContent()) ?? ''
  check('口令框里写明了记录内容', /铜线 1\.5mm²/.test(undoText), undoText.replace(/\s+/g, ' ').slice(0, 90))
  // 撤销是反向冲销库存的破坏性操作，框里要能看出「货交给了谁」
  check(
    '口令框里带上了经手人（入库用「经手人」这个叫法）',
    /经手人：赵六/.test(undoText),
    undoText.replace(/\s+/g, ' ').slice(0, 90)
  )
  check('口令框说明了撤销的后果', /反向冲销/.test(undoText), undoText.replace(/\s+/g, ' ').slice(0, 90))

  // 口令错：一步都不许往下走
  await page.locator('.modal input[type="password"]').fill('000000')
  await page.locator('.modal .btn-danger').click()
  await page.waitForTimeout(350)
  check('口令错误 → 对话框不关', (await page.locator('.modal-overlay').count()) === 1)
  check('口令错误 → 框内给出提示', (await page.locator('.modal-error').count()) >= 1)
  check('口令错误 → 记录数没变（没被撤销掉）', (await rowCount(page)) === 35, `${await rowCount(page)}`)

  // 口令对：撤销
  await page.locator('.modal input[type="password"]').fill('771204')
  await page.locator('.modal .btn-danger').click()
  await page.waitForTimeout(900)
  check('口令正确 → 对话框关闭', (await page.locator('.modal-overlay').count()) === 0)
  check('记录数回到 34（只撤销掉那一条）', (await rowCount(page)) === 34, `${await rowCount(page)}`)
  // 撤销入库 45 会让铜线库存变负，那条告警仍要照常弹
  check(
    '撤销后照常弹出「库存变为负数」告警',
    dialogs.some((d) => /库存变为负数/.test(d.message)),
    JSON.stringify(dialogs.map((d) => d.message.slice(0, 50)))
  )
  await switchTab(page, '仓库')
  await page.waitForTimeout(400)
  const undone = await warehouseRow(page, '铜线 1.5mm²')
  check('铜线库存 30 → -15（撤销反向冲销）', undone?.['数量'] === '-15', rowText(undone))
  await shot(page, '6-after-undo')

  // ── 8. 操作页表单的时间默认值 ────────────────────────────
  // 默认时间是**表单挂载那一刻**取的。停在操作页跨过零点，默认值就成了昨天的日期。
  // 这里用假时钟把「跨零点」造出来 —— 否则只能干等一天，等于没有覆盖。
  //
  // 刻意不用 page.reload()：重载会打断前面所有小节积累的状态，
  // 而且时钟冻结后 React 的调度可能不刷新。切页签同样能让表单重新挂载，
  // 且点击是离散事件，React 会同步 flush，不依赖定时器。
  section('8. 操作页表单时间默认值')

  await switchTab(page, '仓库') // 先离开操作页，确保表单处于卸载状态
  await page.waitForTimeout(200)
  await page.clock.install({ time: new Date('2026-09-19T23:58:00') })
  await switchTab(page, '操作')
  await page.waitForTimeout(400)

  // 变量名带 clock 前缀：本文件 run() 是单个大函数作用域，
  // 第 6 节已经声明过 inForm / nameInput / qtyInput，重名会直接语法报错。
  const clockForm = page.locator('.tx-form').first()
  const clockTime = clockForm.locator('input[type="datetime-local"]')
  const clockName = clockForm.locator('input[type="text"]').first()
  const clockQty = clockForm.locator('input[type="number"]')

  check(
    '表单挂载时默认时间就是当前时刻',
    (await clockTime.inputValue()) === '2026-09-19T23:58',
    await clockTime.inputValue()
  )

  await page.clock.fastForward(10 * 60 * 1000) // 时间前进 10 分钟，跨过零点

  await clockName.click() // 用户开始操作表单，但没碰时间框
  check(
    '跨零点后一操作表单，默认时间校准到次日',
    (await clockTime.inputValue()) === '2026-09-20T00:08',
    await clockTime.inputValue()
  )

  await clockTime.fill('2026-09-20T09:30') // 手动改时间 → 之后不该再被刷新覆盖
  await clockQty.click()
  check(
    '手动改过的时间不会被聚焦刷新覆盖',
    (await clockTime.inputValue()) === '2026-09-20T09:30',
    await clockTime.inputValue()
  )

  // ── 9. 导出 Excel ───────────────────────────────────────
  section('9. 导出 Excel：真产出一份能被解析的工作簿')

  /*
   * 打包配置把 node_modules/xlsx 排除了（依据是它被 Vite 内联进渲染 bundle）。
   * 这个前提一旦不成立，导出会**静默失效** —— 而真实导出走原生保存对话框，
   * Playwright 点不了。
   *
   * 关键：在**预览版里可以绕开**。预览版的 `window.api` 是 preview/mock.ts 里
   * 直接挂上去的普通对象，所以能替换掉 `exportXlsx`，只截取渲染进程**已经算好**的
   * 字节。而预览版跑的渲染 bundle 与打包产物是同一份，因此这确实覆盖了
   * 「打包后导出还能不能用」这个风险。
   *
   * 真 Electron 里做不到：`window.api` 是 contextBridge 暴露的，frozen + sealed，
   * 赋值静默失败、`defineProperty` 直接抛 TypeError，连 `window.api` 本身都不可写。
   * （这个结论是实测出来的，不是猜的。）
   *
   * 截到的字节要拿回 Node 用 xlsx **真解析一遍**：只断言「长度非零」不够 ——
   * 半截数据、错的工作簿类型都能骗过长度检查。
   */
  await switchTab(page, '记录')
  await page.waitForSelector('table.table')
  const exportRows = await page.$$eval('table.table tbody tr', (rs) => rs.length)
  check('记录页有数据可供导出', exportRows > 0, `${exportRows} 行`)

  /*
   * alert 要一起换掉：导出成功/失败时代码都会弹 alert，那是**阻塞**对话框。
   *
   * ⚠️ 原函数必须存下来，用完还原（见本节末尾）。这个坑 2026-09-23 真踩过：
   * 当时只写了 `window.alert = () => {}` 没还原，于是**后面所有小节**里
   * 依赖 alert 的断言全部静默失效 —— 代码明明调了 alert、文案也对，
   * 但 dialog 事件永远不会到 Node 侧，断言只能看到空数组。
   * 9c 的负库存告警就是这么被废掉的（用探针拦 window.alert 才定位到）。
   */
  const patchOk = await page.evaluate(() => {
    window.__origAlert = window.alert
    window.__origExportXlsx = window.api.exportXlsx
    window.alert = () => {}
    window.__export = null
    window.api.exportXlsx = async (data, name) => {
      const bytes = Uint8Array.from(data)
      let bin = ''
      for (const b of bytes) bin += String.fromCharCode(b)
      window.__export = { name, len: bytes.length, b64: btoa(bin) }
      return { ok: true, path: '（已拦截，未真的写文件）' }
    }
    return window.api.exportXlsx.name === '' || String(window.api.exportXlsx).includes('__export')
  })
  check('预览版 window.api 可替换（真 Electron 里是 frozen，做不到）', patchOk === true)

  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('导出'))
    if (b) b.click()
  })
  await page.waitForFunction(() => window.__export !== null, null, { timeout: 5000 }).catch(() => {})
  const exported = await page.evaluate(() => window.__export)
  check('点「导出 Excel」后渲染进程产出了字节', exported !== null && exported.len > 0,
    exported ? `${exported.name} / ${exported.len} 字节` : '没截到')
  check('默认文件名是「出入库记录.xlsx」', exported?.name === '出入库记录.xlsx', String(exported?.name))

  if (exported?.b64) {
    const xbuf = Buffer.from(exported.b64, 'base64')
    // xlsx 本质是 zip，头四字节应当是 PK\x03\x04
    check('字节以 ZIP 魔数 PK 03 04 开头（xlsx 就是 zip）',
      xbuf[0] === 0x50 && xbuf[1] === 0x4b && xbuf[2] === 0x03 && xbuf[3] === 0x04,
      [...xbuf.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' '))

    const XLSX = require('xlsx')
    const wb = XLSX.read(xbuf, { type: 'buffer' })
    check('能被 xlsx 解析出唯一工作表「出入库记录」',
      wb.SheetNames.length === 1 && wb.SheetNames[0] === '出入库记录', wb.SheetNames.join(' | '))
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['出入库记录'], { header: 1 })
    check('表头为 时间/名称/数量/单位/备注/操作人/经手人/领取人/类型',
      JSON.stringify(rows[0]) ===
        JSON.stringify(['时间', '名称', '数量', '单位', '备注', '操作人', '经手人/领取人', '类型']),
      JSON.stringify(rows[0]))
    check('数据行数与界面上的记录数一致（表头之外）', rows.length - 1 === exportRows,
      `表里 ${rows.length - 1} 行 / 界面 ${exportRows} 行`)
    check('导出的是全部记录，不是空表', rows.slice(1).some((r) => typeof r[1] === 'string' && r[1].length > 0))
    // 交接人这一列要真带上值：界面里填过「赵六」，导出不该变成一列「—」
    const hCol = rows[0].indexOf('经手人/领取人')
    check(
      '导出的「经手人/领取人」列带上了实际值（含赵六）',
      rows.slice(1).some((r) => r[hCol] === '赵六'),
      JSON.stringify([...new Set(rows.slice(1).map((r) => r[hCol]))].slice(0, 6))
    )
  }

  // 用完必须还原：这个桩是**全局**的，留着会静默废掉后面所有 alert 断言
  const restoredGlobals = await page.evaluate(() => {
    const stubAlert = window.alert
    const stubExport = window.api.exportXlsx
    // 先确认「原函数确实存下来了」——否则下面 window.alert = undefined 也会
    // 让 `undefined === undefined` 为真，判据就成了空的
    const hadOrigAlert = typeof window.__origAlert === 'function'
    const hadOrigExport = typeof window.__origExportXlsx === 'function'
    window.alert = window.__origAlert
    window.api.exportXlsx = window.__origExportXlsx
    return {
      hadOrigAlert,
      hadOrigExport,
      // 还原成功的判据：指向原函数，且确实不再是那个桩
      okAlert: hadOrigAlert && window.alert === window.__origAlert && window.alert !== stubAlert,
      okExport:
        hadOrigExport &&
        window.api.exportXlsx === window.__origExportXlsx &&
        window.api.exportXlsx !== stubExport
    }
  })
  check(
    '第 9 节替换掉的 window.alert 已还原（否则后面所有依赖 alert 的断言都会被静默废掉）',
    restoredGlobals.okAlert,
    JSON.stringify(restoredGlobals)
  )
  check(
    '被替换的 window.api.exportXlsx 也已还原',
    restoredGlobals.okExport,
    JSON.stringify(restoredGlobals)
  )

  // ── 9b. 重命名 ───────────────────────────────────────────
  /*
   * 改名这条链要验四件事，少一件都可能「看着能用、实际不对」：
   *   1. 双击能进编辑态，回车能提交
   *   2. 改完之后**仓库 / 记录 / 报表三页都变** —— 记录里存的是名称快照，
   *      只改物品不改快照的话，记录页会一直显示旧名字
   *   3. 右键菜单里也能改名（用户不知道能双击时的第二条路）
   *   4. 撞名要合并，且**单位不一致时必须弹出选单位的框** ——
   *      这是唯一会让库存数量失去物理意义的路径，不能静默走掉
   *
   * 放在第 9 节之后：这一节会改名、还会并掉一个物品，
   * 前面的用例都依赖固定的物品名与数量，不能被打乱。
   */
  section('9b. 重命名物品（双击 / 右键 / 撞名合并）')

  /** 仓库页里第一格文字正好等于 name 的行下标；找不到返回 -1 */
  const whRowIdx = (page, name) =>
    page.evaluate((n) => {
      const rows = [...document.querySelectorAll('table.table tbody tr')]
      return rows.findIndex((r) => r.querySelector('td.name-col')?.textContent?.trim() === n)
    }, name)

  /** 记录页里「名称」列等于 name 的第一行下标（按表头名取列，不按下标） */
  const recRowIdx = (page, name) =>
    page.evaluate((n) => {
      const t = document.querySelector('table.table')
      const ths = [...t.querySelectorAll('thead th')]
      const i = ths.findIndex((th) => th.textContent.trim() === '名称')
      const rows = [...t.querySelectorAll('tbody tr')]
      return rows.findIndex((r) => r.querySelectorAll('td')[i]?.textContent?.trim() === n)
    }, name)

  /** 当前表格里所有名称（仓库页取第一格，记录页取「名称」列） */
  const whNames = (page) =>
    page.evaluate(() =>
      [...document.querySelectorAll('table.table tbody tr')].map(
        (r) => r.querySelector('td.name-col')?.textContent?.trim() ?? ''
      )
    )

  /** 记录页「名称」列的全部取值（按表头名取列，不按下标） */
  const recNames = (page) =>
    page.evaluate(() => {
      const t = document.querySelector('table.table')
      const ths = [...t.querySelectorAll('thead th')]
      const i = ths.findIndex((th) => th.textContent.trim() === '名称')
      return [...t.querySelectorAll('tbody tr')].map(
        (r) => r.querySelectorAll('td')[i]?.textContent?.trim() ?? ''
      )
    })

  /** 等某个名字出现（改名是异步落盘 + 广播刷新，不能立刻断言） */
  const waitName = async (page, name, listFn = whNames) => {
    for (let i = 0; i < 40; i++) {
      if ((await listFn(page)).includes(name)) return true
      await sleep(100)
    }
    return false
  }

  await switchTab(page, '仓库')
  await page.waitForSelector('table.table')

  // ── 双击改名 ─────────────────────────────────────────────
  const OLD = '焊锡丝 0.8mm'
  const NEW1 = '焊锡丝 无铅'
  const idx0 = await whRowIdx(page, OLD)
  check('找得到待改名的物品「焊锡丝 0.8mm」', idx0 >= 0, `下标 ${idx0}`)

  await page.locator('table.table tbody tr').nth(idx0).locator('.name-text').dblclick()
  check('双击后出现名称编辑框', await page.locator('input.name-input').isVisible())
  check(
    '编辑框里预填的是当前名称',
    (await page.locator('input.name-input').inputValue()) === OLD,
    await page.locator('input.name-input').inputValue()
  )

  await page.locator('input.name-input').fill(NEW1)
  await page.locator('input.name-input').press('Enter')
  check('回车提交后编辑框消失', (await page.locator('input.name-input').count()) === 0)
  check('仓库页出现了新名称', await waitName(page, NEW1))
  check('仓库页里旧名称已消失', !(await whNames(page)).includes(OLD))
  check('改名不改物品数量（12 卷还在）', await page.evaluate(() =>
    [...document.querySelectorAll('table.table tbody tr')]
      .filter((r) => r.querySelector('td.name-col')?.textContent?.trim() === '焊锡丝 无铅')
      .map((r) => r.querySelector('td.qty-col')?.textContent?.trim())[0] === '12'
  ))

  // ── 三页同步 ─────────────────────────────────────────────
  await switchTab(page, '记录')
  await page.waitForSelector('table.table')
  check('记录页出现了新名称（名称快照被一起改了）', await waitName(page, NEW1, recNames))
  check(
    '记录页里旧名称一条都不剩',
    await page.evaluate(() =>
      ![...document.querySelectorAll('table.table tbody tr')].some((r) =>
        [...r.querySelectorAll('td')].some((td) => td.textContent.trim() === '焊锡丝 0.8mm')
      )
    )
  )

  await switchTab(page, '报表')
  await page.waitForSelector('.report-card')
  check(
    '报表页的卡片标题也变成了新名称',
    await page.evaluate(() =>
      [...document.querySelectorAll('.report-name')].some((e) => e.textContent.trim() === '焊锡丝 无铅')
    )
  )

  // ── 右键菜单改名（记录页，作用范围是整个物品） ───────────
  await switchTab(page, '记录')
  await page.waitForSelector('table.table')
  const NEW2 = '焊锡丝 免洗'
  const rIdx = await recRowIdx(page, NEW1)
  check('记录页找得到该物品的记录', rIdx >= 0, `下标 ${rIdx}`)

  await page.locator('table.table tbody tr').nth(rIdx).locator('.name-text').click({ button: 'right' })
  check('右键弹出菜单', await page.locator('.ctx-menu').isVisible())
  check(
    '菜单里有「修改名称」',
    (await page.locator('.ctx-menu .ctx-item').allTextContents()).includes('修改名称'),
    (await page.locator('.ctx-menu .ctx-item').allTextContents()).join('|')
  )
  await page.locator('.ctx-menu .ctx-item', { hasText: '修改名称' }).click()
  check('点菜单后进入编辑态', await page.locator('input.name-input').isVisible())
  await page.locator('input.name-input').fill(NEW2)
  await page.locator('input.name-input').press('Enter')

  check(
    '在记录页改名 → 该物品的**所有**记录一起变（不是只改这一条）',
    await (async () => {
      for (let i = 0; i < 40; i++) {
        const all = await page.evaluate(() => {
          const t = document.querySelector('table.table')
          const ths = [...t.querySelectorAll('thead th')]
          const i = ths.findIndex((th) => th.textContent.trim() === '名称')
          return [...t.querySelectorAll('tbody tr')].map((r) => r.querySelectorAll('td')[i]?.textContent?.trim())
        })
        if (all.includes('焊锡丝 免洗') && !all.includes('焊锡丝 无铅')) return true
        await sleep(100)
      }
      return false
    })()
  )

  await switchTab(page, '仓库')
  await page.waitForSelector('table.table')
  check('记录页改名同样反映到仓库页', await waitName(page, NEW2))

  // ── 撞名合并：单位不一致必须弹选单位的框 ─────────────────
  const itemsBeforeMerge = await rowCount(page)
  const pcbQty = await page.evaluate(() =>
    Number(
      [...document.querySelectorAll('table.table tbody tr')]
        .filter((r) => r.querySelector('td.name-col')?.textContent?.trim() === 'PCB 打样板')
        .map((r) => r.querySelector('td.qty-col')?.textContent?.trim())[0]
    )
  )
  const solderQty = await page.evaluate(() =>
    Number(
      [...document.querySelectorAll('table.table tbody tr')]
        .filter((r) => r.querySelector('td.name-col')?.textContent?.trim() === '焊锡丝 免洗')
        .map((r) => r.querySelector('td.qty-col')?.textContent?.trim())[0]
    )
  )

  const mergeIdx = await whRowIdx(page, NEW2)
  await page.locator('table.table tbody tr').nth(mergeIdx).locator('.name-text').dblclick()
  await page.locator('input.name-input').fill('PCB 打样板')
  await page.locator('input.name-input').press('Enter')

  check('撞名时弹出合并确认框', await page.locator('.modal').isVisible())
  check(
    '确认框标题是「合并到已有物品」',
    (await page.locator('.modal-header h3').textContent()) === '合并到已有物品',
    await page.locator('.modal-header h3').textContent()
  )
  check(
    '单位不一致 → 出现选单位的区域',
    (await page.locator('.unit-choice').count()) === 1
  )
  const unitBtns = await page.locator('.unit-choice-btns button').allTextContents()
  check(
    '两个单位都作为按钮给出（卷、块各一个）',
    JSON.stringify([...unitBtns].sort()) === JSON.stringify(['块', '卷'].sort()),
    unitBtns.join('|')
  )
  // 顺序也有意义：第一个是**保留下来的那个物品**的单位，也就是默认选项。
  // 反过来（默认选被并掉的那方的单位）会让用户一不留神就把库存改成另一个量纲。
  check(
    '默认排在第一个的是保留方（PCB）的单位「块」',
    unitBtns[0] === '块',
    unitBtns.join('|')
  )
  check('还有输入新单位的输入框', (await page.locator('.unit-choice-input').count()) === 1)

  // 先验「取消」不留痕：合并是不可逆的，取消必须真的什么都不做
  await page.locator('.modal-actions .btn', { hasText: '取消' }).click()
  check('取消后对话框关闭', (await page.locator('.modal').count()) === 0)
  check('取消后物品没有被并掉', (await whNames(page)).includes(NEW2))
  check('取消后物品数不变', (await rowCount(page)) === itemsBeforeMerge)

  // 再来一次，这回真合并
  await page.locator('table.table tbody tr').nth(await whRowIdx(page, NEW2)).locator('.name-text').dblclick()
  await page.locator('input.name-input').fill('PCB 打样板')
  await page.locator('input.name-input').press('Enter')
  await page.locator('.unit-choice-btns button', { hasText: '卷' }).click()
  await page.locator('.modal-actions .btn', { hasText: '合并' }).click()

  check('合并后对话框关闭', (await page.locator('.modal').count()) === 0)
  check('合并后被并掉的物品名消失', !(await whNames(page)).includes(NEW2))
  check('物品数少了一个', (await rowCount(page)) === itemsBeforeMerge - 1, `${await rowCount(page)}`)
  check(
    '数量按「卷」累加（PCB 的 0 + 焊锡丝的 12 = 12）',
    await (async () => {
      for (let i = 0; i < 40; i++) {
        const q = await page.evaluate(() =>
          [...document.querySelectorAll('table.table tbody tr')]
            .filter((r) => r.querySelector('td.name-col')?.textContent?.trim() === 'PCB 打样板')
            .map((r) => r.querySelector('td.qty-col')?.textContent?.trim())[0]
        )
        if (Number(q) === pcbQty + solderQty) return true
        await sleep(100)
      }
      return false
    })(),
    `期望 ${pcbQty + solderQty}`
  )
  check(
    '合并后单位用的是选中的「卷」',
    await page.evaluate(() =>
      [...document.querySelectorAll('table.table tbody tr')]
        .filter((r) => r.querySelector('td.name-col')?.textContent?.trim() === 'PCB 打样板')
        .map((r) => r.querySelector('td.unit-col')?.textContent?.trim())[0] === '卷'
    )
  )

  // ── 单位一致时不该出现选单位的区域 ───────────────────────
  const idleIdx = await whRowIdx(page, '闲置物料 X')
  check('找得到「闲置物料 X」', idleIdx >= 0, `下标 ${idleIdx}`)
  await page.locator('table.table tbody tr').nth(idleIdx).locator('.name-text').dblclick()
  await page.locator('input.name-input').fill('贴片电阻 10kΩ')
  await page.locator('input.name-input').press('Enter')
  check('撞名时仍然弹合并确认框', (await page.locator('.modal').count()) === 1)
  check(
    '两边单位都是「个」→ 不出现选单位的区域（不该让用户白选一次）',
    (await page.locator('.unit-choice').count()) === 0
  )
  await page.locator('.modal-actions .btn', { hasText: '取消' }).click()
  check('取消后「闲置物料 X」还在', (await whNames(page)).includes('闲置物料 X'))

  // 改名不该写流水
  await switchTab(page, '记录')
  await page.waitForSelector('table.table')
  const recAfterRename = await page.$$eval('table.table tbody tr', (rs) => rs.length)
  check('改名与合并都没有产生新的出入库流水', recAfterRename === exportRows, `${recAfterRename} vs ${exportRows}`)

  // ── 从记录页发起合并：另一条路径 ─────────────────────────
  /*
   * 上面那次合并是从**仓库页**发起的。从**记录页**发起是另一条代码路径 ——
   * 源物品的记录正被列表遍历着，合并会把它们整体改嫁到目标物品名下、
   * 再把源物品从 items 里删掉。列表和物品表同时变化，容易出问题。
   *
   * 用户的需求里「记录页也能改名」是明确写了的，所以这条路径必须覆盖。
   */
  const REC_SRC = '贴片电阻 10kΩ'
  const REC_DST = 'M3×8 螺丝'
  const recSrcIdx = await recRowIdx(page, REC_SRC)
  check(`记录页找得到「${REC_SRC}」的记录`, recSrcIdx >= 0, `下标 ${recSrcIdx}`)

  await switchTab(page, '仓库')
  const itemsBeforeRecMerge = await rowCount(page)
  await switchTab(page, '记录')
  await page.waitForSelector('table.table')

  await page.locator('table.table tbody tr').nth(recSrcIdx).locator('.name-text').dblclick()
  await page.locator('input.name-input').fill(REC_DST)
  await page.locator('input.name-input').press('Enter')
  check('从记录页撞名同样弹出合并确认框', (await page.locator('.modal').count()) === 1)
  check(
    '两边单位都是「个」→ 不出现选单位的区域',
    (await page.locator('.unit-choice').count()) === 0
  )
  await page.locator('.modal-actions .btn', { hasText: '合并' }).click()
  check('从记录页合并后对话框关闭', (await page.locator('.modal').count()) === 0)

  check(
    '记录页里被并掉的名称一条不剩（所有记录都改嫁到目标物品名下）',
    await (async () => {
      for (let i = 0; i < 40; i++) {
        const names = await recNames(page)
        if (!names.includes(REC_SRC) && names.includes(REC_DST)) return true
        await sleep(100)
      }
      return false
    })(),
    (await recNames(page)).filter((n) => n === REC_SRC).length + ' 条残留'
  )

  await switchTab(page, '仓库')
  await page.waitForSelector('table.table')
  check(
    '仓库页物品数少了一个',
    (await rowCount(page)) === itemsBeforeRecMerge - 1,
    `${await rowCount(page)} vs ${itemsBeforeRecMerge - 1}`
  )
  check('仓库页不再有被并掉的名称', !(await whNames(page)).includes(REC_SRC))

  await switchTab(page, '报表')
  await page.waitForSelector('.report-card')
  const reportNames = await page.evaluate(() =>
    [...document.querySelectorAll('.report-name')].map((e) => e.textContent.trim())
  )
  check('报表页也不再有被并掉的卡片', !reportNames.includes(REC_SRC), reportNames.join('/'))
  check('报表页有合并后的卡片', reportNames.includes(REC_DST), reportNames.join('/'))

  // ── 9c. 仓库页行内「入库 / 出库」弹窗：另一个入口 ──────────
  /*
   * 出入库有**两个入口**：
   *   ①「操作」页的常驻表单 —— 第 6 节测的是它
   *   ② 仓库页每行的「入库 / 出库」按钮弹出的对话框 —— 本节
   *
   * 两者共用 TransactionForm，但**挂载方式与收尾都不同**：弹窗是条件渲染的
   * （modalType 为真才挂载）、要把物品名预填进去、提交成功后自己关掉，
   * 而且 onCancel 只在弹窗里传。只测入口①，入口② 一行都没跑过 ——
   * 这正是「一个功能多个入口、只覆盖一个」的盲区。
   *
   * 全部用**相对断言**（提交前后比库存、比记录条数），不写死绝对条数：
   * 这样这一节插在哪一段后面都不会被上游的写操作带偏。
   */
  section('9c. 仓库页行内「入库/出库」弹窗（另一个入口）')

  /**
   * 记录页所有行，每行打成 { 表头名: 值 }（按表头名取列，不按下标）。
   *
   * 刻意**不靠行位置**定位新记录：两条记录的时间若显示到同一分钟，
   * 谁排第一就取决于排序对并列的处理，拿「第一行」断言会随机失败 ——
   * 这条断言第一版正是这么挂的（取到的第一行是第 6 节那条旧记录）。
   */
  const recRows = () =>
    page.evaluate(() => {
      const t = document.querySelector('table.table')
      const ths = [...t.querySelectorAll('thead th')].map((th) =>
        th.textContent.trim().replace(/（[^）]*）|\([^)]*\)/g, '').trim()
      )
      return [...t.querySelectorAll('tbody tr')].map((tr) => {
        const tds = [...tr.querySelectorAll('td')]
        const out = {}
        ths.forEach((k, i) => {
          if (tds[i]) out[k] = tds[i].textContent.trim()
        })
        return out
      })
    })

  /** 一条记录的「内容指纹」—— 用来数「这一笔」多了几条，与行序无关 */
  const recKey = (r) => `${r['名称']}|${r['类型']}|${r['数量']}|${r['单位']}`

  // 先记下记录条数与内容供提交后做相对比较（此时筛选已清空）
  await switchTab(page, '记录')
  await page.waitForSelector('table.table')
  await page.waitForTimeout(400)
  const recBefore = await rowCount(page)
  const recRowsBefore = await recRows()

  await switchTab(page, '仓库')
  await page.waitForSelector('table.table')
  await page.waitForTimeout(300)

  // 取第一行作为目标物品：不写死名字，上游小节改名/合并过也不会失配
  const TGT = (await whNames(page))[0]
  check('取到目标物品', Boolean(TGT), JSON.stringify(TGT))

  const rowButtons = (name) =>
    page.evaluate((n) => {
      const tr = [...document.querySelectorAll('table.table tbody tr')].find(
        (r) => r.querySelector('td.name-col')?.textContent?.trim() === n
      )
      return tr
        ? [...tr.querySelectorAll('td:last-child button')].map((b) => b.textContent.trim())
        : []
    }, name)

  const rowBtns = await rowButtons(TGT)
  check(
    `仓库页「${TGT}」这一行有「入库」和「出库」按钮`,
    rowBtns.includes('入库') && rowBtns.includes('出库'),
    rowBtns.join('/') || '(没有按钮)'
  )

  const clickRowBtn = (name, label) =>
    page.evaluate(
      ([n, l]) => {
        const tr = [...document.querySelectorAll('table.table tbody tr')].find(
          (r) => r.querySelector('td.name-col')?.textContent?.trim() === n
        )
        if (!tr) throw new Error('找不到行：' + n)
        const b = [...tr.querySelectorAll('td:last-child button')].find(
          (x) => x.textContent.trim() === l
        )
        if (!b) throw new Error('找不到按钮：' + l)
        b.click()
      },
      [name, label]
    )

  /** 弹窗标题（去掉空白再比：JSX 会把「—」两侧插成独立文本节点） */
  const modalTitle = async () =>
    ((await page.locator('.modal-header h3').first().textContent()) ?? '').replace(/\s/g, '')

  /** 仓库页某物品的库存数字 */
  const qtyOf = async (name) => {
    const row = await warehouseRow(page, name)
    return row ? Number(String(row['数量']).replace(/,/g, '')) : NaN
  }

  // 9c-1 入库弹窗
  await clickRowBtn(TGT, '入库')
  await page.waitForSelector('.modal-overlay')
  await page.waitForTimeout(250)
  check('点行内「入库」→ 弹出对话框', (await page.locator('.modal-overlay').count()) === 1)

  /*
   * 对话框的类名 `.modal` 与改名合并框**共用**，光数 `.modal` 分不清是哪一个。
   * 所以按**标题语义**断言 —— 顺带把这个「类名共用」的事实钉在这里，
   * 免得以后有人写个裸 `.modal` 计数断言，在两条路径上都「通过」却不知道验的是谁。
   */
  check(
    `对话框标题是「入库 — ${TGT}」（按标题区分，不靠共用类名）`,
    (await modalTitle()) === `入库—${TGT}`.replace(/\s/g, ''),
    JSON.stringify(await modalTitle())
  )

  check(
    '弹窗里只有这一个表单（操作页的常驻表单没跟着来）',
    (await page.locator('.tx-form').count()) === 1,
    `${await page.locator('.tx-form').count()} 个`
  )

  const mForm = page.locator('.modal .tx-form')
  const mName = mForm.locator('input[type="text"]').nth(0)
  const mUnit = mForm.locator('input[type="text"]').nth(1)
  const mQty = mForm.locator('input[type="number"]')

  check(
    '弹窗里的名称已预填成该物品（不用再手输一遍）',
    (await mName.inputValue()) === TGT,
    await mName.inputValue()
  )
  const tgtUnit = await mUnit.inputValue()
  check(
    `单位已带出并锁定为「${tgtUnit}」`,
    tgtUnit !== '' && (await mUnit.getAttribute('readonly')) !== null,
    tgtUnit || '(空)'
  )
  await shot(page, '6-行内入库弹窗')

  const beforeQty = await qtyOf(TGT)
  const IN_AMT = 7
  await mQty.fill(String(IN_AMT))
  await page.waitForTimeout(150)
  await mForm.locator('button[type="submit"]').click()
  await page.waitForTimeout(800)
  check('提交成功后弹窗自己关掉', (await page.locator('.modal-overlay').count()) === 0)

  const afterQty = await qtyOf(TGT)
  check(
    `入库 ${IN_AMT} 后「${TGT}」库存 ${beforeQty} → ${beforeQty + IN_AMT}`,
    afterQty === beforeQty + IN_AMT,
    `实际 ${afterQty}`
  )

  await switchTab(page, '记录')
  await page.waitForSelector('table.table')
  await page.waitForTimeout(400)
  check(
    `记录多了一条（${recBefore} → ${recBefore + 1}）`,
    (await rowCount(page)) === recBefore + 1,
    `${await rowCount(page)} vs ${recBefore + 1}`
  )
  const recRowsAfter = await recRows()
  const wanted = `${TGT}|入库|${IN_AMT}|${tgtUnit}`
  const nBefore = recRowsBefore.filter((r) => recKey(r) === wanted).length
  const nAfter = recRowsAfter.filter((r) => recKey(r) === wanted).length
  check(
    `多了一条「${TGT} / 入库 / ${IN_AMT} ${tgtUnit}」的记录（按内容数，不靠行位置）`,
    nAfter === nBefore + 1,
    `${nAfter} vs ${nBefore + 1}`
  )
  const tgtRecBefore = recRowsBefore.filter((r) => r['名称'] === TGT).length
  const tgtRecAfter = recRowsAfter.filter((r) => r['名称'] === TGT).length
  check(
    `「${TGT}」的记录总数 ${tgtRecBefore} → ${tgtRecBefore + 1}`,
    tgtRecAfter === tgtRecBefore + 1,
    `实际 ${tgtRecAfter}`
  )

  // 9c-2 出库弹窗 + 两种关闭方式
  await switchTab(page, '仓库')
  await page.waitForSelector('table.table')
  await page.waitForTimeout(300)

  await clickRowBtn(TGT, '出库')
  await page.waitForSelector('.modal-overlay')
  await page.waitForTimeout(250)
  check(
    `点行内「出库」→ 标题是「出库 — ${TGT}」`,
    (await modalTitle()) === `出库—${TGT}`.replace(/\s/g, ''),
    JSON.stringify(await modalTitle())
  )

  // 关闭方式一：右上角 ×
  await page.locator('.modal-close').click()
  await page.waitForTimeout(250)
  check('点右上角 × 能关掉弹窗', (await page.locator('.modal-overlay').count()) === 0)

  // 关闭方式二：点遮罩（弹窗自己 stopPropagation，点它内部不该被误关）
  await clickRowBtn(TGT, '出库')
  await page.waitForSelector('.modal-overlay')
  await page.waitForTimeout(250)
  await page.locator('.modal-overlay').click({ position: { x: 5, y: 5 } })
  await page.waitForTimeout(250)
  check('点遮罩也能关掉弹窗', (await page.locator('.modal-overlay').count()) === 0)
  check(
    '取消没写盘：关掉弹窗后库存不变',
    (await qtyOf(TGT)) === afterQty,
    `${await qtyOf(TGT)} vs ${afterQty}`
  )

  // 9c-3 从弹窗提交一笔「出库」—— 上面只提交过入库，出库是另一条分支
  /*
   * 按「入口 × 分支」的矩阵，弹窗这个入口下还有「出库」这个分支没走过：
   * 出库有自己的 warning 路径（负库存只警告不阻断），而且表单的
   * 经手人/领取人标签会跟着 type 变。只测弹窗的入库，等于出库那半边没验。
   */
  await switchTab(page, '仓库')
  await page.waitForSelector('table.table')
  await page.waitForTimeout(300)

  const dialogsBefore = dialogs.length
  await clickRowBtn(TGT, '出库')
  await page.waitForSelector('.modal-overlay')
  await page.waitForTimeout(250)

  const outModalForm = page.locator('.modal .tx-form')
  const outModalLabels = await outModalForm.locator('.tx-field label').allTextContents()
  check(
    '弹窗切到出库后，标签变成「领取人」（跟 type 走，不是写死的）',
    outModalLabels.some((l) => l.trim().startsWith('领取人')) &&
      !outModalLabels.some((l) => l.trim().startsWith('经手人')),
    outModalLabels.join('|')
  )

  // 出库量故意超过库存 → 走「负库存只警告不阻断」这条分支
  const OUT_AMT = afterQty + 5
  await outModalForm.locator('input[type="number"]').fill(String(OUT_AMT))
  await page.waitForTimeout(200)
  await shot(page, '7-行内出库弹窗')
  await page.waitForTimeout(150)
  await outModalForm.locator('button[type="submit"]').click()
  /*
   * alert 是渲染进程里同步阻塞的，dialog 事件到 Node 侧是异步的 —— 给它一点时间，
   * 别用固定 sleep 赌时长。
   *
   * 这里踩过一次：一开始断言一直看到空数组，看着像「负库存没弹警告」，
   * 实际是第 9 节把 window.alert 换成了空函数没还原（见本节之前的还原断言），
   * 代码其实调了、文案也对。定位手段是用探针把 window.alert 拦下来看调用记录 ——
   * 「dialog 没到」和「alert 没调」是两回事，先分清再改断言。
   */
  for (let i = 0; i < 40; i++) {
    if (dialogs.length > dialogsBefore) break
    await sleep(100)
  }
  check('出库提交后弹窗同样自己关掉', (await page.locator('.modal-overlay').count()) === 0)

  const afterOutQty = await qtyOf(TGT)
  check(
    `出库 ${OUT_AMT} 后库存 ${afterQty} → -5（负库存只警告不阻断）`,
    afterOutQty === -5,
    `实际 ${afterOutQty}`
  )

  const newDialogs = dialogs.slice(dialogsBefore)
  check(
    '负库存弹了警告（而不是静默写入）',
    newDialogs.some((d) => d.type === 'alert' && d.message.includes('库存已为负')),
    JSON.stringify(newDialogs)
  )
  /*
   * 钉住**逐字文案**。这段告警在两个地方各写了一份：真实数据层
   * （src/main/store/transactions.ts）与界面自检用的内存替身（preview/mock.ts）。
   * 界面层测的是替身 —— 替身改了而真实实现没改，这里照样绿，用户却看到另一句话。
   * 所以 verify-store.ts 里也钉了同一串字面量，两层一起改才不会漏。
   */
  check(
    '警告逐字文案与真实数据层一致（含物品名、负数库存、单位、补货提示）',
    newDialogs.some((d) => d.message === `「${TGT}」库存已为负（-5 ${tgtUnit}），请及时补货`),
    JSON.stringify(newDialogs.map((d) => d.message))
  )

  await switchTab(page, '记录')
  await page.waitForSelector('table.table')
  await page.waitForTimeout(400)
  const rowsAfterOut = await recRows()
  const wantedOut = `${TGT}|出库|${OUT_AMT}|${tgtUnit}`
  check(
    `多了一条「${TGT} / 出库 / ${OUT_AMT} ${tgtUnit}」的记录（按内容数，不靠行位置）`,
    rowsAfterOut.filter((r) => recKey(r) === wantedOut).length ===
      recRowsAfter.filter((r) => recKey(r) === wantedOut).length + 1,
    `${rowsAfterOut.filter((r) => recKey(r) === wantedOut).length} vs ${
      recRowsAfter.filter((r) => recKey(r) === wantedOut).length + 1
    }`
  )

  // ── 9d. 强行修改数量（双击 / 右键 + 口令） ────────────────
  section('9d. 仓库页：强行修改数量（双击 / 右键 + 口令）')

  /*
   * 此刻页面停在记录页（9c 结尾切过来的）。先在**改数之前**记下记录条数 ——
   * 这一节要验「强行改数不写流水」，而 9c 自己刚往记录里加过两条，
   * 拿更早的 recBefore 比会凭空多出 2 的差额，看着像功能坏了。
   */
  const recBeforeQtyEdit = await rowCount(page)

  await switchTab(page, '仓库')
  await page.waitForSelector('table.table')
  await page.waitForTimeout(300)

  // 仍然取第一行：上游小节改过名、合过并，写死名字必然失配
  const QTY_TGT = (await whNames(page))[0]
  const qtyBeforeEdit = await qtyOf(QTY_TGT)
  check(
    '取到待改数量的物品',
    Boolean(QTY_TGT) && Number.isFinite(qtyBeforeEdit),
    `${QTY_TGT} / ${qtyBeforeEdit}`
  )

  /** 等对话框关掉（成功关窗是异步的：要等一次 IPC 往返 + 广播刷新） */
  const waitModalGone = async () => {
    for (let i = 0; i < 40; i++) {
      if ((await page.locator('.modal-overlay').count()) === 0) return true
      await sleep(100)
    }
    return false
  }

  const qtyCellAt = async (name) => {
    const i = await whRowIdx(page, name)
    return page.locator('table.table tbody tr').nth(i).locator('.qty-text')
  }

  // ── 9d-1 双击进入：第一步只给口令 ─────────────────────────
  await (await qtyCellAt(QTY_TGT)).dblclick()
  await page.waitForSelector('.modal-overlay')
  await page.waitForTimeout(200)
  check('双击数量 → 弹出对话框', (await page.locator('.modal-overlay').count()) === 1)
  check(
    `对话框标题是「修改数量 — ${QTY_TGT}」（按标题语义区分共用的 .modal 类名）`,
    (await modalTitle()) === `修改数量—${QTY_TGT}`.replace(/\s/g, ''),
    JSON.stringify(await modalTitle())
  )
  check(
    '第一步只有口令框、**没有**数字框（验证在前、改数在后是物理事实，不是流程约定）',
    (await page.locator('.modal input[type="password"]').count()) === 1 &&
      (await page.locator('.modal input[type="number"]').count()) === 0,
    `password=${await page.locator('.modal input[type="password"]').count()} ` +
      `number=${await page.locator('.modal input[type="number"]').count()}`
  )

  // ── 9d-2 口令错：一步都不许往下走 ─────────────────────────
  const PWD = '771204'
  await page.locator('.modal input[type="password"]').fill('000000')
  await page.locator('.modal .btn-primary').click()
  await page.waitForTimeout(200)
  check(
    '口令错误 → 仍停在第一步（数字框没有出现）',
    (await page.locator('.modal input[type="number"]').count()) === 0
  )
  /*
   * 读「框内错误提示」必须带短超时 + catch。
   *
   * 这里踩过一次：写成裸的 `.textContent()`，一旦提示没出现，playwright 会
   * **超时 30 秒然后抛错**，把整个自检脚本崩掉 —— 后面 9d-5 ~ 9d-8 一条都跑不到，
   * 而报出来的只是一句「locator.textContent: Timeout」，
   * 看着像脚本坏了，实际是「提示没出现」这条断言该红而已。
   * 会崩的断言比会红的断言危险得多：它把后面的证据一起吞掉。
   */
  const modalErrorText = async () =>
    ((await page.locator('.modal-error').first().textContent({ timeout: 1500 }).catch(() => null)) ??
      '')
  check(
    '口令错误 → 框内给出提示（不是静默什么都不做）',
    (await modalErrorText()).includes('口令'),
    JSON.stringify(await modalErrorText())
  )
  check(
    '口令错误 → 对话框不关（关掉会让人以为「改成功了」）',
    (await page.locator('.modal-overlay').count()) === 1
  )

  // ── 9d-3 口令对：这时才放开数字框 ─────────────────────────
  /*
   * 先判存在再操作：口令框若已经不在（说明界面没停在第一步），
   * 裸的 fill() 会超时 30 秒抛错、把整个脚本崩掉，9d-4 之后一条都跑不到。
   * 那种情况下上面两条断言已经红了，这里不该再吞掉后面的证据。
   */
  const pwdInput = page.locator('.modal input[type="password"]')
  if ((await pwdInput.count()) > 0) {
    await pwdInput.fill(PWD)
    await page.locator('.modal .btn-primary').click()
    await page.waitForTimeout(250)
  }
  check('口令正确 → 出现数字输入框', (await page.locator('.modal input[type="number"]').count()) === 1)
  const numInput = page.locator('.modal input[type="number"]')
  check(
    '数字框预填当前数量',
    (await numInput.inputValue()) === String(qtyBeforeEdit),
    await numInput.inputValue()
  )
  await shot(page, '8-改数量-口令通过')

  // ── 9d-4 数字留空：拒绝，不许静默改成 0 ───────────────────
  await numInput.fill('')
  await page.locator('.modal .btn-primary').click()
  await page.waitForTimeout(200)
  check(
    '数字留空 → 拒绝并留在对话框里（Number(\'\') === 0，不特判就会静默写成 0）',
    (await page.locator('.modal-overlay').count()) === 1 &&
      (await page.locator('.modal-error').count()) >= 1,
    `overlay=${await page.locator('.modal-overlay').count()}`
  )

  // ── 9d-5 真改成新值 ───────────────────────────────────────
  const NEW_QTY = qtyBeforeEdit + 33
  await numInput.fill(String(NEW_QTY))
  await page.locator('.modal .btn-primary').click()
  check('提交后对话框自己关掉', await waitModalGone())
  check(`数量变成 ${NEW_QTY}`, (await qtyOf(QTY_TGT)) === NEW_QTY, `实际 ${await qtyOf(QTY_TGT)}`)

  // ── 9d-6 不留流水 ─────────────────────────────────────────
  await switchTab(page, '记录')
  await page.waitForSelector('table.table')
  await page.waitForTimeout(400)
  const recAfterQtyEdit = await rowCount(page)
  check(
    '强行改数不写流水（记录页条数不变）',
    recAfterQtyEdit === recBeforeQtyEdit,
    `${recBeforeQtyEdit} → ${recAfterQtyEdit}`
  )

  // ── 9d-7 右键是第二个入口，且允许改成负数 ─────────────────
  await switchTab(page, '仓库')
  await page.waitForSelector('table.table')
  await page.waitForTimeout(300)
  await (await qtyCellAt(QTY_TGT)).click({ button: 'right' })
  check('右键数量 → 弹出菜单', await page.locator('.ctx-menu').isVisible())
  check(
    '菜单里有「修改数量」',
    (await page.locator('.ctx-menu .ctx-item').allTextContents()).includes('修改数量'),
    (await page.locator('.ctx-menu .ctx-item').allTextContents()).join('|')
  )
  await page.locator('.ctx-menu .ctx-item', { hasText: '修改数量' }).click()
  await page.waitForSelector('.modal-overlay')
  await page.waitForTimeout(200)
  check('点菜单项 → 同样弹出改数量对话框', (await page.locator('.modal-overlay').count()) === 1)

  await page.locator('.modal input[type="password"]').fill(PWD)
  await page.locator('.modal .btn-primary').click()
  await page.waitForTimeout(250)
  await page.locator('.modal input[type="number"]').fill('-3')
  await page.locator('.modal .btn-primary').click()
  check('右键入口提交后同样自己关窗', await waitModalGone())
  check(
    '允许改成负数（库存可以为负是本系统的既有语义）',
    (await qtyOf(QTY_TGT)) === -3,
    `实际 ${await qtyOf(QTY_TGT)}`
  )

  // ── 9d-8 取消不该改数 ─────────────────────────────────────
  await (await qtyCellAt(QTY_TGT)).dblclick()
  await page.waitForSelector('.modal-overlay')
  await page.waitForTimeout(200)
  await page.locator('.modal .btn:not(.btn-primary)').click()
  await page.waitForTimeout(200)
  check(
    '点「取消」→ 对话框关掉，数量保持 -3（没被改）',
    (await page.locator('.modal-overlay').count()) === 0 && (await qtyOf(QTY_TGT)) === -3,
    `overlay=${await page.locator('.modal-overlay').count()} qty=${await qtyOf(QTY_TGT)}`
  )

  // ── 9e. 删除整个物品（操作列的删除按钮，需口令） ──────────
  /*
   * 这一节开始**改动物品集合**（删物品、后面还有导入清空），
   * 所以必须排在所有依赖「6 种物品」的断言之后。
   */
  section('9e. 仓库页：删除物品（需口令）')

  await switchTab(page, '仓库')
  await page.waitForSelector('table.table')
  await page.waitForTimeout(300)

  // 挑「闲置物料 X」：它没有任何出入库记录，删它不影响别的断言关心的数据
  const DEL_TGT = '闲置物料 X'
  const rowsBeforeDelete = await rowCount(page)
  await page
    .locator('table.table tbody tr')
    .nth(await whRowIdx(page, DEL_TGT))
    .locator('button', { hasText: '删除' })
    .click()
  await page.waitForSelector('.modal-overlay')
  await page.waitForTimeout(200)
  check('点操作列的「删除」→ 弹出对话框', (await page.locator('.modal-overlay').count()) === 1)
  check(
    '对话框标题是「删除物品」（按标题语义区分共用的 .modal 类名）',
    (await modalTitle()) === '删除物品'.replace(/\s/g, ''),
    JSON.stringify(await modalTitle())
  )
  check(
    '提示里写清了「连带删掉几条记录」——「删除物品」听起来只删一行',
    /名下 \d+ 条出入库记录/.test(await page.locator('.modal-text').first().textContent()),
    await page.locator('.modal-text').first().textContent()
  )

  // 口令错：一步都不许往下走
  await page.locator('.modal input[type="password"]').fill('000000')
  await page.locator('.modal .btn-danger').click()
  await page.waitForTimeout(300)
  check('口令错误 → 对话框不关', (await page.locator('.modal-overlay').count()) === 1)
  check('口令错误 → 框内给出提示', (await page.locator('.modal-error').count()) >= 1)
  check('口令错误 → 物品还在', (await whNames(page)).includes(DEL_TGT))

  // 口令对：删掉
  await page.locator('.modal input[type="password"]').fill('771204')
  await page.locator('.modal .btn-danger').click()
  await page.waitForTimeout(800)
  check('口令正确 → 对话框关闭', (await page.locator('.modal-overlay').count()) === 0)
  check('口令正确 → 物品被删除', !(await whNames(page)).includes(DEL_TGT))
  check(
    '物品数少 1',
    (await rowCount(page)) === rowsBeforeDelete - 1,
    `${rowsBeforeDelete} → ${await rowCount(page)}`
  )

  // ── 9f. 导入表格（口令 + 清空重建） ────────────────────────
  /*
   * 放在最靠后：导入会**清空所有数据**，之后就不该再有依赖旧数据的断言了
   * （后面只剩「控制台无报错」和「bundle 内容」两节，它们不看数据）。
   */
  section('9f. 仓库页：导入表格（会清空现有数据）')

  const csvPath = join(tmpdir(), `wh-import-${Date.now()}.csv`)
  await writeFile(
    csvPath,
    [
      '名称,单位,数量,备注',
      '导入甲,个,11,第一行备注',
      '导入乙,米,22,',
      '导入丙,卷,-3,负库存也允许'
    ].join('\n'),
    'utf8'
  )

  await page.locator('.card-toolbar button', { hasText: '导入表格' }).click()
  await page.waitForSelector('.modal-overlay')
  await page.waitForTimeout(200)
  check('点「导入表格」→ 先弹口令框', (await page.locator('.modal input[type="password"]').count()) === 1)
  check(
    '口令框里先说清了「会清空现有数据」',
    /清空/.test(await page.locator('.modal-text').first().textContent()),
    await page.locator('.modal-text').first().textContent()
  )

  await page.locator('.modal input[type="password"]').fill('000000')
  await page.locator('.modal .btn-danger').click()
  await page.waitForTimeout(300)
  check(
    '口令错误 → 不进入导入对话框（连文件选择框都不该出现）',
    (await page.locator('.modal input[type="file"]').count()) === 0,
    `file=${await page.locator('.modal input[type="file"]').count()}`
  )

  await page.locator('.modal input[type="password"]').fill('771204')
  await page.locator('.modal .btn-danger').click()
  await page.waitForTimeout(400)
  check('口令正确 → 打开导入对话框', (await page.locator('.modal-wide').count()) === 1)
  check(
    '导入框里有醒目的清空警告',
    (await page.locator('.modal-warn').count()) === 1 &&
      /不可撤销/.test(await page.locator('.modal-warn').textContent()),
    await page.locator('.modal-warn').textContent()
  )

  await page.locator('.modal input[type="file"]').setInputFiles(csvPath)
  await page.waitForTimeout(600)
  const importBody = await page.locator('.modal-body').textContent()
  check('读到 3 行并给出预览', /3 行/.test(importBody), importBody.slice(0, 120))
  check('预览里能看到表格内容（导入甲）', /导入甲/.test(importBody))

  await page.locator('.modal .import-field input').first().fill('张三')
  await page.locator('.modal .import-field input').nth(1).fill('李四')
  await page.locator('.modal-actions .btn', { hasText: '确认导入' }).click()
  await page.waitForTimeout(900)
  check('导入后对话框自己关掉', (await page.locator('.modal-overlay').count()) === 0)

  check('导入后物品数 = 表格行数（3）', (await rowCount(page)) === 3, `${await rowCount(page)}`)
  const importedNames = await page.evaluate(() =>
    [...document.querySelectorAll('table.table tbody tr')].map(
      (r) => r.querySelector('td.name-col')?.textContent?.trim()
    )
  )
  check(
    '物品顺序 = 表格顺序（导入甲 / 导入乙 / 导入丙）',
    importedNames.join('|') === '导入甲|导入乙|导入丙',
    importedNames.join('|')
  )
  check('备注也导进来了', (await cellText('导入甲', 'note-cell')) === '第一行备注', String(await cellText('导入甲', 'note-cell')))
  check('数量按表格值（含负数）', (await cellText('导入丙', 'qty-col')) === '-3', String(await cellText('导入丙', 'qty-col')))
  check('单位按表格值', (await cellText('导入乙', 'unit-col')) === '米', String(await cellText('导入乙', 'unit-col')))
  check(
    '警戒值用默认值 100（表格里没有这一列）',
    (await page.locator('table.table tbody tr').first().locator('.threshold-input').inputValue()) === '100'
  )

  // 记录页：每个物品一条导入产生的入库记录，操作人/经手人是导入时填的
  await switchTab(page, '记录')
  await page.waitForSelector('table.table')
  await page.waitForTimeout(400)
  check('记录页正好 3 条（清空后按行重建）', (await rowCount(page)) === 3, `${await rowCount(page)}`)

  /** 记录页某一列的整列文本，按**表头名**定位 */
  const recCol = (headerName) =>
    page.evaluate((h) => {
      const table = document.querySelector('table.table')
      const ths = [...table.querySelectorAll('thead th')]
      const i = ths.findIndex((th) => th.textContent.trim() === h)
      if (i < 0) return null
      return [...table.querySelectorAll('tbody tr')].map((r) =>
        r.querySelectorAll('td')[i]?.textContent?.trim()
      )
    }, headerName)

  const importedOps = await recCol('操作人')
  const importedHdls = await recCol('经手人/领取人')
  const importedTimes = await recCol('时间')
  check(
    '每条记录的操作人都是导入时填的「张三」',
    importedOps?.every((v) => v === '张三'),
    JSON.stringify(importedOps)
  )
  check(
    '每条记录的经手人都是导入时填的「李四」',
    importedHdls?.every((v) => v === '李四'),
    JSON.stringify(importedHdls)
  )
  check(
    '时间用的是导入时间（今天）',
    importedTimes?.every((t) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(t ?? '')),
    JSON.stringify(importedTimes)
  )

  await switchTab(page, '仓库')
  await page.waitForTimeout(300)

  // ── 9g. 边界：勾选中途「没有低库存物品了」 ─────────────────
  /*
   * 勾选框跟着「N 种低于警戒值」一起渲染，很自然会写成
   * `belowCount > 0 && <勾选框>` —— 那样一旦用户勾上之后把货补齐，
   * 勾选框消失、表格空着、还取消不掉勾选，页面就卡死了。
   * 所以这里专门把这个边界钉住。
   */
  section('9g. 只看低库存：勾选状态下「没有低库存物品了」')

  // 导入的三行数量是 11 / 22 / -3，警戒值都是默认 100 → 三行**都**低于警戒值
  check(
    '导入后 3 种都低于警戒值（11 / 22 / -3 都 < 100）',
    ((await page.locator('.count-warn').textContent()) ?? '').includes('3 种'),
    await page.locator('.count-warn').textContent()
  )
  await page.locator('.low-only-toggle input[type="checkbox"]').check()
  await page.waitForTimeout(300)
  check('勾选后 3 行都在（它们本来就都低）', (await rowCount(page)) === 3, `${await rowCount(page)}`)

  /*
   * 逐个把它们「补货」到高于警戒值 —— 每改一个，那一行就从视图里消失，
   * 最后「低于警戒值」变成 0 种。这时勾选框必须还在（见本节开头的说明）。
   */
  for (const [name, value] of [
    ['导入甲', '500'],
    ['导入乙', '600'],
    ['导入丙', '700']
  ]) {
    await page
      .locator('table.table tbody tr')
      .nth(await rowIdxByName(name))
      .locator('.qty-text')
      .dblclick()
    await page.waitForSelector('.modal-overlay')
    await page.locator('.modal input[type="password"]').fill('771204')
    await page.locator('.modal .btn-primary').click()
    await page.waitForTimeout(300)
    await page.locator('.modal input[type="number"]').fill(value)
    await page.locator('.modal .btn-primary').click()
    await page.waitForTimeout(700)
  }

  check(
    '全部补货之后没有低于警戒值的物品了',
    (await page.locator('.count-warn').count()) === 0,
    await page.locator('.count-warn').count()
  )
  check('此时表格是空的（勾选还在生效）', (await rowCount(page)) === 0, `${await rowCount(page)}`)
  check(
    '★ 此时勾选框仍然在（否则表格空着、勾也取消不掉，页面就卡死了）',
    (await page.locator('.low-only-toggle input[type="checkbox"]').count()) === 1
  )
  /*
   * 这里用 click 而不是 uncheck：取消勾选之后 belowCount 是 0、lowOnly 是 false，
   * 勾选框**按设计从 DOM 里消失**（没有低库存物品可筛了）。
   * 而 uncheck() 会一直等「checked 变成 false」—— 元素都没了，只能等到超时。
   */
  await page.locator('.low-only-toggle input[type="checkbox"]').click()
  await page.waitForTimeout(400)
  check('取消勾选后 3 行都回来', (await rowCount(page)) === 3, `${await rowCount(page)}`)
  check(
    '此时勾选框跟着消失（没有低库存物品可筛，提示和勾选框都没意义）',
    (await page.locator('.low-only-toggle input[type="checkbox"]').count()) === 0
  )

  // ── 9h. 数量不是数字：提示 + 照常录入（按 0） ───────────────
  /*
   * 用户 2026-10-02 的要求：数量那格空着（或写了非数字）时**不要整表拒绝**，
   * 给个提示、按 0 录入就行。实际表格里「数量没填」太常见了。
   *
   * 这条断言盯两件事：
   *  1. **按下确认之前**就要看到提示、并且点明是哪几行 ——
   *     事后才说等于没说，用户根本不知道该去核对哪一行；
   *  2. 导入真的成功、那一行落成 0，且**别的行不受影响**。
   */
  section('9h. 导入：数量不是数字 → 提示 + 按 0 录入')

  const csvPath2 = join(tmpdir(), `wh-import-zero-${Date.now()}.csv`)
  await writeFile(
    csvPath2,
    [
      '名称,单位,数量,备注',
      '正常甲,个,12,',
      '数量空,箱,,这一行数量没填',
      '正常乙,米,34,'
    ].join('\n'),
    'utf8'
  )

  dialogs.length = 0
  await page.locator('.card-toolbar button', { hasText: '导入表格' }).click()
  await page.waitForSelector('.modal-overlay')
  await page.locator('.modal input[type="password"]').fill('771204')
  await page.locator('.modal .btn-danger').click()
  await page.waitForTimeout(400)
  await page.locator('.modal input[type="file"]').setInputFiles(csvPath2)
  await page.waitForTimeout(700)

  check(
    '预览里给出「数量不是数字」的提示',
    (await page.locator('.import-warn').count()) === 1,
    `import-warn=${await page.locator('.import-warn').count()}`
  )
  const warnText = (await page.locator('.import-warn').textContent()) ?? ''
  check('提示点明了是第 2 行', /第 2 行/.test(warnText), warnText.slice(0, 90))
  check('提示说明会按 0 记录', /按 0 记录/.test(warnText), warnText.slice(0, 90))
  check(
    '确认按钮没被禁用（这条路径不阻断导入）',
    !(await page.locator('.modal-actions .btn', { hasText: '确认导入' }).isDisabled())
  )

  await page.locator('.modal-actions .btn', { hasText: '确认导入' }).click()
  await page.waitForTimeout(1000)
  check('导入成功、对话框自己关掉', (await page.locator('.modal-overlay').count()) === 0)
  check('物品数 = 3 —— 一行都没丢', (await rowCount(page)) === 3, `${await rowCount(page)}`)
  check(
    '数量为空那行的库存落成 0',
    (await cellText('数量空', 'qty-col')) === '0',
    String(await cellText('数量空', 'qty-col'))
  )
  check(
    '正常行的数量没被动（12 / 34）',
    (await cellText('正常甲', 'qty-col')) === '12' &&
      (await cellText('正常乙', 'qty-col')) === '34',
    `${await cellText('正常甲', 'qty-col')} / ${await cellText('正常乙', 'qty-col')}`
  )
  check(
    '导入完成后的提示里也报了「按 0 记录」的行号',
    dialogs.some((d) => /按 0 记录/.test(d.message) && /第 2 行/.test(d.message)),
    JSON.stringify(dialogs.map((d) => d.message.slice(0, 70)))
  )

  // ── 10. 控制台 ───────────────────────────────────────────
  section('10. 渲染进程控制台')
  check('无 console.error / pageerror', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

  section('11. 构建产物：导出依赖（xlsx）确实在渲染 bundle 里')

  /*
   * 打包配置把 node_modules/xlsx 整个排除了（asar 从 7MB 降到约 1.1MB），
   * 依据是「xlsx 由渲染进程 import，会被 Vite 打进 bundle，运行期不需要
   * node_modules 里那一份」。这个前提一旦不成立，打包后的导出会**静默失效** ——
   * 而导出走的是原生保存对话框，端到端自动化点不了，没有别的断言能兜住。
   * 所以在这里把前提本身钉死：bundle 里必须有 xlsx，且不得 require 它。
   */
  const assetDir = join(ROOT, 'out', 'renderer', 'assets')
  const bundleName = (await readdir(assetDir)).find((f) => f.endsWith('.js'))
  const bundle = bundleName ? await readFile(join(assetDir, bundleName), 'utf8') : ''
  check('找到渲染 bundle', bundle.length > 0, bundleName ?? 'assets 下没有 .js')
  check(
    'bundle 里带着 xlsx 编码器（SheetJS + xl/workbook 标记）',
    bundle.includes('SheetJS') && bundle.includes('xl/workbook'),
    `SheetJS=${bundle.includes('SheetJS')} xl/workbook=${bundle.includes('xl/workbook')}`
  )
  check(
    'bundle 不 require("xlsx")（没有运行期回退到 node_modules）',
    !bundle.includes('require("xlsx")') && !bundle.includes("require('xlsx')")
  )
  const bundleRequires = [...new Set(bundle.match(/require\("[^"]+"\)/g) ?? [])]
  check(
    'bundle 不引用任何外部模块（故 asar 里无需 node_modules）',
    bundleRequires.length === 0,
    bundleRequires.slice(0, 4).join(' ')
  )
}

// ── 入口 ────────────────────────────────────────────────────
let server = null
let browser = null
let exitCode = 1

try {
  // 构建产物比源码旧的话，测的就不是当前代码 —— 这种情况必须说出来
  const built = await stat(join(ROOT, 'out', 'renderer', 'index.html'))
  const srcNewest = await newestMtime(join(ROOT, 'src'))
  if (srcNewest > built.mtimeMs) {
    console.log('\n  ⚠️  src/ 比构建产物新，测的可能是旧代码。先跑 npm run build。\n')
  }

  if (WANT_SHOTS) await mkdir(SHOT_DIR, { recursive: true })
  const shot = async (page, name) => {
    if (!WANT_SHOTS) return
    await page.screenshot({ path: join(SHOT_DIR, `${name}.png`), fullPage: false })
  }

  server = await startServer()
  browser = await chromium.launch()
  const page = await browser.newPage({
    viewport: { width: 1180, height: 800 },
    deviceScaleFactor: WANT_SHOTS ? 2 : 1
  })

  await run(page, shot)

  console.log(`\n${'─'.repeat(56)}`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  if (failures.length) {
    console.log('\n失败明细：')
    for (const f of failures) console.log(`  \u2717 ${f}`)
  }
  if (WANT_SHOTS) console.log(`\n截图目录：${SHOT_DIR}`)
  exitCode = failed === 0 ? 0 : 1
} catch (err) {
  console.error('\n自检中断：', err)
  exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  if (server) server.kill()
}

process.exit(exitCode)
