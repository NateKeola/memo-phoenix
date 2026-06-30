// Shared line icons for the warm-notebook UI. Stroke icons on a 24x24 grid,
// inheriting currentColor, matching the reference's weight (~1.7) and round caps.
import type { SVGProps } from 'react'

type IconProps = Omit<SVGProps<SVGSVGElement>, 'strokeWidth'> & { size?: number; strokeWidth?: number }

function base({ size = 21, strokeWidth = 1.7, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    ...rest,
  }
}

export function IconHome(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5.5 10V20h13V10" />
    </svg>
  )
}

export function IconPeople(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="9" cy="8" r="3.1" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 6.3a3 3 0 0 1 0 5.4" />
      <path d="M17.5 14.4c1.9.6 3.3 2.4 3.3 4.6" />
    </svg>
  )
}

export function IconSearch(p: IconProps) {
  return (
    <svg {...base({ ...p, strokeWidth: 1.9 })}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  )
}

export function IconToday(p: IconProps) {
  return (
    <svg {...base({ ...p, strokeWidth: 1.6 })}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19" />
    </svg>
  )
}

export function IconPerson(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
    </svg>
  )
}

export function IconMemory(p: IconProps) {
  return (
    <svg {...base({ size: 21, strokeWidth: 1.6, ...p })}>
      <path d="M12 3l1.7 4.8L18.5 9l-4.8 1.2L12 15l-1.7-4.8L5.5 9l4.8-1.2Z" />
      <path d="M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7Z" />
    </svg>
  )
}

export function IconPlus(p: IconProps) {
  return (
    <svg {...base({ size: 28, strokeWidth: 2.2, ...p })}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function IconBack(p: IconProps) {
  return (
    <svg {...base({ size: 22, strokeWidth: 1.8, ...p })}>
      <path d="M15 6l-6 6 6 6" />
    </svg>
  )
}

export function IconMic(p: IconProps) {
  return (
    <svg {...base({ size: 18, ...p })}>
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.5V21" />
    </svg>
  )
}

export function IconText(p: IconProps) {
  return (
    <svg {...base({ size: 18, ...p })}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

export function IconInterview(p: IconProps) {
  return (
    <svg {...base({ size: 18, ...p })}>
      <path d="M8 10h8M8 14h5" />
      <path d="M21 12a8 8 0 0 1-11.3 7.3L4 21l1.7-5.7A8 8 0 1 1 21 12Z" />
    </svg>
  )
}

export function IconSend(p: IconProps) {
  return (
    <svg {...base({ size: 20, strokeWidth: 2, ...p })}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  )
}

export function IconClose(p: IconProps) {
  return (
    <svg {...base({ size: 22, strokeWidth: 1.8, ...p })}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

export function IconChevronDown(p: IconProps) {
  return (
    <svg {...base({ size: 22, strokeWidth: 1.8, ...p })}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}
