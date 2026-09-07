import type { CheckInOutboxRecord, MediaDraftRecord } from '../offline/types'
import type { CheckInResponse, ManualVerificationReason } from './types'

export const TOO_FAR_MESSAGE = 'Вы отъехали слишком далеко. Вернитесь к точке или продолжайте к следующей.'

export function checkInRefusalMessage(reason: ManualVerificationReason | null): string {
  if (reason === 'too_far') return TOO_FAR_MESSAGE
  if (reason === 'location_expired') return 'Геолокация устарела. Дождитесь свежего GPS-сигнала и попробуйте снова.'
  return 'Не удалось точно определить ваше положение. Дождитесь GPS-сигнала или подтвердите посещение по фото.'
}

// Old clients stored every GPS refusal as mandatory manual verification. Keep
// the receipt/evidence, but do not let an abandoned too-far attempt trap a raid.
// An explicitly started photo verification must remain recoverable.
export function checkInNeedsAction(row: CheckInOutboxRecord, media: readonly MediaDraftRecord[]): boolean {
  if (row.status !== 'needs_action') return false
  const response = row.response as CheckInResponse | null
  if (response?.reason !== 'too_far') return true
  return Boolean(row.fallbackSubmission || media.some((draft) =>
    draft.identityId === row.identityId && draft.raidId === row.raidId &&
    draft.purpose === 'fallback' && draft.attemptId === response.attemptId,
  ))
}
