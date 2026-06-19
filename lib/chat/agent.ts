import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/telemetry'
import { CHAT_SYSTEM_PROMPT } from './system-prompt'
import {
  CANONICAL_TABLES,
  findCommitments,
  getPerson,
  getProject,
  getProvenance,
  listInCollection,
  listRecent,
  listUpcoming,
  neighborsOf,
  searchFacts,
  type CanonicalType,
  type RetrievalDeps,
} from './retrieval'

// The composer is a thin stage: Opus routes to the deterministic retrieval tools
// and writes the grounded answer. Lighter effort than the miner (this is read +
// compose, not extraction). All env-overridable.
const MODEL = process.env.CHAT_MODEL || 'claude-opus-4-8'
const EFFORT = process.env.CHAT_EFFORT || 'medium'
const MAX_TOKENS = Number(process.env.CHAT_MAX_TOKENS) || 2048
const MAX_ITERATIONS = 8

let client: Anthropic | null = null
function getClient(): Anthropic {
  if (client) return client
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('[chat] ANTHROPIC_API_KEY is not set')
  client = new Anthropic({ apiKey })
  return client
}

const CANONICAL_TYPE_NAMES = Object.keys(CANONICAL_TABLES) as CanonicalType[]

// Tool catalog. Each maps to a deterministic query in retrieval.ts. Descriptions
// double as routing hints for the model (the system prompt covers the rest).
const TOOLS = [
  {
    name: 'get_person',
    description:
      "Look up a person in the user's graph by name or alias (handles fuzzy spellings). Returns matching people with role, relationship, summary, and provenance.",
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The person name or alias to find.' } },
      required: ['name'],
    },
  },
  {
    name: 'get_project',
    description:
      "Look up the user's projects. Pass a name to find a specific one, or omit to list current projects with their status.",
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Optional project name to match.' } },
    },
  },
  {
    name: 'find_commitments',
    description:
      'Find commitments, promises, and to-dos. Defaults to everything not done. Filter by status, by the person involved, or by a free-text query.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'scheduled', 'done', 'snoozed'], description: 'Optional status filter.' },
        person: { type: 'string', description: 'Optional: only commitments tied to this person name.' },
        query: { type: 'string', description: 'Optional free-text filter.' },
      },
    },
  },
  {
    name: 'list_upcoming',
    description:
      'What is coming up: current events plus commitments still owed. Dates may be informal ("tomorrow"); they are returned as written.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max of each kind (default 15).' } },
    },
  },
  {
    name: 'search_facts',
    description:
      "Search the user's durable facts, preferences, and habits by topic. Set include_insights to also surface higher-level cross-corpus patterns.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        include_insights: { type: 'boolean', description: 'Also include insight patterns.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'neighbors_of',
    description:
      'Given a canonical node id (from an earlier tool result), return the nodes it is connected to via relationships, with the relation and direction.',
    input_schema: {
      type: 'object',
      properties: { node_id: { type: 'string', description: 'A canonical node id.' } },
      required: ['node_id'],
    },
  },
  {
    name: 'list_recent',
    description: 'List the most recently learned rows of a canonical type.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: CANONICAL_TYPE_NAMES, description: 'Which canonical type.' },
        limit: { type: 'number', description: 'How many (default 10, max 25).' },
      },
      required: ['type'],
    },
  },
  {
    name: 'list_in_collection',
    description: 'List items in a named collection (for example a gift list or books to read).',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The collection name.' } },
      required: ['name'],
    },
  },
  {
    name: 'get_provenance',
    description:
      'Resolve source_claim_ids (from any tool result) to the captures they came from, with the capture mode, date, and a snippet. Use to cite when or where the user said something.',
    input_schema: {
      type: 'object',
      properties: { claim_ids: { type: 'array', items: { type: 'string' }, description: 'source_claim_ids to resolve.' } },
      required: ['claim_ids'],
    },
  },
]

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

// Execute one tool call against canonical. Returns a JSON-serializable result, or
// an { error } object the model can read and recover from. Never throws.
async function executeTool(deps: RetrievalDeps, name: string, input: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'get_person': {
        const n = str(input.name)
        if (!n) return { error: 'name is required' }
        return { people: await getPerson(deps, n) }
      }
      case 'get_project':
        return { projects: await getProject(deps, str(input.name)) }
      case 'find_commitments':
        return {
          commitments: await findCommitments(deps, {
            status: str(input.status),
            person: str(input.person),
            query: str(input.query),
          }),
        }
      case 'list_upcoming':
        return await listUpcoming(deps, typeof input.limit === 'number' ? input.limit : 15)
      case 'search_facts': {
        const q = str(input.query)
        if (!q) return { error: 'query is required' }
        return { results: await searchFacts(deps, q, Boolean(input.include_insights)) }
      }
      case 'neighbors_of': {
        const id = str(input.node_id)
        if (!id) return { error: 'node_id is required' }
        return await neighborsOf(deps, id)
      }
      case 'list_recent': {
        const t = str(input.type)
        if (!t || !(t in CANONICAL_TABLES)) return { error: `type must be one of ${CANONICAL_TYPE_NAMES.join(', ')}` }
        return { rows: await listRecent(deps, t as CanonicalType, typeof input.limit === 'number' ? input.limit : 10) }
      }
      case 'list_in_collection': {
        const n = str(input.name)
        if (!n) return { error: 'name is required' }
        return await listInCollection(deps, n)
      }
      case 'get_provenance': {
        const ids = Array.isArray(input.claim_ids) ? (input.claim_ids as unknown[]).map((x) => String(x)) : []
        if (ids.length === 0) return { error: 'claim_ids is required' }
        return await getProvenance(deps, ids)
      }
      default:
        return { error: `unknown tool ${name}` }
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export type ChatTurn = { role: 'user' | 'assistant'; content: string }
export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
export type ChatResult = {
  text: string
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>
  iterations: number
  usage: Usage
  capHit: boolean
  truncated: boolean
}

function baseParams(messages: Anthropic.MessageParam[], system: string, toolChoiceNone = false) {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: EFFORT },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    tools: TOOLS,
    // tool_choice 'none' forces a text answer from the context already gathered.
    ...(toolChoiceNone ? { tool_choice: { type: 'none' } } : {}),
    messages,
  }
}

function addUsage(usage: Usage, u: Anthropic.Message['usage'] | undefined) {
  usage.input_tokens += u?.input_tokens ?? 0
  usage.output_tokens += u?.output_tokens ?? 0
  usage.cache_read_input_tokens += u?.cache_read_input_tokens ?? 0
  usage.cache_creation_input_tokens += u?.cache_creation_input_tokens ?? 0
}

function textOf(msg: Anthropic.Message): string {
  return (msg.content as Anthropic.ContentBlock[])
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

// Chunk the final answer so the route can deliver it progressively. We stream
// only the composed answer (not intermediate tool-routing turns), so the client
// never sees routing chatter, and the streamed bytes equal the recorded text.
function* chunk(text: string, size = 280): Generator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size)
}

// Run the composing loop: route to tools until the model writes its answer, then
// stream that answer. onText receives ONLY the final answer, in chunks.
export async function runChat(opts: {
  supabase: SupabaseClient
  userId: string
  turns: ChatTurn[]
  onText?: (delta: string) => void
  systemPrompt?: string
}): Promise<ChatResult> {
  const deps: RetrievalDeps = { supabase: opts.supabase, userId: opts.userId }
  const system = opts.systemPrompt ?? CHAT_SYSTEM_PROMPT
  const messages: Anthropic.MessageParam[] = opts.turns.map((t) => ({ role: t.role, content: t.content }))
  const toolCalls: ChatResult['toolCalls'] = []
  const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  let answer = ''
  let iterations = 0
  let capHit = false
  let truncated = false

  while (iterations < MAX_ITERATIONS) {
    iterations++
    const msg = await getClient().messages.create(
      baseParams(messages, system) as unknown as Anthropic.MessageCreateParamsNonStreaming
    )
    addUsage(usage, msg.usage)

    const toolUses = (msg.content as Anthropic.ContentBlock[]).filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    )

    // Execute tools whenever the model asked for any, regardless of stop_reason
    // (a turn can carry tool_use blocks with a non-'tool_use' stop reason).
    if (toolUses.length > 0) {
      // Replay the full assistant content (including thinking blocks) so the loop
      // can continue, then answer each tool call.
      messages.push({ role: 'assistant', content: msg.content })
      const results: Anthropic.ToolResultBlockParam[] = []
      for (const tu of toolUses) {
        const input = (tu.input ?? {}) as Record<string, unknown>
        const started = Date.now()
        const out = await executeTool(deps, tu.name, input)
        toolCalls.push({ name: tu.name, input })
        // Telemetry: one tool_call event per invocation (spec §10 verifiability).
        await logEvent({
          user_id: opts.userId,
          event_type: 'tool_call',
          name: tu.name,
          duration_ms: Date.now() - started,
          attrs: {
            surface: 'chat',
            input,
            ok: !(out && typeof out === 'object' && 'error' in (out as object)),
          },
        })
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) })
      }
      messages.push({ role: 'user', content: results })
      continue
    }

    // No tool call: this turn is the answer.
    answer = textOf(msg)
    truncated = msg.stop_reason === 'max_tokens'
    break
  }

  // Cap-hit recovery: the loop was exhausted while the model still wanted tools,
  // so the last tool batch was gathered but never composed. Force one final,
  // tool-free turn to answer from what we have, rather than returning nothing.
  if (!answer) {
    capHit = true
    try {
      const forced = await getClient().messages.create(
        baseParams(messages, system, true) as unknown as Anthropic.MessageCreateParamsNonStreaming
      )
      addUsage(usage, forced.usage)
      answer = textOf(forced)
      truncated = forced.stop_reason === 'max_tokens'
    } catch (err) {
      console.error('[chat] forced-answer turn failed:', err)
    }
    if (!answer) answer = 'I gathered some information but could not compose an answer. Try narrowing the question.'
  }

  if (truncated && answer) answer += '\n\n(Answer was cut off. Ask me to continue.)'

  // Stream the final answer only.
  if (answer && opts.onText) for (const part of chunk(answer)) opts.onText(part)

  return { text: answer, toolCalls, iterations, usage, capHit, truncated }
}
