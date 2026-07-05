# Capture flow

A capture is one append-only row in `captures` (mode: `text` | `memo` | `interview`).
The miner later folds it into the graph. Captures are hard append-only, so any
"already processed" state lives elsewhere (`miner_state`), never as a column here.

## Text

`app/capture/text/actions.ts` (server action) -> `writeCapture(supabase, userId,
{ mode:'text', body, routingHint?, target? })`.

Observability: `capture_text` `ok` (meta `{chars}`) on success, `capture_text`
`error` (with `obsError`) if the write fails.

## Voice memo (Scribe)

1. The browser records audio (`MediaRecorder`) and POSTs the raw bytes to
   `app/api/capture/memo/route.ts` (nodejs runtime) with the audio MIME type.
2. The route transcribes via ElevenLabs Scribe (`lib/stt`, key stays server-side),
   then `writeCapture({ mode:'memo', modality:'voice', body: transcript })`.
3. Returns the transcript. Audio is not retained in V0 (transcript only).

Observability (this path had NO diagnostics panel before; it is the main gap the
layer closes):

| step | subsystem | event | level | meta (shaped only) |
|------|-----------|-------|-------|--------------------|
| empty body | capture_memo | empty_audio | warn | bytes |
| Scribe failed | scribe | transcribe_error | error | bytes, contentType (+ obsError, timing) |
| Scribe ok | scribe | transcribe_ok | ok | bytes, chars, contentType, timing |
| no speech | scribe | no_speech | warn | bytes |
| write failed | capture_memo | error | error | chars (+ obsError) |
| captured | capture_memo | ok | ok | chars, target_kind |

Never logged: the audio, the transcript text, or any content. Only byte/char counts,
MIME type, and timing.

## Capture-with-target

A capture can be ABOUT a person, a commitment, or a chat topic (`captures.target_kind`
+ `target_id`, set at insert only). The miner reads the target and prepends a
one-line context note to the extraction INPUT (never to the stored body). One
mechanism, shared by text, memo, and interview captures. See `lib/capture-target.ts`.
