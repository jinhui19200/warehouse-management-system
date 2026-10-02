import { useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import type { DeleteRecordResult, Item, RenameItemResult, StockRecord } from '@shared/types'
import { displayDateTime, formatQuantity, HANDLER_COLUMN, handlerLabel } from '@shared/utils'
import { NameCell, useRenameFlow } from '../components/RenameName'
import { usePasswordFlow } from '../components/PasswordDialog'

interface Props {
  items: Item[]
  records: StockRecord[]
  deleteRecord: (id: string, password: string) => Promise<DeleteRecordResult>
  renameItem: (id: string, name: string, unit?: string) => Promise<RenameItemResult>
  exportXlsx: (data: number[], defaultName: string) => Promise<{
    ok: boolean
    path?: string
    cancelled?: boolean
    error?: string
  }>
}

export function RecordsPage({
  items,
  records,
  deleteRecord,
  renameItem,
  exportXlsx
}: Props): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState<'all' | 'in' | 'out'>('all')
  /** 时间范围，格式 'YYYY-MM-DD'；空串表示该端不限制。两端都是闭区间，含当日 */
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [exporting, setExporting] = useState(false)

  const rename = useRenameFlow(items, records, renameItem)
  const password = usePasswordFlow()

  /** 按 id 反查物品 —— 记录页改的是**物品**，不是这一条记录 */
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])

  const rangeInvalid = Boolean(dateFrom && dateTo && dateFrom > dateTo)

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    let list = [...records]
    if (term) {
      list = list.filter((r) => r.name.toLowerCase().includes(term))
    }
    if (filterType !== 'all') {
      list = list.filter((r) => r.type === filterType)
    }
    if (dateFrom || dateTo) {
      list = list.filter((r) => {
        // time 是 'YYYY-MM-DDTHH:mm'，取前 10 位即业务日期。
        // 按「日期字符串」而不是「时刻」比较，等于天然含当日 ——
        // 截止日当天 23:59 的记录也会被保留。
        const day = r.time.slice(0, 10)
        if (dateFrom && day < dateFrom) return false
        if (dateTo && day > dateTo) return false
        return true
      })
    }
    // 按业务时间倒序，同一时间用写入时间兜底
    list.sort((a, b) => {
      const byTime = b.time.localeCompare(a.time)
      return byTime !== 0 ? byTime : b.createdAt.localeCompare(a.createdAt)
    })
    return list
  }, [records, search, filterType, dateFrom, dateTo])

  const filterActive = Boolean(search.trim() || filterType !== 'all' || dateFrom || dateTo)

  /**
   * 撤销一条记录（需口令）。
   *
   * 口令框里把「这条记录是谁的、货交给了谁」都写出来 —— 原来是靠一个
   * `window.confirm` 做二次确认，现在**合并成一步**：既确认又输口令，
   * 比「先确认、再输口令」少一次交互，信息一行都没少。
   *
   * 撤销会反向冲销库存且不可逆（没有「重做」），所以从 2026-10-02 起要口令。
   */
  const handleDelete = (record: StockRecord): void => {
    const lines = [
      `${displayDateTime(record.time)}  ${record.name}  ${record.type === 'in' ? '入库' : '出库'} ${formatQuantity(record.quantity)} ${record.unit}`
    ]
    if (record.operator) lines.push(`操作人：${record.operator}`)
    if (record.handler) lines.push(`${handlerLabel(record.type)}：${record.handler}`)

    password.request({
      title: '撤销这条记录？',
      message: `${lines.join('\n')}\n\n撤销会反向冲销它对库存的影响，不可恢复。`,
      confirmLabel: '撤销',
      danger: true,
      onConfirm: (pwd) => {
        void deleteRecord(record.id, pwd).then((result) => {
          if (!result.ok) {
            // 口令错时口令框自己已经提示过了，别在这儿再弹一个
            if (!result.wrongPassword) {
              // eslint-disable-next-line no-alert
              alert(`撤销失败：${result.error}`)
            }
            return
          }
          if (result.warning) {
            // eslint-disable-next-line no-alert
            alert(result.warning)
          }
        })
      }
    })
  }

  const handleExport = async (): Promise<void> => {
    setExporting(true)
    try {
      const wb = XLSX.utils.book_new()
      // 导出当前筛选结果 —— 界面上看到几条就导出几条，避免「筛完再导出却拿到全量」
      const data = filtered.map((r) => ({
        时间: displayDateTime(r.time),
        名称: r.name,
        数量: r.quantity,
        单位: r.unit,
        /*
         * 备注取自**物品当前**的值，不是这条记录的历史快照。
         *
         * 这是刻意的：备注属于「这个物品」（Item.note），不属于某一次出入库，
         * StockRecord 根本没有备注字段。所以记录页这一列会**跟着物品变** ——
         * 你今天改了备注，去年的记录旁边显示的也是新的。
         * 想看「当时的状态」请看出入库记录本身，别指望备注。
         */
        备注: itemById.get(r.itemId)?.note || '',
        操作人: r.operator || '—',
        [HANDLER_COLUMN]: r.handler || '—',
        类型: r.type === 'in' ? '入库' : '出库'
      }))
      const ws = XLSX.utils.json_to_sheet(data)
      XLSX.utils.book_append_sheet(wb, ws, '出入库记录')
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
      const result = await exportXlsx(Array.from(new Uint8Array(buf)), '出入库记录.xlsx')
      if (result.ok && result.path) {
        // eslint-disable-next-line no-alert
        alert(`已导出到：${result.path}`)
      } else if (!result.cancelled) {
        // eslint-disable-next-line no-alert
        alert(`导出失败：${result.error || '未知错误'}`)
      }
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(`导出异常：${String(err)}`)
    } finally {
      setExporting(false)
    }
  }

  return (
    <section className="card">
      <div className="card-header">
        <h2>
          记录
          <span className="count">
            {filterActive
              ? `筛选出 ${filtered.length} / 共 ${records.length} 条`
              : `${filtered.length} 条`}
          </span>
        </h2>
        <div className="card-toolbar">
          <input
            type="text"
            className="search-input"
            placeholder="搜索物品名称…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="date-range">
            <input
              type="date"
              className="date-input"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(e) => setDateFrom(e.target.value)}
              title="起始日期（含当日）"
              aria-label="起始日期"
            />
            <span className="date-sep">～</span>
            <input
              type="date"
              className="date-input"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => setDateTo(e.target.value)}
              title="截止日期（含当日）"
              aria-label="截止日期"
            />
            {(dateFrom || dateTo) && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                title="清除时间范围"
                onClick={() => {
                  setDateFrom('')
                  setDateTo('')
                }}
              >
                清除
              </button>
            )}
          </div>
          <div className="filter-group">
            {(
              [
                { key: 'all', label: '全部' },
                { key: 'in', label: '入库' },
                { key: 'out', label: '出库' }
              ] as const
            ).map((f) => (
              <button
                key={f.key}
                type="button"
                className={filterType === f.key ? 'btn btn-sm btn-active' : 'btn btn-sm'}
                onClick={() => setFilterType(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleExport}
            disabled={exporting || filtered.length === 0}
            title={filterActive ? `导出当前筛选出的 ${filtered.length} 条` : '导出全部记录'}
          >
            {exporting ? '导出中…' : filterActive ? `导出 Excel（${filtered.length} 条）` : '导出 Excel'}
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="empty">
          {rangeInvalid ? '起始日期晚于截止日期，请调整时间范围。' : '没有匹配的记录。'}
        </p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>时间</th>
              <th title="双击或右键名称可以改名">名称</th>
              <th className="num">数量</th>
              <th>单位</th>
              {/* 备注是**物品**的属性（记录本身没有备注字段），见 handleExport 里的说明 */}
              <th title="这个物品当前的备注（不是本条记录的历史快照）">备注</th>
              <th>操作人</th>
              <th>{HANDLER_COLUMN}</th>
              <th>类型</th>
              <th style={{ width: 1 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((record) => (
              <tr key={record.id}>
                <td className="mono">{displayDateTime(record.time)}</td>
                <td>
                  {/*
                    改的是**物品**的名字，不是这一条记录 —— 记录里的 name 只是
                    这个物品的标签快照，单独改一条会让它和所属物品对不上。
                    找不到对应物品（数据异常）时退化成纯文本，不给编辑入口。
                  */}
                  {itemById.has(record.itemId) ? (
                    <NameCell
                      name={record.name}
                      onRename={(next) =>
                        rename.request(itemById.get(record.itemId) as Item, next)
                      }
                    />
                  ) : (
                    record.name
                  )}
                </td>
                <td className="num">{formatQuantity(record.quantity)}</td>
                <td>{record.unit}</td>
                <td className="note-cell">
                  {/*
                    同样是**物品当前**的备注。物品已被删除（数据异常）时显示「—」，
                    不给编辑入口 —— 记录页改的是物品，物品都没了就没得改。
                  */}
                  <span
                    className={
                      itemById.get(record.itemId)?.note
                        ? 'editable-text'
                        : 'editable-text editable-empty'
                    }
                    style={{ cursor: 'default' }}
                  >
                    {itemById.get(record.itemId)?.note || '—'}
                  </span>
                </td>
                <td
                  className="mono"
                  style={{ color: record.operator ? undefined : 'var(--text-faint)' }}
                >
                  {record.operator || '—'}
                </td>
                <td
                  className="mono"
                  style={{ color: record.handler ? undefined : 'var(--text-faint)' }}
                  title={record.handler ? `${handlerLabel(record.type)}` : undefined}
                >
                  {record.handler || '—'}
                </td>
                <td>
                  <span className={record.type === 'in' ? 'tag tag-in' : 'tag tag-out'}>
                    {record.type === 'in' ? '入库' : '出库'}
                  </span>
                </td>
                <td>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => handleDelete(record)}
                  >
                    撤销
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {rename.dialog}
      {password.dialog}
    </section>
  )
}
