'use client'

import { useEffect, useRef, useState } from 'react'
import { startMeter, type MicMeter } from '@/lib/media/mic-meter'

// Always-on, on-screen microphone diagnostics for the voice surfaces (Add memo and
// the interview). It instruments the WHOLE capture path so a single live run shows
// exactly which stage is the last one that succeeds, and a non-technical operator can
// screenshot it. Stages, in order:
//   1. secure context (https / localhost)
//   2. mediaDevices API present (absent in some embedded / in-app browsers)
//   3. permission granted
//   4. a stream with >= 1 audio track
//   5. the track is enabled, live, and not muted
//   6. the AudioContext is running (Chrome can leave it suspended after an await)
//   7. AUDIO IS ACTUALLY FLOWING: the live level meter moves when you speak
//   8. downstream: memo -> Scribe upload+response; interview -> SDK volume/VAD
// The parent owns the stream and passes it in (plus any downstream lines); this
// component owns the meter + the readout.

export type DownstreamLine = { label: string; value: string; ok?: boolean }

type Env = { secure: boolean; hasApi: boolean; ua: string }
type TrackInfo = { enabled: boolean; readyState: string; muted: boolean; label: string }

function readEnv(): Env {
  if (typeof window === 'undefined') return { secure: false, hasApi: false, ua: 'server' }
  const md = navigator.mediaDevices
  const ua = navigator.userAgent || ''
  const short =
    /CriOS|Chrome/.test(ua) && !/Edg/.test(ua)
      ? 'Chrome'
      : /Firefox/.test(ua)
        ? 'Firefox'
        : /Edg/.test(ua)
          ? 'Edge'
          : /Safari/.test(ua)
            ? 'Safari'
            : 'other'
  const inApp = /(FBAN|FBAV|Instagram|Line|WhatsApp|Slack|GSA|; wv\))/i.test(ua)
  return {
    secure: window.isSecureContext !== false,
    hasApi: Boolean(md && typeof md.getUserMedia === 'function'),
    ua: `${short}${inApp ? ' (in-app browser)' : ''}`,
  }
}

export function MicDiagnostics({
  stream,
  error,
  downstream = [],
  note,
}: {
  stream?: MediaStream | null
  error?: string | null
  downstream?: DownstreamLine[]
  note?: string
}) {
  const [env] = useState<Env>(() => readEnv())
  const [perm, setPerm] = useState<string>('checking...')
  const [tracks, setTracks] = useState<TrackInfo[]>([])
  const [level, setLevel] = useState(0)
  const [peak, setPeak] = useState(0)
  const [ctxState, setCtxState] = useState('none')
  const meterRef = useRef<MicMeter | null>(null)

  // Permission state (where the API exists). granted / denied / prompt.
  useEffect(() => {
    const anyNav = navigator as Navigator & { permissions?: { query: (d: { name: string }) => Promise<{ state: string }> } }
    if (!anyNav.permissions?.query) {
      setPerm('unknown (no permissions API)')
      return
    }
    anyNav.permissions
      .query({ name: 'microphone' })
      .then((r) => setPerm(r.state))
      .catch(() => setPerm('unknown'))
  }, [stream])

  // Attach the meter + poll track/level/context state while a stream is live.
  useEffect(() => {
    if (!stream) {
      setTracks([])
      setLevel(0)
      setPeak(0)
      setCtxState('none')
      return
    }
    const readTracks = () =>
      stream.getAudioTracks().map((t) => ({
        enabled: t.enabled,
        readyState: t.readyState,
        muted: t.muted,
        label: t.label || '(unnamed)',
      }))
    setTracks(readTracks())
    const meter = startMeter(stream)
    meterRef.current = meter
    let localPeak = 0
    const id = setInterval(() => {
      const l = meter.level()
      setLevel(l)
      if (l > localPeak) {
        localPeak = l
        setPeak(l)
      }
      setCtxState(meter.contextState())
      setTracks(readTracks())
    }, 200)
    return () => {
      clearInterval(id)
      meter.stop()
      meterRef.current = null
    }
  }, [stream])

  // The last stage that is OK, so the failing stage is obvious.
  const track = tracks[0]
  const stages: Array<{ ok: boolean; label: string }> = [
    { ok: env.secure, label: '1 secure context' },
    { ok: env.hasApi, label: '2 mic API present' },
    { ok: perm !== 'denied', label: '3 permission (not denied)' },
    { ok: tracks.length > 0, label: '4 audio track' },
    { ok: Boolean(track && track.enabled && track.readyState === 'live' && !track.muted), label: '5 track live+unmuted' },
    { ok: ctxState === 'running', label: '6 audiocontext running' },
    { ok: peak > 0.02, label: '7 audio flowing (speak!)' },
    ...downstream.map((d) => ({ ok: Boolean(d.ok), label: `8 ${d.label}` })),
  ]
  let lastOk = 'none'
  let firstBad = 'secure context'
  for (const s of stages) {
    if (s.ok) lastOk = s.label
    else {
      firstBad = s.label
      break
    }
  }
  const allOk = stages.every((s) => s.ok)

  const row = (label: string, value: string, ok?: boolean) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
      <span style={{ color: '#8b949e' }}>{label}</span>
      <span style={{ color: ok === undefined ? '#c9d1d9' : ok ? '#7ee787' : '#ff7b72', textAlign: 'right' }}>{value}</span>
    </div>
  )
  const pct = Math.round(level * 100)
  const peakPct = Math.round(peak * 100)

  return (
    <div
      style={{
        marginTop: 20,
        border: '1px solid #2c2c2c',
        borderRadius: 8,
        overflow: 'hidden',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        background: '#0b0b0b',
      }}
    >
      <div style={{ background: '#111', color: '#7ee787', padding: '6px 10px' }}>MIC DIAGNOSTICS</div>
      <div style={{ padding: '8px 10px', display: 'grid', gap: 4 }}>
        <div style={{ color: allOk ? '#7ee787' : '#ffa657', fontWeight: 600 }}>
          {allOk ? 'all stages OK' : `last OK: ${lastOk}  |  FAILS AT: ${firstBad}`}
        </div>
        {row('browser', env.ua)}
        {row('secure context', String(env.secure), env.secure)}
        {row('mediaDevices API', env.hasApi ? 'present' : 'ABSENT', env.hasApi)}
        {row('permission', perm, perm !== 'denied')}
        {row('audio tracks', String(tracks.length), tracks.length > 0)}
        {track
          ? row(
              'track',
              `${track.readyState}, ${track.enabled ? 'enabled' : 'DISABLED'}, ${track.muted ? 'MUTED' : 'unmuted'}${track.label !== '(unnamed)' ? `, ${track.label.slice(0, 22)}` : ''}`,
              track.enabled && track.readyState === 'live' && !track.muted
            )
          : null}
        {stream ? row('audioContext', ctxState, ctxState === 'running') : null}
        {stream ? (
          <div style={{ display: 'grid', gap: 3, marginTop: 2 }}>
            {row('input level (speak now)', `${pct}%  peak ${peakPct}%`, peak > 0.02)}
            <div style={{ height: 10, background: '#161616', borderRadius: 5, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: pct > 4 ? '#7ee787' : '#484f58', transition: 'width 80ms linear' }} />
            </div>
            {ctxState === 'suspended' ? (
              <button
                type="button"
                onClick={() => void meterRef.current?.resume()}
                style={{ marginTop: 4, alignSelf: 'start', background: '#21262d', color: '#c9d1d9', border: '1px solid #30363d', borderRadius: 5, padding: '4px 8px', cursor: 'pointer', fontSize: 11 }}
              >
                Tap to enable the audio meter
              </button>
            ) : null}
          </div>
        ) : null}
        {downstream.length ? <div style={{ borderTop: '1px solid #21262d', margin: '4px 0' }} /> : null}
        {downstream.map((d, i) => (
          <div key={i}>{row(d.label, d.value, d.ok)}</div>
        ))}
        {error ? row('error', error, false) : null}
        {note ? <div style={{ color: '#6e7681', marginTop: 4 }}>{note}</div> : null}
      </div>
    </div>
  )
}
