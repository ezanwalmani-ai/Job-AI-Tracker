import type { EmailPurposeType, ExtractedJobDetails, PdfValidationReport } from '../types.ts';
import { getFirebaseIdToken, getGmailAccessToken } from './firebase.ts';

const API_BASE = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || '').replace(/\/+$/, '');

interface ClientCacheRecord<T> {
  value: T;
  expiresAt: number;
}

const CLIENT_CACHE_STORAGE_KEY = 'myjobtracker_ai_buffer_v1';
const MAX_CLIENT_CACHE_ENTRIES = 60;
const clientMemoryBuffer = new Map<string, ClientCacheRecord<unknown>>();
const inFlightClientRequests = new Map<string, Promise<unknown>>();
let storageHydrated = false;

function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function hydrateClientBuffer(): void {
  if (storageHydrated) return;
  storageHydrated = true;
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    const raw = window.sessionStorage.getItem(CLIENT_CACHE_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Array<[string, ClientCacheRecord<unknown>]>;
    if (!Array.isArray(parsed)) return;
    const now = Date.now();
    for (const [k, v] of parsed) {
      if (k && v && typeof v.expiresAt === 'number' && v.expiresAt > now) {
        clientMemoryBuffer.set(k, v);
      }
    }
  } catch {
    // ignore corrupted sessionStorage
  }
}

function persistClientBuffer(): void {
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    const now = Date.now();
    const list: Array<[string, ClientCacheRecord<unknown>]> = [];
    for (const [k, v] of clientMemoryBuffer) {
      if (v.expiresAt > now) {
        list.push([k, v]);
      } else {
        clientMemoryBuffer.delete(k);
      }
    }
    window.sessionStorage.setItem(CLIENT_CACHE_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // ignore storage quota exceeded
  }
}

function makeClientCacheKey(namespace: string, payload: unknown): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const clean = { ...(payload as Record<string, unknown>) };
    delete clean.bypassCache;
    return `${namespace}:${fnv1aHash(JSON.stringify(clean))}`;
  }
  return `${namespace}:${fnv1aHash(JSON.stringify(payload))}`;
}

async function cachedApiRequest<T>(
  namespace: string,
  url: string,
  payload: unknown,
  options?: {
    ttlMs?: number;
    bypassCache?: boolean;
    shouldCache?: (value: T) => boolean;
  }
): Promise<T> {
  hydrateClientBuffer();
  const key = makeClientCacheKey(namespace, payload);
  const ttlMs = options?.ttlMs ?? 60 * 60 * 1000;

  if (!options?.bypassCache) {
    const existing = clientMemoryBuffer.get(key);
    if (existing && Date.now() <= existing.expiresAt) {
      // Touch LRU order
      clientMemoryBuffer.delete(key);
      clientMemoryBuffer.set(key, existing);
      return existing.value as T;
    }
  }

  const inflight = inFlightClientRequests.get(key) as Promise<T> | undefined;
  if (inflight) {
    return inflight;
  }

  const reqPromise = apiRequest<T>(url, payload)
    .then((result) => {
      const allow = options?.shouldCache ? options.shouldCache(result) : true;
      if (allow) {
        if (clientMemoryBuffer.has(key)) clientMemoryBuffer.delete(key);
        while (clientMemoryBuffer.size >= MAX_CLIENT_CACHE_ENTRIES) {
          const oldest = clientMemoryBuffer.keys().next().value;
          if (oldest === undefined) break;
          clientMemoryBuffer.delete(oldest);
        }
        clientMemoryBuffer.set(key, { value: result, expiresAt: Date.now() + ttlMs });
        persistClientBuffer();
      }
      return result;
    })
    .finally(() => {
      inFlightClientRequests.delete(key);
    });

  inFlightClientRequests.set(key, reqPromise);
  return reqPromise;
}

async function apiRequest<T>(
  url: string,
  body: unknown,
  options?: { includeGmailToken?: boolean }
): Promise<T> {
  const idToken = await getFirebaseIdToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${idToken}`,
  };

  if (options?.includeGmailToken) {
    const gmailToken = getGmailAccessToken();
    if (!gmailToken) {
      throw new Error(
        'Your Gmail session needs to be connected or refreshed. Click "Connect Gmail" to authorize sending.'
      );
    }
    headers['X-Gmail-Token'] = gmailToken;
  }

  const targetUrl = url.startsWith('http') ? url : `${API_BASE}${url}`;
  const res = await fetch(targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) {
    throw new Error(data.error || `Request failed with status ${res.status}`);
  }
  return data;
}

export function parseResumeApi(pdfBase64: string) {
  return apiRequest<{
    extractedText: string;
    pageCount: number;
    candidateName: string;
    candidateEmail: string;
    candidatePhone: string;
    originalLocation: string;
    locationBox: {
      hasLocationBox: boolean;
      locPage: number;
      locX: number;
      locY: number;
      locW: number;
      locH: number;
      locFontSize: number;
    };
  }>('/api/resume/parse', { pdfBase64 });
}

export function buildResumePdfApi(payload: {
  candidateName: string;
  candidateEmail: string;
  candidatePhone: string;
  originalLocation: string;
  resumeText: string;
  fileName?: string;
}) {
  return apiRequest<{
    pdfBase64: string;
    fileName: string;
    fileSize: number;
    extractedText: string;
    candidateName: string;
    candidateEmail: string;
    candidatePhone: string;
    originalLocation: string;
    locationBox: {
      hasLocationBox: boolean;
      locPage: number;
      locX: number;
      locY: number;
      locW: number;
      locH: number;
      locFontSize: number;
    };
  }>('/api/resume/build-pdf', payload);
}

export function tailorResumeApi(payload: {
  originalPdfBase64: string;
  extractedText: string;
  originalLocation: string;
  locationBox: {
    hasLocationBox: boolean;
    locPage: number;
    locX: number;
    locY: number;
    locW: number;
    locH: number;
    locFontSize: number;
  };
  jobLocation: string;
  companyName: string;
  jobTitle: string;
  jobDescription: string;
  candidateName: string;
  cachedJdSummary?: string;
  cachedKeyRequirements?: string[];
}) {
  return apiRequest<{
    tailoredPdfBase64: string;
    tailoredFileName: string;
    originalLocationText: string;
    updatedLocationText: string;
    normalizedLocation: string;
    pdfByteLength: number;
    validated: boolean;
    validationReport: PdfValidationReport;
    jdSummary: string;
    keyRequirements: string[];
  }>('/api/resume/tailor', payload);
}

export function generateApplicationEmailApi(payload: {
  extractedText: string;
  candidateName: string;
  candidateEmail: string;
  candidatePhone: string;
  companyName: string;
  jobTitle: string;
  jobLocation: string;
  jobDescription: string;
  recruiterName?: string;
  requiredExperience?: string;
  requiredSkills?: string[];
  responsibilities?: string[];
  applicationInstructions?: string;
  emailType?: EmailPurposeType;
  bypassCache?: boolean;
}) {
  const { bypassCache, ...cacheablePayload } = payload;
  return cachedApiRequest<{ subject: string; body: string }>(
    'email_generate',
    '/api/ai/generate-email',
    payload,
    {
      ttlMs: 30 * 60 * 1000,
      bypassCache,
      shouldCache: (res) => Boolean(res.body?.trim()),
    }
  ).catch((err) => {
    void cacheablePayload;
    throw err;
  });
}

export function analyzeManualJdApi(payload: {
  companyName: string;
  jobTitle: string;
  jobLocation: string;
  jobDescription: string;
}) {
  return cachedApiRequest<{ aiSummary: string; keyRequirements: string[] }>(
    'job_analyze_jd',
    '/api/ai/analyze-jd',
    payload,
    { ttlMs: 60 * 60 * 1000 }
  );
}

export function parseJobInputApi(rawText: string) {
  return cachedApiRequest<ExtractedJobDetails>(
    'job_parse',
    '/api/ai/parse-job-input',
    { rawText },
    { ttlMs: 60 * 60 * 1000 }
  );
}

export function findHrContactApi(payload: {
  companyName: string;
  jobLocation?: string;
  jobUrl?: string;
}) {
  return cachedApiRequest<{
    hrEmail: string;
    sourceTitle: string;
    sourceUrl: string;
    message: string;
  }>('hr_lookup', '/api/ai/find-hr-contact', payload, {
    ttlMs: 60 * 60 * 1000,
    shouldCache: (res) => Boolean(res.hrEmail),
  });
}

export function generateFollowUpEmailApi(payload: {
  candidateName: string;
  companyName: string;
  jobTitle: string;
  dateApplied: string;
  originalEmailSubject?: string;
  originalEmailBody?: string;
  previousFollowUps?: string[];
  bypassCache?: boolean;
}) {
  return cachedApiRequest<{ subject: string; body: string }>(
    'email_followup',
    '/api/ai/generate-followup',
    payload,
    {
      ttlMs: 30 * 60 * 1000,
      bypassCache: payload.bypassCache,
      shouldCache: (res) => Boolean(res.body?.trim()),
    }
  );
}

export function sendGmailEmailApi(payload: {
  toEmail: string;
  subject: string;
  body: string;
  attachmentFileName?: string;
  attachmentBase64?: string;
  threadId?: string;
}) {
  return apiRequest<{
    gmailMessageId: string;
    gmailThreadId: string;
    sentAt: string;
  }>('/api/gmail/send', payload, { includeGmailToken: true });
}

export function syncGmailRepliesApi(payload: {
  applications: Array<{
    id: string;
    companyName: string;
    jobTitle: string;
    hrEmail: string;
    gmailThreadId: string;
  }>;
  existingMessageIds: string[];
}) {
  return apiRequest<{
    replies: Array<{
      gmailMessageId: string;
      gmailThreadId: string;
      fromEmail: string;
      fromName: string;
      subject: string;
      snippet: string;
      receivedAt: string;
      matchedApplicationId: string;
      matchConfidence: 'high' | 'needs_review';
      classification:
        | 'Interview Invitation'
        | 'Further Information Requested'
        | 'Rejection'
        | 'Acknowledgement'
        | 'Other';
    }>;
  }>('/api/gmail/sync-replies', payload, { includeGmailToken: true });
}

export function verifyGmailReadonlyApi() {
  return apiRequest<{
    ok: boolean;
    emailAddress: string;
    messagesTotal: number;
    verifiedAt: string;
  }>('/api/gmail/verify-readonly', {}, { includeGmailToken: true });
}

export interface ScannedConfirmationItem {
  gmailMessageId: string;
  gmailThreadId: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  isConfirmedApplication: boolean;
  confidence: 'high' | 'incomplete' | 'not_application';
  companyName: string;
  jobTitle: string;
  jobLocation: string;
  jobUrl: string;
  applicationSource: string;
  applicationDate: string;
  confirmationMessage: string;
  recruiterName: string;
  recruiterEmail: string;
}

export function scanGmailConfirmationsApi(payload: {
  portalFilter?: string;
  existingMessageIds: string[];
}) {
  return apiRequest<{
    checkedCount: number;
    freshCount: number;
    confirmations: ScannedConfirmationItem[];
  }>('/api/gmail/scan-confirmations', payload, { includeGmailToken: true });
}

export function getExtensionDownloadUrl(): string {
  return `${API_BASE}/api/extension/download.zip`;
}
