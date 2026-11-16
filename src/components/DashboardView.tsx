import { useMemo } from 'react';
import {
  FileText,
  Send,
  Plus,
  Mail,
  AlertTriangle,
  Clock,
  ArrowRight,
  Link2,
  BarChart3,
  TrendingUp,
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from 'recharts';
import type {
  EmailConnectionRecord,
  EmailReplyRecord,
  JobApplicationRecord,
  ResumeRecord,
} from '../types.ts';
import {
  addCalendarDays,
  formatReadableDate,
  getTodayIsoDate,
  isFollowUpDue,
  isFollowUpOverdue,
} from '../lib/dateUtils.ts';
import { normalizePortalSource } from '../lib/portalAdapters.ts';
import { statusTextColor } from './MyApplicationsView.tsx';
import { PortalBrandIcon } from './PortalBrandIcon.tsx';

interface DashboardViewProps {
  applications: JobApplicationRecord[];
  activeResume: ResumeRecord | null;
  emailConnection: EmailConnectionRecord | null;
  hasGmailSessionToken: boolean;
  replies: EmailReplyRecord[];
  pendingConfirmationsCount?: number;
  onNavigate: (
    tab: 'dashboard' | 'resume' | 'apply' | 'portals' | 'applications' | 'followups' | 'settings'
  ) => void;
  onNavigateApplicationsWithPortal?: (portalName: string) => void;
  onOpenManualModal: () => void;
  onSelectApplication: (app: JobApplicationRecord) => void;
  onTriggerFollowUp: (app: JobApplicationRecord) => void;
}

export function DashboardView({
  applications,
  activeResume,
  emailConnection,
  hasGmailSessionToken,
  replies,
  pendingConfirmationsCount = 0,
  onNavigate,
  onNavigateApplicationsWithPortal,
  onOpenManualModal,
  onSelectApplication,
  onTriggerFollowUp,
}: DashboardViewProps) {
  const today = getTodayIsoDate();

  const stats = useMemo(() => {
    let linkedin = 0;
    let indeed = 0;
    let naukri = 0;
    let workindia = 0;
    let apna = 0;
    let directEmail = 0;
    let companyWebsite = 0;
    let pendingConfirmation = pendingConfirmationsCount;
    let due = 0;
    let overdue = 0;
    let hrResponded = 0;
    let interviews = 0;
    let offers = 0;

    for (const app of applications) {
      const src = normalizePortalSource(app.applicationSource, app.jobUrl);
      if (app.applicationMethod === 'email' || src === 'Direct Email (Gmail)') {
        directEmail++;
      } else if (src === 'LinkedIn') {
        linkedin++;
      } else if (src === 'Indeed') {
        indeed++;
      } else if (src === 'Naukri') {
        naukri++;
      } else if (src === 'WorkIndia') {
        workindia++;
      } else if (src === 'Apna') {
        apna++;
      } else if (src === 'Company Career Page') {
        companyWebsite++;
      }

      if (
        app.applicationStatus === 'Awaiting Confirmation' ||
        app.applicationStatus === 'Saved' ||
        app.applicationStatus === 'Discovered' ||
        app.needsReview
      ) {
        pendingConfirmation++;
      }
      if (isFollowUpDue(app, today)) due++;
      if (isFollowUpOverdue(app, today)) overdue++;
      if (app.applicationStatus === 'HR Responded') hrResponded++;
      if (app.applicationStatus === 'Interview Scheduled') interviews++;
      if (app.applicationStatus === 'Offer Received') offers++;
    }

    return {
      total: applications.length,
      linkedin,
      indeed,
      naukri,
      workindia,
      apna,
      directEmail,
      companyWebsite,
      pendingConfirmation,
      followUpsDue: due + overdue,
      hrResponded,
      interviews,
      offers,
    };
  }, [applications, today, pendingConfirmationsCount]);

  const attentionApps = useMemo(
    () =>
      applications.filter(
        (app) => isFollowUpOverdue(app, today) || isFollowUpDue(app, today)
      ),
    [applications, today]
  );

  const unreviewedReplies = replies.filter((r) => !r.reviewed).length;

  const statusChartData = useMemo(() => {
    const statusOrder = [
      'Discovered',
      'Saved',
      'Awaiting Confirmation',
      'Applied – Manually Recorded',
      'Applied – Confirmed',
      'Applied',
      'Email Sent',
      'Waiting for Response',
      'Follow-up Due',
      'HR Responded',
      'Interview Scheduled',
      'Offer Received',
      'Rejected',
    ];

    const statusColors: Record<string, string> = {
      Discovered: '#64748b',
      Saved: '#475569',
      'Awaiting Confirmation': '#d97706',
      'Applied – Manually Recorded': '#1d4ed8',
      'Applied – Confirmed': '#059669',
      Applied: '#2563eb',
      'Email Sent': '#1d4ed8',
      'Waiting for Response': '#0284c7',
      'Follow-up Due': '#d97706',
      'HR Responded': '#0d9488',
      'Interview Scheduled': '#10b981',
      'Offer Received': '#047857',
      Rejected: '#dc2626',
    };

    const counts = new Map<string, number>();
    for (const app of applications) {
      const status = app.applicationStatus || 'Applied';
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }

    const orderedStatuses = [
      ...statusOrder.filter((s) => counts.has(s)),
      ...Array.from(counts.keys()).filter((s) => !statusOrder.includes(s)),
    ];

    return orderedStatuses.map((status) => ({
      status,
      count: counts.get(status) ?? 0,
      color: statusColors[status] ?? '#1d4ed8',
    }));
  }, [applications]);

  const timelineChartData = useMemo(() => {
    const validDates = applications
      .map((a) => (a.dateApplied || '').trim().slice(0, 10))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();

    if (validDates.length === 0) {
      return { granularity: 'daily' as const, points: [] as Array<{ label: string; fullDate: string; count: number; cumulative: number }> };
    }

    const countsByDay = new Map<string, number>();
    for (const d of validDates) {
      countsByDay.set(d, (countsByDay.get(d) ?? 0) + 1);
    }

    const minDate = validDates[0];
    const maxAppDate = validDates[validDates.length - 1];
    const endDate = maxAppDate > today ? maxAppDate : today;
    const minWindowStart = addCalendarDays(endDate, -6);
    const startDate = minDate < minWindowStart ? minDate : minWindowStart;

    const msPerDay = 24 * 60 * 60 * 1000;
    const spanDays = Math.round(
      (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / msPerDay
    );

    const monthShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    if (spanDays <= 45) {
      const points: Array<{ label: string; fullDate: string; count: number; cumulative: number }> = [];
      let running = 0;
      for (let offset = 0; offset <= spanDays; offset++) {
        const iso = addCalendarDays(startDate, offset);
        const dayCount = countsByDay.get(iso) ?? 0;
        running += dayCount;
        const [, mm, dd] = iso.split('-');
        const mLabel = monthShort[Math.max(0, Number(mm) - 1)] ?? mm;
        points.push({
          label: `${mLabel} ${Number(dd)}`,
          fullDate: formatReadableDate(iso),
          count: dayCount,
          cumulative: running,
        });
      }
      return { granularity: 'daily' as const, points };
    }

    // Longer histories (> 45 days): group chronologically by month
    const countsByMonth = new Map<string, number>();
    for (const d of validDates) {
      const ym = d.slice(0, 7);
      countsByMonth.set(ym, (countsByMonth.get(ym) ?? 0) + 1);
    }
    const sortedMonths = Array.from(countsByMonth.keys()).sort();
    let running = 0;
    const points = sortedMonths.map((ym) => {
      const monthCount = countsByMonth.get(ym) ?? 0;
      running += monthCount;
      const [yyyy, mm] = ym.split('-');
      const mLabel = monthShort[Math.max(0, Number(mm) - 1)] ?? mm;
      return {
        label: `${mLabel} '${yyyy.slice(2)}`,
        fullDate: `${mLabel} ${yyyy}`,
        count: monthCount,
        cumulative: running,
      };
    });
    return { granularity: 'monthly' as const, points };
  }, [applications, today]);

  const primaryKpis: Array<{
    label: string;
    value: number;
    tone?: 'neutral' | 'amber' | 'red' | 'green';
    onClick?: () => void;
  }> = [
    {
      label: 'Total Applications',
      value: stats.total,
      onClick: () => {
        onNavigateApplicationsWithPortal?.('All');
        onNavigate('applications');
      },
    },
    {
      label: 'Pending Confirmation',
      value: stats.pendingConfirmation,
      tone: stats.pendingConfirmation > 0 ? 'amber' : 'neutral',
      onClick: () => onNavigate('portals'),
    },
    {
      label: 'Follow-ups Due',
      value: stats.followUpsDue,
      tone: stats.followUpsDue > 0 ? 'amber' : 'neutral',
      onClick: () => onNavigate('followups'),
    },
    {
      label: 'HR Responses',
      value: stats.hrResponded,
      onClick: () => onNavigate('applications'),
    },
    {
      label: 'Interviews',
      value: stats.interviews,
      tone: stats.interviews > 0 ? 'green' : 'neutral',
      onClick: () => onNavigate('applications'),
    },
    {
      label: 'Offers Received',
      value: stats.offers,
      tone: stats.offers > 0 ? 'green' : 'neutral',
      onClick: () => onNavigate('applications'),
    },
  ];

  const sourceKpis: Array<{
    label: string;
    portalFilter: string;
    icon: 'linkedin' | 'indeed' | 'naukri' | 'workindia' | 'apna' | 'email' | 'company_career';
    value: number;
  }> = [
    { label: 'LinkedIn', portalFilter: 'LinkedIn', icon: 'linkedin', value: stats.linkedin },
    { label: 'Indeed', portalFilter: 'Indeed', icon: 'indeed', value: stats.indeed },
    { label: 'Naukri', portalFilter: 'Naukri', icon: 'naukri', value: stats.naukri },
    { label: 'WorkIndia', portalFilter: 'WorkIndia', icon: 'workindia', value: stats.workindia },
    { label: 'Apna', portalFilter: 'Apna', icon: 'apna', value: stats.apna },
    {
      label: 'Direct Email',
      portalFilter: 'Direct Email (Gmail)',
      icon: 'email',
      value: stats.directEmail,
    },
    {
      label: 'Company Website',
      portalFilter: 'Company Career Page',
      icon: 'company_career',
      value: stats.companyWebsite,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Quick Action Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-slate-900">Application Overview</h2>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <span>
              Master Resume:{' '}
              <strong className="font-medium text-slate-900">
                {activeResume ? `${activeResume.fileName} (v${activeResume.version})` : 'Not uploaded'}
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Gmail:{' '}
              <strong
                className={`font-medium ${
                  hasGmailSessionToken && emailConnection?.status === 'connected'
                    ? 'text-emerald-700'
                    : 'text-amber-700'
                }`}
              >
                {hasGmailSessionToken && emailConnection?.status === 'connected'
                  ? emailConnection.connectedEmail
                  : 'Needs connection'}
              </strong>
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {!activeResume && (
            <button
              type="button"
              onClick={() => onNavigate('resume')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
            >
              <FileText className="w-3.5 h-3.5" />
              Upload Resume
            </button>
          )}
          <button
            type="button"
            onClick={() => onNavigate('portals')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
          >
            <Link2 className="w-3.5 h-3.5" />
            Connected Portals
          </button>
          <button
            type="button"
            onClick={onOpenManualModal}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Manual Application
          </button>
          <button
            type="button"
            onClick={() => onNavigate('apply')}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer whitespace-nowrap"
          >
            <Mail className="w-3.5 h-3.5" />
            Apply for a Job
          </button>
        </div>
      </div>

      {/* Primary Pipeline KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {primaryKpis.map((item) => {
          const valColor =
            item.tone === 'red'
              ? 'text-red-700'
              : item.tone === 'amber'
                ? 'text-amber-700'
                : item.tone === 'green'
                  ? 'text-emerald-700'
                  : 'text-slate-900';

          return (
            <button
              key={item.label}
              type="button"
              onClick={item.onClick}
              className="text-left bg-white border border-slate-200 rounded-xl p-4 hover:border-slate-300 transition-colors cursor-pointer"
            >
              <p className="text-xs text-slate-500">{item.label}</p>
              <p className={`text-2xl font-semibold font-mono tabular-nums mt-1.5 ${valColor}`}>
                {item.value}
              </p>
            </button>
          );
        })}
      </div>

      {/* Applications by Portal & Direct Channels */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">
            Applications by Portal &amp; Channel
          </h3>
          <button
            type="button"
            onClick={() => onNavigate('portals')}
            className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline cursor-pointer"
          >
            Manage Connected Portals
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {sourceKpis.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => onNavigateApplicationsWithPortal?.(item.portalFilter)}
              className="text-left bg-slate-50 border border-slate-200 rounded-lg p-3 hover:bg-slate-100 transition-colors cursor-pointer flex items-center gap-2.5"
            >
              <PortalBrandIcon portalId={item.icon} size={30} />
              <div className="min-w-0">
                <p className="text-[11px] text-slate-600 truncate">{item.label}</p>
                <p className="text-lg font-semibold font-mono tabular-nums text-slate-900">
                  {item.value}
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Pipeline Analytics Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Bar Chart: Applications by Status */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-blue-700" />
              <h3 className="text-sm font-semibold text-slate-900">Applications by Status</h3>
            </div>
            <span className="text-xs text-slate-500 font-mono tabular-nums">
              {applications.length} total
            </span>
          </div>

          {statusChartData.length === 0 ? (
            <div className="h-64 flex items-center justify-center border border-dashed border-slate-200 rounded-lg bg-slate-50/50 px-4 text-center">
              <p className="text-xs text-slate-500">
                No applications recorded yet. Status distribution will appear here once you add an application.
              </p>
            </div>
          ) : (
            <div className="h-64 w-full min-w-0">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart
                  data={statusChartData}
                  layout="vertical"
                  margin={{ top: 4, right: 20, left: 8, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis
                    type="number"
                    allowDecimals={false}
                    tick={{ fontSize: 11, fill: '#64748b' }}
                    axisLine={{ stroke: '#cbd5e1' }}
                    tickLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="status"
                    width={168}
                    tick={{ fontSize: 11, fill: '#334155' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    cursor={{ fill: '#f8fafc' }}
                    contentStyle={{
                      backgroundColor: '#ffffff',
                      borderColor: '#e2e8f0',
                      borderRadius: '0.5rem',
                      fontSize: '12px',
                      boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.08)',
                    }}
                    formatter={(value) => [`${value ?? 0} application(s)`, 'Count']}
                  />
                  <Bar dataKey="count" name="Applications" radius={[0, 4, 4, 0]} maxBarSize={24}>
                    {statusChartData.map((entry) => (
                      <Cell key={entry.status} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Trend Line: Applications over Time */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-blue-700" />
              <h3 className="text-sm font-semibold text-slate-900">Applications over Time</h3>
            </div>
            <span className="text-xs text-slate-500">
              {timelineChartData.granularity === 'monthly' ? 'Monthly trend' : 'Daily trend'}
            </span>
          </div>

          {timelineChartData.points.length === 0 ? (
            <div className="h-64 flex items-center justify-center border border-dashed border-slate-200 rounded-lg bg-slate-50/50 px-4 text-center">
              <p className="text-xs text-slate-500">
                No dated applications yet. Your submission trend line will appear here after your first application.
              </p>
            </div>
          ) : (
            <div className="h-64 w-full min-w-0">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <LineChart
                  data={timelineChartData.points}
                  margin={{ top: 8, right: 20, left: 0, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: '#64748b' }}
                    axisLine={{ stroke: '#cbd5e1' }}
                    tickLine={false}
                    minTickGap={16}
                  />
                  <YAxis
                    allowDecimals={false}
                    width={32}
                    tick={{ fontSize: 11, fill: '#64748b' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#ffffff',
                      borderColor: '#e2e8f0',
                      borderRadius: '0.5rem',
                      fontSize: '12px',
                      boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.08)',
                    }}
                    labelFormatter={(_, payload) =>
                      payload && payload[0]?.payload?.fullDate
                        ? String(payload[0].payload.fullDate)
                        : ''
                    }
                    formatter={(value, name) => [
                      `${value ?? 0} application(s)`,
                      name === 'cumulative' ? 'Cumulative Total' : 'Submitted',
                    ]}
                  />
                  <Line
                    type="monotone"
                    dataKey="count"
                    name="Submitted"
                    stroke="#1d4ed8"
                    strokeWidth={2.5}
                    dot={{ r: 3.5, fill: '#1d4ed8', strokeWidth: 1.5, stroke: '#ffffff' }}
                    activeDot={{ r: 5.5, fill: '#1d4ed8', strokeWidth: 2, stroke: '#ffffff' }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      {/* Attention Queue & Unreviewed Replies */}
      {(attentionApps.length > 0 || unreviewedReplies > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {attentionApps.length > 0 && (
            <div
              className={`${
                unreviewedReplies > 0 ? 'lg:col-span-8' : 'lg:col-span-12'
              } bg-white border border-slate-200 rounded-xl p-5 space-y-3`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-amber-600" />
                  <h3 className="text-sm font-semibold text-slate-900">
                    Follow-Ups Due &amp; Overdue ({attentionApps.length})
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate('followups')}
                  className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline cursor-pointer"
                >
                  Open Follow-up Manager
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="divide-y divide-slate-200">
                {attentionApps.slice(0, 5).map((app) => {
                  const overdue = isFollowUpOverdue(app, today);
                  return (
                    <div
                      key={app.id}
                      className="py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
                    >
                      <div
                        className="min-w-0 cursor-pointer"
                        onClick={() => onSelectApplication(app)}
                      >
                        <p className="text-sm font-medium text-slate-900 truncate">
                          {app.companyName} — {app.jobTitle}
                        </p>
                        <p className="text-xs text-slate-500 font-mono tabular-nums">
                          Applied {formatReadableDate(app.dateApplied)} ·{' '}
                          <span className={overdue ? 'text-red-600 font-medium' : 'text-amber-700 font-medium'}>
                            {overdue ? `Overdue (${app.followUpDate})` : 'Due today'}
                          </span>
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => onTriggerFollowUp(app)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <Send className="w-3.5 h-3.5" />
                        Follow-Up
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {unreviewedReplies > 0 && (
            <div
              className={`${
                attentionApps.length > 0 ? 'lg:col-span-4' : 'lg:col-span-12'
              } bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4`}
            >
              <div>
                <div className="flex items-center gap-2 text-amber-700">
                  <AlertTriangle className="w-4 h-4" />
                  <h3 className="text-sm font-semibold text-slate-900">
                    Replies Pending Review
                  </h3>
                </div>
                <p className="text-xs text-slate-600 mt-2 leading-relaxed">
                  You have{' '}
                  <strong className="font-mono tabular-nums text-slate-900">
                    {unreviewedReplies}
                  </strong>{' '}
                  incoming email reply(s) that need manual confirmation before linking to an
                  application.
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('settings')}
                className="px-3.5 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer self-start"
              >
                Review Replies in Email Settings
              </button>
            </div>
          )}
        </div>
      )}

      {/* Recent Applications */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">Recent Applications</h3>
          <button
            type="button"
            onClick={() => onNavigate('applications')}
            className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline cursor-pointer"
          >
            View All
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {applications.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium text-slate-900">Your application history is empty</p>
            <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
              Start by uploading your master resume, then prepare a job-specific email application
              or log a job you submitted through a portal.
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
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {applications.slice(0, 8).map((app) => (
                  <tr
                    key={app.id}
                    onClick={() => onSelectApplication(app)}
                    className="hover:bg-slate-50 cursor-pointer"
                  >
                    <td className="py-3 px-4 font-medium text-slate-900">{app.companyName}</td>
                    <td className="py-3 px-4 text-slate-700">{app.jobTitle}</td>
                    <td className="py-3 px-4 text-slate-600">{app.jobLocation}</td>
                    <td className="py-3 px-4 font-mono tabular-nums text-xs text-slate-600">
                      {formatReadableDate(app.dateApplied)}
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-600">
                      {app.applicationMethod === 'email' ? 'Email' : app.applicationSource}
                    </td>
                    <td className="py-3 px-4 text-xs">
                      <span className={statusTextColor(app.applicationStatus)}>
                        {app.applicationStatus}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
