import { useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import type { ImportResult, ImportRow } from '@shared/types'
import { formatQuantity } from '@shared/utils'

/**
 * 导入表格对话框。**会清空现有全部数据**，所以这个框的重点不是「选文件」，
 * 而是让用户**在按下确认之前**清楚地知道：
 *   - 现在有多少东西会被清掉；
 *   - 表格里读出来多少行、前几行长什么样（读错了立刻能看出来）；
 *   - 这批记录会记在谁名下（操作人 / 经手人）。
 *
 * 口令不在这里收 —— 调用方（仓库页）先用通用口令框过一道，
 * 通过后才把这个框弹出来，并把口令传进来。
 * 这样「口令框」和「导入框」各自只做一件事，也不会出现口令输一半的半成品状态。
 */

/** 表头别名。用户手里的表格列名千奇百怪，认全一点能少一次「读不出来」 */
const ALIASES = {
  name: ['名称', '品名', '物品名称', 'name'],
  unit: ['单位', 'unit'],
  quantity: ['数量', '库存', '库存数量', 'qty', 'quantity'],
  note: ['备注', '说明', 'note', 'remark']
} as const

/**
 * 在表头行里找每一列的下标。
 *
 * 返回 null 表示「这一行不像表头」—— 那就是**没有表头**的表格
 * （数据从第一行开始，列序固定为 名称 / 单位 / 数量 / 备注）。
 * 必须兼容这种情况：很多从系统里导出的 csv 是不带表头的。
 */
function mapHeader(cells: string[]): {
  name: number
  unit: number
  quantity: number
  note: number
} | null {
  const find = (aliases: readonly string[]): number => {
    for (let i = 0; i < cells.length; i++) {
      const cell = (cells[i] ?? '').trim().toLowerCase()
      if (!cell) continue
      if (aliases.some((a) => cell.includes(a.toLowerCase()))) return i
    }
    return -1
  }

  const name = find(ALIASES.name)
  const unit = find(ALIASES.unit)
  const quantity = find(ALIASES.quantity)
  const note = find(ALIASES.note)

  // 名称和单位是硬要求：没有这两列就没法建物品。
  // 数量也一样 —— 导入的目的就是把库存建起来。
  // 备注可以没有（aliases 找不到就当整列不存在）。
  if (name < 0 || unit < 0 || quantity < 0) return null
  return { name, unit, quantity, note }
}

interface Parsed {
  rows: ImportRow[]
  /** 用到了表头行（有表头时为 true，数据从第二行开始） */
  hasHeader: boolean
  /** 表格里被跳过的空行数（全空的行） */
  skipped: number
  /**
   * 数量不是数字（或这一格是空的）的**数据行号**，1 起算。
   *
   * 这些行**不会**被拒 —— 按用户要求，数量照 0 录入，但必须提前告诉用户
   * 是哪几行，否则他事后根本不知道哪些库存是「猜的 0」。
   */
  invalidQtyRows: number[]
}

/**
 * 把 CSV 的字节解成字符串。
 *
 * 先按 UTF-8 解；出现替换字符（U+FFFD）说明这份文件不是 UTF-8 ——
 * 中文 Windows 下 Excel「另存为 CSV」默认用 GBK，所以回退到 GBK 再解一次。
 * 两种都不行时返回 UTF-8 的结果（至少让用户看到乱码，而不是一片空白）。
 */
function decodeCsv(buf: ArrayBuffer): string {
  const utf8 = new TextDecoder('utf-8').decode(buf)
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return utf8
  }
}

function parseSheet(workbook: XLSX.WorkBook): Parsed {
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) return { rows: [], hasHeader: false, skipped: 0, invalidQtyRows: [] }

  // header: 1 让第一行也作为普通行返回，方便我们判断它是不是表头
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', blankrows: false })
  if (raw.length === 0) return { rows: [], hasHeader: false, skipped: 0, invalidQtyRows: [] }

  const firstRow = (raw[0] ?? []).map((c) => String(c ?? ''))
  const mapping = mapHeader(firstRow)
  const hasHeader = mapping !== null
  const cols = mapping ?? { name: 0, unit: 1, quantity: 2, note: 3 }

  const rows: ImportRow[] = []
  const invalidQtyRows: number[] = []
  let skipped = 0
  for (let i = hasHeader ? 1 : 0; i < raw.length; i++) {
    const cells = (raw[i] ?? []).map((c) => String(c ?? '').trim())
    const name = cells[cols.name] ?? ''
    const unit = cells[cols.unit] ?? ''
    const quantityRaw = cells[cols.quantity] ?? ''
    // 整行全空（表格里常见的尾部空行）直接跳过，不算错误 ——
    // 否则用户每次导入都要先去 Excel 里删空行
    if (!name && !unit && !quantityRaw) {
      skipped++
      continue
    }

    const quantity = quantityRaw === '' ? Number.NaN : Number(quantityRaw)
    // 记下「数量不是数字」的行号（1 起算，与数据层回报的口径一致）。
    // 空串在这里也走 Number.NaN，所以「那格空着」同样会被列进来 ——
    // 实际表格里这种情况最多（比如「洗发水」那行数量没填）。
    if (!Number.isFinite(quantity)) invalidQtyRows.push(rows.length + 1)

    rows.push({
      name,
      unit,
      quantity,
      note: cols.note >= 0 ? (cells[cols.note] ?? '') : ''
    })
  }

  return { rows, hasHeader, skipped, invalidQtyRows }
}

export function ImportDialog({
  currentItemCount,
  currentRecordCount,
  onCancel,
  onSubmit
}: {
  /** 现有物品数 —— 警示文案要给出「会清掉多少」的具体数字 */
  currentItemCount: number
  currentRecordCount: number
  onCancel: () => void
  onSubmit: (rows: ImportRow[], operator: string, handler: string) => Promise<ImportResult>
}): React.JSX.Element {
  const [parsed, setParsed] = useState<Parsed | null>(null)
  const [fileName, setFileName] = useState('')
  const [operator, setOperator] = useState('')
  const [handler, setHandler] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFile = async (file: File): Promise<void> => {
    setError('')
    setFileName(file.name)
    try {
      const buf = await file.arrayBuffer()
      /*
       * CSV 必须自己先解码成字符串再交给 xlsx。
       *
       * 直接把 ArrayBuffer 丢给 XLSX.read 的话，它会按 **latin1** 解 CSV，
       * 中文全变成乱码 —— 表头「名称/单位/数量」认不出来（于是整表被当成
       * 无表头），数量那一格 '数量' 也过不了 Number()，报「第 1 行：数量不是数字」。
       * 一个纯中文 CSV 会因此完全导不进来。
       *
       * 编码判定：先按 UTF-8 解，出现替换字符（U+FFFD）就说明不是 UTF-8 ——
       * 中文 Windows 下 Excel「另存为 CSV」默认是 GBK，所以回退到 GBK 再试一次。
       */
      const wb = /\.csv$/i.test(file.name)
        ? XLSX.read(decodeCsv(buf), { type: 'string' })
        : XLSX.read(buf, { type: 'array' })
      const result = parseSheet(wb)
      if (result.rows.length === 0) {
        setParsed(null)
        setError('这个表格里没读到任何数据行')
        return
      }
      setParsed(result)
    } catch (err) {
      setParsed(null)
      setError(`读取失败：${String(err)}。请确认是 .xlsx / .xls / .csv 文件`)
    }
  }

  const submit = async (): Promise<void> => {
    if (!parsed || parsed.rows.length === 0) return
    setBusy(true)
    setError('')
    const result = await onSubmit(parsed.rows, operator, handler)
    // 成功时调用方会关掉这个框（它是条件渲染的），不要再 setState
    if (result.ok) return
    setBusy(false)
    // 数据层会指出是哪一行有问题（"第 N 行：…"），原样显示即可
    setError(result.error)
  }

  const preview = parsed ? parsed.rows.slice(0, 8) : []

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>导入表格</h3>
          <button type="button" className="modal-close" onClick={onCancel}>
            ×
          </button>
        </div>

        <div className="modal-body">
          <p className="modal-warn">
            导入会<strong>先清空</strong>现有的 {currentItemCount} 个物品、
            {currentRecordCount} 条出入库记录，再按表格内容重建。
            <strong>此操作不可撤销。</strong>
          </p>

          <div className="import-file">
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              aria-label="选择要导入的表格文件"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void handleFile(file)
              }}
            />
            <p className="modal-note">
              列顺序：名称、单位、数量、备注。带表头或不带表头都认；
              备注列可以没有。
            </p>
          </div>

          {fileName && parsed && (
            <>
              <p className="modal-text">
                已读取 <strong>{fileName}</strong>：{parsed.rows.length} 行
                {parsed.hasHeader ? '（已跳过表头行）' : '（无表头，按列序读取）'}
                {parsed.skipped > 0 ? `，跳过 ${parsed.skipped} 个空行` : ''}
              </p>

              <div className="import-preview">
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>名称</th>
                      <th>单位</th>
                      <th className="num">数量</th>
                      <th>备注</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((r, i) => (
                      <tr key={i}>
                        <td className="mono">{i + 1}</td>
                        <td>{r.name}</td>
                        <td>{r.unit}</td>
                        <td className="num">
                          {Number.isFinite(r.quantity) ? formatQuantity(r.quantity) : '—'}
                        </td>
                        <td>{r.note || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {parsed.rows.length > preview.length && (
                  <p className="modal-note">仅预览前 {preview.length} 行，共 {parsed.rows.length} 行。</p>
                )}
              </div>

              {/*
                数量不是数字**不阻断导入**（按 0 记），但必须在按下确认之前
                就把「是哪几行」摆出来 —— 否则用户事后根本不知道
                哪些库存是猜出来的 0。
              */}
              {parsed.invalidQtyRows.length > 0 && (
                <p className="import-warn">
                  第 {parsed.invalidQtyRows.slice(0, 10).join('、')}
                  {parsed.invalidQtyRows.length > 10
                    ? ` 等 ${parsed.invalidQtyRows.length} 行`
                    : ' 行'}
                  的数量不是数字（或没填），导入时会<strong>按 0 记录</strong>，
                  其余内容照常导入。
                </p>
              )}

              <div className="import-people">
                <label className="import-field">
                  操作人
                  <input
                    type="text"
                    value={operator}
                    aria-label="本次导入的操作人"
                    placeholder="选填"
                    onChange={(e) => setOperator(e.target.value)}
                  />
                </label>
                <label className="import-field">
                  经手人
                  <input
                    type="text"
                    value={handler}
                    aria-label="本次导入的经手人"
                    placeholder="选填"
                    onChange={(e) => setHandler(e.target.value)}
                  />
                </label>
                <p className="modal-note">
                  这两个名字会写在本次导入产生的每一条入库记录上。
                </p>
              </div>
            </>
          )}

          {error && <p className="modal-error">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={!parsed || parsed.rows.length === 0 || busy}
            onClick={() => void submit()}
          >
            {busy ? '导入中…' : '确认导入（将清空现有数据）'}
          </button>
        </div>
      </div>
    </div>
  )
}
