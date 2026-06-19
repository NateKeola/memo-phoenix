import 'server-only'

// Send an email via the Gmail API. Scope is gmail.send (least privilege: send
// only, cannot read the mailbox). The message is built as RFC822 and base64url
// encoded per the API. This is the only place the app sends mail, and it is only
// reached from a confirmed, code-gated send action.
function encodeHeader(value: string): string {
  // keep headers single-line; encode non-ASCII subjects as RFC 2047
  const clean = value.replace(/[\r\n]+/g, ' ').trim()
  return /[^\x20-\x7E]/.test(clean) ? `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=` : clean
}

export async function sendGmail(
  accessToken: string,
  msg: { to: string; subject: string; body: string }
): Promise<{ id: string }> {
  const headers = [
    `To: ${encodeHeader(msg.to)}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
  ]
  const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${msg.body}`, 'utf8').toString('base64url')
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw }),
  })
  if (!res.ok) throw new Error(`[gmail] send ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return (await res.json()) as { id: string }
}
