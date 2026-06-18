import 'server-only'
import { MEMO_COMPANION_BIBLE } from './bible.generated'

// Fills the bible template. Open mode passes an empty brief (the bible reads an
// empty brief as open mode); daily mode passes the composed brief text.
export function composeSystemPrompt(opts: { userName: string; brief: string; now: Date }): string {
  return MEMO_COMPANION_BIBLE.replaceAll('{{user_name}}', opts.userName)
    .replaceAll('{{DAILY_BRIEF}}', opts.brief)
    .replaceAll('{{CURRENT_DATE_TIME}}', formatNow(opts.now))
}

function formatNow(d: Date): string {
  return d.toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// A warm opener. The graph-aware weaving happens inside the conversation (the
// brief is in the system prompt); the first message just opens the door.
export function firstMessage(mode: 'open' | 'daily'): string {
  return mode === 'daily' ? "Hey, good to talk. How've you been?" : "Hey, what's on your mind?"
}
