import 'server-only'
import Anthropic from '@anthropic-ai/sdk'

// The companion drafts message/invite CONTENT for the user to review. It ONLY
// drafts: it does not send or schedule, and it never receives a recipient's
// credentials. The send/create is a separate, code-gated action the user confirms.
const MODEL = process.env.CHAT_MODEL || 'claude-opus-4-8'
const EFFORT = process.env.CHAT_EFFORT || 'low'
const MAX_TOKENS = Number(process.env.COMPANION_DRAFT_MAX_TOKENS) || 1024

let client: Anthropic | null = null
function getClient(): Anthropic {
  if (client) return client
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('[companion] ANTHROPIC_API_KEY is not set')
  client = new Anthropic({ apiKey })
  return client
}

const DRAFT_SYSTEM = `You draft a short, warm, ready-to-send message or calendar invite for the user to review. You ONLY draft the content. You never send anything, you never schedule anything, and you do not have the recipient's address; the user fills that in and confirms before anything happens.

Rules:
- Write in the user's own voice, first person, to the named person.
- Keep it short and natural, the kind of message a person actually sends. No corporate filler.
- Use the work_or_personal framing: a work follow-up is courteous and to the point; a personal one is casual and warm.
- Ground it in the specific follow-up. Do not invent facts, dates, or commitments that were not given.
- Output ONLY a JSON object, no prose, no code fences.
- Do not use em dashes.`

async function callJson(user: string): Promise<Record<string, unknown>> {
  const params = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: EFFORT },
    system: [{ type: 'text', text: DRAFT_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
  }
  const msg = await getClient().messages.create(params as unknown as Anthropic.MessageCreateParamsNonStreaming)
  const text = (msg.content as Anthropic.ContentBlock[])
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
  const stripped = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '').trim()
  const parsed = JSON.parse(stripped) as Record<string, unknown>
  return parsed
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback
}

export type EmailDraft = { subject: string; body: string }
export type CalendarDraft = { title: string; durationMinutes: number; description: string }

export type DraftContext = {
  commitment: string
  personName: string | null
  workOrPersonal: string | null
  userName: string
  due?: string | null
}

export async function draftEmail(ctx: DraftContext): Promise<EmailDraft> {
  const user = JSON.stringify({
    task: 'Draft a short email to follow up on this.',
    from_name: ctx.userName,
    to_person: ctx.personName ?? 'the person',
    work_or_personal: ctx.workOrPersonal ?? 'personal',
    follow_up: ctx.commitment,
    due: ctx.due ?? null,
    output_shape: { subject: 'string', body: 'string' },
  })
  const out = await callJson(user)
  return { subject: str(out.subject, 'Quick follow-up'), body: str(out.body) }
}

export async function draftCalendar(ctx: DraftContext): Promise<CalendarDraft> {
  const user = JSON.stringify({
    task: 'Draft a calendar invite to make this follow-up happen.',
    from_name: ctx.userName,
    with_person: ctx.personName ?? 'the person',
    work_or_personal: ctx.workOrPersonal ?? 'personal',
    follow_up: ctx.commitment,
    due: ctx.due ?? null,
    output_shape: { title: 'string', durationMinutes: 'number (default 30)', description: 'string' },
  })
  const out = await callJson(user)
  const mins = typeof out.durationMinutes === 'number' && out.durationMinutes > 0 ? Math.round(out.durationMinutes) : 30
  return { title: str(out.title, ctx.commitment), durationMinutes: mins, description: str(out.description) }
}
