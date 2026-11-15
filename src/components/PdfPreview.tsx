import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ChevronLeft, ChevronRight, Download, FileText, X } from 'lucide-react';
import { downloadBase64Pdf } from '../lib/dateUtils.ts';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfCanvasViewerProps {
  base64Data: string;
  maxHeightClass?: string;
}

export function PdfCanvasViewer({
  base64Data,
  maxHeightClass = 'max-h-[560px]',
}: PdfCanvasViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pageCount, setPageCount] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setCurrentPage(1);
  }, [base64Data]);

  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel: () => void } | null = null;

    async function renderPdf() {
      if (!base64Data || !canvasRef.current) return;
      setLoading(true);
      setError('');

      try {
        const binaryStr = atob(base64Data);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }

        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
        if (cancelled) return;
        setPageCount(pdf.numPages);

        const safePage = Math.min(Math.max(1, currentPage), pdf.numPages);
        const page = await pdf.getPage(safePage);
        if (cancelled || !canvasRef.current) return;

        const viewport = page.getViewport({ scale: 1.45 });
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');
        if (!context) return;

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        const task = page.render({
          canvasContext: context,
          viewport,
          canvas,
        });
        renderTask = task;
        await task.promise;
        if (!cancelled) {
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('PDF render error:', err);
          setError('Unable to render PDF preview. You can still download the PDF directly.');
          setLoading(false);
        }
      }
    }

    void renderPdf();
    return () => {
      cancelled = true;
      if (renderTask) {
        try {
          renderTask.cancel();
        } catch {
          // ignore cancellation errors
        }
      }
    };
  }, [base64Data, currentPage]);

  return (
    <div className="flex flex-col border border-slate-200 rounded-lg bg-slate-50 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-white border-b border-slate-200 text-xs text-slate-600">
        <span className="font-mono tabular-nums">
          Page {currentPage} of {pageCount}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
            className="p-1 rounded border border-slate-200 hover:bg-slate-100 disabled:opacity-40 cursor-pointer"
            aria-label="Previous page"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setCurrentPage((p) => Math.min(pageCount, p + 1))}
            disabled={currentPage >= pageCount}
            className="p-1 rounded border border-slate-200 hover:bg-slate-100 disabled:opacity-40 cursor-pointer"
            aria-label="Next page"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className={`overflow-auto p-4 flex justify-center bg-slate-100/70 ${maxHeightClass}`}>
        {error ? (
          <div className="py-12 text-center text-sm text-slate-600">
            <FileText className="w-8 h-8 text-slate-400 mx-auto mb-2" />
            <p>{error}</p>
          </div>
        ) : (
          <div className="relative">
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-white/80 text-xs text-slate-500">
                Rendering PDF...
              </div>
            )}
            <canvas
              ref={canvasRef}
              className="max-w-full h-auto shadow-sm border border-slate-200 bg-white"
            />
          </div>
        )}
      </div>
    </div>
  );
}

interface PdfPreviewModalProps {
  isOpen: boolean;
  title: string;
  fileName: string;
  base64Data: string;
  subtitle?: string;
  onClose: () => void;
}

export function PdfPreviewModal({
  isOpen,
  title,
  fileName,
  base64Data,
  subtitle,
  onClose,
}: PdfPreviewModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-900 truncate">{title}</h3>
            {subtitle && (
              <p className="text-xs text-slate-500 mt-0.5 truncate">{subtitle}</p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => downloadBase64Pdf(base64Data, fileName)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              Download PDF
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
              aria-label="Close preview"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="p-4 overflow-y-auto">
          <PdfCanvasViewer base64Data={base64Data} maxHeightClass="max-h-[70vh]" />
        </div>
      </div>
    </div>
  );
}
