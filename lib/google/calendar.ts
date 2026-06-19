import 'server-only'

// Create an event on the user's primary calendar (scope calendar.events). Only
// reached from a confirmed, code-gated create action.
export async function createCalendarEvent(
  accessToken: string,
  ev: { title: string; startISO: string; endISO: string; attendee?: string; description?: string }
): Promise<{ id: string; htmlLink?: string }> {
  const body: Record<string, unknown> = {
    summary: ev.title,
    description: ev.description,
    start: { dateTime: ev.startISO },
    end: { dateTime: ev.endISO },
  }
  if (ev.attendee) body.attendees = [{ email: ev.attendee }]
  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`[calendar] insert ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return (await res.json()) as { id: string; htmlLink?: string }
}
