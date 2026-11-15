import { useState } from 'react';
import { X, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import type { ApplicationStatus, JobApplicationRecord } from '../types.ts';
import { addCalendarDays, getTodayIsoDate } from '../lib/dateUtils.ts';
import { analyzeManualJdApi, parseJobInputApi } from '../lib/apiClient.ts';
import { saveManualApplicationRecord } from '../lib/firestoreService.ts';
import { findDuplicateApplication, normalizePortalSource } from '../lib/portalAdapters.ts';

interface ManualApplicationModalProps {
  isOpen: boolean;
  uid: string;
  defaultFollowUpDays: number;
  applications?: JobApplicationRecord[];
  onClose: () => void;
  onSaved: (message: string) => void;
}

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

const MANUAL_STATUSES: ApplicationStatus[] = [
  'Applied – Manually Recorded',
  'Saved',
  'Applied – Confirmed',
  'Awaiting Confirmation',
  'HR Responded',
  'Interview Scheduled',
  'Offer Received',
  'Rejected',
];

export function ManualApplicationModal({
  isOpen,
  uid,
  defaultFollowUpDays,
  applications = [],
  onClose,
  onSaved,
}: ManualApplicationModalProps) {
  const [pastedInput, setPastedInput] = useState('');
  const [showFields, setShowFields] = useState(false);

  const [companyName, setCompanyName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [jobLocation, setJobLocation] = useState('');
  const [hrEmail, setHrEmail] = useState('');
  const [applicationSource, setApplicationSource] = useState('LinkedIn');
  const [jobUrl, setJobUrl] = useState('');
  const [dateApplied, setDateApplied] = useState(getTodayIsoDate());
  const [applicationStatus, setApplicationStatus] = useState<ApplicationStatus>(
    'Applied – Manually Recorded'
  );
  const [notes, setNotes] = useState('');

  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const resetForm = () => {
    setPastedInput('');
    setShowFields(false);
    setCompanyName('');
    setJobTitle('');
    setJobLocation('');
    setHrEmail('');
    setApplicationSource('LinkedIn');
    setJobUrl('');
    setDateApplied(getTodayIsoDate());
    setApplicationStatus('Applied – Manually Recorded');
    setNotes('');
    setError('');
  };

  const handleExtractOnly = async () => {
    if (pastedInput.trim().length < 10) {
      setError('Paste the job description or posting first.');
      return;
    }
    setExtracting(true);
    setError('');
    try {
      const parsed = await parseJobInputApi(pastedInput.trim());
      setCompanyName(parsed.companyName);
      setJobTitle(parsed.jobTitle);
      setJobLocation(parsed.jobLocation);
      setHrEmail(parsed.hrEmail);
      setJobUrl(parsed.jobUrl);
      setApplicationSource(parsed.applicationSource || 'Job Portal');
      setNotes(parsed.notes);
      setShowFields(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to extract details.');
    } finally {
      setExtracting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = pastedInput.trim();
    const hasManualCore = Boolean(companyName.trim() && jobTitle.trim() && jobLocation.trim());

    if (!raw && !hasManualCore) {
      setError('Paste a job description or posting (with company, role, location, or email).');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const today = dateApplied || getTodayIsoDate();
      const followUpDate = addCalendarDays(today, defaultFollowUpDays);

      let finalCompany = companyName.trim();
      let finalTitle = jobTitle.trim();
      let finalLocation = jobLocation.trim();
      let finalEmail = hrEmail.trim();
      let finalUrl = jobUrl.trim();
      let finalSource = applicationSource;
      let finalNotes = notes.trim();
      let aiSummary = '';
      let keyRequirements: string[] = [];
      let recruiterName = '';
      let companyAddress = '';
      let salary = '';
      let employmentType = '';
      let requiredExperience = '';
      let applicationInstructions = '';

      if (!hasManualCore) {
        const parsed = await parseJobInputApi(raw);
        finalCompany = finalCompany || parsed.companyName || 'Unspecified Company';
        finalTitle = finalTitle || parsed.jobTitle || 'Unspecified Role';
        finalLocation = finalLocation || parsed.jobLocation || 'Not specified';
        finalEmail = finalEmail || parsed.hrEmail;
        finalUrl = finalUrl || parsed.jobUrl;
        finalSource =
          applicationSource === 'LinkedIn' && parsed.applicationSource
            ? parsed.applicationSource
            : applicationSource;
        finalNotes = finalNotes || parsed.notes;
        aiSummary = parsed.aiSummary;
        keyRequirements = parsed.keyRequirements;
        recruiterName = parsed.recruiterName;
        companyAddress = parsed.companyAddress;
        salary = parsed.salary;
        employmentType = parsed.employmentType;
        requiredExperience = parsed.requiredExperience;
        applicationInstructions = parsed.applicationInstructions;
      } else if (raw) {
        const analysis = await analyzeManualJdApi({
          companyName: finalCompany,
          jobTitle: finalTitle,
          jobLocation: finalLocation,
          jobDescription: raw,
        });
        aiSummary = analysis.aiSummary;
        keyRequirements = analysis.keyRequirements;
      }

      const dup = findDuplicateApplication(
        {
          userId: uid,
          companyName: finalCompany,
          jobTitle: finalTitle,
          jobUrl: finalUrl,
          dateApplied: today,
        },
        applications
      );
      if (dup.isDuplicate) {
        setError(`Duplicate detected: ${dup.reason}. No duplicate record was created.`);
        setSaving(false);
        return;
      }

      const normSource = normalizePortalSource(finalSource, finalUrl);
      await saveManualApplicationRecord({
        uid,
        companyName: finalCompany,
        jobTitle: finalTitle,
        jobDescription: raw || `${finalTitle} at ${finalCompany} (${finalLocation})`,
        jobLocation: finalLocation,
        jobUrl: finalUrl,
        hrEmail: finalEmail,
        recruiterName,
        companyAddress,
        salary,
        employmentType,
        requiredExperience,
        applicationInstructions,
        applicationSource: normSource,
        captureMethod: 'manual_portal',
        confirmationEvidence:
          applicationStatus === 'Saved'
            ? `Bookmarked via Quick Save (${normSource})`
            : `Recorded by user for ${normSource} on ${today}`,
        needsReview: false,
        dateApplied: today,
        followUpDate,
        applicationStatus,
        notes: finalNotes,
        aiSummary,
        keyRequirements,
      });

      resetForm();
      onSaved(`Saved application for ${finalTitle} at ${finalCompany} (${today}).`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save application.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Quick Add Application</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Paste the job description or posting below — company, role, location, HR email, and
              today&rsquo;s date are captured automatically.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              resetForm();
              onClose();
            }}
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 cursor-pointer"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-4">
          {error && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
              {error}
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-slate-700">
                Paste Job Description, Post, or Prompt *
              </label>
              <span className="text-[11px] text-slate-500 font-mono tabular-nums">
                Date recorded: {dateApplied}
              </span>
            </div>
            <textarea
              rows={8}
              value={pastedInput}
              onChange={(e) => setPastedInput(e.target.value)}
              placeholder="Paste the entire job post, LinkedIn/Naukri snippet, email, or a quick note like:&#10;Applied to Stripe for Senior Frontend Engineer in Pune, Maharashtra via LinkedIn. HR contact: careers@stripe.com ..."
              className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 leading-relaxed"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setShowFields((prev) => !prev)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              {showFields ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
              {showFields ? 'Hide extracted / optional fields' : 'Review or edit fields manually'}
            </button>

            <button
              type="button"
              onClick={handleExtractOnly}
              disabled={extracting || saving || pastedInput.trim().length < 10}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 hover:underline disabled:opacity-40 cursor-pointer"
            >
              {extracting && <Loader2 className="w-3 h-3 animate-spin" />}
              {extracting ? 'Extracting...' : 'Preview extracted fields'}
            </button>
          </div>

          {showFields && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Company Name
                  </label>
                  <input
                    type="text"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    placeholder="Auto-detected from JD"
                    className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Job Title
                  </label>
                  <input
                    type="text"
                    value={jobTitle}
                    onChange={(e) => setJobTitle(e.target.value)}
                    placeholder="Auto-detected from JD"
                    className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Job Location
                  </label>
                  <input
                    type="text"
                    value={jobLocation}
                    onChange={(e) => setJobLocation(e.target.value)}
                    placeholder="Auto-detected from JD"
                    className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    HR / Recruiter Email
                  </label>
                  <input
                    type="email"
                    value={hrEmail}
                    onChange={(e) => setHrEmail(e.target.value)}
                    placeholder="Auto-detected if in JD"
                    className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Portal / Source
                  </label>
                  <select
                    value={applicationSource}
                    onChange={(e) => setApplicationSource(e.target.value)}
                    className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
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
                    Application Status
                  </label>
                  <select
                    value={applicationStatus}
                    onChange={(e) => setApplicationStatus(e.target.value as ApplicationStatus)}
                    className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                  >
                    {MANUAL_STATUSES.map((st) => (
                      <option key={st} value={st}>
                        {st}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Date Applied
                  </label>
                  <input
                    type="date"
                    value={dateApplied}
                    onChange={(e) => setDateApplied(e.target.value)}
                    className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white font-mono focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Job URL
                  </label>
                  <input
                    type="url"
                    value={jobUrl}
                    onChange={(e) => setJobUrl(e.target.value)}
                    placeholder="Auto-detected if in JD"
                    className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Notes</label>
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional personal notes"
                  className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>
          )}

          <div className="flex items-center justify-between pt-3 border-t border-slate-200">
            <span className="text-xs text-slate-500 font-mono tabular-nums">
              Follow-up auto-set: {addCalendarDays(dateApplied || getTodayIsoDate(), defaultFollowUpDays)}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  resetForm();
                  onClose();
                }}
                disabled={saving}
                className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving || extracting}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg disabled:opacity-60 cursor-pointer whitespace-nowrap"
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {saving ? 'Extracting & Saving...' : 'Save Application'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
