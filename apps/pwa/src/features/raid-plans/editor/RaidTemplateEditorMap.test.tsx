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

  it('exposes the add-at-center action to keyboard users and disables it at the point limit', () => {
    const renderControls = (canAddPoint: boolean) => renderToStaticMarkup(<RaidTemplateMapControls
      canAddPoint={canAddPoint}
      locating={false}
      onAddPointAtCenter={() => undefined}
      onChangeZoom={() => undefined}
      onLocate={() => undefined}
      zoom={12}
    />)

    const enabledMarkup = renderControls(true)
    expect(enabledMarkup).toContain('aria-label="Добавить точку в центре карты"')
    expect(enabledMarkup).not.toContain('class="rt-map__add-point" disabled=""')

    const disabledMarkup = renderControls(false)
    expect(disabledMarkup).toContain('class="rt-map__add-point" disabled=""')
  })
})
