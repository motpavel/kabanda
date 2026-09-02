import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../../lib/http'
import { getRaidPointPresence } from '../raids/api'
import type { RaidParticipant, RaidProjection } from '../raids/types'
import { useRecordingRuntime } from '../raids/recording/runtime'
import {
  actOnClaim,
  actOnFallback,
  createFallback,
  getNearbyPoints,
  listPendingClaims,
  listPendingFallbacks,
  listRaidMedia,
  mediaContentUrl,
} from './api'
import { getOneShotCoordinate, hasQuotaForMedia, sha256Hex, validateMediaFile } from './platform'
import { replayOneCheckInOrMedia } from './replay'
import { loadCheckInExtras } from './refresh'
import {
  activeParticipantSelection,
  checkInAttentionState,
  participantSelectionAfterPresenceRefresh,
  participantSelectionKey,
  participantSelectionScopeKey,
  selectCheckInPrimary,
} from './state'
import {
  enqueueCheckIn,
  getCheckInLocalState,
  persistMediaDraft,
  reserveFallbackSubmission,
  settleFallbackSubmission,
} from './store'
import type {
  CheckInClaim,
  CheckInFallback,
  CheckInResponse,
  NearbyPoint,
  RaidMedia,
} from './types'

function tabId(): string {
  const key = 'kabanda:checkin-sender-tab:v1'
  try {
    const existing = sessionStorage.getItem(key)
    if (existing) return existing
    const created = crypto.randomUUID()
    sessionStorage.setItem(key, created)
    return created
  } catch {
    return crypto.randomUUID()
  }
}

function activeParticipants(raid: RaidProjection): RaidParticipant[] {
  return raid.participants.filter(({ state }) => state === 'active')
}

export function CheckInPanel({
  identityId,
  raid,
  staleProjection,
  onCanonicalRefresh,
  serverTailOnly = false,
  nearbyPoints,
  presentation = 'card',
  onPendingChange,
  onAttentionChange,
}: {
  identityId: string
  raid: RaidProjection
  staleProjection: boolean
  onCanonicalRefresh: () => Promise<unknown>
  serverTailOnly?: boolean
  nearbyPoints?: NearbyPoint[]
  presentation?: 'card' | 'map-sheet'
  onPendingChange?: (count: number) => void
  onAttentionChange?: (state: { count: number; key: string; actionKey: string }) => void
}) {
  const [nearby, setNearby] = useState<NearbyPoint[]>([])
  const [selectedPointId, setSelectedPointId] = useState('')
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>([identityId])
  const [nearbyParticipantIds, setNearbyParticipantIds] = useState<string[]>([])
  const [attestedParticipantKey, setAttestedParticipantKey] = useState<string | null>(null)
  const [claims, setClaims] = useState<CheckInClaim[]>([])
  const [fallbacks, setFallbacks] = useState<CheckInFallback[]>([])
  const [media, setMedia] = useState<RaidMedia[]>([])
  const [local, setLocal] = useState<Awaited<ReturnType<typeof getCheckInLocalState>> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [caption, setCaption] = useState('')
  const [fallbackReason, setFallbackReason] = useState('Координату не удалось подтвердить на месте.')
  const [verifierId, setVerifierId] = useState('')
  const senderTabId = useRef(tabId()).current
  const actionKeys = useRef(new Map<string, string>())
  const manualParticipantChoices = useRef(new Map<string, boolean>())
  const initializedParticipantScopeKey = useRef<string | null>(null)
  const replaying = useRef(false)
  const replayRequested = useRef(false)
  const { setUnsyncedCheckInWork } = useRecordingRuntime()
  const viewerIsOrganizer = raid.organizerUserId === identityId
  const participants = useMemo(() => activeParticipants(raid), [raid])
  const activeParticipantIds = useMemo(() => new Set(participants.map(({ id }) => id)), [participants])
  const pendingClaim = claims[0] ?? null
  const pendingFallback = fallbacks[0] ?? null
  const manualAttempt = local?.needsAction.find(
    ({ fallbackSubmission }) => fallbackSubmission?.status !== 'submitted',
  ) ?? null
  const manualResponse = manualAttempt?.response as CheckInResponse | null
  const manualAttemptOperationId = manualAttempt?.operationId ?? null
  const participantScopeKey = participantSelectionScopeKey(
    identityId,
    selectedPointId,
    manualAttemptOperationId,
  )
  const reservedFallback = manualAttempt?.fallbackSubmission ?? null
  const fallbackMedia = local?.media.find((draft) =>
    draft.status === 'accepted' && draft.purpose === 'fallback' &&
    draft.attemptId === manualResponse?.attemptId && draft.mediaId,
  ) ?? null
  const canMutate = raid.state === 'active' && !staleProjection
  const effectiveNearby = nearbyPoints ?? nearby
  const validSelectedParticipants = activeParticipantSelection(
    identityId,
    selectedParticipants,
    activeParticipantIds,
  )
  const selectedParticipantKey = participantSelectionKey(validSelectedParticipants)
  const organizerAttestation = attestedParticipantKey === selectedParticipantKey &&
    validSelectedParticipants.some((id) => id !== identityId)

  useEffect(() => {
    setAttestedParticipantKey(null)
  }, [selectedParticipantKey])

  useEffect(() => {
    if (!nearbyPoints) return
    const eligible = nearbyPoints.filter(({ creditedByTeam }) => !creditedByTeam)
    setSelectedPointId((current) => eligible.some(({ pointSnapshotId }) => pointSnapshotId === current)
      ? current
      : eligible[0]?.pointSnapshotId ?? '')
  }, [nearbyPoints])

  useEffect(() => {
    for (const participantId of manualParticipantChoices.current.keys()) {
      if (!activeParticipantIds.has(participantId)) manualParticipantChoices.current.delete(participantId)
    }
    setNearbyParticipantIds((current) => current.filter((id) => activeParticipantIds.has(id)))
    setSelectedParticipants((current) => activeParticipantSelection(identityId, current, activeParticipantIds))
  }, [activeParticipantIds, identityId])

  useEffect(() => {
    if (initializedParticipantScopeKey.current === participantScopeKey) return
    initializedParticipantScopeKey.current = participantScopeKey
    manualParticipantChoices.current.clear()
    setNearbyParticipantIds([])
    setAttestedParticipantKey(null)
    setSelectedParticipants(manualAttempt
      ? activeParticipantSelection(identityId, manualAttempt.presentParticipantIds, activeParticipantIds)
      : [identityId])
  }, [activeParticipantIds, identityId, manualAttempt, participantScopeKey])

  useEffect(() => {
    if (!viewerIsOrganizer || raid.state !== 'active' || !selectedPointId || !navigator.onLine) return
    let active = true
    const refresh = async () => {
      try {
        const response = await getRaidPointPresence(raid.id, selectedPointId)
        if (!active) return
        const nearbyIds = response.participants
          .filter(({ id, status }) => status === 'nearby' && activeParticipantIds.has(id))
          .map(({ id }) => id)
        setNearbyParticipantIds(nearbyIds)
        setSelectedParticipants((current) => participantSelectionAfterPresenceRefresh({
          identityId,
          selectedParticipantIds: current,
          nearbyParticipantIds: nearbyIds,
          manualParticipantChoices: manualParticipantChoices.current,
          activeParticipantIds,
          freezeSuggestions: Boolean(manualAttemptOperationId),
        }))
      } catch {
        // Manual participant selection remains available when live presence cannot refresh.
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [
    activeParticipantIds,
    identityId,
    manualAttemptOperationId,
    raid.id,
    raid.state,
    selectedPointId,
    viewerIsOrganizer,
  ])

  useEffect(() => {
    onPendingChange?.(local?.unsynced ?? 0)
  }, [local?.unsynced, onPendingChange])

  const attention = checkInAttentionState({
    claimIds: claims.map(({ id }) => id),
    fallbackIds: fallbacks.map(({ id }) => id),
    manualOperationId: manualAttempt?.operationId ?? null,
    unsynced: local?.unsynced ?? 0,
  })

  useEffect(() => {
    onAttentionChange?.(attention)
  }, [attention.actionKey, attention.count, attention.key, onAttentionChange])

  const refreshLocal = useCallback(async () => {
    const next = await getCheckInLocalState(identityId, raid.id)
    setLocal(next)
    setUnsyncedCheckInWork(next.unsynced)
    return next
  }, [identityId, raid.id, setUnsyncedCheckInWork])

  const refreshCanonicalExtras = useCallback(async () => {
    if (!navigator.onLine || document.visibilityState !== 'visible') return
    const result = await loadCheckInExtras({
      claims: () => listPendingClaims(raid.id),
      fallbacks: () => listPendingFallbacks(raid.id),
      gallery: () => listRaidMedia(raid.id),
    })
    if (result.claims) setClaims(result.claims)
    if (result.fallbacks) setFallbacks(result.fallbacks)
    if (result.gallery) setMedia(result.gallery.media)
  }, [raid.id])

  const flush = useCallback(async () => {
    if (!canMutate || !navigator.onLine) return
    if (replaying.current) {
      replayRequested.current = true
      return
    }
    replaying.current = true
    try {
      do {
        replayRequested.current = false
        for (let index = 0; index < 4; index += 1) {
          const result = await replayOneCheckInOrMedia({
            identityId,
            raidId: raid.id,
            holderTabId: senderTabId,
            online: navigator.onLine,
          })
          if (result.kind === 'idle' || result.kind === 'retryable' || result.kind === 'fence_lost') break
          if (result.kind === 'terminal') {
            setMessage(`Сервер отклонил локальную операцию: ${result.code}.`)
            break
          }
        }
        await refreshLocal()
        await refreshCanonicalExtras().catch(() => undefined)
        await onCanonicalRefresh()
      } while (replayRequested.current && canMutate && navigator.onLine)
    } finally {
      replaying.current = false
    }
  }, [canMutate, identityId, onCanonicalRefresh, raid.id, refreshCanonicalExtras, refreshLocal, senderTabId])

  useEffect(() => {
    void refreshLocal().then(() => void flush())
    void refreshCanonicalExtras().catch(() => undefined)
    const refreshTimer = window.setInterval(() => {
      void refreshCanonicalExtras().catch(() => undefined)
    }, 5_000)
    const resume = () => {
      if (document.visibilityState === 'visible') {
        void refreshLocal().then(() => void flush())
        void refreshCanonicalExtras().catch(() => undefined)
      }
    }
    window.addEventListener('online', resume)
    window.addEventListener('focus', resume)
    window.addEventListener('pageshow', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      setUnsyncedCheckInWork(0)
      window.clearInterval(refreshTimer)
      window.removeEventListener('online', resume)
      window.removeEventListener('focus', resume)
      window.removeEventListener('pageshow', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [flush, refreshCanonicalExtras, refreshLocal, setUnsyncedCheckInWork])

  const locate = async () => {
    if (busy || !navigator.onLine) return
    setBusy('locate')
    setMessage(null)
    try {
      const coordinate = await getOneShotCoordinate()
      const response = await getNearbyPoints(raid.id, coordinate.latitude, coordinate.longitude)
      setNearby(response.points)
      setSelectedPointId(response.points[0]?.pointSnapshotId ?? '')
      setMessage(response.points.length ? 'Сервер рассчитал ближайшие eligible точки.' : 'В пределах политики подходящих точек нет.')
    } catch {
      setMessage('Не удалось получить новую координату и список точек. Recorder cache не использовался.')
    } finally {
      setBusy(null)
    }
  }

  const submit = async () => {
    if (!selectedPointId || busy || !canMutate) return
    setBusy('checkin')
    setMessage(null)
    try {
      const evidence = await getOneShotCoordinate()
      const record = await enqueueCheckIn(identityId, raid.kabandaId, raid.id, {
        pointSnapshotId: selectedPointId,
        evidence,
        presentParticipantIds: validSelectedParticipants,
        organizerAttestation: viewerIsOrganizer && organizerAttestation,
      })
      if (!record) throw new Error('IDENTITY_CHANGED')
      await refreshLocal()
      setMessage('Попытка сохранена на телефоне. Канонический результат появится после server receipt.')
      void flush()
    } catch {
      setMessage('Попытку не удалось надёжно сохранить. Никакого pending check-in не показываем.')
    } finally {
      setBusy(null)
    }
  }

  const claimAction = async (claim: CheckInClaim, action: 'confirm' | 'decline') => {
    if (busy || !navigator.onLine) return
    const logical = `${claim.id}:${action}`
    const key = actionKeys.current.get(logical) ?? crypto.randomUUID()
    actionKeys.current.set(logical, key)
    setBusy(logical)
    try {
      await actOnClaim(raid.id, claim.id, action, key)
      actionKeys.current.delete(logical)
      await refreshCanonicalExtras()
      await onCanonicalRefresh()
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'Ответ не подтверждён. Повтор использует тот же ключ.')
    } finally {
      setBusy(null)
    }
  }

  const fallbackAction = async (fallback: CheckInFallback, action: 'confirm' | 'decline') => {
    if (busy || !navigator.onLine) return
    const logical = `${fallback.id}:${action}`
    const key = actionKeys.current.get(logical) ?? crypto.randomUUID()
    actionKeys.current.set(logical, key)
    setBusy(logical)
    try {
      await actOnFallback(raid.id, fallback.id, action, key)
      actionKeys.current.delete(logical)
      await refreshCanonicalExtras()
      await onCanonicalRefresh()
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'Ответ verifier не подтверждён.')
    } finally {
      setBusy(null)
    }
  }

  const addMedia = async (file: File | null) => {
    if (!file || busy || !canMutate) return
    const invalid = validateMediaFile(file)
    if (invalid) return setMessage(invalid)
    setBusy('media')
    try {
      const quota = await hasQuotaForMedia(file.size)
      if (quota === false) throw new Error('QUOTA')
      const sourceSha256 = await sha256Hex(file)
      const purpose = manualResponse ? 'fallback' as const : 'gallery' as const
      const draft = await persistMediaDraft({
        identityId,
        kabandaId: raid.kabandaId,
        raidId: raid.id,
        blob: file,
        sourceSha256,
        sizeBytes: file.size,
        contentType: file.type as 'image/jpeg' | 'image/png' | 'image/webp',
        caption: caption.trim().slice(0, 160) || null,
        purpose,
        attemptId: manualResponse?.attemptId ?? null,
      })
      if (!draft) throw new Error('IDENTITY_CHANGED')
      await refreshLocal()
      setMessage('Фото сохранено локально вместе с SHA-256. Upload capability в хранилище не попадёт.')
      void flush()
    } catch {
      setMessage('Фото не сохранено: проверьте место в хранилище, формат и активный аккаунт.')
    } finally {
      setBusy(null)
    }
  }

  const submitFallback = async () => {
    const selectedVerifierId = reservedFallback?.input.verifierUserId ?? verifierId
    if (!manualResponse || !fallbackMedia?.mediaId || !selectedVerifierId || selectedVerifierId === identityId || busy || !navigator.onLine) return
    const logical = `fallback:${manualResponse.attemptId}`
    setBusy(logical)
    try {
      const submission = await reserveFallbackSubmission(identityId, raid.id, manualResponse.attemptId, {
        attemptId: manualResponse.attemptId,
        mediaId: fallbackMedia.mediaId,
        verifierUserId: selectedVerifierId,
        presentParticipantIds: validSelectedParticipants,
        reason: fallbackReason.trim().slice(0, 240),
      })
      if (!submission) throw new Error('FALLBACK_ATTEMPT_MISSING')
      const response = await createFallback(raid.id, submission.operationId, submission.input)
      if (!(await settleFallbackSubmission(
        identityId,
        raid.id,
        manualResponse.attemptId,
        submission.operationId,
        response,
      ))) throw new Error('IDENTITY_CHANGED')
      await refreshLocal()
      setMessage('Fallback отправлен другому участнику. Credit появится только после его подтверждения.')
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'Fallback не подтверждён сервером.')
    } finally {
      setBusy(null)
    }
  }

  const toggleParticipant = (participantId: string) => {
    setSelectedParticipants((current) => {
      const selected = !current.includes(participantId)
      manualParticipantChoices.current.set(participantId, selected)
      return selected ? [...current, participantId] : current.filter((id) => id !== participantId)
    })
  }

  const selectedPrimaryKind = selectCheckInPrimary({
    hasPendingClaim: Boolean(pendingClaim),
    hasPendingFallback: Boolean(pendingFallback),
    hasManualAttempt: Boolean(manualResponse),
    hasAcceptedFallbackMedia: Boolean(fallbackMedia?.mediaId),
    hasOtherVerifier: Boolean(
      (reservedFallback?.input.verifierUserId ?? verifierId) &&
      (reservedFallback?.input.verifierUserId ?? verifierId) !== identityId,
    ),
    viewerCanCoordinate: viewerIsOrganizer,
    hasSelectedPoint: Boolean(selectedPointId),
  })
  const primaryKind = serverTailOnly && selectedPrimaryKind !== 'claim' && selectedPrimaryKind !== 'verify_fallback'
    ? null
    : selectedPrimaryKind
  const primary = primaryKind === 'claim' && pendingClaim
    ? { label: 'Подтвердить, что я был здесь', action: () => claimAction(pendingClaim, 'confirm') }
    : primaryKind === 'verify_fallback' && pendingFallback
      ? { label: 'Подтвердить ручную проверку', action: () => fallbackAction(pendingFallback, 'confirm') }
      : primaryKind === 'submit_fallback'
        ? { label: 'Отправить на ручную проверку', action: submitFallback }
        : primaryKind === 'check_in'
          ? { label: 'Отметиться у точки', action: submit }
            : primaryKind === 'locate' && presentation !== 'map-sheet'
            ? { label: 'Найти точку рядом', action: locate }
            : null
  const primaryRequiresOnline = Boolean(pendingClaim || pendingFallback || manualResponse || (viewerIsOrganizer && !selectedPointId))

  return (
    <section className={`${presentation === 'map-sheet' ? 'checkin-panel checkin-panel--map' : 'kb-card checkin-panel'}`}>
      <div className="kb-section-head">
        <div><p className="kb-kicker">Точка рейда</p><h2>{manualResponse ? 'Нужна ручная проверка' : 'Кто сейчас здесь?'}</h2></div>
        {local?.unsynced ? <span className="checkin-pending">Локально: {local.unsynced}</span> : null}
      </div>
      {presentation === 'map-sheet' && local?.unsynced ? <span className="checkin-pending">Локально: {local.unsynced}</span> : null}
      {presentation !== 'map-sheet' && <p className="kb-muted">{serverTailOnly ? 'В finalizing доступны только уже созданные server-side подтверждения.' : 'Для каждой попытки берём отдельную координату. Маршрут навигатора не используется как evidence.'}</p>}

      {pendingClaim && <div className="kb-notice"><strong>Вас отметил участник рейда.</strong><p>Подтвердите только своё присутствие или отклоните claim.</p></div>}
      {pendingFallback && <div className="kb-notice"><strong>Вас выбрали verifier.</strong><p>Подтверждение будет отдельным от автора попытки.</p></div>}

      {!manualResponse && effectiveNearby.length > 0 && (
        <fieldset className="checkin-points"><legend>{presentation === 'map-sheet' ? 'Точка рядом' : 'Eligible точки рядом'}</legend>{effectiveNearby.filter(({ creditedByTeam }) => presentation !== 'map-sheet' || !creditedByTeam).map((point) => (
          <label key={point.pointSnapshotId}><input type="radio" name="nearby-point" checked={selectedPointId === point.pointSnapshotId} onChange={() => setSelectedPointId(point.pointSnapshotId)} /><span><strong>{point.name}</strong><small>{Math.round(point.distanceMeters)} м · {point.creditedByTeam ? 'команда уже была' : 'новая для команды'}</small></span></label>
        ))}</fieldset>
      )}

      {(selectedPointId || manualResponse) && viewerIsOrganizer && (
        <fieldset className="checkin-participants"><legend>Кто остановился у точки</legend>{participants.map((participant) => (
          <label key={participant.id}><input type="checkbox" disabled={participant.id === identityId} checked={participant.id === identityId || validSelectedParticipants.includes(participant.id)} onChange={() => toggleParticipant(participant.id)} /><span>{participant.displayName}{participant.id === identityId ? ' · вы' : nearbyParticipantIds.includes(participant.id) ? ' · рядом автоматически' : ''}</span></label>
        ))}<small>Тех, чья свежая геопозиция попала в радиус 50 м, приложение отметило само. Остальных организатор может добавить вручную.</small></fieldset>
      )}

      {!viewerIsOrganizer && validSelectedParticipants.some((id) => id !== identityId) && !manualResponse && (
        <p className="kb-muted">Выбранные участники получат личный claim. Credit появится только после их подтверждения.</p>
      )}

      {viewerIsOrganizer && validSelectedParticipants.some((id) => id !== identityId) && !manualResponse && (
        <label className="checkin-attestation"><input type="checkbox" checked={organizerAttestation} onChange={(event) => setAttestedParticipantKey(event.target.checked ? selectedParticipantKey : null)} /><span><strong>Подтверждаю как организатор</strong><small>Подтверждение действует только для этого состава. При изменении списка его нужно поставить заново.</small></span></label>
      )}

      {manualResponse && (
        <div className="checkin-manual">
          <p className="kb-error">Причина сервера: {manualResponse.reason}. Географический check-in не принят.</p>
          <label>Причина ручной проверки<textarea disabled={Boolean(reservedFallback)} maxLength={240} rows={2} value={reservedFallback?.input.reason ?? fallbackReason} onChange={(event) => setFallbackReason(event.target.value)} /></label>
          <label>Другой verifier<select disabled={Boolean(reservedFallback)} value={reservedFallback?.input.verifierUserId ?? verifierId} onChange={(event) => setVerifierId(event.target.value)}><option value="">Выберите участника</option>{participants.filter(({ id }) => id !== identityId).map((participant) => <option key={participant.id} value={participant.id}>{participant.displayName}</option>)}</select></label>
          {reservedFallback && <p className="kb-muted">Повтор отправит сохранённый fallback с тем же idempotency key.</p>}
          {!fallbackMedia?.mediaId && <p className="kb-muted">Сначала добавьте и дождитесь принятия fallback-фото.</p>}
        </div>
      )}

      {message && <p className="kb-notice" role="status">{message}</p>}

      {primary && <button className="kb-primary raid-primary" type="button" disabled={Boolean(busy) || staleProjection || (primaryRequiresOnline && !navigator.onLine)} onClick={primary.action}>{busy ? 'Подтверждаем…' : primary.label}</button>}
      {pendingClaim && <button className="kb-text-action" type="button" disabled={Boolean(busy) || !navigator.onLine} onClick={() => claimAction(pendingClaim, 'decline')}>Это ошибка — отклонить</button>}
      {pendingFallback && <button className="kb-text-action" type="button" disabled={Boolean(busy) || !navigator.onLine} onClick={() => fallbackAction(pendingFallback, 'decline')}>Не могу подтвердить</button>}
      {Boolean(local?.unsynced) && <button className="kb-text-action" type="button" disabled={Boolean(busy) || !navigator.onLine} onClick={() => void flush()}>Синхронизировать сохранённое</button>}

      {canMutate && (
        <div className="checkin-media-compose">
          <label>Подпись к фото <input maxLength={160} value={caption} onChange={(event) => setCaption(event.target.value)} /></label>
          <label className="kb-link-button checkin-photo">{manualResponse ? 'Добавить fallback-фото' : 'Добавить фото'}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={Boolean(busy)} onChange={(event) => { void addMedia(event.target.files?.[0] ?? null); event.currentTarget.value = '' }} /></label>
        </div>
      )}

      {media.length > 0 && <div className="checkin-gallery">{media.map((item) => <figure key={item.id}><img src={mediaContentUrl(raid.id, item.id)} alt={item.caption || 'Фото рейда'} loading="lazy" /><figcaption>{item.caption || 'Без подписи'}</figcaption></figure>)}</div>}
    </section>
  )
}
