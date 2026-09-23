import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  beginLocationRequest,
  invalidateLocationRequests,
  isCurrentLocationRequest,
  RaidTemplateMapControls,
  raidTemplateSelectedPointCenter,
  raidTemplatePointAtMapCenter,
} from './RaidTemplateEditorMap'

describe('raid template editor map controls', () => {
  it('invalidates a pending location request before its callback can use a destroyed map', () => {
    const generationRef = { current: 0 }
    const requestGeneration = beginLocationRequest(generationRef)

    expect(isCurrentLocationRequest(generationRef, requestGeneration)).toBe(true)
    invalidateLocationRequests(generationRef)
    expect(isCurrentLocationRequest(generationRef, requestGeneration)).toBe(false)
  })

  it('reads a valid point from the current map center', () => {
    let centerReads = 0
    const point = raidTemplatePointAtMapCenter({
      getCenter: () => {
        centerReads += 1
        return [56.8528, 53.2045]
      },
    })

    expect(centerReads).toBe(1)
    expect(point).toEqual({ latitude: 56.8528, longitude: 53.2045 })
  })

  it('centres a selected point in the map area left above the sheet', () => {
    const point = { latitude: 56.861663, longitude: 53.202876 }
    const center = raidTemplateSelectedPointCenter(point, 15, 844, 340)

    expect(center[0]).toBeLessThan(point.latitude)
    expect(center[0]).toBeGreaterThan(point.latitude - 1)
    expect(center[1]).toBe(point.longitude)
  })

  it('keeps only zoom and location controls with centered SVG icons', () => {
    const markup = renderToStaticMarkup(<RaidTemplateMapControls
      locating={false} onChangeZoom={() => undefined} onLocate={() => undefined} zoom={12}
    />)
    expect(markup).toContain('Приблизить карту')
    expect(markup).toContain('Отдалить карту')
    expect(markup).not.toContain('Добавить точку в центре')
  })
})
