import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import type { TransactionInput } from '@shared/types'
import { getDataDir, getDataFilePath, getLoadReport, getSnapshot } from './store/db'
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
} from './store/transactions'

/**
 * 数据变更后广播给所有窗口。
 * 三个页面都订阅这个事件，因此「任一入口提交 → 所有页面更新」是天然成立的，
 * 不需要任何一处手动去刷新另一处。
 */
function broadcastChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('db:changed')
  }
}

export function registerIpcHandlers(): void {
  ipcMain.handle('app:ping', () => 'pong')

  /** 读取当前快照（纯内存，不碰磁盘） */
  ipcMain.handle('db:snapshot', () => getSnapshot())

  /** 本次启动是否发生过「从备份恢复」，界面据此提示用户 */
  ipcMain.handle('db:loadReport', () => getLoadReport())

  /** 数据文件路径，界面上显示给用户看 */
  ipcMain.handle('app:dataPath', () => getDataFilePath())

  /** 在系统文件管理器里打开数据文件所在目录 */
  ipcMain.handle('app:openDataFolder', async () => {
    const dir = getDataDir()
    const err = await shell.openPath(dir)
    return err ? { ok: false, error: err } : { ok: true, path: dir }
  })

  /** 出库 / 入库 —— 三个页面共用这一个通道 */
  ipcMain.handle('db:transaction', async (_event, input: TransactionInput) => {
    const result = await applyTransaction(input)
    if (result.ok) broadcastChanged()
    return result
  })

  /** 撤销记录（会反向冲销库存） */
  ipcMain.handle('db:deleteRecord', async (_event, id: string) => {
    const result = await deleteRecord(id)
    if (result.ok) broadcastChanged()
    return result
  })

  /** 修改物品警戒值 */
  ipcMain.handle('db:setThreshold', async (_event, id: string, threshold: number) => {
    const result = await setItemThreshold(id, threshold)
    if (result.ok) broadcastChanged()
    return result
  })

  /**
   * 强行修改库存数量（需口令）。
   *
   * 口令的校验点在数据层，不在这个 handler 里 —— 界面上的口令框只是交互，
   * 绕过它直接 invoke 本通道必须同样被拒。这里只负责「成功才广播」。
   */
  ipcMain.handle(
    'db:setQuantity',
    async (_event, id: string, quantity: number, password: string) => {
      const result = await setItemQuantity(id, quantity, password)
      if (result.ok) broadcastChanged()
      return result
    }
  )

  /**
   * 修改物品备注。
   *
   * 与 setThreshold / setQuantity 一样不写流水，
   * 所以成功后必须广播 —— 三页都靠这个事件重新拉取快照。
   */
  ipcMain.handle('db:setNote', async (_event, id: string, note: string) => {
    const result = await setItemNote(id, note)
    if (result.ok) broadcastChanged()
    return result
  })

  /** 修改物品单位（同样不写流水，成功才广播） */
  ipcMain.handle('db:setUnit', async (_event, id: string, unit: string) => {
    const result = await setItemUnit(id, unit)
    if (result.ok) broadcastChanged()
    return result
  })

  /**
   * 删除整个物品（需口令）。
   *
   * 口令的校验点在数据层，不在这个 handler 里 —— 界面上的口令框只是交互，
   * 绕过它直接 invoke 本通道必须同样被拒。
   */
  ipcMain.handle('db:deleteItem', async (_event, id: string, password: string) => {
    const result = await deleteItem(id, password)
    if (result.ok) broadcastChanged()
    return result
  })

  /**
   * 拖动改顺序。**不校验口令**（理由见 reorderItems 的注释），
   * 但它会重排 items 数组 —— 顺序变了，三页都得跟着变，所以也要广播。
   */
  ipcMain.handle('db:reorderItems', async (_event, orderedIds: string[]) => {
    const result = await reorderItems(orderedIds)
    if (result.ok) broadcastChanged()
    return result
  })

  /**
   * 导入表格（需口令，**会清空现有全部数据**）。
   *
   * 成功后必须广播：这是一次整体替换，三页手里的数据全部作废。
   */
  ipcMain.handle(
    'db:importTable',
    async (
      _event,
      password: string,
      rows: Parameters<typeof importTable>[1],
      operator: string,
      handler: string
    ) => {
      const result = await importTable(password, rows, operator, handler)
      if (result.ok) broadcastChanged()
      return result
    }
  )

  /**
   * 重命名物品（撞名时合并）。
   *
   * 改名会同时改动该物品名下所有历史记录的 name 快照，并可能删掉一个物品，
   * 所以成功后必须广播 —— 仓库、记录、报表三页都靠这个事件重新拉取快照。
   */
  ipcMain.handle(
    'db:renameItem',
    async (_event, id: string, name: string, unit?: string) => {
      const result = await renameItem(id, name, unit)
      if (result.ok) broadcastChanged()
      return result
    }
  )

  /** 导出 Excel：渲染进程生成 buffer，主进程弹 dialog 保存 */
  ipcMain.handle('export:xlsx', async (_event, data: number[], defaultName: string) => {
    const { filePath } = await dialog.showSaveDialog({
      defaultPath: defaultName,
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
    })
    if (!filePath) return { ok: false, cancelled: true }
    try {
      await writeFile(filePath, Buffer.from(data))
      return { ok: true, path: filePath }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })
}
