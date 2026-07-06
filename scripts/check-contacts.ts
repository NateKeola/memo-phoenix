// Pure checks for the contact create/import parsing (no DB, no model), so they run
// anywhere and in CI. Verifies vCard + CSV parsing (name detection, first/last
// columns, quoted commas, org, dedup) and the capture-body composition.
//
// Run: npx tsx scripts/check-contacts.ts
import { parseContacts, manualContactBody, importCaptureBody } from '../lib/contacts'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name} ${detail}`) }
}

console.log('== vCard parsing ==')
{
  const vcf = [
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:Camille Lea', 'ORG:Studio North', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:3.0', 'N:Tanker;Cole;;;', 'END:VCARD', // N fallback, no FN
    'BEGIN:VCARD', 'FN;CHARSET=UTF-8:Jane Doe', 'END:VCARD', // property params
  ].join('\r\n')
  const c = parseContacts(vcf)
  check('parses 3 vCards', c.length === 3, JSON.stringify(c))
  check('FN name', c[0]?.name === 'Camille Lea')
  check('ORG captured', c[0]?.org === 'Studio North')
  check('N fallback builds Given + Family', c[1]?.name === 'Cole Tanker', c[1]?.name)
  check('property params ignored (FN;CHARSET)', c[2]?.name === 'Jane Doe', c[2]?.name)
}

console.log('\n== CSV parsing ==')
{
  const csv = 'Name,Organization,Phone\nCamille Lea,"Studio North, Inc.",555\nCole Tanker,,556\n'
  const c = parseContacts(csv)
  check('parses 2 CSV rows', c.length === 2, JSON.stringify(c))
  check('name column', c[0]?.name === 'Camille Lea')
  check('quoted field with a comma stays whole', c[0]?.org === 'Studio North, Inc.', c[0]?.org ?? '')
  check('missing org is null', c[1]?.org === null)
}
{
  const csv = 'First Name,Last Name\nCamille,Lea\nCole,Tanker\n'
  const c = parseContacts(csv)
  check('first + last columns combine', c[0]?.name === 'Camille Lea' && c[1]?.name === 'Cole Tanker', JSON.stringify(c))
}
{
  const csv = 'col1,col2\nAlice,Smith\n' // no recognized header -> first column is the name
  const c = parseContacts(csv)
  check('unknown header falls back to first column', c[0]?.name === 'Alice', c[0]?.name)
}

console.log('\n== dedup + empties ==')
{
  const csv = 'Name\nCamille Lea\ncamille  lea\n\nCole Tanker\n'
  const c = parseContacts(csv)
  check('dedups case/space-insensitively and drops empty', c.length === 2, JSON.stringify(c.map((x) => x.name)))
}

console.log('\n== capture body composition ==')
{
  check('manual with relationship + note', manualContactBody({ name: 'Camille Lea', relationship: 'friend', note: 'met at the conference' }) === 'New contact: Camille Lea. Camille Lea is my friend. met at the conference')
  check('manual name only', manualContactBody({ name: 'Cole Tanker' }) === 'New contact: Cole Tanker.')
  check('manual trims + skips blank fields', manualContactBody({ name: '  Jane  ', relationship: '  ', note: '' }) === 'New contact: Jane.')
  check('import with org', importCaptureBody({ name: 'Camille Lea', org: 'Studio North' }) === 'New contact from my address book: Camille Lea. Camille Lea works at Studio North.')
  check('import name only', importCaptureBody({ name: 'Cole Tanker', org: null }) === 'New contact from my address book: Cole Tanker.')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
