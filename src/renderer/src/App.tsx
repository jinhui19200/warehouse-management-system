import { useEffect, useState } from 'react'
import { useAppData } from './hooks/useAppData'
import { OperationPage } from './pages/OperationPage'
import { RecordsPage } from './pages/RecordsPage'
import { ReportsPage } from './pages/ReportsPage'
import { WarehousePage } from './pages/WarehousePage'

type TabKey = 'warehouse' | 'records' | 'reports' | 'operation'

// 报表放在「操作」之前：操作是录入口，习惯上留在最右边
const TABS: { key: TabKey; label: string }[] = [
  { key: 'warehouse', label: '仓库' },
  { key: 'records', label: '记录' },
  { key: 'reports', label: '报表' },
  { key: 'operation', label: '操作' }
]

export default function App() {
  const [tab, setTab] = useState<TabKey>('warehouse')
  const [bridge, setBridge] = useState('通道检测中…')
  const [folderMsg, setFolderMsg] = useState('')

  const {
    db,
    ready,
    error,
    recoveredFromBackup,
    dataPath,
    applyTransaction,
    deleteRecord,
    setItemThreshold,
    setItemQuantity,
    setItemNote,
    setItemUnit,
    deleteItem,
    reorderItems,
    importTable,
    renameItem,
    exportXlsx,
    openDataFolder
  } = useAppData()

  useEffect(() => {
    Promise.resolve()
      .then(() => window.api.ping())
      .then((r) => setBridge(`主进程通道正常（返回 ${r}）`))
      .catch(() => setBridge('未检测到主进程通道（当前非 Electron 环境）'))
  }, [])

  const handleOpenFolder = async (): Promise<void> => {
    setFolderMsg('')
    try {
      const r = await openDataFolder()
      if (!r.ok) setFolderMsg(r.error ?? '打开失败')
    } catch (err) {
      setFolderMsg(String(err))
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>库存管理系统</h1>
        <span className="bridge-status">
          {error ? `数据读取异常：${error}` : bridge}
        </span>
        <span className="header-spacer" />
        {folderMsg && <span className="header-msg">{folderMsg}</span>}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void handleOpenFolder()}
          title={dataPath ? `数据文件：${dataPath}` : '打开数据文件所在文件夹'}
        >
          打开数据文件夹
        </button>
      </header>

      {recoveredFromBackup && (
        <div className="warn-banner">
          <strong>已从备份恢复。</strong>
          上次运行时有数据文件损坏，程序自动读取了备份，可能丢失最后一次操作。
          建议现在核对一下数据。
        </div>
      )}

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={t.key === tab ? 'tab tab-active' : 'tab'}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="content">
        {!ready && <p className="loading">正在读取数据…</p>}
        {ready && tab === 'warehouse' && (
          <WarehousePage
            items={db.items}
            records={db.records}
            applyTransaction={applyTransaction}
            setItemThreshold={setItemThreshold}
            setItemQuantity={setItemQuantity}
            setItemNote={setItemNote}
            setItemUnit={setItemUnit}
            deleteItem={deleteItem}
            reorderItems={reorderItems}
            importTable={importTable}
            renameItem={renameItem}
            exportXlsx={exportXlsx}
          />
        )}
        {ready && tab === 'records' && (
          <RecordsPage
            items={db.items}
            records={db.records}
            deleteRecord={deleteRecord}
            renameItem={renameItem}
            exportXlsx={exportXlsx}
          />
        )}
        {ready && tab === 'reports' && <ReportsPage items={db.items} records={db.records} />}
        {ready && tab === 'operation' && (
          <OperationPage
            items={db.items}
            records={db.records}
            applyTransaction={applyTransaction}
          />
        )}
      </main>
    </div>
  )
}
