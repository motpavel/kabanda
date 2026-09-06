import type { ReactNode } from 'react'

export function RaidControlIcon({ name }: { name: 'back' | 'more' | 'close' | 'pause' | 'play' | 'finish' | 'plus' | 'minus' | 'location' }) {
  const paths: Record<typeof name, ReactNode> = {
    back: <path d="m12 5-7 7 7 7M5 12h14" />,
    more: <><circle cx="12" cy="5" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="19" r="1" fill="currentColor" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    pause: <><path d="M8 5v14M16 5v14" strokeWidth="3" /></>,
    play: <path d="m8 5 11 7-11 7Z" />,
    finish: <><path d="M5 21V4m0 0c5-4 9 4 14 0v10c-5 4-9-4-14 0" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    minus: <path d="M5 12h14" />,
    location: <><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" fill="currentColor" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></>,
  }
  return <svg className="raid-control-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}
