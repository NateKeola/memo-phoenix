'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// Temporary beta instrumentation for the live voice session (the interview-ends-after-
// its-first-greeting investigation). Always on: every lifecycle event is mirrored to
// the browser console with an [INTERVIEW] prefix AND shown on screen, so a single live
// run reveals exactly why a session ends. The three things it disambiguates:
//   - a CLIENT teardown: "widget UNMOUNTING" logs right before the disconnect (the
//     remount theory), or our own endSession() ran (onDisconnect reason=user);
//   - an ELEVENLABS SERVER close: onDisconnect reason=agent or reason=error, with a
//     WebSocket close code / reason (the agent ended the call, or the socket errored);
//   - a MIC / TURN-TAKING failure: the agent greets, but no user voice is ever detected
//     (vad max stays ~0, micVol flat) and it ends on silence.
// Remove this module and its call sites once the cause is confirmed and fixed.

export type DebugLine = { t: number; msg: string }

export type VadState = { last: number; max: number; count: number; heard: boolean }

export function newVadState(): VadState {
  return { last: 0, max: 0, count: 0, heard: false }
}

export function useInterviewDebug(routeLabel: string) {
  const [lines, setLines] = useState<DebugLine[]>([])
  const t0 = useRef<number | null>(null)
  const log = useCallback(
    (msg: string) => {
      const now = Date.now()
      if (t0.current === null) t0.current = now
      const dt = ((now - t0.current) / 1000).toFixed(1)
      try {
        // eslint-disable-next-line no-console
        console.log(`[INTERVIEW ${routeLabel} +${dt}s] ${msg}`)
      } catch {
        /* console may be unavailable */
      }
      setLines((prev) => {
        const next = [...prev, { t: now, msg }]
        return next.length > 150 ? next.slice(-150) : next
      })
    },
    [routeLabel]
  )
  return { lines, log }
}

// Render DisconnectionDetails (or anything close to it) into one readable line. The
// reason is the headline: "user" = our own endSession()/teardown, "agent" = the
// ElevenLabs agent ended the call, "error" = the socket closed on an error.
export function describeDisconnect(d: unknown): string {
  if (d == null) return 'reason=unknown (no details)'
  if (typeof d === 'string') return `reason=${d}`
  const o = d as {
    reason?: string
    message?: string
    closeCode?: number
    closeReason?: string
    context?: unknown
  }
  const parts: string[] = [`reason=${o.reason ?? 'unknown'}`]
  if (o.closeCode != null) parts.push(`closeCode=${o.closeCode}`)
  if (o.closeReason) parts.push(`closeReason=${JSON.stringify(o.closeReason)}`)
  if (o.message) parts.push(`message=${JSON.stringify(o.message)}`)
  if (o.context !== undefined) {
    try {
      parts.push(`ctx=${JSON.stringify(o.context)}`)
    } catch {
      /* ignore unserializable context */
    }
  }
  return parts.join(' ')
}

// Structured disconnect fields for the durable observability layer (reason + close
// code only; never any transcript/content). "user" = our own teardown, "agent" = the
// ElevenLabs agent ended the call, "error" = the socket closed on an error.
export function disconnectInfo(d: unknown): { reason: string; closeCode?: number } {
  if (d == null) return { reason: 'unknown' }
  if (typeof d === 'string') return { reason: d }
  const o = d as { reason?: string; closeCode?: number }
  return { reason: o.reason ?? 'unknown', closeCode: typeof o.closeCode === 'number' ? o.closeCode : undefined }
}

// Logging-only ElevenLabs callbacks the components are NOT already using. Spreading
// these into useConversation is pure instrumentation (no behavior change). The set of
// keys is constant across renders, so useStableCallbacks keeps the registration stable
// and the live session is never re-initialised by adding them.
export function diagnosticCallbacks(log: (m: string) => void, vadRef: { current: VadState }) {
  return {
    onStatusChange: (p: { status?: string }) => log(`status -> ${p?.status ?? '?'}`),
    onModeChange: (p: { mode?: string }) => log(`mode -> ${p?.mode ?? '?'}`),
    onVadScore: (p: { vadScore?: number }) => {
      const s = typeof p?.vadScore === 'number' ? p.vadScore : 0
      const v = vadRef.current
      v.last = s
      if (s > v.max) v.max = s
      if (s > 0.5) {
        v.count += 1
        if (!v.heard) {
          v.heard = true
          log(`first user voice detected (vad=${s.toFixed(2)})`)
        }
      }
    },
    onInterruption: () => log('interruption (user spoke over agent)'),
    onCanSendFeedbackChange: (p: { canSendFeedback?: boolean }) =>
      log(`canSendFeedback -> ${Boolean(p?.canSendFeedback)}`),
    onDebug: (p: unknown) => {
      try {
        const s = typeof p === 'string' ? p : JSON.stringify(p)
        if (s && s !== '{}' && s !== 'null') log(`sdk-debug ${s.length > 240 ? s.slice(0, 240) + '…' : s}`)
      } catch {
        /* ignore unserializable debug payloads */
      }
    },
  }
}

type LiveConversation = {
  status?: string
  isSpeaking?: boolean
  isListening?: boolean
  getInputVolume?: () => number
}

// While `active`, poll the live mic + turn-taking state once a second so the readout
// shows whether audio is flowing after the greeting. Logs a compact mic sample every
// few seconds so a flat/zero mic (a turn-taking/mic failure) stays visible in the
// console history even after teardown. Returns a one-line summary for the UI.
export function useLiveStatus(
  conversation: LiveConversation,
  active: boolean,
  log: (m: string) => void,
  vadRef: { current: VadState }
) {
  const [summary, setSummary] = useState('idle')
  const tickRef = useRef(0)
  useEffect(() => {
    if (!active) return
    tickRef.current = 0
    const id = setInterval(() => {
      const status = conversation.status ?? '?'
      const speaking = Boolean(conversation.isSpeaking)
      const listening = Boolean(conversation.isListening)
      let vol = 0
      try {
        vol = conversation.getInputVolume ? conversation.getInputVolume() : 0
      } catch {
        /* getInputVolume throws once the session is gone */
      }
      const v = vadRef.current
      const turn = speaking ? 'agent-speaking' : listening ? 'listening' : 'idle'
      const next = `status=${status} ${turn} micVol=${vol.toFixed(2)} vad(last=${v.last.toFixed(2)} max=${v.max.toFixed(2)} heard=${v.heard})`
      setSummary(next)
      tickRef.current += 1
      if (tickRef.current % 3 === 0) log(`mic ${next}`)
    }, 1000)
    return () => clearInterval(id)
  }, [active, conversation, log, vadRef])
  return summary
}

export function DebugReadout({ title, status, lines }: { title: string; status: string; lines: DebugLine[] }) {
  return (
    <div
      style={{
        marginTop: 20,
        border: '1px solid #2c2c2c',
        borderRadius: 8,
        overflow: 'hidden',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
      }}
    >
      <div style={{ background: '#111', color: '#7ee787', padding: '6px 10px' }}>[INTERVIEW] debug — {title}</div>
      <div style={{ background: '#0b0b0b', color: '#c9d1d9', padding: '6px 10px', borderBottom: '1px solid #2c2c2c' }}>
        {status || 'idle'}
      </div>
      <div style={{ background: '#0b0b0b', color: '#8b949e', padding: '6px 10px', maxHeight: 220, overflowY: 'auto' }}>
        {lines.length === 0 ? (
          <div>no events yet</div>
        ) : (
          lines.map((l, i) => (
            <div key={i}>
              <span style={{ color: '#6e7681' }}>{new Date(l.t).toLocaleTimeString()}</span> {l.msg}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
