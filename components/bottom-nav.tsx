'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { IconHome, IconPeople, IconSearch, IconToday, IconMemory } from '@/components/icons'

// The bottom navigation pill. Links only to existing routes (visual layer, no new
// behavior or destinations). Ask sits in the gold center; the active tab lights.
const ITEMS = [
  { href: '/', label: 'Home', Icon: IconHome, match: (p: string) => p === '/' },
  { href: '/people', label: 'People', Icon: IconPeople, match: (p: string) => p.startsWith('/people') },
  { href: '/ask', label: 'Ask', Icon: IconSearch, center: true, match: (p: string) => p.startsWith('/ask') },
  { href: '/companion', label: 'Today', Icon: IconToday, match: (p: string) => p.startsWith('/companion') },
  { href: '/miner', label: 'Memory', Icon: IconMemory, match: (p: string) => p.startsWith('/miner') },
]

export function BottomNav() {
  const pathname = usePathname() || '/'
  return (
    <nav className="mp-nav" aria-label="Primary">
      {ITEMS.map(({ href, label, Icon, center, match }) => {
        const active = match(pathname)
        const cls = center
          ? 'mp-nav__item mp-nav__item--center'
          : `mp-nav__item${active ? ' mp-nav__item--active' : ''}`
        return (
          <Link key={href} href={href} className={cls} aria-label={label} aria-current={active ? 'page' : undefined}>
            <Icon />
          </Link>
        )
      })}
    </nav>
  )
}
