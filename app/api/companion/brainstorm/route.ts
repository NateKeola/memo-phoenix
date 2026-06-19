import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { logEvent } from '@/lib/telemetry'
import { runChat, type ChatTurn } from '@/lib/chat/agent'
import { brainstormSystemPrompt } from '@/lib/companion/brainstorm'

export const runtime = 'nodejs'

const MAX_TURNS = 10

// A short, on-demand brainstorm conversation about one follow-up. Reuses the chat
// composing loop (graph access via the retrieval tools) with the companion
// brainstorm system prompt. It only suggests; it never sends. Streams plain text.
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
    return 'I cannot reach the model right now (usage limit). Your graph is fine; try again later.'
  }
  if (/ANTHROPIC_API_KEY/.test(msg)) return 'The model is not configured on the server.'
  return 'Something went wrong. Please try again.'
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as { seed?: unknown; messages?: unknown }
  const seed = typeof body.seed === 'string' ? body.seed : ''
  const turns = normalizeTurns(body.messages)
  if (turns.length === 0 || turns[turns.length - 1].role !== 'user') {
    return NextResponse.json({ error: 'send a message' }, { status: 400 })
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
          systemPrompt: brainstormSystemPrompt(seed),
          onText: (delta) => controller.enqueue(encoder.encode(delta)),
        })
        await logEvent({
          user_id: user.id,
          event_type: 'companion_brainstorm',
          duration_ms: Date.now() - started,
          attrs: {
            tool_calls: result.toolCalls.length,
            turns: turns.length,
            answer_chars: result.text.length,
            cache_hit: result.usage.cache_read_input_tokens > 0,
          },
        })
      } catch (err) {
        console.error('[companion/brainstorm] failed:', err)
        controller.enqueue(encoder.encode(friendlyError(err)))
        await logEvent({ user_id: user.id, event_type: 'error', name: 'companion_brainstorm', attrs: { message: err instanceof Error ? err.message : String(err) } })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
}
