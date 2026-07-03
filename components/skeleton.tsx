import type { CSSProperties } from 'react'

// Shimmer placeholders for the loading.tsx boundaries. Server components (no client
// hooks) so they render in the instant streamed shell. They mirror the real page
// chrome's regions so there is no layout jump when the data arrives.

export function Skel({
  w = '100%',
  h = 14,
  r = 6,
  style,
}: {
  w?: number | string
  h?: number | string
  r?: number
  style?: CSSProperties
}) {
  return <span className="mp-skel" aria-hidden style={{ display: 'block', width: w, height: h, borderRadius: r, ...style }} />
}

// A list of avatar + two-line rows (people list, follow-ups).
export function SkelRows({ n = 5, avatar = true }: { n?: number; avatar?: boolean }) {
  return (
    <ul className="mp-list" style={{ marginTop: 14 }}>
      {Array.from({ length: n }).map((_, i) => (
        <li key={i} className="mp-row">
          <span style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0 }}>
            {avatar ? <Skel w={40} h={40} r={20} /> : null}
            <span style={{ display: 'grid', gap: 7, flex: 1 }}>
              <Skel w={`${55 - (i % 3) * 8}%`} h={15} />
              <Skel w={`${34 + (i % 2) * 10}%`} h={11} />
            </span>
          </span>
        </li>
      ))}
    </ul>
  )
}
