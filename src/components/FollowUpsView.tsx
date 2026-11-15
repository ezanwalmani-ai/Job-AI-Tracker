import { useMemo, useState } from 'react';
import { Send, Calendar, Save, CheckCircle2 } from 'lucide-react';
import type { FollowUpRecord, JobApplicationRecord } from '../types.ts';
import {
  formatReadableDate,
  getTodayIsoDate,
  isFollowUpDue,
  isFollowUpOverdue,
} from '../lib/dateUtils.ts';
import { updateUserProfile } from '../lib/firestoreService.ts';
import { statusTextColor } from './MyApplicationsView.tsx';

interface FollowUpsViewProps {
  uid: string;
  applications: JobApplicationRecord[];
  followUps: FollowUpRecord[];
  defaultFollowUpDays: number;
  onTriggerFollowUp: (app: JobApplicationRecord) => void;
  onSelectApplication: (app: JobApplicationRecord) => void;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
}

type CategoryKey =
  | 'all'
  | 'applied_today'
  | 'due'
  | 'overdue'
  | 'waiting'
  | 'hr_responded'
  | 'interview'
  | 'rejected'
  | 'offer';

const CATEGORIES: Array<{ key: CategoryKey; label: string }> = [
  { key: 'all', label: 'All Applications' },
  { key: 'applied_today', label: 'Applied Today' },
  { key: 'due', label: 'Follow-up Due' },
  { key: 'overdue', label: 'Follow-up Overdue' },
  { key: 'waiting', label: 'Waiting for Response' },
  { key: 'hr_responded', label: 'HR Responded' },
  { key: 'interview', label: 'Interview Scheduled' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'offer', label: 'Offer Received' },
];

export function FollowUpsView({
  uid,
  applications,
  followUps,
  defaultFollowUpDays,
  onTriggerFollowUp,
  onSelectApplication,
  onNotice,
  onError,
}: FollowUpsViewProps) {
  const [category, setCategory] = useState<CategoryKey>('all');
  const [intervalInput, setIntervalInput] = useState(defaultFollowUpDays);
  const [savingInterval, setSavingInterval] = useState(false);

  const today = getTodayIsoDate();

  const counts = useMemo(() => {
    const map: Record<CategoryKey, number> = {
      all: applications.length,
      applied_today: 0,
      due: 0,
      overdue: 0,
      waiting: 0,
      hr_responded: 0,
      interview: 0,
      rejected: 0,
      offer: 0,
    };
    for (const app of applications) {
      if (app.dateApplied === today) map.applied_today++;
      if (isFollowUpDue(app, today)) map.due++;
      if (isFollowUpOverdue(app, today)) map.overdue++;
      if (
        app.applicationStatus === 'Waiting for Response' ||
        app.applicationStatus === 'Email Sent' ||
        app.applicationStatus === 'Applied'
      ) {
        map.waiting++;
      }
      if (app.applicationStatus === 'HR Responded') map.hr_responded++;
      if (app.applicationStatus === 'Interview Scheduled') map.interview++;
      if (app.applicationStatus === 'Rejected') map.rejected++;
      if (app.applicationStatus === 'Offer Received') map.offer++;
    }
    return map;
  }, [applications, today]);

  const filteredApps = useMemo(() => {
    return applications.filter((app) => {
      switch (category) {
        case 'applied_today':
          return app.dateApplied === today;
        case 'due':
          return isFollowUpDue(app, today);
        case 'overdue':
          return isFollowUpOverdue(app, today);
        case 'waiting':
          return (
            app.applicationStatus === 'Waiting for Response' ||
            app.applicationStatus === 'Email Sent' ||
            app.applicationStatus === 'Applied'
          );
        case 'hr_responded':
          return app.applicationStatus === 'HR Responded';
        case 'interview':
          return app.applicationStatus === 'Interview Scheduled';
        case 'rejected':
          return app.applicationStatus === 'Rejected';
        case 'offer':
          return app.applicationStatus === 'Offer Received';
        default:
          return true;
      }
    });
  }, [applications, category, today]);

  const handleSaveInterval = async () => {
    const days = Math.min(60, Math.max(1, Number(intervalInput) || 7));
    setSavingInterval(true);
    try {
      await updateUserProfile(uid, { defaultFollowUpDays: days });
      setIntervalInput(days);
      onNotice(`Default follow-up interval updated to ${days} calendar days.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to update interval.');
    } finally {
      setSavingInterval(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Configurable Interval */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Follow-Up Manager</h2>
          <p className="text-sm text-slate-600 mt-1">
            Stay on top of pending applications. Follow-up emails are drafted by AI and only sent
            after your review and click.
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0 bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-2">
          <Calendar className="w-4 h-4 text-slate-500" />
          <label htmlFor="follow-up-days" className="text-xs font-medium text-slate-700 whitespace-nowrap">
            Default interval (days):
          </label>
          <input
            id="follow-up-days"
            type="number"
            min={1}
            max={60}
            value={intervalInput}
            onChange={(e) => setIntervalInput(Number(e.target.value))}
            className="w-16 px-2 py-1 text-xs font-mono border border-slate-300 rounded bg-white text-center"
          />
          <button
            type="button"
            onClick={handleSaveInterval}
            disabled={savingInterval}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded cursor-pointer whitespace-nowrap"
          >
            <Save className="w-3 h-3" />
            Save
          </button>
        </div>
      </div>

      {/* Category Tabs */}
      <div className="flex flex-wrap gap-1.5 p-1.5 bg-slate-100 rounded-xl border border-slate-200">
        {CATEGORIES.map((cat) => {
          const active = category === cat.key;
          return (
            <button
              key={cat.key}
              type="button"
              onClick={() => setCategory(cat.key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
                active
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {cat.label}{' '}
              <span className="font-mono tabular-nums text-slate-400 ml-1">
                {counts[cat.key]}
              </span>
            </button>
          );
        })}
      </div>

      {/* Application Follow-Up Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {filteredApps.length === 0 ? (
          <div className="p-10 text-center">
            <CheckCircle2 className="w-8 h-8 text-slate-300 mx-auto mb-2" />
            <p className="text-sm font-medium text-slate-900">No applications in this category</p>
            <p className="text-xs text-slate-500 mt-1">
              Select another follow-up category or apply to a job to track follow-up dates.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                  <th className="py-3 px-4">Company &amp; Role</th>
                  <th className="py-3 px-4">Date Applied</th>
                  <th className="py-3 px-4">Last Comm.</th>
                  <th className="py-3 px-4">Next Follow-Up</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Follow-Ups</th>
                  <th className="py-3 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {filteredApps.map((app) => {
                  const overdue = isFollowUpOverdue(app, today);
                  const due = isFollowUpDue(app, today);
                  const countForApp = followUps.filter(
                    (f) => f.applicationId === app.id
                  ).length;

                  return (
                    <tr
                      key={app.id}
                      onClick={() => onSelectApplication(app)}
                      className="hover:bg-slate-50 cursor-pointer"
                    >
                      <td className="py-3 px-4">
                        <p className="font-medium text-slate-900">{app.companyName}</p>
                        <p className="text-xs text-slate-500">{app.jobTitle}</p>
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-xs text-slate-600">
                        {formatReadableDate(app.dateApplied)}
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-xs text-slate-600">
                        {formatReadableDate(app.lastCommunicationDate || app.dateApplied)}
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-xs">
                        <span
                          className={
                            overdue
                              ? 'text-red-700 font-semibold'
                              : due
                                ? 'text-amber-700 font-semibold'
                                : 'text-slate-700'
                          }
                        >
                          {formatReadableDate(app.followUpDate)}
                        </span>
                        {overdue && (
                          <span className="block text-[11px] text-red-600">Overdue</span>
                        )}
                        {!overdue && due && (
                          <span className="block text-[11px] text-amber-700">Due today</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-xs">
                        <span className={statusTextColor(app.applicationStatus)}>
                          {app.applicationStatus}
                        </span>
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-xs text-slate-600">
                        {countForApp}
                      </td>
                      <td
                        className="py-3 px-4 text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() => onTriggerFollowUp(app)}
                          disabled={
                            app.applicationStatus === 'Rejected' ||
                            app.applicationStatus === 'Offer Received'
                          }
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg disabled:opacity-40 cursor-pointer whitespace-nowrap"
                        >
                          <Send className="w-3.5 h-3.5" />
                          Follow-Up
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Follow-Up Communication Log */}
      {followUps.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
          <h3 className="text-sm font-semibold text-slate-900">Recent Follow-Up History</h3>
          <div className="divide-y divide-slate-200">
            {followUps.slice(0, 10).map((fu) => {
              const app = applications.find((a) => a.id === fu.applicationId);
              return (
                <div key={fu.id} className="py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs">
                  <div>
                    <p className="font-medium text-slate-900">
                      {app ? `${app.companyName} — ${app.jobTitle}` : fu.emailSubject}
                    </p>
                    <p className="text-slate-600 mt-0.5">{fu.outcome}</p>
                  </div>
                  <div className="font-mono tabular-nums text-slate-500 shrink-0">
                    {formatReadableDate(fu.followUpDate)} · {fu.status}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
