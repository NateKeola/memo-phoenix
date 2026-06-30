import type { ReactNode } from 'react'
import Link from 'next/link'
import { IconBack } from '@/components/icons'

// The quiet top bar used across sub-screens: a back chevron on the left, optional
// actions on the right. Purely presentational; server-safe (no client hooks).
export function PageHeader({
  back = '/',
  backLabel = 'Back',
  right,
}: {
  back?: string
  backLabel?: string
  right?: ReactNode
}) {
  return (
    <div className="mp-top">
      <Link href={back} className="mp-iconbtn" aria-label={backLabel}>
        <IconBack />
      </Link>
      {right ?? <span />}
    </div>
  )
}
