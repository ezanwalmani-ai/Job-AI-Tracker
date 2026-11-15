import { useMemo, useState } from 'react';
import { Search, Plus, Send, Eye } from 'lucide-react';
import type { ApplicationMethod, ApplicationStatus, JobApplicationRecord } from '../types.ts';
import { formatReadableDate, isFollowUpOverdue, isFollowUpDue } from '../lib/dateUtils.ts';

interface MyApplicationsViewProps {
  applications: JobApplicationRecord[];
  onOpenManualModal: () => void;
  onSelectApplication: (app: JobApplicationRecord) => void;
  onTriggerFollowUp: (app: JobApplicationRecord) => void;
}

const STATUS_OPTIONS: Array<'All' | ApplicationStatus> = [
  'All',
  'Applied',
  'Email Sent',
  'Waiting for Response',
  'HR Responded',
  'Interview Scheduled',
  'Offer Received',
  'Rejected',
];

export function statusTextColor(status: ApplicationStatus): string {
  switch (status) {
    case 'Offer Received':
    case 'Interview Scheduled':
      return 'text-emerald-700 font-medium';
    case 'HR Responded':
      return 'text-blue-700 font-medium';
    case 'Email Sent':
    case 'Applied':
    case 'Waiting for Response':
      return 'text-slate-700 font-medium';
    case 'Rejected':
      return 'text-red-700 font-medium';
  }
}

export function MyApplicationsView({
  applications,
  onOpenManualModal,
  onSelectApplication,
  onTriggerFollowUp,
}: MyApplicationsViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [companyFilter, setCompanyFilter] = useState('');
  const [titleFilter, setTitleFilter] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const [methodFilter, setMethodFilter] = useState<'all' | ApplicationMethod>('all');
  const [statusFilter, setStatusFilter] = useState<'All' | ApplicationStatus>('All');
  const [dateFilter, setDateFilter] = useState('');

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const cf = companyFilter.trim().toLowerCase();
    const tf = titleFilter.trim().toLowerCase();
    const lf = locationFilter.trim().toLowerCase();

    return applications.filter((app) => {
      if (q) {
        const hay =
          `${app.companyName} ${app.jobTitle} ${app.jobLocation} ${app.applicationSource} ${app.notes}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (cf && !app.companyName.toLowerCase().includes(cf)) return false;
      if (tf && !app.jobTitle.toLowerCase().includes(tf)) return false;
      if (lf && !app.jobLocation.toLowerCase().includes(lf)) return false;
      if (methodFilter !== 'all' && app.applicationMethod !== methodFilter) return false;
      if (statusFilter !== 'All' && app.applicationStatus !== statusFilter) return false;
      if (dateFilter && app.dateApplied !== dateFilter) return false;
      return true;
    });
  }, [
    applications,
    searchQuery,
    companyFilter,
    titleFilter,
    locationFilter,
    methodFilter,
    statusFilter,
    dateFilter,
  ]);

  const clearFilters = () => {
    setSearchQuery('');
    setCompanyFilter('');
    setTitleFilter('');
    setLocationFilter('');
    setMethodFilter('all');
    setStatusFilter('All');
    setDateFilter('');
  };

  const hasActiveFilters =
    Boolean(searchQuery || companyFilter || titleFilter || locationFilter || dateFilter) ||
    methodFilter !== 'all' ||
    statusFilter !== 'All';

  return (
    <div className="space-y-5">
      {/* Top Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">My Applications</h2>
            <p className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
              Showing {filtered.length} of {applications.length} recorded applications
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenManualModal}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer whitespace-nowrap shrink-0"
          >
            <Plus className="w-4 h-4" />
            Add Manual Application
          </button>
        </div>

        {/* Search & Filters */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="relative sm:col-span-2">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search company, role, location, or notes..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>
          <input
            type="text"
            value={companyFilter}
            onChange={(e) => setCompanyFilter(e.target.value)}
            placeholder="Filter by company"
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
          <input
            type="text"
            value={titleFilter}
            onChange={(e) => setTitleFilter(e.target.value)}
            placeholder="Filter by job title"
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
          <input
            type="text"
            value={locationFilter}
            onChange={(e) => setLocationFilter(e.target.value)}
            placeholder="Filter by location"
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
          <select
            value={methodFilter}
            onChange={(e) => setMethodFilter(e.target.value as 'all' | ApplicationMethod)}
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
          >
            <option value="all">All Methods</option>
            <option value="email">Sent Through Email</option>
            <option value="portal">Job Portal / Manual</option>
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'All' | ApplicationStatus)}
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt === 'All' ? 'All Statuses' : opt}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className="flex-1 px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-300 rounded-lg cursor-pointer whitespace-nowrap"
              >
                Reset
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Application History Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium text-slate-900">
              {applications.length === 0
                ? 'No job applications recorded yet'
                : 'No applications match your filters'}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              {applications.length === 0
                ? 'Apply through Gmail in "Apply for a Job" or record a portal submission via "Add Manual Application".'
                : 'Try adjusting your search query or clearing active filters.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                  <th className="py-3 px-4">Company</th>
                  <th className="py-3 px-4">Job Title</th>
                  <th className="py-3 px-4">Location</th>
                  <th className="py-3 px-4">Applied Date</th>
                  <th className="py-3 px-4">Method</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {filtered.map((app) => {
                  const overdue = isFollowUpOverdue(app);
                  const due = isFollowUpDue(app);
                  return (
                    <tr
                      key={app.id}
                      onClick={() => onSelectApplication(app)}
                      className="hover:bg-slate-50 transition-colors cursor-pointer"
                    >
                      <td className="py-3 px-4 font-medium text-slate-900">
                        {app.companyName}
                      </td>
                      <td className="py-3 px-4 text-slate-700">{app.jobTitle}</td>
                      <td className="py-3 px-4 text-slate-600">{app.jobLocation}</td>
                      <td className="py-3 px-4 font-mono tabular-nums text-xs text-slate-600">
                        {formatReadableDate(app.dateApplied)}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600">
                        {app.applicationMethod === 'email' ? 'Email' : app.applicationSource}
                      </td>
                      <td className="py-3 px-4 text-xs">
                        <div className="flex flex-col">
                          <span className={statusTextColor(app.applicationStatus)}>
                            {app.applicationStatus}
                          </span>
                          {overdue && (
                            <span className="text-red-600 font-mono tabular-nums mt-0.5">
                              Follow-up overdue ({app.followUpDate})
                            </span>
                          )}
                          {!overdue && due && (
                            <span className="text-amber-700 font-mono tabular-nums mt-0.5">
                              Follow-up due today
                            </span>
                          )}
                        </div>
                      </td>
                      <td
                        className="py-3 px-4 text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => onSelectApplication(app)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            View
                          </button>
                          <button
                            type="button"
                            onClick={() => onTriggerFollowUp(app)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-700 bg-white border border-blue-200 rounded-md hover:bg-blue-50 cursor-pointer whitespace-nowrap"
                          >
                            <Send className="w-3.5 h-3.5" />
                            Follow-Up
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
