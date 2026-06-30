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
    <section style={{ marginTop: 28 }}>
      <hr className="mp-rule" />
      <p className="mp-eyebrow">Fix identity</p>
      <p className="mp-meta" style={{ marginTop: 8 }}>
        A correction is recorded now and applied on the next miner run. It does not change the graph
        immediately.
      </p>

      <div style={{ display: 'grid', gap: 10, marginTop: 16, marginBottom: 22 }}>
        <span className="mp-label">Rename</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Corrected name"
            className="mp-input"
            style={{ flex: 1 }}
          />
          <button type="button" className="mp-btn mp-btn--ghost" onClick={doRename} disabled={busy || !newName.trim()}>
            Save rename
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <span className="mp-label">Merge with another person</span>
        {candidates.length > 0 ? (
          <p className="mp-meta" style={{ margin: 0 }}>
            Likely the same person: {candidates.map((c) => c.name).join(', ')}
          </p>
        ) : null}
        <select value={mergeFromId} onChange={(e) => setMergeFromId(e.target.value)} className="mp-input">
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
        <label className="mp-meta" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Keep the name:{' '}
          <select value={survivor} onChange={(e) => setSurvivor(e.target.value as 'this' | 'other')} className="mp-input" style={{ width: 'auto', flex: 1 }}>
            <option value="this">{person.name} (this one)</option>
            <option value="other">the selected person</option>
          </select>
        </label>
        <button type="button" className="mp-btn mp-btn--ghost" style={{ justifySelf: 'start' }} onClick={doMerge} disabled={busy || !mergeFromId}>
          Save merge
        </button>
      </div>

      {msg ? <p className="mp-ok" style={{ marginTop: 12 }}>{msg}</p> : null}
      {err ? <p className="mp-bad" style={{ marginTop: 12 }}>{err}</p> : null}
    </section>
  )
}
