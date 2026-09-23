import type { RefObject } from 'react'
import { useSheetViewport } from '../../../components/sheets/useSheetViewport'

export function usePointSheetViewport(ref: RefObject<HTMLElement | null>, onHeightChange: (height: number) => void) {
  useSheetViewport(ref, { hostSelector: '.rt-editor-shell', contentSelector: '.rt-point-sheet__body',
    allowMapSelector: '.rt-map--point-editing', position: 'frame', onHeightChange })
}
