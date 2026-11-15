import { useRef, useState } from 'react';
import {
  Upload,
  FileText,
  Eye,
  Download,
  CheckCircle2,
  Loader2,
  Clock,
} from 'lucide-react';
import type { ResumeRecord } from '../types.ts';
import { downloadBase64Pdf, fileToBase64, formatReadableDate } from '../lib/dateUtils.ts';
import { parseResumeApi } from '../lib/apiClient.ts';
import {
  loadPdfBase64Chunks,
  saveMasterResumeVersion,
  switchActiveMasterResume,
} from '../lib/firestoreService.ts';
import { PdfPreviewModal } from './PdfPreview.tsx';

interface MyResumeViewProps {
  uid: string;
  resumes: ResumeRecord[];
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
}

export function MyResumeView({
  uid,
  resumes,
  onNotice,
  onError,
}: MyResumeViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [loadingPdfId, setLoadingPdfId] = useState<string | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<{
    fileName: string;
    base64: string;
    subtitle: string;
  } | null>(null);

  const activeResume = resumes.find((r) => r.isActive) || resumes[0] || null;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      onError('Please upload your master resume in PDF format (.pdf).');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      onError('Please upload a PDF file smaller than 10 MB.');
      return;
    }

    setUploading(true);
    try {
      const pdfBase64 = await fileToBase64(file);
      const parsed = await parseResumeApi(pdfBase64);

      await saveMasterResumeVersion({
        uid,
        existingResumes: resumes,
        fileName: file.name,
        mimeType: file.type || 'application/pdf',
        fileSize: file.size,
        pdfBase64,
        extractedText: parsed.extractedText,
        candidateName: parsed.candidateName,
        candidateEmail: parsed.candidateEmail,
        candidatePhone: parsed.candidatePhone,
        originalLocation: parsed.originalLocation,
        locationBox: parsed.locationBox,
      });

      onNotice(`Master resume "${file.name}" saved permanently and set as active.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to upload and process resume.');
    } finally {
      setUploading(false);
    }
  };

  const handlePreview = async (resume: ResumeRecord) => {
    setLoadingPdfId(resume.id);
    try {
      const base64 = await loadPdfBase64Chunks(uid, 'resumes', resume.id);
      if (!base64) {
        onError('Could not retrieve the stored PDF file.');
        return;
      }
      setPreviewData({
        fileName: resume.fileName,
        base64,
        subtitle: `Version ${resume.version} · Uploaded ${formatReadableDate(resume.uploadedAt)}`,
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to load PDF preview.');
    } finally {
      setLoadingPdfId(null);
    }
  };

  const handleDownload = async (resume: ResumeRecord) => {
    setLoadingPdfId(resume.id);
    try {
      const base64 = await loadPdfBase64Chunks(uid, 'resumes', resume.id);
      if (!base64) {
        onError('Could not retrieve the stored PDF file.');
        return;
      }
      downloadBase64Pdf(base64, resume.fileName);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to download PDF.');
    } finally {
      setLoadingPdfId(null);
    }
  };

  const handleSetActive = async (resumeId: string) => {
    setSwitchingId(resumeId);
    try {
      await switchActiveMasterResume(uid, resumes, resumeId);
      onNotice('Active master resume updated for future applications.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to switch active resume.');
    } finally {
      setSwitchingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Master Resume</h2>
          <p className="text-sm text-slate-600 mt-1">
            Upload your master PDF once. Your original file stays untouched, and previous versions
            are preserved whenever you upload an updated resume.
          </p>
        </div>
        <div className="shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            onChange={handleFileChange}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg disabled:opacity-60 cursor-pointer whitespace-nowrap"
          >
            {uploading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Upload className="w-4 h-4" />
            )}
            {uploading
              ? 'Extracting & Saving...'
              : activeResume
                ? 'Upload New Version'
                : 'Upload Master Resume (PDF)'}
          </button>
        </div>
      </div>

      {!activeResume ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
          <FileText className="w-10 h-10 text-slate-400 mx-auto mb-3" />
          <h3 className="text-base font-semibold text-slate-900">No master resume uploaded yet</h3>
          <p className="text-sm text-slate-600 mt-1 max-w-md mx-auto">
            Upload your PDF resume once to extract your verified professional profile and reuse it
            across all job applications.
          </p>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="mt-5 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer"
          >
            <Upload className="w-4 h-4" />
            Upload PDF Resume
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 pb-4 border-b border-slate-200">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs font-medium text-emerald-700">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>Active Master Resume</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">v{activeResume.version}</span>
                </div>
                <h3 className="text-base font-semibold text-slate-900 mt-1 truncate">
                  {activeResume.fileName}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                  Uploaded {formatReadableDate(activeResume.uploadedAt)} ·{' '}
                  {(activeResume.fileSize / 1024).toFixed(1)} KB
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => handlePreview(activeResume)}
                  disabled={loadingPdfId === activeResume.id}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                >
                  {loadingPdfId === activeResume.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Eye className="w-3.5 h-3.5" />
                  )}
                  Preview
                </button>
                <button
                  type="button"
                  onClick={() => handleDownload(activeResume)}
                  disabled={loadingPdfId === activeResume.id}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-xs text-slate-500">Candidate Name</p>
                <p className="font-medium text-slate-900 mt-0.5">
                  {activeResume.candidateName || 'Not detected'}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Original Location on Resume</p>
                <p className="font-medium text-slate-900 mt-0.5">
                  {activeResume.originalLocation || 'Not specified in PDF'}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Email on Resume</p>
                <p className="font-medium text-slate-900 mt-0.5 break-all">
                  {activeResume.candidateEmail || 'Not detected'}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Phone on Resume</p>
                <p className="font-medium text-slate-900 mt-0.5 font-mono tabular-nums">
                  {activeResume.candidatePhone || 'Not detected'}
                </p>
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-slate-700 mb-2">
                Extracted Verified Resume Text (used strictly as ground truth for AI emails)
              </p>
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 max-h-64 overflow-y-auto text-xs text-slate-700 whitespace-pre-wrap leading-relaxed font-mono">
                {activeResume.extractedText}
              </div>
            </div>
          </div>

          <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="text-sm font-semibold text-slate-900">Saved Resume Versions</h3>
              <span className="text-xs text-slate-500 font-mono tabular-nums">
                {resumes.length} {resumes.length === 1 ? 'version' : 'versions'}
              </span>
            </div>

            <div className="divide-y divide-slate-200 mt-2">
              {resumes.map((res) => (
                <div key={res.id} className="py-3.5 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-mono font-semibold text-slate-800">v{res.version}</span>
                      <span aria-hidden="true">·</span>
                      <span className="text-slate-500 font-mono tabular-nums">
                        {formatReadableDate(res.uploadedAt)}
                      </span>
                      {res.isActive && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-medium text-emerald-700">Active</span>
                        </>
                      )}
                    </div>
                    <p className="text-sm font-medium text-slate-900 truncate mt-0.5">
                      {res.fileName}
                    </p>
                    {res.originalLocation && (
                      <p className="text-xs text-slate-500 mt-0.5">
                        Location: {res.originalLocation}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {!res.isActive && (
                      <button
                        type="button"
                        onClick={() => handleSetActive(res.id)}
                        disabled={switchingId === res.id}
                        className="px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 border border-blue-200 rounded-md cursor-pointer whitespace-nowrap"
                      >
                        {switchingId === res.id ? 'Setting...' : 'Use Version'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handlePreview(res)}
                      disabled={loadingPdfId === res.id}
                      className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md cursor-pointer"
                      aria-label={`Preview ${res.fileName}`}
                      title="Preview PDF"
                    >
                      <Eye className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDownload(res)}
                      disabled={loadingPdfId === res.id}
                      className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md cursor-pointer"
                      aria-label={`Download ${res.fileName}`}
                      title="Download PDF"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 pt-3 border-t border-slate-200 flex items-start gap-2 text-xs text-slate-500">
              <Clock className="w-4 h-4 shrink-0 mt-0.5 text-slate-400" />
              <p>
                Uploading a new PDF never deletes past versions. Job applications remain linked to
                the exact version used when you applied.
              </p>
            </div>
          </div>
        </div>
      )}

      {previewData && (
        <PdfPreviewModal
          isOpen={Boolean(previewData)}
          title={previewData.fileName}
          fileName={previewData.fileName}
          base64Data={previewData.base64}
          subtitle={previewData.subtitle}
          onClose={() => setPreviewData(null)}
        />
      )}
    </div>
  );
}
