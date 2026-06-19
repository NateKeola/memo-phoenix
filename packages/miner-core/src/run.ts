import { admin } from './supabase'
import { extractCapture, type Capture } from './extract'
import { runDerivation } from './derive'
import { logEvent } from './telemetry'
import { addUsage, emptyUsage, type PassResult, type Usage } from './types'

export type MineSummary = {
  captures: number
  extracted: number
  rawInserted: number
  passes: PassResult[]
  extractUsage: Usage
  durationMs: number
}

// Full recompute for one user: extract every not-yet-extracted capture into the
// raw layer, then derive the canonical layer (A -> B -> C) from the full raw set.
// Extraction and each derivation pass are memoized on input hashes, so a second
// run over unchanged input does no LLM work and writes nothing.
export async function mine(userId: string, startedAtMs: number): Promise<MineSummary> {
  const { data, error } = await admin()
    .from('captures')
    .select('id, user_id, mode, modality, body, target_kind, target_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`[miner] read captures: ${error.message}`)
  const captures = (data ?? []) as Capture[]

  let extractUsage = emptyUsage()
  let rawInserted = 0
  let extracted = 0
  for (const cap of captures) {
    const r = await extractCapture(cap)
    extractUsage = addUsage(extractUsage, r.usage)
    rawInserted += r.rawInserted
    if (!r.skipped) extracted++
  }

  const passes = await runDerivation(userId)

  const summary: MineSummary = {
    captures: captures.length,
    extracted,
    rawInserted,
    passes,
    extractUsage,
    durationMs: 0,
  }

  // run-level telemetry; durationMs is stamped by the caller's clock
  const totalUsage = passes.reduce((acc, p) => addUsage(acc, p.usage), extractUsage)
  await logEvent({
    user_id: userId,
    event_type: 'miner_run',
    name: 'mine:complete',
    attrs: {
      stage: 'all',
      captures: captures.length,
      extracted,
      raw_inserted: rawInserted,
      tokens_in: totalUsage.input_tokens,
      tokens_out: totalUsage.output_tokens,
      cache_read: totalUsage.cache_read_input_tokens,
      cache_creation: totalUsage.cache_creation_input_tokens,
    },
  })

  return summary
}
