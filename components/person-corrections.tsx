'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { mergePeople, renamePerson } from '@/app/people/actions'

type PersonOption = { id: string; name: string | null }

// The rename + merge correction forms for one person. A correction is appended to
// the corrections table; it takes effect on the next miner run, which the UI says
// plainly. This never edits canonical directly.
export function PersonCorrections({
  person,
  candidates,
  allPeople,
}: {
  person: { id: string; name: string | null }
  candidates: PersonOption[]
  allPeople: PersonOption[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const [newName, setNewName] = useState(person.name ?? '')
  const [mergeFromId, setMergeFromId] = useState('')
  const [survivor, setSurvivor] = useState<'this' | 'other'>('this')

  const others = allPeople.filter((p) => p.id !== person.id)

  async function doRename() {
    if (busy) return
    setErr('')
    setMsg('')
    setBusy(true)
    try {
      const res = await renamePerson({ personId: person.id, fromLabel: person.name ?? '', toLabel: newName })
      if (!res.ok) throw new Error(res.error || 'could not save')
      setMsg('Rename saved. It takes effect on the next miner run.')
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function doMerge() {
    if (busy) return
    setErr('')
    setMsg('')
    const other = others.find((p) => p.id === mergeFromId)
    if (!other) {
      setErr('pick a person to merge with')
      return
    }
    // survivor 'this' keeps the current person; 'other' keeps the selected one.
    const keep = survivor === 'this' ? person : other
    const drop = survivor === 'this' ? other : person
    setBusy(true)
    try {
      const res = await mergePeople({
        fromId: drop.id,
        fromLabel: drop.name ?? '',
        intoId: keep.id,
        intoLabel: keep.name ?? '',
      })
      if (!res.ok) throw new Error(res.error || 'could not save')
      setMsg(`Merge saved: "${drop.name}" into "${keep.name}". It takes effect on the next miner run.`)
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={{ marginTop: 24, borderTop: '1px solid #ddd', paddingTop: 16 }}>
      <h2 style={{ fontSize: 18 }}>Fix identity</h2>
      <p style={{ color: '#666', fontSize: 13, marginTop: 0 }}>
        A correction is recorded now and applied on the next miner run. It does not change the graph
        immediately.
      </p>

      <div style={{ display: 'grid', gap: 8, maxWidth: 460, marginBottom: 20 }}>
        <strong style={{ fontSize: 14 }}>Rename</strong>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Corrected name"
            style={{ flex: 1, padding: 6 }}
          />
          <button type="button" onClick={doRename} disabled={busy || !newName.trim()}>
            Save rename
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 8, maxWidth: 460 }}>
        <strong style={{ fontSize: 14 }}>Merge with another person</strong>
        {candidates.length > 0 ? (
          <p style={{ fontSize: 13, color: '#666', margin: 0 }}>
            Likely the same person: {candidates.map((c) => c.name).join(', ')}
          </p>
        ) : null}
        <select value={mergeFromId} onChange={(e) => setMergeFromId(e.target.value)} style={{ padding: 6 }}>
          <option value="">Select a person...</option>
          {candidates.length > 0 ? (
            <optgroup label="Likely duplicates">
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          <optgroup label="All people">
            {others.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
        </select>
        <label style={{ fontSize: 13 }}>
          Keep the name:{' '}
          <select value={survivor} onChange={(e) => setSurvivor(e.target.value as 'this' | 'other')}>
            <option value="this">{person.name} (this one)</option>
            <option value="other">the selected person</option>
          </select>
        </label>
        <button type="button" onClick={doMerge} disabled={busy || !mergeFromId}>
          Save merge
        </button>
      </div>

      {msg ? <p style={{ color: 'green', marginTop: 12 }}>{msg}</p> : null}
      {err ? <p style={{ color: 'crimson', marginTop: 12 }}>{err}</p> : null}
    </section>
  )
}
