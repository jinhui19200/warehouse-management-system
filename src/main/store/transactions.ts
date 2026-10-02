import { randomUUID } from 'node:crypto'
import type {
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
import { cloneDB, commit, enqueue, load } from './db'

/**
 * 数据层的**唯一写入口**。
 *
 * 仓库页弹窗、操作页出库块、操作页入库块 —— 三处全部调用这里的函数，
 * 不允许任何一处自己拼装「写记录」和「改库存」两个动作。
 *
 * 原子性靠这个顺序保证：
 *   校验 → 基于当前快照构造一个**全新的 DB** → 原子写盘 → 写盘成功才提交内存
 * 任何一步失败，内存里的数据都还是操作之前的样子，不会出现
 * 「记录写进去了、库存却没动」这种脏数据。
 */

type Validated =
  | { ok: true; name: string; quantity: number }
  | { ok: false; error: string }

function validate(input: TransactionInput): Validated {
  const name = normalizeName(input.name ?? '')
  if (!name) return { ok: false, error: '名称不能为空' }

  const quantity = Number(input.quantity)
  if (!Number.isFinite(quantity)) return { ok: false, error: '数量必须是数字' }
  if (quantity <= 0) return { ok: false, error: '数量必须大于 0' }

  if (input.type !== 'in' && input.type !== 'out') {
    return { ok: false, error: '操作类型必须是入库或出库' }
  }

  return { ok: true, name, quantity: roundQuantity(quantity) }
}

/** 入库或出库。物品不存在时自动创建。 */
export function applyTransaction(input: TransactionInput): Promise<TransactionResult> {
  return enqueue(async () => {
    const v = validate(input)
    if (!v.ok) return v

    const current = await load()
    const next = cloneDB(current)
    const now = new Date().toISOString()

    const existing = next.items.find((i) => i.name === v.name)
    let item: Item
    let unit: string

    if (existing) {
      // 物品已存在 → **强制使用物品自身的单位，忽略调用方传来的 unit**。
      // 前端把单位输入框锁成只读只是 UI 层的事，这里才是真正的防线：
      // 即使有人绕过界面直接调 IPC，也不可能把「个」改成「盒」。
      item = existing
      unit = existing.unit
    } else {
      unit = (input.unit ?? '').trim()
      if (!unit) return { ok: false, error: '新物品必须填写单位' }

      item = {
        id: randomUUID(),
        name: v.name,
        unit,
        quantity: 0,
        threshold: DEFAULT_THRESHOLD,
        createdAt: now,
        updatedAt: now
      }
      next.items.push(item)
    }

    const delta = input.type === 'in' ? v.quantity : -v.quantity
    item.quantity = roundQuantity(item.quantity + delta)
    item.updatedAt = now

    const record: StockRecord = {
      id: randomUUID(),
      itemId: item.id,
      time: input.time || toLocalDateTime(),
      // name / unit / operator / handler 存快照：历史记录是铁证
      name: item.name,
      unit,
      quantity: v.quantity,
      type: input.type,
      operator: (input.operator ?? '').trim(),
      handler: (input.handler ?? '').trim(),
      createdAt: now
    }
    next.records.push(record)

    try {
      await commit(next)
    } catch (err) {
      return { ok: false, error: `保存失败：${String(err)}` }
    }

    const warning =
      item.quantity < 0
        ? `「${item.name}」库存已为负（${item.quantity} ${item.unit}），请及时补货`
        : undefined

    return { ok: true, item: { ...item }, record: { ...record }, warning }
  })
}

/** 撤销一条记录，并**反向冲销**它对库存的影响。 */
export function deleteRecord(id: string, password: unknown): Promise<DeleteRecordResult> {
  return enqueue(async () => {
    /*
     * 撤销会**反向冲销库存** —— 删掉一条入库记录，库存就减回去。
     * 它和「删除物品」一样是不可逆的破坏性操作（没有「重做」），
     * 所以 2026-10-02 起同样要求口令。
     *
     * 校验点在数据层而不是界面：界面上那个口令框只是交互，
     * 绕过它直接 invoke `db:deleteRecord` 必须同样被拒。
     */
    if (!matchesQuantityPassword(password)) {
      return { ok: false, error: '口令不正确', wrongPassword: true }
    }

    const current = await load()
    const index = current.records.findIndex((r) => r.id === id)
    if (index < 0) return { ok: false, error: '记录不存在，可能已被删除' }

    const next = cloneDB(current)
    const [removed] = next.records.splice(index, 1)

    // 反向冲销：删掉一条入库记录要减库存，删掉一条出库记录要加库存。
    // 这正是撤销必须由数据层来做、不能让界面自己改数字的原因。
    const item = next.items.find((i) => i.id === removed.itemId)
    if (item) {
      const delta = removed.type === 'in' ? -removed.quantity : removed.quantity
      item.quantity = roundQuantity(item.quantity + delta)
      item.updatedAt = new Date().toISOString()
    }

    try {
      await commit(next)
    } catch (err) {
      return { ok: false, error: `保存失败：${String(err)}` }
    }

    return {
      ok: true,
      removed: { ...removed },
      item: item ? { ...item } : null,
      warning:
        item && item.quantity < 0
          ? `「${item.name}」库存变为负数（${item.quantity} ${item.unit}）`
          : undefined
    }
  })
}

/**
 * 修改某个物品的库存警戒值。
 *
 * 刻意**不写流水**：警戒值是一个观察阈值，不是库存变动。
 * 把它记进出库记录会让「本月入库/出库」的统计和撤销逻辑全部失准。
 *
 * 非法输入（清空、负数、非数字）统一回落到默认值 100，
 * 而不是报错拒绝 —— 用户在输入框里删光重填是正常操作，
 * 那一刻的中间态不该弹错误提示。
 */
export function setItemThreshold(id: string, threshold: unknown): Promise<SetThresholdResult> {
  return enqueue(async () => {
    const current = await load()
    const target = current.items.find((i) => i.id === id)
    if (!target) return { ok: false, error: '物品不存在，可能已被删除' }

    const next = cloneDB(current)
    const item = next.items.find((i) => i.id === id) as Item
    const value = normalizeThreshold(threshold)

    // 没变就什么都不做：避免每次失焦都触发一次写盘 + 全窗口广播
    if (item.threshold === value) return { ok: true, item: { ...item } }

    item.threshold = value

    try {
      await commit(next)
    } catch (err) {
      return { ok: false, error: `保存失败：${String(err)}` }
    }

    return { ok: true, item: { ...item } }
  })
}

/**
 * 强行修改某个物品的库存数量（需口令）。
 *
 * 这是**唯一**能凭空改库存、却不留任何流水的入口，所以几点必须写清楚：
 *
 * 1. **为什么刻意不写流水。** `StockRecord.type` 只有 in / out，没有任何合法值
 *    能表示「校正」。硬塞一条 in/out 更糟：它会被算进「本月入库/出库」的统计，
 *    撤销时还会按方向再反向冲销一遍 —— 一个凭空的差值被反复加减，
 *    账会越算越乱。代价是这次修改**在记录页查不到**，所以界面必须先过口令、
 *    并在提交前把「从多少改成多少」摆给用户看。
 *
 * 2. **允许任意有限数，包括负数和 0。** 库存允许为负是本系统既有的语义
 *    （见 applyTransaction 的负库存 warning），强行修改更不该在这里替用户把关。
 *
 * 3. **非法输入一律拒绝，不回落默认值 —— 这一点与 setItemThreshold 相反。**
 *    改警戒值时的空串是「用户正在清空重填」的中间态，回落 100 是合理的；
 *    而这里是用户明确按了「确认修改」，此刻的空串/非数字只可能是错误，
 *    静默写成某个值等于伪造了一次没人确认过的修改。
 *
 * 4. **口令校验在读盘之前。** 口令不对时连 load() 都不做：既快，
 *    也让「口令错」和「物品不存在」不可能被时序凑成同一种表现。
 */
export function setItemQuantity(
  id: string,
  rawQuantity: unknown,
  password: unknown
): Promise<SetQuantityResult> {
  return enqueue(async () => {
    // 口令规则与界面共用同一个函数（见 matchesQuantityPassword 的注释）：
    // 界面那道只是交互，这里才是绕过它直接 invoke 时唯一的防线
    if (!matchesQuantityPassword(password)) {
      return { ok: false, error: '口令不正确', wrongPassword: true }
    }

    // 空串要单独挡掉：Number('') === 0，不特判就会把「用户清空了没填」
    // 当成「改成 0」静默写进数据。与 normalizeThreshold 同款处理。
    if (rawQuantity === null || rawQuantity === undefined) {
      return { ok: false, error: '数量不能为空' }
    }
    if (typeof rawQuantity === 'string' && rawQuantity.trim() === '') {
      return { ok: false, error: '数量不能为空' }
    }

    const quantity = Number(rawQuantity)
    if (!Number.isFinite(quantity)) return { ok: false, error: '数量必须是数字' }

    const current = await load()
    const target = current.items.find((i) => i.id === id)
    if (!target) return { ok: false, error: '物品不存在，可能已被删除' }

    const next = cloneDB(current)
    const item = next.items.find((i) => i.id === id) as Item
    const value = roundQuantity(quantity)

    // 没变就什么都不做：避免白写一次盘 + 一次全窗口广播
    if (item.quantity === value) return { ok: true, item: { ...item } }

    item.quantity = value
    item.updatedAt = new Date().toISOString()

    try {
      await commit(next)
    } catch (err) {
      return { ok: false, error: `保存失败：${String(err)}` }
    }

    return { ok: true, item: { ...item } }
  })
}

/**
 * 修改物品备注。
 *
 * 与 setItemThreshold / setItemQuantity 一样**刻意不写流水**：
 * 备注是「这个物品」的附加说明，不是一次库存变动，
 * 记进出库记录会让「本月入库/出库」的统计和撤销逻辑全部失准。
 *
 * **允许设成空串**（用户清空备注框是明确的意图） —— 这一点与数量相反：
 * 数量留空是错误（见 setItemQuantity 第 3 条），备注留空是「把备注去掉」。
 */
export function setItemNote(id: string, rawNote: unknown): Promise<SetNoteResult> {
  return enqueue(async () => {
    const current = await load()
    const target = current.items.find((i) => i.id === id)
    if (!target) return { ok: false, error: '物品不存在，可能已被删除' }

    const note = typeof rawNote === 'string' ? rawNote : String(rawNote ?? '')

    const next = cloneDB(current)
    const item = next.items.find((i) => i.id === id) as Item

    // 没变就什么都不做：避免每次失焦都触发一次写盘 + 全窗口广播
    if ((item.note ?? '') === note) return { ok: true, item: { ...item } }

    item.note = note
    item.updatedAt = new Date().toISOString()

    try {
      await commit(next)
    } catch (err) {
      return { ok: false, error: `保存失败：${String(err)}` }
    }

    return { ok: true, item: { ...item } }
  })
}

/**
 * 修改物品单位。
 *
 * 这是**唯一**能改单位的正当入口 —— 出入库时单位由数据层锁定
 * （见 applyTransaction），改名撞名的合并路径则由调用方指定单位。
 *
 * 刻意**不写流水**（理由同 setItemNote / setItemThreshold）。
 * **单位不允许为空**：清空输入框后的空串是「取消这次修改」的信号，
 * 静默写进空串会让仓库页的单位列整列空白、且无法从记录里恢复。
 */
export function setItemUnit(id: string, rawUnit: unknown): Promise<SetUnitResult> {
  return enqueue(async () => {
    const unit = typeof rawUnit === 'string' ? rawUnit.trim() : String(rawUnit ?? '').trim()
    if (!unit) return { ok: false, error: '单位不能为空' }

    const current = await load()
    const target = current.items.find((i) => i.id === id)
    if (!target) return { ok: false, error: '物品不存在，可能已被删除' }

    const next = cloneDB(current)
    const item = next.items.find((i) => i.id === id) as Item

    if (item.unit === unit) return { ok: true, item: { ...item } }

    item.unit = unit
    item.updatedAt = new Date().toISOString()

    try {
      await commit(next)
    } catch (err) {
      return { ok: false, error: `保存失败：${String(err)}` }
    }

    return { ok: true, item: { ...item } }
  })
}

/**
 * 删除整个物品（需口令）。
 *
 * 与 deleteRecord 的区别必须讲清楚，两者名字都带「删除」但语义完全不同：
 *  - `deleteRecord` 是**撤销一条记录**：只删那一笔，并反向冲销它对库存的影响；
 *  - `deleteItem` 是**删掉这个物品本身**，连它名下**所有**历史记录一起清掉。
 * 后者不可恢复（不像撤销记录还能靠反向冲销找补回来），所以必须过口令。
 */
export function deleteItem(id: string, password: unknown): Promise<DeleteItemResult> {
  return enqueue(async () => {
    // 口令规则与界面共用同一个函数（见 matchesQuantityPassword 的注释）
    if (!matchesQuantityPassword(password)) {
      return { ok: false, error: '口令不正确', wrongPassword: true }
    }

    const current = await load()
    if (!current.items.some((i) => i.id === id)) {
      return { ok: false, error: '物品不存在，可能已被删除' }
    }

    // 先算好要清掉多少条，写盘失败时也还知道「原本要删多少」
    const recordCount = current.records.filter((r) => r.itemId === id).length

    const next = cloneDB(current)
    next.items = next.items.filter((i) => i.id !== id)
    next.records = next.records.filter((r) => r.itemId !== id)

    try {
      await commit(next)
    } catch (err) {
      return { ok: false, error: `保存失败：${String(err)}` }
    }

    return { ok: true, itemCount: 1, recordCount }
  })
}

/**
 * 重新排列物品顺序（拖动改顺序用）。
 *
 * 刻意**不需要口令**：拖动是高频微调，每拖一次都要求输口令就把体验毁了。
 * 而且这条路径下**任何数据值都没变**，只是数组顺序变了 ——
 * 最坏情况也只是「顺序不是你想要的」，重新拖回来就行，
 * 不像删物品那样不可逆。
 *
 * 校验两条，缺一不可：
 *  1. **数量必须完全一致**。多一个少一个都说明调用方手里的快照已经过期
 *     （比如另一个窗口刚删了一个物品），此时按过期列表重排会**悄悄丢物品** ——
 *     重排后的数组里根本没有那个 id，写盘后它就消失了；
 *  2. **每个 id 都必须存在且不重复**。
 */
export function reorderItems(orderedIds: string[]): Promise<ReorderItemsResult> {
  return enqueue(async () => {
    if (!Array.isArray(orderedIds)) return { ok: false, error: '顺序列表格式不对' }

    const current = await load()
    if (orderedIds.length !== current.items.length) {
      return {
        ok: false,
        error:
          `顺序列表与物品数不一致（${orderedIds.length} vs ${current.items.length}），` +
          '刚有物品增删，请刷新后重试'
      }
    }

    const byId = new Map(current.items.map((i) => [i.id, i]))
    const seen = new Set<string>()
    const reordered: Item[] = []
    for (const id of orderedIds) {
      if (seen.has(id)) return { ok: false, error: '顺序列表里有重复物品' }
      const item = byId.get(id)
      if (!item) return { ok: false, error: '顺序列表里有不存在的物品，请刷新后重试' }
      seen.add(id)
      reordered.push(item)
    }

    // 顺序没变就什么都不做：拖动后原地放下也会走到这里（drop 到自己身上），
    // 那一次不该触发写盘 + 全窗口广播
    const unchanged = reordered.every((item, i) => current.items[i]?.id === item.id)
    if (unchanged) return { ok: true, items: current.items.map((i) => ({ ...i })) }

    const next = cloneDB(current)
    next.items = reordered

    try {
      await commit(next)
    } catch (err) {
      return { ok: false, error: `保存失败：${String(err)}` }
    }

    return { ok: true, items: reordered.map((i) => ({ ...i })) }
  })
}

/**
 * 导入表格（需口令）—— **会清空现有全部数据**。
 *
 * 这是本系统唯一一个「整体替换」的入口，所以几条原则必须写死：
 *
 * 1. **校验分两档，清空永远发生在校验之后。**
 *    名称 / 单位为空 → 整体拒绝、一行都不导入（没有名字建不出物品，
 *    单位空会让仓库页整列空白，这两样没法替用户猜）；
 *    **数量不是数字 → 不阻断**，按 `0` 录入并在结果里回报行号
 *    （用户 2026-10-02 明确要求）。实际表格里「数量那格空着」太常见，
 *    为此把整张表拒掉、让用户回 Excel 一行行改，代价太大。
 *    无论哪一档，都**不能出现「导入到一半失败、旧数据又没了」**的局面。
 * 2. **物品顺序 = 表格行顺序。** 这是用户明确要求的语义
 *    （「仓库的物品顺序按表格顺序」），所以直接按 rows 的次序 push，
 *    不做任何排序、也不按名称去重。
 * 3. **每行建一条入库记录。** 表格只有名称 / 单位 / 数量 / 备注四列，
 *    没有「操作人 / 经手人 / 时间」，这三样由导入对话框统一填 ——
 *    所以同一批导入的所有记录共享同一个 time、operator、handler。
 *    记录类型是 'in'：导入本质上是「把现有库存一次性建账」，
 *    而 StockRecord.type 只有 in / out 两种，没有第三种可用。
 * 4. **警戒值一律用默认值。** 表格没有这一列，导入后用户自己在仓库页改。
 */
export function importTable(
  password: unknown,
  rows: ImportRow[],
  operator: unknown,
  handler: unknown
): Promise<ImportResult> {
  return enqueue(async () => {
    if (!matchesQuantityPassword(password)) {
      return { ok: false, error: '口令不正确', wrongPassword: true }
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: false, error: '表格里没有任何数据行' }
    }

    // ── 第 1 步：整表校验（名称 / 单位严格，数量宽松） ──────────
    const prepared: { name: string; unit: string; quantity: number; note: string }[] = []
    /** 数量不是数字、被按 0 录入的行号（1 起算） */
    const zeroedRows: number[] = []

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as ImportRow | undefined

      const name = normalizeName(typeof row?.name === 'string' ? row.name : String(row?.name ?? ''))
      if (!name) return { ok: false, error: `第 ${i + 1} 行：名称为空`, rowIndex: i }

      const unit = typeof row?.unit === 'string' ? row.unit.trim() : String(row?.unit ?? '').trim()
      if (!unit) return { ok: false, error: `第 ${i + 1} 行：单位为空`, rowIndex: i }

      // 数量：能解析成有限数就用它，否则按 0 记并记下行号。
      // 空串要单独挡：Number('') === 0，不特判就分不清「本来填了 0」和「这格是空的」，
      // 而两者都要回报给用户（后者才是「需要去核对的那些行」）。
      // 声明成 unknown 是故意的 —— ImportRow.quantity 类型上是 number，
      // 但表格解析出来的可能是字符串 / null，这里要按「任意输入」来挡。
      const rawQty: unknown = row?.quantity
      const isBlank =
        rawQty === null ||
        rawQty === undefined ||
        (typeof rawQty === 'string' && rawQty.trim() === '')
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

    // ── 第 2 步：整表替换（清空 + 按行顺序重建） ────────────────
    const now = new Date().toISOString()
    const time = toLocalDateTime()
    const operatorText = typeof operator === 'string' ? operator.trim() : String(operator ?? '')
    const handlerText = typeof handler === 'string' ? handler.trim() : String(handler ?? '')

    const nextItems: Item[] = []
    const nextRecords: StockRecord[] = []

    for (const row of prepared) {
      const item: Item = {
        id: randomUUID(),
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
        id: randomUUID(),
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

    try {
      await commit({ version: 1, items: nextItems, records: nextRecords })
    } catch (err) {
      return { ok: false, error: `保存失败：${String(err)}` }
    }

    return {
      ok: true,
      itemCount: nextItems.length,
      recordCount: nextRecords.length,
      zeroedRows
    }
  })
}

/**
 * 重命名物品。
 *
 * 这是**唯一**会去改历史记录内容的操作，所以有几点必须写清楚：
 *
 * 1. **为什么连历史记录的 name 快照一起改。**
 *    `StockRecord.name` 原本刻意存快照（「历史记录是铁证」）。但改名是个例外：
 *    名字只是这个物品的标签，不是当时的业务事实 —— 用户把「螺丝」改成
 *    「M3×8 螺丝」之后，如果记录页还显示旧名字，他会以为那是另一个物品，
 *    三页对不上。所以改名必须三页同步。
 *
 * 2. **但记录的 `unit` 快照不动。** 单位是**当时的计量事实**：
 *    一条「12 包」的历史记录，哪怕物品后来并进了按「个」计数的物品，
 *    它也确实是 12 包。改掉它就是篡改历史，而且和记录上的数量对不上。
 *
 * 3. **撞名即合并。** 新名字已被别的物品占用时，把本物品的记录搬到目标物品名下、
 *    数量累加、然后删掉本物品。**这条路径下数量可能失去物理意义**
 *    （2 个 + 12 包 = 14 个），所以单位不一致时会在返回值里带出
 *    `unitConflict`，由界面提示用户确认/改单位 —— 数据层不替用户决定。
 *    调用方可以传 `unit` 指定合并后使用的单位；不传就沿用目标物品的。
 *
 * 合并是**不可逆**的（源物品被删掉了），所以界面必须先弹确认。
 */
export function renameItem(
  id: string,
  rawName: string,
  unit?: string
): Promise<RenameItemResult> {
  return enqueue(async () => {
    const name = normalizeName(rawName ?? '')
    if (!name) return { ok: false, error: '名称不能为空' }

    const current = await load()
    if (!current.items.some((i) => i.id === id)) {
      return { ok: false, error: '物品不存在，可能已被删除' }
    }

    const next = cloneDB(current)
    const now = new Date().toISOString()
    const src = next.items.find((i) => i.id === id) as Item

    // 名字没变：什么都不做。用户在编辑框里原样回车是正常操作，
    // 不该因此触发一次写盘 + 全窗口广播。
    if (src.name === name) {
      return { ok: true, item: { ...src }, merged: false, movedRecords: 0, renamedRecords: 0 }
    }

    const target = next.items.find((i) => i.name === name && i.id !== id)

    // ── 路径一：单纯改名 ─────────────────────────────────────
    if (!target) {
      const oldName = src.name
      src.name = name
      src.updatedAt = now

      let renamedRecords = 0
      for (const r of next.records) {
        if (r.itemId !== id) continue
        r.name = name
        renamedRecords++
      }

      try {
        await commit(next)
      } catch (err) {
        return { ok: false, error: `保存失败：${String(err)}` }
      }

      return {
        ok: true,
        item: { ...src },
        merged: false,
        mergedFrom: oldName,
        movedRecords: 0,
        renamedRecords
      }
    }

    // ── 路径二：撞名，合并进 target ──────────────────────────
    const unitConflict =
      target.unit === src.unit
        ? undefined
        : { keptUnit: target.unit, otherUnit: src.unit }

    // 界面没指定就用目标物品的单位。trim 后为空串（用户清空输入框）也回落到目标单位，
    // 与 normalizeThreshold 的兜底思路一致：不让中间态写进数据。
    const chosenUnit = (unit ?? '').trim() || target.unit

    target.quantity = roundQuantity(target.quantity + src.quantity)
    target.unit = chosenUnit
    target.updatedAt = now

    let movedRecords = 0
    for (const r of next.records) {
      if (r.itemId !== id) continue
      r.itemId = target.id
      r.name = target.name
      // r.unit 刻意保持原快照 —— 见函数头注释第 2 条
      movedRecords++
    }

    next.items = next.items.filter((i) => i.id !== id)

    try {
      await commit(next)
    } catch (err) {
      return { ok: false, error: `保存失败：${String(err)}` }
    }

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
  })
}

export { DEFAULT_THRESHOLD }
