// Bundles the interview bible .md files (authored by the user, source of truth)
// into committed .generated.ts the app imports. Runtime filesystem reads fail in
// Vercel serverless, so each bible must be a compiled constant. Edit the .md, then
// run: npm run bible:generate
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

// Each entry: a source .md (the authored source of truth) -> a generated .ts const.
const BIBLES = [
  {
    src: 'packages/miner-core/prompts/memo-companion-bible.md',
    out: 'lib/interview/bible.generated.ts',
    name: 'MEMO_COMPANION_BIBLE',
  },
  {
    src: 'packages/miner-core/prompts/onboarding-bible.md',
    out: 'lib/interview/onboarding-bible.generated.ts',
    name: 'MEMO_ONBOARDING_BIBLE',
  },
]

for (const b of BIBLES) {
  const srcPath = resolve(root, b.src)
  const outPath = resolve(root, b.out)
  const text = readFileSync(srcPath, 'utf8').replace(/\r\n/g, '\n')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(
    outPath,
    '// GENERATED FILE - do not edit by hand.\n' +
      `// Source: ${b.src}\n` +
      '// Regenerate with: npm run bible:generate\n\n' +
      `export const ${b.name} = ${JSON.stringify(text)}\n`
  )
  console.log(`generated ${outPath} (${text.length} chars)`)
}
