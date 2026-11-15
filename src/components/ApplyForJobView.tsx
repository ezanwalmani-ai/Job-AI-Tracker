import { useMemo, useState } from 'react';
import {
  FileText,
  Mail,
  Send,
  RefreshCw,
  Eye,
  Download,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Edit3,
  ClipboardPaste,
  Trash2,
  Search,
  ExternalLink,
  Briefcase,
  ChevronDown,
  ChevronUp,
  RotateCcw,
} from 'lucide-react';
import type {
  EmailConnectionRecord,
  EmailPurposeType,
  ExtractedJobDetails,
  JobApplicationRecord,
  PdfValidationReport,
  ResumeRecord,
} from '../types.ts';
import { addCalendarDays, downloadBase64Pdf, getTodayIsoDate } from '../lib/dateUtils.ts';
import {
  findHrContactApi,
  generateApplicationEmailApi,
  parseJobInputApi,
  sendGmailEmailApi,
  tailorResumeApi,
} from '../lib/apiClient.ts';
import {
  loadPdfBase64Chunks,
  saveEmailApplicationRecord,
  saveManualApplicationRecord,
} from '../lib/firestoreService.ts';
import { normalizePortalSource } from '../lib/portalAdapters.ts';
import { PdfCanvasViewer, PdfPreviewModal } from './PdfPreview.tsx';

interface ApplyForJobViewProps {
  uid: string;
  userEmail: string;
  activeResume: ResumeRecord | null;
  applications: JobApplicationRecord[];
  defaultFollowUpDays: number;
  emailConnection: EmailConnectionRecord | null;
  hasGmailSessionToken: boolean;
  onReconnectGmail: () => Promise<boolean>;
  onGoToResume: () => void;
  onApplicationSent: (msg: string) => void;
  onError: (msg: string) => void;
}

interface TailoredPdfCache {
  cacheKey: string;
  originalPdfBase64: string;
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
}

interface EmailDraftState {
  recipientEmail: string;
  emailSubject: string;
  emailBody: string;
}

const EMAIL_PURPOSE_OPTIONS: Array<{ value: EmailPurposeType; label: string }> = [
  { value: 'initial_application', label: 'Initial Job Application' },
  { value: 'response_to_hr_email', label: 'Response to HR Vacancy Email' },
  { value: 'application_unnamed_recruiter', label: 'Application (No Named Recruiter)' },
  { value: 'recruitment_enquiry', label: 'Recruitment Enquiry' },
  { value: 'follow_up', label: 'Follow-up After Applying' },
];

type ProcessingStage =
  | 'idle'
  | 'reading'
  | 'extracting'
  | 'analyzing'
  | 'preparing_resume'
  | 'writing_email'
  | 'verifying_attachment'
  | 'ready';

const STAGE_LABEL: Record<ProcessingStage, string> = {
  idle: '',
  reading: 'Reading job posting...',
  extracting: 'Extracting company and contact details...',
  analyzing: 'Analysing job requirements...',
  preparing_resume: 'Preparing job-specific resume...',
  writing_email: 'Writing application email...',
  verifying_attachment: 'Preparing PDF attachment...',
  ready: 'Application ready to send.',
};

const PORTAL_SOURCES = [
  'LinkedIn',
  'Indeed',
  'Naukri',
  'WorkIndia',
  'Apna',
  'Company Career Page',
  'Wellfound',
  'Glassdoor',
  'Referral',
  'Job Portal',
];

export function ApplyForJobView({
  uid,
  userEmail,
  activeResume,
  applications,
  defaultFollowUpDays,
  emailConnection,
  hasGmailSessionToken,
  onReconnectGmail,
  onGoToResume,
  onApplicationSent,
  onError,
}: ApplyForJobViewProps) {
  // Stage 1: Raw pasted input
  const [rawInput, setRawInput] = useState('');
  const [stage, setStage] = useState<ProcessingStage>('idle');
  const [failedStage, setFailedStage] = useState<'extract' | 'resume' | 'email' | null>(null);
  const [stageError, setStageError] = useState('');

  // Stage 2: Extracted & editable job details
  const [extracted, setExtracted] = useState<ExtractedJobDetails | null>(null);
  const [lastProcessedRaw, setLastProcessedRaw] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [jobLocation, setJobLocation] = useState('');
  const [hrEmail, setHrEmail] = useState('');
  const [recruiterName, setRecruiterName] = useState('');
  const [companyAddress, setCompanyAddress] = useState('');
  const [requiredExperience, setRequiredExperience] = useState('');
  const [salary, setSalary] = useState('');
  const [employmentType, setEmploymentType] = useState('');
  const [jobUrl, setJobUrl] = useState('');
  const [applicationInstructions, setApplicationInstructions] = useState('');
  const [extractedDescription, setExtractedDescription] = useState('');
  const [showFullJd, setShowFullJd] = useState(false);
  const [followUpDays, setFollowUpDays] = useState(defaultFollowUpDays);

  // Optional web search contact lookup
  const [searchingHr, setSearchingHr] = useState(false);
  const [hrLookupSource, setHrLookupSource] = useState<{
    message: string;
    sourceTitle: string;
    sourceUrl: string;
  } | null>(null);

  // Stage 3 & 5: Cached job-specific PDF & verification
  const [pdfData, setPdfData] = useState<TailoredPdfCache | null>(null);
  const [resumeCompareView, setResumeCompareView] = useState<'updated' | 'original'>('updated');
  const [showAttachmentModal, setShowAttachmentModal] = useState(false);

  // Stage 4 & 6: AI email draft
  const [emailType, setEmailType] = useState<EmailPurposeType>('initial_application');
  const [emailDraft, setEmailDraft] = useState<EmailDraftState | null>(null);
  const [isEditingEmail, setIsEditingEmail] = useState(true);
  const [regeneratingEmail, setRegeneratingEmail] = useState(false);

  // Stage 7 & 8: Sending & duplicate protection
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [showSendConfirm, setShowSendConfirm] = useState(false);
  const [confirmDuplicateOverride, setConfirmDuplicateOverride] = useState(false);

  // Fork flow mode ('email' = Tailor Resume + Send Gmail; 'portal' = Record Job Portal Application)
  const [applicationBranch, setApplicationBranch] = useState<'email' | 'portal'>('email');
  const [portalDateApplied, setPortalDateApplied] = useState(getTodayIsoDate());
  const [portalSource, setPortalSource] = useState('LinkedIn');
  const [portalNotes, setPortalNotes] = useState('');
  const [portalBusy, setPortalBusy] = useState(false);

  const duplicateMatch = useMemo(() => {
    const c = companyName.trim().toLowerCase();
    const t = jobTitle.trim().toLowerCase();
    if (!c || !t) return null;
    return (
      applications.find(
        (app) =>
          app.companyName.trim().toLowerCase() === c &&
          app.jobTitle.trim().toLowerCase() === t
      ) || null
    );
  }, [applications, companyName, jobTitle]);

  if (!activeResume) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
        <FileText className="w-10 h-10 text-slate-400 mx-auto mb-3" />
        <h2 className="text-lg font-semibold text-slate-900">Upload your Master Resume first</h2>
        <p className="text-sm text-slate-600 mt-1 max-w-md mx-auto">
          Your active master resume PDF is used automatically for every application so you never
          have to upload it again.
        </p>
        <button
          type="button"
          onClick={onGoToResume}
          className="mt-5 px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer"
        >
          Go to My Resume
        </button>
      </div>
    );
  }

  const isBusy =
    stage === 'reading' ||
    stage === 'extracting' ||
    stage === 'analyzing' ||
    stage === 'preparing_resume' ||
    stage === 'writing_email' ||
    stage === 'verifying_attachment';

  const applyParsedResult = (parsed: ExtractedJobDetails, rawSource: string) => {
    setExtracted(parsed);
    setLastProcessedRaw(rawSource);
    setCompanyName(parsed.companyName);
    setJobTitle(parsed.jobTitle);
    setJobLocation(parsed.jobLocation);
    setHrEmail(parsed.hrEmail);
    setRecruiterName(parsed.recruiterName);
    setCompanyAddress(parsed.companyAddress);
    setRequiredExperience(parsed.requiredExperience);
    setSalary(parsed.salary);
    setEmploymentType(parsed.employmentType);
    setJobUrl(parsed.jobUrl);
    setApplicationInstructions(parsed.applicationInstructions);
    setExtractedDescription(parsed.extractedDescription || rawSource);
    setHrLookupSource(null);
    setSendError('');
    setConfirmDuplicateOverride(false);
    const detectedSource = normalizePortalSource(parsed.applicationSource, parsed.jobUrl);
    setPortalSource(PORTAL_SOURCES.includes(detectedSource) ? detectedSource : 'LinkedIn');

    // Auto-detect appropriate email purpose type from parsed content
    const looksLikeHrEmail =
      parsed.applicationSource === 'HR Email' ||
      /^(from:|subject:|dear\s|hi\s|hello\s)/im.test(rawSource.slice(0, 300));
    const detectedType: EmailPurposeType = looksLikeHrEmail
      ? 'response_to_hr_email'
      : !parsed.recruiterName.trim()
        ? 'application_unnamed_recruiter'
        : 'initial_application';
    setEmailType(detectedType);

    setEmailDraft((prev) =>
      prev ? { ...prev, recipientEmail: parsed.hrEmail || prev.recipientEmail } : null
    );
  };

  // Stage 1: Extract job details from pasted text
  const runExtractStage = async (textToProcess: string): Promise<ExtractedJobDetails | null> => {
    const clean = textToProcess.trim();
    if (clean.length < 15) {
      onError('Please paste the complete job posting, recruitment email, or job description.');
      return null;
    }

    setFailedStage(null);
    setStageError('');
    setStage('reading');
    const t1 = window.setTimeout(() => {
      setStage((cur) => (cur === 'reading' ? 'extracting' : cur));
    }, 350);
    const t2 = window.setTimeout(() => {
      setStage((cur) => (cur === 'extracting' ? 'analyzing' : cur));
    }, 1100);

    try {
      const parsed = await parseJobInputApi(clean);
      applyParsedResult(parsed, clean);
      setStage('idle');
      return parsed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to extract job details.';
      setFailedStage('extract');
      setStageError(msg);
      setStage('idle');
      onError(msg);
      return null;
    } finally {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    }
  };

  const handlePasteFromClipboard = async () => {
    let textToParse = '';
    try {
      if (!navigator.clipboard?.readText) {
        throw new Error('Clipboard unavailable');
      }
      const clip = (await navigator.clipboard.readText()).trim();
      if (!clip) {
        if (rawInput.trim().length >= 15) {
          textToParse = rawInput.trim();
        } else {
          onError('Your clipboard is empty. Copy a job posting first, then click Paste from Clipboard.');
          return;
        }
      } else {
        setRawInput(clip);
        textToParse = clip;
      }
    } catch {
      if (rawInput.trim().length >= 15) {
        textToParse = rawInput.trim();
      } else {
        onError(
          'Clipboard access was blocked by the browser. Allow clipboard access or paste directly into the text box below.'
        );
        return;
      }
    }

    await runExtractStage(textToParse);
  };

  const handleClearInput = () => {
    setRawInput('');
    setExtracted(null);
    setLastProcessedRaw('');
    setCompanyName('');
    setJobTitle('');
    setJobLocation('');
    setHrEmail('');
    setRecruiterName('');
    setCompanyAddress('');
    setRequiredExperience('');
    setSalary('');
    setEmploymentType('');
    setJobUrl('');
    setApplicationInstructions('');
    setExtractedDescription('');
    setHrLookupSource(null);
    setPdfData(null);
    setEmailDraft(null);
    setFailedStage(null);
    setStageError('');
    setSendError('');
    setConfirmDuplicateOverride(false);
    setEmailType('initial_application');
    setPortalDateApplied(getTodayIsoDate());
    setPortalSource('LinkedIn');
    setPortalNotes('');
    setStage('idle');
  };

  const handleFindHrContact = async () => {
    if (!companyName.trim()) {
      onError('Enter the company name first so we can search for its official HR contact.');
      return;
    }
    setSearchingHr(true);
    setHrLookupSource(null);
    try {
      const res = await findHrContactApi({
        companyName: companyName.trim(),
        jobLocation: jobLocation.trim(),
        jobUrl: jobUrl.trim(),
      });
      setHrLookupSource({
        message: res.message,
        sourceTitle: res.sourceTitle,
        sourceUrl: res.sourceUrl,
      });
      if (res.hrEmail) {
        setHrEmail(res.hrEmail);
        setEmailDraft((prev) => (prev ? { ...prev, recipientEmail: res.hrEmail } : prev));
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to search for official HR contact.');
    } finally {
      setSearchingHr(false);
    }
  };

  // Stages 3, 4, 5: Tailored Resume PDF (cached), AI Email, Attachment Validation
  const runGenerateStages = async (options?: { startAt?: 'resume' | 'email' }) => {
    const cleanRaw = rawInput.trim();
    if (!extracted || lastProcessedRaw !== cleanRaw) {
      const parsed = await runExtractStage(cleanRaw);
      if (!parsed) return;
    }

    const cName = companyName.trim();
    const jTitle = jobTitle.trim();
    const jLoc = jobLocation.trim();
    const jdText = (extractedDescription || cleanRaw).trim();

    if (!cName) {
      onError('Please enter or confirm the Company Name before generating your application.');
      return;
    }
    if (!jTitle) {
      onError('Please enter or confirm the Job Title before generating your application.');
      return;
    }
    if (!jLoc) {
      onError(
        'Target job location could not be extracted. Please enter the Job Location before modifying your resume location.'
      );
      return;
    }

    setFailedStage(null);
    setStageError('');
    setSendError('');

    const targetCacheKey = `${activeResume.id}::${cName}::${jTitle}::${jLoc}`;
    let activePdf = pdfData;

    // Stage 3: Generate Job-Specific Resume PDF (only if not cached or location/company/title/master changed)
    if (options?.startAt !== 'email' && (!activePdf || activePdf.cacheKey !== targetCacheKey)) {
      setStage('preparing_resume');
      try {
        const originalPdfBase64 =
          activePdf?.originalPdfBase64 ||
          (await loadPdfBase64Chunks(uid, 'resumes', activeResume.id));
        if (!originalPdfBase64) {
          throw new Error('Could not retrieve your stored master resume PDF.');
        }

        const tailored = await tailorResumeApi({
          originalPdfBase64,
          extractedText: activeResume.extractedText,
          originalLocation: activeResume.originalLocation,
          locationBox: {
            hasLocationBox: activeResume.hasLocationBox,
            locPage: activeResume.locPage,
            locX: activeResume.locX,
            locY: activeResume.locY,
            locW: activeResume.locW,
            locH: activeResume.locH,
            locFontSize: activeResume.locFontSize,
          },
          jobLocation: jLoc,
          companyName: cName,
          jobTitle: jTitle,
          jobDescription: jdText,
          candidateName: activeResume.candidateName || 'Candidate',
          cachedJdSummary: extracted?.aiSummary || undefined,
          cachedKeyRequirements: extracted?.keyRequirements || undefined,
        });

        activePdf = {
          cacheKey: targetCacheKey,
          originalPdfBase64,
          tailoredPdfBase64: tailored.tailoredPdfBase64,
          tailoredFileName: tailored.tailoredFileName,
          originalLocationText: tailored.originalLocationText,
          updatedLocationText: tailored.updatedLocationText,
          normalizedLocation: tailored.normalizedLocation,
          pdfByteLength: tailored.pdfByteLength,
          validated: tailored.validated,
          validationReport: tailored.validationReport,
          jdSummary: tailored.jdSummary,
          keyRequirements: tailored.keyRequirements,
        };
        setPdfData(activePdf);
        if (tailored.normalizedLocation) {
          setJobLocation(tailored.normalizedLocation);
        }
        setResumeCompareView('updated');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to prepare job-specific resume PDF.';
        setFailedStage('resume');
        setStageError(msg);
        setStage('idle');
        onError(msg);
        return;
      }
    }

    // Stage 4: Generate AI Application Email
    setStage('writing_email');
    try {
      const email = await generateApplicationEmailApi({
        extractedText: activeResume.extractedText,
        candidateName: activeResume.candidateName,
        candidateEmail: activeResume.candidateEmail || userEmail,
        candidatePhone: activeResume.candidatePhone,
        companyName: cName,
        jobTitle: jTitle,
        jobLocation: activePdf?.normalizedLocation || jLoc,
        jobDescription: jdText,
        recruiterName: recruiterName.trim() || undefined,
        requiredExperience: requiredExperience.trim() || undefined,
        requiredSkills: extracted?.requiredSkills,
        responsibilities: extracted?.responsibilities,
        applicationInstructions: applicationInstructions.trim() || undefined,
        emailType,
      });

      // Stage 5: Verify PDF Attachment
      setStage('verifying_attachment');
      if (
        !activePdf ||
        !activePdf.tailoredPdfBase64 ||
        activePdf.tailoredPdfBase64.length < 100 ||
        !activePdf.tailoredFileName
      ) {
        throw new Error('Generated PDF attachment could not be verified. Please regenerate the resume.');
      }

      setEmailDraft({
        recipientEmail: hrEmail.trim(),
        emailSubject: email.subject,
        emailBody: email.body,
      });
      setIsEditingEmail(true);
      setStage('ready');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to generate application email.';
      setFailedStage('email');
      setStageError(msg);
      setStage('idle');
      onError(msg);
    }
  };

  const handleRegenerateEmail = async (overrideType?: EmailPurposeType) => {
    if (!pdfData) return;
    const activeType = overrideType ?? emailType;
    setRegeneratingEmail(true);
    setSendError('');
    try {
      const email = await generateApplicationEmailApi({
        extractedText: activeResume.extractedText,
        candidateName: activeResume.candidateName,
        candidateEmail: activeResume.candidateEmail || userEmail,
        candidatePhone: activeResume.candidatePhone,
        companyName: companyName.trim(),
        jobTitle: jobTitle.trim(),
        jobLocation: pdfData.normalizedLocation || jobLocation.trim(),
        jobDescription: (extractedDescription || rawInput).trim(),
        recruiterName: recruiterName.trim() || undefined,
        requiredExperience: requiredExperience.trim() || undefined,
        requiredSkills: extracted?.requiredSkills,
        responsibilities: extracted?.responsibilities,
        applicationInstructions: applicationInstructions.trim() || undefined,
        emailType: activeType,
      });
      setEmailDraft((prev) => ({
        recipientEmail: prev?.recipientEmail ?? hrEmail.trim(),
        emailSubject: email.subject,
        emailBody: email.body,
      }));
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to regenerate application email.');
    } finally {
      setRegeneratingEmail(false);
    }
  };

  const attachmentVerified = Boolean(
    pdfData &&
      pdfData.validated &&
      pdfData.tailoredPdfBase64.length > 100 &&
      pdfData.tailoredFileName.endsWith('.pdf')
  );

  const handleRequestSend = async () => {
    if (!emailDraft || !attachmentVerified) {
      onError('The generated PDF attachment must be verified before sending.');
      return;
    }
    if (!emailDraft.recipientEmail.trim()) {
      onError('Recipient email not found. Please enter the HR email address before sending.');
      return;
    }
    if (!emailDraft.emailSubject.trim() || !emailDraft.emailBody.trim()) {
      onError('Email subject and body cannot be empty.');
      return;
    }
    if (duplicateMatch && !confirmDuplicateOverride) {
      onError(
        `You already applied for ${duplicateMatch.jobTitle} at ${duplicateMatch.companyName} on ${duplicateMatch.dateApplied}. Confirm the duplicate warning checkbox if you intend to send again.`
      );
      return;
    }

    if (!hasGmailSessionToken) {
      const ok = await onReconnectGmail();
      if (!ok) return;
    }

    setSendError('');
    setShowSendConfirm(true);
  };

  const handleConfirmSend = async () => {
    if (!emailDraft || !pdfData) return;
    setSending(true);
    setSendError('');
    try {
      const gmailRes = await sendGmailEmailApi({
        toEmail: emailDraft.recipientEmail.trim(),
        subject: emailDraft.emailSubject.trim(),
        body: emailDraft.emailBody,
        attachmentFileName: pdfData.tailoredFileName,
        attachmentBase64: pdfData.tailoredPdfBase64,
      });

      const dateApplied = getTodayIsoDate();
      const followUpDate = addCalendarDays(dateApplied, followUpDays);

      await saveEmailApplicationRecord({
        uid,
        companyName: companyName.trim(),
        jobTitle: jobTitle.trim(),
        jobDescription: (extractedDescription || rawInput).trim(),
        jobLocation: jobLocation.trim(),
        jobUrl: jobUrl.trim(),
        hrEmail: emailDraft.recipientEmail.trim(),
        recruiterName: recruiterName.trim(),
        companyAddress: companyAddress.trim(),
        salary: salary.trim(),
        employmentType: employmentType.trim(),
        requiredExperience: requiredExperience.trim(),
        applicationInstructions: applicationInstructions.trim(),
        applicationSource: 'Direct Email (Gmail)',
        dateApplied,
        followUpDate,
        aiSummary: pdfData.jdSummary || extracted?.aiSummary || '',
        keyRequirements: pdfData.keyRequirements.length
          ? pdfData.keyRequirements
          : extracted?.keyRequirements || [],
        masterResumeId: activeResume.id,
        tailoredFileName: pdfData.tailoredFileName,
        originalLocation: pdfData.originalLocationText,
        updatedLocationLabel: pdfData.updatedLocationText,
        tailoredPdfBase64: pdfData.tailoredPdfBase64,
        emailSubject: emailDraft.emailSubject.trim(),
        emailBody: emailDraft.emailBody,
        gmailMessageId: gmailRes.gmailMessageId,
        gmailThreadId: gmailRes.gmailThreadId,
        sentAt: gmailRes.sentAt,
      });

      const sentRecipient = emailDraft.recipientEmail.trim();
      setShowSendConfirm(false);
      handleClearInput();
      onApplicationSent(
        `Application sent to ${sentRecipient} and recorded in My Applications (Gmail ID: ${gmailRes.gmailMessageId}).`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to send application email.';
      setShowSendConfirm(false);
      setSendError(msg);
      onError(msg);
    } finally {
      setSending(false);
    }
  };

  // Fork Flow: switch to Portal branch and auto-extract pasted text if not yet processed
  const handleSelectForkBranch = async (branch: 'email' | 'portal') => {
    setApplicationBranch(branch);
    if (branch === 'portal') {
      setPortalDateApplied((prev) => prev || getTodayIsoDate());
      const cleanRaw = rawInput.trim();
      if (cleanRaw.length >= 15 && (!extracted || lastProcessedRaw !== cleanRaw)) {
        await runExtractStage(cleanRaw);
      }
    }
  };

  const handleSavePortalApplication = async () => {
    const cleanRaw = rawInput.trim();
    if (!extracted || lastProcessedRaw !== cleanRaw) {
      if (cleanRaw.length >= 15) {
        const parsed = await runExtractStage(cleanRaw);
        if (!parsed) return;
      }
    }

    if (!companyName.trim() || !jobTitle.trim() || !jobLocation.trim()) {
      onError('Please confirm Company Name, Job Title, and Job Location before saving.');
      return;
    }
    if (duplicateMatch && !confirmDuplicateOverride) {
      onError(
        `An application for ${duplicateMatch.jobTitle} at ${duplicateMatch.companyName} was already recorded on ${duplicateMatch.dateApplied}. Confirm the duplicate checkbox if you still want to add it.`
      );
      return;
    }

    setPortalBusy(true);
    try {
      const applied = portalDateApplied || getTodayIsoDate();
      const followUpDate = addCalendarDays(applied, followUpDays);
      const normSource = normalizePortalSource(portalSource, jobUrl.trim());
      await saveManualApplicationRecord({
        uid,
        companyName: companyName.trim(),
        jobTitle: jobTitle.trim(),
        jobDescription:
          (extractedDescription || rawInput).trim() ||
          `${jobTitle.trim()} at ${companyName.trim()} (${jobLocation.trim()})`,
        jobLocation: jobLocation.trim(),
        jobUrl: jobUrl.trim(),
        hrEmail: hrEmail.trim(),
        recruiterName: recruiterName.trim(),
        companyAddress: companyAddress.trim(),
        salary: salary.trim(),
        employmentType: employmentType.trim(),
        requiredExperience: requiredExperience.trim(),
        applicationInstructions: applicationInstructions.trim(),
        applicationSource: normSource,
        captureMethod: 'manual_portal',
        confirmationEvidence: `User confirmed submission on ${normSource} on ${applied}`,
        needsReview: false,
        dateApplied: applied,
        followUpDate,
        applicationStatus: 'Applied – Manually Recorded',
        notes: portalNotes.trim(),
        aiSummary: extracted?.aiSummary || '',
        keyRequirements: extracted?.keyRequirements || [],
      });

      const savedLabel = `${jobTitle.trim()} at ${companyName.trim()}`;
      setApplicationBranch('email');
      handleClearInput();
      onApplicationSent(`Portal application for ${savedLabel} saved to My Applications.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to save portal application.');
    } finally {
      setPortalBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Gmail & Master Resume Status Strip */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <div className="text-xs text-slate-600 space-y-0.5">
          <p>
            Active Master Resume:{' '}
            <span className="font-semibold text-slate-900">{activeResume.fileName}</span>{' '}
            <span className="font-mono text-slate-500">(v{activeResume.version})</span>
          </p>
          <p>
            Original Location:{' '}
            <span className="font-mono text-slate-800">
              {activeResume.originalLocation || 'Not listed on master resume'}
            </span>{' '}
            · Date Applied auto-set:{' '}
            <span className="font-mono tabular-nums text-slate-800">{getTodayIsoDate()}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {hasGmailSessionToken ? (
            <div className="flex items-center gap-2 text-xs text-emerald-700 font-medium">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>Gmail Connected ({emailConnection?.connectedEmail || userEmail})</span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2.5 text-xs">
              <span className="text-amber-800">
                Connect your Gmail account to send job applications directly from this website.
              </span>
              <button
                type="button"
                onClick={() => void onReconnectGmail()}
                className="px-3 py-1.5 font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer whitespace-nowrap shrink-0"
              >
                Connect Gmail
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Stage 1: Intelligent Input Area */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 pb-3 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Apply for a Job – Let AI Prepare Your Application
            </h2>
            <p className="text-xs text-slate-600 mt-1 max-w-3xl leading-relaxed">
              Paste the complete job posting, recruitment email or job description below. AI will
              extract the company, job title, location and details once — then fork between{' '}
              <span className="font-medium text-slate-800">Applying via Email</span> or{' '}
              <span className="font-medium text-slate-800">Recording a Job Portal Application</span>.
            </p>
          </div>
          <div className="inline-flex border border-slate-300 rounded-lg overflow-hidden bg-slate-50 shrink-0 self-start">
            <button
              type="button"
              onClick={() => void handleSelectForkBranch('email')}
              disabled={isBusy || portalBusy}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium cursor-pointer whitespace-nowrap ${
                applicationBranch === 'email'
                  ? 'bg-blue-700 text-white'
                  : 'text-slate-700 hover:bg-white'
              }`}
            >
              <Mail className="w-3.5 h-3.5" />
              Apply via Email
            </button>
            <button
              type="button"
              onClick={() => void handleSelectForkBranch('portal')}
              disabled={isBusy || portalBusy}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium cursor-pointer whitespace-nowrap border-l border-slate-300 ${
                applicationBranch === 'portal'
                  ? 'bg-blue-700 text-white'
                  : 'text-slate-700 hover:bg-white'
              }`}
            >
              <Briefcase className="w-3.5 h-3.5" />
              I Applied Through a Job Portal
            </button>
          </div>
        </div>

        <div>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
            <label
              htmlFor="apply-job-posting-input"
              className="block text-xs font-semibold text-slate-800"
            >
              Paste Job Posting or Recruitment Email
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handlePasteFromClipboard}
                disabled={isBusy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg disabled:opacity-60 cursor-pointer whitespace-nowrap shrink-0"
              >
                <ClipboardPaste className="w-3.5 h-3.5" />
                Paste from Clipboard
              </button>
              <button
                type="button"
                onClick={handleClearInput}
                disabled={isBusy || (!rawInput && !extracted && !emailDraft)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-300 rounded-lg disabled:opacity-40 cursor-pointer whitespace-nowrap shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear Input
              </button>
            </div>
          </div>

          <textarea
            id="apply-job-posting-input"
            rows={9}
            value={rawInput}
            onChange={(e) => setRawInput(e.target.value)}
            placeholder="Paste the complete job advertisement, LinkedIn job description, HR recruitment email or company vacancy details here..."
            className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 leading-relaxed"
          />
        </div>

        {/* Staged Progress Bar / Error Retry Banner */}
        {(isBusy || stage === 'ready') && (
          <div className="px-4 py-3 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 text-slate-800 font-medium">
              {isBusy ? (
                <Loader2 className="w-4 h-4 animate-spin text-blue-700 shrink-0" />
              ) : (
                <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
              )}
              <span>{STAGE_LABEL[stage]}</span>
            </div>
            <span className="font-mono text-[11px] text-slate-500">
              {stage === 'reading' || stage === 'extracting' || stage === 'analyzing'
                ? 'Stage 1 of 3'
                : stage === 'preparing_resume'
                  ? 'Stage 2 of 3'
                  : stage === 'writing_email' || stage === 'verifying_attachment'
                    ? 'Stage 3 of 3'
                    : 'Ready'}
            </span>
          </div>
        )}

        {failedStage && stageError && (
          <div className="px-4 py-3 rounded-lg bg-red-50 border border-red-200 flex flex-wrap items-center justify-between gap-3 text-xs text-red-800">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{stageError}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                if (failedStage === 'extract') {
                  void runExtractStage(rawInput);
                } else {
                  void runGenerateStages({ startAt: failedStage });
                }
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1 bg-white border border-red-300 rounded-md font-medium text-red-900 hover:bg-red-100 cursor-pointer whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Retry Failed Stage
            </button>
          </div>
        )}

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-1">
          <p className="text-xs text-slate-500">
            {applicationBranch === 'portal'
              ? 'Step 1 (Job Portal Mode): Extract all details automatically from your pasted posting — no email or modified PDF needed.'
              : 'Step 1: Process the pasted posting to review extracted details, then either send via email or record as a job portal application.'}
          </p>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {applicationBranch === 'email' && (
              <button
                type="button"
                onClick={() => void handleSelectForkBranch('portal')}
                disabled={isBusy || rawInput.trim().length < 15}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-xs font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
              >
                <Briefcase className="w-3.5 h-3.5" />
                Extract &amp; Record Portal App
              </button>
            )}
            <button
              type="button"
              onClick={() => void runExtractStage(rawInput)}
              disabled={isBusy || rawInput.trim().length < 15}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg disabled:opacity-60 cursor-pointer whitespace-nowrap shrink-0"
            >
              {stage === 'reading' || stage === 'extracting' || stage === 'analyzing' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : null}
              {applicationBranch === 'portal' ? 'Extract Portal Job Details' : 'Process Job Details'}
            </button>
          </div>
        </div>
      </div>

      {/* Stage 2: Editable Extracted Job Details Preview */}
      {extracted && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-3 border-b border-slate-200">
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Extracted Job Details Preview
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Source detected: <span className="font-medium text-slate-700">{extracted.applicationSource}</span> ·
                Review or edit any field below before generating your tailored resume &amp; email.
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-600">
              <label htmlFor="apply-followup-days" className="whitespace-nowrap">
                Follow-up interval (days):
              </label>
              <input
                id="apply-followup-days"
                type="number"
                min={1}
                max={60}
                value={followUpDays}
                onChange={(e) =>
                  setFollowUpDays(Math.min(60, Math.max(1, Number(e.target.value) || 7)))
                }
                className="w-16 px-2 py-1 text-xs font-mono border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>
          </div>

          {duplicateMatch && (
            <div className="p-3.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-2">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">
                    Possible duplicate application detected
                  </p>
                  <p className="mt-0.5">
                    You already recorded an application for{' '}
                    <span className="font-medium">{duplicateMatch.jobTitle}</span> at{' '}
                    <span className="font-medium">{duplicateMatch.companyName}</span> on{' '}
                    <span className="font-mono">{duplicateMatch.dateApplied}</span> (Status:{' '}
                    {duplicateMatch.applicationStatus}).
                  </p>
                </div>
              </div>
              <label className="inline-flex items-center gap-2 cursor-pointer font-medium">
                <input
                  type="checkbox"
                  checked={confirmDuplicateOverride}
                  onChange={(e) => setConfirmDuplicateOverride(e.target.checked)}
                  className="rounded border-amber-400"
                />
                I understand and want to prepare/send another application for this role.
              </label>
            </div>
          )}

          {/* Core Editable Fields */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Company Name *
              </label>
              <input
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="Enter company name"
                className={`w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 ${
                  !companyName.trim()
                    ? 'border-amber-400 bg-amber-50/40'
                    : 'border-slate-300 bg-white'
                }`}
              />
              {!companyName.trim() && (
                <p className="text-[11px] text-amber-700 mt-1">
                  Company name could not be extracted — please enter it.
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Job Title *
              </label>
              <input
                type="text"
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
                placeholder="Enter job title"
                className={`w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 ${
                  !jobTitle.trim()
                    ? 'border-amber-400 bg-amber-50/40'
                    : 'border-slate-300 bg-white'
                }`}
              />
              {!jobTitle.trim() && (
                <p className="text-[11px] text-amber-700 mt-1">
                  Job title could not be extracted — please enter it.
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Target Job Location *
              </label>
              <input
                type="text"
                value={jobLocation}
                onChange={(e) => setJobLocation(e.target.value)}
                placeholder="e.g. Baner, Pune, Maharashtra"
                className={`w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 ${
                  !jobLocation.trim()
                    ? 'border-amber-400 bg-amber-50/40'
                    : 'border-slate-300 bg-white'
                }`}
              />
              {!jobLocation.trim() && (
                <p className="text-[11px] text-amber-700 mt-1">
                  Location not found — please enter the target location before modifying your resume.
                </p>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-slate-700">
                  HR / Recipient Email
                </label>
                {applicationBranch === 'email' && !hrEmail.trim() && (
                  <span className="text-[11px] font-medium text-amber-700">
                    Recipient email not found
                  </span>
                )}
              </div>
              <div className="flex gap-1.5">
                <input
                  type="email"
                  value={hrEmail}
                  onChange={(e) => {
                    const val = e.target.value;
                    setHrEmail(val);
                    setEmailDraft((prev) => (prev ? { ...prev, recipientEmail: val } : prev));
                  }}
                  placeholder={
                    applicationBranch === 'portal' ? 'Optional' : 'Enter HR email address'
                  }
                  className={`flex-1 min-w-0 px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 ${
                    applicationBranch === 'email' && !hrEmail.trim()
                      ? 'border-amber-400 bg-amber-50/40'
                      : 'border-slate-300 bg-white'
                  }`}
                />
                {!hrEmail.trim() && companyName.trim() && (
                  <button
                    type="button"
                    onClick={handleFindHrContact}
                    disabled={searchingHr}
                    title="Search official web sources for company recruitment email"
                    className="inline-flex items-center gap-1 px-2.5 py-2 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg disabled:opacity-60 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    {searchingHr ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Search className="w-3.5 h-3.5" />
                    )}
                    Find Contact
                  </button>
                )}
              </div>
              {hrLookupSource && (
                <p className="text-[11px] text-slate-600 mt-1">
                  {hrLookupSource.message}{' '}
                  {hrLookupSource.sourceUrl && (
                    <a
                      href={hrLookupSource.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-0.5 text-blue-700 hover:underline"
                    >
                      Source: {hrLookupSource.sourceTitle || hrLookupSource.sourceUrl}
                      <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  )}
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Recruiter Name
              </label>
              <input
                type="text"
                value={recruiterName}
                onChange={(e) => setRecruiterName(e.target.value)}
                placeholder="Optional if stated"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Required Experience
              </label>
              <input
                type="text"
                value={requiredExperience}
                onChange={(e) => setRequiredExperience(e.target.value)}
                placeholder="Not specified"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Company Address
              </label>
              <input
                type="text"
                value={companyAddress}
                onChange={(e) => setCompanyAddress(e.target.value)}
                placeholder="Not specified"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Salary / Employment Type
              </label>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  value={salary}
                  onChange={(e) => setSalary(e.target.value)}
                  placeholder="Salary"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                <input
                  type="text"
                  value={employmentType}
                  onChange={(e) => setEmploymentType(e.target.value)}
                  placeholder="Type"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Job Application URL
              </label>
              <input
                type="url"
                value={jobUrl}
                onChange={(e) => setJobUrl(e.target.value)}
                placeholder="Not specified"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>

            {applicationBranch === 'email' && (
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Email Purpose / Type
                </label>
                <select
                  value={emailType}
                  onChange={(e) => setEmailType(e.target.value as EmailPurposeType)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {EMAIL_PURPOSE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {applicationInstructions && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-700">
              <span className="font-semibold text-slate-900">Application Instructions: </span>
              {applicationInstructions}
            </div>
          )}

          {/* Extracted Summary, Skills, Responsibilities & Complete JD Toggle */}
          <div className="border-t border-slate-200 pt-3 space-y-3">
            <button
              type="button"
              onClick={() => setShowFullJd((prev) => !prev)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 hover:text-slate-900 cursor-pointer"
            >
              {showFullJd ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
              {showFullJd
                ? 'Hide complete extracted description & requirements'
                : 'View complete extracted description, skills & responsibilities'}
            </button>

            {showFullJd && (
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-3 text-xs text-slate-700">
                {extracted.aiSummary && (
                  <p className="text-slate-800 leading-relaxed">{extracted.aiSummary}</p>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {extracted.responsibilities.length > 0 && (
                    <div>
                      <p className="font-semibold text-slate-900 mb-1">Responsibilities</p>
                      <ul className="list-disc pl-4 space-y-0.5">
                        {extracted.responsibilities.map((item, i) => (
                          <li key={i}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {(extracted.requiredSkills.length > 0 ||
                    extracted.preferredQualifications.length > 0) && (
                    <div className="space-y-2">
                      {extracted.requiredSkills.length > 0 && (
                        <div>
                          <p className="font-semibold text-slate-900 mb-1">Required Skills</p>
                          <p>{extracted.requiredSkills.join(', ')}</p>
                        </div>
                      )}
                      {extracted.preferredQualifications.length > 0 && (
                        <div>
                          <p className="font-semibold text-slate-900 mb-1">
                            Preferred Qualifications
                          </p>
                          <ul className="list-disc pl-4 space-y-0.5">
                            {extracted.preferredQualifications.map((q, i) => (
                              <li key={i}>{q}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div>
                  <label className="block font-semibold text-slate-900 mb-1">
                    Complete Extracted Job Description
                  </label>
                  <textarea
                    rows={6}
                    value={extractedDescription}
                    onChange={(e) => setExtractedDescription(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 leading-relaxed"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Fork Flow Selection inside Extracted Preview */}
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-slate-900">Choose Next Step (Fork Flow)</p>
              <p className="text-[11px] text-slate-600 mt-0.5">
                {applicationBranch === 'portal'
                  ? 'Recording a job already submitted on a portal — saves directly to My Applications without generating an email or modified PDF.'
                  : 'Preparing a tailored resume PDF and AI email to send directly through your connected Gmail account.'}
              </p>
            </div>
            <div className="inline-flex border border-slate-300 rounded-lg overflow-hidden bg-white shrink-0">
              <button
                type="button"
                onClick={() => setApplicationBranch('email')}
                disabled={isBusy || portalBusy}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium cursor-pointer whitespace-nowrap ${
                  applicationBranch === 'email'
                    ? 'bg-blue-700 text-white'
                    : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                <Mail className="w-3.5 h-3.5" />
                Apply via Email
              </button>
              <button
                type="button"
                onClick={() => setApplicationBranch('portal')}
                disabled={isBusy || portalBusy}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium cursor-pointer whitespace-nowrap border-l border-slate-300 ${
                  applicationBranch === 'portal'
                    ? 'bg-blue-700 text-white'
                    : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                <Briefcase className="w-3.5 h-3.5" />
                I Applied Through a Job Portal
              </button>
            </div>
          </div>

          {applicationBranch === 'portal' && (
            <div className="bg-blue-50/50 border border-blue-200 rounded-lg p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Portal Used *
                </label>
                <select
                  value={portalSource}
                  onChange={(e) => setPortalSource(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {PORTAL_SOURCES.map((src) => (
                    <option key={src} value={src}>
                      {src}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Date Applied *
                </label>
                <input
                  type="date"
                  value={portalDateApplied}
                  onChange={(e) => setPortalDateApplied(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Portal Notes (optional)
                </label>
                <input
                  type="text"
                  value={portalNotes}
                  onChange={(e) => setPortalNotes(e.target.value)}
                  placeholder="Submission confirmation or referral note"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>
          )}

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2 border-t border-slate-200">
            {applicationBranch === 'portal' ? (
              <>
                <p className="text-xs text-slate-500">
                  Follow-up reminder auto-scheduled for{' '}
                  <span className="font-mono tabular-nums text-slate-700">
                    {addCalendarDays(portalDateApplied || getTodayIsoDate(), followUpDays)}
                  </span>{' '}
                  · No email or modified PDF generated.
                </p>
                <button
                  type="button"
                  onClick={() => void handleSavePortalApplication()}
                  disabled={portalBusy || isBusy}
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg disabled:opacity-60 cursor-pointer whitespace-nowrap shrink-0"
                >
                  {portalBusy ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Briefcase className="w-4 h-4" />
                  )}
                  {portalBusy ? 'Saving...' : 'Save Portal Application'}
                </button>
              </>
            ) : (
              <>
                <p className="text-xs text-slate-500">
                  Only the designated preferred job location line is updated on your resume PDF copy;
                  your master resume and work history stay completely unchanged.
                </p>
                <button
                  type="button"
                  onClick={() => void runGenerateStages()}
                  disabled={isBusy}
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg disabled:opacity-60 cursor-pointer whitespace-nowrap shrink-0"
                >
                  {(stage === 'preparing_resume' ||
                    stage === 'writing_email' ||
                    stage === 'verifying_attachment') && (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  )}
                  Generate Application
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Stage 6: Complete Application Preview (Tailored Resume + AI Email + Send) */}
      {(pdfData || emailDraft) && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
          {/* Left: Original vs Updated Resume Comparison & Verification */}
          {pdfData && (
            <div className="xl:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-slate-900">
                    Job-Specific Resume
                  </h3>
                  <p className="text-xs text-slate-600 font-mono mt-0.5 truncate">
                    {pdfData.tailoredFileName}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    downloadBase64Pdf(pdfData.tailoredPdfBase64, pdfData.tailoredFileName)
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download PDF
                </button>
              </div>

              {/* Location diff & attachment verification */}
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 text-xs space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    PDF verified &amp; ready ({Math.max(1, Math.round(pdfData.pdfByteLength / 1024))} KB)
                  </span>
                  <div className="inline-flex border border-slate-300 rounded-md overflow-hidden bg-white">
                    <button
                      type="button"
                      onClick={() => setResumeCompareView('updated')}
                      className={`px-2 py-0.5 text-[11px] font-medium cursor-pointer ${
                        resumeCompareView === 'updated'
                          ? 'bg-blue-700 text-white'
                          : 'text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      Updated
                    </button>
                    <button
                      type="button"
                      onClick={() => setResumeCompareView('original')}
                      className={`px-2 py-0.5 text-[11px] font-medium cursor-pointer ${
                        resumeCompareView === 'original'
                          ? 'bg-blue-700 text-white'
                          : 'text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      Original
                    </button>
                  </div>
                </div>
                <p className="text-slate-600">
                  Original Location:{' '}
                  <span className="font-mono text-slate-800">{pdfData.originalLocationText}</span>
                </p>
                <p className="text-slate-900 font-medium">
                  Resume Location Label:{' '}
                  <span className="font-mono">{pdfData.updatedLocationText}</span>
                </p>
                {pdfData.validationReport && (
                  <div className="pt-1.5 border-t border-slate-200 grid grid-cols-1 gap-1 text-[11px]">
                    <span
                      className={
                        pdfData.validationReport.locationDisplayed
                          ? 'text-emerald-700'
                          : 'text-amber-700'
                      }
                    >
                      {pdfData.validationReport.locationDisplayed ? '✓' : '!'} Preferred location
                      ({pdfData.validationReport.normalizedLocation}) verified in PDF
                    </span>
                    <span
                      className={
                        pdfData.validationReport.contactFieldsPreserved
                          ? 'text-emerald-700'
                          : 'text-red-700'
                      }
                    >
                      {pdfData.validationReport.contactFieldsPreserved ? '✓' : '✕'} Phone, email &amp;
                      LinkedIn preserved intact
                    </span>
                    <span
                      className={
                        pdfData.validationReport.noOverlapDetected
                          ? 'text-emerald-700'
                          : 'text-red-700'
                      }
                    >
                      {pdfData.validationReport.noOverlapDetected ? '✓' : '✕'} Zero contact overlap
                      detected ({pdfData.validationReport.placementMode.replace('_', ' ')})
                    </span>
                  </div>
                )}
              </div>

              <PdfCanvasViewer
                base64Data={
                  resumeCompareView === 'updated'
                    ? pdfData.tailoredPdfBase64
                    : pdfData.originalPdfBase64
                }
                maxHeightClass="max-h-[480px]"
              />
            </div>
          )}

          {/* Right: AI Email Preview & Send */}
          {emailDraft && (
            <div className="xl:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-4 flex flex-col">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-200">
                <div>
                  <h3 className="text-base font-semibold text-slate-900">
                    Application Email Preview
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {companyName} · {jobTitle} · {jobLocation}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label="Email Type"
                    value={emailType}
                    disabled={regeneratingEmail || sending}
                    onChange={(e) => {
                      const nextType = e.target.value as EmailPurposeType;
                      setEmailType(nextType);
                      void handleRegenerateEmail(nextType);
                    }}
                    className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 cursor-pointer"
                  >
                    {EMAIL_PURPOSE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => void handleRegenerateEmail()}
                    disabled={regeneratingEmail || sending}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                  >
                    {regeneratingEmail ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" />
                    )}
                    Regenerate Email
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsEditingEmail((prev) => !prev)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    {isEditingEmail ? 'Preview Mode' : 'Edit Email'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowAttachmentModal(true)}
                    disabled={!pdfData}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    Preview Resume
                  </button>
                </div>
              </div>

              <div className="space-y-3 flex-1">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-medium text-slate-700">To *</label>
                    {!emailDraft.recipientEmail.trim() && (
                      <span className="text-[11px] font-medium text-amber-700">
                        Recipient email not found — enter manually to enable sending
                      </span>
                    )}
                  </div>
                  <input
                    type="email"
                    value={emailDraft.recipientEmail}
                    onChange={(e) => {
                      const val = e.target.value;
                      setEmailDraft({ ...emailDraft, recipientEmail: val });
                      setHrEmail(val);
                    }}
                    placeholder="Enter HR or recruiter email address"
                    disabled={!isEditingEmail}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 disabled:bg-slate-50"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Subject *
                  </label>
                  <input
                    type="text"
                    value={emailDraft.emailSubject}
                    onChange={(e) =>
                      setEmailDraft({ ...emailDraft, emailSubject: e.target.value })
                    }
                    disabled={!isEditingEmail}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 disabled:bg-slate-50"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Email Body *
                  </label>
                  {isEditingEmail ? (
                    <textarea
                      rows={13}
                      value={emailDraft.emailBody}
                      onChange={(e) =>
                        setEmailDraft({ ...emailDraft, emailBody: e.target.value })
                      }
                      className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 leading-relaxed"
                    />
                  ) : (
                    <div className="border border-slate-200 rounded-lg p-4 bg-slate-50 text-sm text-slate-800 whitespace-pre-wrap leading-relaxed min-h-[260px]">
                      {emailDraft.emailBody}
                    </div>
                  )}
                </div>

                {pdfData && (
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <Mail className="w-4 h-4 text-emerald-700 shrink-0" />
                        <span className="text-slate-600 shrink-0">Verified Attachment:</span>
                        <span className="font-mono font-medium text-slate-900 truncate">
                          {pdfData.tailoredFileName}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowAttachmentModal(true)}
                        className="text-blue-700 hover:underline font-medium shrink-0 cursor-pointer ml-2"
                      >
                        Inspect PDF
                      </button>
                    </div>

                    {/* Pre-Send Quality Checklist */}
                    <div className="pt-2 border-t border-slate-200 grid grid-cols-1 sm:grid-cols-2 gap-1 text-[11px]">
                      <span
                        className={
                          emailDraft.emailSubject
                            .toLowerCase()
                            .includes(jobTitle.trim().toLowerCase())
                            ? 'text-emerald-700'
                            : 'text-amber-700'
                        }
                      >
                        {emailDraft.emailSubject
                          .toLowerCase()
                          .includes(jobTitle.trim().toLowerCase())
                          ? '✓'
                          : '!'}{' '}
                        Exact job title in subject
                      </span>
                      <span className={companyName.trim() ? 'text-emerald-700' : 'text-amber-700'}>
                        {companyName.trim() ? '✓' : '!'} Company name verified ({companyName.trim() || 'missing'})
                      </span>
                      <span className={attachmentVerified ? 'text-emerald-700' : 'text-red-700'}>
                        {attachmentVerified ? '✓' : '✕'} PDF layout &amp; contact check passed
                      </span>
                      <span
                        className={
                          emailDraft.emailBody.trim().length > 40 ? 'text-emerald-700' : 'text-amber-700'
                        }
                      >
                        {emailDraft.emailBody.trim().length > 40 ? '✓' : '!'} Grounded email body ready
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {sendError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold">Email not sent</p>
                    <p className="mt-0.5">{sendError} — Your draft and resume are preserved; you can retry below.</p>
                  </div>
                </div>
              )}

              {!hasGmailSessionToken && (
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 flex flex-wrap items-center justify-between gap-3 text-xs text-amber-900">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>
                      Connect your Gmail account to send job applications directly from this website.
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void onReconnectGmail()}
                    className="px-3 py-1.5 bg-white border border-amber-300 rounded-md font-medium text-amber-900 hover:bg-amber-100 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    Connect Gmail
                  </button>
                </div>
              )}

              <div className="pt-3 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-slate-500">
                  Follow-up auto-scheduled:{' '}
                  <span className="font-mono tabular-nums text-slate-700">
                    {addCalendarDays(getTodayIsoDate(), followUpDays)}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={handleRequestSend}
                  disabled={
                    sending ||
                    !attachmentVerified ||
                    !emailDraft.recipientEmail.trim() ||
                    !emailDraft.emailSubject.trim() ||
                    !emailDraft.emailBody.trim()
                  }
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg disabled:opacity-50 cursor-pointer whitespace-nowrap"
                >
                  <Send className="w-4 h-4" />
                  Send Application
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Stage 7: Explicit Send Confirmation Modal */}
      {showSendConfirm && emailDraft && pdfData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 shadow-xl space-y-4">
            <h3 className="text-base font-semibold text-slate-900">
              Confirm Sending Job Application
            </h3>
            <p className="text-sm text-slate-600">
              This will send the email from your connected Gmail account with your job-specific
              resume attached and record the application in My Applications.
            </p>
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 text-xs space-y-1.5">
              <p>
                <span className="text-slate-500">From:</span>{' '}
                <span className="font-medium text-slate-900">
                  {emailConnection?.connectedEmail || userEmail}
                </span>
              </p>
              <p>
                <span className="text-slate-500">To:</span>{' '}
                <span className="font-medium text-slate-900">{emailDraft.recipientEmail}</span>
              </p>
              <p>
                <span className="text-slate-500">Subject:</span>{' '}
                <span className="font-medium text-slate-900">{emailDraft.emailSubject}</span>
              </p>
              <p>
                <span className="text-slate-500">Attachment:</span>{' '}
                <span className="font-mono text-slate-900">{pdfData.tailoredFileName}</span>
              </p>
              <p>
                <span className="text-slate-500">Follow-up Date:</span>{' '}
                <span className="font-mono text-slate-900">
                  {addCalendarDays(getTodayIsoDate(), followUpDays)}
                </span>
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowSendConfirm(false)}
                disabled={sending}
                className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmSend}
                disabled={sending}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg disabled:opacity-60 cursor-pointer whitespace-nowrap"
              >
                {sending && <Loader2 className="w-4 h-4 animate-spin" />}
                {sending ? 'Sending...' : 'Confirm & Send Application'}
              </button>
            </div>
          </div>
        </div>
      )}


      {pdfData && (
        <PdfPreviewModal
          isOpen={showAttachmentModal}
          title={pdfData.tailoredFileName}
          fileName={pdfData.tailoredFileName}
          base64Data={pdfData.tailoredPdfBase64}
          subtitle={`Original: ${pdfData.originalLocationText} → Updated: ${pdfData.updatedLocationText}`}
          onClose={() => setShowAttachmentModal(false)}
        />
      )}
    </div>
  );
}
