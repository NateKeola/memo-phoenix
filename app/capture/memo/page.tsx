'use client'

import { useRef, useState } from 'react'
import { PageHeader } from '@/components/page-header'
import { IconMic } from '@/components/icons'
import { acquireMic, releaseStream } from '@/lib/media/mic'

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
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  async function start() {
    setError('')
    setTranscript('')
    let stream: MediaStream
    try {
      stream = await acquireMic()
    } catch (e) {
      // Surface the REAL reason (in-app browser, blocked permission, no device,
      // device busy, insecure context) instead of one generic string.
      setError(e instanceof Error ? e.message : 'Microphone unavailable.')
      setState('error')
      return
    }
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream)
    } catch (e) {
      // Some browsers reject MediaRecorder / the default codec even after
      // getUserMedia succeeds (older Safari). Release the device and report it.
      releaseStream(stream)
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
      releaseStream(stream)
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
      setState('transcribing')
      try {
        const res = await fetch(`/api/capture/memo${targetQuery()}`, {
          method: 'POST',
          headers: { 'content-type': blob.type },
          body: blob,
        })
        const json = (await res.json()) as { transcript?: string; error?: string }
        if (!res.ok) throw new Error(json.error || 'transcription failed')
        setTranscript(json.transcript ?? '')
        setState('done')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setState('error')
      }
    }
    recorderRef.current = recorder
    recorder.start()
    setState('recording')
  }

  function stop() {
    recorderRef.current?.stop()
  }

  const idle = state === 'idle' || state === 'done' || state === 'error'

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
    </main>
  )
}
