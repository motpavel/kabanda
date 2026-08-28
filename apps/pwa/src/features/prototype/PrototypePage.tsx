import { useEffect, useMemo, useState, type ReactNode } from 'react'
import '@fontsource-variable/geist'
import {
  deliveryStateCopy,
  flows,
  getAdjacentScreen,
  isPrototypeRole,
  isScreenInFlow,
  screens,
  type DeliveryState,
  type PrototypeRole,
  type PrototypeScreenId,
} from './model'
import './prototype.css'

type IconName =
  | 'arrow-left'
  | 'bicycle'
  | 'camera'
  | 'check'
  | 'cloud'
  | 'group'
  | 'history'
  | 'home'
  | 'location'
  | 'map'
  | 'person'
  | 'route'
  | 'warning'

const iconPaths: Record<IconName, ReactNode> = {
  'arrow-left': <path d="m15 18-6-6 6-6" />,
  bicycle: (
    <>
      <circle cx="6" cy="17" r="3" />
      <circle cx="18" cy="17" r="3" />
      <path d="m6 17 4-8 4 8m-6-4h7l-2-4h3" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8h3l1.5-2h7L17 8h3v11H4z" />
      <circle cx="12" cy="13.5" r="3" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  cloud: (
    <>
      <path d="M6.5 18a4.5 4.5 0 0 1-.7-8.94A6 6 0 0 1 17.3 8a5 5 0 0 1 .2 10Z" />
      <path d="m9 14 2 2 4-5" />
    </>
  ),
  group: (
    <>
      <circle cx="9" cy="9" r="3" />
      <circle cx="17" cy="10" r="2.5" />
      <path d="M3.5 19c.5-3 2.4-4.5 5.5-4.5s5 1.5 5.5 4.5M14 15c3.4-.6 5.5.7 6 4" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5m4-1v5l3 2" />
    </>
  ),
  home: (
    <>
      <path d="m4 11 8-7 8 7v9H4z" />
      <path d="M9 20v-6h6v6" />
    </>
  ),
  location: (
    <>
      <path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" />
      <circle cx="12" cy="10" r="2.5" />
    </>
  ),
  map: <path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3zm6-3v15m6-12v15" />,
  person: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 21c.7-4.2 3.2-6.5 7.5-6.5s6.8 2.3 7.5 6.5" />
    </>
  ),
  route: <path d="M5 19c7 0 2-14 9-14 3.5 0 5 2 5 5m-2-2 2 2 2-2M3 19h4" />,
  warning: (
    <>
      <path d="M12 3 2.8 20h18.4z" />
      <path d="M12 9v5m0 3h.01" />
    </>
  ),
}

function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="vp-icon"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
        {iconPaths[name]}
      </g>
    </svg>
  )
}

function BrandLockup() {
  return (
    <span aria-label="КАБАНДА" className="vp-brand" role="img">
      <img alt="" src="/brand/kabanda-logo-reference.png" />
    </span>
  )
}

function StatusCard({
  detail,
  icon,
  state,
}: {
  detail: string
  icon: IconName
  state: DeliveryState
}) {
  return (
    <div className={`vp-status vp-status--${state}`} role="status">
      <span className="vp-status__icon">
        <Icon name={icon} />
      </span>
      <span>
        <strong>{deliveryStateCopy[state]}</strong>
        <small>{detail}</small>
      </span>
    </div>
  )
}

function ParticipantList({ compact = false }: { compact?: boolean }) {
  const participants = [
    ['П', 'Павел', 'Навигатор'],
    ['А', 'Аня', 'Готова'],
    ['М', 'Макс', 'Готов'],
    ['Л', 'Лена', 'Подключается'],
  ]
  return (
    <ul className={`vp-people${compact ? ' vp-people--compact' : ''}`}>
      {participants.map(([initial, name, state], index) => (
        <li key={name}>
          <span aria-hidden="true" className="vp-avatar">
            {initial}
          </span>
          <span>
            <strong>{name}</strong>
            <small>{state}</small>
          </span>
          <span className={index === 3 ? 'vp-dot vp-dot--waiting' : 'vp-dot'}>
            <span className="vp-sr-only">{index === 3 ? 'ещё не готов' : 'готов'}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

function MapPreview() {
  return (
    <div aria-label="Схема активного маршрута" className="vp-map" role="img">
      <span className="vp-map__road vp-map__road--one" />
      <span className="vp-map__road vp-map__road--two" />
      <svg aria-hidden="true" className="vp-map__route" viewBox="0 0 320 190">
        <path d="M18 150c38-18 46-62 84-67 34-5 39 37 75 27 40-11 48-61 112-64" />
      </svg>
      <span className="vp-map__you">Вы</span>
      <span className="vp-map__point"><Icon name="location" size={20} /></span>
      <div className="vp-map__caption">
        <strong>Сквер у цирка</strong>
        <span>34 м · вход со стороны реки</span>
      </div>
    </div>
  )
}

function Metrics() {
  return (
    <dl className="vp-metrics">
      <div><dt>Расстояние</dt><dd>18,4 км</dd></div>
      <div><dt>В пути</dt><dd>1:26</dd></div>
      <div><dt>Точки</dt><dd>6</dd></div>
      <div><dt>Фото</dt><dd>14</dd></div>
    </dl>
  )
}

function ScreenBody({ role, screen }: { role: PrototypeRole; screen: PrototypeScreenId }) {
  switch (screen) {
    case 'entry':
      return (
        <>
          <div className="vp-onboarding-mark"><BrandLockup /></div>
          <p className="vp-lead">Проверим полный рейд без подсказок и без обещаний, которые PWA не может выполнить.</p>
          <fieldset className="vp-role-picker">
            <legend>Выберите роль</legend>
            <label><input checked={role === 'organizer'} name="visual-role" readOnly type="radio" /> Организатор</label>
            <label><input checked={role === 'participant'} name="visual-role" readOnly type="radio" /> Участник по приглашению</label>
          </fieldset>
          <p className="vp-note">Роль меняется в панели прототипа сверху. В продукте этой панели не будет.</p>
        </>
      )
    case 'invite':
      return (
        <>
          <div className="vp-invite-hero">
            <BrandLockup />
            <p>Аня зовёт вас в постоянную команду</p>
            <h2>Ижевские кабаны</h2>
          </div>
          <div className="vp-card vp-card--quiet">
            <div className="vp-inline"><Icon name="bicycle" /><strong>Первый рейд сегодня в 19:00</strong></div>
            <p>После входа вы вернётесь ровно в это приглашение.</p>
          </div>
          <label className="vp-field">Почта<input autoComplete="email" defaultValue="pavel@example.test" inputMode="email" type="email" /></label>
        </>
      )
    case 'auth-return':
      return (
        <>
          <StatusCard detail="Вход подтверждён, ссылка не потерялась" icon="check" state="accepted" />
          <div className="vp-card">
            <p className="vp-kicker">Приглашение от Ани</p>
            <h2>Ижевские кабаны</h2>
            <p>4 участника · ближайший рейд сегодня</p>
            <ParticipantList compact />
          </div>
        </>
      )
    case 'install':
      return (
        <>
          <div className="vp-illustration"><Icon name="home" size={36} /></div>
          <p className="vp-lead">Участнику можно продолжить в браузере. Для записи маршрута навигатор открывает установленную КАБАНДУ с активным экраном.</p>
          <div className="vp-card vp-checklist">
            <p><Icon name="check" /> Приглашение работает в обоих режимах</p>
            <p><Icon name="check" /> Установка понадобится только перед ролью навигатора</p>
            <p><Icon name="warning" /> Фоновый GPS без свежих координат не обещаем</p>
          </div>
        </>
      )
    case 'home':
      return (
        <>
          <div className="vp-home-hero">
            <p className="vp-kicker">Сегодня можно выехать</p>
            <h2>Соберите друзей в одну Кабанду</h2>
            <p>Постоянная команда хранит участников, точки и общую историю.</p>
          </div>
          <Metrics />
          <div className="vp-card vp-empty"><Icon name="group" size={32} /><strong>Кабанды пока нет</strong><span>На создание уйдёт меньше минуты</span></div>
        </>
      )
    case 'kabanda':
      return (
        <>
          <div className="vp-card vp-kabanda-card">
            <div className="vp-inline"><span className="vp-team-mark">ИК</span><div><h2>Ижевские кабаны</h2><p>4 участника · Ижевск</p></div></div>
            <ParticipantList compact />
          </div>
          <div className="vp-card vp-card--quiet"><p className="vp-kicker">Общий прогресс</p><Metrics /></div>
        </>
      )
    case 'raid-setup':
      return (
        <form className="vp-stack" onSubmit={(event) => event.preventDefault()}>
          <label className="vp-field">Название<input defaultValue="Вечерний рейд" /></label>
          <label className="vp-field">Когда<input defaultValue="Сегодня, 19:00" /></label>
          <div className="vp-card vp-card--quiet"><div className="vp-inline"><Icon name="map" /><div><strong>Центр Ижевска</strong><p>8 точек в текущей коллекции</p></div></div></div>
          <p className="vp-note">Остальное можно уточнить в lobby. Длинной анкеты перед поездкой нет.</p>
        </form>
      )
    case 'lobby':
      return (
        <>
          <div className="vp-card vp-raid-summary"><div><span className="vp-kicker">Сегодня · 19:00</span><h2>Центр Ижевска</h2></div><span className="vp-round-icon"><Icon name="bicycle" /></span></div>
          <ParticipantList />
          <button className="vp-secondary-row" type="button"><Icon name="group" /><span><strong>Пригласить ещё</strong><small>Ссылка действует до старта</small></span></button>
        </>
      )
    case 'readiness':
      return (
        <>
          <div className="vp-readiness-score"><strong>4 из 4</strong><span>критичных проверок пройдено</span></div>
          <ul className="vp-readiness-list">
            <li><Icon name="home" /><span><strong>Установлено</strong><small>standalone режим</small></span><Icon name="check" /></li>
            <li><Icon name="location" /><span><strong>Геолокация</strong><small>точность 18 м</small></span><Icon name="check" /></li>
            <li><Icon name="cloud" /><span><strong>Офлайн-очередь</strong><small>хранилище доступно</small></span><Icon name="check" /></li>
            <li><Icon name="bicycle" /><span><strong>Экран не уснёт</strong><small>Wake Lock включён</small></span><Icon name="check" /></li>
          </ul>
          <p className="vp-note">Во время движения телефон остаётся в креплении. Все действия выполняются только после остановки.</p>
        </>
      )
    case 'active':
      return (
        <>
          <StatusCard detail="Свежая координата 4 секунды назад" icon="route" state="accepted" />
          <MapPreview />
          <div className="vp-active-stats"><span><strong>6,8</strong> км</span><span><strong>02</strong> точки</span><span><strong>04</strong> в очереди</span></div>
          <div className="vp-update-note"><Icon name="cloud" /><span><strong>Обновление готово</strong><small>Установим после завершения рейда</small></span></div>
        </>
      )
    case 'gps-recovery':
      return (
        <>
          <div className="vp-alert" role="alert"><Icon name="warning" size={30} /><div><strong>Нет свежих координат 48 секунд</strong><p>Маршрут больше не помечается как записываемый. Уже сохранённые точки в безопасности.</p></div></div>
          <div className="vp-card vp-checklist"><p><Icon name="location" /> Верните КАБАНДУ на экран</p><p><Icon name="home" /> Разрешите геолокацию</p><p><Icon name="person" /> Если не помогло, передайте роль навигатора</p></div>
          <button className="vp-text-action" type="button">Передать роль Ане</button>
        </>
      )
    case 'checkin':
      return (
        <>
          <div className="vp-point-card"><span className="vp-round-icon"><Icon name="location" /></span><div><p className="vp-kicker">34 м · координата свежая</p><h2>Сквер у цирка</h2><p>Сервер ещё раз проверит расстояние</p></div></div>
          <fieldset className="vp-checkin-list"><legend>Отметьте тех, кто остановился у точки</legend>{['Павел', 'Аня', 'Макс', 'Лена'].map((name) => <label key={name}><input defaultChecked name={name} type="checkbox" /><span className="vp-avatar">{name[0]}</span><span>{name}</span></label>)}</fieldset>
          <p className="vp-note">Один обычный чекин: выбор участников и одно подтверждение.</p>
        </>
      )
    case 'photo':
      return (
        <>
          <div className="vp-photo"><div className="vp-photo__sky" /><div className="vp-photo__city" /><span><Icon name="camera" /> Предпросмотр фотографии</span></div>
          <StatusCard detail="Можно закрыть экран и вернуться позже" icon="cloud" state="local" />
          <button className="vp-secondary-row" type="button"><Icon name="camera" /><span><strong>Выбрать другое фото</strong><small>Камера или файл</small></span></button>
        </>
      )
    case 'offline':
      return (
        <>
          <p className="vp-lead">Рейд продолжается. Очередь привязана к вашему аккаунту и отправится после возвращения сети.</p>
          <div className="vp-delivery-list">
            <StatusCard detail="Фото сквера · 2,4 МБ" icon="camera" state="local" />
            <StatusCard detail="Чекин у цирка" icon="location" state="sending" />
            <StatusCard detail="18 точек маршрута" icon="route" state="accepted" />
            <StatusCard detail="Нужно выбрать другое фото" icon="warning" state="needs_action" />
          </div>
        </>
      )
    case 'finish':
      return (
        <>
          <div className="vp-card vp-finish-card"><Icon name="route" size={36} /><h2>Маршрут сохранён</h2><p>Одна фотография всё ещё требует действия. Она не войдёт в результат, пока вы её не замените.</p></div>
          <Metrics />
          <button className="vp-text-action" type="button">Вернуться к фотографии</button>
          <p className="vp-note">Завершение создаёт один канонический результат. Повторный тап не удвоит метрики.</p>
        </>
      )
    case 'result':
      return (
        <>
          <div className="vp-result-hero"><BrandLockup /><p>28 августа · Ижевск</p><h2>Вечерний рейд</h2><span>Ижевские кабаны</span></div>
          <Metrics />
          <div className="vp-card"><div className="vp-inline"><Icon name="group" /><div><strong>4 участника</strong><p>Личный и командный вклад разделены</p></div></div><ParticipantList compact /></div>
          <button className="vp-secondary-row" type="button"><Icon name="cloud" /><span><strong>Поделиться карточкой</strong><small>Без точного маршрута и внутренних ID</small></span></button>
        </>
      )
    case 'history':
      return (
        <>
          <StatusCard detail="Показаны последние принятые данные" icon="history" state="accepted" />
          <article className="vp-history-card"><div className="vp-history-card__map"><Icon name="route" size={38} /></div><div><p className="vp-kicker">28 августа · 4 участника</p><h2>Вечерний рейд</h2><p>18,4 км · 6 точек · 14 фото</p></div></article>
          <article className="vp-history-card vp-history-card--muted"><div className="vp-history-card__map"><Icon name="map" size={38} /></div><div><p className="vp-kicker">24 августа</p><h2>Ночной рейд</h2><p>12,8 км · 4 точки</p></div></article>
        </>
      )
  }
}

const topLevelScreens = new Set<PrototypeScreenId>(['home', 'kabanda', 'history'])

function BottomNav({ screen }: { screen: PrototypeScreenId }) {
  if (!topLevelScreens.has(screen)) return null
  const items: Array<[IconName, string, boolean]> = [
    ['home', 'Главная', screen === 'home'],
    ['bicycle', 'Рейды', screen === 'history'],
    ['map', 'Карта', false],
    ['group', 'Кабанда', screen === 'kabanda'],
    ['person', 'Профиль', false],
  ]
  return (
    <nav aria-label="Основная навигация" className="vp-bottom-nav">
      {items.map(([icon, label, active]) => <button aria-current={active ? 'page' : undefined} className={active ? 'is-active' : ''} key={label} type="button"><Icon name={icon} size={20} /><span>{label}</span></button>)}
    </nav>
  )
}

function initialState() {
  const params = new URLSearchParams(window.location.search)
  const roleParam = params.get('role')
  const role: PrototypeRole = isPrototypeRole(roleParam) ? roleParam : 'organizer'
  const screenParam = params.get('screen')
  const screen: PrototypeScreenId = isScreenInFlow(role, screenParam) ? screenParam : 'entry'
  return { role, screen }
}

export function PrototypePage() {
  const initial = useMemo(initialState, [])
  const [role, setRole] = useState<PrototypeRole>(initial.role)
  const [screen, setScreen] = useState<PrototypeScreenId>(initial.screen)
  const flow = flows[role]
  const currentIndex = flow.indexOf(screen)
  const current = screens[screen]

  useEffect(() => {
    const previousTitle = document.title
    document.title = 'КАБАНДА — UX-прототип'
    return () => {
      document.title = previousTitle
    }
  }, [])

  useEffect(() => {
    const params = new URLSearchParams({ role, screen })
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`)
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [role, screen])

  function changeRole(nextRole: PrototypeRole) {
    setRole(nextRole)
    setScreen('entry')
  }

  return (
    <main className="vp-prototype">
      <aside aria-label="Управление прототипом" className="vp-prototype-controls">
        <label>Роль<select onChange={(event) => changeRole(event.target.value as PrototypeRole)} value={role}><option value="organizer">Организатор</option><option value="participant">Участник</option></select></label>
        <label>Экран<select onChange={(event) => setScreen(event.target.value as PrototypeScreenId)} value={screen}>{flow.map((screenId) => <option key={screenId} value={screenId}>{screens[screenId].title}</option>)}</select></label>
        <span>{currentIndex + 1}/{flow.length}</span>
      </aside>

      <section aria-label={`Прототип: ${current.title}`} className="vp-phone">
        <header className="vp-topbar">
          {currentIndex > 0 ? <button aria-label="Назад" className="vp-icon-button" onClick={() => setScreen(getAdjacentScreen(role, screen, -1))} type="button"><Icon name="arrow-left" /></button> : <BrandLockup />}
          {currentIndex > 0 && <span className="vp-topbar__brand"><BrandLockup /></span>}
          <span className="vp-mode">{role === 'organizer' ? 'Организатор' : 'Участник'}</span>
        </header>

        <div className="vp-content">
          <div className="vp-screen-heading"><p className="vp-kicker">Кликабельный VP</p><h1>{current.title}</h1></div>
          <ScreenBody role={role} screen={screen} />
        </div>

        <div className="vp-action-bar">
          <button className="vp-primary-action" onClick={() => setScreen(getAdjacentScreen(role, screen, 1))} type="button">{current.primaryLabel}</button>
        </div>
        <BottomNav screen={screen} />
      </section>
    </main>
  )
}
