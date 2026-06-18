// Swappable speech-to-text interface (locked: the interface is required even
// though there is one implementation now, so the provider can change without
// touching the capture UI).
export interface SttProvider {
  // audio is the raw recorded bytes; contentType is its MIME type (e.g.
  // 'audio/webm'). Returns the transcript text.
  transcribe(audio: Buffer, contentType: string): Promise<{ text: string }>
}
