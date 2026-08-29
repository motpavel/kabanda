export interface AlphaPointValidationResult {
  pointCount: number
  fieldEvidenceCount: number
}

export function validateAlphaPointManifests(input: {
  manifestContent: string
  fieldEvidenceContent: string
}): AlphaPointValidationResult

export function validateAlphaPointManifestsWithArtifacts(input: {
  manifestContent: string
  fieldEvidenceContent: string
  evidenceRoot?: string | undefined
}): Promise<AlphaPointValidationResult>

export const expectedManifestHeader: string[]
export const expectedFieldEvidenceHeader: string[]
