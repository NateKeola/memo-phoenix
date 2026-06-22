import { NextResponse, type NextRequest } from 'next/server'
import { authorizeApiUser } from '@/lib/auth/guard'
import { logEvent } from '@/lib/telemetry'
import { runChat, type ChatTurn } from '@/lib/chat/agent'

export const runtime = 'nodejs'

// Cap the multi-turn context we replay (light memory, no durable storage).
const MAX_TURNS = 10

// Normalize client-supplied turns: keep string-content user/assistant turns, take
// the most recent window, and ensure it starts with a user turn (the API requires
// the first message to be the user).
function normalizeTurns(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return []
  const turns: ChatTurn[] = []
  for (const m of raw) {
    const role = (m as { role?: unknown })?.role
    const content = (m as { content?: unknown })?.content
    if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content.trim()) {
      turns.push({ role, content: content.trim() })
    }
  }
  let windowed = turns.slice(-MAX_TURNS)
  while (windowed.length > 0 && windowed[0].role !== 'user') windowed = windowed.slice(1)
  return windowed
}

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const status = (err as { status?: number })?.status
  if (status === 429 || /usage limit|rate limit|overloaded/i.test(msg)) {
    return 'I cannot reach the model right now (usage limit). Your graph and the retrieval tools are fine; try again later.'
  }
  if (/ANTHROPIC_API_KEY/.test(msg)) {
    return 'The chat model is not configured on the server (missing ANTHROPIC_API_KEY).'
  }
  return 'Something went wrong composing the answer. Please try again.'
}

// Chat over the user's canonical graph. The model routes to deterministic
// retrieval tools (RLS-scoped) and composes a grounded answer that streams back
// as plain text. No durable conversation storage; recent turns come from the body.
export async function POST(request: NextRequest) {
  const auth = await authorizeApiUser()
  if ('error' in auth) return auth.error
  const { supabase, user } = auth

  const body = (await request.json().catch(() => ({}))) as { messages?: unknown }
  const turns = normalizeTurns(body.messages)
  if (turns.length === 0 || turns[turns.length - 1].role !== 'user') {
    return NextResponse.json({ error: 'send at least one user message' }, { status: 400 })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const started = Date.now()
      try {
        const result = await runChat({
          supabase,
          userId: user.id,
          turns,
          onText: (delta) => controller.enqueue(encoder.encode(delta)),
        })
        await logEvent({
          user_id: user.id,
          event_type: 'chat_query',
          duration_ms: Date.now() - started,
          attrs: {
            tool_calls: result.toolCalls.length,
            tools: result.toolCalls.map((t) => t.name),
            iterations: result.iterations,
            answer_chars: result.text.length,
            cap_hit: result.capHit,
            truncated: result.truncated,
            usage: result.usage,
            cache_hit: result.usage.cache_read_input_tokens > 0,
          },
        })
      } catch (err) {
        console.error('[chat] runChat failed:', err)
        controller.enqueue(encoder.encode(friendlyError(err)))
        await logEvent({
          user_id: user.id,
          event_type: 'error',
          name: 'chat',
          duration_ms: Date.now() - started,
          attrs: { message: err instanceof Error ? err.message : String(err) },
        })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}
