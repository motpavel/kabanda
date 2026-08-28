export type OutboxOperationKind = 'route.sample' | 'check-in.submit' | 'media.register'
export type OutboxOperationStatus = 'pending' | 'sending' | 'failed'

export interface LocalIdentity {
  userId: string
  activatedAt: string
}

export interface OutboxOperation {
  id: string
  identityId: string
  kind: OutboxOperationKind
  aggregateId: string
  payload: unknown
  createdAt: string
  status: OutboxOperationStatus
  attempts: number
  lastError?: string
}
