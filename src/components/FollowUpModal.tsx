import { useEffect, useState } from 'react';
import { Loader2, Send, CheckSquare, X, AlertCircle } from 'lucide-react';
import type {
  ApplicationEmailRecord,
  FollowUpRecord,
  JobApplicationRecord,
} from '../types.ts';
import { addCalendarDays, getTodayIsoDate } from '../lib/dateUtils.ts';
import { generateFollowUpEmailApi, sendGmailEmailApi } from '../lib/apiClient.ts';
import { createFollowUpRecord } from '../lib/firestoreService.ts';

interface FollowUpModalProps {
  application: JobApplicationRecord | null;
  uid: string;
  candidateName: string;
  defaultFollowUpDays: number;
  originalEmail: ApplicationEmailRecord | null;
  previousFollowUps: FollowUpRecord[];
  hasGmailSessionToken: boolean;
  onReconnectGmail: () => Promise<boolean>;
  onClose: () => void;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

export function FollowUpModal({
  application,
  uid,
  candidateName,
  defaultFollowUpDays,
  originalEmail,
  previousFollowUps,
  hasGmailSessionToken,
  onReconnectGmail,
  onClose,
  onSuccess,
  onError,
}: FollowUpModalProps) {
  const [recipientEmail, setRecipientEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [confirmingSend, setConfirmingSend] = useState(false);

  useEffect(() => {
    if (!application) return;
    setRecipientEmail(application.hrEmail || originalEmail?.recipientEmail || '');
    setConfirmingSend(false);
    setSubject('');
    setBody('');

    let cancelled = false;
    async function generateDraft() {
      if (!application) return;
      setGenerating(true);
      try {
        const res = await generateFollowUpEmailApi({
          candidateName,
          companyName: application.companyName,
          jobTitle: application.jobTitle,
          dateApplied: application.dateApplied,
          originalEmailSubject: originalEmail?.emailSubject,
          originalEmailBody: originalEmail?.emailBody,
          previousFollowUps: previousFollowUps.map((f) => f.emailBody),
        });
        if (!cancelled) {
          setSubject(res.subject);
          setBody(res.body);
        }
      } catch (err) {
        if (!cancelled) {
          onError(err instanceof Error ? err.message : 'Failed to draft follow-up email.');
        }
      } finally {
        if (!cancelled) {
          setGenerating(false);
        }
      }
    }

    void generateDraft();
    return () => {
      cancelled = true;
    };
  }, [application?.id]);

  if (!application) return null;

  const today = getTodayIsoDate();
  const nextFollowUpDate = addCalendarDays(today, defaultFollowUpDays);

  const handleRequestSend = async () => {
    if (!recipientEmail.trim()) {
      onError('Please enter a recipient email address, or use "Log Portal Follow-up" below.');
      return;
    }
    if (!subject.trim() || !body.trim()) {
      onError('Follow-up subject and body are required.');
      return;
    }
    if (!hasGmailSessionToken) {
      const ok = await onReconnectGmail();
      if (!ok) return;
    }
    setConfirmingSend(true);
  };

  const handleConfirmSendViaGmail = async () => {
    setSending(true);
    try {
      const gmailRes = await sendGmailEmailApi({
        toEmail: recipientEmail.trim(),
        subject: subject.trim(),
        body,
        threadId: application.gmailThreadId || undefined,
      });

      await createFollowUpRecord({
        uid,
        applicationId: application.id,
        followUpDate: today,
        recipientEmail: recipientEmail.trim(),
        emailSubject: subject.trim(),
        emailBody: body,
        gmailMessageId: gmailRes.gmailMessageId,
        status: 'sent',
        outcome: 'Follow-up email sent via Gmail',
        sentAt: gmailRes.sentAt,
        nextFollowUpDate,
      });

      onSuccess(`Follow-up sent to ${recipientEmail.trim()} for ${application.companyName}.`);
      onClose();
    } catch (err) {
      setConfirmingSend(false);
      onError(err instanceof Error ? err.message : 'Failed to send follow-up via Gmail.');
    } finally {
      setSending(false);
    }
  };

  const handleLogManualFollowUp = async () => {
    setSending(true);
    try {
      await createFollowUpRecord({
        uid,
        applicationId: application.id,
        followUpDate: today,
        recipientEmail: recipientEmail.trim(),
        emailSubject:
          subject.trim() ||
          `Follow-up on ${application.jobTitle} Application – ${application.companyName}`,
        emailBody: body || 'Followed up via job portal / direct message.',
        gmailMessageId: '',
        status: 'logged',
        outcome: `Followed up manually via ${application.applicationSource}`,
        sentAt: new Date().toISOString(),
        nextFollowUpDate,
      });
      onSuccess(`Logged follow-up for ${application.companyName}. Next reminder set for ${nextFollowUpDate}.`);
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to log follow-up.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              Follow Up · {application.companyName}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {application.jobTitle} · Applied {application.dateApplied}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 cursor-pointer"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-4">
          {generating ? (
            <div className="py-12 flex flex-col items-center justify-center text-sm text-slate-600 gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-blue-700" />
              <span>Drafting personalized follow-up email...</span>
            </div>
          ) : confirmingSend ? (
            <div className="space-y-4">
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2 text-sm">
                <p className="font-semibold text-slate-900">Confirm Sending Follow-Up Email</p>
                <p className="text-xs text-slate-600">
                  To: <span className="font-medium text-slate-900">{recipientEmail}</span>
                </p>
                <p className="text-xs text-slate-600">
                  Subject: <span className="font-medium text-slate-900">{subject}</span>
                </p>
                <p className="text-xs text-slate-600">
                  Next follow-up will be scheduled for{' '}
                  <span className="font-mono">{nextFollowUpDate}</span>.
                </p>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmingSend(false)}
                  disabled={sending}
                  className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  Back to Edit
                </button>
                <button
                  type="button"
                  onClick={handleConfirmSendViaGmail}
                  disabled={sending}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg disabled:opacity-60 cursor-pointer"
                >
                  {sending && <Loader2 className="w-4 h-4 animate-spin" />}
                  {sending ? 'Sending...' : 'Confirm & Send Follow-Up'}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Recipient Email
                </label>
                <input
                  type="email"
                  value={recipientEmail}
                  onChange={(e) => setRecipientEmail(e.target.value)}
                  placeholder="hr@company.com"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Subject
                </label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Follow-Up Message
                </label>
                <textarea
                  rows={9}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 leading-relaxed"
                />
              </div>

              {!hasGmailSessionToken && (
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 flex items-center justify-between gap-2 text-xs text-amber-800">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>Connect or refresh Gmail session to send directly.</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void onReconnectGmail()}
                    className="px-2.5 py-1 bg-white border border-amber-300 rounded font-medium cursor-pointer whitespace-nowrap"
                  >
                    Reconnect Gmail
                  </button>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={handleLogManualFollowUp}
                  disabled={sending}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                >
                  <CheckSquare className="w-3.5 h-3.5" />
                  Log Portal Follow-Up
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={sending}
                    className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleRequestSend}
                    disabled={sending}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg disabled:opacity-60 cursor-pointer whitespace-nowrap"
                  >
                    <Send className="w-4 h-4" />
                    Send via Gmail
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
