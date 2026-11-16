import { useRef, useState } from 'react';
import {
  Upload,
  FileText,
  Eye,
  Download,
  CheckCircle2,
  Loader2,
  Clock,
  Pencil,
  FilePlus2,
  X,
  Save,
} from 'lucide-react';
import type { ResumeRecord } from '../types.ts';
import { downloadBase64Pdf, fileToBase64, formatReadableDate } from '../lib/dateUtils.ts';
import { buildResumePdfApi, parseResumeApi } from '../lib/apiClient.ts';
import {
  loadPdfBase64Chunks,
  saveMasterResumeVersion,
  switchActiveMasterResume,
  updateManualResumeDetails,
} from '../lib/firestoreService.ts';
import { PdfPreviewModal } from './PdfPreview.tsx';

interface MyResumeViewProps {
  uid: string;
  resumes: ResumeRecord[];
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
}

interface EditorState {
  mode: 'edit' | 'create';
  resumeId: string;
  version: number;
  fileName: string;
  candidateName: string;
  candidateEmail: string;
  candidatePhone: string;
  originalLocation: string;
  extractedText: string;
}

const STARTER_MANUAL_TEMPLATE = `PROFESSIONAL SUMMARY
Results-driven professional with experience in procurement, vendor management, and cross-functional operations.

CORE SKILLS
- Vendor Negotiation & Purchasing
- Order Management & Inventory Control
- ERP / SAP MM & Excel Reporting

WORK EXPERIENCE
Purchase Executive | Company Name (City, State)
2023 - Present
- Managed end-to-end purchase requisitions, supplier quotes, and purchase order fulfillment.
- Negotiated pricing and delivery timelines with approved vendors to reduce lead times.

EDUCATION
Bachelor's Degree | University Name`;

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
  const [savingEditMode, setSavingEditMode] = useState<'metadata' | 'rebuild' | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
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

  const openEditModal = (resume: ResumeRecord) => {
    setEditor({
      mode: 'edit',
      resumeId: resume.id,
      version: resume.version,
      fileName: resume.fileName,
      candidateName: resume.candidateName,
      candidateEmail: resume.candidateEmail,
      candidatePhone: resume.candidatePhone,
      originalLocation: resume.originalLocation,
      extractedText: resume.extractedText,
    });
  };

  const openCreateModal = () => {
    setEditor({
      mode: 'create',
      resumeId: '',
      version: resumes.reduce((max, r) => Math.max(max, r.version || 0), 0) + 1,
      fileName: 'Master_Resume.pdf',
      candidateName: activeResume?.candidateName || '',
      candidateEmail: activeResume?.candidateEmail || '',
      candidatePhone: activeResume?.candidatePhone || '',
      originalLocation: activeResume?.originalLocation || '',
      extractedText: STARTER_MANUAL_TEMPLATE,
    });
  };

  const handleSaveMetadataOnly = async () => {
    if (!editor || editor.mode !== 'edit') return;
    if (!editor.candidateName.trim()) {
      onError('Candidate name is required.');
      return;
    }
    if (editor.extractedText.trim().length < 20) {
      onError('Please enter at least 20 characters of resume text.');
      return;
    }

    setSavingEditMode('metadata');
    try {
      await updateManualResumeDetails({
        uid,
        resumeId: editor.resumeId,
        fileName: editor.fileName,
        candidateName: editor.candidateName,
        candidateEmail: editor.candidateEmail,
        candidatePhone: editor.candidatePhone,
        originalLocation: editor.originalLocation,
        extractedText: editor.extractedText,
      });
      setEditor(null);
      onNotice('Resume details and verified text updated (original PDF kept intact).');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to update resume details.');
    } finally {
      setSavingEditMode(null);
    }
  };

  const handleRebuildPdfAndSaveVersion = async () => {
    if (!editor) return;
    if (!editor.candidateName.trim()) {
      onError('Candidate name is required before generating a PDF.');
      return;
    }
    if (editor.extractedText.trim().length < 20) {
      onError('Please enter at least 20 characters of resume content.');
      return;
    }

    setSavingEditMode('rebuild');
    try {
      const built = await buildResumePdfApi({
        candidateName: editor.candidateName.trim(),
        candidateEmail: editor.candidateEmail.trim(),
        candidatePhone: editor.candidatePhone.trim(),
        originalLocation: editor.originalLocation.trim(),
        resumeText: editor.extractedText.trim(),
        fileName: editor.fileName.trim() || 'Master_Resume.pdf',
      });

      await saveMasterResumeVersion({
        uid,
        existingResumes: resumes,
        fileName: built.fileName,
        mimeType: 'application/pdf',
        fileSize: built.fileSize,
        pdfBase64: built.pdfBase64,
        extractedText: built.extractedText,
        candidateName: built.candidateName,
        candidateEmail: built.candidateEmail,
        candidatePhone: built.candidatePhone,
        originalLocation: built.originalLocation,
        locationBox: built.locationBox,
      });

      setEditor(null);
      onNotice(`Built "${built.fileName}" and saved as your new active master resume.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to build and save resume PDF.');
    } finally {
      setSavingEditMode(null);
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
            Upload your master PDF once, or create and edit your resume manually anytime. Previous
            versions remain preserved whenever you save an updated version.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={openCreateModal}
            disabled={uploading || savingEditMode !== null}
            className="inline-flex items-center gap-2 px-3.5 py-2.5 text-sm font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg disabled:opacity-60 cursor-pointer whitespace-nowrap"
          >
            <FilePlus2 className="w-4 h-4" />
            Create Manually
          </button>
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
            disabled={uploading || savingEditMode !== null}
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
            Upload your PDF resume once or write one manually to extract your verified professional
            profile and reuse it across all job applications.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer"
            >
              <Upload className="w-4 h-4" />
              Upload PDF Resume
            </button>
            <button
              type="button"
              onClick={openCreateModal}
              disabled={uploading}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer"
            >
              <FilePlus2 className="w-4 h-4" />
              Create Resume Manually
            </button>
          </div>
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
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => openEditModal(activeResume)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 cursor-pointer whitespace-nowrap"
                >
                  <Pencil className="w-3.5 h-3.5" />
                  Edit Resume
                </button>
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
              <div className="flex items-center justify-between gap-2 mb-2">
                <p className="text-xs font-medium text-slate-700">
                  Extracted Verified Resume Text (used strictly as ground truth for AI emails)
                </p>
                <button
                  type="button"
                  onClick={() => openEditModal(activeResume)}
                  className="text-xs font-medium text-blue-700 hover:underline cursor-pointer"
                >
                  Edit text manually
                </button>
              </div>
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
                      onClick={() => openEditModal(res)}
                      className="p-1.5 text-slate-600 hover:text-blue-700 hover:bg-blue-50 rounded-md cursor-pointer"
                      aria-label={`Edit ${res.fileName}`}
                      title="Edit Resume Manually"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
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
                Uploading or rebuilding a PDF never deletes past versions. Job applications remain
                linked to the exact version used when you applied.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Manual Resume Editor / Builder Modal */}
      {editor && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl shadow-xl w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  {editor.mode === 'create'
                    ? 'Create Master Resume Manually'
                    : `Edit Resume (v${editor.version})`}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {editor.mode === 'create'
                    ? 'Fill in your contact details and resume sections below to build a downloadable A4 PDF.'
                    : 'Fix contact details or resume text for email drafting, or rebuild a new PDF version from your edits.'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => savingEditMode === null && setEditor(null)}
                disabled={savingEditMode !== null}
                className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg cursor-pointer"
                aria-label="Close resume editor"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Candidate Full Name *
                  </label>
                  <input
                    type="text"
                    value={editor.candidateName}
                    onChange={(e) =>
                      setEditor((prev) => (prev ? { ...prev, candidateName: e.target.value } : prev))
                    }
                    placeholder="e.g., Mohammed Ezhan Walmani"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Resume File Name
                  </label>
                  <input
                    type="text"
                    value={editor.fileName}
                    onChange={(e) =>
                      setEditor((prev) => (prev ? { ...prev, fileName: e.target.value } : prev))
                    }
                    placeholder="e.g., Master_Resume.pdf"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Email Address
                  </label>
                  <input
                    type="email"
                    value={editor.candidateEmail}
                    onChange={(e) =>
                      setEditor((prev) =>
                        prev ? { ...prev, candidateEmail: e.target.value } : prev
                      )
                    }
                    placeholder="you@example.com"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Phone Number
                  </label>
                  <input
                    type="text"
                    value={editor.candidatePhone}
                    onChange={(e) =>
                      setEditor((prev) =>
                        prev ? { ...prev, candidatePhone: e.target.value } : prev
                      )
                    }
                    placeholder="e.g., +91 9876543210"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Original Location on Resume
                  </label>
                  <input
                    type="text"
                    value={editor.originalLocation}
                    onChange={(e) =>
                      setEditor((prev) =>
                        prev ? { ...prev, originalLocation: e.target.value } : prev
                      )
                    }
                    placeholder="e.g., Pune, Maharashtra"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <label className="block text-xs font-medium text-slate-700">
                    Resume Content *
                  </label>
                  <span className="text-[11px] text-slate-500">
                    ALL CAPS lines become section headings when rebuilding PDF; lines starting with -
                    become bullets
                  </span>
                </div>
                <textarea
                  value={editor.extractedText}
                  onChange={(e) =>
                    setEditor((prev) => (prev ? { ...prev, extractedText: e.target.value } : prev))
                  }
                  rows={14}
                  placeholder="Paste or edit your summary, skills, work experience, and education..."
                  className="w-full px-3.5 py-2.5 text-xs font-mono leading-relaxed border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setEditor(null)}
                disabled={savingEditMode !== null}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 cursor-pointer"
              >
                Cancel
              </button>

              <div className="flex flex-wrap items-center gap-2.5">
                {editor.mode === 'edit' && (
                  <button
                    type="button"
                    onClick={handleSaveMetadataOnly}
                    disabled={savingEditMode !== null}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg disabled:opacity-60 cursor-pointer"
                  >
                    {savingEditMode === 'metadata' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Save className="w-3.5 h-3.5" />
                    )}
                    {savingEditMode === 'metadata' ? 'Saving...' : 'Save Text & Details Only'}
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleRebuildPdfAndSaveVersion}
                  disabled={savingEditMode !== null}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg disabled:opacity-60 cursor-pointer"
                >
                  {savingEditMode === 'rebuild' ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <FileText className="w-3.5 h-3.5" />
                  )}
                  {savingEditMode === 'rebuild'
                    ? 'Building PDF...'
                    : editor.mode === 'create'
                      ? 'Create & Save Resume PDF'
                      : 'Save & Rebuild PDF (New Version)'}
                </button>
              </div>
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
