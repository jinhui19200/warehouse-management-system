import { useCallback, useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import type {
  DeleteItemResult,
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
  computeMonthlyTotals,
  currentMonth,
  DEFAULT_THRESHOLD,
  formatQuantity,
  isBelowThreshold,
  matchesItemQuery,
  pinMatches
} from '@shared/utils'
import { TransactionForm } from '../components/TransactionForm'
import { NameCell, useRenameFlow } from '../components/RenameName'
import { QuantityCell, useQuantityFlow } from '../components/QuantityCell'
import { EditableCell } from '../components/ItemCells'
import { ImportDialog } from '../components/ImportDialog'
import { usePasswordFlow } from '../components/PasswordDialog'

interface Props {
  items: Item[]
  records: StockRecord[]
  applyTransaction: (input: TransactionInput) => Promise<TransactionResult>
  setItemThreshold: (id: string, threshold: number) => Promise<SetThresholdResult>
  setItemQuantity: (id: string, quantity: number, password: string) => Promise<SetQuantityResult>
  setItemNote: (id: string, note: string) => Promise<SetNoteResult>
  setItemUnit: (id: string, unit: string) => Promise<SetUnitResult>
  deleteItem: (id: string, password: string) => Promise<DeleteItemResult>
  reorderItems: (orderedIds: string[]) => Promise<ReorderItemsResult>
  importTable: (
    password: string,
    rows: ImportRow[],
    operator: string,
    handler: string
  ) => Promise<ImportResult>
  renameItem: (id: string, name: string, unit?: string) => Promise<RenameItemResult>
  exportXlsx: (data: number[], defaultName: string) => Promise<{
    ok: boolean
    path?: string
    cancelled?: boolean
    error?: string
  }>
}

/**
 * 警戒值输入框。
 *
 * 刻意做成**非受控式提交**（输入时不落盘，失焦或回车才提交）：
 * 如果每敲一个字符就写一次盘，输入「1000」会触发 4 次原子写 + 4 次全窗口广播，
 * 而且中途的「1」「10」「100」都会被当成合法警戒值短暂生效，界面会闪。
 */
function ThresholdInput({
  item,
  onCommit
}: {
  item: Item
  onCommit: (value: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(item.threshold))

  // 数据层归一化后的值回来了（例如清空输入被兜回 100），把草稿同步成真实值，
  // 否则输入框会一直显示用户敲的那个非法内容，和实际生效的值对不上。
  useEffect(() => {
    setDraft(String(item.threshold))
  }, [item.threshold])

  const commit = (): void => {
    const parsed = Number(draft)
    const value = draft.trim() === '' || !Number.isFinite(parsed) || parsed < 0 ? NaN : parsed
    // 非法输入（清空 / 负数 / 溢出）一律**回退到上一次生效的值**，不提交。
    // 刻意不做「清空 = 恢复默认 100」：用户清空输入框多半是想取消这次修改，
    // 静默替他改成 100 是越权改数据。数据层仍保留 100 兜底，防的是绕过界面直接调 IPC。
    if (Number.isNaN(value)) {
      setDraft(String(item.threshold))
      return
    }
    if (value === item.threshold) {
      setDraft(String(value))
      return
    }
    onCommit(value)
  }

  return (
    <input
      type="number"
      className="threshold-input"
      min={0}
      step={1}
      value={draft}
      aria-label={`${item.name} 的警戒值`}
      title={`库存低于这个数时标红（默认 ${DEFAULT_THRESHOLD}）`}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur() // 交给 onBlur 统一提交，避免两条提交路径
        } else if (e.key === 'Escape') {
          setDraft(String(item.threshold))
          e.currentTarget.blur()
        }
      }}
    />
  )
}

export function WarehousePage({
  items,
  records,
  applyTransaction,
  setItemThreshold,
  setItemQuantity,
  setItemNote,
  setItemUnit,
  deleteItem,
  reorderItems,
  importTable,
  renameItem,
  exportXlsx
}: Props): React.JSX.Element {
  const [modalType, setModalType] = useState<'in' | 'out' | null>(null)
  const [modalName, setModalName] = useState('')
  const [query, setQuery] = useState('')
  const [exporting, setExporting] = useState(false)
  /** 只看低于警戒值的物品（表头「警戒值」旁的小方框） */
  const [lowOnly, setLowOnly] = useState(false)
  /** 正在被拖动的物品 id（拖动柄按下时设置，放下或取消时清空） */
  const [dragId, setDragId] = useState<string | null>(null)
  /** 当前悬停的放置目标，用来画一条插入提示线 */
  const [overId, setOverId] = useState<string | null>(null)
  /** 导入流程：口令通过后才有值，非空即打开导入对话框 */
  const [importPassword, setImportPassword] = useState<string | null>(null)

  const rename = useRenameFlow(items, records, renameItem)
  const quantity = useQuantityFlow(items, setItemQuantity)
  const password = usePasswordFlow()

  const month = currentMonth()
  const monthLabel = `${Number(month.slice(5))}月`
  const totals = useMemo(() => computeMonthlyTotals(records, month), [records, month])

  const belowCount = useMemo(
    () => items.filter((i) => isBelowThreshold(i.quantity, i.threshold)).length,
    [items]
  )

  const searchActive = query.trim() !== ''

  /**
   * 搜索命中的物品**排到最前面**，其余保持原有顺序跟在后面。
   *
   * 刻意不隐藏未命中的行：仓库页是全量台账，用户搜「螺丝」时往往还要
   * 顺手核对旁边的库存；把其余行藏起来，就得反复清空搜索框才能看全。
   */
  const searched = useMemo(() => pinMatches(items, (i) => i.name, query), [items, query])

  /**
   * 「只看低于警戒值」的过滤。
   *
   * 刻意做成**过滤**而不是「把低库存的排到前面」：这个勾选的用途是
   * 「今天要补货，把该补的列出来」，不是「调整排序」。
   * 排到前面的话，还得自己去数哪几行是红的。
   */
  const displayed = useMemo(
    () => (lowOnly ? searched.filter((i) => isBelowThreshold(i.quantity, i.threshold)) : searched),
    [searched, lowOnly]
  )

  /** 命中的物品 id，用来给这些行加一层底色 —— 光靠「排到前面」看不出哪几行是命中的 */
  const matchedIds = useMemo(
    () => new Set(items.filter((i) => matchesItemQuery(i.name, query)).map((i) => i.id)),
    [items, query]
  )

  const openModal = (type: 'in' | 'out', name: string): void => {
    setModalType(type)
    setModalName(name)
  }

  const closeModal = (): void => {
    setModalType(null)
    setModalName('')
  }

  const handleThreshold = (item: Item, value: number): void => {
    void setItemThreshold(item.id, value).then((r) => {
      if (!r.ok) {
        // eslint-disable-next-line no-alert
        alert(`警戒值保存失败：${r.error}`)
      }
    })
  }

  const handleNote = (item: Item, note: string): void => {
    void setItemNote(item.id, note).then((r) => {
      if (!r.ok) {
        // eslint-disable-next-line no-alert
        alert(`备注保存失败：${r.error}`)
      }
    })
  }

  const handleUnit = (item: Item, unit: string): void => {
    void setItemUnit(item.id, unit).then((r) => {
      if (!r.ok) {
        // eslint-disable-next-line no-alert
        alert(`单位保存失败：${r.error}`)
      }
    })
  }

  /**
   * 删除整个物品。
   *
   * 删之前必须让用户看到**连带会删掉多少条记录** —— 「删除物品」四个字
   * 听起来只删一行，实际会把它名下的历史记录一起清掉。
   */
  const handleDelete = (item: Item): void => {
    const recordCount = records.filter((r) => r.itemId === item.id).length
    password.request({
      title: '删除物品',
      message:
        `将删除「${item.name}」及其名下 ${recordCount} 条出入库记录。` +
        '此操作不可撤销（不像记录页的「撤销」还能反向冲销）。',
      confirmLabel: '删除',
      danger: true,
      onConfirm: (pwd) => {
        void deleteItem(item.id, pwd).then((r) => {
          if (!r.ok) {
            // eslint-disable-next-line no-alert
            alert(`删除失败：${r.error}`)
            return
          }
          // eslint-disable-next-line no-alert
          alert(`已删除「${item.name}」，连带 ${r.recordCount} 条记录`)
        })
      }
    })
  }

  /**
   * 拖动放置：把 dragId 那一行插到 targetId 所在的位置。
   *
   * 用的是**当前显示的顺序**（`displayed`），也就是「你看到什么顺序，
   * 拖完就是什么顺序」。这一点在搜索状态下尤其重要 ——
   * 若按原始数组算，用户拖完会发现和屏幕上看到的对不上。
   *
   * 勾选了「只看低于警戒值」时拖柄是禁用的（见 tbody 里的说明），
   * 所以这里拿到的 `displayed` 一定是全量，可以直接交给 reorderItems。
   */
  const handleDrop = useCallback(
    (targetId: string): void => {
      const from = dragId
      setDragId(null)
      setOverId(null)
      if (!from || from === targetId) return

      const ids = displayed.map((i) => i.id)
      const fromIdx = ids.indexOf(from)
      const toIdx = ids.indexOf(targetId)
      if (fromIdx < 0 || toIdx < 0) return

      ids.splice(toIdx, 0, ids.splice(fromIdx, 1)[0])

      void reorderItems(ids).then((r) => {
        if (!r.ok) {
          // 这里失败几乎都是「物品刚被另一个窗口删/加过」，提示里要给出路
          // eslint-disable-next-line no-alert
          alert(`顺序保存失败：${r.error}`)
        }
      })
    },
    [dragId, displayed, reorderItems]
  )

  const handleExport = async (): Promise<void> => {
    setExporting(true)
    try {
      const wb = XLSX.utils.book_new()
      // 导出**界面当前的顺序与筛选**（命中的在前、只看低库存时只导这些），
      // 而不是物品的原始顺序 —— 「看到什么就导出什么」才不会出现
      // 「表格里顺序对不上」的困惑。
      const data = displayed.map((item) => {
        const t = totals[item.id] ?? { in: 0, out: 0 }
        return {
          名称: item.name,
          数量: item.quantity,
          单位: item.unit,
          备注: item.note ?? '',
          警戒值: item.threshold,
          [`本月入库（${monthLabel}）`]: t.in,
          [`本月出库（${monthLabel}）`]: t.out,
          // 界面上低于警戒值的行是浅红的，导出的文件里没有颜色可看，
          // 就把这个状态落成一列文字，否则导出后这条信息就丢了
          状态: isBelowThreshold(item.quantity, item.threshold) ? '低于警戒值' : ''
        }
      })
      const ws = XLSX.utils.json_to_sheet(data)
      XLSX.utils.book_append_sheet(wb, ws, '仓库台账')
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
      const result = await exportXlsx(Array.from(new Uint8Array(buf)), '仓库台账.xlsx')
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

  if (items.length === 0) {
    return (
      <section className="card">
        <h2>仓库</h2>
        <p className="empty">还没有任何物品。到「操作」页做一次入库，物品会自动建立。</p>
      </section>
    )
  }

  return (
    <section className="card card-fill">
      <div className="card-header">
        <h2>
          仓库
          <span className="count">
            {searchActive
              ? `匹配 ${matchedIds.size} / 共 ${items.length} 种`
              : `${items.length} 种物品`}
          </span>
          {/*
            「只看低库存」的勾选框放这里，不放表头的「警戒值」旁边 ——
            它和「N 种低于警戒值」本来就是同一件事：一个报数量、一个做筛选，
            挨着才看得出这个框在筛什么。

            注意 `belowCount === 0` 时**也要显示**：用户勾上之后刚好把货补齐，
            若这时候勾选框跟着消失，表格空着却没法取消勾选 —— 页面就卡死了。
          */}
          {(belowCount > 0 || lowOnly) && (
            <label className="low-only-toggle" title="勾选后只显示低于警戒值的物品">
              <span className={belowCount > 0 ? 'count count-warn' : 'count'}>
                {belowCount} 种低于警戒值
              </span>
              <input
                type="checkbox"
                checked={lowOnly}
                onChange={(e) => setLowOnly(e.target.checked)}
                aria-label="只显示低于警戒值的物品"
              />
              只看这些
            </label>
          )}
        </h2>
        <div className="card-toolbar">
          <input
            type="text"
            className="search-input"
            placeholder="搜索物品名称…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索物品"
          />
          {searchActive && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setQuery('')}
              title="清除搜索"
            >
              清除
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() =>
              password.request({
                title: '导入表格',
                message:
                  `导入会先清空现有的 ${items.length} 个物品、${records.length} 条记录，` +
                  '再按表格内容重建。需要口令。',
                confirmLabel: '继续',
                danger: true,
                onConfirm: (pwd) => setImportPassword(pwd)
              })
            }
            title="从表格导入整份仓库数据（会清空现有数据，需口令）"
          >
            导入表格
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void handleExport()}
            disabled={exporting}
            title={`导出仓库台账（共 ${displayed.length} 种物品，按当前显示顺序与筛选）`}
          >
            {exporting ? '导出中…' : '导出 Excel'}
          </button>
        </div>
      </div>

      {/* 搜索词没命中任何物品时明说一句。表格仍照常显示全部 —— 见上面 searched 的注释 */}
      {searchActive && matchedIds.size === 0 && (
        <p className="search-note">没有名称包含「{query.trim()}」的物品，下面是全部 {items.length} 种。</p>
      )}

      {lowOnly && (
        <p className="search-note">
          已勾选「只看低于警戒值」：下面只显示 {displayed.length} 种库存偏低的物品
          （共 {belowCount} 种）。
        </p>
      )}

      {/*
        表格单独滚动，表头才谈得上「置顶」。
        不这么做的话，滚动的是整个页面，表头会跟着一起滚走 ——
        用户下拉时看不到「这一列是什么」，还以为列错位了。
      */}
      <div className="table-scroll">
        <table className="table table-cols-fixed">
          <colgroup>
            {/* 拖动柄：窄到只放得下三根横线，不占名称列的空间 */}
            <col style={{ width: 34 }} />
            {/* 名称列不写宽度，吃掉其余列定宽之后剩下的全部空间 */}
            <col />
            <col style={{ width: 76 }} />
            <col style={{ width: 62 }} />
            {/* 备注列同样不写宽度：备注长短差得多，定死会让短备注后面空一大片 */}
            <col />
            <col style={{ width: 132 }} />
            {/*
              这两列看着能压窄，其实压不得：表头是「本月入库（10月）」这种
              带月份的长文字，而 .table th 是 white-space: nowrap。
              列宽不够时文字会**溢出单元格**而不是换行，
              表头与数据的右边缘就对不上了（实测压到 112px 会差 16px）。
            */}
            <col style={{ width: 132 }} />
            <col style={{ width: 132 }} />
            {/* 操作列现在要放「入库 / 出库 / 删除」三个按钮 */}
            <col style={{ width: 178 }} />
          </colgroup>
          <thead>
            <tr>
              <th aria-label="拖动排序" />
              <th title="双击或右键名称可以改名">名称</th>
              <th className="num" title="双击或右键数量可以强行修改（需口令）">
                数量
              </th>
              <th title="双击或右键单位可以修改">单位</th>
              <th title="双击或右键备注可以修改">备注</th>
              <th className="num" title="库存低于这个数时标红（默认 100）">
                警戒值
              </th>
              <th className="num">本月入库（{monthLabel}）</th>
              <th className="num">本月出库（{monthLabel}）</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {displayed.map((item) => {
              const t = totals[item.id] ?? { in: 0, out: 0 }
              const low = isBelowThreshold(item.quantity, item.threshold)
              const hit = matchedIds.has(item.id)
              return (
                <tr
                  key={item.id}
                  className={[
                    low ? 'row-low' : '',
                    hit ? 'row-hit' : '',
                    overId === item.id ? 'row-drop' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onDragOver={(e) => {
                    if (!dragId) return
                    // 必须 preventDefault，否则浏览器不会触发 drop
                    e.preventDefault()
                    setOverId(item.id)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    handleDrop(item.id)
                  }}
                >
                  <td className="drag-cell">
                    <span
                      className="drag-handle"
                      draggable={!lowOnly}
                      aria-label="拖动以改变顺序"
                      title={
                        lowOnly
                          ? '取消「只看低于警戒值」的勾选后才能拖动排序'
                          : '按住拖动，可改变这一行在仓库里的顺序'
                      }
                      onDragStart={(e) => {
                        setDragId(item.id)
                        e.dataTransfer.effectAllowed = 'move'
                        // 带上是非必须的（我们用 state 记），但有些浏览器
                        // 不给 data 就不启动拖放
                        e.dataTransfer.setData('text/plain', item.id)
                      }}
                      onDragEnd={() => {
                        setDragId(null)
                        setOverId(null)
                      }}
                    >
                      <span className="drag-bars" aria-hidden="true" />
                    </span>
                  </td>
                  {/*
                    name-col / qty-col 这两个类名是给界面自检用的定位锚点。
                    断言如果按「第几个 td」找行，只要加一列（比如拖动柄）就会静默错位；
                    按类名找就不会。类名本身不承载样式。
                  */}
                  <td className="name-col">
                    <NameCell name={item.name} onRename={(next) => rename.request(item, next)} />
                  </td>
                  <td
                    className={[
                      'num',
                      'qty-col',
                      item.quantity < 0 ? 'negative' : '',
                      low ? 'below-threshold' : ''
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <QuantityCell item={item} low={low} onRequest={quantity.request} />
                  </td>
                  <td className="unit-col">
                    <EditableCell
                      value={item.unit}
                      ariaLabel={`${item.name} 的单位`}
                      hint="双击或右键修改单位"
                      menuLabel="修改单位"
                      emptyText="—"
                      onCommit={(next) => handleUnit(item, next)}
                    />
                  </td>
                  <td className="note-cell">
                    <EditableCell
                      value={item.note ?? ''}
                      ariaLabel={`${item.name} 的备注`}
                      hint="双击或右键修改备注"
                      menuLabel="修改备注"
                      emptyText="—"
                      onCommit={(next) => handleNote(item, next)}
                    />
                  </td>
                  <td className="num">
                    <ThresholdInput item={item} onCommit={(v) => handleThreshold(item, v)} />
                  </td>
                  <td className="num" style={{ color: 'var(--in-fg)' }}>
                    {t.in > 0 ? `+${formatQuantity(t.in)}` : '—'}
                  </td>
                  <td className="num" style={{ color: 'var(--out-fg)' }}>
                    {t.out > 0 ? `-${formatQuantity(t.out)}` : '—'}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{
                        background: 'var(--in-bg)',
                        color: 'var(--in-fg)',
                        borderColor: 'var(--in-bg)'
                      }}
                      onClick={() => openModal('in', item.name)}
                    >
                      入库
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{
                        background: 'var(--out-bg)',
                        color: 'var(--out-fg)',
                        borderColor: 'var(--out-bg)',
                        marginLeft: 6
                      }}
                      onClick={() => openModal('out', item.name)}
                    >
                      出库
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      style={{ marginLeft: 6 }}
                      title="删除这个物品及其名下所有记录（需口令）"
                      onClick={() => handleDelete(item)}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {displayed.length === 0 && lowOnly && (
        <p className="empty">当前没有低于警戒值的物品。</p>
      )}

      {modalType && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                {modalType === 'in' ? '入库' : '出库'} — {modalName}
              </h3>
              <button type="button" className="modal-close" onClick={closeModal}>
                ×
              </button>
            </div>
            <TransactionForm
              type={modalType}
              items={items}
              records={records}
              initialName={modalName}
              onSubmit={async (input) => {
                const result = await applyTransaction(input)
                if (!result.ok) throw new Error(result.error)
                if (result.warning) {
                  // eslint-disable-next-line no-alert
                  alert(result.warning)
                }
                closeModal()
              }}
              onCancel={closeModal}
            />
          </div>
        </div>
      )}

      {rename.dialog}
      {quantity.dialog}
      {password.dialog}

      {importPassword !== null && (
        <ImportDialog
          currentItemCount={items.length}
          currentRecordCount={records.length}
          onCancel={() => setImportPassword(null)}
          onSubmit={async (rows, operator, handler) => {
            const result = await importTable(importPassword, rows, operator, handler)
            if (result.ok) {
              setImportPassword(null)
              // 有数量被按 0 记的行时，把行号一并报出来 —— 这几行的库存是「猜的」，
              // 用户需要事后核对（导入对话框里也提前提示过一次，这是第二次）
              const zeroNote =
                result.zeroedRows.length > 0
                  ? `\n\n其中 ${result.zeroedRows.length} 行的数量不是数字，已按 0 记录：` +
                    `第 ${result.zeroedRows.slice(0, 10).join('、')} 行` +
                    `${result.zeroedRows.length > 10 ? ' 等' : ''}。请核对这几行。`
                  : ''
              // eslint-disable-next-line no-alert
              alert(`已导入 ${result.itemCount} 个物品、${result.recordCount} 条记录${zeroNote}`)
            }
            return result
          }}
        />
      )}
    </section>
  )
}
