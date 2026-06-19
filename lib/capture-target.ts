// The capture-with-target mechanism (one reusable shape used by every "add
// context" surface). A capture can be ABOUT a person, a commitment, or a chat
// topic, so the miner attaches the extracted context to the intended thing rather
// than guessing.
//
// Shape (documented in the decision log):
//   captures.target_kind: 'person' | 'commitment' | 'topic' | null
//   captures.target_id:   the canonical id of the target (a person or commitment
//                         id); null for a free 'topic' (the topic text lives in
//                         the seeded interview / the capture body itself).
//
// On the interview surfaces the same target also seeds the system prompt (the
// briefing-injection mechanism), aiming the conversation at the target.
export type CaptureTargetKind = 'person' | 'commitment' | 'topic'

export type CaptureTarget = { kind: CaptureTargetKind; id?: string | null }

export function isCaptureTargetKind(v: unknown): v is CaptureTargetKind {
  return v === 'person' || v === 'commitment' || v === 'topic'
}

// Parse a target from loose input (query params, request body), returning null
// when absent or malformed so callers can treat an untargeted capture normally.
export function parseTarget(kind: unknown, id: unknown): CaptureTarget | null {
  if (!isCaptureTargetKind(kind)) return null
  const targetId = typeof id === 'string' && id.trim() ? id.trim() : null
  // person/commitment need an id; topic does not
  if ((kind === 'person' || kind === 'commitment') && !targetId) return null
  return { kind, id: targetId }
}
