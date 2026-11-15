import type { EmailPurposeType, ExtractedJobDetails, PdfValidationReport } from '../types.ts';
import { getFirebaseIdToken, getGmailAccessToken } from './firebase.ts';

const API_BASE = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || '').replace(/\/+$/, '');

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
}) {
  return apiRequest<{ subject: string; body: string }>('/api/ai/generate-email', payload);
}

export function analyzeManualJdApi(payload: {
  companyName: string;
  jobTitle: string;
  jobLocation: string;
  jobDescription: string;
}) {
  return apiRequest<{ aiSummary: string; keyRequirements: string[] }>(
    '/api/ai/analyze-jd',
    payload
  );
}

export function parseJobInputApi(rawText: string) {
  return apiRequest<ExtractedJobDetails>('/api/ai/parse-job-input', { rawText });
}

export function findHrContactApi(payload: {
  companyName: string;
  jobLocation?: string;
  jobUrl?: string;
}) {
  return apiRequest<{
    hrEmail: string;
    sourceTitle: string;
    sourceUrl: string;
    message: string;
  }>('/api/ai/find-hr-contact', payload);
}

export function generateFollowUpEmailApi(payload: {
  candidateName: string;
  companyName: string;
  jobTitle: string;
  dateApplied: string;
  originalEmailSubject?: string;
  originalEmailBody?: string;
  previousFollowUps?: string[];
}) {
  return apiRequest<{ subject: string; body: string }>('/api/ai/generate-followup', payload);
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
