import type { ReactNode } from 'react'

export function HomeIcon({ name }: { name: 'arrow' | 'map' | 'calendar' | 'bike' | 'plus' }) {
  const paths: Record<typeof name, ReactNode> = {
    arrow: <path d="m9 5 7 7-7 7" />,
    map: <><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Z" /><path d="M9 3v15M15 6v15" /></>,
    calendar: <><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M8 3v4M16 3v4M4 11h16M8 15h2M14 15h2" /></>,
    bike: <><circle cx="5.5" cy="16.5" r="4" /><circle cx="18.5" cy="16.5" r="4" /><path d="m5.5 16.5 5-9 4 9h-9L9 10h7l2.5 6.5M14 4h2l1 3.5M8 7.5h4" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
  }
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}
