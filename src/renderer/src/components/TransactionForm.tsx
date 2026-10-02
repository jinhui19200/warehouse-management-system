import { useEffect, useMemo, useRef, useState } from 'react'
import type { Item, StockRecord, TransactionInput } from '@shared/types'
import { handlerLabel, normalizeName, toLocalDateTime } from '@shared/utils'

interface Props {
  type: 'in' | 'out'
  items: Item[]
  records: StockRecord[]
  /** 预填名称（仓库页点「出库/入库」时传入） */
  initialName?: string
  onSubmit: (input: TransactionInput) => Promise<void> | void
  onCancel?: () => void
}

/**
 * 从历史记录里取补全建议：包含输入内容、去重、排除与输入完全相同的项、最多 6 条。
 *
 * `type` 传了就只在该方向的记录里找 —— 「经手人」和「领取人」在业务上是两个角色
 * （一个把货交出去、一个把货领走），拿领取人的名字去建议经手人会让用户选错。
 */
function suggestionsFrom(
  records: StockRecord[],
  field: 'operator' | 'handler',
  term: string,
  type?: 'in' | 'out'
): string[] {
  const t = term.trim()
  if (!t) return []
  const seen = new Set<string>()
  const list: string[] = []
  for (const r of records) {
    if (type && r.type !== type) continue
    const v = r[field]
    if (v && v.includes(t) && v !== t && !seen.has(v)) {
      seen.add(v)
      list.push(v)
      if (list.length >= 6) break
    }
  }
  return list
}

export function TransactionForm({
  type,
  items,
  records,
  initialName,
  onSubmit,
  onCancel
}: Props): React.JSX.Element {
  const [time, setTime] = useState(toLocalDateTime())
  /**
   * 用户是否手动改过时间。
   *
   * 默认时间是**挂载那一刻**取的，表单停在操作页跨过零点后就成了昨天的日期。
   * 所以用户一开始操作表单就重新取「此刻」—— 但他要是手动改过，就尊重他的输入。
   *
   * 刻意不做「提交时才取当前时间」：那样屏幕上显示 09:00、记进流水却是 10:00，
   * 显示与结果不一致比默认值略旧更难排查。这里保证两者始终一致。
   */
  const [timeEdited, setTimeEdited] = useState(false)
  const [name, setName] = useState(initialName ?? '')
  const [quantity, setQuantity] = useState('')
  const [unit, setUnit] = useState('')
  const [operator, setOperator] = useState('')
  const [handler, setHandler] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const nameRef = useRef<HTMLInputElement>(null)

  // 名称对应的已存在物品（用于锁定单位）
  const matchedItem = useMemo(
    () => items.find((i) => i.name === normalizeName(name)),
    [items, name]
  )

  // 名称自动补全建议
  const nameSuggestions = useMemo(() => {
    const term = normalizeName(name)
    if (!term || matchedItem) return []
    return items
      .filter((i) => i.name.includes(term) && i.name !== term)
      .map((i) => i.name)
      .slice(0, 6)
  }, [items, name, matchedItem])

  // 操作人自动补全建议（去重，只取最近用过的；排除与已输入完全相同的项）
  const operatorSuggestions = useMemo(
    () => suggestionsFrom(records, 'operator', operator),
    [records, operator]
  )

  // 经手人 / 领取人的补全建议。只在本方向的记录里找：入库建议历来的经手人，
  // 出库建议历来的领取人 —— 两个角色不该互相串。
  const handlerSuggestions = useMemo(
    () => suggestionsFrom(records, 'handler', handler, type),
    [records, handler, type]
  )

  // 单位锁定：物品已存在时强制用 item.unit
  useEffect(() => {
    if (matchedItem) {
      setUnit(matchedItem.unit)
    } else if (initialName && !name) {
      setUnit('')
    }
  }, [matchedItem, initialName, name])

  const isValid =
    normalizeName(name) !== '' &&
    Number(quantity) > 0 &&
    (matchedItem ? true : unit.trim() !== '')

  /**
   * 表单内任意控件获得焦点时调用（React 的 onFocus 是 focusin 语义，会冒泡）。
   *
   * 提交前必须先输入名称和数量，也就必然会触发一次聚焦，
   * 因此「聚焦即校准时间」足以覆盖所有提交路径，不需要额外定时器。
   */
  const handleFormFocus = (): void => {
    if (!timeEdited) setTime(toLocalDateTime())
  }

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!isValid || submitting) return
    setSubmitting(true)
    setError('')

    try {
      await onSubmit({
        time,
        name: normalizeName(name),
        quantity: Number(quantity),
        unit: unit.trim(),
        operator: operator.trim(),
        handler: handler.trim(),
        type
      })
      // 提交成功清空表单（保留操作人与经手人/领取人，减少重复输入）
      setTime(toLocalDateTime())
      setTimeEdited(false)
      setName('')
      setQuantity('')
      setUnit('')
      nameRef.current?.focus()
    } catch (err) {
      setError(String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const title = type === 'in' ? '入库' : '出库'
  const accent = type === 'in' ? 'var(--in-fg)' : 'var(--out-fg)'

  return (
    <form onSubmit={handleSubmit} onFocus={handleFormFocus} className="tx-form">
      <div className="tx-field">
        <label>时间</label>
        <input
          type="datetime-local"
          value={time}
          onChange={(e) => {
            setTime(e.target.value)
            setTimeEdited(true)
          }}
          required
        />
      </div>

      <div className="tx-field">
        <label>名称</label>
        <div className="tx-input-wrap">
          <input
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="输入物品名称"
            autoComplete="off"
            required
          />
          {nameSuggestions.length > 0 && (
            <div className="tx-suggestions">
              {nameSuggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="tx-suggestion"
                  onClick={() => {
                    setName(s)
                    nameRef.current?.focus()
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="tx-field">
        <label>数量</label>
        <input
          type="number"
          step="0.001"
          min="0.001"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          placeholder={type === 'in' ? '入库数量' : '出库数量'}
          required
        />
      </div>

      <div className="tx-field">
        <label>单位 {matchedItem ? <span className="tx-locked">（已锁定）</span> : null}</label>
        <input
          type="text"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          placeholder={matchedItem ? unit : '如：个、盒、箱'}
          readOnly={!!matchedItem}
          required={!matchedItem}
        />
        {/*
          已有物品的备注只**展示**、不给编辑入口。
          备注属于物品本身（Item.note），改它应该去仓库页那一行上改 ——
          这里塞一个输入框，就会出现「同一样东西两个地方能改」，
          而两处的行为很难完全一致。
        */}
        {matchedItem?.note && (
          <p className="tx-item-note" title="这个物品的备注，在仓库页可以修改">
            备注：{matchedItem.note}
          </p>
        )}
      </div>

      <div className="tx-field">
        <label>操作人</label>
        <div className="tx-input-wrap">
          <input
            type="text"
            value={operator}
            onChange={(e) => setOperator(e.target.value)}
            placeholder="选填，输入操作人姓名"
            autoComplete="off"
          />
          {operatorSuggestions.length > 0 && (
            <div className="tx-suggestions">
              {operatorSuggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="tx-suggestion"
                  onClick={() => setOperator(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/*
        经手人（入库）/ 领取人（出库）。标签由 handlerLabel(type) 统一给出 ——
        表单、记录列表表头、导出 Excel 的列名都取自同一处定义，改文案不会漏。
      */}
      <div className="tx-field">
        <label>{handlerLabel(type)}</label>
        <div className="tx-input-wrap">
          <input
            type="text"
            className="tx-handler-input"
            value={handler}
            onChange={(e) => setHandler(e.target.value)}
            placeholder={
              type === 'in' ? '选填，输入经手人姓名' : '选填，输入领取人姓名'
            }
            autoComplete="off"
          />
          {handlerSuggestions.length > 0 && (
            <div className="tx-suggestions">
              {handlerSuggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="tx-suggestion"
                  onClick={() => setHandler(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && <p className="tx-error">{error}</p>}
      <div className="tx-actions">
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            取消
          </button>
        )}
        <button
          type="submit"
          className="btn"
          disabled={!isValid || submitting}
          style={{ background: accent, borderColor: accent, color: '#fff' }}
        >
          {submitting ? '提交中…' : title}
        </button>
      </div>
    </form>
  )
}
