import type { JobApplicationRecord } from '../types.ts';

export function getTodayIsoDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addCalendarDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) {
    const dt = new Date();
    dt.setDate(dt.getDate() + days);
    return dt.toISOString().slice(0, 10);
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function formatReadableDate(isoDate: string): string {
  if (!isoDate) return '—';
  const parsed = new Date(isoDate.length === 10 ? `${isoDate}T00:00:00` : isoDate);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return parsed.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function isTerminalStatus(status: JobApplicationRecord['applicationStatus']): boolean {
  return status === 'Rejected' || status === 'Offer Received';
}

export function isFollowUpDue(app: JobApplicationRecord, today = getTodayIsoDate()): boolean {
  if (!app.followUpDate || isTerminalStatus(app.applicationStatus)) return false;
  if (app.applicationStatus === 'HR Responded' || app.applicationStatus === 'Interview Scheduled') {
    return false;
  }
  return app.followUpDate === today;
}

export function isFollowUpOverdue(app: JobApplicationRecord, today = getTodayIsoDate()): boolean {
  if (!app.followUpDate || isTerminalStatus(app.applicationStatus)) return false;
  if (app.applicationStatus === 'HR Responded' || app.applicationStatus === 'Interview Scheduled') {
    return false;
  }
  return app.followUpDate < today;
}

export function downloadBase64Pdf(base64: string, fileName: string): void {
  const byteChars = atob(base64);
  const byteNums = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteNums[i] = byteChars.charCodeAt(i);
  }
  const blob = new Blob([new Uint8Array(byteNums)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName || 'resume.pdf';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}
