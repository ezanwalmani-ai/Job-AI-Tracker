import { useEffect, useMemo, useRef, useState } from 'react';
import { User } from 'firebase/auth';
import {
  LayoutDashboard,
  FileText,
  Send,
  Briefcase,
  CalendarClock,
  Settings,
  LogOut,
  Plus,
  Menu,
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Link2,
} from 'lucide-react';
import type {
  ApplicationEmailRecord,
  ApplicationResumeRecord,
  ConnectedPortalRecord,
  EmailConnectionRecord,
  EmailReplyRecord,
  ExtensionCapturePayload,
  FollowUpRecord,
  GmailConfirmationRecord,
  JobApplicationRecord,
  ResumeRecord,
  UserProfile,
} from './types.ts';
import {
  clearGmailAccessToken,
  getGmailAccessToken,
  signInWithGoogle,
  signOutUser,
  subscribeToAuth,
} from './lib/firebase.ts';
import {
  ensureUserProfile,
  saveEmailConnectionState,
  saveGmailConfirmationRecord,
  saveManualApplicationRecord,
  subscribeCollection,
  subscribeUserProfile,
  upsertConnectedPortalState,
} from './lib/firestoreService.ts';
import { scanGmailConfirmationsApi } from './lib/apiClient.ts';
import { addCalendarDays, getTodayIsoDate } from './lib/dateUtils.ts';
import {
  doesAppMatchPortal,
  findDuplicateApplication,
  mapSourceToPortalId,
  normalizePortalSource,
} from './lib/portalAdapters.ts';
import { SignInScreen } from './components/SignInScreen.tsx';
import { DashboardView } from './components/DashboardView.tsx';
import { MyResumeView } from './components/MyResumeView.tsx';
import { ApplyForJobView } from './components/ApplyForJobView.tsx';
import { ConnectedPortalsView } from './components/ConnectedPortalsView.tsx';
import { MyApplicationsView } from './components/MyApplicationsView.tsx';
import { FollowUpsView } from './components/FollowUpsView.tsx';
import { EmailSettingsView } from './components/EmailSettingsView.tsx';
import { ManualApplicationModal } from './components/ManualApplicationModal.tsx';
import { ApplicationDetailModal } from './components/ApplicationDetailModal.tsx';
import { FollowUpModal } from './components/FollowUpModal.tsx';
import { BrandLogo } from './components/BrandLogo.tsx';

export type NavTab =
  | 'dashboard'
  | 'resume'
  | 'apply'
  | 'portals'
  | 'applications'
  | 'followups'
  | 'settings';

const NAV_ITEMS: Array<{ key: NavTab; label: string; icon: typeof LayoutDashboard }> = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'resume', label: 'My Resume', icon: FileText },
  { key: 'apply', label: 'Apply for a Job', icon: Send },
  { key: 'portals', label: 'Connected Portals', icon: Link2 },
  { key: 'applications', label: 'My Applications', icon: Briefcase },
  { key: 'followups', label: 'Follow-ups', icon: CalendarClock },
  { key: 'settings', label: 'Email Settings', icon: Settings },
];

export default function App() {
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [hasGmailToken, setHasGmailToken] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState('');

  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [resumes, setResumes] = useState<ResumeRecord[]>([]);
  const [applications, setApplications] = useState<JobApplicationRecord[]>([]);
  const [appResumes, setAppResumes] = useState<ApplicationResumeRecord[]>([]);
  const [appEmails, setAppEmails] = useState<ApplicationEmailRecord[]>([]);
  const [followUps, setFollowUps] = useState<FollowUpRecord[]>([]);
  const [emailConnections, setEmailConnections] = useState<EmailConnectionRecord[]>([]);
  const [emailReplies, setEmailReplies] = useState<EmailReplyRecord[]>([]);
  const [connectedPortals, setConnectedPortals] = useState<ConnectedPortalRecord[]>([]);
  const [gmailConfirmations, setGmailConfirmations] = useState<GmailConfirmationRecord[]>([]);
  const [applicationsPortalFilter, setApplicationsPortalFilter] = useState('All');
  const [appsSynced, setAppsSynced] = useState(false);
  const [confirmationsSynced, setConfirmationsSynced] = useState(false);
  const autoScanRanRef = useRef(false);

  const [notice, setNotice] = useState('');
  const [errorBanner, setErrorBanner] = useState('');

  const [showManualModal, setShowManualModal] = useState(false);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [followUpApp, setFollowUpApp] = useState<JobApplicationRecord | null>(null);

  useEffect(() => {
    const unsub = subscribeToAuth((currentUser, gmailTokenActive) => {
      setUser(currentUser);
      setHasGmailToken(gmailTokenActive);
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!user) {
      setProfile(null);
      setResumes([]);
      setApplications([]);
      setAppResumes([]);
      setAppEmails([]);
      setFollowUps([]);
      setEmailConnections([]);
      setEmailReplies([]);
      setConnectedPortals([]);
      setGmailConfirmations([]);
      setAppsSynced(false);
      setConfirmationsSynced(false);
      autoScanRanRef.current = false;
      return;
    }

    let cancelled = false;
    void ensureUserProfile(user).catch((err) => {
      if (!cancelled) {
        setErrorBanner(err instanceof Error ? err.message : 'Failed to load profile.');
      }
    });

    const onDbErr = (err: Error) => {
      if (!cancelled) {
        console.error('Firestore listener error:', err);
      }
    };

    const unsubs = [
      subscribeUserProfile(user.uid, (p) => !cancelled && setProfile(p), onDbErr),
      subscribeCollection<ResumeRecord>(user.uid, 'resumes', (d) => !cancelled && setResumes(d), onDbErr),
      subscribeCollection<JobApplicationRecord>(
        user.uid,
        'jobApplications',
        (d) => {
          if (!cancelled) {
            setApplications(d);
            setAppsSynced(true);
          }
        },
        onDbErr
      ),
      subscribeCollection<ApplicationResumeRecord>(
        user.uid,
        'applicationResumes',
        (d) => !cancelled && setAppResumes(d),
        onDbErr
      ),
      subscribeCollection<ApplicationEmailRecord>(
        user.uid,
        'applicationEmails',
        (d) => !cancelled && setAppEmails(d),
        onDbErr
      ),
      subscribeCollection<FollowUpRecord>(
        user.uid,
        'followUpHistory',
        (d) => !cancelled && setFollowUps(d),
        onDbErr
      ),
      subscribeCollection<EmailConnectionRecord>(
        user.uid,
        'emailConnections',
        (d) => !cancelled && setEmailConnections(d),
        onDbErr,
        'updatedAt'
      ),
      subscribeCollection<EmailReplyRecord>(
        user.uid,
        'emailReplies',
        (d) => !cancelled && setEmailReplies(d),
        onDbErr
      ),
      subscribeCollection<ConnectedPortalRecord>(
        user.uid,
        'connectedPortals',
        (d) => !cancelled && setConnectedPortals(d),
        onDbErr,
        'updatedAt'
      ),
      subscribeCollection<GmailConfirmationRecord>(
        user.uid,
        'gmailConfirmations',
        (d) => {
          if (!cancelled) {
            setGmailConfirmations(d);
            setConfirmationsSynced(true);
          }
        },
        onDbErr
      ),
    ];

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [user?.uid]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Handle ?extCapture=<base64url> fallback handoff from the Chrome Extension
  useEffect(() => {
    if (!user || !appsSynced || typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const rawExt = params.get('extCapture');
    if (!rawExt) return;

    const cleanUrl = () => {
      params.delete('extCapture');
      const qs = params.toString();
      window.history.replaceState(
        {},
        '',
        `${window.location.pathname}${qs ? `?${qs}` : ''}`
      );
    };

    try {
      const padded = rawExt.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(padded);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      const payload = JSON.parse(new TextDecoder().decode(bytes)) as ExtensionCapturePayload;
      cleanUrl();

      if (!payload.companyName || !payload.jobTitle) {
        setErrorBanner('Extension capture did not include both Company Name and Job Title.');
        return;
      }

      const normSource = normalizePortalSource(payload.portalName, payload.jobUrl);
      const dup = findDuplicateApplication(
        {
          userId: user.uid,
          companyName: payload.companyName,
          jobTitle: payload.jobTitle,
          jobUrl: payload.jobUrl,
          dateApplied: getTodayIsoDate(),
        },
        applications
      );

      if (dup.isDuplicate) {
        setNotice(`Skipped duplicate extension capture: ${dup.reason}.`);
        setActiveTab('applications');
        return;
      }

      const today = getTodayIsoDate();
      const status = payload.didApply ? 'Applied – Manually Recorded' : 'Saved';
      const followUpDate = addCalendarDays(today, profile?.defaultFollowUpDays ?? 7);

      void saveManualApplicationRecord({
        uid: user.uid,
        companyName: payload.companyName,
        jobTitle: payload.jobTitle,
        jobDescription:
          payload.jobDescription || `${payload.jobTitle} at ${payload.companyName}`,
        jobLocation: payload.jobLocation || 'Not specified',
        jobUrl: payload.jobUrl || '',
        applicationSource: normSource,
        captureMethod: 'chrome_extension',
        confirmationEvidence: payload.didApply
          ? `User confirmed application on ${normSource} via Chrome Extension`
          : `Saved from ${normSource} via Chrome Extension`,
        needsReview: false,
        dateApplied: today,
        followUpDate,
        applicationStatus: status,
        notes: '',
        aiSummary: `Captured from ${normSource} via Chrome Extension (${status}).`,
        keyRequirements: [],
      }).then(async () => {
        const portalId = mapSourceToPortalId(normSource);
        if (portalId) {
          const nowIso = new Date().toISOString();
          await upsertConnectedPortalState({
            uid: user.uid,
            portalId,
            updates: {
              status: 'connected',
              connectionMethod: 'chrome_extension',
              extensionCaptureEnabled: true,
              extensionVerifiedAt: nowIso,
              lastTestedAt: nowIso,
              lastSyncedAt: nowIso,
              lastSyncSummary: `Extension captured "${payload.jobTitle}" at ${payload.companyName} (${status})`,
            },
          });
        }
        setNotice(
          `Saved "${payload.jobTitle}" at ${payload.companyName} (${status}) from ${normSource}.`
        );
        setActiveTab('applications');
      });
    } catch {
      cleanUrl();
      setErrorBanner('Could not decode captured job payload from browser extension.');
    }
  }, [user?.uid, appsSynced]);

  // Optional session auto-scan for job confirmation emails when enabled
  useEffect(() => {
    const conn = emailConnections[0];
    if (
      !user ||
      !appsSynced ||
      !confirmationsSynced ||
      !hasGmailToken ||
      !conn?.autoProcessConfirmations ||
      autoScanRanRef.current
    ) {
      return;
    }

    autoScanRanRef.current = true;
    let cancelled = false;

    void (async () => {
      try {
        const existingIds = Array.from(
          new Set([
            ...gmailConfirmations.map((c) => c.gmailMessageId),
            ...applications.map((a) => a.gmailConfirmationMessageId || '').filter(Boolean),
          ])
        );

        const res = await scanGmailConfirmationsApi({ existingMessageIds: existingIds });
        if (cancelled || res.confirmations.length === 0) return;

        let imported = 0;
        let pending = 0;
        const workingApps = [...applications];
        const followDays = profile?.defaultFollowUpDays ?? 7;
        const nowIso = new Date().toISOString();

        for (const item of res.confirmations) {
          if (!item.isConfirmedApplication || item.confidence === 'not_application') {
            await saveGmailConfirmationRecord(user.uid, {
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
          const dup = findDuplicateApplication(
            {
              userId: user.uid,
              companyName: item.companyName,
              jobTitle: item.jobTitle,
              jobUrl: item.jobUrl,
              dateApplied: item.applicationDate,
              gmailConfirmationMessageId: item.gmailMessageId,
            },
            workingApps
          );

          if (dup.isDuplicate && dup.matchedApplication) {
            await saveGmailConfirmationRecord(user.uid, {
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
            const followUpDate = addCalendarDays(applied, followDays);
            const appId = await saveManualApplicationRecord({
              uid: user.uid,
              companyName: item.companyName,
              jobTitle: item.jobTitle,
              jobDescription: `Confirmed application via ${normSource}.\n\nEmail: ${item.subject}\n${item.confirmationMessage || item.snippet}`,
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
              id: appId,
              userId: user.uid,
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
            await saveGmailConfirmationRecord(user.uid, {
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
              linkedApplicationId: appId,
            });
            const pId = mapSourceToPortalId(normSource);
            if (pId) {
              await upsertConnectedPortalState({
                uid: user.uid,
                portalId: pId,
                updates: {
                  status: 'connected',
                  connectionMethod: 'gmail_confirmation',
                  gmailDetectionEnabled: true,
                  gmailVerifiedAt: nowIso,
                  lastTestedAt: nowIso,
                  lastSyncedAt: nowIso,
                  importedCount: workingApps.filter((a) => doesAppMatchPortal(a, pId)).length,
                  lastSyncSummary: `Auto-detected confirmation: ${item.jobTitle} at ${item.companyName}`,
                },
              });
            }
            imported++;
          } else {
            await saveGmailConfirmationRecord(user.uid, {
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
            pending++;
          }
        }

        if (!cancelled && (imported > 0 || pending > 0)) {
          setNotice(
            `Auto-detected ${imported} confirmed portal application(s)${pending > 0 ? ` and ${pending} item(s) for review in Connected Portals` : ''}.`
          );
        }
      } catch {
        // Silent background check failure — user can still manually trigger scan in Connected Portals
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.uid, appsSynced, confirmationsSynced, hasGmailToken, emailConnections]);

  const handleSignIn = async () => {
    setSigningIn(true);
    setAuthError('');
    try {
      const { user: signedInUser, gmailAccessToken } = await signInWithGoogle(false);
      setUser(signedInUser);
      setHasGmailToken(Boolean(gmailAccessToken));
      await ensureUserProfile(signedInUser);
      if (gmailAccessToken) {
        await saveEmailConnectionState({
          uid: signedInUser.uid,
          connectedEmail: signedInUser.email || '',
          status: 'connected',
          replyTrackingEnabled: true,
          connectedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'Google Sign-In failed. Please try again.'
      );
    } finally {
      setSigningIn(false);
    }
  };

  const handleReconnectGmail = async (): Promise<boolean> => {
    if (!user) return false;
    try {
      const { user: authedUser, gmailAccessToken } = await signInWithGoogle(true);
      const tokenPresent = Boolean(gmailAccessToken || getGmailAccessToken());
      setHasGmailToken(tokenPresent);
      if (tokenPresent) {
        await saveEmailConnectionState({
          uid: authedUser.uid,
          connectedEmail: authedUser.email || user.email || '',
          status: 'connected',
          replyTrackingEnabled: emailConnections[0]?.replyTrackingEnabled ?? true,
          connectedAt: new Date().toISOString(),
        });
        return true;
      }
      setErrorBanner('Gmail permission was not granted. Please approve Gmail access to send emails.');
      return false;
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : 'Failed to authorize Gmail account.'
      );
      return false;
    }
  };

  const handleDisconnectGmail = async () => {
    if (!user) return;
    clearGmailAccessToken();
    setHasGmailToken(false);
    try {
      await saveEmailConnectionState({
        uid: user.uid,
        connectedEmail: emailConnections[0]?.connectedEmail || user.email || '',
        status: 'disconnected',
        replyTrackingEnabled: false,
      });
      setNotice('Gmail account disconnected.');
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to disconnect Gmail.');
    }
  };

  useEffect(() => {
    if (!mobileMenuOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobileMenuOpen(false);
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [mobileMenuOpen]);

  const handleMobileNavigate = (tab: NavTab) => {
    setMobileMenuOpen(false);
    setActiveTab(tab);
  };

  const handleSignOut = async () => {
    setMobileMenuOpen(false);
    await signOutUser();
    setUser(null);
    setHasGmailToken(false);
    setActiveTab('dashboard');
  };

  const activeResume = useMemo(
    () => resumes.find((r) => r.isActive) || resumes[0] || null,
    [resumes]
  );

  const selectedApplication = useMemo(
    () => applications.find((a) => a.id === selectedAppId) || null,
    [applications, selectedAppId]
  );

  const defaultFollowUpDays = profile?.defaultFollowUpDays ?? 7;
  const emailConnection = emailConnections[0] || null;
  const currentTabMeta = NAV_ITEMS.find((n) => n.key === activeTab) || NAV_ITEMS[0];

  if (!authReady) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center gap-4">
        <BrandLogo size={48} />
        <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <Loader2 className="w-4 h-4 animate-spin text-blue-700" />
          <span>My Job Tracker</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <SignInScreen
        onSignIn={handleSignIn}
        isLoading={signingIn}
        errorMessage={authError}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:fixed lg:inset-y-0 bg-white border-r border-slate-200">
        <div className="h-16 px-5 flex items-center gap-2.5 border-b border-slate-200">
          <BrandLogo size={28} />
          <span className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
            My Job Tracker
          </span>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setActiveTab(item.key)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
                  active
                    ? 'bg-blue-50 text-blue-800'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 space-y-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-900 truncate">
              {profile?.displayName || user.displayName || 'Candidate'}
            </p>
            <p className="text-xs text-slate-500 truncate">{user.email}</p>
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div
          id="mobile-nav-drawer"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          className="fixed inset-0 z-50 lg:hidden flex"
        >
          <div
            className="fixed inset-0 bg-slate-900/40 animate-drawer-backdrop-in"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative w-72 max-w-[82vw] bg-white border-r border-slate-200 shadow-xl flex flex-col z-10 animate-drawer-slide-in">
            <div className="h-16 px-5 flex items-center justify-between border-b border-slate-200">
              <div className="flex items-center gap-2.5 min-w-0">
                <BrandLogo size={26} />
                <span className="text-base font-bold text-slate-900 whitespace-nowrap truncate">My Job Tracker</span>
              </div>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="inline-flex items-center justify-center min-w-[40px] min-h-[40px] -mr-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg cursor-pointer transition-colors"
                aria-label="Close navigation"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => handleMobileNavigate(item.key)}
                    className={`w-full flex items-center gap-3 px-3.5 min-h-[44px] py-2.5 text-sm font-medium rounded-lg cursor-pointer transition-colors whitespace-nowrap ${
                      active
                        ? 'bg-blue-50 text-blue-800'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="p-4 border-t border-slate-200 space-y-2.5">
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-900 truncate">
                  {profile?.displayName || user.displayName || 'Candidate'}
                </p>
                <p className="text-xs text-slate-500 truncate">{user.email}</p>
              </div>
              <button
                type="button"
                onClick={handleSignOut}
                className="w-full inline-flex items-center justify-center gap-2 px-3 min-h-[40px] py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign Out
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
        {/* Top Bar */}
        <header className="h-16 bg-white border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between gap-4 sticky top-0 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden inline-flex items-center justify-center min-w-[40px] min-h-[40px] -ml-2 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg cursor-pointer transition-colors"
              aria-label="Open menu"
              aria-expanded={mobileMenuOpen}
              aria-controls="mobile-nav-drawer"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-slate-400 hidden sm:inline">My Job Tracker</span>
              <span className="text-slate-300 hidden sm:inline">/</span>
              <h1 className="font-semibold text-slate-900 truncate">
                {currentTabMeta.label}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {activeTab !== 'apply' ? (
              <button
                type="button"
                onClick={() => setActiveTab('apply')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer whitespace-nowrap shrink-0"
              >
                <Send className="w-3.5 h-3.5" />
                Apply for a Job
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setShowManualModal(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Manual Application
              </button>
            )}
          </div>
        </header>

        {/* Notifications */}
        <main className="flex-1 p-4 sm:p-6 max-w-7xl w-full mx-auto space-y-5">
          {notice && (
            <div className="flex items-center justify-between gap-3 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-800">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{notice}</span>
              </div>
              <button
                type="button"
                onClick={() => setNotice('')}
                className="text-emerald-700 hover:text-emerald-900 cursor-pointer"
                aria-label="Dismiss notification"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {errorBanner && (
            <div className="flex items-center justify-between gap-3 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{errorBanner}</span>
              </div>
              <button
                type="button"
                onClick={() => setErrorBanner('')}
                className="text-red-700 hover:text-red-900 cursor-pointer"
                aria-label="Dismiss error"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {activeTab === 'dashboard' && (
            <DashboardView
              applications={applications}
              activeResume={activeResume}
              emailConnection={emailConnection}
              hasGmailSessionToken={hasGmailToken}
              replies={emailReplies}
              pendingConfirmationsCount={
                gmailConfirmations.filter(
                  (c) => c.isConfirmedApplication && c.reviewStatus === 'pending_review'
                ).length
              }
              onNavigate={setActiveTab}
              onNavigateApplicationsWithPortal={(portalName) => {
                setApplicationsPortalFilter(portalName);
                setActiveTab('applications');
              }}
              onOpenManualModal={() => setShowManualModal(true)}
              onSelectApplication={(app) => setSelectedAppId(app.id)}
              onTriggerFollowUp={(app) => setFollowUpApp(app)}
            />
          )}

          {activeTab === 'resume' && (
            <MyResumeView
              uid={user.uid}
              resumes={resumes}
              onNotice={setNotice}
              onError={setErrorBanner}
            />
          )}

          {activeTab === 'apply' && (
            <ApplyForJobView
              uid={user.uid}
              userEmail={user.email || ''}
              activeResume={activeResume}
              applications={applications}
              defaultFollowUpDays={defaultFollowUpDays}
              emailConnection={emailConnection}
              hasGmailSessionToken={hasGmailToken}
              onReconnectGmail={handleReconnectGmail}
              onGoToResume={() => setActiveTab('resume')}
              onApplicationSent={(msg) => {
                setNotice(msg);
                setActiveTab('applications');
              }}
              onError={setErrorBanner}
            />
          )}

          {activeTab === 'portals' && (
            <ConnectedPortalsView
              uid={user.uid}
              userEmail={user.email || ''}
              defaultFollowUpDays={defaultFollowUpDays}
              applications={applications}
              connectedPortals={connectedPortals}
              gmailConfirmations={gmailConfirmations}
              emailConnection={emailConnection}
              hasGmailSessionToken={hasGmailToken}
              onRefreshGmailState={(hasToken) => setHasGmailToken(hasToken)}
              onSelectApplication={(app) => setSelectedAppId(app.id)}
              onNavigateToApply={() => setActiveTab('apply')}
              onNotice={setNotice}
              onError={setErrorBanner}
            />
          )}

          {activeTab === 'applications' && (
            <MyApplicationsView
              applications={applications}
              portalFilter={applicationsPortalFilter}
              onPortalFilterChange={setApplicationsPortalFilter}
              onOpenManualModal={() => setShowManualModal(true)}
              onSelectApplication={(app) => setSelectedAppId(app.id)}
              onTriggerFollowUp={(app) => setFollowUpApp(app)}
            />
          )}

          {activeTab === 'followups' && (
            <FollowUpsView
              uid={user.uid}
              applications={applications}
              followUps={followUps}
              defaultFollowUpDays={defaultFollowUpDays}
              onTriggerFollowUp={(app) => setFollowUpApp(app)}
              onSelectApplication={(app) => setSelectedAppId(app.id)}
              onNotice={setNotice}
              onError={setErrorBanner}
            />
          )}

          {activeTab === 'settings' && (
            <EmailSettingsView
              uid={user.uid}
              userEmail={user.email || ''}
              defaultFollowUpDays={defaultFollowUpDays}
              emailConnection={emailConnection}
              hasGmailSessionToken={hasGmailToken}
              applications={applications}
              replies={emailReplies}
              onConnectGmail={handleReconnectGmail}
              onDisconnectGmail={handleDisconnectGmail}
              onOpenConnectedPortals={() => setActiveTab('portals')}
              onNotice={setNotice}
              onError={setErrorBanner}
            />
          )}
        </main>
      </div>

      {/* Modals */}
      <ManualApplicationModal
        isOpen={showManualModal}
        uid={user.uid}
        defaultFollowUpDays={defaultFollowUpDays}
        applications={applications}
        onClose={() => setShowManualModal(false)}
        onSaved={(msg) => setNotice(msg)}
      />

      <ApplicationDetailModal
        application={selectedApplication}
        uid={user.uid}
        appResume={
          selectedApplication
            ? appResumes.find((r) => r.id === selectedApplication.applicationResumeId) || null
            : null
        }
        emails={
          selectedApplication
            ? appEmails.filter((e) => e.applicationId === selectedApplication.id)
            : []
        }
        followUps={
          selectedApplication
            ? followUps.filter((f) => f.applicationId === selectedApplication.id)
            : []
        }
        replies={
          selectedApplication
            ? emailReplies.filter((r) => r.applicationId === selectedApplication.id)
            : []
        }
        onClose={() => setSelectedAppId(null)}
        onTriggerFollowUp={(app) => {
          setSelectedAppId(null);
          setFollowUpApp(app);
        }}
        onUpdated={(msg) => setNotice(msg)}
        onError={(msg) => setErrorBanner(msg)}
      />

      <FollowUpModal
        application={followUpApp}
        uid={user.uid}
        candidateName={
          activeResume?.candidateName || profile?.displayName || user.displayName || 'Candidate'
        }
        defaultFollowUpDays={defaultFollowUpDays}
        originalEmail={
          followUpApp
            ? appEmails.find((e) => e.applicationId === followUpApp.id) || null
            : null
        }
        previousFollowUps={
          followUpApp
            ? followUps.filter((f) => f.applicationId === followUpApp.id)
            : []
        }
        hasGmailSessionToken={hasGmailToken}
        onReconnectGmail={handleReconnectGmail}
        onClose={() => setFollowUpApp(null)}
        onSuccess={(msg) => setNotice(msg)}
        onError={(msg) => setErrorBanner(msg)}
      />
    </div>
  );
}
