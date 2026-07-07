import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isOperator } from '@/lib/auth/operator'
import { readRecentObs, rollUpHealth, type ObsRow, type SubsystemHealth } from '@/lib/observability'
import { PageHeader } from '@/components/page-header'
import { ObsRefresh } from '@/components/admin/obs-refresh'

export const dynamic = 'force-dynamic'

// Admin-only observability console. Operator-gated (isOperator), never shown to a
// regular user. It reads the durable observability layer + miner_runs + invites
// ACROSS users via the service-role client, because the operator monitors the whole
// beta; RLS still blocks every non-service client (the operator gate is the
// authorization, the same pattern as the cron sweep and invites). It shows: which
// subsystems are healthy, recent errors with detail, miner run state, and
// invite-acceptance status. It shows NO user content (only status, timings, counts,
// error messages).
export default async function ObservabilityPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  if (!isOperator(user)) redirect('/')

  // Service-role reads, cross-user (operator console only).
  const admin = createAdminClient()
  const [events, { data: runsRaw }, { data: invitesRaw }] = await Promise.all([
    readRecentObs(150),
    admin.from('miner_runs').select('id, user_id, status, trigger, runtime, stage, started_at, ended_at, heartbeat_at, error, summary').order('started_at', { ascending: false }).limit(8),
    admin.from('invites').select('email, status, invited_user_id, accepted_at, created_at').order('created_at', { ascending: false }).limit(20),
  ])
  const health = rollUpHealth(events, Date.now())
  const errors = events.filter((e) => e.level === 'error').slice(0, 25)
  const runs = (runsRaw ?? []) as Array<Record<string, unknown>>
  const invites = (invitesRaw ?? []) as Array<{ email: string; status: string; invited_user_id: string | null; accepted_at: string | null; created_at: string }>

  return (
    <main className="mp-page" style={{ maxWidth: 760 }}>
      <PageHeader back="/admin" backLabel="Admin" />
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <h1 className="mp-h1">Observability</h1>
        <ObsRefresh />
      </div>
      <p className="mp-sub">Subsystem health, recent errors, miner runs, and invite status. Status and error detail only, never content.</p>

      <Section title="Subsystem health">
        {health.length === 0 ? (
          <Empty>No events yet. Exercise a capture or interview to populate this.</Empty>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
            {health.map((h) => (
              <HealthCard key={h.subsystem} h={h} />
            ))}
          </div>
        )}
      </Section>

      <Section title={`Recent errors (${errors.length})`}>
        {errors.length === 0 ? (
          <Empty>No errors recorded. Healthy.</Empty>
        ) : (
          <ul className="mp-list">
            {errors.map((e) => (
              <li key={e.id} className="mp-row" style={{ display: 'block' }}>
                <EventLine e={e} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Miner runs">
        {runs.length === 0 ? (
          <Empty>No runs yet.</Empty>
        ) : (
          <ul className="mp-list">
            {runs.map((r) => (
              <li key={String(r.id)} className="mp-row" style={{ justifyContent: 'space-between' }}>
                <span style={{ minWidth: 0 }}>
                  <span style={{ color: runColor(String(r.status)) }}>{effectiveRunStatus(r)}</span>
                  {runMode(r) ? <span className="mp-tag mp-tag--accent" style={{ marginLeft: 6 }}>{runMode(r)}</span> : null}
                  <span className="mp-meta"> {String(r.trigger ?? '')}/{String(r.runtime ?? '')} {r.stage ? `· ${String(r.stage)}` : ''}</span>
                  {r.error ? <span className="mp-meta" style={{ display: 'block', color: 'var(--record-soft)' }}>{String(r.error).slice(0, 90)}</span> : null}
                </span>
                <span className="mp-meta" style={{ whiteSpace: 'nowrap' }}>{shortId(String(r.user_id))} · {ago(String(r.started_at))}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Invites">
        {invites.length === 0 ? (
          <Empty>No invites.</Empty>
        ) : (
          <ul className="mp-list">
            {invites.map((inv) => (
              <li key={inv.email} className="mp-row" style={{ justifyContent: 'space-between' }}>
                <span>{inv.email}</span>
                <span className={`mp-tag ${inv.status === 'accepted' ? 'mp-tag--ok' : inv.status === 'revoked' ? '' : 'mp-tag--accent'}`}>
                  {inv.status}{inv.status !== 'accepted' && inv.invited_user_id ? ' · signed up, not onboarded' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <p className="mp-meta" style={{ marginTop: 28 }}>
        <Link href="/admin" className="mp-link">Back to invites</Link>
      </p>
    </main>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 26 }}>
      <p className="mp-eyebrow">{title}</p>
      <div style={{ marginTop: 10 }}>{children}</div>
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="mp-meta">{children}</p>
}

function HealthCard({ h }: { h: SubsystemHealth }) {
  return (
    <div className="mp-card" style={{ padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: h.healthy ? 'var(--ok)' : 'var(--record-soft)' }} aria-hidden />
        <span style={{ fontWeight: 500 }}>{h.subsystem}</span>
      </div>
      <div className="mp-meta" style={{ marginTop: 6 }}>
        {h.healthy ? 'healthy' : `${h.errorsLastHour} error${h.errorsLastHour === 1 ? '' : 's'} / hr`}
        {h.lastEventAt ? ` · ${ago(h.lastEventAt)}` : ''}
      </div>
      {!h.healthy && h.lastError?.message ? (
        <div className="mp-meta" style={{ marginTop: 4, color: 'var(--record-soft)' }}>{h.lastError.message.slice(0, 80)}</div>
      ) : null}
    </div>
  )
}

function EventLine({ e }: { e: ObsRow }) {
  return (
    <div>
      <span style={{ color: 'var(--record-soft)' }}>{e.subsystem}/{e.event}</span>
      {e.error_type ? <span className="mp-meta"> [{e.error_type}]</span> : null}
      <span className="mp-meta" style={{ float: 'right' }}>{ago(e.created_at)}{e.user_id ? ` · ${shortId(e.user_id)}` : ''}</span>
      {e.error_message ? <div className="mp-meta" style={{ marginTop: 3 }}>{e.error_message}</div> : null}
    </div>
  )
}

function runColor(s: string): string {
  if (s === 'done') return 'var(--ok)'
  if (s === 'error') return 'var(--record-soft)'
  return 'var(--accent-deep)'
}
// The derivation path this run took (from miner_runs.summary), so the operator can
// confirm routine mines are incremental. Null for pre-Phase-2 runs (no mode field).
// A DONE run shows its counts; a failed/attempted run (mineWithLock stamps the mode
// early, before the passes) shows the mode it was attempting WITHOUT a bogus 0 count.
function runMode(r: Record<string, unknown>): string | null {
  const s = r.summary as { mode?: string; newCaptures?: number; captures?: number } | null | undefined
  if (!s || typeof s.mode !== 'string') return null
  const done = String(r.status) === 'done'
  if (s.mode === 'incremental') return done ? `incremental · ${s.newCaptures ?? 0} new` : 'incremental (attempted)'
  if (s.mode === 'noop') return done ? 'no-op · up to date' : 'no-op'
  return done ? `full · ${s.captures ?? 0} captures` : 'full (attempted)'
}
// Show a stalled run (running but no heartbeat for > 10 min) honestly.
function effectiveRunStatus(r: Record<string, unknown>): string {
  if (r.status !== 'running') return String(r.status)
  const last = (r.heartbeat_at as string | null) ?? (r.started_at as string)
  const silentMs = Date.now() - new Date(last).getTime()
  return silentMs > 10 * 60 * 1000 ? 'stalled' : 'running'
}
function shortId(id: string): string {
  return id.slice(0, 8)
}
function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
