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

export interface GmailConfirmationCandidate {
  gmailMessageId: string;
  gmailThreadId: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  snippet: string;
  bodyExcerpt: string;
  receivedAt: string;
}

interface GmailMessagePart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
}

function decodeBase64Url(data: string): string {
  try {
    const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(normalized, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractReadableBody(payload?: GmailMessagePart): string {
  if (!payload) return '';
  let plain = '';
  let html = '';

  const walk = (part: GmailMessagePart) => {
    if (part.mimeType === 'text/plain' && part.body?.data && !plain) {
      plain = decodeBase64Url(part.body.data);
    } else if (part.mimeType === 'text/html' && part.body?.data && !html) {
      html = decodeBase64Url(part.body.data);
    }
    if (Array.isArray(part.parts)) {
      for (const child of part.parts) {
        walk(child);
      }
    }
  };

  walk(payload);
  const raw = plain.trim() || (html ? stripHtmlTags(html) : '');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 3500);
}

export async function verifyGmailReadonlyProfile(accessToken: string): Promise<{
  emailAddress: string;
  messagesTotal: number;
}> {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = (await res.json().catch(() => ({}))) as {
    emailAddress?: string;
    messagesTotal?: number;
    error?: { message?: string };
  };

  if (!res.ok || !data.emailAddress) {
    throw new Error(
      data.error?.message || `Failed to verify read-only Gmail access (HTTP ${res.status})`
    );
  }

  return {
    emailAddress: data.emailAddress,
    messagesTotal: data.messagesTotal ?? 0,
  };
}

export async function fetchJobConfirmationEmails(params: {
  accessToken: string;
  userEmail: string;
  maxResults?: number;
  portalFilter?: string;
}): Promise<GmailConfirmationCandidate[]> {
  let portalClause = '';
  const filterLower = (params.portalFilter || '').trim().toLowerCase();
  if (filterLower === 'linkedin') {
    portalClause = ' (linkedin OR from:jobs-noreply@linkedin.com)';
  } else if (filterLower === 'indeed') {
    portalClause = ' (indeed OR from:indeedapply@indeed.com)';
  } else if (filterLower === 'naukri') {
    portalClause = ' (naukri OR from:naukri.com)';
  } else if (filterLower === 'workindia') {
    portalClause = ' (workindia OR from:workindia.in)';
  } else if (filterLower === 'apna') {
    portalClause = ' (apna OR from:apna.co)';
  }

  const rawQuery =
    '-from:me -in:drafts ("application has been submitted" OR "thank you for applying" OR "thanks for applying" OR "application was received" OR "application has been received" OR "application confirmation" OR "successfully applied" OR "your application to" OR "your application for" OR from:jobs-noreply@linkedin.com OR from:indeedapply@indeed.com OR from:naukri.com OR from:workindia.in OR from:apna.co)' +
    portalClause;

  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(
      rawQuery
    )}&maxResults=${params.maxResults ?? 20}`,
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
      listData.error?.message ||
        `Failed to scan Gmail for application confirmations (HTTP ${listRes.status})`
    );
  }

  const messageRefs = listData.messages ?? [];
  if (messageRefs.length === 0) return [];

  const details = await Promise.all(
    messageRefs.slice(0, params.maxResults ?? 20).map(async (ref) => {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ref.id}?format=full`,
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
        payload?: GmailMessagePart & {
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
      const bodyExcerpt = extractReadableBody(msg.payload);

      return {
        gmailMessageId: msg.id,
        gmailThreadId: msg.threadId || '',
        fromEmail: fromParsed.email,
        fromName: fromParsed.name || fromParsed.email,
        subject: getHeader('Subject') || '(No subject)',
        snippet: msg.snippet || '',
        bodyExcerpt: bodyExcerpt || msg.snippet || '',
        receivedAt: new Date(internalMs).toISOString(),
      } satisfies GmailConfirmationCandidate;
    })
  );

  return details.filter((m): m is GmailConfirmationCandidate => m !== null);
}
