import { useEffect, useMemo, useRef, useState } from 'react'
import type { RaidProjection } from '../raids/types'
import type { LivePosition } from '../raids/live-feed'
import { enqueueField, pumpFieldOperations, type FieldOperation } from '../raids/field-outbox'
import type { StopPoint } from '../raids/recording/stop-context'
import { riderDistanceMeters } from '../raids/recording/rider-markers'
import { getOneShotCoordinate } from './platform'
import { activeParticipantSelection, participantSelectionAfterPresenceRefresh } from './state'
import { checkInRefusalMessage } from './refusal'
import type { CheckInResponse } from './types'

export function TeamVisitPanel(props: {
  identityId: string; raid: RaidProjection; point: StopPoint; positions: readonly LivePosition[]
  operations: readonly FieldOperation[]; visible: boolean; stale: boolean; repeat: boolean
  onAccepted: () => void; onManual: () => void
}) {
  const { identityId, raid, point, positions, operations, visible, stale, repeat, onAccepted, onManual } = props
  const [selected, setSelected] = useState<string[]>([identityId])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [operationId, setOperationId] = useState<string | null>(null)
  const choices = useRef(new Map<string, boolean>())
  const mounted = useRef(true)
  const observed = useRef(new Set<string>())
  const previousAttemptId = useRef(point.lastAttemptId ?? null)
  const members = raid.participants.filter(member => member.state === 'active')
  const memberKey = members.map(member => member.id).sort().join(':')
  const activeIds = useMemo(() => new Set(memberKey.split(':').filter(Boolean)), [memberKey])
  const waiting = operations.find(row => row.kind === 'team' && row.pointId === point.pointSnapshotId && ['pending', 'sending', 'retryable'].includes(row.status))
  const current = operationId ? operations.find(row => row.operationId === operationId) : waiting
  const sending = Boolean(current && ['pending', 'sending', 'retryable'].includes(current.status))
  const selectedIds = activeParticipantSelection(identityId, selected, activeIds)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (!operationId && waiting) setOperationId(waiting.operationId) }, [operationId, waiting])
  useEffect(() => {
    const now = Date.now()
    const nearbyIds = positions.filter(position => {
      const age = now - Date.parse(position.capturedAt)
      return age >= -5000 && age <= 30_000 && position.accuracyMeters <= 50 &&
        riderDistanceMeters(position, { ...point, capturedAt: position.capturedAt }) <= 50
    }).map(position => position.userId)
    setSelected(previous => {
      const next = participantSelectionAfterPresenceRefresh({ identityId, selectedParticipantIds: previous,
        nearbyParticipantIds: nearbyIds, manualParticipantChoices: choices.current, activeParticipantIds: activeIds,
        freezeSuggestions: sending || busy })
      return previous.join(':') === next.join(':') ? previous : next
    })
  }, [identityId, point, positions, activeIds, sending, busy])
  useEffect(() => {
    if (!current || !['accepted', 'rejected'].includes(current.status) || observed.current.has(current.operationId)) return
    observed.current.add(current.operationId)
    const response = current.response as CheckInResponse | undefined
    if (response?.outcome === 'accepted') { onAccepted(); return }
    if (response?.outcome === 'needs_manual_verification') {
      setMessage(checkInRefusalMessage(response.reason))
      if (response.reason !== 'too_far') onManual()
      return
    }
    if (current.lastError === 'TEAM_VISIT_ALREADY_CONFIRMED') { onAccepted(); return }
    setMessage(current.lastError === 'NAVIGATOR_REQUIRED' ? 'Навигатор сменился. Посещение подтверждает новый навигатор.'
      : current.lastError === 'ATTENDANCE_CHANGED' ? 'Состав изменился. Проверьте участников перед новой попыткой.'
        : 'Сервер не подтвердил посещение. Проверьте состав и повторите.')
  }, [current, onAccepted, onManual])

  const submit = async () => {
    if (!visible || busy || sending || raid.state !== 'active' || raid.navigatorUserId !== identityId || !activeIds.has(identityId)) return
    if (stale && navigator.onLine) { setMessage('Обновляем состояние рейда. Повторите после соединения.'); return }
    setBusy(true)
    setMessage('Проверяем координату…')
    try {
      // The foreground proximity watcher already keeps GPS warm. A remembered
      // arrival coordinate (even ten seconds old) can belong to the previous
      // stop while a bicycle has moved outside the check-in radius. Take an
      // independent fresh fix at the tap; never use the stabilized display pin.
      const evidence = await getOneShotCoordinate(10_000)
      if (!mounted.current) return
      const operation = await enqueueField({ identityId, kabandaId: raid.kabandaId, raidId: raid.id,
        pointId: point.pointSnapshotId, kind: 'team', payload: {
          pointSnapshotId: point.pointSnapshotId, evidence, presentParticipantIds: selectedIds,
          confirmedAttendance: true, repeatVisit: repeat, previousAttemptId: repeat ? previousAttemptId.current : null,
        } })
      if (!mounted.current) return
      setOperationId(operation.operationId)
      setMessage(navigator.onLine ? 'Отправляем посещение…' : 'Посещение сохранено на телефоне и ожидает соединения.')
      void pumpFieldOperations(identityId, raid.id, 'team', navigator.onLine).catch(() => undefined)
    } catch (error) {
      if (mounted.current) setMessage(error instanceof Error && error.message !== 'GPS_TIMEOUT' ? error.message
        : 'Не получили свежую координату. Выбор участников сохранён, повторите попытку.')
    } finally { if (mounted.current) setBusy(false) }
  }

  return <section className="checkin-panel checkin-panel--map" aria-label="Командное посещение">
    <fieldset className="checkin-participants"><legend>Кого отмечаем на точке?</legend>
      {members.map(member => <label key={member.id}>
        <input type="checkbox" aria-label={member.displayName} disabled={busy || sending || member.id === identityId}
          checked={selectedIds.includes(member.id)} onChange={event => {
            const checked = event.target.checked
            choices.current.set(member.id, checked)
            setSelected(previous => checked ? [...new Set([...previous, member.id])] : previous.filter(id => id !== member.id))
          }} />
        <span className="checkin-participant__name">{member.displayName}{member.id === identityId ? ' · вы' : ''}</span>
      </label>)}
    </fieldset>
    <p className="checkin-participant-hint">Нажимая Пометить точку, вы подтверждаете присутствие выбранных участников. Повторять отметку на остальных телефонах не нужно.</p>
    {(message || sending) && <p className="kb-notice" role="status">{sending
      ? current?.status === 'retryable' ? 'Связь задерживается. Повторим эту же операцию автоматически.'
        : current?.status === 'sending' ? 'Ожидаем подтверждение сервера…' : 'Посещение сохранено на телефоне. Отправляем при наличии связи.'
      : message}</p>}
    <button type="button" className="kb-primary raid-primary" disabled={busy || sending || (repeat && !previousAttemptId.current)} onClick={() => void submit()}>
      {busy ? 'Проверяем координату…' : sending ? 'Отправляем посещение…' : repeat ? 'Подтвердить новый визит' : 'Пометить точку'}
    </button>
  </section>
}
