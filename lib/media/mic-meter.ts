// A browser-level microphone INPUT-LEVEL METER, independent of any SDK. Given a
// MediaStream (from getUserMedia), it taps the audio with a WebAudio AnalyserNode
// and reports a live 0..1 level. This is the single most decisive mic diagnostic:
// it separates "permission granted but NO audio flows" (flat level while speaking:
// muted track, wrong device, OS-muted, or a suspended AudioContext) from "audio IS
// captured but the downstream consumer does not receive it" (level moves, but Scribe
// returns nothing / the interview SDK reports VAD 0). Because the memo path uses
// MediaRecorder and the interview path uses the ElevenLabs SDK, neither exposed a
// raw browser-level reading before this.
//
// Chrome caveat this also surfaces: an AudioContext created after an `await` in a
// click handler loses the user-activation and starts SUSPENDED, so no samples flow
// until resumed. We resume on creation and expose the context state, so a stuck
// suspended context is visible (and a gesture button can resume it).

type AnyWindow = Window & {
  webkitAudioContext?: typeof AudioContext
}

function AudioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null
  const w = window as AnyWindow
  return window.AudioContext || w.webkitAudioContext || null
}

export type MicMeter = {
  // Peak amplitude of the most recent audio frame, 0..1. ~0 while silent.
  level: () => number
  // 'running' | 'suspended' | 'closed' | 'unavailable'
  contextState: () => string
  // Resume a suspended AudioContext (call from a user gesture if needed).
  resume: () => Promise<void>
  // Tear down the analyser + context (does NOT stop the stream's tracks).
  stop: () => void
}

// Attach a meter to a live stream. Never throws: on any failure it returns a meter
// that reports level 0 and contextState 'unavailable', so instrumentation can render
// that fact instead of crashing the capture flow.
export function startMeter(stream: MediaStream): MicMeter {
  const Ctor = AudioContextCtor()
  if (!Ctor) {
    return { level: () => 0, contextState: () => 'unavailable', resume: async () => {}, stop: () => {} }
  }
  let ctx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let buf: Uint8Array<ArrayBuffer> | null = null
  try {
    ctx = new Ctor()
    source = ctx.createMediaStreamSource(stream)
    analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    buf = new Uint8Array(new ArrayBuffer(analyser.fftSize))
    source.connect(analyser)
    // Best-effort resume (Chrome may start it suspended after an await).
    void ctx.resume().catch(() => {})
  } catch {
    try {
      ctx?.close()
    } catch {
      /* ignore */
    }
    return { level: () => 0, contextState: () => 'unavailable', resume: async () => {}, stop: () => {} }
  }

  return {
    level: () => {
      if (!analyser || !buf) return 0
      analyser.getByteTimeDomainData(buf)
      // peak deviation from the 128 midpoint, normalized to 0..1
      let peak = 0
      for (let i = 0; i < buf.length; i++) {
        const dev = Math.abs(buf[i] - 128)
        if (dev > peak) peak = dev
      }
      return Math.min(1, peak / 128)
    },
    contextState: () => ctx?.state ?? 'unavailable',
    resume: async () => {
      try {
        await ctx?.resume()
      } catch {
        /* ignore */
      }
    },
    stop: () => {
      try {
        source?.disconnect()
        analyser?.disconnect()
        void ctx?.close()
      } catch {
        /* ignore */
      }
    },
  }
}
