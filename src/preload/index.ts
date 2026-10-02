import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  DB,
  DeleteItemResult,
  DeleteRecordResult,
  ImportResult,
  ImportRow,
  RenameItemResult,
  ReorderItemsResult,
  SetNoteResult,
  SetQuantityResult,
  SetThresholdResult,
  SetUnitResult,
  TransactionInput,
  TransactionResult
} from '@shared/types'

/**
 * 数据变更订阅表。
 *
 * 这里刻意用「订阅号 + 取消订阅号」而不是「返回一个取消订阅函数」：
 * contextBridge 每次跨进程传函数都会包一层新的代理，
 * 同一个回调传回来时已经不是同一个引用了，没法用来删除。
 * 用数字做键则完全绕开这个问题。
 */
let nextSubscriberId = 0
const changeSubscribers = new Map<number, () => void>()

ipcRenderer.on('db:changed', () => {
  for (const callback of changeSubscribers.values()) callback()
})

const api = {
  /** 连通性自检 */
  ping: (): Promise<string> => ipcRenderer.invoke('app:ping'),

  /** 读取当前数据快照（物品 + 记录） */
  getSnapshot: (): Promise<DB> => ipcRenderer.invoke('db:snapshot'),

  /** 本次启动是否发生过「从备份恢复」 */
  getLoadReport: (): Promise<{ recoveredFromBackup: boolean }> =>
    ipcRenderer.invoke('db:loadReport'),

  /** 数据文件完整路径 */
  getDataPath: (): Promise<string> => ipcRenderer.invoke('app:dataPath'),

  /** 在系统文件管理器里打开数据文件所在目录 */
  openDataFolder: (): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('app:openDataFolder'),

  /** 出库 / 入库 —— 三个页面共用这一个入口 */
  applyTransaction: (input: TransactionInput): Promise<TransactionResult> =>
    ipcRenderer.invoke('db:transaction', input),

  /** 撤销记录（会反向冲销库存） */
  deleteRecord: (id: string): Promise<DeleteRecordResult> =>
    ipcRenderer.invoke('db:deleteRecord', id),

  /** 修改物品警戒值 */
  setItemThreshold: (id: string, threshold: number): Promise<SetThresholdResult> =>
    ipcRenderer.invoke('db:setThreshold', id, threshold),

  /**
   * 强行修改库存数量。`password` 会原样送到数据层校验 ——
   * 界面上那道口令框只是交互，这里才是必经之路。
   */
  setItemQuantity: (id: string, quantity: number, password: string): Promise<SetQuantityResult> =>
    ipcRenderer.invoke('db:setQuantity', id, quantity, password),

  /** 删除整个物品及其名下所有记录（需口令，校验在数据层） */
  deleteItem: (id: string, password: string): Promise<DeleteItemResult> =>
    ipcRenderer.invoke('db:deleteItem', id, password),

  /** 拖动改顺序。不需要口令，但它重排的是 items 数组本身 */
  reorderItems: (orderedIds: string[]): Promise<ReorderItemsResult> =>
    ipcRenderer.invoke('db:reorderItems', orderedIds),

  /** 修改物品备注。允许传空串（= 清空备注） */
  setItemNote: (id: string, note: string): Promise<SetNoteResult> =>
    ipcRenderer.invoke('db:setNote', id, note),

  /** 修改物品单位。空串会被数据层拒绝 */
  setItemUnit: (id: string, unit: string): Promise<SetUnitResult> =>
    ipcRenderer.invoke('db:setUnit', id, unit),

  /**
   * 导入表格（需口令，**会清空现有全部数据**）。
   * `rows` 按表格行顺序传入，导入后物品顺序与之一致。
   */
  importTable: (
    password: string,
    rows: ImportRow[],
    operator: string,
    handler: string
  ): Promise<ImportResult> =>
    ipcRenderer.invoke('db:importTable', password, rows, operator, handler),

  /**
   * 重命名物品。撞名时会与已有物品**合并**，可用 `unit` 指定合并后使用的单位；
   * 不传则沿用目标物品的单位。
   */
  renameItem: (id: string, name: string, unit?: string): Promise<RenameItemResult> =>
    ipcRenderer.invoke('db:renameItem', id, name, unit),

  /** 导出 Excel */
  exportXlsx: (data: number[], defaultName: string): Promise<{
    ok: boolean
    path?: string
    cancelled?: boolean
    error?: string
  }> => ipcRenderer.invoke('export:xlsx', data, defaultName),

  /** 订阅数据变更，返回订阅号 */
  onChanged: (callback: () => void): number => {
    const id = ++nextSubscriberId
    changeSubscribers.set(id, callback)
    return id
  },

  /** 取消订阅 */
  offChanged: (id: number): void => {
    changeSubscribers.delete(id)
  }
}

export type Api = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore 类型定义见 index.d.ts
  window.electron = electronAPI
  // @ts-ignore 类型定义见 index.d.ts
  window.api = api
}
