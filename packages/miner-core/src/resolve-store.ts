import { admin } from './supabase'
import { Resolver, type ResolveCandidate } from './resolution'

// DB-backed wiring for the stable-identity resolver. Reads the current canonical
// rows + the persisted entity_aliases for a table to build a Resolver, and persists
// the new aliases a resolution run discovered (a drifted label remembered against
// its stable id).
//
// Gated by MINER_STABLE_IDENTITY. OFF (default) keeps the exact prior behavior
// (id = uuidv5 of the label). The operator turns it ON deliberately as the cutover
// to stable identity, ideally alongside seeding entity_aliases from the existing
// graph (scripts/migrate-identity.mjs). Self-seeding: with an empty alias table an
// existing entity still resolves by its current label (exact match), so turning the
// flag on is non-destructive (it adopts existing ids, it does not re-key).
export const STABLE_IDENTITY = process.env.MINER_STABLE_IDENTITY === '1'

type RowExtract = {
  // the identity basis for matching (insights match on data.statement, not the
  // pattern_type label); defaults to the row label
  labelOf?: (data: Record<string, unknown>, label: string | null) => string | null
  // an optional disambiguator (commitments use the linked person id)
  contextOf?: (data: Record<string, unknown>) => string | null
}

function asStrArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : []
}

export async function buildResolver(userId: string, table: string, ex: RowExtract = {}): Promise<Resolver> {
  const { data, error } = await admin()
    .from(table)
    .select('id, label, data')
    .eq('user_id', userId)
    .is('valid_to', null)
  if (error) throw new Error(`[miner] resolver read ${table}: ${error.message}`)
  const candidates: ResolveCandidate[] = (data ?? []).map((r) => {
    const row = r as { id: string; label: string | null; data: Record<string, unknown> | null }
    const d = row.data ?? {}
    return {
      id: String(row.id),
      label: ex.labelOf ? ex.labelOf(d, row.label) : row.label,
      aliases: asStrArr(d.aliases),
      contextKey: ex.contextOf ? ex.contextOf(d) : undefined,
    }
  })
  const aliasMap = await readAliasMap(userId, table)
  return new Resolver({ candidates, aliasMap })
}

async function readAliasMap(userId: string, table: string): Promise<Map<string, string>> {
  const m = new Map<string, string>()
  try {
    const { data, error } = await admin()
      .from('entity_aliases')
      .select('alias_norm, stable_id')
      .eq('user_id', userId)
      .eq('entity_table', table)
    if (error) return m // table absent / not migrated: degrade to current-canonical-only
    for (const r of data ?? []) {
      const row = r as { alias_norm: string; stable_id: string }
      m.set(String(row.alias_norm), String(row.stable_id))
    }
  } catch {
    // ignore; an empty map still resolves existing entities by their current label
  }
  return m
}

export async function persistAliases(
  userId: string,
  table: string,
  added: Array<{ alias_norm: string; stable_id: string }>
): Promise<void> {
  if (!added.length) return
  const rows = added.map((a) => ({
    user_id: userId,
    entity_table: table,
    alias_norm: a.alias_norm,
    stable_id: a.stable_id,
    source: 'miner',
  }))
  const { error } = await admin()
    .from('entity_aliases')
    .upsert(rows, { onConflict: 'user_id,entity_table,alias_norm' })
  if (error) throw new Error(`[miner] persist aliases ${table}: ${error.message}`)
}
