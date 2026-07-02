'use client'

import { useRef, useState } from 'react'
import { PageHeader } from '@/components/page-header'
import { IconMic } from '@/components/icons'
import { acquireMic, releaseStream } from '@/lib/media/mic'
import { MicDiagnostics, type DownstreamLine } from '@/components/mic-diagnostics'

type State = 'idle' | 'recording' | 'transcribing' | 'done' | 'error'

// capture-with-target: an "add memo about X" surface links here with the target as
// query params, which we forward to the memo API so the capture knows its subject.
function targetQuery(): string {
  if (typeof window === 'undefined') return ''
  const sp = new URLSearchParams(window.location.search)
  const kind = sp.get('target_kind')
  if (!kind) return ''
  const out = new URLSearchParams({ target_kind: kind })
  const id = sp.get('target_id')
  if (id) out.set('target_id', id)
  out.set('source', sp.get('source') ?? 'memo')
  return `?${out.toString()}`
}

export default function AddMemoPage() {
  const [state, setState] = useState<State>('idle')
  const [transcript, setTranscript] = useState('')
  const [error, setError] = useState('')
  // The live capture stream, kept in state so the diagnostics panel can meter it
  // (show that real audio is flowing) while recording.
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [down, setDown] = useState<DownstreamLine[]>([])
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  async function start() {
    setError('')
    setTranscript('')
    setDown([])
    let s: MediaStream
    try {
      s = await acquireMic()
    } catch (e) {
      // Surface the REAL reason (in-app browser, blocked permission, no device,
      // device busy, insecure context) instead of one generic string.
      setError(e instanceof Error ? e.message : 'Microphone unavailable.')
      setState('error')
      return
    }
    setStream(s) // hand the live stream to the diagnostics meter
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(s)
    } catch (e) {
      releaseStream(s)
      setStream(null)
      setError(
        `This browser cannot record audio (${e instanceof Error ? e.message : String(e)}). Try Safari or Chrome.`
      )
      setState('error')
      return
    }
    chunksRef.current = []
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }
    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
      // Downstream visibility: exactly what we send to Scribe and what comes back.
      const sendLine: DownstreamLine = {
        label: 'sent to Scribe',
        value: `${blob.size} bytes, ${blob.type || 'audio/webm'}`,
        ok: blob.size > 0,
      }
      setDown([sendLine])
      setState('transcribing')
      try {
        const res = await fetch(`/api/capture/memo${targetQuery()}`, {
          method: 'POST',
          headers: { 'content-type': blob.type },
          body: blob,
        })
        const json = (await res.json().catch(() => ({}))) as { transcript?: string; error?: string }
        setDown([
          sendLine,
          {
            label: 'Scribe response',
            value: res.ok
              ? `${res.status} ok, ${String(json.transcript ?? '').length} chars`
              : `${res.status} ${json.error ?? 'error'}`,
            ok: res.ok,
          },
        ])
        if (!res.ok) throw new Error(json.error || `transcription failed (${res.status})`)
        setTranscript(json.transcript ?? '')
        setState('done')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setState('error')
      } finally {
        // Release the mic AFTER we have read the downstream result (the panel keeps
        // its last reading; the meter simply goes idle).
        releaseStream(s)
        setStream(null)
      }
    }
    recorderRef.current = recorder
    recorder.start()
    setState('recording')
  }

  function stop() {
    recorderRef.current?.stop()
  }

  return (
    <main className="mp-page mp-page--flush" style={{ maxWidth: 560 }}>
      <PageHeader back="/" backLabel="Home" />
      <p className="mp-eyebrow">Voice memo</p>
      <h1 className="mp-h1" style={{ marginTop: 8 }}>Add memo</h1>
      <p className="mp-sub">Record a voice memo. One way, no conversation. It is transcribed and captured.</p>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, marginTop: 40 }}>
        <div style={{ position: 'relative', width: 96, height: 96, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {state === 'recording' ? (
            <>
              <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '1.5px solid var(--accent)', animation: 'mp-recpulse 2.2s ease-out infinite' }} aria-hidden />
              <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '1.5px solid var(--accent)', animation: 'mp-recpulse 2.2s ease-out infinite', animationDelay: '1.1s' }} aria-hidden />
            </>
          ) : null}
          <button
            type="button"
            onClick={state === 'recording' ? stop : start}
            disabled={state === 'transcribing'}
            aria-label={state === 'recording' ? 'Stop and transcribe' : 'Start recording'}
            style={{
              position: 'relative',
              width: 96,
              height: 96,
              borderRadius: '50%',
              border: 0,
              background: 'var(--accent)',
              color: 'var(--scr-bg)',
              cursor: state === 'transcribing' ? 'default' : 'pointer',
              opacity: state === 'transcribing' ? 0.5 : 1,
              boxShadow: 'var(--shadow-fab)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {state === 'recording' ? (
              <span style={{ width: 22, height: 22, borderRadius: 5, background: 'var(--scr-bg)' }} />
            ) : (
              <IconMic size={30} />
            )}
          </button>
        </div>

        <p className="mp-meta" style={{ minHeight: 18, letterSpacing: '0.04em' }}>
          {state === 'recording' ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--accent)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--record-soft)', animation: 'mp-recdot 1.3s infinite' }} />
              Recording &middot; tap to stop
            </span>
          ) : state === 'transcribing' ? (
            'Transcribing your memo...'
          ) : state === 'done' || state === 'error' ? (
            'Tap to record again'
          ) : (
            'Tap to record'
          )}
        </p>
      </div>

      {error ? <p className="mp-bad mp-rise" style={{ marginTop: 24 }}>{error}</p> : null}
      {state === 'done' ? (
        <div className="mp-rise" style={{ marginTop: 24 }}>
          <p className="mp-ok">Captured.</p>
          <div className="mp-card mp-card--recessed" style={{ marginTop: 10, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
            {transcript}
          </div>
        </div>
      ) : null}

      {/* Always-on capture diagnostics: while recording, the input-level meter should
          move when you speak. If it stays flat, the mic is delivering silence (the
          real failure), not a permission error. */}
      <MicDiagnostics
        stream={stream}
        error={error || null}
        downstream={down}
        note={state === 'recording' ? 'Speak now: the input level bar should move.' : undefined}
      />
    </main>
  )
}
