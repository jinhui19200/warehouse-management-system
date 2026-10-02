/** 出入库方向 */
export type TransactionType = 'in' | 'out'

/** 物品（库存台账的一行） */
export interface Item {
  id: string
  /** 归一化后的名称（去首尾空格、内部连续空格压成一个） */
  name: string
  /** 单位。物品创建后由数据层锁定，不随出入库变动 */
  unit: string
  /** 当前库存。允许为负（出库超过库存时只警告不阻断） */
  quantity: number
  /**
   * 库存警戒值。当前库存**低于**它时，仓库页把数量标成浅红。
   * 默认 {@link DEFAULT_THRESHOLD}（100）；旧数据文件没有这个字段，
   * 加载时由数据层补齐，不需要用户手动迁移。
   */
  threshold: number
  /**
   * 物品备注（自由文本）。空串表示未填。
   *
   * v1.6.0 引入。旧数据文件没这个字段，加载时补成空串。
   * 与 StockRecord **不同**：StockRecord 没有备注字段，
   * 备注属于「这个物品」而不是「某一次出入库」。
   */
  note?: string
  createdAt: string
  updatedAt: string
}

/** 一条出入库流水。name / unit 存的是**快照**，历史记录不受物品当前状态影响 */
export interface StockRecord {
  id: string
  itemId: string
  /** 用户填写的业务时间，格式 `YYYY-MM-DDTHH:mm`（本地时间，不带时区） */
  time: string
  /** 名称快照 */
  name: string
  /** 单位快照 */
  unit: string
  /** 数量，恒为正数，方向由 type 决定 */
  quantity: number
  type: TransactionType
  /** 操作人快照（选填）。空串表示未填 */
  operator: string
  /**
   * 货品交接人快照（选填）。空串表示未填。
   *
   * 语义随 type 变化：入库是**经手人**（货交到谁手上），出库是**领取人**（货被谁领走）。
   * 两种角色不会同时出现在一条记录上，所以存**同一个字段**而不是两个 ——
   * 两个字段必然一个恒为空，查询、导出、断言都要处处判断「该看哪个」。
   * 界面按 type 决定标签文案，数据层不关心。
   *
   * 与 {@link operator} 并存：操作人是「谁在系统里录的账」，
   * 本字段是「货实际交给了谁」，二者可以是同一个人，也可以不是。
   */
  handler: string
  /** 机器写入时间（ISO），用于审计与排序兜底 */
  createdAt: string
}

export interface DB {
  version: 1
  items: Item[]
  records: StockRecord[]
}

/** 出入库请求参数 */
export interface TransactionInput {
  time: string
  name: string
  quantity: number
  /**
   * 单位。**仅在新物品首次创建时生效**；
   * 物品已存在时数据层会忽略此值，强制使用 item.unit。
   */
  unit?: string
  /** 操作人（选填） */
  operator?: string
  /**
   * 货品交接人（选填）。入库填「经手人」、出库填「领取人」，
   * 界面按 type 决定标签，数据层原样存快照。
   */
  handler?: string
  type: TransactionType
}

export type TransactionResult =
  | {
      ok: true
      item: Item
      record: StockRecord
      /** 非致命提示，例如「库存已为负」 */
      warning?: string
    }
  | { ok: false; error: string }

export type DeleteRecordResult =
  | { ok: true; removed: StockRecord; item: Item | null; warning?: string }
  | { ok: false; error: string }

/** 修改物品警戒值 */
export type SetThresholdResult = { ok: true; item: Item } | { ok: false; error: string }

/**
 * 强行修改库存数量的结果。
 *
 * `wrongPassword` 单独标出来，是为了让界面能区分「口令不对」和「数量非法」：
 * 前者要把用户退回口令那一步、并清空输入，后者只需在数量框上报错。
 * 只给一个 error 字符串的话，界面就得去匹配文案，改一个字就失配。
 */
export type SetQuantityResult =
  | { ok: true; item: Item }
  | { ok: false; error: string; wrongPassword?: boolean }

/**
 * 重命名物品的结果。
 *
 * 「改名」有两种落法，用 {@link merged} 区分：
 *  - 新名字没人用 → 单纯改名，物品本身 + 它名下所有历史记录的 `name` 快照一起改
 *  - 新名字已被别的物品占用 → **合并**：记录搬到目标物品名下、数量累加、源物品删除
 */
export type RenameItemResult =
  | {
      ok: true
      /** 改名后的物品；发生合并时是**保留下来的那一个**（目标物品） */
      item: Item
      /** 是否发生了「与已有物品同名」的合并 */
      merged: boolean
      /** 被合并掉的物品名（等于新名字）。未合并时为 undefined */
      mergedFrom?: string
      /** 合并时搬运到目标物品名下的记录条数 */
      movedRecords: number
      /** 单纯改名时，跟着一起改了名字快照的记录条数 */
      renamedRecords: number
      /**
       * 合并时两边单位不一致。界面据此提示用户改单位。
       *
       * `keptUnit` 是目标物品（保留下来的那个）原本的单位，
       * `otherUnit` 是被并掉的那个物品的单位。
       */
      unitConflict?: { keptUnit: string; otherUnit: string }
      /** 非致命提示，例如合并后库存为负 */
      warning?: string
    }
  | { ok: false; error: string }

/**
 * 表格导入的一行。来源是用户在导入对话框里选择的 xlsx/csv 文件，
 * 数据层会校验每一行（名称、单位、数量必填，数量必须为有限数）。
 */
export interface ImportRow {
  name: string
  unit: string
  quantity: number
  note?: string
}

/** 导入表格的结果 */
export type ImportResult =
  | { ok: true; itemCount: number; recordCount: number }
  | { ok: false; error: string; wrongPassword?: boolean; rowIndex?: number }

/** 修改物品备注 */
export type SetNoteResult = { ok: true; item: Item } | { ok: false; error: string }

/** 修改物品单位 */
export type SetUnitResult = { ok: true; item: Item } | { ok: false; error: string }

/**
 * 删除整个物品的结果。
 *
 * `itemCount` / `recordCount` 是被清掉的统计 —— 哪怕接口失败也写下来，
 * 方便排查「我想删 1 个物品，但实际删了 8 条记录」之类的情况。
 */
export type DeleteItemResult =
  | { ok: true; itemCount: number; recordCount: number }
  | { ok: false; error: string; wrongPassword?: boolean }

/**
 * 重新排列 items 顺序的结果。
 *
 * 拖动改顺序是一个交互体验，不强制密码 —— 否则每拖一次都要求口令，
 * 体验就毁了。这条路径下数据本身没被修改，只是展示顺序变了。
 */
export type ReorderItemsResult =
  | { ok: true; items: Item[] }
  | { ok: false; error: string }
