// Offline checks for the shared microphone helper (lib/media/mic). Pure: no DB, no
// model, no browser, so it runs anywhere. It locks the diagnostic CONTRACT the voice
// surfaces now depend on: that a getUserMedia failure names its cause (the memo
// surface used to collapse everything to one string, which is why "the mic does not
// work" was never diagnosable), and that an in-app-browser / insecure context is
// detected before getUserMedia is even called.
//
// Run: npx tsx scripts/check-mic.ts
import { describeMicError, micUnavailableReason } from '../lib/media/mic'
import { startMeter } from '../lib/media/mic-meter'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name} ${detail}`)
  }
}
const err = (name: string) => Object.assign(new Error(name), { name })

console.log('== describeMicError maps each DOMException to a clear cause ==')
check('NotAllowedError -> blocked/allow message', /blocked|allow the mic/i.test(describeMicError(err('NotAllowedError'))))
check('SecurityError -> blocked/allow message', /blocked|allow the mic/i.test(describeMicError(err('SecurityError'))))
check('NotFoundError -> no microphone', /no microphone/i.test(describeMicError(err('NotFoundError'))))
check('NotReadableError -> in use by another app', /in use|another app/i.test(describeMicError(err('NotReadableError'))))
check('AbortError -> could not start', /could not start/i.test(describeMicError(err('AbortError'))))
check('unknown -> echoes the message, not a generic swallow', describeMicError(err('WeirdError')).includes('WeirdError'))
check('a plain string is handled', typeof describeMicError('boom') === 'string')

console.log('\n== micUnavailableReason preflight ==')
// navigator is a read-only getter in Node, so override via defineProperty.
const setGlobals = (win: unknown, nav: unknown) => {
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true })
}

// No window (a server-ish context): must report unavailable, never throw.
setGlobals(undefined, undefined)
check('no window -> a reason (does not throw)', typeof micUnavailableReason() === 'string')

// Secure context but mediaDevices missing (the in-app-browser / embedded WebView case).
setGlobals({ isSecureContext: true }, {})
check(
  'secure context without mediaDevices -> in-app-browser guidance',
  /Safari or Chrome|inside another app/i.test(micUnavailableReason() ?? '')
)

// Insecure context.
setGlobals({ isSecureContext: false }, { mediaDevices: { getUserMedia() {} } })
check('insecure context -> https message', /https|not served securely/i.test(micUnavailableReason() ?? ''))

// Capable environment -> null (proceed to acquireMic).
setGlobals({ isSecureContext: true }, { mediaDevices: { getUserMedia() {} } })
check('capable environment -> null (proceed)', micUnavailableReason() === null)

console.log('\n== mic-meter safe fallback (no AudioContext -> never throws) ==')
// In a non-browser context AudioContextCtor() is null, so startMeter must return a
// no-op meter (level 0, state 'unavailable') instead of throwing into the capture flow.
{
  // ensure window has no AudioContext for this check
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true, writable: true })
  const m = startMeter({ getAudioTracks: () => [] } as unknown as MediaStream)
  check('startMeter without AudioContext returns level 0', m.level() === 0)
  check('startMeter without AudioContext reports contextState unavailable', m.contextState() === 'unavailable')
  check('startMeter fallback stop()/resume() do not throw', (() => { try { m.stop(); void m.resume(); return true } catch { return false } })())
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
