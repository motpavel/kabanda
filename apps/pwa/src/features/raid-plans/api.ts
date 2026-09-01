import { requestJson } from '../../lib/http'
import type {
  CreateRaidTemplateInput,
  CreateRaidTemplateResponse,
  RaidTemplate,
  RaidTemplateSummary,
} from './types'

export async function listRaidTemplates(kabandaId: string): Promise<RaidTemplateSummary[]> {
  const response = await requestJson<{ templates: RaidTemplateSummary[] }>(
    `/api/kabandas/${encodeURIComponent(kabandaId)}/raid-templates`,
  )
  return response.templates
}

export function getRaidTemplate(templateId: string): Promise<{ template: RaidTemplate }> {
  return requestJson<{ template: RaidTemplate }>(
    `/api/raid-templates/${encodeURIComponent(templateId)}`,
  )
}

export function createRaidTemplate(
  kabandaId: string,
  input: CreateRaidTemplateInput,
  idempotencyKey: string,
): Promise<CreateRaidTemplateResponse> {
  return requestJson<CreateRaidTemplateResponse>(
    `/api/kabandas/${encodeURIComponent(kabandaId)}/raid-templates`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    },
  )
}

export function reverseGeocodeTemplatePoint(latitude: number, longitude: number): Promise<{
  name: string
  address: string
  source: 'openstreetmap'
}> {
  const query = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude) })
  return requestJson(`/api/geocoding/reverse?${query.toString()}`)
}
