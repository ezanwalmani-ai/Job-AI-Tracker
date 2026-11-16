import crypto from 'node:crypto';
import type { EmailPurposeType } from '../types.ts';
import { normalizeJobLocationToCityState } from './pdfService.ts';

export class ServerTtlCache<T> {
  private readonly store = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 400
  ) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh recency
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    }
    while (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

export function hashKey(parts: unknown[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function isQuotaOrRateLimitError(err: unknown): boolean {
  const raw =
    err instanceof Error
      ? `${err.message} ${String((err as { status?: unknown }).status ?? '')}`
      : String(err ?? '');
  const lower = raw.toLowerCase();
  return (
    lower.includes('429') ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests') ||
    lower.includes('overloaded') ||
    lower.includes('unavailable') ||
    lower.includes('503')
  );
}

const AGGREGATOR_DOMAINS = new Set([
  'linkedin.com',
  'indeed.com',
  'indeed.co.in',
  'naukri.com',
  'workindia.in',
  'apna.co',
  'glassdoor.com',
  'glassdoor.co.in',
  'wellfound.com',
  'monster.com',
  'foundit.in',
  'shine.com',
  'timesjobs.com',
  'duckduckgo.com',
  'google.com',
  'facebook.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'youtube.com',
  'github.com',
  'sentry.io',
  'w3.org',
  'example.com',
]);

const GENERIC_FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'yahoo.co.in',
  'outlook.com',
  'hotmail.com',
  'icloud.com',
  'proton.me',
  'protonmail.com',
]);

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUsefulHrEmailCandidate(email: string): boolean {
  const lower = email.toLowerCase().trim();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,12}$/.test(lower)) return false;
  if (/\.(png|jpg|jpeg|gif|svg|webp|css|js|woff|woff2)$/i.test(lower)) return false;
  const [local, domain] = lower.split('@');
  if (!local || !domain) return false;
  if (AGGREGATOR_DOMAINS.has(domain)) return false;
  if (
    local.includes('noreply') ||
    local.includes('no-reply') ||
    local.includes('donotreply') ||
    local.includes('bounce') ||
    local.includes('mailer-daemon') ||
    local.includes('privacy') ||
    local.includes('abuse') ||
    local.includes('postmaster')
  ) {
    return false;
  }
  return true;
}

function scoreEmailCandidate(email: string, companyTokens: string[]): number {
  const lower = email.toLowerCase();
  const [local, domain] = lower.split('@');
  let score = 0;

  if (/^(hr|careers|career|jobs|recruitment|recruiting|talent|hiring|people)/.test(local)) {
    score += 60;
  } else if (/(hr|career|job|recruit|talent|hiring|people)/.test(local)) {
    score += 45;
  } else if (/^(info|contact|hello|admin|office)/.test(local)) {
    score += 20;
  } else {
    score += 10;
  }

  if (!GENERIC_FREE_EMAIL_DOMAINS.has(domain)) {
    score += 25;
  }
  for (const tok of companyTokens) {
    if (tok.length >= 3 && domain.includes(tok)) {
      score += 40;
      break;
    }
  }
  return score;
}

function extractEmailsFromHtmlOrText(raw: string): string[] {
  const out = new Set<string>();
  const mailtoRegex = /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,12})/gi;
  for (const m of raw.matchAll(mailtoRegex)) {
    if (m[1] && isUsefulHrEmailCandidate(m[1])) out.add(m[1].toLowerCase());
  }
  const plain = stripHtmlToText(raw);
  const emailRegex = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,12}\b/g;
  for (const m of plain.matchAll(emailRegex)) {
    if (m[0] && isUsefulHrEmailCandidate(m[0])) out.add(m[0].toLowerCase());
  }
  return Array.from(out);
}

async function fetchHtmlSnippet(url: string, timeoutMs = 3500): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return '';
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('text/html') && !ctype.includes('text/plain')) return '';
    const text = await res.text();
    return text.slice(0, 150000);
  } catch {
    return '';
  }
}

function buildCompanyCandidateOrigins(companyName: string, jobUrl?: string): string[] {
  const origins: string[] = [];
  if (jobUrl) {
    try {
      const parsed = new URL(jobUrl.startsWith('http') ? jobUrl : `https://${jobUrl}`);
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
      if (!AGGREGATOR_DOMAINS.has(host)) {
        origins.push(`${parsed.protocol}//${parsed.host}`);
      }
    } catch {
      // ignore invalid URL
    }
  }

  const cleaned = companyName
    .toLowerCase()
    .replace(/\b(private|pvt|limited|ltd|llp|inc|corp|corporation|llc|india|technologies|technology|tech|solutions|services|systems|group)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim();

  const words = cleaned.split(/\s+/).filter(Boolean);
  const slugs = new Set<string>();
  if (words.length > 0) {
    slugs.add(words.join(''));
    if (words.length > 1) {
      slugs.add(words.join('-'));
      if (words[0].length >= 4) slugs.add(words[0]);
    }
  }

  for (const slug of Array.from(slugs).slice(0, 2)) {
    origins.push(`https://www.${slug}.com`);
    origins.push(`https://www.${slug}.in`);
    origins.push(`https://${slug}.com`);
    origins.push(`https://www.${slug}.co.in`);
  }

  return Array.from(new Set(origins)).slice(0, 8);
}

/**
 * Unlimited zero-AI-quota lookup for official company HR/careers emails.
 * Checks direct jobUrl (if non-aggregator), official company career/contact pages,
 * and public DuckDuckGo HTML search results.
 */
export async function findCompanyHrContactFreeWeb(params: {
  companyName: string;
  jobLocation?: string;
  jobUrl?: string;
}): Promise<{ hrEmail: string; sourceTitle: string; sourceUrl: string; message: string } | null> {
  const companyTokens = params.companyName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !['pvt', 'ltd', 'inc', 'llc', 'india', 'private', 'limited'].includes(w));

  const foundCandidates: Array<{ email: string; sourceUrl: string; sourceTitle: string; score: number }> = [];

  const collectFromPage = async (url: string, title: string) => {
    const html = await fetchHtmlSnippet(url, 3200);
    if (!html) return;
    const emails = extractEmailsFromHtmlOrText(html);
    for (const email of emails) {
      foundCandidates.push({
        email,
        sourceUrl: url,
        sourceTitle: title,
        score: scoreEmailCandidate(email, companyTokens),
      });
    }
  };

  // 1. Check jobUrl directly if non-aggregator
  if (params.jobUrl) {
    try {
      const u = new URL(params.jobUrl.startsWith('http') ? params.jobUrl : `https://${params.jobUrl}`);
      const host = u.hostname.replace(/^www\./, '').toLowerCase();
      if (!AGGREGATOR_DOMAINS.has(host)) {
        await collectFromPage(u.toString(), `${params.companyName} Job Posting`);
      }
    } catch {
      // ignore
    }
  }

  // 2. Probe likely company official websites (/careers, /contact, /) in parallel
  if (foundCandidates.length === 0) {
    const origins = buildCompanyCandidateOrigins(params.companyName, params.jobUrl);
    const probeUrls: Array<{ url: string; title: string }> = [];
    for (const origin of origins.slice(0, 4)) {
      probeUrls.push({ url: `${origin}/careers`, title: `${params.companyName} Careers` });
      probeUrls.push({ url: `${origin}/contact`, title: `${params.companyName} Contact` });
      probeUrls.push({ url: `${origin}/contact-us`, title: `${params.companyName} Contact` });
      probeUrls.push({ url: origin, title: `${params.companyName} Official Website` });
    }
    await Promise.allSettled(
      probeUrls.slice(0, 10).map((p) => collectFromPage(p.url, p.title))
    );
  }

  // 3. Fallback to public DuckDuckGo HTML search (free, no API key required)
  if (foundCandidates.length === 0) {
    const q = `"${params.companyName}" (hr@ OR careers@ OR jobs@ OR recruitment@ OR talent@) email`;
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const ddgHtml = await fetchHtmlSnippet(ddgUrl, 4500);
    if (ddgHtml) {
      const emails = extractEmailsFromHtmlOrText(ddgHtml);
      for (const email of emails) {
        foundCandidates.push({
          email,
          sourceUrl: ddgUrl,
          sourceTitle: 'Public web search (free fallback)',
          score: scoreEmailCandidate(email, companyTokens),
        });
      }
    }
  }

  if (foundCandidates.length === 0) return null;

  foundCandidates.sort((a, b) => b.score - a.score);
  const best = foundCandidates[0];
  if (best.score < 35) return null;

  return {
    hrEmail: best.email,
    sourceTitle: best.sourceTitle,
    sourceUrl: best.sourceUrl,
    message: `Discovered ${best.email} via free public website lookup.`,
  };
}

export function extractCandidateInfoFallback(extractedText: string): {
  candidateName: string;
  candidateEmail: string;
  candidatePhone: string;
  originalLocation: string;
} {
  const lines = extractedText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const emailMatch = extractedText.match(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,12}\b/);
  const phoneMatch = extractedText.match(/(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{3,5}\)?[\s-]?)?\d{5}[\s-]?\d{5}|\b\d{10}\b/);

  let candidateName = '';
  for (const line of lines.slice(0, 6)) {
    if (line.includes('@') || /\d{5,}/.test(line) || /linkedin\.com/i.test(line)) continue;
    if (line.length >= 3 && line.length <= 50 && /^[a-zA-Z.\s-]+$/.test(line)) {
      candidateName = line;
      break;
    }
  }

  let originalLocation = '';
  for (const line of lines.slice(0, 12)) {
    const locMatch = line.match(
      /\b([A-Z][a-zA-Z ]{2,24},\s*(?:Maharashtra|Karnataka|Telangana|Tamil Nadu|Delhi|Haryana|Uttar Pradesh|Gujarat|West Bengal|Rajasthan|Kerala|India|[A-Z]{2}))\b/
    );
    if (locMatch?.[1]) {
      originalLocation = locMatch[1].trim();
      break;
    }
  }

  return {
    candidateName,
    candidateEmail: emailMatch?.[0] || '',
    candidatePhone: phoneMatch?.[0]?.trim() || '',
    originalLocation,
  };
}

function extractBulletsAndKeywords(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s•\-*▪–\d.)]+/, '').trim())
    .filter((l) => l.length >= 12 && l.length <= 140);

  const picked: string[] = [];
  for (const line of lines) {
    if (
      /^(company|location|salary|ctc|experience|apply|http|email|phone|contact)/i.test(line)
    ) {
      continue;
    }
    if (!picked.includes(line)) picked.push(line);
    if (picked.length >= 6) break;
  }
  return picked;
}

export function prepareLocationAndJdFallback(params: {
  originalLocation: string;
  jobLocation: string;
  companyName: string;
  jobTitle: string;
  jobDescription: string;
}): {
  exactOriginalSubstring: string;
  replacementLocationText: string;
  jdSummary: string;
  keyRequirements: string[];
} {
  const normalizedTarget = normalizeJobLocationToCityState(params.jobLocation) || params.jobLocation.trim();
  const keyRequirements = extractBulletsAndKeywords(params.jobDescription);
  const jdSummary = `${params.companyName} is hiring for a ${params.jobTitle} role${normalizedTarget ? ` in ${normalizedTarget}` : ''}. Key focus areas include ${keyRequirements.slice(0, 2).join('; ') || 'core domain execution and cross-functional coordination'}.`;

  return {
    exactOriginalSubstring: params.originalLocation.trim(),
    replacementLocationText: `Preferred Location: ${normalizedTarget}`,
    jdSummary,
    keyRequirements,
  };
}

export function analyzeManualJdFallback(params: {
  companyName: string;
  jobTitle: string;
  jobLocation: string;
  jobDescription: string;
}): { aiSummary: string; keyRequirements: string[] } {
  const keyRequirements = extractBulletsAndKeywords(params.jobDescription);
  const loc = normalizeJobLocationToCityState(params.jobLocation) || params.jobLocation;
  return {
    aiSummary: `${params.jobTitle} opening at ${params.companyName}${loc ? ` (${loc})` : ''}. Core focus: ${keyRequirements.slice(0, 2).join('; ') || 'role-specific execution and delivery'}.`,
    keyRequirements,
  };
}

export function parseRawJobInputFallback(rawText: string): {
  companyName: string;
  jobTitle: string;
  extractedDescription: string;
  responsibilities: string[];
  requiredExperience: string;
  requiredSkills: string[];
  preferredQualifications: string[];
  jobLocation: string;
  companyAddress: string;
  recruiterName: string;
  hrEmail: string;
  jobUrl: string;
  salary: string;
  employmentType: string;
  applicationInstructions: string;
  applicationSource: string;
  notes: string;
  aiSummary: string;
  keyRequirements: string[];
} {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const matchField = (labels: string[]): string => {
    for (const line of lines) {
      for (const lbl of labels) {
        const re = new RegExp(`^(?:${lbl})\\s*[:\\-–]\\s*(.+)$`, 'i');
        const m = line.match(re);
        if (m?.[1]) return m[1].trim();
      }
    }
    return '';
  };

  const urlMatch = rawText.match(/https?:\/\/[^\s)>\]"']+/i);
  const jobUrl = matchField(['apply link', 'job url', 'url', 'link']) || (urlMatch?.[0] || '');

  const emails = Array.from(
    rawText.matchAll(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,12}\b/g)
  ).map((m) => m[0]);
  const hrEmail = emails.find((e) => !/noreply|no-reply|donotreply/i.test(e)) || '';

  let jobTitle = matchField(['job title', 'role', 'position', 'designation', 'opening']);
  let companyName = matchField(['company name', 'company', 'organization', 'employer', 'hiring company']);
  const recruiterName = matchField(['recruiter', 'hr name', 'contact person', 'hiring manager']);
  const rawLocation = matchField(['location', 'job location', 'work location', 'city']);
  const requiredExperience =
    matchField(['experience', 'required experience', 'exp']) ||
    (rawText.match(/\b(\d+\s*(?:-|–|to)\s*\d+\s*years?|\d+\+?\s*years?\s*(?:of\s*)?experience)\b/i)?.[1] || '');
  const salary =
    matchField(['salary', 'ctc', 'compensation', 'pay']) ||
    (rawText.match(/(?:₹|INR|Rs\.?|USD|\$)\s?[\d,.\s]+(?:\s*(?:-|–|to)\s*(?:₹|INR|Rs\.?|USD|\$)?\s?[\d,.\s]+)?(?:\s*(?:LPA|PA|per annum|per month|\/month|\/year))?/i)?.[0]?.trim() || '');
  const employmentType =
    matchField(['employment type', 'job type', 'work mode']) ||
    (rawText.match(/\b(Full-time|Part-time|Contract|Internship|Hybrid|Remote)\b/i)?.[1] || '');

  // Heuristic title & company from top lines if explicit labels weren't present
  if (!jobTitle && lines[0]) {
    const atMatch = lines[0].match(/^(.{3,70}?)\s+(?:at|@|-|–|\|)\s+(.{2,60})$/i);
    if (atMatch) {
      jobTitle = atMatch[1].trim();
      if (!companyName) companyName = atMatch[2].trim();
    } else if (lines[0].length <= 80 && !lines[0].includes('http')) {
      jobTitle = lines[0].replace(/^(?:we are hiring|hiring|job opening)\s*[:\-–]?\s*/i, '').trim();
    }
  }
  if (!companyName && lines[1] && lines[1].length <= 65 && !lines[1].includes(':') && !lines[1].includes('http')) {
    companyName = lines[1];
  }

  let jobLocation = rawLocation ? normalizeJobLocationToCityState(rawLocation) : '';
  if (!jobLocation) {
    const cityGuess = rawText.match(
      /\b(Pune|Bengaluru|Bangalore|Mumbai|Hyderabad|Gurugram|Gurgaon|Noida|New Delhi|Delhi|Chennai|Kolkata|Ahmedabad|Jaipur|Remote)\b/i
    );
    if (cityGuess?.[1]) {
      jobLocation = normalizeJobLocationToCityState(cityGuess[1]);
    }
  }

  const lower = `${rawText} ${jobUrl}`.toLowerCase();
  let applicationSource = 'Job Posting';
  if (lower.includes('linkedin.com')) applicationSource = 'LinkedIn';
  else if (lower.includes('naukri.com')) applicationSource = 'Naukri';
  else if (lower.includes('indeed.')) applicationSource = 'Indeed';
  else if (lower.includes('workindia')) applicationSource = 'WorkIndia';
  else if (lower.includes('apna.co')) applicationSource = 'Apna';
  else if (lower.includes('wellfound')) applicationSource = 'Wellfound';
  else if (lower.includes('glassdoor')) applicationSource = 'Glassdoor';
  else if (hrEmail || /^(from:|subject:)/im.test(rawText.slice(0, 250))) applicationSource = 'HR Email';

  const bullets = extractBulletsAndKeywords(rawText);
  const skillsLine = matchField(['skills', 'required skills', 'key skills']);
  const requiredSkills = skillsLine
    ? skillsLine.split(/[,;|]/).map((s) => s.trim()).filter(Boolean).slice(0, 12)
    : [];

  return {
    companyName,
    jobTitle,
    extractedDescription: rawText.trim(),
    responsibilities: bullets.slice(0, 6),
    requiredExperience,
    requiredSkills,
    preferredQualifications: [],
    jobLocation,
    companyAddress: '',
    recruiterName,
    hrEmail,
    jobUrl,
    salary,
    employmentType,
    applicationInstructions: '',
    applicationSource,
    notes: 'Extracted using built-in fast parser (zero AI quota used).',
    aiSummary: `${jobTitle || 'Role'} opportunity${companyName ? ` at ${companyName}` : ''}${jobLocation ? ` (${jobLocation})` : ''}.`,
    keyRequirements: bullets.slice(0, 6),
  };
}

export function generateApplicationEmailFallback(params: {
  extractedText: string;
  candidateName: string;
  candidateEmail: string;
  candidatePhone: string;
  companyName: string;
  jobTitle: string;
  jobLocation: string;
  jobDescription: string;
  recruiterName?: string;
  requiredSkills?: string[];
  emailType?: EmailPurposeType;
}): { subject: string; body: string } {
  const candidate = params.candidateName || 'Candidate';
  const loc = normalizeJobLocationToCityState(params.jobLocation) || params.jobLocation;
  const emailType: EmailPurposeType =
    params.emailType ||
    (params.recruiterName?.trim() ? 'initial_application' : 'application_unnamed_recruiter');

  const subject =
    emailType === 'follow_up'
      ? `Follow-up on ${params.jobTitle} Application – ${params.companyName}`
      : emailType === 'recruitment_enquiry'
        ? `Recruitment Enquiry: ${params.jobTitle} Opportunities at ${params.companyName} – ${candidate}`
        : `Application for ${params.jobTitle} at ${params.companyName} – ${candidate}`;

  const greeting =
    emailType !== 'application_unnamed_recruiter' && params.recruiterName?.trim()
      ? `Dear ${params.recruiterName.trim()},`
      : `Dear ${params.companyName} Hiring Team,`;

  // Pick strictly verified matching lines/skills from master resume
  const jdWords = new Set(
    `${params.jobTitle} ${(params.requiredSkills || []).join(' ')} ${params.jobDescription}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4)
  );
  const resumeLines = params.extractedText
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s•\-*▪]+/, '').trim())
    .filter((l) => l.length >= 25 && l.length <= 180 && !l.includes('@'));

  const matchingHighlights = resumeLines
    .map((line) => {
      const words = line.toLowerCase().split(/[^a-z0-9]+/);
      const hits = words.filter((w) => jdWords.has(w)).length;
      return { line, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 2)
    .map((x) => x.line);

  const highlightText =
    matchingHighlights.length > 0
      ? `In my background, I bring verified hands-on experience directly relevant to this role, including:\n- ${matchingHighlights.join('\n- ')}`
      : `With my background aligned to ${params.jobTitle} responsibilities, I bring practical experience supporting day-to-day operations, coordination, and execution.`;

  const contactLine = [candidate, params.candidateEmail, params.candidatePhone]
    .filter(Boolean)
    .join(' | ');

  const body = [
    greeting,
    '',
    `I am writing to apply for the ${params.jobTitle} position at ${params.companyName}${loc ? ` (${loc})` : ''}.`,
    '',
    highlightText,
    '',
    'I have attached my updated resume PDF for your review and would welcome the opportunity to discuss how my background aligns with your team’s goals.',
    '',
    'Best regards,',
    contactLine,
  ].join('\n');

  return { subject, body };
}

export function generateFollowUpEmailFallback(params: {
  candidateName: string;
  companyName: string;
  jobTitle: string;
  dateApplied: string;
}): { subject: string; body: string } {
  const candidate = params.candidateName || 'Candidate';
  return {
    subject: `Follow-up on ${params.jobTitle} Application – ${params.companyName}`,
    body: [
      `Dear ${params.companyName} Hiring Team,`,
      '',
      `I hope you are doing well. I am following up on my application for the ${params.jobTitle} role submitted on ${params.dateApplied}.`,
      '',
      `I remain very interested in contributing to ${params.companyName} and would be glad to provide any additional information or schedule a brief conversation at your convenience.`,
      '',
      'Best regards,',
      candidate,
    ].join('\n'),
  };
}

export function classifyRepliesFallback(params: {
  messages: Array<{
    gmailMessageId: string;
    gmailThreadId: string;
    fromEmail: string;
    fromName: string;
    subject: string;
    snippet: string;
  }>;
  applications: Array<{
    id: string;
    companyName: string;
    jobTitle: string;
    hrEmail: string;
    gmailThreadId: string;
  }>;
}) {
  return params.messages.map((m) => {
    const text = `${m.subject} ${m.snippet}`.toLowerCase();
    let matchedApplicationId = '';
    let matchConfidence: 'high' | 'needs_review' = 'needs_review';

    const byThread = params.applications.find((a) => a.gmailThreadId && a.gmailThreadId === m.gmailThreadId);
    if (byThread) {
      matchedApplicationId = byThread.id;
      matchConfidence = 'high';
    } else {
      const fromDomain = (m.fromEmail.split('@')[1] || '').toLowerCase();
      const byCompanyOrEmail = params.applications.find((a) => {
        if (a.hrEmail && a.hrEmail.toLowerCase() === m.fromEmail.toLowerCase()) return true;
        const cleanComp = a.companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
        return (cleanComp.length >= 3 && fromDomain.includes(cleanComp)) || text.includes(a.companyName.toLowerCase());
      });
      if (byCompanyOrEmail) {
        matchedApplicationId = byCompanyOrEmail.id;
        matchConfidence = 'high';
      }
    }

    let classification:
      | 'Interview Invitation'
      | 'Further Information Requested'
      | 'Rejection'
      | 'Acknowledgement'
      | 'Other' = 'Other';
    if (/(interview|schedule a call|availability|round \d|shortlisted)/.test(text)) {
      classification = 'Interview Invitation';
    } else if (/(unfortunately|not moving forward|other candidates|regret to inform|declined)/.test(text)) {
      classification = 'Rejection';
    } else if (/(share your|expected ctc|notice period|additional details|please confirm)/.test(text)) {
      classification = 'Further Information Requested';
    } else if (/(received|thank you for applying|under review|acknowledg)/.test(text)) {
      classification = 'Acknowledgement';
    }

    return {
      gmailMessageId: m.gmailMessageId,
      matchedApplicationId,
      matchConfidence,
      classification,
    };
  });
}

export function isLikelyNonApplicationDigest(subject: string, snippet: string): boolean {
  const lower = `${subject} ${snippet}`.toLowerCase();
  const digestSignals = [
    'jobs recommended for you',
    'new jobs matching',
    'job alert',
    'recommended jobs',
    'top jobs for you',
    "you're invited to apply",
    'apply now to',
    'people also viewed',
    'weekly job digest',
    'daily job alert',
  ];
  const confirmSignals = [
    'your application has been submitted',
    'thank you for applying',
    'thanks for applying',
    'your application was received',
    'application confirmation',
    'you have successfully applied',
    'we received your application',
    'application submitted',
  ];
  if (confirmSignals.some((p) => lower.includes(p))) return false;
  return digestSignals.some((p) => lower.includes(p));
}

export function detectPortalConfirmationsFallback(params: {
  messages: Array<{
    gmailMessageId: string;
    fromEmail: string;
    fromName: string;
    subject: string;
    snippet: string;
    bodyExcerpt: string;
    receivedAt: string;
  }>;
}) {
  return params.messages.map((m) => {
    const combined = `${m.subject}\n${m.snippet}\n${m.bodyExcerpt}`;
    const lower = combined.toLowerCase();
    const isDigest = isLikelyNonApplicationDigest(m.subject, m.snippet);
    const confirmMatches = [
      'your application has been submitted',
      'thank you for applying',
      'thanks for applying',
      'your application was received',
      'application confirmation',
      'you have successfully applied',
      'we received your application',
      'application submitted',
    ].find((phrase) => lower.includes(phrase));

    if (isDigest || !confirmMatches) {
      return {
        gmailMessageId: m.gmailMessageId,
        isConfirmedApplication: false,
        confidence: 'not_application' as const,
        companyName: '',
        jobTitle: '',
        jobLocation: '',
        jobUrl: '',
        applicationSource: 'Company Career Page',
        applicationDate: m.receivedAt.slice(0, 10),
        confirmationMessage: '',
        recruiterName: '',
        recruiterEmail: '',
      };
    }

    const fromLower = m.fromEmail.toLowerCase();
    let applicationSource = 'Company Career Page';
    if (fromLower.includes('linkedin')) applicationSource = 'LinkedIn';
    else if (fromLower.includes('indeed')) applicationSource = 'Indeed';
    else if (fromLower.includes('naukri')) applicationSource = 'Naukri';
    else if (fromLower.includes('workindia')) applicationSource = 'WorkIndia';
    else if (fromLower.includes('apna')) applicationSource = 'Apna';

    const forAtMatch = m.subject.match(/for\s+(.{3,60}?)\s+at\s+(.{2,60})/i);
    const companyName = forAtMatch?.[2]?.trim() || m.fromName.replace(/jobs|careers|recruiting/gi, '').trim();
    const jobTitle = forAtMatch?.[1]?.trim() || '';
    const urlMatch = combined.match(/https?:\/\/[^\s)>\]"']+/i);

    return {
      gmailMessageId: m.gmailMessageId,
      isConfirmedApplication: true,
      confidence: companyName && jobTitle ? ('high' as const) : ('incomplete' as const),
      companyName,
      jobTitle,
      jobLocation: '',
      jobUrl: urlMatch?.[0] || '',
      applicationSource,
      applicationDate: m.receivedAt.slice(0, 10),
      confirmationMessage: confirmMatches,
      recruiterName: '',
      recruiterEmail: '',
    };
  });
}
