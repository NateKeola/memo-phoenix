import Anthropic from '@anthropic-ai/sdk'
import { EFFORT, MAX_TOKENS, MODEL, THINKING_ON } from './config'

export type LlmResult = {
  raw: string
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
  }
}

let client: Anthropic | null = null
function getClient(): Anthropic {
  if (client) return client
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('[miner] ANTHROPIC_API_KEY is not set')
  client = new Anthropic({ apiKey })
  return client
}

// Assemble the answer text from a completed message: the text blocks only. Extended
// thinking lives in separate `thinking` blocks (adaptive thinking keeps reasoning out
// of the answer), so filtering to text blocks means thinking never leaks into the
// parsed JSON. This is the same reconstruction for a streamed or non-streamed
// message (finalMessage() returns the identical block shape). Exported so the
// assembly can be checked offline (scripts/check-streaming.ts).
export function messageText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

// One LLM call. The static stage instructions go in a cached system block
// (cache_control ephemeral) so repeated pagination batches and repeated captures
// reuse the prefix; the variable data goes in the user message. Adaptive thinking
// keeps reasoning in thinking blocks (not the response text), so the text stays
// clean JSON.
export async function callClaude(system: string, user: string): Promise<LlmResult> {
  // Built as a variable then cast, so newer API fields (output_config, adaptive
  // thinking) pass through even if the installed SDK types lag.
  const params = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    ...(THINKING_ON ? { thinking: { type: 'adaptive' } } : {}),
    output_config: { effort: EFFORT },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
  }
  // Stream the request. The SDK's NON-streaming messages.create refuses upfront any
  // request whose max_tokens could imply a >10-minute generation
  // (client.js _calculateNonstreamingTimeout throws "Streaming is required for
  // operations that may take longer than 10 minutes" once max_tokens exceeds
  // ~21,333: (60 * max_tokens) / 128000 > 10 min). Raising MAX_TOKENS to 24000 (with
  // extended thinking on) crossed that line, so the full-recompute passes were
  // refused. messages.stream() has no such upfront limit; each call still emits a
  // bounded page (pageLimit), so a single request stays well under 10 minutes.
  // finalMessage() assembles the SAME Message a non-streaming create returns
  // (thinking + text blocks, usage, stop_reason), so the extraction below is
  // byte-identical and the JSON parses the same. The SDK's built-in retries and abort
  // apply to the stream request too; a mid-stream failure rejects finalMessage() and
  // propagates exactly as a non-streaming error did.
  const message = await getClient()
    .messages.stream(params as unknown as Anthropic.MessageStreamParams)
    .finalMessage()

  const raw = messageText(message.content as Anthropic.ContentBlock[])

  if (!raw.trim()) {
    // model returned only thinking blocks (or stopped early): a clearer error
    // than JSON.parse('') failing downstream. The batch-retry loop will re-call.
    throw new Error(`[miner] model returned no text (stop_reason=${message.stop_reason ?? 'unknown'})`)
  }

  const u = message.usage
  return {
    raw,
    usage: {
      input_tokens: u?.input_tokens ?? 0,
      output_tokens: u?.output_tokens ?? 0,
      cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
    },
  }
}

// Strip ```json fences (the model is instructed not to use them, but be tolerant).
export function stripFences(text: string): string {
  const t = text.trim()
  const m = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/)
  return (m ? m[1] : t).trim()
}

export function parseModelObject(raw: string, ctx: string): Record<string, unknown> {
  const stripped = stripFences(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch (err) {
    throw new Error(
      `[miner] ${ctx}: model did not return valid JSON (${err instanceof Error ? err.message : String(err)}): ${stripped.slice(0, 200)}`
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`[miner] ${ctx}: model returned a non-object JSON value`)
  }
  return parsed as Record<string, unknown>
}
