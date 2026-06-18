import { loadEnv } from './env'
import { readFileSync } from 'node:fs'

// Seed a real capture for validation:
//   npm run seed -- --file path/to/transcript.txt --mode interview
//   echo "text" | npm run seed -- --mode text
// Modes: memo | text | interview (default interview). Modality defaults to text,
// or voice for mode=memo.
async function main(): Promise<void> {
  loadEnv()
  const { admin } = await import('./supabase')
  const { requireUserId } = await import('./config')

  const args = process.argv.slice(2)
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }

  const file = get('--file')
  const inlineText = get('--text')
  const mode = get('--mode') ?? 'interview'
  const modality = get('--modality') ?? (mode === 'memo' ? 'voice' : 'text')

  let body: string
  if (file) body = readFileSync(file, 'utf8')
  else if (inlineText) body = inlineText
  else body = readFileSync(0, 'utf8') // stdin

  body = body.trim()
  if (!body) throw new Error('[seed] empty body; pass --file, --text, or pipe stdin')

  const userId = requireUserId()
  const { data, error } = await admin()
    .from('captures')
    .insert({ user_id: userId, mode, modality, body })
    .select('id')
    .single()
  if (error) throw new Error(`[seed] insert capture: ${error.message}`)

  console.log(`[seed] inserted capture ${(data as { id: string }).id} (mode=${mode}, ${body.length} chars)`)
}

main().catch((err) => {
  console.error('[seed] failed:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
