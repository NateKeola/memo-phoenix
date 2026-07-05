// The browser's IANA time zone (e.g. "America/Los_Angeles"), used to inject the
// user's real local date/time into an interview's context at session start. The
// server cannot know the client's zone (it runs in UTC), so the client sends this.
// Falls back to undefined so the server uses its own default when unavailable.
export function localTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}
