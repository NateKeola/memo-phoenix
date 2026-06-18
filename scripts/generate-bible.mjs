// Bundles the interview bible .md (authored by the user, source of truth) into a
// committed .generated.ts the app imports. Runtime filesystem reads fail in
// Vercel serverless, so the bible must be a compiled constant. Edit the .md, then
// run: npm run bible:generate
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
// Source of truth lives where the user authored it (the miner-core prompts dir).
const src = resolve(root, 'packages/miner-core/prompts/memo-companion-bible.md')
const out = resolve(root, 'lib/interview/bible.generated.ts')

const text = readFileSync(src, 'utf8').replace(/\r\n/g, '\n')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(
  out,
  '// GENERATED FILE - do not edit by hand.\n' +
    '// Source: packages/miner-core/prompts/memo-companion-bible.md\n' +
    '// Regenerate with: npm run bible:generate\n\n' +
    `export const MEMO_COMPANION_BIBLE = ${JSON.stringify(text)}\n`
)
console.log(`generated ${out} (${text.length} chars)`)
