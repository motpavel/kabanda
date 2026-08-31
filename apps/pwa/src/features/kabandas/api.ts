import { requestJson } from '../../lib/http'
import type {
  InvitePreview,
  CreatedInvite,
  KabandaMember,
  KabandaSummary,
  PointPage,
} from './types'

export async function listKabandas(): Promise<KabandaSummary[]> {
  const response = await requestJson<{ kabandas: KabandaSummary[] }>('/api/kabandas')
  return response.kabandas
}

export async function createKabanda(name: string, avatar: string, idempotencyKey: string): Promise<KabandaSummary> {
  const response = await requestJson<{ kabanda: KabandaSummary }>('/api/kabandas', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ name, avatar }),
  })
  return response.kabanda
}

export async function updateKabanda(
  kabandaId: string,
  input: { name?: string; coverImage?: string },
): Promise<KabandaSummary> {
  const response = await requestJson<{ kabanda: KabandaSummary }>(
    `/api/kabandas/${encodeURIComponent(kabandaId)}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  )
  return response.kabanda
}

export async function listMembers(kabandaId: string): Promise<KabandaMember[]> {
  const response = await requestJson<{ members: KabandaMember[] }>(
    `/api/kabandas/${encodeURIComponent(kabandaId)}/members`,
  )
  return response.members
}

export async function removeMember(kabandaId: string, memberId: string): Promise<void> {
  await requestJson<null>(
    `/api/kabandas/${encodeURIComponent(kabandaId)}/members/${encodeURIComponent(memberId)}`,
    { method: 'DELETE' },
  )
}

export async function leaveKabanda(kabandaId: string): Promise<void> {
  await requestJson<null>(`/api/kabandas/${encodeURIComponent(kabandaId)}/members/me`, {
    method: 'DELETE',
  })
}

export async function previewInvite(
  credential: { token: string } | { continuation: string } | { pending: true },
): Promise<InvitePreview> {
  const response = await requestJson<{ invite: InvitePreview }>('/api/invites/preview', {
    method: 'POST',
    body: JSON.stringify(credential),
  })
  return response.invite
}

export async function createInvite(kabandaId: string): Promise<CreatedInvite> {
  const response = await requestJson<{ invite: CreatedInvite }>(
    `/api/kabandas/${encodeURIComponent(kabandaId)}/invites`,
    {
      method: 'POST',
      body: JSON.stringify({ expiresInHours: 24 }),
    },
  )
  return response.invite
}

export async function acceptInvite(
  continuation: string,
  idempotencyKey: string,
  credentials?: { username: string; password: string },
): Promise<KabandaSummary> {
  const response = await requestJson<{ kabanda: KabandaSummary }>('/api/invites/accept', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ continuation, ...credentials }),
  })
  return response.kabanda
}

export async function listPoints(
  collectionId: string,
  bbox: readonly [number, number, number, number],
  limit = 100,
): Promise<PointPage> {
  const query = new URLSearchParams({
    collection: collectionId,
    bbox: bbox.join(','),
    limit: String(Math.min(Math.max(limit, 1), 200)),
  })
  return requestJson<PointPage>(`/api/points?${query}`)
}
