export interface SendGmailEmailParams {
  accessToken: string;
  fromEmail?: string;
  toEmail: string;
  subject: string;
  body: string;
  attachment?: {
    fileName: string;
    mimeType: string;
    base64Data: string;
  };
  threadId?: string;
}

export interface SendGmailResult {
  id: string;
  threadId: string;
}

function encodeMimeHeader(value: string): string {
  // Encode non-ASCII header text safely per RFC 2047
  if (/^[\x20-\x7E]*$/.test(value)) {
    return value;
  }
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function chunkBase64(b64: string, lineLength = 76): string {
  const clean = b64.replace(/\s+/g, '');
  const lines: string[] = [];
  for (let i = 0; i < clean.length; i += lineLength) {
    lines.push(clean.slice(i, i + lineLength));
  }
  return lines.join('\r\n');
}

function toBase64Url(str: string): string {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function sendGmailMessage(
  params: SendGmailEmailParams
): Promise<SendGmailResult> {
  const boundary = `----=_MyJobTracker_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const headers: string[] = [
    `To: ${params.toEmail}`,
    `Subject: ${encodeMimeHeader(params.subject)}`,
    'MIME-Version: 1.0',
  ];

  if (params.fromEmail) {
    headers.unshift(`From: ${params.fromEmail}`);
  }

  let rawEmail = '';
  if (params.attachment) {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const bodyBase64 = chunkBase64(Buffer.from(params.body, 'utf8').toString('base64'));
    const attachmentBase64 = chunkBase64(params.attachment.base64Data);
    const safeFilename = params.attachment.fileName.replace(/["\r\n]/g, '');

    rawEmail = [
      ...headers,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      bodyBase64,
      `--${boundary}`,
      `Content-Type: ${params.attachment.mimeType}; name="${safeFilename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${safeFilename}"`,
      '',
      attachmentBase64,
      `--${boundary}--`,
      '',
    ].join('\r\n');
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push('Content-Transfer-Encoding: base64');
    rawEmail = [
      ...headers,
      '',
      chunkBase64(Buffer.from(params.body, 'utf8').toString('base64')),
    ].join('\r\n');
  }

  const payload: { raw: string; threadId?: string } = {
    raw: toBase64Url(rawEmail),
  };
  if (params.threadId) {
    payload.threadId = params.threadId;
  }

  const response = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }
  );

  const data = (await response.json()) as {
    id?: string;
    threadId?: string;
    error?: { message?: string; code?: number };
  };

  if (!response.ok || !data.id) {
    const errMsg =
      data.error?.message || `Gmail API returned HTTP ${response.status}`;
    throw new Error(errMsg);
  }

  return {
    id: data.id,
    threadId: data.threadId || '',
  };
}

export interface GmailInboxMessage {
  gmailMessageId: string;
  gmailThreadId: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  snippet: string;
  receivedAt: string;
}

function parseFromHeader(fromHeader: string): { name: string; email: string } {
  const match = fromHeader.match(/^(?:"?([^"]*)"?\s)?<?([^<>@\s]+@[^<>@\s]+)>?$/);
  if (match) {
    return {
      name: (match[1] || '').trim(),
      email: (match[2] || fromHeader).trim().toLowerCase(),
    };
  }
  return { name: '', email: fromHeader.trim().toLowerCase() };
}

export async function fetchRecentGmailReplies(params: {
  accessToken: string;
  userEmail: string;
  maxResults?: number;
}): Promise<GmailInboxMessage[]> {
  const query = encodeURIComponent(
    'in:inbox -from:me (application OR interview OR position OR role OR candidate OR hiring OR offer OR unfortunately OR thank)'
  );
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=${params.maxResults ?? 15}`,
    {
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
      },
    }
  );

  const listData = (await listRes.json()) as {
    messages?: Array<{ id: string; threadId: string }>;
    error?: { message?: string };
  };

  if (!listRes.ok) {
    throw new Error(
      listData.error?.message || `Failed to read Gmail inbox (HTTP ${listRes.status})`
    );
  }

  const messageRefs = listData.messages ?? [];
  if (messageRefs.length === 0) return [];

  const details = await Promise.all(
    messageRefs.slice(0, 15).map(async (ref) => {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ref.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        {
          headers: {
            Authorization: `Bearer ${params.accessToken}`,
          },
        }
      );
      if (!msgRes.ok) return null;
      const msg = (await msgRes.json()) as {
        id: string;
        threadId: string;
        snippet?: string;
        internalDate?: string;
        payload?: {
          headers?: Array<{ name: string; value: string }>;
        };
      };

      const headers = msg.payload?.headers ?? [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

      const fromParsed = parseFromHeader(getHeader('From'));
      if (
        params.userEmail &&
        fromParsed.email === params.userEmail.trim().toLowerCase()
      ) {
        return null;
      }

      const internalMs = msg.internalDate ? Number(msg.internalDate) : Date.now();
      return {
        gmailMessageId: msg.id,
        gmailThreadId: msg.threadId || '',
        fromEmail: fromParsed.email,
        fromName: fromParsed.name || fromParsed.email,
        subject: getHeader('Subject') || '(No subject)',
        snippet: msg.snippet || '',
        receivedAt: new Date(internalMs).toISOString(),
      } satisfies GmailInboxMessage;
    })
  );

  return details.filter((m): m is GmailInboxMessage => m !== null);
}
