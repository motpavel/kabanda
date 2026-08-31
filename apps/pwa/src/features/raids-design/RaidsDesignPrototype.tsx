import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import '@fontsource-variable/manrope'
import { appPath } from '../../lib/paths'
import {
  parseRaidsDesignScreen,
  parseRaidsDesignVariant,
  parseParticipantDesignState,
  longParticipantList,
  participantDesignStates,
  participants,
  raidsDesignScreens,
  raidsDesignVariants,
  routeCards,
  type RaidsDesignScreen,
  type RaidsDesignVariant,
  type ParticipantDesignState,
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

type ParticipantOrigin = 'quick' | 'route' | 'schedule'

const routePreviewPoints = [
  'Набережная Ижевского пруда',
  'Летний сад и ротонда',
  'Монумент дружбы народов',
  'Площадь оружейников',
  'Михайловская колонна',
  'Северная набережная',
  'Парк имени Кирова',
  'Пешеходный мост',
  'Смотровая у пруда',
  'Улица Песочная',
  'Северный сквер',
  'Парк Космонавтов',
  'Тихая велодорожка',
  'Городская эспланада',
  'Финиш у набережной',
]

function parseParticipantOrigin(value: string | null): ParticipantOrigin {
  return value === 'quick' || value === 'schedule' ? value : 'route'
}

function updatePrototypeUrl(screen: RaidsDesignScreen, variant: RaidsDesignVariant, routeId?: string, origin?: ParticipantOrigin) {
  const url = new URL(window.location.href)
  if (screen === 'hub') url.searchParams.delete('screen')
  else url.searchParams.set('screen', screen)
  if (variant === 'active') url.searchParams.delete('variant')
  else url.searchParams.set('variant', variant)
  if (routeId && (screen === 'preview' || screen === 'participants' || screen === 'scheduled')) url.searchParams.set('route', routeId)
  else url.searchParams.delete('route')
  if (origin && (screen === 'participants' || screen === 'scheduled')) url.searchParams.set('origin', origin)
  else url.searchParams.delete('origin')
  if (screen !== 'participants') url.searchParams.delete('participant')
  window.history.pushState({}, '', url)
}

export function RaidsDesignPrototype() {
  const initial = useMemo(() => new URLSearchParams(window.location.search), [])
  const [screen, setScreenState] = useState(() => parseRaidsDesignScreen(initial.get('screen')))
  const [variant, setVariantState] = useState(() => parseRaidsDesignVariant(initial.get('variant')))
  const [participantState, setParticipantState] = useState(() => parseParticipantDesignState(initial.get('participant')))
  const [sheetOpen, setSheetOpen] = useState(false)
  const [route, setRoute] = useState(() => routeCards.find((item) => item.id === initial.get('route')) ?? routeCards[0]!)
  const [participantOrigin, setParticipantOrigin] = useState<ParticipantOrigin>(() => parseParticipantOrigin(initial.get('origin')))
  const newRaidButtonRef = useRef<HTMLButtonElement>(null)
  const captureMode = initial.get('capture') === '1'
  const textScaleMode = initial.get('text') === '120'

  useEffect(() => {
    const onPopState = () => {
      const query = new URLSearchParams(window.location.search)
      setScreenState(parseRaidsDesignScreen(query.get('screen')))
      setVariantState(parseRaidsDesignVariant(query.get('variant')))
      setParticipantState(parseParticipantDesignState(query.get('participant')))
      setRoute(routeCards.find((item) => item.id === query.get('route')) ?? routeCards[0]!)
      setParticipantOrigin(parseParticipantOrigin(query.get('origin')))
      setSheetOpen(false)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const setScreen = (next: RaidsDesignScreen, options?: { origin?: ParticipantOrigin; route?: RouteCardData }) => {
    const nextRoute = options?.route ?? route
    const nextOrigin = options?.origin ?? participantOrigin
    if (options?.route) setRoute(options.route)
    if (options?.origin) setParticipantOrigin(options.origin)
    updatePrototypeUrl(next, variant, nextRoute.id, nextOrigin)
    setScreenState(next)
    setSheetOpen(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const setVariant = (next: RaidsDesignVariant) => {
    updatePrototypeUrl(screen, next, route.id, participantOrigin)
    setVariantState(next)
  }

  const closeSheet = () => {
    setSheetOpen(false)
    requestAnimationFrame(() => newRaidButtonRef.current?.focus())
  }

  return (
    <div className={`rdp-root${captureMode ? ' rdp-root--capture' : ''}${textScaleMode ? ' rdp-root--text-120' : ''}${screen === 'participants' || screen === 'schedule' || screen === 'scheduled' ? ' rdp-root--flow' : ''}`}>
      <main className="rdp-app">
        {screen === 'hub' && <RaidHub newButtonRef={newRaidButtonRef} onNew={() => setSheetOpen(true)} onPreview={(next) => setScreen('preview', { origin: 'route', route: next })} variant={variant} />}
        {screen === 'preview' && <RoutePreview onBack={() => setScreen('hub')} onRide={() => setScreen('participants', { origin: 'route' })} route={route} variant={variant} />}
        {screen === 'schedule' && <ScheduleRaid onBack={() => setScreen('hub')} onContinue={() => setScreen('participants', { origin: 'schedule' })} />}
        {screen === 'participants' && <ParticipantPicker designState={participantState} onBack={() => setScreen(participantOrigin === 'route' ? 'preview' : participantOrigin === 'schedule' ? 'schedule' : 'hub')} onDone={() => setScreen('scheduled')} origin={participantOrigin} route={route} />}
        {screen === 'scheduled' && <ScheduledSuccess onBack={() => setScreen('hub')} origin={participantOrigin} route={route} />}
        {(screen === 'hub' || screen === 'preview') && <BottomNav onRaids={() => setScreen('hub')} />}
      </main>
      {sheetOpen && <NewRaidSheet onClose={closeSheet} onQuick={() => setScreen('participants', { origin: 'quick' })} onSchedule={() => setScreen('schedule')} />}
      {initial.get('review') === '1' && <ReviewControls participantState={participantState} screen={screen} setParticipantState={setParticipantState} setScreen={setScreen} setVariant={setVariant} variant={variant} />}
    </div>
  )
}

function RaidHub({ newButtonRef, onNew, onPreview, variant }: { newButtonRef: RefObject<HTMLButtonElement | null>; onNew: () => void; onPreview: (route: RouteCardData) => void; variant: RaidsDesignVariant }) {
  const isEmpty = variant === 'empty'
  const upcomingEmpty = isEmpty || variant === 'upcoming-empty'
  return (
    <div className="rdp-page rdp-page--hub">
      <header className="rdp-heading">
        <h1>Рейды</h1>
        <button className="rdp-new" onClick={onNew} ref={newButtonRef} type="button"><span aria-hidden="true">＋</span> Новый рейд</button>
      </header>

      {variant === 'offline' && <div className="rdp-stale" role="status"><Icon name="clock" /><span><strong>Данные сохранены на телефоне</strong><small>Показана версия на 18:42. Обновим, когда появится сеть.</small></span></div>}

      {variant === 'loading' ? <LoadingHub /> : <>
        {!isEmpty && <section aria-labelledby="now-heading" className="rdp-section">
          <h2 id="now-heading">Сейчас</h2>
          {variant === 'idle' ? <IdleRaid onNew={onNew} /> : <ActiveRaid />}
        </section>}

        <section aria-labelledby="upcoming-heading" className="rdp-section">
          <h2 id="upcoming-heading">Предстоящие</h2>
          {upcomingEmpty ? <CompactEmpty icon="calendar" text="Пока ничего не запланировано" /> : <div className="rdp-list-card">
            {variant === 'upcoming-cases' ? <>
              <UpcomingRow action="Открыть" avatars={[]} id="lenina-evening" places="0 заявок" subtitle="Понедельник, 31 августа · Сегодня · 19:00" title="По Ленина — очень длинное название вечернего заезда" />
              <UpcomingRow action="Начать" id="city-center" places="4 едут" subtitle="Вторник, 1 сентября · Завтра · 11:00" title="Центр Ижевска" />
            </> : <>
              <UpcomingRow id="lenina-evening" places="7 мест" subtitle="Понедельник, 31 августа · Сегодня · 19:00" title="По Ленина — вечерний заезд" />
              <UpcomingRow id="city-center" places="8 мест" subtitle="Вторник, 1 сентября · Завтра · 11:00" title="Центр Ижевска" />
            </>}
          </div>}
        </section>

        <section aria-labelledby="routes-heading" className="rdp-section">
          <h2 id="routes-heading">Доступные маршруты</h2>
          {variant === 'catalog-error' || variant === 'partial-error' ? <ErrorState /> : isEmpty ? <EmptyState onNew={onNew} /> : <div aria-label="Маршруты" className="rdp-routes">
            {routeCards.map((item, index) => <RouteCard index={index} key={item.id} noCover={variant === 'fallback' && index === 2} onOpen={() => onPreview(item)} route={item} />)}
          </div>}
        </section>

        <section aria-labelledby="history-heading" className="rdp-section rdp-section--history">
          <h2 id="history-heading">История</h2>
          {isEmpty ? <CompactEmpty icon="flag" text="Первый рейд ещё впереди" /> : <div className="rdp-list-card">
            <HistoryRow id="embankment-loop" meta="19,4 км · 14 точек" subtitle="17 мая 2025 · 10:30 · 1 ч 32 мин · Вы участвовали · 4 человека" title="Набережная кругом" />
            <HistoryRow id="industrial-route" meta="22,7 км · 16 точек" subtitle="10 мая 2025 · 11:00 · 1 ч 48 мин · 5 участников" title="Индустриальный маршрут" />
          </div>}
        </section>
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
      <div className="rdp-active__people" aria-label="12 активных участников из 20: Павел, мотор, Аня и ещё 9"><Icon name="group" /><span><dt>12 / 20</dt><dd>участников</dd></span></div>
    </dl>
    <button className="rdp-active__cta" type="button"><Icon name="send" /> Вернуться в рейд</button>
  </article>
}

function Metric({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  return <div><Icon name={icon} size={24} /><span><dt>{value}</dt><dd>{label}</dd></span></div>
}

function IdleRaid({ onNew }: { onNew: () => void }) {
  return <div className="rdp-idle"><span><Icon name="bike" size={28} /></span><div><h3>Сегодня ещё не катались</h3><p>Соберите Кабанду и начните новый рейд.</p></div><button onClick={onNew} type="button">Поехали</button></div>
}

function UpcomingRow({ action = 'Открыть', avatars = ['П', 'М', '+3'], id, places, subtitle, title }: { action?: string; avatars?: string[]; id: string; places: string; subtitle: string; title: string }) {
  return <a aria-label={`${action}: ${title}`} className="rdp-row" href={`${appPath('app')}?tab=raids&raid=${id}`}><span className="rdp-row__icon"><Icon name="calendar" /></span><span className="rdp-row__copy"><strong>{title}</strong><small><span>{subtitle}</span>{avatars.length > 0 && <span aria-label={`${avatars.length > 2 ? '5' : avatars.length} участников`} className="rdp-row__avatars">{avatars.map((avatar) => <i aria-hidden="true" key={avatar}>{avatar}</i>)}</span>}</small></span><span className="rdp-row__action"><span className="rdp-row__badge">{places}</span><small>{action}</small><Icon name="chevron" size={19} /></span></a>
}

function HistoryRow({ id, meta, subtitle, title }: { id: string; meta: string; subtitle: string; title: string }) {
  return <a aria-label={`Открыть результат: ${title}`} className="rdp-row rdp-row--history" href={`${appPath('app')}?tab=raids&raid=${id}`}><span className="rdp-row__icon rdp-row__icon--history"><Icon name="flag" /></span><span className="rdp-row__copy"><strong>{title}</strong><small>{subtitle}</small></span><span className="rdp-row__meta">{meta}</span><Icon name="chevron" size={19} /></a>
}

function RouteCard({ index, noCover = false, onOpen, route }: { index: number; noCover?: boolean; onOpen: () => void; route: RouteCardData }) {
  return <a aria-label={`Открыть маршрут: ${route.title}. ${route.description}. ${route.distance}, около 2 часов, ${route.points} точек`} className={`rdp-route-card rdp-route-card--${index + 1}`} href={`?screen=preview&route=${route.id}`} onClick={(event) => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onOpen() } }}>
    <span className={`rdp-route-card__visual${noCover ? ' rdp-route-card__visual--fallback' : ''}`}>
      {noCover ? <span className="rdp-route-fallback"><Icon name="route" size={34} /><small>Фото появится позже</small></span> : <img alt="" src={appPath(index === 1 ? 'brand/kabanda-login-riders.jpg' : 'brand/kabanda-team-cover.jpg')} style={{ objectPosition: route.imagePosition }} />}
      <span className="rdp-route-card__shade" />
      <span className="rdp-route-card__copy"><strong>{route.title}</strong><small><span><Icon name="route" size={12} /> {route.distance}</span><span><Icon name="clock" size={12} /> ~2ч</span><span><Icon name="flag" size={12} /> {route.points}</span></small></span>
    </span>
    <span className="rdp-route-card__more"><span>Подробнее</span><Icon name="chevron" size={17} /></span>
  </a>
}

function CompactEmpty({ icon, text }: { icon: IconName; text: string }) { return <div className="rdp-compact-empty"><span><Icon name={icon} /></span><strong>{text}</strong></div> }
function ErrorState() { return <div className="rdp-state" role="alert"><span><Icon name="route" /></span><h3>Каталог временно недоступен</h3><p>Другие разделы работают. Проверьте соединение и попробуйте ещё раз.</p><button onClick={() => window.location.reload()} type="button">Повторить загрузку</button></div> }
function EmptyState({ onNew }: { onNew: () => void }) { return <div className="rdp-state"><span><Icon name="flag" /></span><h3>Пока нет маршрутов</h3><p>Можно начать свободный рейд без готового маршрута.</p><button onClick={onNew} type="button">Новый рейд</button></div> }

function LoadingHub() { return <div aria-busy="true" aria-label="Загрузка рейдов" className="rdp-loading"><i /><i /><i /><i /></div> }

function RoutePreview({ onBack, onRide, route, variant }: { onBack: () => void; onRide: () => void; route: RouteCardData; variant: RaidsDesignVariant }) {
  const unavailable = variant === 'archived'
  const partial = variant === 'partial-error'
  const noCover = variant === 'fallback'
  return <div className="rdp-page rdp-detail">
    <header className="rdp-subhead"><button aria-label="Назад к рейдам" onClick={onBack} type="button"><Icon name="arrow" /></button><strong>Маршрут</strong><span /></header>
    <div className={`rdp-preview-hero${noCover ? ' rdp-preview-hero--fallback' : ''}`}>{noCover ? <span className="rdp-preview-fallback"><Icon name="route" size={42} />Фото маршрута пока нет</span> : <img alt="Кабанда едет по Ижевску" src={appPath('brand/kabanda-team-cover.jpg')} />}<span /></div>
    <section className="rdp-preview-copy"><p className="rdp-eyebrow">Готовый маршрут · Ижевск, Северный район</p><h1>{route.title}</h1><p>{route.description}. Спокойный темп и несколько удобных остановок по пути.</p>
      {unavailable && <div className="rdp-inline-alert" role="alert"><strong>Маршрут снят с публикации</strong><span>Его можно посмотреть, но нельзя использовать для нового рейда.</span></div>}
      {partial && <div className="rdp-inline-alert rdp-inline-alert--warning" role="status"><strong>2 точки временно недоступны</strong><span>Перед стартом покажем актуальную последовательность.</span></div>}
      <dl><div><dt>{route.distance}</dt><dd>длина</dd></div><div><dt>{route.points}</dt><dd>точек</dd></div><div><dt>~ 2 ч</dt><dd>в пути</dd></div></dl>
      <div className="rdp-mini-map" aria-label="Схема маршрута" role="img"><svg viewBox="0 0 320 150"><path d="M18 120c55-8 52-72 107-62 40 7 48 64 99 38 27-14 34-45 77-58" /></svg><i /><i /><i /></div>
      <details className="rdp-route-points"><summary>Открыть {route.points} точек маршрута</summary><ol className="rdp-points">{routePreviewPoints.slice(0, route.points).map((point) => <li key={point}><Icon name="pin" />{point}</li>)}</ol></details>
    </section>
    <div className="rdp-sticky-action"><button disabled={unavailable} onClick={onRide} type="button"><Icon name="bike" /> {unavailable ? 'Маршрут недоступен' : 'Поехать по маршруту'}</button></div>
  </div>
}

function ScheduleRaid({ onBack, onContinue }: { onBack: () => void; onContinue: () => void }) {
  return <div className="rdp-page rdp-detail rdp-schedule">
    <header className="rdp-subhead"><button aria-label="Назад к рейдам" onClick={onBack} type="button"><Icon name="arrow" /></button><strong>Запланировать</strong><span /></header>
    <section><p className="rdp-eyebrow">Новый рейд</p><h1>Когда едем?</h1><p>Укажите время сбора. Состав подтвердим на следующем шаге.</p>
      <label>Название<input defaultValue="Вечерний рейд" /></label>
      <div className="rdp-schedule__grid"><label>Дата<input defaultValue="2026-09-01" type="date" /></label><label>Время<input defaultValue="19:00" type="time" /></label></div>
    </section>
    <div className="rdp-sticky-action"><button onClick={onContinue} type="button">Выбрать участников</button></div>
  </div>
}

function ParticipantPicker({ designState, onBack, onDone, origin, route }: { designState: ParticipantDesignState; onBack: () => void; onDone: () => void; origin: 'quick' | 'route' | 'schedule'; route: RouteCardData }) {
  const people = designState === 'long' ? longParticipantList : participants
  const permissionDenied = designState === 'permission-error'
  const [selected, setSelected] = useState(() => new Set(['pavel', 'motor', 'lesha']))
  const [hasError, setHasError] = useState(designState === 'error')
  const [submitting, setSubmitting] = useState(false)
  useEffect(() => setHasError(designState === 'error'), [designState])
  const toggle = (id: string) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const submit = () => {
    if (submitting) return
    setSubmitting(true)
    if (hasError) setHasError(false)
    window.setTimeout(onDone, 350)
  }
  const source = origin === 'route' ? route.title : origin === 'schedule' ? 'Вечерний рейд · завтра в 19:00' : 'Свободный рейд · прямо сейчас'
  return <div className="rdp-page rdp-detail rdp-participants">
    <header className="rdp-subhead"><button aria-label="Назад" onClick={onBack} type="button"><Icon name="arrow" /></button><strong>Участники</strong><span /></header>
    <section className="rdp-participants__intro"><p className="rdp-eyebrow">{source}</p><h1>Кто сегодня едет?</h1><p>Отметьте участников и подтвердите состав перед стартом.</p></section>
    {hasError && <div className="rdp-inline-alert" role="alert"><strong>Не удалось создать рейд</strong><span>Выбор сохранён. Проверьте сеть и нажмите «Повторить».</span></div>}
    {permissionDenied && <div className="rdp-inline-alert" role="alert"><strong>Недостаточно прав</strong><span>Начать этот рейд может только вожак Кабанды.</span></div>}
    <fieldset disabled={permissionDenied}><legend>Состав Кабанды · {people.length}</legend>{people.map((person) => <label className={person.disabled ? 'rdp-participant--disabled' : undefined} key={person.id}><span className="rdp-avatar">{person.initial}</span><span><strong>{person.name}</strong><small>{person.role}</small></span><input checked={selected.has(person.id)} disabled={person.disabled} onChange={() => toggle(person.id)} type="checkbox" /></label>)}</fieldset>
    <div className="rdp-sticky-action"><button disabled={!permissionDenied && (selected.size === 0 || submitting)} onClick={permissionDenied ? onBack : submit} type="button">{permissionDenied ? 'Вернуться' : submitting ? 'Создаём рейд…' : hasError ? `Повторить · ${selected.size}` : `Поехали · ${selected.size}`}</button></div>
  </div>
}

function ScheduledSuccess({ onBack, origin, route }: { onBack: () => void; origin: ParticipantOrigin; route: RouteCardData }) {
  const planned = origin === 'schedule'
  const description = planned
    ? 'Вечерний рейд появился в предстоящих. Участники увидят его в Кабанде.'
    : origin === 'quick'
      ? 'Свободный рейд создан. Три участника подтвердили состав — это уже открытое лобби.'
      : `${route.title}: три участника подтвердили состав — это уже открытое лобби.`
  return <div className="rdp-page rdp-success"><span><Icon name="flag" size={34} /></span><p className="rdp-eyebrow">{planned ? 'РЕЙД ЗАПЛАНИРОВАН' : 'ЛОББИ ОТКРЫТО'}</p><h1>{planned ? 'Рейд запланирован' : 'Кабанда собирается'}</h1><p>{description}</p><button onClick={onBack} type="button">Вернуться к рейдам</button></div>
}

function NewRaidSheet({ onClose, onQuick, onSchedule }: { onClose: () => void; onQuick: () => void; onSchedule: () => void }) {
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { onClose(); return }
      if (event.key !== 'Tab') return
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])].filter((item) => !item.hasAttribute('disabled'))
      if (!focusable.length) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return <div className="rdp-sheet-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }} role="presentation"><section aria-labelledby="new-raid-title" aria-modal="true" className="rdp-sheet" ref={dialogRef} role="dialog"><span className="rdp-sheet__handle" /><div className="rdp-sheet__head"><div><p className="rdp-eyebrow">Новый рейд</p><h2 id="new-raid-title">Как едем?</h2></div><button aria-label="Закрыть" autoFocus onClick={onClose} type="button">×</button></div><button className="rdp-sheet-choice" onClick={onQuick} type="button"><span><Icon name="send" /></span><span><strong>Поехали сейчас</strong><small>Начать без предварительного расписания</small></span><Icon name="chevron" /></button><button className="rdp-sheet-choice" onClick={onSchedule} type="button"><span><Icon name="calendar" /></span><span><strong>Запланировать</strong><small>Выбрать дату и время</small></span><Icon name="chevron" /></button></section></div>
}

function BottomNav({ onRaids }: { onRaids: () => void }) {
  return <nav aria-label="Основные разделы" className="rdp-tabbar"><a href={appPath('app')}><Icon name="home" /><span>Главная</span></a><a href={`${appPath('app')}?tab=map`}><Icon name="map" /><span>Карта</span></a><button aria-current="page" onClick={onRaids} type="button"><Icon name="flag" /><span>Рейды</span></button><a href={`${appPath('app')}?tab=kabanda`}><Icon name="team" /><span>Кабанда</span></a></nav>
}

function ReviewControls({ participantState, screen, setParticipantState, setScreen, setVariant, variant }: { participantState: ParticipantDesignState; screen: RaidsDesignScreen; setParticipantState: (value: ParticipantDesignState) => void; setScreen: (value: RaidsDesignScreen) => void; setVariant: (value: RaidsDesignVariant) => void; variant: RaidsDesignVariant }) {
  return <aside aria-label="Панель ревью" className="rdp-review"><label>Экран<select onChange={(event) => setScreen(event.target.value as RaidsDesignScreen)} value={screen}>{raidsDesignScreens.map((item) => <option key={item}>{item}</option>)}</select></label><label>Состояние<select onChange={(event) => setVariant(event.target.value as RaidsDesignVariant)} value={variant}>{raidsDesignVariants.map((item) => <option key={item}>{item}</option>)}</select></label><label>Состав<select onChange={(event) => setParticipantState(event.target.value as ParticipantDesignState)} value={participantState}>{participantDesignStates.map((item) => <option key={item}>{item}</option>)}</select></label></aside>
}
