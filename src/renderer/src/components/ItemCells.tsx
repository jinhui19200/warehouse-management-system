import { useEffect, useRef, useState } from 'react'
import { ContextMenu } from './ContextMenu'

/**
 * 行内编辑输入框（备注 / 单位共用）。
 *
 * 回车 / 失焦提交，Esc 取消。用 `done` 这个 ref 而不是 state 做「只提交一次」的闸门：
 * 回车会先触发提交、紧接着 blur 又触发一次，用 state 拦不住 ——
 * 同一个 tick 里两次 setState 都读到旧值，改动会被执行两遍。
 */
function InlineEditInput({
  initial,
  ariaLabel,
  onCommit,
  onCancel
}: {
  initial: string
  ariaLabel: string
  onCommit: (next: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(initial)
  const done = useRef(false)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.select()
  }, [])

  const finish = (commit: boolean): void => {
    if (done.current) return
    done.current = true
    if (commit) onCommit(draft)
    else onCancel()
  }

  return (
    <input
      ref={ref}
      type="text"
      className="name-input"
      value={draft}
      aria-label={ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
      }}
    />
  )
}

/**
 * 可双击 / 右键编辑的文本单元格（备注、单位共用）。
 *
 * 与改数量那套**刻意不同**：这里不需要口令。
 * 理由是操作代价不同 —— 改数量会把库存改成任意数（可能把 245 写成 2450），
 * 而备注和单位改错了也就是「内容不对」，一眼能看见、随手能改回来。
 * 给它们也加口令，只会让「随手补个备注」变成要输六位数的麻烦事。
 *
 * @param emptyText 内容为空时显示的占位（默认「—」）。
 *                  刻意不用空白 —— 空的单元格看起来像「加载失败了」
 */
export function EditableCell({
  value,
  ariaLabel,
  hint,
  menuLabel,
  emptyText = '—',
  onCommit
}: {
  value: string
  ariaLabel: string
  /** 鼠标悬停提示，例如「双击或右键修改备注」 */
  hint: string
  /** 右键菜单里的项名，例如「修改备注」 */
  menuLabel: string
  emptyText?: string
  onCommit: (next: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  if (editing) {
    return (
      <InlineEditInput
        initial={value}
        ariaLabel={ariaLabel}
        // 先退出编辑态再提交：提交可能失败并弹提示，
        // 让输入框一直开着的话，用户取消后会发现内容没变但框还在
        onCommit={(next) => {
          setEditing(false)
          onCommit(next)
        }}
        onCancel={() => setEditing(false)}
      />
    )
  }

  return (
    <>
      <span
        className={value ? 'editable-text' : 'editable-text editable-empty'}
        title={hint}
        onDoubleClick={() => setEditing(true)}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        {value || emptyText}
      </span>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[{ label: menuLabel, onClick: () => setEditing(true) }]}
        />
      )}
    </>
  )
}
