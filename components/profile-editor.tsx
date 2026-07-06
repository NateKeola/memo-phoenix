'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { updateDisplayName, uploadAvatar, removeAvatar } from '@/app/settings/actions'

// Client-side pre-checks (the server action re-validates authoritatively, and the
// bucket enforces the same limits). Kept in sync with lib/profile.ts.
const ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const MAX_BYTES = 5 * 1024 * 1024

export function ProfileEditor({
  displayName,
  avatarUrl,
  initial,
  email,
}: {
  displayName: string
  avatarUrl: string | null
  initial: string
  email: string
}) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(displayName)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file after an error
    if (!file) return
    setErr('')
    setOk('')
    if (!ACCEPT.includes(file.type)) return setErr('Image must be PNG, JPG, WEBP, or GIF.')
    if (file.size > MAX_BYTES) return setErr('Image must be under 5 MB.')
    setBusy(true)
    try {
      const fd = new FormData()
      fd.set('file', file)
      const res = await uploadAvatar(fd)
      if (!res.ok) throw new Error(res.error || 'could not upload the photo')
      setOk('Photo updated.')
      router.refresh()
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2))
    } finally {
      setBusy(false)
    }
  }

  async function onRemovePhoto() {
    setBusy(true)
    setErr('')
    setOk('')
    try {
      const res = await removeAvatar()
      if (!res.ok) throw new Error(res.error || 'could not remove the photo')
      router.refresh()
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2))
    } finally {
      setBusy(false)
    }
  }

  async function onSaveName() {
    const trimmed = name.trim()
    if (!trimmed || trimmed === displayName) return
    setBusy(true)
    setErr('')
    setOk('')
    try {
      const res = await updateDisplayName({ displayName: trimmed })
      if (!res.ok) throw new Error(res.error || 'could not save your name')
      setOk('Name saved.')
      router.refresh()
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2))
    } finally {
      setBusy(false)
    }
  }

  const linkBtn: React.CSSProperties = {
    background: 'none',
    border: 0,
    cursor: busy ? 'default' : 'pointer',
    fontSize: 14,
    color: 'var(--txt-faint)',
    padding: 0,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        aria-label="Change profile photo"
        style={{ background: 'none', border: 0, padding: 0, cursor: busy ? 'default' : 'pointer' }}
      >
        <span className="mp-avatar mp-avatar--xl" aria-hidden>
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="" />
          ) : (
            initial
          )}
        </span>
      </button>
      <input ref={fileRef} type="file" accept={ACCEPT.join(',')} onChange={onPick} hidden />

      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <button
          type="button"
          className="mp-btn mp-btn--ghost"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          style={{ padding: '6px 14px', fontSize: 14 }}
        >
          {avatarUrl ? 'Change photo' : 'Add photo'}
        </button>
        {avatarUrl ? (
          <button type="button" onClick={() => void onRemovePhoto()} disabled={busy} style={linkBtn}>
            Remove
          </button>
        ) : null}
      </div>

      <div style={{ display: 'flex', gap: 8, width: '100%', maxWidth: 340, marginTop: 6 }}>
        <input
          className="mp-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          maxLength={80}
          aria-label="Display name"
          style={{ textAlign: 'center', flex: 1 }}
        />
        <button
          type="button"
          className="mp-btn mp-btn--primary"
          onClick={() => void onSaveName()}
          disabled={busy || !name.trim() || name.trim() === displayName}
          style={{ padding: '0 16px' }}
        >
          Save
        </button>
      </div>
      <p className="mp-meta" style={{ margin: 0 }}>{email}</p>

      {err ? <p className="mp-bad" style={{ margin: '2px 0 0' }}>{err}</p> : null}
      {ok && !err ? <p className="mp-ok" style={{ margin: '2px 0 0' }}>{ok}</p> : null}
    </div>
  )
}
