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
  const message = await getClient().messages.create(
    params as unknown as Anthropic.MessageCreateParamsNonStreaming
  )

  const raw = (message.content as Anthropic.ContentBlock[])
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')

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
