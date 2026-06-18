'use client'

import Link from 'next/link'
import { useRef, useState } from 'react'

type State = 'idle' | 'recording' | 'transcribing' | 'done' | 'error'

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
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setError('Microphone permission denied or unavailable.')
      setState('error')
      return
    }
    const recorder = new MediaRecorder(stream)
    chunksRef.current = []
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
      setState('transcribing')
      try {
        const res = await fetch('/api/capture/memo', {
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

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 560 }}>
      <p><Link href="/">&larr; Home</Link></p>
      <h1>Add memo</h1>
      <p>Record a voice memo. One way, no conversation. It is transcribed and captured.</p>

      {state === 'idle' || state === 'done' || state === 'error' ? (
        <button type="button" onClick={start}>Start recording</button>
      ) : null}
      {state === 'recording' ? (
        <button type="button" onClick={stop}>Stop and transcribe</button>
      ) : null}
      {state === 'recording' ? <p>Recording...</p> : null}
      {state === 'transcribing' ? <p>Transcribing...</p> : null}

      {error ? <p style={{ color: 'crimson' }}>{error}</p> : null}
      {state === 'done' ? (
        <div style={{ marginTop: 16 }}>
          <p style={{ color: 'green' }}>Captured.</p>
          <p style={{ whiteSpace: 'pre-wrap', background: '#f5f5f5', padding: 12 }}>{transcript}</p>
        </div>
      ) : null}
    </main>
  )
}
