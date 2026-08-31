import { useEffect, useMemo, useState, type ReactNode } from 'react'
import '@fontsource-variable/geist'
import { appPath } from '../../lib/paths'
import {
  parseRaidsDesignScreen,
  parseRaidsDesignVariant,
  participants,
  raidsDesignScreens,
  raidsDesignVariants,
  routeCards,
  type RaidsDesignScreen,
  type RaidsDesignVariant,
  type RouteCardData,
} from './model'
import './raids-design.css'

type IconName = 'arrow' | 'bike' | 'calendar' | 'chevron' | 'clock' | 'flag' | 'group' | 'home' | 'map' | 'pin' | 'route' | 'send' | 'team'

const iconPaths: Record<IconName, ReactNode> = {
  arrow: <path d="m15 18-6-6 6-6" />,
  bike: <><circle cx="6" cy="17" r="3" /><circle cx="18" cy="17" r="3" /><path d="m6 17 4-8h4l4 8M8 13h8M11 8l-1.5-2H7" /></>,
  calendar: <><rect x="4" y="5.5" width="16" height="14" rx="2" /><path d="M8 3v5m8-5v5M4 10h16M8 14h.01m4 0h.01m4 0h.01m-8 3h.01m4 0h.01" /></>,
  chevron: <path d="m9 18 6-6-6-6" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></>,
  flag: <><path d="M6 21V4" /><path d="M6 5c4-3 7 3 12 0v9c-5 3-8-3-12 0" /></>,
  group: <><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3.5 19c.4-4 2.2-6 5.5-6s5.1 2 5.5 6M14 14c3.6-.7 5.7 1 6.5 4.5" /></>,
  home: <><path d="m3.5 10.5 8.5-7.5 8.5 7.5" /><path d="M5.5 9.5v10h13v-10M9.5 19.5v-6h5v6" /></>,
  map: <><path d="m3.5 6 5-2.5 7 2.5 5-2.5v14l-5 2.5-7-2.5-5 2.5Z" /><path d="M8.5 3.5v14M15.5 6v14" /></>,
  pin: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
  route: <><circle cx="6" cy="17" r="2" /><circle cx="18" cy="7" r="2" /><path d="M8 17c6 0 2-10 8-10" /></>,
  send: <><path d="m21 3-8 18-3.5-8.5L1 9Z" /><path d="m9.5 12.5 5-4.5" /></>,
  team: <><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3.5 19c.4-4 2.2-6 5.5-6s5.1 2 5.5 6M14 14c3.6-.7 5.7 1 6.5 4.5" /></>,
}

function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return <svg aria-hidden="true" fill="none" height={size} viewBox="0 0 24 24" width={size}><g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">{iconPaths[name]}</g></svg>
}

function updatePrototypeUrl(screen: RaidsDesignScreen, variant: RaidsDesignVariant) {
  const url = new URL(window.location.href)
  if (screen === 'hub') url.searchParams.delete('screen')
  else url.searchParams.set('screen', screen)
  if (variant === 'active') url.searchParams.delete('variant')
  else url.searchParams.set('variant', variant)
  window.history.pushState({}, '', url)
}

export function RaidsDesignPrototype() {
  const initial = useMemo(() => new URLSearchParams(window.location.search), [])
  const [screen, setScreenState] = useState(() => parseRaidsDesignScreen(initial.get('screen')))
  const [variant, setVariantState] = useState(() => parseRaidsDesignVariant(initial.get('variant')))
  const [sheetOpen, setSheetOpen] = useState(false)
  const [route, setRoute] = useState(routeCards[0]!)
  const captureMode = initial.get('capture') === '1'

  useEffect(() => {
    const onPopState = () => {
      const query = new URLSearchParams(window.location.search)
      setScreenState(parseRaidsDesignScreen(query.get('screen')))
      setVariantState(parseRaidsDesignVariant(query.get('variant')))
      setSheetOpen(false)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const setScreen = (next: RaidsDesignScreen) => {
    updatePrototypeUrl(next, variant)
    setScreenState(next)
    setSheetOpen(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const setVariant = (next: RaidsDesignVariant) => {
    updatePrototypeUrl(screen, next)
    setVariantState(next)
  }

  return (
    <div className={`rdp-root${captureMode ? ' rdp-root--capture' : ''}`}>
      <main className="rdp-app">
        {screen === 'hub' && <RaidHub onNew={() => setSheetOpen(true)} onPreview={(next) => { setRoute(next); setScreen('preview') }} variant={variant} />}
        {screen === 'preview' && <RoutePreview onBack={() => setScreen('hub')} onRide={() => setScreen('participants')} route={route} />}
        {screen === 'participants' && <ParticipantPicker onBack={() => setScreen('preview')} onDone={() => setScreen('scheduled')} route={route} />}
        {screen === 'scheduled' && <ScheduledSuccess onBack={() => setScreen('hub')} route={route} />}
        <BottomNav onRaids={() => setScreen('hub')} />
      </main>
      {sheetOpen && <NewRaidSheet onClose={() => setSheetOpen(false)} onQuick={() => setScreen('participants')} onTemplate={() => setScreen('preview')} />}
      {initial.get('review') === '1' && <ReviewControls screen={screen} setScreen={setScreen} setVariant={setVariant} variant={variant} />}
    </div>
  )
}

function RaidHub({ onNew, onPreview, variant }: { onNew: () => void; onPreview: (route: RouteCardData) => void; variant: RaidsDesignVariant }) {
  const isEmpty = variant === 'empty'
  return (
    <div className="rdp-page rdp-page--hub">
      <header className="rdp-heading">
        <h1>Рейды</h1>
        <button className="rdp-new" onClick={onNew} type="button"><span aria-hidden="true">＋</span> Новый рейд</button>
      </header>

      {variant === 'loading' ? <LoadingHub /> : <>
        {!isEmpty && <section aria-labelledby="now-heading" className="rdp-section">
          <h2 id="now-heading">Сейчас</h2>
          {variant === 'idle' ? <IdleRaid onNew={onNew} /> : <ActiveRaid />}
        </section>}

        {!isEmpty && <section aria-labelledby="upcoming-heading" className="rdp-section">
          <h2 id="upcoming-heading">Предстоящие</h2>
          <div className="rdp-list-card">
            <UpcomingRow places="7 мест" subtitle="Сегодня в 19:00" title="По Ленина — вечерний заезд" />
            <UpcomingRow places="8 мест" subtitle="Завтра в 11:00" title="Центр Ижевска" />
          </div>
        </section>}

        <section aria-labelledby="routes-heading" className="rdp-section">
          <h2 id="routes-heading">Доступные маршруты</h2>
          {variant === 'catalog-error' ? <ErrorState /> : isEmpty ? <EmptyState onNew={onNew} /> : <div aria-label="Маршруты" className="rdp-routes">
            {routeCards.map((item, index) => <RouteCard index={index} key={item.id} onOpen={() => onPreview(item)} route={item} />)}
          </div>}
        </section>

        {!isEmpty && <section aria-labelledby="history-heading" className="rdp-section rdp-section--history">
          <h2 id="history-heading">История</h2>
          <div className="rdp-list-card">
            <HistoryRow meta="19,4 км · 14 точек" subtitle="17 мая 2025 · 10:30" title="Набережная кругом" />
            <HistoryRow meta="22,7 км · 16 точек" subtitle="10 мая 2025 · 11:00" title="Индустриальный маршрут" />
          </div>
        </section>}
      </>}
    </div>
  )
}

function ActiveRaid() {
  return <article className="rdp-active">
    <div className="rdp-active__top"><span className="rdp-live"><i /> Идёт сейчас</span><span className="rdp-pill">Лобби открыто</span></div>
    <div className="rdp-active__intro">
      <img alt="Вечерний Ижевск" src={appPath('brand/kabanda-team-cover.jpg')} />
      <div><h3>Северное кольцо</h3><p>По северу города с видами<br />на пруды и набережные</p></div>
    </div>
    <dl className="rdp-active__metrics">
      <Metric icon="clock" label="в пути" value="1 ч 40 мин" />
      <Metric icon="route" label="длина" value="24,6 км" />
      <Metric icon="flag" label="чек-поинтов" value="15 точек" />
      <Metric icon="group" label="участников" value="12 / 20" />
    </dl>
    <button className="rdp-active__cta" type="button"><Icon name="send" /> Вернуться в рейд</button>
  </article>
}

function Metric({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  return <div><Icon name={icon} size={24} /><span><dt>{value}</dt><dd>{label}</dd></span></div>
}

function IdleRaid({ onNew }: { onNew: () => void }) {
  return <div className="rdp-idle"><span><Icon name="bike" size={28} /></span><div><h3>Сейчас никто не едет</h3><p>Соберите Кабанду и начните новый рейд.</p></div><button onClick={onNew} type="button">Начать</button></div>
}

function UpcomingRow({ places, subtitle, title }: { places: string; subtitle: string; title: string }) {
  return <button className="rdp-row" type="button"><span className="rdp-row__icon"><Icon name="calendar" /></span><span className="rdp-row__copy"><strong>{title}</strong><small>{subtitle}</small></span><span className="rdp-row__badge">{places}</span><Icon name="chevron" size={19} /></button>
}

function HistoryRow({ meta, subtitle, title }: { meta: string; subtitle: string; title: string }) {
  return <button className="rdp-row rdp-row--history" type="button"><span className="rdp-row__icon rdp-row__icon--history"><Icon name="flag" /></span><span className="rdp-row__copy"><strong>{title}</strong><small>{subtitle}</small></span><span className="rdp-row__meta">{meta}</span><Icon name="chevron" size={19} /></button>
}

function RouteCard({ index, onOpen, route }: { index: number; onOpen: () => void; route: RouteCardData }) {
  return <article className={`rdp-route-card rdp-route-card--${index + 1}`}>
    <button aria-label={`Подробнее: ${route.title}`} className="rdp-route-card__visual" onClick={onOpen} type="button">
      <img alt="" src={appPath(index === 1 ? 'brand/kabanda-login-riders.jpg' : 'brand/kabanda-team-cover.jpg')} style={{ objectPosition: route.imagePosition }} />
      <span className="rdp-route-card__shade" />
      <span className="rdp-route-card__copy"><strong>{route.title}</strong><small><span><Icon name="route" size={15} /> {route.distance}</span><span><Icon name="flag" size={15} /> {route.points} точек</span></small></span>
    </button>
    <button className="rdp-route-card__more" onClick={onOpen} type="button"><span>Подробнее</span><Icon name="chevron" size={17} /></button>
  </article>
}

function ErrorState() { return <div className="rdp-state"><span><Icon name="route" /></span><h3>Маршруты не загрузились</h3><p>Проверьте соединение и попробуйте ещё раз.</p><button onClick={() => window.location.reload()} type="button">Повторить</button></div> }
function EmptyState({ onNew }: { onNew: () => void }) { return <div className="rdp-state"><span><Icon name="flag" /></span><h3>Пока нет маршрутов</h3><p>Можно начать свободный рейд без готового маршрута.</p><button onClick={onNew} type="button">Новый рейд</button></div> }

function LoadingHub() { return <div aria-busy="true" aria-label="Загрузка рейдов" className="rdp-loading"><i /><i /><i /><i /></div> }

function RoutePreview({ onBack, onRide, route }: { onBack: () => void; onRide: () => void; route: RouteCardData }) {
  return <div className="rdp-page rdp-detail">
    <header className="rdp-subhead"><button aria-label="Назад к рейдам" onClick={onBack} type="button"><Icon name="arrow" /></button><strong>Маршрут</strong><span /></header>
    <div className="rdp-preview-hero"><img alt="Кабанда едет по Ижевску" src={appPath('brand/kabanda-team-cover.jpg')} /><span /></div>
    <section className="rdp-preview-copy"><p className="rdp-eyebrow">Готовый маршрут</p><h1>{route.title}</h1><p>{route.description}. Спокойный темп и несколько удобных остановок по пути.</p>
      <dl><div><dt>{route.distance}</dt><dd>длина</dd></div><div><dt>{route.points}</dt><dd>точек</dd></div><div><dt>~ 2 ч</dt><dd>в пути</dd></div></dl>
      <div className="rdp-mini-map" aria-label="Схема маршрута" role="img"><svg viewBox="0 0 320 150"><path d="M18 120c55-8 52-72 107-62 40 7 48 64 99 38 27-14 34-45 77-58" /></svg><i /><i /><i /></div>
      <h2>Что увидим</h2><ul className="rdp-points"><li><Icon name="pin" />Набережная Ижевского пруда</li><li><Icon name="pin" />Летний сад и ротонда</li><li><Icon name="pin" />Северная часть города</li></ul>
    </section>
    <div className="rdp-sticky-action"><button onClick={onRide} type="button"><Icon name="bike" /> Поехать по маршруту</button></div>
  </div>
}

function ParticipantPicker({ onBack, onDone, route }: { onBack: () => void; onDone: () => void; route: RouteCardData }) {
  const [selected, setSelected] = useState(() => new Set(['pavel', 'motor']))
  const toggle = (id: string) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  return <div className="rdp-page rdp-detail rdp-participants">
    <header className="rdp-subhead"><button aria-label="Назад к маршруту" onClick={onBack} type="button"><Icon name="arrow" /></button><strong>Участники</strong><span /></header>
    <section className="rdp-participants__intro"><p className="rdp-eyebrow">Новый рейд</p><h1>Кто поедет?</h1><p>{route.title} · отметьте тех, кто уже собирается.</p></section>
    <fieldset><legend>Состав Кабанды</legend>{participants.map((person) => <label key={person.id}><span className="rdp-avatar">{person.initial}</span><span><strong>{person.name}</strong><small>{person.role}</small></span><input checked={selected.has(person.id)} onChange={() => toggle(person.id)} type="checkbox" /></label>)}</fieldset>
    <div className="rdp-sticky-action"><button disabled={selected.size === 0} onClick={onDone} type="button">Продолжить · {selected.size}</button></div>
  </div>
}

function ScheduledSuccess({ onBack, route }: { onBack: () => void; route: RouteCardData }) {
  return <div className="rdp-page rdp-success"><span><Icon name="flag" size={34} /></span><p className="rdp-eyebrow">Всё готово</p><h1>Рейд собран</h1><p>{route.title} появился в предстоящих. Участники увидят его в Кабанде.</p><button onClick={onBack} type="button">Вернуться к рейдам</button></div>
}

function NewRaidSheet({ onClose, onQuick, onTemplate }: { onClose: () => void; onQuick: () => void; onTemplate: () => void }) {
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }; document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey) }, [onClose])
  return <div className="rdp-sheet-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }} role="presentation"><section aria-labelledby="new-raid-title" aria-modal="true" className="rdp-sheet" role="dialog"><span className="rdp-sheet__handle" /><div className="rdp-sheet__head"><div><p className="rdp-eyebrow">Новый рейд</p><h2 id="new-raid-title">Как поедем?</h2></div><button aria-label="Закрыть" onClick={onClose} type="button">×</button></div><button className="rdp-sheet-choice" onClick={onQuick} type="button"><span><Icon name="send" /></span><span><strong>Поехали сейчас</strong><small>Без маршрута и расписания</small></span><Icon name="chevron" /></button><button className="rdp-sheet-choice" onClick={onTemplate} type="button"><span><Icon name="route" /></span><span><strong>Выбрать маршрут</strong><small>Готовые точки и расстояние</small></span><Icon name="chevron" /></button></section></div>
}

function BottomNav({ onRaids }: { onRaids: () => void }) {
  return <nav aria-label="Основные разделы" className="rdp-tabbar"><a href={appPath('app')}><Icon name="home" /><span>Главная</span></a><a href={`${appPath('app')}?tab=map`}><Icon name="map" /><span>Карта</span></a><button aria-current="page" onClick={onRaids} type="button"><Icon name="flag" /><span>Рейды</span></button><a href={`${appPath('app')}?tab=kabanda`}><Icon name="team" /><span>Кабанда</span></a></nav>
}

function ReviewControls({ screen, setScreen, setVariant, variant }: { screen: RaidsDesignScreen; setScreen: (value: RaidsDesignScreen) => void; setVariant: (value: RaidsDesignVariant) => void; variant: RaidsDesignVariant }) {
  return <aside aria-label="Панель ревью" className="rdp-review"><label>Экран<select onChange={(event) => setScreen(event.target.value as RaidsDesignScreen)} value={screen}>{raidsDesignScreens.map((item) => <option key={item}>{item}</option>)}</select></label><label>Состояние<select onChange={(event) => setVariant(event.target.value as RaidsDesignVariant)} value={variant}>{raidsDesignVariants.map((item) => <option key={item}>{item}</option>)}</select></label></aside>
}
