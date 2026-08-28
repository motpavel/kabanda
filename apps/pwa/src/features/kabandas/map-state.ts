import type { PointPresentation, ProviderState } from './types'

export function choosePointPresentation(
  requested: PointPresentation,
  providerState: ProviderState,
  webglAvailable: boolean,
): PointPresentation {
  if (requested === 'list' || providerState === 'failed' || !webglAvailable) return 'list'
  return 'map'
}

export function detectWebgl(): boolean {
  if (typeof document === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
  } catch {
    return false
  }
}
