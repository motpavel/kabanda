import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CleanMapVariant } from './CleanMapVariant'
import { NavigatorVariant } from './NavigatorVariant'
import { TelemetryVariant } from './TelemetryVariant'
import './route-tracking-prototype.css'

const variants = [
  { name: 'Чистая карта', render: CleanMapVariant },
  { name: 'Штурман', render: NavigatorVariant },
  { name: 'Телеметрия', render: TelemetryVariant },
] as const

function initialVariant() {
  const parsed = Number(new URLSearchParams(window.location.search).get('v'))
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= variants.length ? parsed - 1 : 0
}

export function RouteTrackingPrototype() {
  const [current, setCurrent] = useState(initialVariant)
  const [mountKey, setMountKey] = useState(0)
  const pickerRef = useRef<HTMLElement>(null)
  const highlightRef = useRef<HTMLSpanElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const Variant = variants[current]!.render

  const moveHighlight = () => {
    const item = itemRefs.current[current]
    const highlight = highlightRef.current
    if (!item || !highlight) return
    highlight.style.width = `${item.offsetWidth}px`
    highlight.style.transform = `translateX(${item.offsetLeft}px)`
  }

  useLayoutEffect(moveHighlight, [current])

  useEffect(() => {
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => pickerRef.current?.setAttribute('data-ready', ''))
    })
    const onResize = () => moveHighlight()
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  const setActive = (index: number) => {
    if (index < 0 || index >= variants.length) return
    setCurrent(index)
    setMountKey((key) => key + 1)
    const url = new URL(window.location.href)
    url.searchParams.set('v', String(index + 1))
    window.history.replaceState(null, '', url)
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const numeric = Number.parseInt(event.key, 10)
      if (numeric >= 1 && numeric <= variants.length) setActive(numeric - 1)
      else if (event.key === 'ArrowRight') setActive((current + 1) % variants.length)
      else if (event.key === 'ArrowLeft') setActive((current - 1 + variants.length) % variants.length)
      else if (event.key === 'r' || event.key === 'R') setMountKey((key) => key + 1)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [current])

  return (
    <>
      <div id="stage" className="route-proto-stage"><Variant key={`${current}-${mountKey}`} /></div>
      <nav ref={pickerRef} className="proto-picker" data-position="top" aria-label="Prototype variants">
        <span ref={highlightRef} className="proto-picker-highlight" aria-hidden="true"></span>
        {variants.map((variant, index) => (
          <button
            key={variant.name}
            ref={(element) => { itemRefs.current[index] = element }}
            className="proto-picker-item"
            data-active={current === index ? '' : undefined}
            aria-current={current === index ? 'true' : undefined}
            onClick={() => setActive(index)}
          >{variant.name}</button>
        ))}
        <span className="proto-picker-divider" aria-hidden="true"></span>
        <button className="proto-picker-item proto-picker-replay" aria-label="Replay animation (R)" onClick={() => setMountKey((key) => key + 1)}>↻</button>
      </nav>
    </>
  )
}
