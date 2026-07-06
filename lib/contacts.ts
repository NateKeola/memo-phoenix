// Contact creation + import helpers (pure, no DB, no library). A created or imported
// contact never writes the graph directly: it becomes a normal text capture whose
// body names the person, and the miner turns it into a canonical person on the next
// mine. These functions parse an uploaded vCard/CSV and compose the capture bodies.

export type Contact = { name: string; org: string | null }

// V0 cap on a single import, so an accidental huge file cannot append hundreds of
// permanent (append-only) captures. Import again for more. Env-tunable.
export const MAX_IMPORT = Number(process.env.MEMO_MAX_IMPORT) || 50

function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

// A minimal CSV line parser: handles double-quoted fields with embedded commas and
// "" escapes. Embedded newlines inside a quoted field are not supported (rare for a
// contact export); the file is split on newlines first.
function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else inQ = false
      } else cur += c
    } else if (c === '"') inQ = true
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

function parseVcards(text: string): Contact[] {
  const out: Contact[] = []
  // one card per BEGIN:VCARD..END:VCARD block
  const cards = text.split(/BEGIN:VCARD/i).slice(1)
  for (const card of cards) {
    const body = card.split(/END:VCARD/i)[0]
    const lines = body.split('\n')
    let fn = ''
    let n = ''
    let org = ''
    for (const raw of lines) {
      // a property may carry params before the colon (FN;CHARSET=UTF-8:Jane Doe)
      const fnM = raw.match(/^FN[^:]*:(.*)$/i)
      if (fnM) { fn = fnM[1].trim(); continue }
      const nM = raw.match(/^N[^:]*:(.*)$/i)
      if (nM && !n) {
        // structured name: Family;Given;Additional;Prefix;Suffix
        const [family = '', given = '', additional = ''] = nM[1].split(';').map((x) => x.trim())
        n = [given, additional, family].filter(Boolean).join(' ')
        continue
      }
      const orgM = raw.match(/^ORG[^:]*:(.*)$/i)
      if (orgM && !org) org = orgM[1].split(';').map((x) => x.trim()).filter(Boolean).join(', ')
    }
    const name = fn || n
    if (name) out.push({ name, org: org || null })
  }
  return out
}

function parseCsv(text: string): Contact[] {
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length < 2) return []
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase())
  const idxOf = (...names: string[]) => header.findIndex((h) => names.includes(h))
  const nameIdx = idxOf('name', 'full name', 'display name', 'contact name')
  const firstIdx = idxOf('first name', 'given name', 'first')
  const lastIdx = idxOf('last name', 'family name', 'surname', 'last')
  const orgIdx = idxOf('organization', 'company', 'org', 'organization name')
  const out: Contact[] = []
  for (const line of lines.slice(1)) {
    const f = parseCsvLine(line)
    let name = ''
    if (nameIdx >= 0) name = f[nameIdx] ?? ''
    else if (firstIdx >= 0 || lastIdx >= 0) name = [f[firstIdx] ?? '', f[lastIdx] ?? ''].join(' ').trim()
    else name = f[0] ?? '' // fall back to the first column
    name = name.trim()
    if (name) out.push({ name, org: (orgIdx >= 0 ? f[orgIdx] : '')?.trim() || null })
  }
  return out
}

// Parse an uploaded vCard (.vcf) or CSV into a deduped contact list. Format is
// detected from the content (BEGIN:VCARD => vCard, else CSV). Names are deduped
// case-insensitively and empties dropped; the caller applies MAX_IMPORT.
export function parseContacts(text: string): Contact[] {
  const t = text.replace(/\r\n?/g, '\n')
  const raw = /BEGIN:VCARD/i.test(t) ? parseVcards(t) : parseCsv(t)
  const seen = new Set<string>()
  const out: Contact[] = []
  for (const c of raw) {
    const key = normName(c.name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({ name: c.name.trim(), org: c.org })
  }
  return out
}

// The capture body for a manually created contact. Phrased so extraction reliably
// creates the person (and their relationship, when given). The miner does the rest.
export function manualContactBody(input: { name: string; relationship?: string | null; note?: string | null }): string {
  const name = input.name.trim()
  const rel = (input.relationship ?? '').trim()
  const note = (input.note ?? '').trim()
  let body = `New contact: ${name}.`
  if (rel) body += ` ${name} is my ${rel}.`
  if (note) body += ` ${note}`
  return body
}

// The capture body for one imported contact.
export function importCaptureBody(c: Contact): string {
  let body = `New contact from my address book: ${c.name.trim()}.`
  if (c.org) body += ` ${c.name.trim()} works at ${c.org}.`
  return body
}
