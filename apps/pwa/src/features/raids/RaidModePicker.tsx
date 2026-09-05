import { freeHuntCoverUrl, routeRaidCoverUrl } from './FreeHuntCover'

export type DepartureMode = 'free' | 'route'

export function RaidModePicker({ onSelect }: { onSelect: (mode: DepartureMode) => void }) {
  return <div className="raid-mode-picker" aria-label="Режим поездки">
    <button type="button" className="raid-mode-card" onClick={() => onSelect('free')}>
      <img src={freeHuntCoverUrl} alt="" width="1312" height="1199" />
      <span><strong>Свободная охота</strong><small>Выбирайте точки по пути</small></span>
    </button>
    <button type="button" className="raid-mode-card" onClick={() => onSelect('route')}>
      <img src={routeRaidCoverUrl} alt="" width="1312" height="1199" />
      <span><strong>По маршруту</strong><small>От первой точки до финиша</small></span>
    </button>
  </div>
}

export function departureTitle(mode: DepartureMode, routeTitle: string | undefined, date: Date): string {
  const day = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
  return `${mode === 'free' ? 'Свободный рейд' : (routeTitle || 'Рейд по маршруту').slice(0, 70)} · ${day}`
}
