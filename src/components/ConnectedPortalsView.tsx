import { useMemo, useState } from 'react';
import {
  CheckCircle2,
  AlertCircle,
  Loader2,
  Mail,
  Chrome,
  Upload,
  SlidersHorizontal,
  Unplug,
  Download,
  Copy,
  Check,
  ShieldCheck,
  X,
  RefreshCw,
  FileSpreadsheet,
  ExternalLink,
} from 'lucide-react';
import type {
  EmailConnectionRecord,
  GmailConfirmationRecord,
  JobApplicationRecord,
  ConnectedPortalRecord,
  PortalId,
} from '../types.ts';
import { addCalendarDays, formatReadableDate, getTodayIsoDate } from '../lib/dateUtils.ts';
import {
  PORTAL_ADAPTERS,
  buildDefaultPortalRecord,
  doesAppMatchPortal,
  findDuplicateApplication,
  getPortalAdapter,
  mapSourceToPortalId,
  normalizePortalSource,
  parsePortalExportCsv,
  type ParsedCsvImportRow,
} from '../lib/portalAdapters.ts';
import {
  exportExtensionPairingConfig,
  signInWithGmailReadonly,
} from '../lib/firebase.ts';
import {
  getExtensionDownloadUrl,
  scanGmailConfirmationsApi,
  verifyGmailReadonlyApi,
  type ScannedConfirmationItem,
} from '../lib/apiClient.ts';
import {
  disconnectPortalState,
  importApplicationsWithDedupe,
  saveEmailConnectionState,
  saveGmailConfirmationRecord,
  saveManualApplicationRecord,
  updateGmailConfirmationRecord,
  upsertConnectedPortalState,
} from '../lib/firestoreService.ts';
import { PortalBrandIcon } from './PortalBrandIcon.tsx';

interface ConnectedPortalsViewProps {
  uid: string;
  userEmail: string;
  defaultFollowUpDays: number;
  applications: JobApplicationRecord[];
  connectedPortals: ConnectedPortalRecord[];
  gmailConfirmations: GmailConfirmationRecord[];
  emailConnection: EmailConnectionRecord | null;
  hasGmailSessionToken: boolean;
  onRefreshGmailState: (hasToken: boolean) => void;
  onSelectApplication: (app: JobApplicationRecord) => void;
  onNavigateToApply: () => void;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
}

type ConfigTab = 'gmail' | 'extension' | 'csv';

export function ConnectedPortalsView({
  uid,
  userEmail,
  defaultFollowUpDays,
  applications,
  connectedPortals,
  gmailConfirmations,
  emailConnection,
  hasGmailSessionToken,
  onRefreshGmailState,
  onSelectApplication,
  onNavigateToApply,
  onNotice,
  onError,
}: ConnectedPortalsViewProps) {
  const [scanningAll, setScanningAll] = useState(false);
  const [lastScanReport, setLastScanReport] = useState('');
  const [activePortalId, setActivePortalId] = useState<PortalId | null>(null);
  const [configTab, setConfigTab] = useState<ConfigTab>('gmail');
  const [modalBusy, setModalBusy] = useState(false);
  const [pairingCode, setPairingCode] = useState('');
  const [copiedCode, setCopiedCode] = useState(false);

  // CSV preview state
  const [csvFileName, setCsvFileName] = useState('');
  const [csvRows, setCsvRows] = useState<ParsedCsvImportRow[]>([]);

  // Pending review confirmation inline edits
  const [pendingDrafts, setPendingDrafts] = useState<
    Record<
      string,
      { companyName: string; jobTitle: string; jobLocation: string; applicationSource: string }
    >
  >({});

  const portalMap = useMemo(() => {
    const map = new Map<PortalId, ConnectedPortalRecord>();
    for (const p of connectedPortals) {
      map.set(p.portalId, p);
    }
    return map;
  }, [connectedPortals]);

  const pendingConfirmations = useMemo(
    () =>
      gmailConfirmations.filter(
        (c) => c.isConfirmedApplication && c.reviewStatus === 'pending_review'
      ),
    [gmailConfirmations]
  );

  const importedConfirmationsCount = useMemo(
    () => gmailConfirmations.filter((c) => c.reviewStatus === 'imported').length,
    [gmailConfirmations]
  );

  const ensureReadonlyGmailToken = async (): Promise<boolean> => {
    if (hasGmailSessionToken) return true;
    try {
      const { user, gmailAccessToken } = await signInWithGmailReadonly();
      if (!gmailAccessToken) {
        onError('Read-only Gmail permission was not granted.');
        return false;
      }
      onRefreshGmailState(true);
      await saveEmailConnectionState({
        uid: user.uid,
        connectedEmail: user.email || userEmail,
        status: 'connected',
        replyTrackingEnabled: emailConnection?.replyTrackingEnabled ?? true,
        autoProcessConfirmations: emailConnection?.autoProcessConfirmations ?? false,
        connectedAt: emailConnection?.connectedAt || new Date().toISOString(),
      });
      return true;
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to authorize read-only Gmail access.');
      return false;
    }
  };

  const processScannedConfirmations = async (
    items: ScannedConfirmationItem[],
    portalFilterId?: PortalId
  ) => {
    let importedCount = 0;
    let pendingCount = 0;
    let duplicateCount = 0;
    let ignoredAlerts = 0;
    const workingApps = [...applications];
    const portalsTouched = new Set<PortalId>();
    if (portalFilterId) portalsTouched.add(portalFilterId);

    for (const item of items) {
      if (!item.isConfirmedApplication || item.confidence === 'not_application') {
        ignoredAlerts++;
        await saveGmailConfirmationRecord(uid, {
          gmailMessageId: item.gmailMessageId,
          gmailThreadId: item.gmailThreadId,
          fromEmail: item.fromEmail,
          subject: item.subject,
          snippet: item.snippet,
          receivedAt: item.receivedAt,
          isConfirmedApplication: false,
          confidence: 'not_application',
          companyName: '',
          jobTitle: '',
          jobLocation: '',
          jobUrl: '',
          applicationSource: item.applicationSource || 'Job Portal',
          applicationDate: item.applicationDate,
          confirmationMessage: '',
          recruiterName: '',
          recruiterEmail: '',
          reviewStatus: 'dismissed',
          linkedApplicationId: '',
        });
        continue;
      }

      const normSource = normalizePortalSource(
        item.applicationSource,
        `${item.fromEmail} ${item.jobUrl}`
      );
      const matchedPortal = mapSourceToPortalId(normSource);
      if (matchedPortal) portalsTouched.add(matchedPortal);

      // Duplicate protection against already saved applications
      const dup = findDuplicateApplication(
        {
          userId: uid,
          companyName: item.companyName,
          jobTitle: item.jobTitle,
          jobUrl: item.jobUrl,
          dateApplied: item.applicationDate,
          gmailConfirmationMessageId: item.gmailMessageId,
        },
        workingApps
      );

      if (dup.isDuplicate && dup.matchedApplication) {
        duplicateCount++;
        await saveGmailConfirmationRecord(uid, {
          gmailMessageId: item.gmailMessageId,
          gmailThreadId: item.gmailThreadId,
          fromEmail: item.fromEmail,
          subject: item.subject,
          snippet: item.snippet,
          receivedAt: item.receivedAt,
          isConfirmedApplication: true,
          confidence: item.confidence,
          companyName: item.companyName,
          jobTitle: item.jobTitle,
          jobLocation: item.jobLocation,
          jobUrl: item.jobUrl,
          applicationSource: normSource,
          applicationDate: item.applicationDate,
          confirmationMessage: item.confirmationMessage,
          recruiterName: item.recruiterName,
          recruiterEmail: item.recruiterEmail,
          reviewStatus: 'duplicate_skipped',
          linkedApplicationId: dup.matchedApplication.id,
        });
        continue;
      }

      if (item.confidence === 'high' && item.companyName && item.jobTitle) {
        const applied = item.applicationDate || getTodayIsoDate();
        const followUpDate = addCalendarDays(applied, defaultFollowUpDays);
        const newAppId = await saveManualApplicationRecord({
          uid,
          companyName: item.companyName,
          jobTitle: item.jobTitle,
          jobDescription: `Confirmed application via ${normSource}.\n\nConfirmation email: ${item.subject}\nFrom: ${item.fromEmail}\n\n${item.confirmationMessage || item.snippet}`,
          jobLocation: item.jobLocation || 'Not specified',
          jobUrl: item.jobUrl,
          hrEmail: item.recruiterEmail,
          recruiterName: item.recruiterName,
          applicationSource: normSource,
          captureMethod: 'gmail_confirmation',
          confirmationEvidence: item.confirmationMessage || item.subject,
          needsReview: false,
          gmailConfirmationMessageId: item.gmailMessageId,
          dateApplied: applied,
          followUpDate,
          applicationStatus: 'Applied – Confirmed',
          notes: `Auto-detected from Gmail confirmation (${item.fromEmail}).`,
          aiSummary: `Confirmed submission detected on ${normSource} via Gmail receipt.`,
          keyRequirements: [],
        });

        workingApps.push({
          id: newAppId,
          userId: uid,
          companyName: item.companyName,
          jobTitle: item.jobTitle,
          jobDescription: '',
          jobLocation: item.jobLocation,
          jobUrl: item.jobUrl,
          hrEmail: item.recruiterEmail,
          applicationSource: normSource,
          applicationMethod: 'portal',
          captureMethod: 'gmail_confirmation',
          gmailConfirmationMessageId: item.gmailMessageId,
          dateApplied: applied,
          lastCommunicationDate: applied,
          followUpDate,
          applicationStatus: 'Applied – Confirmed',
          notes: '',
          aiSummary: '',
          keyRequirements: [],
          applicationResumeId: '',
          gmailThreadId: item.gmailThreadId,
        });

        await saveGmailConfirmationRecord(uid, {
          gmailMessageId: item.gmailMessageId,
          gmailThreadId: item.gmailThreadId,
          fromEmail: item.fromEmail,
          subject: item.subject,
          snippet: item.snippet,
          receivedAt: item.receivedAt,
          isConfirmedApplication: true,
          confidence: 'high',
          companyName: item.companyName,
          jobTitle: item.jobTitle,
          jobLocation: item.jobLocation,
          jobUrl: item.jobUrl,
          applicationSource: normSource,
          applicationDate: applied,
          confirmationMessage: item.confirmationMessage,
          recruiterName: item.recruiterName,
          recruiterEmail: item.recruiterEmail,
          reviewStatus: 'imported',
          linkedApplicationId: newAppId,
        });
        importedCount++;
      } else {
        // Incomplete details -> Pending Review queue (never guess missing fields silently)
        pendingCount++;
        await saveGmailConfirmationRecord(uid, {
          gmailMessageId: item.gmailMessageId,
          gmailThreadId: item.gmailThreadId,
          fromEmail: item.fromEmail,
          subject: item.subject,
          snippet: item.snippet,
          receivedAt: item.receivedAt,
          isConfirmedApplication: true,
          confidence: 'incomplete',
          companyName: item.companyName,
          jobTitle: item.jobTitle,
          jobLocation: item.jobLocation,
          jobUrl: item.jobUrl,
          applicationSource: normSource,
          applicationDate: item.applicationDate || getTodayIsoDate(),
          confirmationMessage: item.confirmationMessage || item.subject,
          recruiterName: item.recruiterName,
          recruiterEmail: item.recruiterEmail,
          reviewStatus: 'pending_review',
          linkedApplicationId: '',
        });
      }
    }

    const nowIso = new Date().toISOString();
    for (const pId of portalsTouched) {
      const existing = portalMap.get(pId);
      const countForPortal = workingApps.filter((a) => doesAppMatchPortal(a, pId)).length;
      await upsertConnectedPortalState({
        uid,
        portalId: pId,
        updates: {
          status: 'connected',
          connectionMethod: 'gmail_confirmation',
          gmailDetectionEnabled: true,
          gmailVerifiedAt: existing?.gmailVerifiedAt || nowIso,
          lastTestedAt: nowIso,
          lastSyncedAt: nowIso,
          importedCount: countForPortal,
          lastSyncSummary: `Gmail scan complete: +${importedCount} imported, ${pendingCount} pending review, ${duplicateCount} duplicate(s) skipped.`,
        },
      });
    }

    return { importedCount, pendingCount, duplicateCount, ignoredAlerts };
  };

  const handleGlobalGmailScan = async (portalFilterId?: PortalId) => {
    const ok = await ensureReadonlyGmailToken();
    if (!ok) return;

    const busySetter = portalFilterId ? setModalBusy : setScanningAll;
    busySetter(true);
    try {
      const verification = await verifyGmailReadonlyApi();
      const existingIds = Array.from(
        new Set([
          ...gmailConfirmations.map((c) => c.gmailMessageId),
          ...applications
            .map((a) => a.gmailConfirmationMessageId || '')
            .filter(Boolean),
        ])
      );

      const scanRes = await scanGmailConfirmationsApi({
        portalFilter: portalFilterId,
        existingMessageIds: existingIds,
      });

      const stats = await processScannedConfirmations(scanRes.confirmations, portalFilterId);

      await saveEmailConnectionState({
        uid,
        connectedEmail: verification.emailAddress || userEmail,
        status: 'connected',
        replyTrackingEnabled: emailConnection?.replyTrackingEnabled ?? true,
        autoProcessConfirmations: emailConnection?.autoProcessConfirmations ?? false,
        lastSyncedAt: new Date().toISOString(),
      });

      const summary = `Checked ${scanRes.checkedCount} email(s) (${scanRes.freshCount} new): +${stats.importedCount} confirmed application(s) saved, ${stats.pendingCount} pending review, ${stats.duplicateCount} duplicate(s) skipped, ${stats.ignoredAlerts} job alert(s) ignored.`;
      setLastScanReport(summary);
      onNotice(summary);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to scan Gmail confirmations.');
    } finally {
      busySetter(false);
    }
  };

  const handleToggleAutoProcess = async () => {
    try {
      const nextVal = !(emailConnection?.autoProcessConfirmations ?? false);
      await saveEmailConnectionState({
        uid,
        connectedEmail: emailConnection?.connectedEmail || userEmail,
        status: emailConnection?.status || (hasGmailSessionToken ? 'connected' : 'disconnected'),
        replyTrackingEnabled: emailConnection?.replyTrackingEnabled ?? true,
        autoProcessConfirmations: nextVal,
      });
      onNotice(
        nextVal
          ? 'Automatic confirmation email scanning enabled for connected sessions.'
          : 'Automatic confirmation scanning turned off (manual scan still available).'
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to update setting.');
    }
  };

  const handleApprovePending = async (item: GmailConfirmationRecord) => {
    const draft = pendingDrafts[item.id] || {
      companyName: item.companyName,
      jobTitle: item.jobTitle,
      jobLocation: item.jobLocation,
      applicationSource: item.applicationSource || 'Company Career Page',
    };
    const finalCompany = draft.companyName.trim();
    const finalTitle = draft.jobTitle.trim();
    const finalLocation = draft.jobLocation.trim() || 'Not specified';
    const finalSource = normalizePortalSource(draft.applicationSource, item.jobUrl);

    if (!finalCompany || !finalTitle) {
      onError('Enter both Company Name and Job Title before saving this pending confirmation.');
      return;
    }

    const dup = findDuplicateApplication(
      {
        userId: uid,
        companyName: finalCompany,
        jobTitle: finalTitle,
        jobUrl: item.jobUrl,
        dateApplied: item.applicationDate,
        gmailConfirmationMessageId: item.gmailMessageId,
      },
      applications
    );
    if (dup.isDuplicate && dup.matchedApplication) {
      await updateGmailConfirmationRecord(uid, item.id, {
        reviewStatus: 'duplicate_skipped',
        linkedApplicationId: dup.matchedApplication.id,
      });
      onNotice(
        `Already tracked under ${dup.matchedApplication.companyName} — ${dup.matchedApplication.jobTitle}. Marked as duplicate.`
      );
      return;
    }

    try {
      const applied = item.applicationDate || getTodayIsoDate();
      const followUpDate = addCalendarDays(applied, defaultFollowUpDays);
      const appId = await saveManualApplicationRecord({
        uid,
        companyName: finalCompany,
        jobTitle: finalTitle,
        jobDescription: `Confirmed application via ${finalSource}.\n\nEmail: ${item.subject}\n${item.confirmationMessage || item.snippet}`,
        jobLocation: finalLocation,
        jobUrl: item.jobUrl,
        hrEmail: item.recruiterEmail,
        recruiterName: item.recruiterName,
        applicationSource: finalSource,
        captureMethod: 'gmail_confirmation',
        confirmationEvidence: item.confirmationMessage || item.subject,
        needsReview: false,
        gmailConfirmationMessageId: item.gmailMessageId,
        dateApplied: applied,
        followUpDate,
        applicationStatus: 'Applied – Confirmed',
        notes: `Reviewed & confirmed from Gmail (${item.fromEmail}).`,
        aiSummary: `Confirmed submission on ${finalSource}.`,
        keyRequirements: [],
      });

      await updateGmailConfirmationRecord(uid, item.id, {
        companyName: finalCompany,
        jobTitle: finalTitle,
        jobLocation: finalLocation,
        applicationSource: finalSource,
        reviewStatus: 'imported',
        linkedApplicationId: appId,
      });
      onNotice(`Saved "${finalTitle}" at ${finalCompany} to My Applications.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to confirm application.');
    }
  };

  const handleDismissPending = async (itemId: string) => {
    try {
      await updateGmailConfirmationRecord(uid, itemId, {
        reviewStatus: 'dismissed',
      });
      onNotice('Confirmation dismissed.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to dismiss item.');
    }
  };

  const openPortalConfig = (portalId: PortalId, initialTab: ConfigTab = 'gmail') => {
    setActivePortalId(portalId);
    setConfigTab(initialTab);
    setCsvRows([]);
    setCsvFileName('');
    setCopiedCode(false);
    try {
      setPairingCode(exportExtensionPairingConfig(uid, userEmail, defaultFollowUpDays));
    } catch {
      setPairingCode('');
    }
  };

  const handleDisconnect = async (portalId: PortalId) => {
    try {
      await disconnectPortalState(uid, portalId);
      onNotice(`${getPortalAdapter(portalId).portalName} disconnected.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to disconnect portal.');
    }
  };

  const handleCopyPairingCode = async () => {
    try {
      const code = pairingCode || exportExtensionPairingConfig(uid, userEmail, defaultFollowUpDays);
      setPairingCode(code);
      await navigator.clipboard.writeText(code);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 3000);
      onNotice('Extension Pairing Code copied. Paste it into the Save to My Job Tracker Chrome extension.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not copy pairing code.');
    }
  };

  const handleCsvFileSelected = async (
    e: React.ChangeEvent<HTMLInputElement>,
    portalName: string
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvFileName(file.name);
    const text = await file.text();
    const parsed = parsePortalExportCsv({
      csvText: text,
      defaultPortalName: portalName,
      uid,
      existingApplications: applications,
    });
    if (parsed.length === 0) {
      onError('No valid job application rows found in that CSV. Include Company and Job Title columns.');
      setCsvRows([]);
      return;
    }
    setCsvRows(parsed);
  };

  const handleImportCsvRows = async (portalId: PortalId) => {
    const selectedRows = csvRows.filter((r) => r.selected);
    if (selectedRows.length === 0) {
      onError('Select at least one non-duplicate row to import.');
      return;
    }
    setModalBusy(true);
    try {
      const res = await importApplicationsWithDedupe({
        uid,
        defaultFollowUpDays,
        existingApplications: applications,
        rows: selectedRows,
      });

      const existing = portalMap.get(portalId);
      const isAlreadyAuthorized =
        existing?.status === 'connected' &&
        Boolean(existing.gmailVerifiedAt || existing.extensionVerifiedAt);

      const newCount =
        applications.filter((a) => doesAppMatchPortal(a, portalId)).length + res.imported;

      await upsertConnectedPortalState({
        uid,
        portalId,
        updates: {
          status: isAlreadyAuthorized ? 'connected' : 'imported_only',
          connectionMethod: isAlreadyAuthorized
            ? existing?.connectionMethod || 'gmail_confirmation'
            : 'csv_import',
          csvImportEnabled: true,
          lastSyncedAt: new Date().toISOString(),
          lastImportFileName: csvFileName || 'portal_export.csv',
          importedCount: newCount,
          lastSyncSummary: `One-time CSV import: +${res.imported} imported, ${res.skippedDuplicates} duplicate(s) skipped.`,
        },
      });

      onNotice(
        `CSV import complete: +${res.imported} application(s) imported, ${res.skippedDuplicates} duplicate(s) skipped.`
      );
      setCsvRows([]);
      setCsvFileName('');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to import CSV applications.');
    } finally {
      setModalBusy(false);
    }
  };

  const handleVerifyExtensionCapture = async (portalId: PortalId) => {
    const extCaptured = applications.filter(
      (a) => doesAppMatchPortal(a, portalId) && a.captureMethod === 'chrome_extension'
    );
    const existing = portalMap.get(portalId);
    if (extCaptured.length === 0 && !existing?.extensionVerifiedAt) {
      onError(
        `No extension capture received yet for ${getPortalAdapter(portalId).portalName}. Open a job on ${getPortalAdapter(portalId).portalName} and click "Save to My Job Tracker" (or use the test capture button) to verify.`
      );
      return;
    }

    setModalBusy(true);
    try {
      const nowIso = new Date().toISOString();
      await upsertConnectedPortalState({
        uid,
        portalId,
        updates: {
          status: 'connected',
          connectionMethod: 'chrome_extension',
          extensionCaptureEnabled: true,
          extensionVerifiedAt: existing?.extensionVerifiedAt || nowIso,
          lastTestedAt: nowIso,
          importedCount: applications.filter((a) => doesAppMatchPortal(a, portalId)).length,
          lastSyncSummary: `Chrome Extension verified (${extCaptured.length} capture(s) recorded).`,
        },
      });
      onNotice(`${getPortalAdapter(portalId).portalName} Chrome Extension connection verified.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Verification failed.');
    } finally {
      setModalBusy(false);
    }
  };

  const activeAdapter = activePortalId ? getPortalAdapter(activePortalId) : null;
  const activeRecord = activePortalId
    ? buildDefaultPortalRecord(uid, activeAdapter!, portalMap.get(activePortalId))
    : null;

  return (
    <div className="space-y-6">
      {/* Header & Gmail Application Detection Panel */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4 pb-5 border-b border-slate-200">
          <div className="space-y-1.5 max-w-2xl">
            <h2 className="text-lg font-semibold text-slate-900">Connected Job Portals</h2>
            <p className="text-sm text-slate-600 leading-relaxed">
              Capture job applications across LinkedIn, Indeed, Naukri, WorkIndia, Apna, and company
              career pages using Gmail confirmation scanning, the optional Chrome extension, or
              one-time CSV exports. Portals never show &ldquo;Connected&rdquo; unless a real method is
              authorized and tested.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void handleGlobalGmailScan()}
              disabled={scanningAll}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg disabled:opacity-60 cursor-pointer whitespace-nowrap"
            >
              {scanningAll ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              {scanningAll
                ? 'Scanning Confirmations...'
                : hasGmailSessionToken
                  ? 'Scan Gmail Confirmations'
                  : 'Authorize & Scan Gmail'}
            </button>
            <button
              type="button"
              onClick={onNavigateToApply}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
            >
              Quick-Save Job Posting
            </button>
          </div>
        </div>

        {/* Permission Separation & Privacy Bar */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 space-y-1">
            <div className="flex items-center gap-1.5 font-semibold text-slate-900">
              <Mail className="w-3.5 h-3.5 text-blue-700" />
              <span>Read-Only Confirmation Detection</span>
            </div>
            <p className="text-slate-600 leading-relaxed">
              Uses <span className="font-mono">gmail.readonly</span> solely to detect confirmed
              submission receipts (&ldquo;Thank you for applying&rdquo;, &ldquo;Application
              submitted&rdquo;). Kept separate from sending (<span className="font-mono">gmail.send</span>).
            </p>
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 space-y-1">
            <div className="flex items-center gap-1.5 font-semibold text-slate-900">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-700" />
              <span>Alerts Ignored &amp; No Passwords</span>
            </div>
            <p className="text-slate-600 leading-relaxed">
              Job digests, recommendations, and invitations are skipped. Portal passwords are never
              requested, stored, or automated.
            </p>
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 flex flex-col justify-between gap-2">
            <label className="inline-flex items-start gap-2 font-medium text-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={emailConnection?.autoProcessConfirmations ?? false}
                onChange={() => void handleToggleAutoProcess()}
                className="mt-0.5 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
              />
              <span>Auto-scan high-confidence confirmation emails on sign-in</span>
            </label>
            <p className="text-[11px] text-slate-500 font-mono tabular-nums">
              Confirmed imports saved: {importedConfirmationsCount} · Pending review:{' '}
              {pendingConfirmations.length}
            </p>
          </div>
        </div>

        {lastScanReport && (
          <div className="px-4 py-2.5 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-900">
            {lastScanReport}
          </div>
        )}
      </div>

      {/* Pending Review Queue (incomplete confirmation detections) */}
      {pendingConfirmations.length > 0 && (
        <div className="bg-white border border-amber-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-amber-900">
                Pending Confirmation Review ({pendingConfirmations.length})
              </h3>
              <p className="text-xs text-slate-600 mt-0.5">
                These emails confirmed an application submission, but the company name or job title
                was incomplete. Fill in the missing details to add them cleanly.
              </p>
            </div>
          </div>

          <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg">
            {pendingConfirmations.map((item) => {
              const draft = pendingDrafts[item.id] || {
                companyName: item.companyName,
                jobTitle: item.jobTitle,
                jobLocation: item.jobLocation,
                applicationSource: item.applicationSource || 'Company Career Page',
              };

              const updateDraft = (patch: Partial<typeof draft>) => {
                setPendingDrafts((prev) => ({
                  ...prev,
                  [item.id]: { ...draft, ...patch },
                }));
              };

              return (
                <div key={item.id} className="p-4 space-y-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-slate-900">{item.subject}</span>
                    <span className="font-mono text-slate-500">
                      {item.fromEmail} · {formatReadableDate(item.receivedAt)}
                    </span>
                  </div>
                  <p className="text-slate-600 bg-slate-50 p-2.5 rounded border border-slate-200">
                    {item.confirmationMessage || item.snippet}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
                    <input
                      type="text"
                      value={draft.companyName}
                      onChange={(e) => updateDraft({ companyName: e.target.value })}
                      placeholder="Company Name *"
                      className="px-2.5 py-1.5 border border-slate-300 rounded-md"
                    />
                    <input
                      type="text"
                      value={draft.jobTitle}
                      onChange={(e) => updateDraft({ jobTitle: e.target.value })}
                      placeholder="Job Title *"
                      className="px-2.5 py-1.5 border border-slate-300 rounded-md"
                    />
                    <input
                      type="text"
                      value={draft.jobLocation}
                      onChange={(e) => updateDraft({ jobLocation: e.target.value })}
                      placeholder="City, State"
                      className="px-2.5 py-1.5 border border-slate-300 rounded-md"
                    />
                    <select
                      value={draft.applicationSource}
                      onChange={(e) => updateDraft({ applicationSource: e.target.value })}
                      className="px-2.5 py-1.5 border border-slate-300 rounded-md bg-white"
                    >
                      {PORTAL_ADAPTERS.map((a) => (
                        <option key={a.portalId} value={a.portalName}>
                          {a.portalName}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleApprovePending(item)}
                      className="px-3 py-1.5 bg-blue-700 text-white rounded-md hover:bg-blue-800 font-medium cursor-pointer"
                    >
                      Confirm &amp; Save Application
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDismissPending(item.id)}
                      className="px-3 py-1.5 bg-white border border-slate-300 text-slate-600 rounded-md hover:bg-slate-50 cursor-pointer"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Portal Connection Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {PORTAL_ADAPTERS.map((adapter) => {
          const rec = buildDefaultPortalRecord(uid, adapter, portalMap.get(adapter.portalId));
          const liveApps = applications.filter((a) => doesAppMatchPortal(a, adapter.portalId));
          const isVerifiedConnected =
            rec.status === 'connected' &&
            Boolean(rec.gmailVerifiedAt || rec.extensionVerifiedAt);
          const isImportedOnly = !isVerifiedConnected && rec.status === 'imported_only';

          const methodLabel =
            rec.connectionMethod === 'gmail_confirmation'
              ? 'Gmail Confirmation Detection'
              : rec.connectionMethod === 'chrome_extension'
                ? 'Chrome Browser Extension'
                : rec.connectionMethod === 'csv_import'
                  ? 'One-Time CSV Export Import'
                  : rec.connectionMethod === 'manual_quick_save'
                    ? 'Manual Quick Save'
                    : 'Not configured yet';

          return (
            <div
              key={adapter.portalId}
              className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4"
            >
              <div className="space-y-4">
                {/* Top Card Header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <PortalBrandIcon portalId={adapter.portalId} size={40} />
                    <div className="min-w-0">
                      <h3 className="text-base font-semibold text-slate-900 truncate">
                        {adapter.portalName}
                      </h3>
                      <p className="text-[11px] text-slate-500 truncate">
                        {adapter.supportedLabel}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Status & Telemetry */}
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 space-y-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500">Connection Status</span>
                    {isVerifiedConnected ? (
                      <span className="inline-flex items-center gap-1 font-semibold text-emerald-700">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Connected
                      </span>
                    ) : isImportedOnly ? (
                      <span className="inline-flex items-center gap-1 font-semibold text-blue-700">
                        <FileSpreadsheet className="w-3.5 h-3.5" />
                        One-Time CSV Imported
                      </span>
                    ) : rec.status === 'disconnected' ? (
                      <span className="inline-flex items-center gap-1 font-medium text-slate-600">
                        <AlertCircle className="w-3.5 h-3.5" />
                        Disconnected
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 font-medium text-amber-700">
                        <AlertCircle className="w-3.5 h-3.5" />
                        Not Connected
                      </span>
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500">Active Method</span>
                    <span className="font-medium text-slate-800 text-right">{methodLabel}</span>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500">Last Sync / Import</span>
                    <span className="font-mono tabular-nums text-slate-700">
                      {rec.lastSyncedAt ? formatReadableDate(rec.lastSyncedAt) : 'Never'}
                    </span>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500">Applications Imported</span>
                    <span className="font-mono tabular-nums font-semibold text-slate-900">
                      {liveApps.length}
                    </span>
                  </div>
                </div>

                {rec.lastSyncSummary && (
                  <p className="text-[11px] text-slate-600 leading-relaxed">
                    {rec.lastSyncSummary}
                  </p>
                )}
              </div>

              {/* Card Actions */}
              <div className="pt-2 border-t border-slate-100 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => openPortalConfig(adapter.portalId, 'gmail')}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer whitespace-nowrap"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  {isVerifiedConnected ? 'Configure' : 'Connect / Configure'}
                </button>

                {(isVerifiedConnected || isImportedOnly) && (
                  <button
                    type="button"
                    onClick={() => void handleDisconnect(adapter.portalId)}
                    className="inline-flex items-center gap-1 px-3 py-2 text-xs font-medium text-red-700 bg-white border border-red-200 hover:bg-red-50 rounded-lg cursor-pointer whitespace-nowrap"
                  >
                    <Unplug className="w-3.5 h-3.5" />
                    Disconnect
                  </button>
                )}
              </div>

              {liveApps.length > 0 && (
                <button
                  type="button"
                  onClick={() => onSelectApplication(liveApps[0])}
                  className="text-[11px] text-blue-700 hover:underline text-left truncate cursor-pointer"
                >
                  Latest: {liveApps[0].companyName} — {liveApps[0].jobTitle}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Portal Configuration Modal */}
      {activeAdapter && activeRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden shadow-xl">
            {/* Modal Header */}
            <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-slate-200">
              <div className="flex items-center gap-3 min-w-0">
                <PortalBrandIcon portalId={activeAdapter.portalId} size={36} />
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-slate-900">
                    Configure {activeAdapter.portalName}
                  </h3>
                  <p className="text-xs text-slate-500 truncate">
                    Official honest capture methods — zero password collection or automated scraping
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setActivePortalId(null)}
                className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 cursor-pointer"
                aria-label="Close configuration"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Method Tabs */}
            <div className="px-6 pt-3 border-b border-slate-200 flex gap-2 overflow-x-auto bg-slate-50">
              <button
                type="button"
                onClick={() => setConfigTab('gmail')}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                  configTab === 'gmail'
                    ? 'border-blue-700 text-blue-800 bg-white rounded-t-md'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                <Mail className="w-3.5 h-3.5" />
                1. Gmail Confirmation Sync
              </button>
              <button
                type="button"
                onClick={() => setConfigTab('extension')}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                  configTab === 'extension'
                    ? 'border-blue-700 text-blue-800 bg-white rounded-t-md'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                <Chrome className="w-3.5 h-3.5" />
                2. Browser Extension
              </button>
              <button
                type="button"
                onClick={() => setConfigTab('csv')}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                  configTab === 'csv'
                    ? 'border-blue-700 text-blue-800 bg-white rounded-t-md'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                <Upload className="w-3.5 h-3.5" />
                3. CSV Data Export (One-Time)
              </button>
            </div>

            {/* Tab Content */}
            <div className="p-6 overflow-y-auto space-y-5 text-sm">
              <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700 leading-relaxed">
                {activeAdapter.restrictionNote}
              </div>

              {configTab === 'gmail' && (
                <div className="space-y-4">
                  <div className="space-y-1">
                    <h4 className="font-semibold text-slate-900">
                      Detect {activeAdapter.portalName} Confirmation Emails Automatically
                    </h4>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Authorizes read-only Gmail access (<span className="font-mono">gmail.readonly</span>)
                      to verify inbox connectivity and scan confirmation receipts from{' '}
                      <span className="font-mono">
                        {activeAdapter.emailSenderHints.slice(0, 3).join(', ')}
                      </span>
                      . Job alerts and recommendations are automatically ignored.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div className="p-3 rounded-lg border border-slate-200">
                      <p className="text-slate-500">Verification Status</p>
                      <p className="font-semibold text-slate-900 mt-1">
                        {activeRecord.gmailVerifiedAt
                          ? `Verified (${formatReadableDate(activeRecord.gmailVerifiedAt)})`
                          : 'Not yet tested'}
                      </p>
                    </div>
                    <div className="p-3 rounded-lg border border-slate-200">
                      <p className="text-slate-500">Last Scan Summary</p>
                      <p className="text-slate-800 mt-1">
                        {activeRecord.lastSyncSummary || 'No scan run yet'}
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => void handleGlobalGmailScan(activeAdapter.portalId)}
                    disabled={modalBusy}
                    className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg disabled:opacity-60 cursor-pointer"
                  >
                    {modalBusy ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Mail className="w-4 h-4" />
                    )}
                    {modalBusy
                      ? 'Verifying & Scanning Gmail...'
                      : `Authorize & Test ${activeAdapter.portalName} Gmail Scan`}
                  </button>
                </div>
              )}

              {configTab === 'extension' && (
                <div className="space-y-4">
                  <div className="space-y-1">
                    <h4 className="font-semibold text-slate-900">
                      Save to My Job Tracker — Chrome Extension (Manifest V3)
                    </h4>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Adds a clean <strong>&ldquo;Save to My Job Tracker&rdquo;</strong> button on{' '}
                      {activeAdapter.portalName} and any active company career page. Captures only
                      visible fields after you confirm whether you applied (
                      <em>Applied – Manually Recorded</em>) or saved the listing (<em>Saved</em>).
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5">
                    <a
                      href={getExtensionDownloadUrl()}
                      download="save-to-my-job-tracker-extension.zip"
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg whitespace-nowrap"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download Extension (.zip)
                    </a>

                    <button
                      type="button"
                      onClick={() => void handleCopyPairingCode()}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer whitespace-nowrap"
                    >
                      {copiedCode ? (
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      {copiedCode ? 'Pairing Code Copied' : 'Copy Pairing Code'}
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleVerifyExtensionCapture(activeAdapter.portalId)}
                      disabled={modalBusy}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 rounded-lg cursor-pointer whitespace-nowrap"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Verify Extension Connection
                    </button>
                  </div>

                  <ol className="list-decimal pl-5 text-xs text-slate-600 space-y-1 leading-relaxed">
                    <li>Download and unzip the extension folder above.</li>
                    <li>
                      Open <span className="font-mono">chrome://extensions</span>, enable{' '}
                      <strong>Developer mode</strong>, and click <strong>Load unpacked</strong>.
                    </li>
                    <li>
                      Open the extension popup and paste your Pairing Code (no portal passwords
                      ever collected).
                    </li>
                    <li>
                      Click <strong>Save to My Job Tracker</strong> on a{' '}
                      {activeAdapter.portalName} job page and confirm submission.
                    </li>
                  </ol>
                </div>
              )}

              {configTab === 'csv' && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="font-semibold text-slate-900">
                      One-Time Historical CSV Import (Not Live Sync)
                    </h4>
                    <span className="px-2 py-0.5 text-[11px] font-medium bg-slate-100 text-slate-700 rounded border border-slate-200">
                      One-Time Import
                    </span>
                  </div>

                  <p className="text-xs text-slate-600 leading-relaxed">
                    <strong>How to export:</strong> {activeAdapter.exportInstructions}
                  </p>

                  <div className="flex flex-wrap items-center gap-3">
                    <label className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer">
                      <Upload className="w-3.5 h-3.5" />
                      <span>{csvFileName || 'Choose Export CSV File'}</span>
                      <input
                        type="file"
                        accept=".csv,text/csv"
                        onChange={(e) =>
                          void handleCsvFileSelected(e, activeAdapter.portalName)
                        }
                        className="sr-only"
                      />
                    </label>
                  </div>

                  {csvRows.length > 0 && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-slate-800">
                          Preview ({csvRows.filter((r) => r.selected).length} new selected ·{' '}
                          {csvRows.filter((r) => r.isDuplicate).length} duplicate(s) flagged)
                        </span>
                        <button
                          type="button"
                          onClick={() => void handleImportCsvRows(activeAdapter.portalId)}
                          disabled={modalBusy}
                          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg disabled:opacity-60 cursor-pointer"
                        >
                          {modalBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                          Import Selected Rows
                        </button>
                      </div>

                      <div className="max-h-60 overflow-auto border border-slate-200 rounded-lg">
                        <table className="w-full text-left border-collapse text-xs">
                          <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                            <tr>
                              <th className="py-2 px-3">Import</th>
                              <th className="py-2 px-3">Company</th>
                              <th className="py-2 px-3">Job Title</th>
                              <th className="py-2 px-3">Applied</th>
                              <th className="py-2 px-3">Match</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-200">
                            {csvRows.map((row, idx) => (
                              <tr key={`${row.rowIndex}-${idx}`}>
                                <td className="py-2 px-3">
                                  <input
                                    type="checkbox"
                                    checked={row.selected}
                                    onChange={(e) =>
                                      setCsvRows((prev) =>
                                        prev.map((r, i) =>
                                          i === idx ? { ...r, selected: e.target.checked } : r
                                        )
                                      )
                                    }
                                    className="rounded border-slate-300 text-blue-700"
                                  />
                                </td>
                                <td className="py-2 px-3 font-medium text-slate-900">
                                  {row.companyName}
                                </td>
                                <td className="py-2 px-3 text-slate-700">
                                  <div className="flex items-center gap-1">
                                    <span>{row.jobTitle}</span>
                                    {row.jobUrl && (
                                      <a
                                        href={row.jobUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-blue-600"
                                      >
                                        <ExternalLink className="w-3 h-3" />
                                      </a>
                                    )}
                                  </div>
                                </td>
                                <td className="py-2 px-3 font-mono tabular-nums text-slate-600">
                                  {row.dateApplied}
                                </td>
                                <td className="py-2 px-3">
                                  {row.isDuplicate ? (
                                    <span className="text-amber-700 font-medium">
                                      Duplicate ({row.duplicateReason})
                                    </span>
                                  ) : (
                                    <span className="text-emerald-700 font-medium">New</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
