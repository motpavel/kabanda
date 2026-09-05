import { ApiError } from '../../lib/http'
import {
  attemptBucket,
  classifyDiagnosticError,
  emitAlphaDiagnostic,
  operationReference,
} from '../../lib/diagnostics'
import type { MediaDraftRecord } from '../offline/types'
import { createMediaIntent, submitCheckIn, uploadMediaContent } from './api'
import {
  acquireCheckInSenderLease,
  claimNextCheckIn,
  claimNextMediaDraft,
  rememberMediaIntent,
  replaceExpiredMediaIntent,
  retryCheckIn,
  retryMediaDraft,
  settleCheckIn,
  settleMediaDraft,
} from './store'

export type CheckInReplayResult =
  | { kind: 'idle' }
  | { kind: 'accepted' | 'needs_action'; operationId: string }
  | { kind: 'media'; operationId: string; mediaId: string }
  | { kind: 'replaced_expired_intent' }
  | { kind: 'retryable' }
  | { kind: 'terminal'; code: string }
  | { kind: 'fence_lost' }

function errorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : 'NETWORK_ERROR'
}

function isTerminal(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500 &&
    error.status !== 401 && error.status !== 408 && error.status !== 429 &&
    error.code !== 'MEDIA_PROCESSING'
}

type MediaFailureStage = 'intent' | 'upload' | 'processing'

function reportMediaFailure(
  media: MediaDraftRecord,
  stage: MediaFailureStage,
  error: unknown,
  terminal: boolean,
): void {
  if (!terminal && media.attempts < 3) return
  const code = errorCode(error)
  void operationReference(media.operationId).then((operationRef) =>
    emitAlphaDiagnostic(
      {
        kind: 'media_failed',
        stage: code === 'MEDIA_PROCESSING' ? 'processing' : stage,
        terminal,
        attemptBucket: attemptBucket(media.attempts),
        errorClass: classifyDiagnosticError(code),
      },
      { operationRef },
    ),
  )
}

export async function replayOneCheckInOrMedia(input: {
  identityId: string
  raidId: string
  holderTabId: string
  online: boolean
}): Promise<CheckInReplayResult> {
  if (!input.online) return { kind: 'idle' }
  const fence = await acquireCheckInSenderLease(input.identityId, input.raidId, input.holderTabId)
  if (!fence) return { kind: 'idle' }

  const checkIn = await claimNextCheckIn(fence)
  if (checkIn) {
    try {
      const response = await submitCheckIn(checkIn.raidId, checkIn.operationId, {
        pointSnapshotId: checkIn.pointSnapshotId,
        evidence: checkIn.evidence,
        presentParticipantIds: checkIn.presentParticipantIds,
        organizerAttestation: checkIn.organizerAttestation,
        ...(checkIn.repeatVisit ? { repeatVisit: true } : {}),
      })
      const settled = await settleCheckIn(fence, checkIn.operationId, response)
      return settled
        ? { kind: response.outcome === 'accepted' ? 'accepted' : 'needs_action', operationId: checkIn.operationId }
        : { kind: 'fence_lost' }
    } catch (error) {
      const terminal = isTerminal(error)
      const marked = await retryCheckIn(fence, checkIn.operationId, errorCode(error), terminal)
      return !marked ? { kind: 'fence_lost' } : terminal
        ? { kind: 'terminal', code: errorCode(error) }
        : { kind: 'retryable' }
    }
  }

  const media = await claimNextMediaDraft(fence)
  if (!media) return { kind: 'idle' }
  let stage: MediaFailureStage = 'intent'
  try {
    const intent = await createMediaIntent(media.raidId, media.operationId, {
      sourceSha256: media.sourceSha256,
      sizeBytes: media.sizeBytes,
      contentType: media.contentType,
      caption: media.caption,
      purpose: media.purpose,
      ...(media.attemptId ? { attemptId: media.attemptId } : {}),
    })
    if (!(await rememberMediaIntent(fence, media.operationId, intent.intentId))) return { kind: 'fence_lost' }
    stage = 'upload'
    const response = await uploadMediaContent(
      media.raidId,
      intent.intentId,
      intent.uploadCapability,
      media.sourceSha256,
      media.blob,
    )
    const settled = await settleMediaDraft(fence, media.operationId, response)
    return settled
      ? { kind: 'media', operationId: media.operationId, mediaId: response.media.id }
      : { kind: 'fence_lost' }
  } catch (error) {
    if (error instanceof ApiError && error.code === 'MEDIA_INTENT_EXPIRED') {
      const replaced = await replaceExpiredMediaIntent(fence, media.operationId)
      if (!replaced) reportMediaFailure(media, stage, error, true)
      return replaced ? { kind: 'replaced_expired_intent' } : { kind: 'fence_lost' }
    }
    const terminal = isTerminal(error)
    const marked = await retryMediaDraft(fence, media.operationId, errorCode(error), terminal)
    reportMediaFailure(media, stage, error, terminal)
    return !marked ? { kind: 'fence_lost' } : terminal
      ? { kind: 'terminal', code: errorCode(error) }
      : { kind: 'retryable' }
  }
}

export async function replayOneIssuedMedia(input: {
  identityId: string
  raidId: string
  holderTabId: string
  online: boolean
}): Promise<CheckInReplayResult> {
  if (!input.online) return { kind: 'idle' }
  const fence = await acquireCheckInSenderLease(input.identityId, input.raidId, input.holderTabId)
  if (!fence) return { kind: 'idle' }
  const media = await claimNextMediaDraft(fence, Date.now(), true)
  if (!media) return { kind: 'idle' }
  let stage: MediaFailureStage = 'intent'
  try {
    const intent = await createMediaIntent(media.raidId, media.operationId, {
      sourceSha256: media.sourceSha256,
      sizeBytes: media.sizeBytes,
      contentType: media.contentType,
      caption: media.caption,
      purpose: media.purpose,
      ...(media.attemptId ? { attemptId: media.attemptId } : {}),
    })
    if (!(await rememberMediaIntent(fence, media.operationId, intent.intentId))) return { kind: 'fence_lost' }
    stage = 'upload'
    const response = await uploadMediaContent(
      media.raidId,
      intent.intentId,
      intent.uploadCapability,
      media.sourceSha256,
      media.blob,
    )
    const settled = await settleMediaDraft(fence, media.operationId, response)
    return settled
      ? { kind: 'media', operationId: media.operationId, mediaId: response.media.id }
      : { kind: 'fence_lost' }
  } catch (error) {
    if (error instanceof ApiError && error.code === 'MEDIA_INTENT_EXPIRED') {
      const marked = await retryMediaDraft(fence, media.operationId, error.code, true)
      reportMediaFailure(media, stage, error, true)
      return marked ? { kind: 'terminal', code: error.code } : { kind: 'fence_lost' }
    }
    const terminal = isTerminal(error)
    const marked = await retryMediaDraft(fence, media.operationId, errorCode(error), terminal)
    reportMediaFailure(media, stage, error, terminal)
    return !marked ? { kind: 'fence_lost' } : terminal
      ? { kind: 'terminal', code: errorCode(error) }
      : { kind: 'retryable' }
  }
}
