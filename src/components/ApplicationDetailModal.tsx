import { useEffect, useState } from 'react';
import {
  X,
  ExternalLink,
  Download,
  Eye,
  Mail,
  Send,
  Trash2,
  Loader2,
  Save,
} from 'lucide-react';
import type {
  ApplicationEmailRecord,
  ApplicationResumeRecord,
  ApplicationStatus,
  EmailReplyRecord,
  FollowUpRecord,
  JobApplicationRecord,
} from '../types.ts';
import { downloadBase64Pdf, formatReadableDate } from '../lib/dateUtils.ts';
import {
  deleteJobApplicationRecord,
  loadPdfBase64Chunks,
  updateJobApplicationRecord,
} from '../lib/firestoreService.ts';
import { PdfPreviewModal } from './PdfPreview.tsx';

interface ApplicationDetailModalProps {
  application: JobApplicationRecord | null;
  uid: string;
  appResume: ApplicationResumeRecord | null;
  emails: ApplicationEmailRecord[];
  followUps: FollowUpRecord[];
  replies: EmailReplyRecord[];
  onClose: () => void;
  onTriggerFollowUp: (app: JobApplicationRecord) => void;
  onUpdated: (msg: string) => void;
  onError: (msg: string) => void;
}

const ALL_STATUSES: ApplicationStatus[] = [
  'Applied',
  'Email Sent',
  'Waiting for Response',
  'HR Responded',
  'Interview Scheduled',
  'Offer Received',
  'Rejected',
];

export function ApplicationDetailModal({
  application,
  uid,
  appResume,
  emails,
  followUps,
  replies,
  onClose,
  onTriggerFollowUp,
  onUpdated,
  onError,
}: ApplicationDetailModalProps) {
  const [status, setStatus] = useState<ApplicationStatus>('Applied');
  const [followUpDate, setFollowUpDate] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loadingPdf, setLoadingPdf] = useState(false);
  const [previewPdf, setPreviewPdf] = useState<{ fileName: string; base64: string } | null>(
    null
  );

  useEffect(() => {
    if (!application) return;
    setStatus(application.applicationStatus);
    setFollowUpDate(application.followUpDate);
    setNotes(application.notes);
    setConfirmDelete(false);
  }, [application?.id, application?.applicationStatus, application?.followUpDate, application?.notes]);

  if (!application) return null;

  const handleSaveChanges = async () => {
    setSaving(true);
    try {
      await updateJobApplicationRecord(uid, application.id, {
        applicationStatus: status,
        followUpDate,
        notes,
      });
      onUpdated(`Updated application for ${application.companyName}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to update application.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteJobApplicationRecord(uid, application.id);
      onUpdated(`Deleted application for ${application.companyName}.`);
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to delete application.');
    } finally {
      setDeleting(false);
    }
  };

  const handleLoadResumePdf = async (action: 'preview' | 'download') => {
    if (!appResume) return;
    setLoadingPdf(true);
    try {
      const base64 = await loadPdfBase64Chunks(uid, 'applicationResumes', appResume.id);
      if (!base64) {
        onError('Attached resume PDF could not be retrieved.');
        return;
      }
      if (action === 'download') {
        downloadBase64Pdf(base64, appResume.fileName);
      } else {
        setPreviewPdf({ fileName: appResume.fileName, base64 });
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to load resume PDF.');
    } finally {
      setLoadingPdf(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-slate-200">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span>{application.applicationMethod === 'email' ? 'Email Application' : 'Job Portal'}</span>
              <span aria-hidden="true">·</span>
              <span>{application.applicationSource}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                Applied {formatReadableDate(application.dateApplied)}
              </span>
            </div>
            <h2 className="text-lg font-semibold text-slate-900 mt-1">
              {application.jobTitle} — {application.companyName}
            </h2>
            <p className="text-xs text-slate-600 mt-0.5">{application.jobLocation}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onTriggerFollowUp(application)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer whitespace-nowrap"
            >
              <Send className="w-3.5 h-3.5" />
              Follow Up
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 cursor-pointer"
              aria-label="Close detail"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto space-y-6">
          {/* Status & Schedule Editor */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 bg-slate-50 border border-slate-200 rounded-lg p-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Application Status
              </label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as ApplicationStatus)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                {ALL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Next Follow-Up Date
              </label>
              <input
                type="date"
                value={followUpDate}
                onChange={(e) => setFollowUpDate(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white font-mono focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Last Communication
              </label>
              <p className="px-3 py-2 text-sm font-mono tabular-nums text-slate-700 bg-white border border-slate-200 rounded-lg">
                {application.lastCommunicationDate || application.dateApplied}
              </p>
            </div>
            <div className="sm:col-span-3">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Notes
              </label>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Add personal notes, interview feedback, or recruiter details..."
                  className="flex-1 px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                <button
                  type="button"
                  onClick={handleSaveChanges}
                  disabled={saving}
                  className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer whitespace-nowrap"
                >
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  Save Updates
                </button>
              </div>
            </div>
          </div>

          {/* Linked Resume & URL */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="border border-slate-200 rounded-lg p-4">
              <p className="text-xs font-semibold text-slate-800">Attached Resume Version</p>
              {appResume ? (
                <div className="mt-2 space-y-2">
                  <p className="text-sm font-medium text-slate-900 truncate">
                    {appResume.fileName}
                  </p>
                  <p className="text-xs text-slate-600">
                    Location set: <span className="font-mono">{appResume.updatedLocationLabel}</span>
                  </p>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => handleLoadResumePdf('preview')}
                      disabled={loadingPdf}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 cursor-pointer"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      Preview PDF
                    </button>
                    <button
                      type="button"
                      onClick={() => handleLoadResumePdf('download')}
                      disabled={loadingPdf}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-500 mt-2">
                  Submitted directly via {application.applicationSource}.
                </p>
              )}
            </div>

            <div className="border border-slate-200 rounded-lg p-4 space-y-1.5 text-xs">
              <p className="font-semibold text-slate-800">Contact &amp; Job Details</p>
              {application.recruiterName && (
                <p className="text-slate-600">
                  Recruiter:{' '}
                  <span className="font-medium text-slate-900">{application.recruiterName}</span>
                </p>
              )}
              <p className="text-slate-600">
                HR Email:{' '}
                <span className="font-medium text-slate-900">
                  {application.hrEmail || 'Not recorded'}
                </span>
              </p>
              {application.companyAddress && (
                <p className="text-slate-600">
                  Company Address:{' '}
                  <span className="text-slate-800">{application.companyAddress}</span>
                </p>
              )}
              {(application.requiredExperience || application.employmentType || application.salary) && (
                <p className="text-slate-600">
                  {[
                    application.requiredExperience && `Exp: ${application.requiredExperience}`,
                    application.employmentType,
                    application.salary && `Pay: ${application.salary}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}
              <p className="text-slate-600">
                Job URL:{' '}
                {application.jobUrl ? (
                  <a
                    href={application.jobUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-blue-700 hover:underline break-all"
                  >
                    {application.jobUrl}
                    <ExternalLink className="w-3 h-3 shrink-0" />
                  </a>
                ) : (
                  <span className="text-slate-500">None</span>
                )}
              </p>
              {application.applicationInstructions && (
                <p className="text-slate-600 pt-1">
                  Instructions: <span className="text-slate-800">{application.applicationInstructions}</span>
                </p>
              )}
              {application.aiSummary && (
                <p className="text-slate-600 pt-1 leading-relaxed">{application.aiSummary}</p>
              )}
            </div>
          </div>

          {/* Email History */}
          {emails.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-slate-900">Application Email Sent</h3>
              {emails.map((em) => (
                <div
                  key={em.id}
                  className="border border-slate-200 rounded-lg p-4 space-y-2 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                    <span className="flex items-center gap-1.5 font-medium text-slate-800">
                      <Mail className="w-3.5 h-3.5 text-blue-700" />
                      To: {em.recipientEmail}
                    </span>
                    <span className="font-mono tabular-nums">
                      Sent {formatReadableDate(em.sentAt)} · Gmail ID: {em.gmailMessageId || '—'}
                    </span>
                  </div>
                  <p className="font-medium text-slate-900 text-sm">{em.emailSubject}</p>
                  <div className="text-xs text-slate-700 whitespace-pre-wrap bg-slate-50 p-3 rounded border border-slate-200 leading-relaxed">
                    {em.emailBody}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Matched HR Replies */}
          {replies.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-slate-900">HR Replies Received</h3>
              {replies.map((rep) => (
                <div
                  key={rep.id}
                  className="border border-slate-200 rounded-lg p-4 space-y-1.5 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-slate-900">
                      {rep.fromName} ({rep.fromEmail})
                    </span>
                    <span className="font-medium text-blue-700">
                      {rep.classification} · {formatReadableDate(rep.receivedAt)}
                    </span>
                  </div>
                  <p className="font-medium text-slate-800">{rep.subject}</p>
                  <p className="text-slate-600 leading-relaxed">{rep.snippet}</p>
                </div>
              ))}
            </div>
          )}

          {/* Follow-Up History */}
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-900">Follow-Up History</h3>
            {followUps.length === 0 ? (
              <p className="text-xs text-slate-500">No follow-ups sent or logged yet.</p>
            ) : (
              <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg">
                {followUps.map((fu) => (
                  <div key={fu.id} className="p-3.5 text-xs space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-slate-900">{fu.emailSubject}</span>
                      <span className="font-mono tabular-nums text-slate-500">
                        {fu.followUpDate} · {fu.status}
                      </span>
                    </div>
                    <p className="text-slate-600 whitespace-pre-wrap leading-relaxed">
                      {fu.emailBody}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Full Job Description */}
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-900">Job Description</h3>
            {application.keyRequirements.length > 0 && (
              <ul className="list-disc pl-5 text-xs text-slate-700 space-y-1 mb-2">
                {application.keyRequirements.map((req, i) => (
                  <li key={i}>{req}</li>
                ))}
              </ul>
            )}
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 text-xs text-slate-700 whitespace-pre-wrap max-h-64 overflow-y-auto leading-relaxed">
              {application.jobDescription}
            </div>
          </div>

          {/* Delete */}
          <div className="pt-4 border-t border-slate-200 flex items-center justify-between">
            {!confirmDelete ? (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600 hover:text-red-700 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete Application Record
              </button>
            ) : (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-red-700 font-medium">Confirm delete this record?</span>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700 cursor-pointer"
                >
                  {deleting ? 'Deleting...' : 'Yes, Delete'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="px-3 py-1 bg-white border border-slate-300 rounded cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {previewPdf && (
        <PdfPreviewModal
          isOpen={Boolean(previewPdf)}
          title={previewPdf.fileName}
          fileName={previewPdf.fileName}
          base64Data={previewPdf.base64}
          onClose={() => setPreviewPdf(null)}
        />
      )}
    </div>
  );
}
