import type { YandexMap, YandexTileLayer } from '../yandex-maps'

/** Local, opt-in counters only. No locations, URLs, identities or uploads. */
export function mapDiagnostics(map: YandexMap, container: HTMLElement) {
  let panel: HTMLDivElement | undefined, text: HTMLPreElement | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  let layer: YandexTileLayer | undefined
  let state = 'Проверка', worker = 'не проверен'
  let clicks = 0, lastClick = 0, started = 0, settled: number | undefined
  let requests = 0, prepared = 0, hits = 0, misses = 0, failures = 0, lastRead = 0
  const visible = () => container.getBoundingClientRect().width > 0 && container.getBoundingClientRect().height > 0
  const render = () => {
    if (!text) return
    ready()
    const readyStatus = layer?.getTileStatus?.()
    text.textContent = `Карта · ${typeof __APP_VERSION__ === 'undefined' ? 'test' : __APP_VERSION__}\nСлой: ${state}\nSW: ${worker}\nГотово: ${readyStatus ? `${readyStatus.readyTileNumber}/${readyStatus.totalTileNumber}` : '—'}\nURL / подготовлено: ${requests} / ${prepared}\nКэш / сеть / ошибки: ${hits} / ${misses} / ${failures}\nПоследний ответ: ${lastRead} мс\nПосле движения до готовности: ${settled === undefined ? '—' : `${settled} мс`}\nТолько текущий сеанс, без отправки`
  }
  const close = () => { clearInterval(interval); interval = undefined; panel?.remove(); panel = undefined; text = undefined }
  const open = () => {
    if (panel || !visible()) return
    panel = document.createElement('div')
    panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', 'Диагностика карты')
    Object.assign(panel.style, { position: 'fixed', top: 'calc(env(safe-area-inset-top, 0px) + 62px)', left: '8px', zIndex: '10000', maxWidth: 'calc(100vw - 16px)', background: '#fff', color: '#222', padding: '10px', borderRadius: '12px', boxShadow: '0 4px 18px #0003' })
    text = document.createElement('pre'); Object.assign(text.style, { font: '11px/1.5 monospace', margin: '0', whiteSpace: 'pre-wrap' })
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Закрыть диагностику'; button.onclick = close
    panel.append(text, button); document.body.append(panel)
    requests = prepared = hits = misses = failures = lastRead = 0; settled = undefined
    const controller = navigator.serviceWorker?.controller
    if (controller) {
      const channel = new MessageChannel()
      const timeout = setTimeout(() => channel.port1.close(), 2000)
      channel.port1.onmessage = event => { worker = typeof event.data?.build === 'string' ? event.data.build : 'неизвестен'; clearTimeout(timeout); channel.port1.close(); render() }
      controller.postMessage({ type: 'KABANDA_SW_BUILD' }, [channel.port2])
    } else worker = 'нет контроллера'
    interval = setInterval(() => { if (!visible()) close(); else render() }, 250); render()
  }
  const click = (event: Event) => {
    if (!(event.target instanceof Element) || !visible()) return
    const tab = event.target.closest('.kb-app-tabbar a[aria-current="page"]')
    if (!tab || new URL((tab as HTMLAnchorElement).href).searchParams.get('tab') !== 'map') return
    const now = performance.now(); clicks = now - lastClick < 900 ? clicks + 1 : 1; lastClick = now
    if (clicks === 5) { clicks = 0; if (panel) close(); else open() }
  }
  const moving = () => { if (panel) { started = performance.now(); settled = undefined } }
  const ready = () => {
    if (!panel || !started) return
    const status = layer?.getTileStatus?.()
    if (status && status.totalTileNumber > 0 && status.readyTileNumber === status.totalTileNumber) {
      settled ??= Math.round(performance.now() - started)
    } else settled = undefined
  }
  document.addEventListener('click', click)
  map.events.add('boundschange', moving)
  const setLayer = (next: YandexTileLayer) => { layer?.events?.remove?.('tileloadchange', ready); layer = next; layer.events?.add('tileloadchange', ready) }
  return {
    active: () => Boolean(panel),
    state: (next: string) => { state = next },
    layer: setLayer,
    request: (isPrepared: boolean) => { if (panel) { requests++; if (isPrepared) prepared++ } },
    response: (source: string, ms: number) => { if (panel && Number.isFinite(ms)) { if (source === 'hit') hits++; else if (source === 'miss') misses++; else failures++; lastRead = Math.round(ms) } },
    dispose: () => { close(); document.removeEventListener('click', click); map.events.remove?.('boundschange', moving); layer?.events?.remove?.('tileloadchange', ready) },
  }
}
