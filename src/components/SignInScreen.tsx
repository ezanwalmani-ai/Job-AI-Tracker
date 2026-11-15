import { FileCheck2, Mail, CalendarClock, ShieldCheck } from 'lucide-react';
import { BrandLogo } from './BrandLogo.tsx';

interface SignInScreenProps {
  onSignIn: () => void;
  isLoading: boolean;
  errorMessage: string;
}

export function SignInScreen({
  onSignIn,
  isLoading,
  errorMessage,
}: SignInScreenProps) {
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center px-6 py-12">
      <div className="max-w-4xl mx-auto w-full grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
        <div className="lg:col-span-7 space-y-6">
          <div>
            <div className="flex items-center gap-3.5">
              <BrandLogo size={44} />
              <div>
                <p className="text-xs font-medium text-blue-700 tracking-wide">
                  Personal Job Application Workspace
                </p>
                <h1 className="text-3xl sm:text-4xl font-semibold text-slate-900 tracking-tight text-balance">
                  My Job Tracker
                </h1>
              </div>
            </div>
            <p className="text-base text-slate-600 mt-3 leading-relaxed max-w-xl">
              Upload your master resume once, prepare location-specific PDF applications, send
              personalized emails through your Gmail account, and keep every follow-up on schedule.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <FileCheck2 className="w-5 h-5 text-blue-700 mb-2" />
              <h2 className="text-sm font-semibold text-slate-900">Master Resume Storage</h2>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                Keep your original PDF intact and generate job-location updates without altering
                experience or skills.
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <Mail className="w-5 h-5 text-blue-700 mb-2" />
              <h2 className="text-sm font-semibold text-slate-900">Direct Gmail Sending</h2>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                Draft tailored emails grounded in your resume, review before sending, and attach
                the right PDF automatically.
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <CalendarClock className="w-5 h-5 text-blue-700 mb-2" />
              <h2 className="text-sm font-semibold text-slate-900">Follow-Up Manager</h2>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                Track both email and portal applications with automatic follow-up reminders and HR
                reply detection.
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <ShieldCheck className="w-5 h-5 text-blue-700 mb-2" />
              <h2 className="text-sm font-semibold text-slate-900">Private &amp; Secure</h2>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                Signed-in workspace using Google OAuth. No passwords stored, and emails are only
                sent when you click Send.
              </p>
            </div>
          </div>
        </div>

        <div className="lg:col-span-5">
          <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">Sign in to your tracker</h2>
            <p className="text-sm text-slate-600 mt-1.5 leading-relaxed">
              Sign in with Google to access your saved resumes, application history, and Gmail
              sending permissions.
            </p>

            {errorMessage && (
              <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                {errorMessage}
              </div>
            )}

            <div className="mt-6">
              <button
                type="button"
                onClick={onSignIn}
                disabled={isLoading}
                className="gsi-material-button w-full"
              >
                <div className="gsi-material-button-state" />
                <div className="gsi-material-button-content-wrapper">
                  <div className="gsi-material-button-icon">
                    <svg
                      version="1.1"
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 48 48"
                      style={{ display: 'block' }}
                    >
                      <path
                        fill="#EA4335"
                        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                      />
                      <path
                        fill="#4285F4"
                        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                      />
                      <path
                        fill="#34A853"
                        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                      />
                      <path fill="none" d="M0 0h48v48H0z" />
                    </svg>
                  </div>
                  <span className="gsi-material-button-contents">
                    {isLoading ? 'Signing in...' : 'Sign in with Google'}
                  </span>
                </div>
              </button>
            </div>

            <div className="mt-5 pt-4 border-t border-slate-200 text-xs text-slate-500 space-y-1.5">
              <p className="font-medium text-slate-700">Requested Gmail permissions:</p>
              <p>1. Send application and follow-up emails on your click.</p>
              <p>2. Optional read-only check for HR replies to tracked applications.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
