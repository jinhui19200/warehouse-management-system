/**
 * 数据层自检脚本。
 *
 * 覆盖：原子写入、事务原子性、单位锁定、名称归一化、负库存、浮点精度、
 * 撤销反向冲销、持久化重载、并发写、损坏恢复、操作人字段。
 *
 * 运行：npm run verify:store
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDataFilePath, getLoadReport, getSnapshot, initStore, load } from '../src/main/store/db'
import type { ImportRow } from '../src/shared/types'
import {
  applyTransaction,
  deleteItem,
  deleteRecord,
  importTable,
  renameItem,
  reorderItems,
  setItemNote,
  setItemQuantity,
  setItemThreshold,
  setItemUnit
} from '../src/main/store/transactions'
import {
  DEFAULT_THRESHOLD,
  HANDLER_COLUMN,
  handlerLabel,
  matchesItemQuery,
  monthDiff,
  monthLabel,
  monthlySeries,
  pinMatches,
  QUANTITY_EDIT_PASSWORD,
  recentMonths
} from '../src/shared/utils'

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

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'wh-store-test-'))
  initStore(dir)
  await load()

  section('1. 入库自动创建物品')
  let r = await applyTransaction({
    time: '2026-09-19T10:00',
    name: 'M3螺丝',
    quantity: 100,
    unit: '个',
    operator: '张三',
    handler: '赵六',
    type: 'in'
  })
  check('入库成功', r.ok === true, r.ok ? '' : r.error)
  if (r.ok) {
    check('库存 = 100', r.item.quantity === 100, `实际 ${r.item.quantity}`)
    check('单位 = 个', r.item.unit === '个', `实际 ${r.item.unit}`)
    check('记录方向 = in', r.record.type === 'in')
    check('记录单位存的是快照', r.record.unit === '个')
    check('操作人快照 = 张三', r.record.operator === '张三')
    check('经手人快照 = 赵六', r.record.handler === '赵六', `实际 ${JSON.stringify(r.record.handler)}`)
  }

  section('2. 同一物品再次入库应累加')
  r = await applyTransaction({
    time: '2026-09-19T11:00',
    name: 'M3螺丝',
    quantity: 50,
    unit: '个',
    type: 'in'
  })
  check('库存累加 = 150', r.ok && r.item.quantity === 150, r.ok ? `实际 ${r.item.quantity}` : '')
  check('物品数仍为 1', getSnapshot().items.length === 1, `实际 ${getSnapshot().items.length}`)

  section('3. 单位锁定（数据层强制，防绕过界面）')
  r = await applyTransaction({
    time: '2026-09-19T11:30',
    name: 'M3螺丝',
    quantity: 10,
    unit: '盒',
    type: 'in'
  })
  check(
    '传入「盒」被忽略，仍是「个」',
    r.ok && r.item.unit === '个',
    r.ok ? `实际 ${r.item.unit}` : ''
  )
  check('库存 = 160', r.ok && r.item.quantity === 160, r.ok ? `实际 ${r.item.quantity}` : '')

  section('4. 名称归一化')
  r = await applyTransaction({
    time: '2026-09-19T12:00',
    name: '  M3螺丝  ',
    quantity: 5,
    unit: '个',
    type: 'in'
  })
  check('前后空格视为同一物品', getSnapshot().items.length === 1, `物品数 ${getSnapshot().items.length}`)
  check('库存 = 165', r.ok && r.item.quantity === 165, r.ok ? `实际 ${r.item.quantity}` : '')

  section('5. 出库')
  r = await applyTransaction({ time: '2026-09-19T13:00', name: 'M3螺丝', quantity: 20, type: 'out' })
  check('出库成功', r.ok === true, r.ok ? '' : r.error)
  check('库存 = 145', r.ok && r.item.quantity === 145, r.ok ? `实际 ${r.item.quantity}` : '')

  section('6. 出库超库存：警告但不阻断')
  r = await applyTransaction({ time: '2026-09-19T14:00', name: 'M3螺丝', quantity: 200, type: 'out' })
  check('超库存出库不被阻断', r.ok === true, r.ok ? '' : r.error)
  check('库存变负 = -55', r.ok && r.item.quantity === -55, r.ok ? `实际 ${r.item.quantity}` : '')
  /*
   * 这里刻意把**文案本身**钉死，而不是只查 `typeof warning === 'string'`。
   *
   * 原因：这段告警文案在**两个地方各写了一份** —— 真实数据层
   * （src/main/store/transactions.ts）与界面自检用的内存替身（preview/mock.ts）。
   * 界面层测的是替身，所以替身改了、真实实现没改，界面层照样全绿，
   * 而用户看到的是另一句话 —— 这种分叉只有「两层各钉同一串字面量」才拦得住。
   * 改文案时两处一起改，否则必有一层变红。
   */
  check(
    '负库存警告的文案（与 preview/mock.ts 必须逐字一致）',
    r.ok && r.warning === '「M3螺丝」库存已为负（-55 个），请及时补货',
    r.ok ? JSON.stringify(r.warning) : ''
  )

  section('7. 输入校验')
  check('空名称被拒绝', (await applyTransaction({ time: '', name: '', quantity: 1, type: 'in' })).ok === false)
  check('数量 0 被拒绝', (await applyTransaction({ time: '', name: '新东西', quantity: 0, type: 'in' })).ok === false)
  check('负数被拒绝', (await applyTransaction({ time: '', name: '新东西', quantity: -5, type: 'in' })).ok === false)
  check('非数字被拒绝', (await applyTransaction({ time: '', name: '新东西', quantity: NaN, type: 'in' })).ok === false)
  check('新物品不填单位被拒绝', (await applyTransaction({ time: '', name: '新东西', quantity: 5, type: 'in' })).ok === false)

  section('8. 浮点精度')
  await applyTransaction({ time: '', name: '电线', quantity: 0.1, unit: '米', type: 'in' })
  await applyTransaction({ time: '', name: '电线', quantity: 0.2, unit: '米', type: 'in' })
  const wire = getSnapshot().items.find((i) => i.name === '电线')
  check('0.1 + 0.2 = 0.3（不是 0.30000000000000004）', wire?.quantity === 0.3, `实际 ${wire?.quantity}`)

  section('9. 原子写入产物')
  const raw = await readFile(getDataFilePath(), 'utf8')
  let parsedOk = true
  try {
    JSON.parse(raw)
  } catch {
    parsedOk = false
  }
  check('data.json 是合法 JSON', parsedOk)
  check('data.json 非空', raw.length > 0, `${raw.length} 字节`)
  const bak = await stat(`${getDataFilePath()}.bak`)
    .then(() => true)
    .catch(() => false)
  check('保留了 .bak 备份', bak)

  section('10. 撤销记录反向冲销库存')
  const beforeQty = getSnapshot().items.find((i) => i.name === 'M3螺丝')!.quantity
  const inRec = getSnapshot().records.find((rec) => rec.type === 'in' && rec.name === 'M3螺丝')!
  const recCountBefore = getSnapshot().records.length
  const d = await deleteRecord(inRec.id)
  check('撤销成功', d.ok === true, d.ok ? '' : d.error)
  const afterQty = getSnapshot().items.find((i) => i.name === 'M3螺丝')!.quantity
  check(
    `撤销一条入库 ${inRec.quantity} → 库存减少 ${inRec.quantity}`,
    Math.abs(afterQty - (beforeQty - inRec.quantity)) < 1e-9,
    `${beforeQty} → ${afterQty}`
  )
  check('记录数减少 1', getSnapshot().records.length === recCountBefore - 1)
  check('撤销不存在的记录被拒绝', (await deleteRecord('不存在的id')).ok === false)

  section('11. 撤销出库记录应加回库存')
  const outRec = getSnapshot().records.find((rec) => rec.type === 'out')!
  const q0 = getSnapshot().items.find((i) => i.name === 'M3螺丝')!.quantity
  await deleteRecord(outRec.id)
  const q1 = getSnapshot().items.find((i) => i.name === 'M3螺丝')!.quantity
  check(
    `撤销一条出库 ${outRec.quantity} → 库存增加 ${outRec.quantity}`,
    Math.abs(q1 - (q0 + outRec.quantity)) < 1e-9,
    `${q0} → ${q1}`
  )

  section('12. 持久化：清缓存后从磁盘重载')
  const itemsBefore = getSnapshot().items.length
  const recordsBefore = getSnapshot().records.length
  initStore(dir)
  await load()
  check('物品数一致', getSnapshot().items.length === itemsBefore, `${getSnapshot().items.length} vs ${itemsBefore}`)
  check('记录数一致', getSnapshot().records.length === recordsBefore, `${getSnapshot().records.length} vs ${recordsBefore}`)

  section('13. 并发写入不丢数据')
  const baseRecords = getSnapshot().records.length
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      applyTransaction({ time: '', name: '并发件', quantity: 1, unit: '个', type: 'in' })
    )
  )
  check('20 笔并发全部成功', results.every((x) => x.ok), `成功 ${results.filter((x) => x.ok).length}/20`)
  check('记录数 +20', getSnapshot().records.length === baseRecords + 20, `实际 +${getSnapshot().records.length - baseRecords}`)
  const conc = getSnapshot().items.find((i) => i.name === '并发件')
  check('库存累加到 20（无覆盖丢失）', conc?.quantity === 20, `实际 ${conc?.quantity}`)

  section('14. 失败不污染内存')
  const qBefore = getSnapshot().items.find((i) => i.name === 'M3螺丝')!.quantity
  const rcBefore = getSnapshot().records.length
  await applyTransaction({ time: '', name: '', quantity: 1, type: 'in' })
  check('被拒绝的操作没有改变库存', getSnapshot().items.find((i) => i.name === 'M3螺丝')!.quantity === qBefore)
  check('被拒绝的操作没有新增记录', getSnapshot().records.length === rcBefore)

  section('15. 损坏恢复：主文件坏掉时从 .bak 恢复')
  const target = getDataFilePath()
  const bakPath = `${target}.bak`
  const goodContent = await readFile(target, 'utf8')
  const goodBak = await readFile(bakPath, 'utf8')
  const bakParsed = JSON.parse(goodBak) as { items: unknown[]; records: unknown[] }

  // 把主文件写坏（模拟用户手工改坏 / 被截断）
  await writeFile(target, '这不是 JSON { 坏掉了')

  initStore(dir)
  let threw = false
  try {
    await load()
  } catch {
    threw = true
  }
  // 这是关键：恢复成功是正常路径，抛异常会让启动流程直接挂掉
  check('恢复成功时 load() 不抛异常', !threw)
  check('loadReport 标记为「已从备份恢复」', getLoadReport().recoveredFromBackup === true)

  const restoredRaw = await readFile(target, 'utf8')
  check(
    '恢复后 data.json 是合法 JSON',
    (() => {
      try {
        JSON.parse(restoredRaw)
        return true
      } catch {
        return false
      }
    })()
  )
  check(
    '恢复后物品数与备份一致',
    getSnapshot().items.length === bakParsed.items.length,
    `${getSnapshot().items.length} vs ${bakParsed.items.length}`
  )
  check(
    '恢复后记录数与备份一致',
    getSnapshot().records.length === bakParsed.records.length,
    `${getSnapshot().records.length} vs ${bakParsed.records.length}`
  )

  // 最容易踩的坑：恢复时若照常「把当前主文件拷成备份」，
  // 就会把损坏内容覆盖到唯一的好备份上，救命稻草当场作废
  const bakAfter = await readFile(bakPath, 'utf8')
  check('好备份没有被损坏的主文件覆盖', bakAfter === goodBak, `备份变成了 ${bakAfter.slice(0, 40)}…`)

  // 清理：把好的写回去，避免影响后续用例
  await writeFile(target, goodContent)

  section('16. 旧数据无 operator / handler 字段时自动补空串')
  const legacy = JSON.stringify({
    version: 1,
    items: [{ id: '1', name: ' legacy', unit: '个', quantity: 10, createdAt: 'x', updatedAt: 'x' }],
    records: [{ id: 'r1', itemId: '1', time: '2026-01-01T00:00', name: 'legacy', unit: '个', quantity: 5, type: 'in', createdAt: 'x' }]
  })
  const legacyDir = await mkdtemp(join(tmpdir(), 'wh-legacy-test-'))
  await writeFile(join(legacyDir, 'data.json'), legacy)
  initStore(legacyDir)
  await load()
  const legacyRec = getSnapshot().records[0]
  check('旧记录 operator 被补成空串', legacyRec.operator === '', `实际 ${JSON.stringify(legacyRec.operator)}`)
  // handler 是比 operator 更晚加的字段，同一批旧数据里两个都没有。
  // 不补齐的话，记录页那一列会渲染出 `undefined`、导出会写出空单元格。
  check(
    '旧记录 handler 也被补成空串',
    legacyRec.handler === '',
    `实际 ${JSON.stringify(legacyRec.handler)}`
  )
  // 警戒值是后加的功能，旧数据文件里没有这个字段
  const legacyItem = getSnapshot().items[0]
  check(
    '旧物品 threshold 被补成默认值 100',
    legacyItem.threshold === DEFAULT_THRESHOLD,
    `实际 ${JSON.stringify(legacyItem.threshold)}`
  )

  section('17. 警戒值')
  // 回到主测试目录
  initStore(dir)
  await load()
  const first = getSnapshot().items[0]
  check(
    '新物品默认警戒值 100',
    first.threshold === DEFAULT_THRESHOLD,
    `实际 ${first.threshold}`
  )

  const recordsBeforeThreshold = getSnapshot().records.length
  const set1 = await setItemThreshold(first.id, 7)
  check('改成 7 成功', set1.ok && set1.item.threshold === 7, JSON.stringify(set1))
  check(
    '改警戒值不写流水（记录数不变）',
    getSnapshot().records.length === recordsBeforeThreshold,
    `${getSnapshot().records.length} vs ${recordsBeforeThreshold}`
  )
  check(
    '内存快照同步',
    getSnapshot().items.find((i) => i.id === first.id)?.threshold === 7
  )

  // 落盘校验：重新从磁盘读一遍，而不是信内存
  const diskAfterSet = JSON.parse(await readFile(getDataFilePath(), 'utf8'))
  check(
    '警戒值已落盘',
    diskAfterSet.items.find((i: { id: string }) => i.id === first.id)?.threshold === 7
  )

  const set2 = await setItemThreshold(first.id, 250.5)
  check('小数保留（250.5）', set2.ok && set2.item.threshold === 250.5, JSON.stringify(set2))

  for (const [label, bad] of [
    ['空串', ''],
    ['纯空白', '   '],
    ['非数字', 'abc'],
    ['负数', -5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY]
  ] as const) {
    const res = await setItemThreshold(first.id, bad as unknown as number)
    check(
      `非法输入「${label}」回落默认值 100`,
      res.ok && res.item.threshold === DEFAULT_THRESHOLD,
      JSON.stringify(res)
    )
  }

  const missing = await setItemThreshold('不存在的-id', 10)
  check('物品不存在时返回错误', !missing.ok, JSON.stringify(missing))

  // 持久化：重启后（重新 load）警戒值还在
  const persistedDir = dir
  initStore(persistedDir)
  await load()
  check(
    '重新加载后警戒值仍为 100（上一轮非法输入的结果）',
    getSnapshot().items.find((i) => i.id === first.id)?.threshold === DEFAULT_THRESHOLD
  )

  // ── 18. 报表用的月度序列 ─────────────────────────────────
  section('18. 月度序列（报表页的数据源）')

  // 跨年是最容易写错的地方：自己算 `m - i` 会得到负数或 0 月
  const crossYear = recentMonths(6, new Date(2026, 1, 15)) // 2026-02-15
  check(
    '跨年回推 6 个月得到 2025-09 ~ 2026-02',
    crossYear.join(',') === '2025-09,2025-10,2025-11,2025-12,2026-01,2026-02',
    crossYear.join(',')
  )

  // 日期固定为 1 号，否则 3-31 回推会落到不存在的「2 月 31 日」
  const from31 = recentMonths(3, new Date(2026, 2, 31)) // 2026-03-31
  check(
    '从 31 号回推不会跳到不存在的日期',
    from31.join(',') === '2026-01,2026-02,2026-03',
    from31.join(',')
  )

  const months = recentMonths(3, new Date(2026, 8, 19)) // 2026-07 ~ 2026-09
  check('序列从早到晚，最后一项是当月', months[months.length - 1] === '2026-09', months.join(','))

  const series = monthlySeries(
    [
      { itemId: 'a', time: '2026-09-01T10:00', quantity: 100, type: 'in' },
      { itemId: 'a', time: '2026-09-20T10:00', quantity: 50, type: 'in' },
      { itemId: 'a', time: '2026-09-21T10:00', quantity: 30, type: 'out' },
      { itemId: 'a', time: '2026-08-05T10:00', quantity: 7, type: 'out' },
      { itemId: 'b', time: '2026-09-02T10:00', quantity: 999, type: 'in' },
      { itemId: 'a', time: '2020-01-01T10:00', quantity: 888, type: 'in' } // 落在窗口之外
    ],
    'a',
    months
  )
  check('返回定长数组，与传入月份一一对应', series.length === 3, `${series.length}`)
  check('同月多笔入库累加（100+50）', series[2].in === 150, `${series[2].in}`)
  check('同月出库单独统计', series[2].out === 30, `${series[2].out}`)
  check('其它月份的记录记在对应位置（8 月出库 7）', series[1].out === 7, `${series[1].out}`)
  check(
    '没有记录的月份补 0 而不是缺项',
    series[0].in === 0 && series[0].out === 0,
    JSON.stringify(series[0])
  )
  check('只统计指定物品（b 的 999 不计入）', series[2].in === 150, `${series[2].in}`)
  check('窗口之外的历史记录被忽略', series.every((r) => r.in !== 888), JSON.stringify(series))
  check(
    '月份短标签（9月 / 1月）',
    monthLabel('2026-09') === '9月' && monthLabel('2026-01') === '1月',
    monthLabel('2026-09')
  )

  section('19. 月份差（时间窗口平移用）')
  check('同年', monthDiff('2026-01', '2026-09') === 8, `${monthDiff('2026-01', '2026-09')}`)
  check('跨年', monthDiff('2025-10', '2026-09') === 11, `${monthDiff('2025-10', '2026-09')}`)
  check('正好一年 = 12', monthDiff('2025-09', '2026-09') === 12, `${monthDiff('2025-09', '2026-09')}`)
  check('跨年相邻月 = 1（不是 -11）', monthDiff('2025-12', '2026-01') === 1, `${monthDiff('2025-12', '2026-01')}`)
  check('同月 = 0', monthDiff('2026-09', '2026-09') === 0, `${monthDiff('2026-09', '2026-09')}`)
  check('反向为负（符号有意义）', monthDiff('2026-09', '2026-01') === -8, `${monthDiff('2026-09', '2026-01')}`)

  // 把两个函数对起来：平移 offset 个月之后，窗口起点应当正好比锚点早 (WINDOW-1) 个月。
  // 这条不通过就说明「滑动一个月」实际滑的不是一个月（跨年或月末借位出错）。
  const WINDOW = 12
  for (const off of [0, 1, 11, 12, 25]) {
    const anchor = new Date(2026, 8 - off, 1)
    const win = recentMonths(WINDOW, anchor)
    const anchorKey = `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, '0')}`
    const span = monthDiff(win[0], win[win.length - 1])
    check(
      `窗口长度恒为 ${WINDOW} 个月（offset=${off}）`,
      win.length === WINDOW && span === WINDOW - 1 && win[win.length - 1] === anchorKey,
      `${win[0]} ~ ${win[win.length - 1]}，跨度 ${span}`
    )
  }

  section('20. 经手人 / 领取人（与操作人并存，互不覆盖）')
  initStore(dir)
  await load()
  const hIn = await applyTransaction({
    time: '2026-09-20T09:00',
    name: 'M3螺丝',
    quantity: 5,
    operator: '操作员甲',
    // 故意带两侧空白：数据层应当裁掉再存
    handler: '  经手人乙  ',
    type: 'in'
  })
  check(
    '入库：经手人与操作人各自存下，互不覆盖（且两侧空白被裁掉）',
    hIn.ok && hIn.record.handler === '经手人乙' && hIn.record.operator === '操作员甲',
    hIn.ok ? JSON.stringify({ h: hIn.record.handler, o: hIn.record.operator }) : hIn.error
  )
  const hOut = await applyTransaction({
    time: '2026-09-20T10:00',
    name: 'M3螺丝',
    quantity: 2,
    operator: '操作员甲',
    handler: '领取人丙',
    type: 'out'
  })
  check(
    '出库：同一个字段装领取人，方向不同而已',
    hOut.ok && hOut.record.handler === '领取人丙' && hOut.record.type === 'out',
    hOut.ok ? JSON.stringify(hOut.record.handler) : hOut.error
  )

  // 选填：不传 handler 时必须是空串，而不是 undefined ——
  // 记录页那一列、导出的单元格、撤销确认框都直接读它
  const hNone = await applyTransaction({
    time: '2026-09-20T11:00',
    name: 'M3螺丝',
    quantity: 1,
    type: 'in'
  })
  check(
    '不填经手人时存空串（不是 undefined）',
    hNone.ok && hNone.record.handler === '',
    hNone.ok ? JSON.stringify(hNone.record.handler) : hNone.error
  )

  // 落盘校验：重新从磁盘读一遍，而不是信内存
  const diskHandler = JSON.parse(await readFile(getDataFilePath(), 'utf8'))
  check(
    '经手人已落盘',
    diskHandler.records.some(
      (x: { handler?: string }) => x.handler === '经手人乙'
    ),
    JSON.stringify(diskHandler.records.slice(-3).map((x: { handler?: string }) => x.handler))
  )

  section('21. 仓库页搜索：命中置顶但其余不隐藏')
  const items = [
    { name: 'M3×8 螺丝' },
    { name: '贴片电阻 10kΩ' },
    { name: 'M4 螺丝' },
    { name: '铜线 1.5mm²' }
  ]
  const names = (list: Array<{ name: string }>): string => list.map((x) => x.name).join('|')

  check(
    '空搜索词时原样返回（连顺序都不动）',
    names(pinMatches(items, (i) => i.name, '')) === names(items) &&
      pinMatches(items, (i) => i.name, '') === items,
    names(pinMatches(items, (i) => i.name, ''))
  )
  const hit = pinMatches(items, (i) => i.name, '螺丝')
  check(
    '命中的两个排到最前，且**一个都没被隐藏**',
    hit.length === items.length && names(hit) === 'M3×8 螺丝|M4 螺丝|贴片电阻 10kΩ|铜线 1.5mm²',
    names(hit)
  )
  check(
    '命中的两个保持原有相对顺序（稳定，不是随机重排）',
    names(hit).indexOf('M3×8 螺丝') < names(hit).indexOf('M4 螺丝'),
    names(hit)
  )
  check(
    '未命中的也保持原有相对顺序',
    names(hit).indexOf('贴片电阻 10kΩ') < names(hit).indexOf('铜线 1.5mm²'),
    names(hit)
  )
  check('无命中时返回原顺序（不是空数组）', names(pinMatches(items, (i) => i.name, 'zzz')) === names(items))
  check('大小写不敏感', matchesItemQuery('PCB 打样板', 'pcb') === true)
  check('忽略搜索词首尾空白', matchesItemQuery('M3×8 螺丝', '  螺丝  ') === true)
  check('空搜索词不匹配任何项（否则全部会被标成命中）', matchesItemQuery('任何名称', '') === false)
  check('只按名称匹配，不匹配单位', matchesItemQuery('M3×8 螺丝', '个') === false)

  section('22. 经手人 / 领取人的文案')
  check('入库叫经手人', handlerLabel('in') === '经手人', handlerLabel('in'))
  check('出库叫领取人', handlerLabel('out') === '领取人', handlerLabel('out'))
  check(
    '列名同时含两种叫法（一条记录非入即出，共用一个字段）',
    HANDLER_COLUMN === '经手人/领取人',
    HANDLER_COLUMN
  )

  // ── 23. 重命名（改名 + 撞名合并） ─────────────────────────
  section('23. 重命名物品')
  initStore(dir)
  await load()

  // 单独造一批物品，避免和前面用例的状态纠缠
  const rnA = await applyTransaction({
    time: '2026-09-21T09:00',
    name: '待改名甲',
    quantity: 10,
    unit: '个',
    type: 'in'
  })
  const rnB = await applyTransaction({
    time: '2026-09-21T10:00',
    name: '待改名乙',
    quantity: 3,
    unit: '个',
    type: 'in'
  })
  await applyTransaction({ time: '2026-09-21T11:00', name: '待改名甲', quantity: 5, unit: '个', type: 'in' })
  if (!rnA.ok || !rnB.ok) throw new Error('重命名用例的前置数据没造出来')

  // ── 23a. 单纯改名 ────────────────────────────────────────
  // 改名前后比条数，而不是写死一个数字 —— 前面十几节用例已经往同一个
  // 数据目录里攒了一堆记录，写死数字只会得到一个「看着像功能坏了」的假失败
  const recordsBeforeRename = getSnapshot().records.length
  const plain = await renameItem(rnA.item.id, '改名后的甲')
  check('改名成功', plain.ok === true, plain.ok ? '' : plain.error)
  if (plain.ok) {
    check('物品名已更新', plain.item.name === '改名后的甲', plain.item.name)
    check('不是合并', plain.merged === false)
    check('同步改了 2 条历史记录的名称', plain.renamedRecords === 2, `${plain.renamedRecords}`)
  }
  const snapAfterRename = getSnapshot()
  check(
    '旧名字在记录里彻底消失（记录页不会和新名字对不上）',
    !snapAfterRename.records.some((rec) => rec.name === '待改名甲')
  )
  check(
    '这 2 条记录的 itemId 没变（还挂在这个物品名下）',
    snapAfterRename.records.filter((rec) => rec.itemId === rnA.item.id).length === 2,
    `${snapAfterRename.records.filter((rec) => rec.itemId === rnA.item.id).length}`
  )
  check(
    '改名不动数量',
    snapAfterRename.items.find((i) => i.id === rnA.item.id)?.quantity === 15,
    `${snapAfterRename.items.find((i) => i.id === rnA.item.id)?.quantity}`
  )
  check(
    '改名不写新流水（记录总数不变）',
    snapAfterRename.records.length === recordsBeforeRename,
    `${recordsBeforeRename} → ${snapAfterRename.records.length}`
  )

  // 名字没变（含只改空白）应当静默无操作，而不是报错或白写一次盘
  const same = await renameItem(rnA.item.id, '  改名后的甲  ')
  check('只改首尾空白 → 归一化后同名，视为无操作', same.ok && same.renamedRecords === 0, JSON.stringify(same))

  const emptyName = await renameItem(rnA.item.id, '   ')
  check('空名被拒绝', emptyName.ok === false, JSON.stringify(emptyName))
  const ghost = await renameItem('不存在的-id', '随便什么')
  check('物品不存在时返回错误', ghost.ok === false, JSON.stringify(ghost))

  // ── 23b. 撞名合并（单位不一致） ──────────────────────────
  const rnC = await applyTransaction({
    time: '2026-09-21T12:00',
    name: '待改名丙',
    quantity: 7,
    unit: '盒',
    type: 'in'
  })
  if (!rnC.ok) throw new Error('重命名用例的前置数据没造出来')

  const merged = await renameItem(rnC.item.id, '待改名乙')
  check('撞名 → 合并成功', merged.ok === true && merged.merged === true, JSON.stringify(merged))
  if (merged.ok) {
    check('保留下来的目标物品（不是被并的那个）', merged.item.id === rnB.item.id)
    check('数量累加 3 + 7 = 10', merged.item.quantity === 10, `${merged.item.quantity}`)
    check('搬过来 1 条记录', merged.movedRecords === 1, `${merged.movedRecords}`)
    check(
      '单位不一致时带回 unitConflict 供界面提示',
      merged.unitConflict?.keptUnit === '个' && merged.unitConflict?.otherUnit === '盒',
      JSON.stringify(merged.unitConflict)
    )
    check('没指定单位 → 沿用目标物品的单位', merged.item.unit === '个', merged.item.unit)
  }

  const snapAfterMerge = getSnapshot()
  check(
    '源物品已被删除',
    !snapAfterMerge.items.some((i) => i.id === rnC.item.id)
  )
  const movedRecs = snapAfterMerge.records.filter((rec) => rec.itemId === rnB.item.id)
  check('目标物品名下现在有 2 条记录', movedRecs.length === 2, `${movedRecs.length}`)
  check(
    '搬过来的记录名称改成目标物品名',
    movedRecs.every((rec) => rec.name === '待改名乙')
  )
  check(
    '搬过来的记录**单位保持原快照**（「7 盒」是当时的计量事实，不能改写成「个」）',
    movedRecs.some((rec) => rec.unit === '盒'),
    movedRecs.map((rec) => rec.unit).join('/')
  )

  // ── 23c. 合并时指定单位 ──────────────────────────────────
  const rnD = await applyTransaction({
    time: '2026-09-21T13:00',
    name: '待改名丁',
    quantity: 4,
    unit: '包',
    type: 'in'
  })
  if (!rnD.ok) throw new Error('重命名用例的前置数据没造出来')
  const mergedWithUnit = await renameItem(rnD.item.id, '待改名乙', '箱')
  check(
    '可以指定合并后使用的单位',
    mergedWithUnit.ok && mergedWithUnit.item.unit === '箱',
    JSON.stringify(mergedWithUnit.ok ? mergedWithUnit.item.unit : mergedWithUnit)
  )
  check(
    '指定单位后数量继续累加 10 + 4 = 14',
    mergedWithUnit.ok && mergedWithUnit.item.quantity === 14,
    `${mergedWithUnit.ok ? mergedWithUnit.item.quantity : '—'}`
  )

  // 清空单位 → 回落到目标物品的单位，而不是写进空串
  const rnE = await applyTransaction({
    time: '2026-09-21T14:00',
    name: '待改名戊',
    quantity: 1,
    unit: '袋',
    type: 'in'
  })
  if (!rnE.ok) throw new Error('重命名用例的前置数据没造出来')
  const blankUnit = await renameItem(rnE.item.id, '待改名乙', '   ')
  check(
    '单位传空串 → 回落成目标物品当前的单位，不会写进空串',
    blankUnit.ok && blankUnit.item.unit === '箱',
    JSON.stringify(blankUnit.ok ? blankUnit.item.unit : blankUnit)
  )

  // ── 23d. 单位一致时不该有 unitConflict ────────────────────
  const sameA = await applyTransaction({ time: '2026-09-21T15:00', name: '同名甲', quantity: 2, unit: '个', type: 'in' })
  const sameB = await applyTransaction({ time: '2026-09-21T16:00', name: '同名乙', quantity: 3, unit: '个', type: 'in' })
  if (!sameA.ok || !sameB.ok) throw new Error('重命名用例的前置数据没造出来')
  const mergedSameUnit = await renameItem(sameB.item.id, '同名甲')
  check(
    '单位一致时不带 unitConflict（界面不该弹选单位的框）',
    mergedSameUnit.ok && mergedSameUnit.unitConflict === undefined,
    JSON.stringify(mergedSameUnit.ok ? mergedSameUnit.unitConflict : mergedSameUnit)
  )
  check(
    '单位一致时数量直接相加 2 + 3 = 5',
    mergedSameUnit.ok && mergedSameUnit.item.quantity === 5,
    `${mergedSameUnit.ok ? mergedSameUnit.item.quantity : '—'}`
  )

  // ── 23e. 合并后库存为负要给出提示 ────────────────────────
  const negA = await applyTransaction({ time: '2026-09-21T17:00', name: '负数甲', quantity: 1, unit: '个', type: 'in' })
  const negB = await applyTransaction({ time: '2026-09-21T18:00', name: '负数乙', quantity: 10, unit: '个', type: 'out' })
  if (!negA.ok || !negB.ok) throw new Error('重命名用例的前置数据没造出来')
  const mergedNeg = await renameItem(negB.item.id, '负数甲')
  check(
    '合并后库存为负 → 数量 1 - 10 = -9',
    mergedNeg.ok && mergedNeg.item.quantity === -9,
    `${mergedNeg.ok ? mergedNeg.item.quantity : '—'}`
  )
  check(
    '合并后库存为负 → 带出 warning',
    mergedNeg.ok && typeof mergedNeg.warning === 'string' && mergedNeg.warning.includes('负'),
    JSON.stringify(mergedNeg.ok ? mergedNeg.warning : mergedNeg)
  )

  // ── 23f. 改名要真的落盘 ──────────────────────────────────
  initStore(dir)
  await load()
  const reloaded = getSnapshot()
  check(
    '重载后改过的名字还在（不是只改了内存）',
    reloaded.items.some((i) => i.name === '待改名乙') &&
      !reloaded.items.some((i) => i.name === '待改名丙'),
    reloaded.items.map((i) => i.name).join('/')
  )
  check(
    '重载后历史记录的名称快照也是新的',
    reloaded.records.some((rec) => rec.name === '改名后的甲') &&
      !reloaded.records.some((rec) => rec.name === '待改名甲')
  )
  check(
    '重载后被并掉的物品没有复活',
    !reloaded.items.some((i) => i.name === '待改名丙' || i.name === '待改名丁')
  )

  // ── 24. 强行修改库存数量（需口令） ────────────────────────
  section('24. 强行修改库存数量（需口令）')
  initStore(dir)
  await load()

  const qtyItem = getSnapshot().items.find((i) => i.name === '待改名乙')
  if (!qtyItem) throw new Error('改数量用例的前置物品没找到')
  const qtyBefore = qtyItem.quantity
  const recordsBeforeQty = getSnapshot().records.length

  // ── 24a. 口令不对：一步都不能往下走 ──────────────────────
  const badPwd = await setItemQuantity(qtyItem.id, 999, '000000')
  check('口令错误 → 拒绝', badPwd.ok === false, JSON.stringify(badPwd))
  check(
    '口令错误 → 带 wrongPassword（界面据此退回口令那一步）',
    !badPwd.ok && badPwd.wrongPassword === true,
    JSON.stringify(badPwd)
  )
  check(
    '口令错误 → 数量一个字都没动',
    getSnapshot().items.find((i) => i.id === qtyItem.id)?.quantity === qtyBefore,
    `${getSnapshot().items.find((i) => i.id === qtyItem.id)?.quantity} vs ${qtyBefore}`
  )

  // 口令缺失的各种形态都要挡住：String(undefined) 是 'undefined'，
  // 不特判就会有人靠「传 undefined 恰好不等于口令」这种巧合过掉
  for (const [label, pwd] of [
    ['空串', ''],
    ['undefined', undefined],
    ['null', null],
    ['纯空白', '   '],
    ['数字 771204（类型不对）', 771204],
    // String(['771204']) 也等于 '771204' —— 不严格比类型的话，这种也能混过去
    ['单元素数组', ['771204']],
    ['771204 中间夹了空格', '7712 04'],
    ['前缀不同的 1771204', '1771204']
  ] as const) {
    const r0 = await setItemQuantity(qtyItem.id, 999, pwd as unknown as string)
    check(`口令「${label}」→ 拒绝`, r0.ok === false, JSON.stringify(r0))
  }

  // 首尾空白刻意宽容：粘贴口令时带空格是常见手滑，判成「口令不正确」
  // 只会让人怀疑自己记错了口令
  const spacedPwd = await setItemQuantity(qtyItem.id, 111, ' 771204 ')
  check(
    '口令带首尾空白 → 放行（粘贴手滑，不该判成口令错）',
    spacedPwd.ok === true && spacedPwd.item.quantity === 111,
    JSON.stringify(spacedPwd)
  )

  // 口令校验发生在找物品之前：口令错时，连「物品不存在」都不该被说出来
  const ghostWrongPwd = await setItemQuantity('不存在的-id', 1, 'x')
  check(
    '口令错优先于「物品不存在」（先验口令，再找物品）',
    ghostWrongPwd.ok === false && ghostWrongPwd.wrongPassword === true,
    JSON.stringify(ghostWrongPwd)
  )

  // ── 24b. 口令正确：改成功，且不写流水 ────────────────────
  const okSet = await setItemQuantity(qtyItem.id, 321, QUANTITY_EDIT_PASSWORD)
  check('口令正确 → 改成 321', okSet.ok && okSet.item.quantity === 321, JSON.stringify(okSet))
  check(
    '强行改数不写流水（记录数不变）',
    getSnapshot().records.length === recordsBeforeQty,
    `${recordsBeforeQty} → ${getSnapshot().records.length}`
  )
  check(
    '内存快照同步',
    getSnapshot().items.find((i) => i.id === qtyItem.id)?.quantity === 321
  )

  const diskAfterQty = JSON.parse(await readFile(getDataFilePath(), 'utf8'))
  check(
    '数量已落盘（不是只改了内存）',
    diskAfterQty.items.find((i: { id: string }) => i.id === qtyItem.id)?.quantity === 321
  )

  // 只动指定的那一个物品，别的不许被牵连
  const otherQty = getSnapshot().items.find((i) => i.id !== qtyItem.id) as { id: string; quantity: number }
  const otherBefore = otherQty.quantity
  await setItemQuantity(qtyItem.id, 777, QUANTITY_EDIT_PASSWORD)
  check(
    '只改指定的那个物品，其他物品的数量不动',
    getSnapshot().items.find((i) => i.id === otherQty.id)?.quantity === otherBefore
  )

  // ── 24c. 负数 / 0 / 小数都允许 ───────────────────────────
  // 库存允许为负是本系统的既有语义（出库超库存只警告不阻断），
  // 强行改数更不该在这里替用户把关
  const negQty = await setItemQuantity(qtyItem.id, -8, QUANTITY_EDIT_PASSWORD)
  check('允许改成负数', negQty.ok && negQty.item.quantity === -8, JSON.stringify(negQty))
  const zeroQty = await setItemQuantity(qtyItem.id, 0, QUANTITY_EDIT_PASSWORD)
  check('允许改成 0', zeroQty.ok && zeroQty.item.quantity === 0, JSON.stringify(zeroQty))
  const fracQty = await setItemQuantity(qtyItem.id, 12.5, QUANTITY_EDIT_PASSWORD)
  check('小数保留（12.5）', fracQty.ok && fracQty.item.quantity === 12.5, JSON.stringify(fracQty))

  // ── 24d. 非法数字一律**拒绝**，不回落默认值 ──────────────
  // 这一条与警戒值相反，是刻意的：用户已经按了「确认修改」，
  // 此刻的空串只可能是错误，静默写成某个值等于伪造一次没人确认过的修改
  for (const [label, bad] of [
    ['空串', ''],
    ['纯空白', '   '],
    ['非数字', 'abc'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['undefined', undefined],
    ['null', null]
  ] as const) {
    const res = await setItemQuantity(qtyItem.id, bad, QUANTITY_EDIT_PASSWORD)
    check(`非法数量「${label}」被拒绝`, res.ok === false, JSON.stringify(res))
  }
  check(
    '非法输入被拒后，数量还是上一次成功的 12.5（没被静默改写）',
    getSnapshot().items.find((i) => i.id === qtyItem.id)?.quantity === 12.5,
    `${getSnapshot().items.find((i) => i.id === qtyItem.id)?.quantity}`
  )

  // ── 24e. 没变就什么都不做 ────────────────────────────────
  const sameQty = await setItemQuantity(qtyItem.id, 12.5, QUANTITY_EDIT_PASSWORD)
  check('改成同一个值 → 成功但无操作', sameQty.ok === true && sameQty.item.quantity === 12.5, JSON.stringify(sameQty))

  const ghostQty = await setItemQuantity('不存在的-id', 1, QUANTITY_EDIT_PASSWORD)
  check('物品不存在时返回错误', ghostQty.ok === false, JSON.stringify(ghostQty))

  // ── 24f. 重启后数量还在 ──────────────────────────────────
  initStore(dir)
  await load()
  check(
    '重新加载后强行改过的数量仍在（12.5）',
    getSnapshot().items.find((i) => i.id === qtyItem.id)?.quantity === 12.5,
    `${getSnapshot().items.find((i) => i.id === qtyItem.id)?.quantity}`
  )

  // ── 25. v1.6.0 新增：备注 / 单位 / 删除物品 / 排序 / 导入 ──
  section('25. 备注 / 单位 / 删除物品 / 排序 / 导入')
  initStore(dir)
  await load()

  const v16 = getSnapshot().items[0]
  if (!v16) throw new Error('v1.6.0 用例的前置物品没找到')
  const recordsBeforeV16 = getSnapshot().records.length

  // ── 25a. 备注 ────────────────────────────────────────────
  const noteSet = await setItemNote(v16.id, '这是个备注')
  check('改备注成功', noteSet.ok && noteSet.item.note === '这是个备注', JSON.stringify(noteSet))
  check('改备注不写流水', getSnapshot().records.length === recordsBeforeV16)
  check(
    '备注已落盘',
    JSON.parse(await readFile(getDataFilePath(), 'utf8')).items.find(
      (i: { id: string }) => i.id === v16.id
    )?.note === '这是个备注'
  )
  // 与数量相反：数量留空是错误，备注留空是「把备注去掉」
  const noteClear = await setItemNote(v16.id, '')
  check('备注允许清空', noteClear.ok && noteClear.item.note === '', JSON.stringify(noteClear))
  const noteGhost = await setItemNote('不存在的-id', 'x')
  check('物品不存在时改备注返回错误', noteGhost.ok === false, JSON.stringify(noteGhost))

  // ── 25b. 单位 ────────────────────────────────────────────
  const unitBefore = v16.unit
  const unitSet = await setItemUnit(v16.id, '箱')
  check('改单位成功', unitSet.ok && unitSet.item.unit === '箱', JSON.stringify(unitSet))
  check('改单位不写流水', getSnapshot().records.length === recordsBeforeV16)
  for (const [label, bad] of [
    ['空串', ''],
    ['纯空白', '   '],
    ['undefined', undefined],
    ['null', null]
  ] as const) {
    const r = await setItemUnit(v16.id, bad as unknown as string)
    check(`单位「${label}」被拒绝（空单位会让整列空白）`, r.ok === false, JSON.stringify(r))
  }
  check('单位被拒后仍是「箱」', getSnapshot().items.find((i) => i.id === v16.id)?.unit === '箱')
  await setItemUnit(v16.id, unitBefore)

  // ── 25c. 删除物品（需口令） ──────────────────────────────
  const delSeed = await applyTransaction({
    time: '2026-09-24T10:00',
    name: '待删物品',
    quantity: 5,
    unit: '个',
    type: 'in'
  })
  if (!delSeed.ok) throw new Error('删除用例的前置数据没造出来')
  const delId = delSeed.item.id
  const itemsBeforeDelete = getSnapshot().items.length
  const recordsBeforeDelete = getSnapshot().records.length

  const delBad = await deleteItem(delId, '000000')
  check(
    '口令错 → 拒绝删除',
    delBad.ok === false && delBad.wrongPassword === true,
    JSON.stringify(delBad)
  )
  check('口令错 → 物品还在', getSnapshot().items.some((i) => i.id === delId))
  check('口令错 → 记录一条没少', getSnapshot().records.length === recordsBeforeDelete)

  const delOk = await deleteItem(delId, QUANTITY_EDIT_PASSWORD)
  check('口令对 → 删除成功', delOk.ok === true, JSON.stringify(delOk))
  if (delOk.ok) {
    check('删掉 1 个物品', delOk.itemCount === 1)
    check('连带删掉它名下的记录', delOk.recordCount === 1, `${delOk.recordCount}`)
  }
  check('物品数少 1', getSnapshot().items.length === itemsBeforeDelete - 1)
  check('记录数少 1（不留孤儿记录）', getSnapshot().records.length === recordsBeforeDelete - 1)
  check(
    '磁盘上也没有孤儿记录',
    JSON.parse(await readFile(getDataFilePath(), 'utf8')).records.every(
      (r: { itemId: string }) => r.itemId !== delId
    )
  )
  const delGhost = await deleteItem('不存在的-id', QUANTITY_EDIT_PASSWORD)
  check('物品不存在时删除返回错误', delGhost.ok === false, JSON.stringify(delGhost))

  // ── 25d. 拖动排序 ────────────────────────────────────────
  const orderBefore = getSnapshot().items.map((i) => i.id)
  check('至少有 3 个物品可排序', orderBefore.length >= 3, `${orderBefore.length}`)
  const reversed = [...orderBefore].reverse()
  const reorderOk = await reorderItems(reversed)
  check('重排成功', reorderOk.ok === true, JSON.stringify(reorderOk).slice(0, 120))
  check('顺序真的反过来了', getSnapshot().items.map((i) => i.id).join(',') === reversed.join(','))
  check(
    '顺序已落盘',
    JSON.parse(await readFile(getDataFilePath(), 'utf8')).items.map(
      (i: { id: string }) => i.id
    ).join(',') === reversed.join(',')
  )

  const reorderShort = await reorderItems(reversed.slice(0, -1))
  check(
    '数量不一致 → 拒绝（按过期列表重排会悄悄丢物品）',
    reorderShort.ok === false,
    JSON.stringify(reorderShort)
  )
  const reorderDup = await reorderItems([reversed[0], ...reversed.slice(0, -1)])
  check('有重复 id → 拒绝', reorderDup.ok === false, JSON.stringify(reorderDup))
  const reorderGhost = await reorderItems([...reversed.slice(0, -1), '不存在的-id'])
  check('有不存在的 id → 拒绝', reorderGhost.ok === false, JSON.stringify(reorderGhost))
  check('被拒后顺序没变', getSnapshot().items.map((i) => i.id).join(',') === reversed.join(','))

  // ── 25e. 导入表格（会清空现有数据） ──────────────────────
  const importRows: ImportRow[] = [
    { name: '导入甲', unit: '个', quantity: 11, note: '甲备注' },
    { name: '导入乙', unit: '米', quantity: 22, note: '' },
    { name: '导入丙', unit: '卷', quantity: -3, note: '' }
  ]
  const impBad = await importTable('000000', importRows, '张三', '李四')
  check(
    '口令错 → 拒绝导入',
    impBad.ok === false && impBad.wrongPassword === true,
    JSON.stringify(impBad)
  )
  check('口令错 → 旧数据原封不动', getSnapshot().items.length === itemsBeforeDelete - 1)

  const impBadRow = await importTable(
    QUANTITY_EDIT_PASSWORD,
    [
      { name: '好行', unit: '个', quantity: 1 },
      { name: '', unit: '个', quantity: 2 }
    ],
    '',
    ''
  )
  check('有非法行 → 整表拒绝', impBadRow.ok === false, JSON.stringify(impBadRow))
  check(
    '整表被拒时旧数据仍在（不会「导入到一半、旧数据又没了」）',
    getSnapshot().items.length === itemsBeforeDelete - 1,
    `${getSnapshot().items.length}`
  )
  const impEmpty = await importTable(QUANTITY_EDIT_PASSWORD, [], '', '')
  check('空表格 → 拒绝（否则等于一键清空）', impEmpty.ok === false, JSON.stringify(impEmpty))

  const impOk = await importTable(QUANTITY_EDIT_PASSWORD, importRows, '张三', '李四')
  check('导入成功', impOk.ok === true, JSON.stringify(impOk))
  if (impOk.ok) {
    check('物品数 = 表格行数 3', impOk.itemCount === 3, `${impOk.itemCount}`)
    check('记录数 = 3（每行一条）', impOk.recordCount === 3, `${impOk.recordCount}`)
  }

  const afterImp = getSnapshot()
  check(
    '物品顺序 = 表格顺序',
    afterImp.items.map((i) => i.name).join('|') === '导入甲|导入乙|导入丙',
    afterImp.items.map((i) => i.name).join('|')
  )
  check('备注导进来了', afterImp.items[0].note === '甲备注', String(afterImp.items[0].note))
  check('警戒值一律用默认值', afterImp.items.every((i) => i.threshold === DEFAULT_THRESHOLD))
  check('数量按表格值（含负数）', afterImp.items[2].quantity === -3, `${afterImp.items[2].quantity}`)
  check('旧物品被清空（只剩这 3 个）', afterImp.items.length === 3)
  check('旧记录被清空（只剩这 3 条）', afterImp.records.length === 3)
  check('记录的操作人 = 导入时填的', afterImp.records.every((r) => r.operator === '张三'))
  check('记录的经手人 = 导入时填的', afterImp.records.every((r) => r.handler === '李四'))
  check(
    '记录类型是 in（StockRecord.type 只有 in/out 两种可用）',
    afterImp.records.every((r) => r.type === 'in')
  )
  check(
    '所有记录共用同一个导入时间',
    new Set(afterImp.records.map((r) => r.time)).size === 1,
    JSON.stringify(afterImp.records.map((r) => r.time))
  )
  check(
    '记录数量与对应物品的数量一致',
    afterImp.records.every(
      (r) => afterImp.items.find((i) => i.id === r.itemId)?.quantity === r.quantity
    )
  )

  // 重载：导入的结果要真的落盘
  initStore(dir)
  await load()
  check(
    '重载后导入的数据仍在',
    getSnapshot().items.map((i) => i.name).join('|') === '导入甲|导入乙|导入丙',
    getSnapshot().items.map((i) => i.name).join('|')
  )

  await rm(dir, { recursive: true, force: true })
  await rm(legacyDir, { recursive: true, force: true })
  console.log(`\n${'='.repeat(52)}`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  if (failed > 0) {
    console.log('\n失败项：')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
  console.log('数据层全部自检通过。')
}

main().catch((err) => {
  console.error('自检脚本异常终止：', err)
  process.exit(1)
})
