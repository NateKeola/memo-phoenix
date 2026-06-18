import 'server-only'

// ElevenLabs Conversational AI, server-side. The ELEVENLABS_API_KEY never reaches
// the browser: the client connects with a short-lived signed URL minted here.
const BASE = 'https://api.elevenlabs.io'

function apiKey(): string {
  const k = process.env.ELEVENLABS_API_KEY
  if (!k) throw new Error('[elevenlabs] ELEVENLABS_API_KEY is not set')
  return k
}

// Mint a signed WebSocket URL for the configured agent. The client uses it to
// connect; the API key stays here.
export async function getSignedUrl(): Promise<string> {
  const agentId = process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID
  if (!agentId) throw new Error('[elevenlabs] NEXT_PUBLIC_ELEVENLABS_AGENT_ID is not set')
  const res = await fetch(
    `${BASE}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
    { method: 'GET', headers: { 'xi-api-key': apiKey() }, cache: 'no-store' }
  )
  if (!res.ok) throw new Error(`[elevenlabs] signed-url ${res.status}: ${(await res.text()).slice(0, 200)}`)
  let data: { signed_url?: string }
  try {
    data = (await res.json()) as { signed_url?: string }
  } catch (err) {
    throw new Error(`[elevenlabs] failed to parse signed-url response: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!data.signed_url) throw new Error('[elevenlabs] response missing signed_url')
  return data.signed_url
}

export type FetchedTranscript = { text: string; status: string; turns: number }

// Fetch the authoritative transcript for a finished conversation, retrying while
// ElevenLabs is still processing. Returns null only on hard failure to fetch.
export async function fetchTranscript(conversationId: string, maxAttempts = 8): Promise<FetchedTranscript | null> {
  let last: FetchedTranscript | null = null
  for (let i = 0; i < maxAttempts; i++) {
    let res: Response
    try {
      res = await fetch(`${BASE}/v1/convai/conversations/${encodeURIComponent(conversationId)}`, {
        method: 'GET',
        headers: { 'xi-api-key': apiKey() },
        cache: 'no-store',
      })
    } catch {
      await sleep(backoff(i))
      continue
    }
    if (!res.ok) {
      await sleep(backoff(i))
      continue
    }
    let root: Record<string, unknown>
    try {
      root = (await res.json()) as Record<string, unknown>
    } catch {
      await sleep(backoff(i)) // non-JSON / transient body; retry
      continue
    }
    // the transcript may be top-level or nested under `data` (webhook-shaped)
    const inner = (root.data as Record<string, unknown>) ?? root
    const status = String((root.status as string) ?? (inner.status as string) ?? 'unknown')
    const turns = Array.isArray(inner.transcript)
      ? (inner.transcript as Array<{ role?: string; message?: string | null }>)
      : []
    const text = turns
      .filter((t) => t.message && String(t.message).trim())
      .map((t) => `${t.role ?? 'speaker'}: ${String(t.message).trim()}`)
      .join('\n')
    last = { text, status, turns: turns.length }
    // 'done' means ElevenLabs finished processing (an empty conversation is
    // handled by the caller); 'failed' is terminal. Keep retrying only while the
    // conversation is still processing.
    if (status === 'done' || status === 'failed') return last
    await sleep(backoff(i))
  }
  return last
}

function backoff(i: number): number {
  return Math.min(1000 * Math.pow(1.5, i), 5000)
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
