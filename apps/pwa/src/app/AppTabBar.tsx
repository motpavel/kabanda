import { appPath } from '../lib/paths'
import { appSectionSearch, type AppSection } from './navigation'

const sections: { id: AppSection; label: string }[] = [
  { id: 'home', label: 'Главная' },
  { id: 'map', label: 'Карта' },
  { id: 'raids', label: 'Рейды' },
  { id: 'kabanda', label: 'Кабанда' },
]

export function AppTabBar({
  active,
  kabandaId,
  onSelect,
}: {
  active: AppSection
  kabandaId: string | null
  onSelect: (section: AppSection) => void
}) {
  return (
    <nav className="kb-app-tabbar" aria-label="Основные разделы">
      {sections.map(({ id, label }) => (
        <a
          key={id}
          href={`${appPath('app')}${appSectionSearch('', id, kabandaId)}`}
          aria-current={active === id ? 'page' : undefined}
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
            event.preventDefault()
            onSelect(id)
          }}
        >
          <TabIcon section={id} />
          <span>{label}</span>
        </a>
      ))}
    </nav>
  )
}

function TabIcon({ section }: { section: AppSection }) {
  return <span aria-hidden="true" className={`kb-nav-icon kb-nav-icon--${section}`} style={{ maskImage: `url(${appPath('brand/kabanda-navigation-v1.png')})`, WebkitMaskImage: `url(${appPath('brand/kabanda-navigation-v1.png')})` }} />
}
