import { useId } from 'react';

interface BrandLogoProps {
  size?: number;
  className?: string;
}

export function BrandLogo({ size = 32, className = '' }: BrandLogoProps) {
  const gradId = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 ${className}`.trim()}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#2563EB" />
          <stop offset="100%" stopColor="#1E3A8A" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${gradId})`} />
      <path
        d="M8.5 7.5C8.5 6.67157 9.17157 6 10 6H17L21.5 10.5V22.5C21.5 23.3284 20.8284 24 20 24H10C9.17157 24 8.5 23.3284 8.5 22.5V7.5Z"
        fill="#FFFFFF"
      />
      <path d="M17 6V9.75C17 10.1642 17.3358 10.5 17.75 10.5H21.5L17 6Z" fill="#93C5FD" />
      <rect x="11" y="10.5" width="4.5" height="2" rx="1" fill="#1D4ED8" />
      <rect x="11" y="14.25" width="7.5" height="2" rx="1" fill="#1D4ED8" />
      <circle cx="21.5" cy="21.5" r="6.25" fill="#0F172A" stroke="#2563EB" strokeWidth="1.5" />
      <path
        d="M19.25 23.75L23.75 19.25M23.75 19.25H20.25M23.75 19.25V22.75"
        stroke="#FFFFFF"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
