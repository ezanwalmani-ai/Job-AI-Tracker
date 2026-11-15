import { useState } from 'react';
import {
  Mail,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Loader2,
  LogOut,
  Inbox,
  Save,
} from 'lucide-react';
import type {
  EmailConnectionRecord,
  EmailReplyRecord,
  JobApplicationRecord,
} from '../types.ts';
import { formatReadableDate } from '../lib/dateUtils.ts';
import { syncGmailRepliesApi } from '../lib/apiClient.ts';
import {
  assignOrDismissReply,
  saveEmailConnectionState,
  saveSyncedEmailReplies,
  updateJobApplicationRecord,
  updateUserProfile,
} from '../lib/firestoreService.ts';

interface EmailSettingsViewProps {
  uid: string;
  userEmail: string;
  defaultFollowUpDays: number;
  emailConnection: EmailConnectionRecord | null;
  hasGmailSessionToken: boolean;
  applications: JobApplicationRecord[];
  replies: EmailReplyRecord[];
  onConnectGmail: () => Promise<boolean>;
  onDisconnectGmail: () => Promise<void>;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
}

export function EmailSettingsView({
  uid,
  userEmail,
  defaultFollowUpDays,
  emailConnection,
  hasGmailSessionToken,
  applications,
  replies,
  onConnectGmail,
  onDisconnectGmail,
  onNotice,
  onError,
}: EmailSettingsViewProps) {
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [followUpDays, setFollowUpDays] = useState(defaultFollowUpDays);
  const [savingSettings, setSavingSettings] = useState(false);
  const [manualAssign, setManualAssign] = useState<Record<string, string>>({});

  const isConnected =
    emailConnection?.status === 'connected' && hasGmailSessionToken;
  const needsReconnect =
    emailConnection?.status === 'connected' && !hasGmailSessionToken;

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const ok = await onConnectGmail();
      if (ok) {
        onNotice('Gmail account authorized and ready for sending.');
      }
    } finally {
      setConnecting(false);
    }
  };

  const handleToggleReplyTracking = async () => {
    try {
      await saveEmailConnectionState({
        uid,
        connectedEmail: emailConnection?.connectedEmail || userEmail,
        status: emailConnection?.status || (hasGmailSessionToken ? 'connected' : 'disconnected'),
        replyTrackingEnabled: !(emailConnection?.replyTrackingEnabled ?? true),
      });
      onNotice('Email reply tracking preference updated.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to update reply tracking preference.');
    }
  };

  const handleSyncReplies = async () => {
    if (!hasGmailSessionToken) {
      const ok = await onConnectGmail();
      if (!ok) return;
    }

    setSyncing(true);
    try {
      const res = await syncGmailRepliesApi({
        applications: applications.map((a) => ({
          id: a.id,
          companyName: a.companyName,
          jobTitle: a.jobTitle,
          hrEmail: a.hrEmail,
          gmailThreadId: a.gmailThreadId,
        })),
        existingMessageIds: replies.map((r) => r.gmailMessageId),
      });

      if (res.replies.length > 0) {
        await saveSyncedEmailReplies(
          uid,
          res.replies.map((r) => ({
            applicationId: r.matchedApplicationId,
            gmailMessageId: r.gmailMessageId,
            gmailThreadId: r.gmailThreadId,
            fromEmail: r.fromEmail,
            fromName: r.fromName,
            subject: r.subject,
            snippet: r.snippet,
            receivedAt: r.receivedAt,
            classification: r.classification,
            matchConfidence: r.matchConfidence,
          }))
        );

        // Update application status for high-confidence matches
        for (const r of res.replies) {
          if (r.matchConfidence === 'high' && r.matchedApplicationId) {
            const targetApp = applications.find((a) => a.id === r.matchedApplicationId);
            if (targetApp) {
              let nextStatus = targetApp.applicationStatus;
              if (r.classification === 'Interview Invitation') {
                nextStatus = 'Interview Scheduled';
              } else if (r.classification === 'Rejection') {
                nextStatus = 'Rejected';
              } else if (
                r.classification === 'Further Information Requested' ||
                r.classification === 'Acknowledgement'
              ) {
                nextStatus = 'HR Responded';
              }
              await updateJobApplicationRecord(uid, targetApp.id, {
                applicationStatus: nextStatus,
                lastCommunicationDate: r.receivedAt.slice(0, 10),
              });
            }
          }
        }
      }

      await saveEmailConnectionState({
        uid,
        connectedEmail: emailConnection?.connectedEmail || userEmail,
        status: 'connected',
        replyTrackingEnabled: emailConnection?.replyTrackingEnabled ?? true,
        lastSyncedAt: new Date().toISOString(),
      });

      onNotice(
        res.replies.length > 0
          ? `Found ${res.replies.length} new HR reply message(s).`
          : 'Checked inbox — no new HR replies found.'
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to sync Gmail replies.');
    } finally {
      setSyncing(false);
    }
  };

  const handleAssignReply = async (reply: EmailReplyRecord) => {
    const appId = manualAssign[reply.id];
    if (!appId) {
      onError('Select an application to assign this reply to.');
      return;
    }
    try {
      await assignOrDismissReply(uid, reply.id, {
        applicationId: appId,
        matchConfidence: 'high',
        reviewed: true,
      });
      const targetApp = applications.find((a) => a.id === appId);
      if (targetApp) {
        const nextStatus =
          reply.classification === 'Interview Invitation'
            ? 'Interview Scheduled'
            : reply.classification === 'Rejection'
              ? 'Rejected'
              : 'HR Responded';
        await updateJobApplicationRecord(uid, appId, {
          applicationStatus: nextStatus,
          lastCommunicationDate: reply.receivedAt.slice(0, 10),
        });
      }
      onNotice('Reply linked to the selected application.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to assign reply.');
    }
  };

  const handleDismissReply = async (replyId: string) => {
    try {
      await assignOrDismissReply(uid, replyId, {
        applicationId: '',
        matchConfidence: 'needs_review',
        reviewed: true,
      });
      onNotice('Message dismissed from review queue.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to dismiss reply.');
    }
  };

  const handleSaveDefaultDays = async () => {
    const days = Math.min(60, Math.max(1, Number(followUpDays) || 7));
    setSavingSettings(true);
    try {
      await updateUserProfile(uid, { defaultFollowUpDays: days });
      setFollowUpDays(days);
      onNotice(`Default follow-up interval saved (${days} days).`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to save settings.');
    } finally {
      setSavingSettings(false);
    }
  };

  const pendingReviewReplies = replies.filter((r) => !r.reviewed);

  return (
    <div className="space-y-6">
      {/* Connect Email Account */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 pb-4 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Connect Email Account</h2>
            <p className="text-sm text-slate-600 mt-1">
              Send job applications and follow-ups directly from your personal Gmail account using
              Google OAuth 2.0. Passwords are never requested or stored.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isConnected ? (
              <>
                <button
                  type="button"
                  onClick={handleConnect}
                  disabled={connecting}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Refresh Connection
                </button>
                <button
                  type="button"
                  onClick={() => void onDisconnectGmail()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 cursor-pointer whitespace-nowrap"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Disconnect
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={handleConnect}
                disabled={connecting}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer whitespace-nowrap"
              >
                {connecting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Mail className="w-4 h-4" />
                )}
                {needsReconnect ? 'Reconnect Gmail' : 'Connect Gmail'}
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
            <p className="text-xs text-slate-500">Connected Email Address</p>
            <p className="font-medium text-slate-900 mt-1 break-all">
              {emailConnection?.connectedEmail || userEmail}
            </p>
          </div>
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
            <p className="text-xs text-slate-500">Connection Status</p>
            <div className="mt-1 flex items-center gap-1.5 font-medium">
              {isConnected ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span className="text-emerald-700">Connected &amp; Ready to Send</span>
                </>
              ) : needsReconnect ? (
                <>
                  <AlertCircle className="w-4 h-4 text-amber-600" />
                  <span className="text-amber-700">Authorization Expired — Reconnect</span>
                </>
              ) : (
                <>
                  <AlertCircle className="w-4 h-4 text-slate-500" />
                  <span className="text-slate-700">Disconnected</span>
                </>
              )}
            </div>
          </div>
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
            <p className="text-xs text-slate-500">Permissions Granted</p>
            <p className="text-xs text-slate-700 mt-1 leading-relaxed">
              Send emails on your click (<span className="font-mono">gmail.send</span>) and
              optional read-only HR reply check (<span className="font-mono">gmail.readonly</span>).
            </p>
          </div>
        </div>
      </div>

      {/* Default Follow-Up Interval */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-slate-900">Follow-Up Schedule</h3>
          <p className="text-xs text-slate-600 mt-1">
            Automatically schedule your follow-up reminder this many calendar days after applying.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <input
            type="number"
            min={1}
            max={60}
            value={followUpDays}
            onChange={(e) => setFollowUpDays(Number(e.target.value))}
            className="w-20 px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg text-center"
          />
          <span className="text-xs text-slate-600">days</span>
          <button
            type="button"
            onClick={handleSaveDefaultDays}
            disabled={savingSettings}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" />
            Save
          </button>
        </div>
      </div>

      {/* Email Reply Tracking */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-200">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              Email Reply Tracking (Optional)
            </h3>
            <p className="text-xs text-slate-600 mt-1">
              Scan recent Gmail replies to detect Interview Invitations, Requests for Information,
              Rejections, or Acknowledgements. Never sends automatic replies.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={emailConnection?.replyTrackingEnabled ?? true}
                onChange={handleToggleReplyTracking}
                className="rounded border-slate-300 text-blue-700 focus:ring-blue-600"
              />
              Enable Reply Sync
            </label>
            <button
              type="button"
              onClick={handleSyncReplies}
              disabled={syncing || !(emailConnection?.replyTrackingEnabled ?? true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              {syncing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Inbox className="w-3.5 h-3.5" />
              )}
              {syncing ? 'Checking Inbox...' : 'Check for HR Replies Now'}
            </button>
          </div>
        </div>

        {emailConnection?.lastSyncedAt && (
          <p className="text-xs text-slate-500 font-mono tabular-nums">
            Last checked: {formatReadableDate(emailConnection.lastSyncedAt)}
          </p>
        )}

        {/* Replies Needing Manual Review */}
        {pendingReviewReplies.length > 0 && (
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-amber-800">
              Replies Requiring Review ({pendingReviewReplies.length})
            </h4>
            <p className="text-xs text-slate-600">
              These incoming emails could not be matched with high certainty. Assign them to an
              application or dismiss them.
            </p>
            <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg">
              {pendingReviewReplies.map((rep) => (
                <div key={rep.id} className="p-4 space-y-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-slate-900">
                      {rep.fromName} ({rep.fromEmail})
                    </span>
                    <span className="font-medium text-blue-700">
                      {rep.classification} · {formatReadableDate(rep.receivedAt)}
                    </span>
                  </div>
                  <p className="font-medium text-slate-800">{rep.subject}</p>
                  <p className="text-slate-600">{rep.snippet}</p>
                  <div className="flex flex-wrap items-center gap-2 pt-2">
                    <select
                      value={manualAssign[rep.id] || ''}
                      onChange={(e) =>
                        setManualAssign({ ...manualAssign, [rep.id]: e.target.value })
                      }
                      className="px-2.5 py-1.5 border border-slate-300 rounded bg-white text-xs"
                    >
                      <option value="">Select matching application...</option>
                      {applications.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.companyName} — {a.jobTitle}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => handleAssignReply(rep)}
                      className="px-3 py-1.5 bg-blue-700 text-white rounded hover:bg-blue-800 font-medium cursor-pointer"
                    >
                      Link Reply
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDismissReply(rep.id)}
                      className="px-3 py-1.5 bg-white border border-slate-300 text-slate-600 rounded hover:bg-slate-50 cursor-pointer"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent Matched Replies */}
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-slate-900">Matched HR Communications</h4>
          {replies.filter((r) => r.reviewed && r.applicationId).length === 0 ? (
            <p className="text-xs text-slate-500">
              No matched HR replies yet. Click &ldquo;Check for HR Replies Now&rdquo; to scan your
              Gmail inbox.
            </p>
          ) : (
            <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg">
              {replies
                .filter((r) => r.reviewed && r.applicationId)
                .slice(0, 10)
                .map((rep) => {
                  const app = applications.find((a) => a.id === rep.applicationId);
                  return (
                    <div key={rep.id} className="p-3.5 text-xs space-y-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-slate-900">
                          {app ? `${app.companyName} — ${app.jobTitle}` : rep.fromEmail}
                        </span>
                        <span className="font-medium text-blue-700">
                          {rep.classification} · {formatReadableDate(rep.receivedAt)}
                        </span>
                      </div>
                      <p className="text-slate-700 font-medium">{rep.subject}</p>
                      <p className="text-slate-600">{rep.snippet}</p>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
