import type { ReactNode } from 'react'
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
  const paths: Record<AppSection, ReactNode> = {
    home: <><path d="M3.5 10.5 12 3l8.5 7.5" /><path d="M5.5 9.5v10h13v-10M9.5 19.5v-6h5v6" /></>,
    map: <><path d="m3.5 6 5-2.5 7 2.5 5-2.5v14l-5 2.5-7-2.5-5 2.5Z" /><path d="M8.5 3.5v14M15.5 6v14" /></>,
    raids: <><circle cx="7" cy="17" r="3" /><circle cx="17" cy="17" r="3" /><path d="m7 17 4-8h4l2 8M9 13h7M10.5 6.5h3" /></>,
    kabanda: <><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3.5 19c.4-4 2.2-6 5.5-6s5.1 2 5.5 6M14 14c3.6-.7 5.7 1 6.5 4.5" /></>,
  }
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[section]}</svg>
}
