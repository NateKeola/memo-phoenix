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
  meta: LlmMeta
}

// Shaped metadata about ONE model response. Every field is a count, an enum, or a
// token total, so it is safe to put in a thrown Error (which mineWithLock persists to
// miner_runs.error) and in telemetry. The response TEXT is deliberately NOT part of
// it: model output summarizes real people, so it is user content and never reaches a
// table. It goes to stdout only, via dumpModelOutput below.
export type LlmMeta = {
  stop_reason: string
  block_count: number
  block_types: string[]
  text_chars: number
  input_tokens: number
  output_tokens: number
  // How much of output_tokens was internal reasoning. The API returns this in
  // usage.output_tokens_details and the miner has simply never read it, which is why
  // "how much of the budget is thinking" could not be answered from the recorded
  // usage of any past run. null when the API omits the breakdown.
  thinking_tokens: number | null
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// Stable marker so a decorated message can be recognized and not decorated twice.
const LLM_META_MARKER = 'llm: stop_reason='

// One-line, shaped rendering of LlmMeta. Carries no model text.
export function describeLlmMeta(m: LlmMeta): string {
  return (
    `${LLM_META_MARKER}${m.stop_reason} text_chars=${m.text_chars} ` +
    `blocks=${m.block_count}[${m.block_types.join(',')}] ` +
    `tokens_in=${m.input_tokens} tokens_out=${m.output_tokens} ` +
    `thinking=${m.thinking_tokens ?? 'n/a'} ` +
    `cache_read=${m.cache_read_input_tokens} cache_write=${m.cache_creation_input_tokens}`
  )
}

// Attach the call metadata to an error raised DOWNSTREAM of the call (a provenance
// rejection), so it arrives with the same context a parse failure has. Idempotent:
// parseModelObject already embeds its own. Mutates the message so the stack survives.
export function decorateWithLlmMeta(err: unknown, meta: LlmMeta): Error {
  const e = err instanceof Error ? err : new Error(String(err))
  if (e.message.includes(LLM_META_MARKER)) return e
  e.message = `${e.message} [${describeLlmMeta(meta)}]`
  return e
}

// Print the COMPLETE model response to stdout so a parse failure can actually be
// attributed. The 2026-08-07 failure could not be, because the only surviving copy
// was a 200-character slice.
//
// This is the ONLY place model text is emitted, and it goes to stdout ONLY (the
// GitHub Action log). It must never be written to telemetry_events,
// observability_events, miner_runs.error, or any other table.
function dumpModelOutput(ctx: string, text: string, meta?: LlmMeta): void {
  console.log(`[miner] ===== BEGIN raw model output (${ctx}) =====`)
  if (meta) console.log(`[miner] ${describeLlmMeta(meta)}`)
  console.log(text)
  console.log(`[miner] ===== END raw model output (${ctx}), ${text.length} chars =====`)
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

  const content = message.content as Anthropic.ContentBlock[]
  const raw = messageText(content)

  const u = message.usage
  const meta: LlmMeta = {
    stop_reason: message.stop_reason ?? 'unknown',
    block_count: content.length,
    block_types: content.map((b) => b.type),
    text_chars: raw.length,
    input_tokens: u?.input_tokens ?? 0,
    output_tokens: u?.output_tokens ?? 0,
    thinking_tokens: u?.output_tokens_details?.thinking_tokens ?? null,
    cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
  }

  if (!raw.trim()) {
    // model returned only thinking blocks (or stopped early): a clearer error
    // than JSON.parse('') failing downstream. This path does NOT retry (it is
    // raised outside the batch-retry try/catch), which is preserved as-is.
    throw new Error(`[miner] model returned no text (${describeLlmMeta(meta)})`)
  }

  return {
    raw,
    usage: {
      input_tokens: meta.input_tokens,
      output_tokens: meta.output_tokens,
      cache_read_input_tokens: meta.cache_read_input_tokens,
      cache_creation_input_tokens: meta.cache_creation_input_tokens,
    },
    meta,
  }
}

// Strip ```json fences (the model is instructed not to use them, but be tolerant).
export function stripFences(text: string): string {
  const t = text.trim()
  const m = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/)
  return (m ? m[1] : t).trim()
}

// V8 embeds a slice of the INPUT in some parse messages
// (`Unexpected token 'H', "Here is th"... is not valid JSON`). That slice is model
// output, so it is cut here before the message goes into a thrown Error that
// mineWithLock persists to miner_runs.error. The position/line/column forms carry no
// input and pass through whole. The full text is on stdout either way.
export function structuralParseMessage(message: string): string {
  const cut = message.indexOf(', "')
  return cut === -1 ? message : `${message.slice(0, cut)} (input snippet withheld; see stdout)`
}

// `meta` is optional so this stays callable without a Message, but every caller in the
// miner passes it. The thrown Error carries the SHAPED metadata, not a text slice: the
// previous `stripped.slice(0, 200)` put model-authored prose (summaries of real people)
// into miner_runs.error, which is a database table. The full text is printed to stdout
// instead, which is strictly more useful for attribution and does not persist content.
export function parseModelObject(raw: string, ctx: string, meta?: LlmMeta): Record<string, unknown> {
  const stripped = stripFences(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch (err) {
    dumpModelOutput(ctx, stripped, meta)
    throw new Error(
      `[miner] ${ctx}: model did not return valid JSON (${structuralParseMessage(err instanceof Error ? err.message : String(err))})` +
        ` [${meta ? describeLlmMeta(meta) : 'llm meta unavailable'}]` +
        ` [full output printed to stdout, ${stripped.length} chars]`
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    dumpModelOutput(ctx, stripped, meta)
    throw new Error(
      `[miner] ${ctx}: model returned a non-object JSON value` +
        ` [${meta ? describeLlmMeta(meta) : 'llm meta unavailable'}]` +
        ` [full output printed to stdout, ${stripped.length} chars]`
    )
  }
  return parsed as Record<string, unknown>
}
