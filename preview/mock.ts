/**
 * 浏览器预览用的内存版数据后端。
 *
 * 它镜像主进程 store 的语义（名称归一化、单位锁定、负库存警告、撤销反向冲销），
 * 只是把「原子写盘」换成「存在内存里」。这样界面行为与真实应用一致，
 * 可以放心用来点着看效果。
 */
import type {
  DB,
  DeleteItemResult,
  DeleteRecordResult,
  ImportResult,
  ImportRow,
  Item,
  RenameItemResult,
  ReorderItemsResult,
  SetNoteResult,
  SetQuantityResult,
  SetThresholdResult,
  SetUnitResult,
  StockRecord,
  TransactionInput,
  TransactionResult
} from '@shared/types'
import {
  DEFAULT_THRESHOLD,
  matchesQuantityPassword,
  normalizeName,
  normalizeThreshold,
  roundQuantity,
  toLocalDateTime
} from '@shared/utils'

const NOW = new Date().toISOString()

let uid = 0
const nid = (p: string): string => `${p}${++uid}`

function seed(): DB {
  const items: Item[] = [
    // 刻意让几种状态都出现：高于警戒值、低于警戒值、负数、正好为 0。
    // 注意别在这里加「排针」—— 界面自检的「新建物品」用例要靠它不存在才能跑通。
  // note 刻意有的填、有的不填 —— 界面要能看出「空备注」不是坏了
  { id: 'i1', name: 'M3×8 螺丝', unit: '个', quantity: 245, threshold: 100, note: '常用规格，注意防潮', createdAt: NOW, updatedAt: NOW },
  { id: 'i2', name: '贴片电阻 10kΩ', unit: '个', quantity: 80, threshold: 100, note: '', createdAt: NOW, updatedAt: NOW },
  { id: 'i3', name: '铜线 1.5mm²', unit: '米', quantity: -15, threshold: 50, note: '负数是历史遗留，需盘点', createdAt: NOW, updatedAt: NOW },
  { id: 'i4', name: '焊锡丝 0.8mm', unit: '卷', quantity: 12, threshold: 10, note: '', createdAt: NOW, updatedAt: NOW },
  { id: 'i5', name: 'PCB 打样板', unit: '块', quantity: 0, threshold: 5, note: '打样回来的余料', createdAt: NOW, updatedAt: NOW },
    // 窗口内零出入库：报表页要显示「近 N 个月无出入库」而不是一个空刻度。
    // 库存刻意设为**高于**警戒值 —— 让「零出入库」和「低于警戒值」两个状态保持正交，
    // 否则它会连带扰动所有跟低库存有关的计数断言，排查时容易误判。
    { id: 'i9', name: '闲置物料 X', unit: '个', quantity: 50, threshold: 10, createdAt: NOW, updatedAt: NOW }
  ]
  const mk = (
    itemId: string,
    time: string,
    name: string,
    unit: string,
    quantity: number,
    type: 'in' | 'out',
    operator: string,
    handler = ''
  ): StockRecord => ({
    id: nid('r'),
    itemId,
    time,
    name,
    unit,
    quantity,
    type,
    operator,
    handler,
    createdAt: NOW
  })

  const records: StockRecord[] = [
    // 前几条刻意带上「经手人 / 领取人」：记录页要有一列显示它，
    // 全空的话断言只能验「列存在」，验不了「值取对了」。
    mk('i1', '2026-09-19T09:30', 'M3×8 螺丝', '个', 100, 'in', '张三', '赵六'),
    mk('i1', '2026-09-19T10:00', 'M3×8 螺丝', '个', 50, 'in', '李四', '赵六'),
    mk('i1', '2026-09-19T11:00', 'M3×8 螺丝', '个', 20, 'out', '张三', '孙八'),
    mk('i2', '2026-09-18T14:00', '贴片电阻 10kΩ', '个', 200, 'in', ''),
    mk('i2', '2026-09-19T08:00', '贴片电阻 10kΩ', '个', 120, 'out', '王五', '周九'),
    mk('i3', '2026-09-19T13:00', '铜线 1.5mm²', '米', 30, 'in', ''),
    mk('i3', '2026-09-19T15:00', '铜线 1.5mm²', '米', 45, 'out', '李四'),
    mk('i4', '2026-09-17T16:20', '焊锡丝 0.8mm', '卷', 12, 'in', '张三'),
    mk('i1', '2026-08-20T10:00', 'M3×8 螺丝', '个', 5, 'in', '张三'),

    // 更早几个月的数据，专门喂给报表页的月度柱状图 ——
    // 否则 6 个月里只有 2 个月有柱子，看不出图表的实际效果。
    // 刻意避开 08-20 与 09-17 ~ 09-19：记录页的日期筛选断言依赖那几天的条数。
    mk('i1', '2026-06-12T09:00', 'M3×8 螺丝', '个', 300, 'in', '张三'),
    mk('i2', '2026-06-20T14:30', '贴片电阻 10kΩ', '个', 500, 'in', '李四'),
    mk('i4', '2026-06-28T11:10', '焊锡丝 0.8mm', '卷', 40, 'in', ''),
    mk('i3', '2026-07-03T09:45', '铜线 1.5mm²', '米', 120, 'in', '李四'),
    mk('i1', '2026-07-08T10:20', 'M3×8 螺丝', '个', 150, 'out', '张三'),
    mk('i2', '2026-07-15T16:00', '贴片电阻 10kΩ', '个', 260, 'out', '王五'),
    mk('i5', '2026-07-22T13:30', 'PCB 打样板', '块', 30, 'in', '张三'),
    mk('i2', '2026-08-11T15:20', '贴片电阻 10kΩ', '个', 180, 'out', '王五'),

    // 再往前铺满 12 个月。报表页默认窗口就是 12 个月，
    // 只有 6~9 月有数据的话左边三分之二全空，默认视图看着像坏了。
    // 顺带让「往前滑」有足够的历史可滑 —— 可滑范围 = 最早记录所在月到当前月。
    // 日期都落在 2025-10 ~ 2026-05，离记录页筛选断言依赖的那几天很远。
    mk('i1', '2025-10-14T09:20', 'M3×8 螺丝', '个', 200, 'in', '张三'),
    mk('i2', '2025-10-27T15:40', '贴片电阻 10kΩ', '个', 300, 'in', '李四'),
    mk('i3', '2025-11-06T10:10', '铜线 1.5mm²', '米', 80, 'in', '李四'),
    mk('i1', '2025-11-19T14:05', 'M3×8 螺丝', '个', 90, 'out', '张三'),
    mk('i4', '2025-12-03T11:30', '焊锡丝 0.8mm', '卷', 25, 'in', ''),
    mk('i2', '2025-12-16T16:45', '贴片电阻 10kΩ', '个', 150, 'out', '王五'),
    mk('i5', '2026-01-09T09:00', 'PCB 打样板', '块', 20, 'in', '张三'),
    mk('i1', '2026-01-22T13:15', 'M3×8 螺丝', '个', 260, 'in', '李四'),
    mk('i3', '2026-02-05T10:40', '铜线 1.5mm²', '米', 60, 'out', '王五'),
    mk('i2', '2026-02-18T15:25', '贴片电阻 10kΩ', '个', 400, 'in', '李四'),
    mk('i4', '2026-03-11T09:50', '焊锡丝 0.8mm', '卷', 15, 'out', '张三'),
    mk('i1', '2026-03-24T14:35', 'M3×8 螺丝', '个', 120, 'out', '王五'),
    mk('i5', '2026-04-08T11:05', 'PCB 打样板', '块', 45, 'in', '李四'),
    mk('i2', '2026-04-21T16:20', '贴片电阻 10kΩ', '个', 220, 'out', '王五'),
    mk('i3', '2026-05-13T10:30', '铜线 1.5mm²', '米', 150, 'in', '张三'),
    mk('i1', '2026-05-26T15:10', 'M3×8 螺丝', '个', 180, 'in', '李四')
  ]

  // ?seed=N 额外灌 N 条记录，用来观察「记录攒多了」时界面的表现
  const seedParam = Number(new URLSearchParams(location.search).get('seed') ?? 0)
  if (Number.isFinite(seedParam) && seedParam > 0) {
    const n = Math.min(Math.floor(seedParam), 50000)
    for (let i = 0; i < n; i++) {
      const it = items[i % items.length]
      const day = String((i % 28) + 1).padStart(2, '0')
      const hh = String(i % 24).padStart(2, '0')
      const mm = String((i * 7) % 60).padStart(2, '0')
      records.push(
        mk(
          it.id,
          `2026-09-${day}T${hh}:${mm}`,
          it.name,
          it.unit,
          (i % 20) + 1,
          i % 3 === 0 ? 'out' : 'in',
          `员工${(i % 7) + 1}`
        )
      )
    }
  }

  return { version: 1, items, records }
}

let db: DB = seed()

let subSeq = 0
const subs = new Map<number, () => void>()
function notify(): void {
  for (const fn of subs.values()) fn()
}

function clone(): DB {
  return {
    version: 1,
    items: db.items.map((i) => ({ ...i })),
    records: db.records.map((r) => ({ ...r }))
  }
}

function applyTransaction(input: TransactionInput): TransactionResult {
  const name = normalizeName(input.name ?? '')
  if (!name) return { ok: false, error: '名称不能为空' }

  const qty = Number(input.quantity)
  if (!Number.isFinite(qty)) return { ok: false, error: '数量必须是数字' }
  if (qty <= 0) return { ok: false, error: '数量必须大于 0' }

  if (input.type !== 'in' && input.type !== 'out') {
    return { ok: false, error: '操作类型必须是入库或出库' }
  }

  const quantity = roundQuantity(qty)
  const next = clone()
  const stamp = new Date().toISOString()

  const existing = next.items.find((i) => i.name === name)
  let item: Item
  let unit: string

  if (existing) {
    // 与数据层一致：物品已存在则强制沿用其单位
    item = existing
    unit = existing.unit
  } else {
    unit = (input.unit ?? '').trim()
    if (!unit) return { ok: false, error: '新物品必须填写单位' }
    item = {
      id: nid('i'),
      name,
      unit,
      quantity: 0,
      threshold: DEFAULT_THRESHOLD,
      createdAt: stamp,
      updatedAt: stamp
    }
    next.items.push(item)
  }

  const delta = input.type === 'in' ? quantity : -quantity
  item.quantity = roundQuantity(item.quantity + delta)
  item.updatedAt = stamp

  const record: StockRecord = {
    id: nid('r'),
    itemId: item.id,
    time: input.time || toLocalDateTime(),
    name: item.name,
    unit,
    quantity,
    type: input.type,
    operator: (input.operator ?? '').trim(),
    handler: (input.handler ?? '').trim(),
    createdAt: stamp
  }
  next.records.push(record)

  db = next
  notify()

  return {
    ok: true,
    item: { ...item },
    record: { ...record },
    warning:
      item.quantity < 0
        ? `「${item.name}」库存已为负（${item.quantity} ${item.unit}），请及时补货`
        : undefined
  }
}

function deleteRecord(id: string): DeleteRecordResult {
  const index = db.records.findIndex((r) => r.id === id)
  if (index < 0) return { ok: false, error: '记录不存在，可能已被删除' }

  const next = clone()
  const [removed] = next.records.splice(index, 1)

  const item = next.items.find((i) => i.id === removed.itemId)
  if (item) {
    const delta = removed.type === 'in' ? -removed.quantity : removed.quantity
    item.quantity = roundQuantity(item.quantity + delta)
    item.updatedAt = new Date().toISOString()
  }

  db = next
  notify()

  return {
    ok: true,
    removed: { ...removed },
    item: item ? { ...item } : null,
    warning:
      item && item.quantity < 0
        ? `「${item.name}」库存变为负数（${item.quantity} ${item.unit}）`
        : undefined
  }
}

function setItemThreshold(id: string, threshold: number): SetThresholdResult {
  const item = db.items.find((i) => i.id === id)
  if (!item) return { ok: false, error: '物品不存在，可能已被删除' }

  const next = clone()
  const target = next.items.find((i) => i.id === id) as Item
  const value = normalizeThreshold(threshold)
  if (target.threshold === value) return { ok: true, item: { ...target } }

  target.threshold = value
  db = next
  notify()
  return { ok: true, item: { ...target } }
}

/**
 * 强行修改库存数量。语义与主进程 store 的 `setItemQuantity` 保持一致：
 * 口令不对直接拒（连找物品都不做），非法数字也拒（**不回落默认值**，与警戒值相反），
 * 合法值直接覆盖、不写流水。
 *
 * 演示模式没有真实写盘，但**必须镜像同一套规则** ——
 * 否则界面自检验的是 mock 的行为，与真实应用对不上，等于白验。
 */
function setItemQuantity(
  id: string,
  rawQuantity: unknown,
  password: unknown
): SetQuantityResult {
  // 与数据层一致：共用同一个口令判定函数
  if (!matchesQuantityPassword(password)) {
    return { ok: false, error: '口令不正确', wrongPassword: true }
  }

  if (rawQuantity === null || rawQuantity === undefined) {
    return { ok: false, error: '数量不能为空' }
  }
  if (typeof rawQuantity === 'string' && rawQuantity.trim() === '') {
    return { ok: false, error: '数量不能为空' }
  }

  const quantity = Number(rawQuantity)
  if (!Number.isFinite(quantity)) return { ok: false, error: '数量必须是数字' }

  const item = db.items.find((i) => i.id === id)
  if (!item) return { ok: false, error: '物品不存在，可能已被删除' }

  const next = clone()
  const target = next.items.find((i) => i.id === id) as Item
  const value = roundQuantity(quantity)
  if (target.quantity === value) return { ok: true, item: { ...target } }

  target.quantity = value
  target.updatedAt = new Date().toISOString()
  db = next
  notify()
  return { ok: true, item: { ...target } }
}

/**
 * 修改物品备注。语义与主进程 `setItemNote` 一致：不写流水、允许空串。
 */
function setItemNote(id: string, rawNote: unknown): SetNoteResult {
  const item = db.items.find((i) => i.id === id)
  if (!item) return { ok: false, error: '物品不存在，可能已被删除' }

  const note = typeof rawNote === 'string' ? rawNote : String(rawNote ?? '')
  const next = clone()
  const target = next.items.find((i) => i.id === id) as Item
  if ((target.note ?? '') === note) return { ok: true, item: { ...target } }

  target.note = note
  target.updatedAt = new Date().toISOString()
  db = next
  notify()
  return { ok: true, item: { ...target } }
}

/** 修改物品单位。语义与主进程 `setItemUnit` 一致：不写流水、空串被拒 */
function setItemUnit(id: string, rawUnit: unknown): SetUnitResult {
  const unit = typeof rawUnit === 'string' ? rawUnit.trim() : String(rawUnit ?? '').trim()
  if (!unit) return { ok: false, error: '单位不能为空' }

  const item = db.items.find((i) => i.id === id)
  if (!item) return { ok: false, error: '物品不存在，可能已被删除' }

  const next = clone()
  const target = next.items.find((i) => i.id === id) as Item
  if (target.unit === unit) return { ok: true, item: { ...target } }

  target.unit = unit
  target.updatedAt = new Date().toISOString()
  db = next
  notify()
  return { ok: true, item: { ...target } }
}

/** 删除整个物品及其名下所有记录。语义与主进程 `deleteItem` 一致（需口令） */
function deleteItem(id: string, password: unknown): DeleteItemResult {
  if (!matchesQuantityPassword(password)) {
    return { ok: false, error: '口令不正确', wrongPassword: true }
  }
  if (!db.items.some((i) => i.id === id)) {
    return { ok: false, error: '物品不存在，可能已被删除' }
  }

  const recordCount = db.records.filter((r) => r.itemId === id).length
  const next = clone()
  next.items = next.items.filter((i) => i.id !== id)
  next.records = next.records.filter((r) => r.itemId !== id)
  db = next
  notify()
  return { ok: true, itemCount: 1, recordCount }
}

/** 拖动改顺序。语义与主进程 `reorderItems` 一致（不需口令，但校验数量与重复） */
function reorderItems(orderedIds: string[]): ReorderItemsResult {
  if (!Array.isArray(orderedIds)) return { ok: false, error: '顺序列表格式不对' }
  if (orderedIds.length !== db.items.length) {
    return {
      ok: false,
      error:
        `顺序列表与物品数不一致（${orderedIds.length} vs ${db.items.length}），` +
        '刚有物品增删，请刷新后重试'
    }
  }

  const byId = new Map(db.items.map((i) => [i.id, i]))
  const seen = new Set<string>()
  const reordered: Item[] = []
  for (const id of orderedIds) {
    if (seen.has(id)) return { ok: false, error: '顺序列表里有重复物品' }
    const item = byId.get(id)
    if (!item) return { ok: false, error: '顺序列表里有不存在的物品，请刷新后重试' }
    seen.add(id)
    reordered.push(item)
  }

  const unchanged = reordered.every((item, i) => db.items[i]?.id === item.id)
  if (unchanged) return { ok: true, items: db.items.map((i) => ({ ...i })) }

  const next = clone()
  next.items = reordered
  db = next
  notify()
  return { ok: true, items: reordered.map((i) => ({ ...i })) }
}

/**
 * 导入表格（需口令，**会清空现有全部数据**）。
 * 语义与主进程 `importTable` 一致：名称/单位严格、**数量不是数字按 0 录入**，
 * 且整表校验在清空之前。
 */
function importTable(
  password: unknown,
  rows: ImportRow[],
  operator: unknown,
  handler: unknown
): ImportResult {
  if (!matchesQuantityPassword(password)) {
    return { ok: false, error: '口令不正确', wrongPassword: true }
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, error: '表格里没有任何数据行' }
  }

  const prepared: { name: string; unit: string; quantity: number; note: string }[] = []
  const zeroedRows: number[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as ImportRow | undefined

    const name = normalizeName(typeof row?.name === 'string' ? row.name : String(row?.name ?? ''))
    if (!name) return { ok: false, error: `第 ${i + 1} 行：名称为空`, rowIndex: i }

    const unit = typeof row?.unit === 'string' ? row.unit.trim() : String(row?.unit ?? '').trim()
    if (!unit) return { ok: false, error: `第 ${i + 1} 行：单位为空`, rowIndex: i }

    // 同主进程：数量解析不出来就按 0 记，并记下行号（空串也算「不是数字」）
    const rawQty: unknown = row?.quantity
    const isBlank =
      rawQty === null || rawQty === undefined || (typeof rawQty === 'string' && rawQty.trim() === '')
    const parsed = isBlank ? Number.NaN : Number(rawQty)

    let quantity: number
    if (Number.isFinite(parsed)) {
      quantity = roundQuantity(parsed)
    } else {
      quantity = 0
      zeroedRows.push(i + 1)
    }

    const note = typeof row?.note === 'string' ? row.note : String(row?.note ?? '')
    prepared.push({ name, unit, quantity, note })
  }

  const now = new Date().toISOString()
  const time = toLocalDateTime()
  const operatorText = typeof operator === 'string' ? operator.trim() : String(operator ?? '')
  const handlerText = typeof handler === 'string' ? handler.trim() : String(handler ?? '')

  const nextItems: Item[] = []
  const nextRecords: StockRecord[] = []
  for (const row of prepared) {
    const item: Item = {
      id: nid('i'),
      name: row.name,
      unit: row.unit,
      quantity: row.quantity,
      threshold: DEFAULT_THRESHOLD,
      note: row.note,
      createdAt: now,
      updatedAt: now
    }
    nextItems.push(item)
    nextRecords.push({
      id: nid('r'),
      itemId: item.id,
      time,
      name: item.name,
      unit: item.unit,
      quantity: row.quantity,
      type: 'in',
      operator: operatorText,
      handler: handlerText,
      createdAt: now
    })
  }

  db = { version: 1, items: nextItems, records: nextRecords }
  notify()
  return {
    ok: true,
    itemCount: nextItems.length,
    recordCount: nextRecords.length,
    zeroedRows
  }
}

/**
 * 重命名物品。语义与主进程 store 的 `renameItem` 保持一致：
 * 单纯改名时同步历史记录的 name 快照；撞名时合并（搬记录、累加数量、删源物品）。
 *
 * 演示模式下没有真实写盘，但**必须镜像同一套规则** ——
 * 否则界面自检验的是 mock 的行为，与真实应用对不上，等于白验。
 */
function renameItem(id: string, rawName: string, unit?: string): RenameItemResult {
  const name = normalizeName(rawName ?? '')
  if (!name) return { ok: false, error: '名称不能为空' }

  if (!db.items.some((i) => i.id === id)) {
    return { ok: false, error: '物品不存在，可能已被删除' }
  }

  const next = clone()
  const stamp = new Date().toISOString()
  const src = next.items.find((i) => i.id === id) as Item

  if (src.name === name) {
    return { ok: true, item: { ...src }, merged: false, movedRecords: 0, renamedRecords: 0 }
  }

  const target = next.items.find((i) => i.name === name && i.id !== id)

  if (!target) {
    const oldName = src.name
    src.name = name
    src.updatedAt = stamp
    let renamedRecords = 0
    for (const r of next.records) {
      if (r.itemId !== id) continue
      r.name = name
      renamedRecords++
    }
    db = next
    notify()
    return {
      ok: true,
      item: { ...src },
      merged: false,
      mergedFrom: oldName,
      movedRecords: 0,
      renamedRecords
    }
  }

  const unitConflict =
    target.unit === src.unit ? undefined : { keptUnit: target.unit, otherUnit: src.unit }
  const chosenUnit = (unit ?? '').trim() || target.unit

  target.quantity = roundQuantity(target.quantity + src.quantity)
  target.unit = chosenUnit
  target.updatedAt = stamp

  let movedRecords = 0
  for (const r of next.records) {
    if (r.itemId !== id) continue
    r.itemId = target.id
    r.name = target.name
    movedRecords++
  }
  next.items = next.items.filter((i) => i.id !== id)

  db = next
  notify()

  return {
    ok: true,
    item: { ...target },
    merged: true,
    mergedFrom: src.name,
    movedRecords,
    renamedRecords: 0,
    unitConflict,
    warning:
      target.quantity < 0
        ? `「${target.name}」合并后库存为负（${target.quantity} ${target.unit}），请及时补货`
        : undefined
  }
}

const api = {
  ping: async (): Promise<string> => 'pong',
  getSnapshot: async (): Promise<DB> => clone(),
  applyTransaction: async (input: TransactionInput): Promise<TransactionResult> =>
    applyTransaction(input),
  deleteRecord: async (id: string): Promise<DeleteRecordResult> => deleteRecord(id),
  setItemThreshold: async (id: string, threshold: number): Promise<SetThresholdResult> =>
    setItemThreshold(id, threshold),
  setItemQuantity: async (
    id: string,
    quantity: number,
    password: string
  ): Promise<SetQuantityResult> => setItemQuantity(id, quantity, password),
  renameItem: async (id: string, name: string, unit?: string): Promise<RenameItemResult> =>
    renameItem(id, name, unit),
  deleteItem: async (id: string, password: string): Promise<DeleteItemResult> =>
    deleteItem(id, password),
  reorderItems: async (orderedIds: string[]): Promise<ReorderItemsResult> =>
    reorderItems(orderedIds),
  setItemNote: async (id: string, note: string): Promise<SetNoteResult> => setItemNote(id, note),
  setItemUnit: async (id: string, unit: string): Promise<SetUnitResult> => setItemUnit(id, unit),
  importTable: async (
    password: string,
    rows: ImportRow[],
    operator: string,
    handler: string
  ): Promise<ImportResult> => importTable(password, rows, operator, handler),
  exportXlsx: async (): Promise<{ ok: boolean; error?: string }> => ({
    ok: false,
    error: '演示模式不会真的写出文件；真实应用中这里会弹出保存对话框'
  }),
  // 带 ?recovered=1 打开即可预览「已从备份恢复」提示条的样子
  getLoadReport: async (): Promise<{ recoveredFromBackup: boolean }> => ({
    recoveredFromBackup: new URLSearchParams(location.search).has('recovered')
  }),
  getDataPath: async (): Promise<string> => '（演示模式：数据只存在浏览器内存里，没有文件）',
  openDataFolder: async (): Promise<{ ok: boolean; error?: string }> => ({
    ok: false,
    error: '演示模式没有数据文件夹'
  }),
  onChanged: (cb: () => void): number => {
    const id = ++subSeq
    subs.set(id, cb)
    return id
  },
  offChanged: (id: number): void => {
    subs.delete(id)
  }
}

;(window as unknown as { api: unknown }).api = api

function mountBanner(): void {
  const el = document.createElement('div')
  el.textContent = '演示模式 · 数据仅存于浏览器内存，刷新即重置'
  el.style.cssText = [
    'position:fixed',
    'right:14px',
    'bottom:14px',
    'z-index:9999',
    'padding:6px 12px',
    'border-radius:999px',
    'background:rgba(31,35,41,0.82)',
    'color:#fff',
    'font-size:12px',
    'line-height:1.6',
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
    'pointer-events:none',
    'box-shadow:0 4px 14px rgba(0,0,0,0.18)'
  ].join(';')
  document.body.appendChild(el)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountBanner)
} else {
  mountBanner()
}
