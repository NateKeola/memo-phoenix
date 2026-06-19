import 'server-only'

// Google OAuth 2.0 (authorization code flow with offline access for a refresh
// token), and the Gmail/Calendar token plumbing. Raw fetch, no SDK. Least
// privilege: gmail.send (send only, cannot read mail) and calendar.events.
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ')

function clientId(): string {
  const v = process.env.GOOGLE_CLIENT_ID
  if (!v) throw new Error('[google] GOOGLE_CLIENT_ID is not set')
  return v
}
function clientSecret(): string {
  const v = process.env.GOOGLE_CLIENT_SECRET
  if (!v) throw new Error('[google] GOOGLE_CLIENT_SECRET is not set')
  return v
}

// Whether the server is configured to offer a Google connection at all. The
// surface degrades gracefully (prompts to connect) when this is false.
export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
}

export function buildAuthUrl(redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline', // get a refresh token
    prompt: 'consent', // force a refresh token even on re-consent
    include_granted_scopes: 'true',
    state,
  })
  return `${GOOGLE_AUTH}?${p.toString()}`
}

export type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
  id_token?: string
}

export async function exchangeCode(code: string, redirectUri: string): Promise<TokenResponse> {
  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  if (!res.ok) throw new Error(`[google] token exchange ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as TokenResponse
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`[google] token refresh ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as TokenResponse
}

// Read the email claim from the id_token (a JWT we just received from Google over
// TLS) to label which account is connected. Not used for authorization.
export function emailFromIdToken(idToken?: string): string | null {
  if (!idToken) return null
  try {
    const payload = idToken.split('.')[1]
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown }
    return typeof json.email === 'string' ? json.email : null
  } catch {
    return null
  }
}
