// Offline verification for the streaming miner model call (packages/miner-core/src/
// anthropic.ts). No live API call: it drives the SDK's MessageStream over a RECORDED
// thinking+text stream and asserts the assembly reconstructs the correct final
// content and that the miner's text extraction (messageText) yields the identical
// parsed JSON, with extended-thinking content excluded.
//
// Run: npx tsx scripts/check-streaming.ts
//
// Why this matters: callClaude switched from non-streaming messages.create to
// messages.stream(...).finalMessage() because the SDK refuses a non-streaming request
// whose max_tokens implies a >10-minute generation (it throws "Streaming is required
// for operations that may take longer than 10 minutes" once max_tokens exceeds
// ~21,333, which MINER_MAX_TOKENS=24000 crosses). finalMessage() returns the SAME
// Message shape create() returned, so the extraction is unchanged; this proves it.
import { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream'
import type Anthropic from '@anthropic-ai/sdk'
import { messageText, parseModelObject } from '../packages/miner-core/src/anthropic'

let pass = 0
let fail = 0
function ok(cond: boolean, label: string): void {
  if (cond) {
    pass++
    console.log('  ok   ' + label)
  } else {
    fail++
    console.log('  FAIL ' + label)
  }
}

// --- 1. messageText: thinking blocks are excluded, text blocks assembled ----------
// (This is exactly what callClaude consumes from the assembled message.)
type Block = { type: string; text?: string; thinking?: string }
const mixed = [
  { type: 'thinking', thinking: 'Reasoning about {not json} here.' },
  { type: 'text', text: '{"nodes":[{"name":"A"}],' },
  { type: 'thinking', thinking: 'more reasoning' },
  { type: 'text', text: '"has_more":false}' },
] as unknown as Anthropic.ContentBlock[]
const extracted = messageText(mixed)
ok(!extracted.includes('Reasoning') && !extracted.includes('more reasoning'), 'messageText excludes thinking blocks')
ok(extracted === '{"nodes":[{"name":"A"}],\n"has_more":false}', 'messageText joins text blocks with newline')
const parsed = parseModelObject(extracted, 'check-streaming')
ok((parsed.nodes as unknown[]).length === 1 && parsed.has_more === false, 'extracted text parses to the expected JSON')
ok(messageText([{ type: 'thinking', thinking: 'x' }] as unknown as Anthropic.ContentBlock[]) === '', 'thinking-only message extracts to empty (triggers the no-text error path)')

// --- 2. Streaming assembly: the SDK reconstructs a recorded thinking+text stream ---
// finalMessage() must assemble the same blocks a non-streaming call returns.
function recordedStream(events: unknown[]): ReadableStream {
  // fromReadableStream reads JSONL (one stream-event object per line).
  const bytes = new TextEncoder().encode(events.map((e) => JSON.stringify(e)).join('\n'))
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}
const events = [
  { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me reason about the {fake json} here.' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig123' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '{"nodes":[{"name":"Andy' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ' Smalley"}],"has_more":false}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 42 } },
  { type: 'message_stop' },
]

async function main(): Promise<void> {
  const message = await MessageStream.fromReadableStream(recordedStream(events)).finalMessage()
  ok(message.content.length === 2, 'stream assembled 2 blocks (thinking + text)')
  ok(message.content[0]?.type === 'thinking', 'assembled block 0 is thinking')
  ok(message.content[1]?.type === 'text', 'assembled block 1 is text')
  ok(message.stop_reason === 'end_turn', 'stop_reason assembled from message_delta')
  ok((message.usage?.output_tokens ?? 0) === 42, 'usage assembled from message_delta')
  const raw = messageText(message.content as Anthropic.ContentBlock[])
  ok(!raw.includes('reason about'), 'thinking text does NOT leak into the extracted answer')
  ok(raw === '{"nodes":[{"name":"Andy Smalley"}],"has_more":false}', 'text deltas assembled into the exact JSON string')
  const p = parseModelObject(raw, 'check-streaming stream')
  ok((p.nodes as Array<{ name: string }>)[0]?.name === 'Andy Smalley' && p.has_more === false, 'assembled stream parses to the expected JSON')

  console.log('\n' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
}

void main()
