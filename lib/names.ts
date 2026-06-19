// App-side name helpers (display only; identity is computed miner-side in
// packages/miner-core/src/identity.ts with the same token split). A person's
// first/last is read from data when the miner has persisted it, and falls back to
// splitting the label so the contact sheet shows first/last even before the next
// mine.

export function splitName(name: string | null | undefined): { first: string; last: string } {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { first: '', last: '' }
  return { first: parts[0], last: parts.slice(1).join(' ') }
}

export function personDisplay(first: string | null | undefined, last: string | null | undefined): string {
  return [first, last].filter((s) => s && s.trim()).join(' ').trim()
}

// First/last for a person, preferring the miner-persisted data, else splitting the
// current label.
export function firstLast(label: string | null, data: Record<string, unknown> | null | undefined): { first: string; last: string } {
  const d = data ?? {}
  const f = typeof d.first_name === 'string' ? d.first_name.trim() : ''
  const l = typeof d.last_name === 'string' ? d.last_name.trim() : ''
  if (f || l) return { first: f, last: l }
  return splitName(label)
}
