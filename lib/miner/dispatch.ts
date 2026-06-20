import 'server-only'

// Off-machine miner: the GitHub Action fallback. When a recompute would exceed the
// Vercel route ceiling (or to survive a closed tab), the app fires the Action via
// repository_dispatch and the long work runs there, off Vercel entirely.
//
// Needs two env values set in the Vercel project (kept server-side):
//   GITHUB_DISPATCH_TOKEN  a fine-grained PAT for THIS repo with "contents: write"
//                          (repository_dispatch permission)
//   GITHUB_REPO            "owner/repo"
// Unset => not configured => the route runs the mine inline on Vercel instead.

export function isGithubDispatchConfigured(): boolean {
  return Boolean(process.env.GITHUB_DISPATCH_TOKEN && process.env.GITHUB_REPO)
}

export async function triggerMinerWorkflow(userId: string, trigger: string): Promise<void> {
  const token = process.env.GITHUB_DISPATCH_TOKEN
  const repo = process.env.GITHUB_REPO
  if (!token || !repo) throw new Error('GitHub dispatch not configured (GITHUB_DISPATCH_TOKEN / GITHUB_REPO)')

  const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({ event_type: 'miner-run', client_payload: { user_id: userId, trigger } }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`repository_dispatch failed: ${res.status} ${text.slice(0, 200)}`)
  }
}
