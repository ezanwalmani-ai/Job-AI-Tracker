import type { PortalId } from '../types.ts';

interface PortalBrandIconProps {
  portalId: PortalId | 'email';
  size?: number;
}

export function PortalBrandIcon({ portalId, size = 36 }: PortalBrandIconProps) {
  const style = { width: size, height: size };

  switch (portalId) {
    case 'linkedin':
      return (
        <div
          style={style}
          className="rounded-lg bg-[#0A66C2] text-white flex items-center justify-center font-bold text-sm tracking-tight shrink-0"
          aria-hidden="true"
        >
          in
        </div>
      );
    case 'indeed':
      return (
        <div
          style={style}
          className="rounded-lg bg-[#2557A7] text-white flex items-center justify-center shrink-0"
          aria-hidden="true"
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current">
            <circle cx="12" cy="5.5" r="2.3" />
            <path d="M10.2 10h3.6v9.5a1.8 1.8 0 1 1-3.6 0V10Z" />
          </svg>
        </div>
      );
    case 'naukri':
      return (
        <div
          style={style}
          className="rounded-lg bg-[#275DF5] text-white flex items-center justify-center font-bold text-sm shrink-0"
          aria-hidden="true"
        >
          N
        </div>
      );
    case 'workindia':
      return (
        <div
          style={style}
          className="rounded-lg bg-[#0F766E] text-white flex items-center justify-center font-bold text-xs tracking-tight shrink-0"
          aria-hidden="true"
        >
          WI
        </div>
      );
    case 'apna':
      return (
        <div
          style={style}
          className="rounded-lg bg-[#6D28D9] text-white flex items-center justify-center font-bold text-xs tracking-tight shrink-0"
          aria-hidden="true"
        >
          apna
        </div>
      );
    case 'email':
      return (
        <div
          style={style}
          className="rounded-lg bg-blue-700 text-white flex items-center justify-center shrink-0"
          aria-hidden="true"
        >
          <svg viewBox="0 0 24 24" className="w-4 h-4 stroke-current fill-none" strokeWidth="2">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="m3 7 9 6 9-6" />
          </svg>
        </div>
      );
    case 'company_career':
    default:
      return (
        <div
          style={style}
          className="rounded-lg bg-slate-800 text-white flex items-center justify-center shrink-0"
          aria-hidden="true"
        >
          <svg viewBox="0 0 24 24" className="w-4 h-4 stroke-current fill-none" strokeWidth="2">
            <path d="M3 21h18M5 21V7l7-4 7 4v14M9 11h1M14 11h1M9 15h1M14 15h1" />
          </svg>
        </div>
      );
  }
}
