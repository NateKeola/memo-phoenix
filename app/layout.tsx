import type { ReactNode } from 'react'

export const metadata = {
  title: 'Memo Phoenix',
  description: 'Single-user personal knowledge and companion system',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
