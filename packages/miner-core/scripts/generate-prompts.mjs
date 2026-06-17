// Bundles the prompt .md sources into a committed .generated.ts file, so the
// runtime never reads the filesystem (filesystem reads fail in Vercel
// serverless). Edit the .md sources, then run: npm run prompts:generate
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = resolve(here, '..')
const promptsDir = resolve(pkg, 'prompts')
const outFile = resolve(pkg, 'src', 'prompts.generated.ts')

const MAP = {
  EXTRACTION_PROMPT: 'extraction-v1.md',
  STAGE_A_PEOPLE_PROMPT: 'stage-a-people-v1.md',
  STAGE_A_PLACES_ORGS_PROMPT: 'stage-a-places-orgs-v1.md',
  STAGE_B_PROJECTS_PROMPT: 'stage-b-projects-v1.md',
  STAGE_B_EVENTS_PROMPT: 'stage-b-events-v1.md',
  STAGE_B_FACTS_PROMPT: 'stage-b-facts-v1.md',
  STAGE_C_RELATIONSHIPS_PROMPT: 'stage-c-relationships-v1.md',
  STAGE_C_COMMITMENTS_PROMPT: 'stage-c-commitments-v1.md',
  STAGE_C_INSIGHTS_PROMPT: 'stage-c-insights-v1.md',
}

let out =
  '// GENERATED FILE - do not edit by hand.\n' +
  '// Edit the prompt .md sources, then run: npm run prompts:generate\n\n'
for (const [name, file] of Object.entries(MAP)) {
  const text = readFileSync(resolve(promptsDir, file), 'utf8').replace(/\r\n/g, '\n')
  out += `export const ${name} = ${JSON.stringify(text)}\n\n`
}
writeFileSync(outFile, out)
console.log(`generated ${outFile} from ${Object.keys(MAP).length} prompts`)
