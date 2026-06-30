import type { ReactNode } from 'react'
import './globals.css'

export const metadata = {
  title: 'Memo Phoenix',
  description: 'Single-user personal knowledge and companion system',
}

export const viewport = {
  themeColor: '#2A1E12',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Newsreader is the voice of the whole system. Loaded as a stylesheet link
            (not bundled JS) so it stays out of the client bundle. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,300;1,6..72,400;1,6..72,500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  )
}
