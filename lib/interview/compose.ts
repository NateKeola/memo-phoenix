import 'server-only'
import { MEMO_COMPANION_BIBLE } from './bible.generated'
import { MEMO_ONBOARDING_BIBLE } from './onboarding-bible.generated'

export type InterviewMode = 'open' | 'daily' | 'onboarding'

// Fills the bible template. Open mode passes an empty brief (the bible reads an
// empty brief as open mode); daily mode passes the composed brief text.
export function composeSystemPrompt(opts: { userName: string; brief: string; now: Date; timeZone?: string }): string {
  return MEMO_COMPANION_BIBLE.replaceAll('{{user_name}}', opts.userName)
    .replaceAll('{{DAILY_BRIEF}}', opts.brief)
    .replaceAll('{{CURRENT_DATE_TIME}}', formatNow(opts.now, opts.timeZone))
}

// Fills the onboarding (first-run) bible. There is no brief: the graph is empty,
// so the conversation is a warm, broad first life overview. Same prompt discipline
// as above; just a different source bible (its own isolated .md).
export function composeOnboardingSystemPrompt(opts: { userName: string; now: Date; timeZone?: string }): string {
  return MEMO_ONBOARDING_BIBLE.replaceAll('{{user_name}}', opts.userName).replaceAll(
    '{{CURRENT_DATE_TIME}}',
    formatNow(opts.now, opts.timeZone)
  )
}

// Format the current moment in the USER'S local timezone (the browser sends its IANA
// zone at session start), so the agent knows what "now" is where the user is, not the
// server's UTC. Includes the short zone name (e.g. PDT). Falls back to the server zone
// if the passed timeZone is missing/invalid.
export function formatNow(d: Date, timeZone?: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }
  try {
    return d.toLocaleString('en-US', timeZone ? { ...opts, timeZone } : opts)
  } catch {
    // an invalid IANA string throws RangeError; fall back to no explicit zone.
    return d.toLocaleString('en-US', opts)
  }
}

// A warm opener. The graph-aware weaving happens inside the conversation (the
// brief is in the system prompt); the first message just opens the door.
export function firstMessage(mode: InterviewMode): string {
  if (mode === 'onboarding') {
    return "Hey, I'm Memo. I'm really glad to meet you. Before anything else, I'd just love to get to know you a little. Tell me about yourself?"
  }
  return mode === 'daily' ? "Hey, good to talk. How've you been?" : "Hey, what's on your mind?"
}
