// Follow-up time-sensitivity, derived deterministically at read time. A follow-up
// is time-sensitive when it has a CONCRETE deadline (a real calendar date), so an
// evergreen nudge like "call your dad" is never time-sensitive and never retired.
// The deadline is the miner's inferred date (data.deadline, with data.due as a
// fallback) OR the user's set deadline (the companion_state overlay), the user
// winning. The user can also override the time-sensitivity flag outright. The main
// follow-up tab excludes items whose deadline has passed (computed here, never
// deleted); those surface in a "past" view.

export type Timing = { timeSensitive: boolean; deadline: string | null; passed: boolean }

// Pull a YYYY-MM-DD out of a value: an ISO date/datetime, an embedded YYYY-MM-DD,
// or a YYYY-MM (resolved to the end of that month). Returns null when there is no
// concrete date (a relative or fuzzy due like "soon" or "tomorrow" is not concrete
// enough to retire an item, so it stays in the main tab).
function pickDate(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  const ymd = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`
  const ym = t.match(/^(\d{4})-(\d{2})$/)
  if (ym) {
    const last = new Date(Date.UTC(Number(ym[1]), Number(ym[2]), 0)).getUTCDate()
    return `${ym[1]}-${ym[2]}-${String(last).padStart(2, '0')}`
  }
  return null
}

// The miner-inferred deadline: data.deadline (the structured field the commitments
// prompt now emits) first, then a concrete date embedded in the free-text data.due.
export function inferredDeadline(data: Record<string, unknown>): string | null {
  return pickDate(data.deadline) ?? pickDate(data.due)
}

// End-of-day (UTC) for a deadline string, so an item due "today" is not treated as
// passed until the day is over. Accepts a YYYY-MM-DD or a full ISO timestamp.
function dayEndMs(deadline: string): number | null {
  const ms = Date.parse(deadline.length <= 10 ? `${deadline}T00:00:00Z` : deadline)
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999)
}

export function resolveTiming(opts: {
  data: Record<string, unknown>
  overrideTimeSensitive: boolean | null // overlay.time_sensitive (null = use inferred)
  overrideDeadline: string | null // overlay.due_date (the user's set deadline, ISO) or null
  now: number
}): Timing {
  const userDeadline = opts.overrideDeadline ? opts.overrideDeadline.slice(0, 10) : null
  const deadline = userDeadline ?? inferredDeadline(opts.data)
  // A concrete deadline => time-sensitive, unless the user overrode the flag.
  const timeSensitive = opts.overrideTimeSensitive !== null ? opts.overrideTimeSensitive : Boolean(deadline)
  let passed = false
  if (timeSensitive && deadline) {
    const end = dayEndMs(deadline)
    passed = end !== null && end < opts.now
  }
  return { timeSensitive, deadline, passed }
}
