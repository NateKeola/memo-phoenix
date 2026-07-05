import { NextResponse, type NextRequest } from 'next/server'
import { authorizeApiUser } from '@/lib/auth/guard'
import { logObs, type ObsSubsystem } from '@/lib/observability'

export const runtime = 'nodejs'

// Client -> server observability bridge. The interview widgets run entirely in the
// browser (the ElevenLabs SDK is client-side), so their lifecycle signals
// (connect, disconnect + reason, error, mic-permission-failure, pause, resume) never
// reach the server unless the client posts them. This endpoint unifies those signals
// into the durable observability layer, so an interview failure on another device or
// user is finally visible (previously only the on-screen panel showed it).
//
// STRICT ALLOWLIST: only a fixed set of subsystems/events and a small shaped meta are
// accepted, and the event is stamped to the authenticated user. It CANNOT carry user
// content: only whitelisted metadata keys survive.

const ALLOWED_SUBSYSTEMS = new Set<ObsSubsystem>(['interview', 'onboarding', 'capture_memo', 'surface'])
const ALLOWED_EVENTS = new Set([
  'connect',
  'disconnect',
  'error',
  'mic_error',
  'mic_ok',
  'pause',
  'resume',
  'start',
  'end',
  'started',
])
// Only these metadata keys are persisted; everything else in the client payload is
// dropped, so no transcript/content can ride along.
const META_KEYS = [
  'mode',
  'reason',
  'closeCode',
  'durationSec',
  'micState',
  'vadHeard',
  'vadMax',
  'captured',
  'sdkStatus',
  'stage',
]

export async function POST(request: NextRequest) {
  const auth = await authorizeApiUser()
  if ('error' in auth) return auth.error
  const { user } = auth

  const body = (await request.json().catch(() => ({}))) as {
    subsystem?: string
    event?: string
    level?: string
    status?: string
    errorType?: string
    errorMessage?: string
    durationMs?: number
    meta?: Record<string, unknown>
  }

  const subsystem = body.subsystem as ObsSubsystem
  if (!ALLOWED_SUBSYSTEMS.has(subsystem) || typeof body.event !== 'string' || !ALLOWED_EVENTS.has(body.event)) {
    return NextResponse.json({ error: 'rejected' }, { status: 400 })
  }

  const meta: Record<string, unknown> = {}
  const src = body.meta ?? {}
  for (const k of META_KEYS) {
    if (src[k] !== undefined && (typeof src[k] === 'string' || typeof src[k] === 'number' || typeof src[k] === 'boolean')) {
      // truncate any string metadata defensively (labels/reasons only, never content)
      meta[k] = typeof src[k] === 'string' ? (src[k] as string).slice(0, 120) : src[k]
    }
  }

  await logObs({
    subsystem,
    event: body.event,
    level: body.level === 'error' || body.level === 'warn' ? body.level : undefined,
    status: typeof body.status === 'string' ? body.status.slice(0, 40) : null,
    userId: user.id,
    durationMs: typeof body.durationMs === 'number' ? body.durationMs : null,
    errorType: typeof body.errorType === 'string' ? body.errorType.slice(0, 120) : null,
    errorMessage: typeof body.errorMessage === 'string' ? body.errorMessage.slice(0, 500) : null,
    meta,
  })
  return NextResponse.json({ ok: true })
}
