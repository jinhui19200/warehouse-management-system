import { useCallback, useEffect, useRef, useState } from 'react'
import { matchesQuantityPassword } from '@shared/utils'

/**
 * 通用「输口令 → 确认」对话框。
 *
 * 删物品、导入表格这两处都要「先过口令、再干事」，各写一份的话，
 * 口令判定规则迟早在其中一份里走样（一处 trim、一处不 trim，
 * 于是「 771204 」在一处过了、另一处被拒）。所以抽成这一个：
 * 判定共用 `matchesQuantityPassword`，与数据层的判定**永远一致**。
 *
 * 与改数量那个两步式的分工：
 *  - 改数量：第二步还要填数字，所以口令和数字在同一个对话框里分步；
 *  - 这里：口令就是全部，校验通过即把**原样口令**交给调用方，
 *    由调用方拿去调数据层（数据层会**再验一次**，这里只是交互层）。
 */

export interface PasswordRequest {
  title: string
  /** 正文。必须把「会发生什么、能不能撤销」讲清楚 —— 见各调用方 */
  message: string
  /** 确认按钮文案，默认「确认」 */
  confirmLabel?: string
  /** 危险操作：确认按钮用警示色（删物品、导入都会清空数据） */
  danger?: boolean
  onConfirm: (password: string) => void
}

function PasswordDialog({
  request,
  onCancel,
  onConfirm
}: {
  request: PasswordRequest
  onCancel: () => void
  onConfirm: (password: string) => void
}): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  const submit = (): void => {
    // 与数据层共用同一个判定函数（见 matchesQuantityPassword 的注释）
    if (!matchesQuantityPassword(password)) {
      setError('口令不正确')
      setPassword('')
      ref.current?.focus()
      return
    }
    onConfirm(password)
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{request.title}</h3>
          <button type="button" className="modal-close" onClick={onCancel}>
            ×
          </button>
        </div>

        <div className="modal-body">
          <p className="modal-text">{request.message}</p>
          <input
            ref={ref}
            type="password"
            className="qty-edit-input"
            value={password}
            aria-label="口令"
            autoComplete="off"
            onChange={(e) => {
              setPassword(e.target.value)
              setError('')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onCancel()
              }
            }}
          />
          {error && <p className="modal-error">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className={request.danger ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={submit}
          >
            {request.confirmLabel ?? '确认'}
          </button>
        </div>
      </div>
    </div>
  )
}

export interface PasswordFlow {
  /** 弹出口令框。`onConfirm` 只在口令校验通过后被调用 */
  request: (req: PasswordRequest) => void
  /** 需要时渲染的对话框（没在等口令时是 null） */
  dialog: React.JSX.Element | null
}

export function usePasswordFlow(): PasswordFlow {
  const [pending, setPending] = useState<PasswordRequest | null>(null)

  const request = useCallback((req: PasswordRequest): void => {
    setPending(req)
  }, [])

  const dialog = pending ? (
    <PasswordDialog
      request={pending}
      onCancel={() => setPending(null)}
      onConfirm={(password) => {
        // 先关窗再回调：回调里多半要弹下一个对话框（导入流程就是这样），
        // 让这个先消失，界面才不会叠两层
        setPending(null)
        pending.onConfirm(password)
      }}
    />
  ) : null

  return { request, dialog }
}
