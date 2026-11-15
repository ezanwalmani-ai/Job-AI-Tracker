import { useEffect, useMemo, useState } from 'react';
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
} from 'lucide-react';
import type {
  ApplicationEmailRecord,
  ApplicationResumeRecord,
  EmailConnectionRecord,
  EmailReplyRecord,
  FollowUpRecord,
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
  subscribeCollection,
  subscribeUserProfile,
} from './lib/firestoreService.ts';
import { SignInScreen } from './components/SignInScreen.tsx';
import { DashboardView } from './components/DashboardView.tsx';
import { MyResumeView } from './components/MyResumeView.tsx';
import { ApplyForJobView } from './components/ApplyForJobView.tsx';
import { MyApplicationsView } from './components/MyApplicationsView.tsx';
import { FollowUpsView } from './components/FollowUpsView.tsx';
import { EmailSettingsView } from './components/EmailSettingsView.tsx';
import { ManualApplicationModal } from './components/ManualApplicationModal.tsx';
import { ApplicationDetailModal } from './components/ApplicationDetailModal.tsx';
import { FollowUpModal } from './components/FollowUpModal.tsx';

type NavTab =
  | 'dashboard'
  | 'resume'
  | 'apply'
  | 'applications'
  | 'followups'
  | 'settings';

const NAV_ITEMS: Array<{ key: NavTab; label: string; icon: typeof LayoutDashboard }> = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'resume', label: 'My Resume', icon: FileText },
  { key: 'apply', label: 'Apply for a Job', icon: Send },
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
        (d) => !cancelled && setApplications(d),
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

  const handleSignOut = async () => {
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
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="flex items-center gap-2.5 text-sm text-slate-600">
          <Loader2 className="w-5 h-5 animate-spin text-blue-700" />
          <span>Loading workspace...</span>
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
        <div className="h-16 px-5 flex items-center border-b border-slate-200">
          <span className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap">
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
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative w-64 max-w-[80vw] bg-white border-r border-slate-200 flex flex-col z-10">
            <div className="h-16 px-5 flex items-center justify-between border-b border-slate-200">
              <span className="text-base font-bold text-slate-900">My Job Tracker</span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg"
                aria-label="Close navigation"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="flex-1 px-3 py-4 space-y-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.key);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg cursor-pointer ${
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
            <div className="p-4 border-t border-slate-200 space-y-2">
              <p className="text-xs text-slate-600 truncate">{user.email}</p>
              <button
                type="button"
                onClick={handleSignOut}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg"
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
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900 rounded-lg"
              aria-label="Open menu"
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
              onNavigate={setActiveTab}
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

          {activeTab === 'applications' && (
            <MyApplicationsView
              applications={applications}
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
