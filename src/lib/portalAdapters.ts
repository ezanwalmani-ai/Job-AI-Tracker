import type {
  ApplicationStatus,
  JobApplicationRecord,
  PortalConnectionRecord,
  PortalId,
} from '../types.ts';
import { getTodayIsoDate } from './dateUtils.ts';

export interface PortalAdapterCapabilities {
  gmailConfirmation: boolean;
  chromeExtension: boolean;
  csvExportImport: boolean;
  manualQuickSave: boolean;
  officialPublicApi: false;
}

export interface PortalAdapterDefinition {
  portalId: PortalId;
  portalName: string;
  shortLabel: string;
  domains: string[];
  emailSenderHints: string[];
  supportedLabel: string;
  exportInstructions: string;
  restrictionNote: string;
  capabilities: PortalAdapterCapabilities;
}

export const PORTAL_ADAPTERS: PortalAdapterDefinition[] = [
  {
    portalId: 'linkedin',
    portalName: 'LinkedIn',
    shortLabel: 'in',
    domains: ['linkedin.com'],
    emailSenderHints: ['jobs-noreply@linkedin.com', 'linkedin.com'],
    supportedLabel: 'Gmail Confirmation · Browser Extension · LinkedIn Data Export (CSV)',
    exportInstructions:
      'LinkedIn → Settings & Privacy → Data privacy → Get a copy of your data → Job Applications (job_applications.csv).',
    restrictionNote:
      'LinkedIn does not provide a public personal API for syncing past Easy Apply submissions. Captures work via Gmail confirmation emails, the optional Save to My Job Tracker extension on open job tabs, or official LinkedIn CSV export.',
    capabilities: {
      gmailConfirmation: true,
      chromeExtension: true,
      csvExportImport: true,
      manualQuickSave: true,
      officialPublicApi: false,
    },
  },
  {
    portalId: 'indeed',
    portalName: 'Indeed',
    shortLabel: 'id',
    domains: ['indeed.com', 'in.indeed.com'],
    emailSenderHints: ['indeedapply@indeed.com', 'indeed.com'],
    supportedLabel: 'Gmail Confirmation · Browser Extension · CSV Import',
    exportInstructions:
      'Export or download your Indeed applied-jobs CSV/JSON list or paste job URLs directly.',
    restrictionNote:
      'Indeed does not offer a personal consumer application-history API. Use Gmail confirmation detection for Indeed Apply emails, the Chrome extension on job pages, or CSV import.',
    capabilities: {
      gmailConfirmation: true,
      chromeExtension: true,
      csvExportImport: true,
      manualQuickSave: true,
      officialPublicApi: false,
    },
  },
  {
    portalId: 'naukri',
    portalName: 'Naukri',
    shortLabel: 'nk',
    domains: ['naukri.com'],
    emailSenderHints: ['naukri.com', 'info@naukri.com'],
    supportedLabel: 'Gmail Confirmation · Browser Extension · CSV Import',
    exportInstructions:
      'Upload any exported CSV/spreadsheet of Naukri applications or capture postings as you apply.',
    restrictionNote:
      'Naukri restricts automated scraping and does not expose a personal OAuth application-sync API. Confirmation emails in Gmail, one-click extension capture, and quick manual save keep your tracker complete.',
    capabilities: {
      gmailConfirmation: true,
      chromeExtension: true,
      csvExportImport: true,
      manualQuickSave: true,
      officialPublicApi: false,
    },
  },
  {
    portalId: 'workindia',
    portalName: 'WorkIndia',
    shortLabel: 'wi',
    domains: ['workindia.in'],
    emailSenderHints: ['workindia.in'],
    supportedLabel: 'Gmail Confirmation · Browser Extension · CSV Import · Quick Save',
    exportInstructions:
      'Import a CSV list if exported or use the browser extension / quick-save paste flow after applying.',
    restrictionNote:
      'WorkIndia handles many applications inside its mobile app/portal without public OAuth APIs. Email confirmations (when sent), browser extension capture, and one-paste quick save record submissions safely.',
    capabilities: {
      gmailConfirmation: true,
      chromeExtension: true,
      csvExportImport: true,
      manualQuickSave: true,
      officialPublicApi: false,
    },
  },
  {
    portalId: 'apna',
    portalName: 'Apna',
    shortLabel: 'ap',
    domains: ['apna.co'],
    emailSenderHints: ['apna.co'],
    supportedLabel: 'Gmail Confirmation · Browser Extension · CSV Import · Quick Save',
    exportInstructions:
      'Import a CSV list if exported or capture jobs directly from apna.co with the browser extension.',
    restrictionNote:
      'Apna does not provide an external candidate sync API. Use the Save to My Job Tracker extension on apna.co, Gmail confirmation scanning, or quick paste recording.',
    capabilities: {
      gmailConfirmation: true,
      chromeExtension: true,
      csvImportEnabled: true,
      csvExportImport: true,
      manualQuickSave: true,
      officialPublicApi: false,
    } as PortalAdapterCapabilities,
  },
  {
    portalId: 'company_career',
    portalName: 'Company Career Page',
    shortLabel: 'co',
    domains: [],
    emailSenderHints: [
      'greenhouse.io',
      'lever.co',
      'myworkdayjobs.com',
      'icims.com',
      'smartrecruiters.com',
      'ashbyhq.com',
      'zohorecruit.com',
      'darwinbox.in',
      'bamboohr.com',
      'workable.com',
    ],
    supportedLabel: 'Gmail ATS Confirmation · Browser Extension · CSV Import · Quick Save',
    exportInstructions:
      'Import a CSV of company career-site applications or detect ATS confirmation emails automatically from Gmail.',
    restrictionNote:
      'Company portals (Workday, Greenhouse, Lever, iCIMS, Ashby, Darwinbox) send confirmation emails to your Gmail and can be captured in 1 click via the Chrome extension.',
    capabilities: {
      gmailConfirmation: true,
      chromeExtension: true,
      csvExportImport: true,
      manualQuickSave: true,
      officialPublicApi: false,
    },
  },
];

export function getPortalAdapter(portalId: PortalId): PortalAdapterDefinition {
  return (
    PORTAL_ADAPTERS.find((p) => p.portalId === portalId) || PORTAL_ADAPTERS[PORTAL_ADAPTERS.length - 1]
  );
}

export function normalizePortalSource(rawSource?: string, urlOrDomain?: string): string {
  const combined = `${rawSource || ''} ${urlOrDomain || ''}`.toLowerCase();
  if (combined.includes('linkedin')) return 'LinkedIn';
  if (combined.includes('indeed')) return 'Indeed';
  if (combined.includes('naukri')) return 'Naukri';
  if (combined.includes('workindia')) return 'WorkIndia';
  if (combined.includes('apna')) return 'Apna';
  if (combined.includes('wellfound') || combined.includes('angel.co')) return 'Wellfound';
  if (combined.includes('glassdoor')) return 'Glassdoor';
  if (combined.includes('referral')) return 'Referral';
  if (
    combined.includes('direct email') ||
    combined.includes('gmail') ||
    combined.includes('hr email')
  ) {
    return 'Direct Email (Gmail)';
  }
  if (
    combined.includes('company') ||
    combined.includes('career') ||
    combined.includes('greenhouse') ||
    combined.includes('lever.co') ||
    combined.includes('workday') ||
    combined.includes('icims') ||
    combined.includes('ashby') ||
    combined.includes('smartrecruiters') ||
    combined.includes('darwinbox')
  ) {
    return 'Company Career Page';
  }
  return (rawSource || '').trim() || 'Job Portal';
}

export function mapSourceToPortalId(source: string): PortalId | null {
  const lower = (source || '').toLowerCase();
  if (lower.includes('linkedin')) return 'linkedin';
  if (lower.includes('indeed')) return 'indeed';
  if (lower.includes('naukri')) return 'naukri';
  if (lower.includes('workindia')) return 'workindia';
  if (lower.includes('apna')) return 'apna';
  if (lower.includes('company') || lower.includes('career')) return 'company_career';
  return null;
}

export function doesAppMatchPortal(app: JobApplicationRecord, portalId: PortalId): boolean {
  const normSource = normalizePortalSource(app.applicationSource, app.jobUrl).toLowerCase();
  switch (portalId) {
    case 'linkedin':
      return normSource === 'linkedin';
    case 'indeed':
      return normSource === 'indeed';
    case 'naukri':
      return normSource === 'naukri';
    case 'workindia':
      return normSource === 'workindia';
    case 'apna':
      return normSource === 'apna';
    case 'company_career':
      return normSource === 'company career page';
    default:
      return false;
  }
}

export function normalizeComparableUrl(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const trackingParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'trk',
      'trkInfo',
      'refId',
      'trackingId',
      'fbclid',
      'gclid',
    ];
    for (const p of trackingParams) {
      parsed.searchParams.delete(p);
    }
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    const qs = parsed.searchParams.toString();
    return `${parsed.hostname.replace(/^www\./, '').toLowerCase()}${cleanPath}${qs ? `?${qs}` : ''}`;
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, '');
  }
}

function normalizeComparableText(str: string): string {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  reason: string;
  matchedApplication: JobApplicationRecord | null;
}

export function findDuplicateApplication(
  candidate: {
    userId?: string;
    companyName: string;
    jobTitle: string;
    jobUrl?: string;
    dateApplied?: string;
    gmailConfirmationMessageId?: string;
  },
  existingApplications: JobApplicationRecord[]
): DuplicateCheckResult {
  const targetUrl = normalizeComparableUrl(candidate.jobUrl || '');
  const targetCompany = normalizeComparableText(candidate.companyName);
  const targetTitle = normalizeComparableText(candidate.jobTitle);
  const targetDate = (candidate.dateApplied || '').trim().slice(0, 10);
  const targetMsgId = (candidate.gmailConfirmationMessageId || '').trim();

  for (const app of existingApplications) {
    if (candidate.userId && app.userId !== candidate.userId) continue;

    if (targetMsgId && app.gmailConfirmationMessageId === targetMsgId) {
      return {
        isDuplicate: true,
        reason: 'Same Gmail confirmation message already imported',
        matchedApplication: app,
      };
    }

    const existingUrl = normalizeComparableUrl(app.jobUrl || '');
    if (targetUrl && existingUrl && targetUrl === existingUrl) {
      return {
        isDuplicate: true,
        reason: 'Same job URL already recorded',
        matchedApplication: app,
      };
    }

    const existingCompany = normalizeComparableText(app.companyName);
    const existingTitle = normalizeComparableText(app.jobTitle);
    const existingDate = (app.dateApplied || '').trim().slice(0, 10);

    if (
      targetCompany &&
      targetTitle &&
      existingCompany === targetCompany &&
      existingTitle === targetTitle
    ) {
      if (!targetDate || !existingDate || targetDate === existingDate) {
        return {
          isDuplicate: true,
          reason: `Matching company, role, and date (${existingDate || 'tracked'})`,
          matchedApplication: app,
        };
      }
    }
  }

  return { isDuplicate: false, reason: '', matchedApplication: null };
}

export interface ParsedCsvImportRow {
  rowIndex: number;
  companyName: string;
  jobTitle: string;
  jobLocation: string;
  dateApplied: string;
  jobUrl: string;
  applicationStatus: ApplicationStatus;
  applicationSource: string;
  notes: string;
  isDuplicate: boolean;
  duplicateReason: string;
  selected: boolean;
}

function parseCsvMatrix(csvText: string): string[][] {
  const clean = csvText.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const next = clean[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\r' && next === '\n') {
      row.push(cell.trim());
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      cell = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      row.push(cell.trim());
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    if (row.some((c) => c.length > 0)) rows.push(row);
  }
  return rows;
}

function normalizeImportedDate(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return getTodayIsoDate();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    const y = parsed.getUTCFullYear();
    const m = String(parsed.getUTCMonth() + 1).padStart(2, '0');
    const d = String(parsed.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return getTodayIsoDate();
}

function normalizeImportedStatus(rawStatus: string): ApplicationStatus {
  const lower = (rawStatus || '').trim().toLowerCase();
  if (!lower) return 'Applied – Manually Recorded';
  if (lower.includes('offer')) return 'Offer Received';
  if (lower.includes('reject') || lower.includes('declin') || lower.includes('not selected')) {
    return 'Rejected';
  }
  if (lower.includes('interview')) return 'Interview Scheduled';
  if (lower.includes('hr') || lower.includes('responded') || lower.includes('shortlist')) {
    return 'HR Responded';
  }
  if (lower.includes('confirm')) return 'Applied – Confirmed';
  if (lower.includes('awaiting') || lower.includes('pending')) return 'Awaiting Confirmation';
  if (lower.includes('saved') || lower.includes('bookmark')) return 'Saved';
  if (lower.includes('discover')) return 'Discovered';
  if (lower.includes('follow')) return 'Follow-up Due';
  return 'Applied – Manually Recorded';
}

export function parsePortalExportCsv(params: {
  csvText: string;
  defaultPortalName: string;
  uid: string;
  existingApplications: JobApplicationRecord[];
}): ParsedCsvImportRow[] {
  const matrix = parseCsvMatrix(params.csvText);
  if (matrix.length < 2) return [];

  const headers = matrix[0].map((h) => h.toLowerCase().replace(/[^a-z0-9]+/g, '_'));
  const findCol = (aliases: string[]): number =>
    headers.findIndex((h) => aliases.some((a) => h === a || h.includes(a)));

  const colCompany = findCol(['company_name', 'company', 'employer', 'organization']);
  const colTitle = findCol(['job_title', 'title', 'role', 'position', 'designation']);
  const colLocation = findCol(['job_location', 'location', 'city']);
  const colDate = findCol(['application_date', 'date_applied', 'applied_date', 'applied_on', 'date']);
  const colUrl = findCol(['job_url', 'url', 'link', 'posting_url', 'job_link']);
  const colStatus = findCol(['status', 'application_status', 'stage']);
  const colPortal = findCol(['portal', 'source', 'application_source', 'platform']);
  const colNotes = findCol(['notes', 'note', 'comments', 'question_and_answers', 'description']);

  const parsedRows: ParsedCsvImportRow[] = [];
  const seenKeys = new Set<string>();

  for (let i = 1; i < matrix.length; i++) {
    const r = matrix[i];
    const companyName = (colCompany >= 0 ? r[colCompany] : '') || '';
    const jobTitle = (colTitle >= 0 ? r[colTitle] : '') || '';
    if (!companyName && !jobTitle) continue;

    const finalCompany = companyName || 'Unspecified Company';
    const finalTitle = jobTitle || 'Unspecified Role';
    const jobLocation = (colLocation >= 0 ? r[colLocation] : '') || 'Not specified';
    const dateApplied = normalizeImportedDate(colDate >= 0 ? r[colDate] : '');
    const jobUrl = (colUrl >= 0 ? r[colUrl] : '') || '';
    const rawPortal = (colPortal >= 0 ? r[colPortal] : '') || params.defaultPortalName;
    const applicationSource = normalizePortalSource(rawPortal, jobUrl);
    const applicationStatus = normalizeImportedStatus(colStatus >= 0 ? r[colStatus] : '');
    const notes = (colNotes >= 0 ? r[colNotes] : '') || '';

    const dup = findDuplicateApplication(
      {
        userId: params.uid,
        companyName: finalCompany,
        jobTitle: finalTitle,
        jobUrl,
        dateApplied,
      },
      params.existingApplications
    );

    const rowKey = `${normalizeComparableUrl(jobUrl)}|${normalizeComparableText(finalCompany)}|${normalizeComparableText(finalTitle)}|${dateApplied}`;
    const inFileDup = seenKeys.has(rowKey);
    seenKeys.add(rowKey);

    const isDup = dup.isDuplicate || inFileDup;
    parsedRows.push({
      rowIndex: i,
      companyName: finalCompany.slice(0, 200),
      jobTitle: finalTitle.slice(0, 200),
      jobLocation: jobLocation.slice(0, 200),
      dateApplied,
      jobUrl: jobUrl.slice(0, 2000),
      applicationStatus,
      applicationSource,
      notes: notes.slice(0, 2000),
      isDuplicate: isDup,
      duplicateReason: dup.isDuplicate
        ? dup.reason
        : inFileDup
          ? 'Duplicate row within this CSV file'
          : '',
      selected: !isDup,
    });
  }

  return parsedRows;
}

export function buildDefaultPortalRecord(
  uid: string,
  adapter: PortalAdapterDefinition,
  existing?: PortalConnectionRecord | null
): PortalConnectionRecord {
  if (existing) return existing;
  return {
    id: adapter.portalId,
    userId: uid,
    portalId: adapter.portalId,
    portalName: adapter.portalName,
    status: 'not_connected',
    connectionMethod: 'none',
    gmailDetectionEnabled: false,
    extensionCaptureEnabled: false,
    csvImportEnabled: false,
    lastSyncedAt: '',
    lastSyncSummary: '',
    lastTestedAt: '',
    importedCount: 0,
    extensionVerifiedAt: '',
    gmailVerifiedAt: '',
    lastImportFileName: '',
  };
}
