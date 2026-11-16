import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PdfLocationBox, PdfValidationReport } from '../types.ts';

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  path.resolve(process.cwd(), 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')
).href;

export interface TextLineItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
}

export interface TextSegment {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  items: TextLineItem[];
}

export interface ExtractedPdfData {
  extractedText: string;
  page1Items: TextLineItem[];
  page1Segments: TextSegment[];
  page1Lines: Array<{
    text: string;
    x: number;
    y: number;
    w: number;
    h: number;
    fontSize: number;
  }>;
  page1Size: { width: number; height: number };
  pageCount: number;
}

const CITY_ALIASES: Record<string, string> = {
  bangalore: 'Bengaluru',
  bengaluru: 'Bengaluru',
  gurgaon: 'Gurugram',
  gurugram: 'Gurugram',
  bombay: 'Mumbai',
  mumbai: 'Mumbai',
  'navi mumbai': 'Navi Mumbai',
  madras: 'Chennai',
  chennai: 'Chennai',
  calcutta: 'Kolkata',
  kolkata: 'Kolkata',
  poona: 'Pune',
  pune: 'Pune',
  cochin: 'Kochi',
  kochi: 'Kochi',
  trivandrum: 'Thiruvananthapuram',
  thiruvananthapuram: 'Thiruvananthapuram',
  baroda: 'Vadodara',
  vadodara: 'Vadodara',
  mysore: 'Mysuru',
  mysuru: 'Mysuru',
  mangalore: 'Mangaluru',
  mangaluru: 'Mangaluru',
  'new delhi': 'New Delhi',
  delhi: 'Delhi',
  hyderabad: 'Hyderabad',
  secunderabad: 'Secunderabad',
  noida: 'Noida',
  'greater noida': 'Greater Noida',
  ghaziabad: 'Ghaziabad',
  faridabad: 'Faridabad',
  ahmedabad: 'Ahmedabad',
  gandhinagar: 'Gandhinagar',
  surat: 'Surat',
  jaipur: 'Jaipur',
  udaipur: 'Udaipur',
  chandigarh: 'Chandigarh',
  mohali: 'Mohali',
  panchkula: 'Panchkula',
  indore: 'Indore',
  bhopal: 'Bhopal',
  bhubaneswar: 'Bhubaneswar',
  nagpur: 'Nagpur',
  nashik: 'Nashik',
  thane: 'Thane',
  coimbatore: 'Coimbatore',
  madurai: 'Madurai',
  visakhapatnam: 'Visakhapatnam',
  vizag: 'Visakhapatnam',
  vijayawada: 'Vijayawada',
  patna: 'Patna',
  guwahati: 'Guwahati',
  ranchi: 'Ranchi',
  raipur: 'Raipur',
  dehradun: 'Dehradun',
  lucknow: 'Lucknow',
  kanpur: 'Kanpur',
  panaji: 'Panaji',
  goa: 'Goa',
};

const CITY_TO_STATE: Record<string, string> = {
  Pune: 'Maharashtra',
  Mumbai: 'Maharashtra',
  'Navi Mumbai': 'Maharashtra',
  Thane: 'Maharashtra',
  Nagpur: 'Maharashtra',
  Nashik: 'Maharashtra',
  Bengaluru: 'Karnataka',
  Mysuru: 'Karnataka',
  Mangaluru: 'Karnataka',
  Hyderabad: 'Telangana',
  Secunderabad: 'Telangana',
  Chennai: 'Tamil Nadu',
  Coimbatore: 'Tamil Nadu',
  Madurai: 'Tamil Nadu',
  Gurugram: 'Haryana',
  Faridabad: 'Haryana',
  Panchkula: 'Haryana',
  Noida: 'Uttar Pradesh',
  'Greater Noida': 'Uttar Pradesh',
  Ghaziabad: 'Uttar Pradesh',
  Lucknow: 'Uttar Pradesh',
  Kanpur: 'Uttar Pradesh',
  'New Delhi': 'Delhi',
  Delhi: 'Delhi',
  Kolkata: 'West Bengal',
  Ahmedabad: 'Gujarat',
  Gandhinagar: 'Gujarat',
  Surat: 'Gujarat',
  Vadodara: 'Gujarat',
  Jaipur: 'Rajasthan',
  Udaipur: 'Rajasthan',
  Chandigarh: 'Chandigarh',
  Mohali: 'Punjab',
  Indore: 'Madhya Pradesh',
  Bhopal: 'Madhya Pradesh',
  Bhubaneswar: 'Odisha',
  Kochi: 'Kerala',
  Thiruvananthapuram: 'Kerala',
  Visakhapatnam: 'Andhra Pradesh',
  Vijayawada: 'Andhra Pradesh',
  Patna: 'Bihar',
  Guwahati: 'Assam',
  Ranchi: 'Jharkhand',
  Raipur: 'Chhattisgarh',
  Dehradun: 'Uttarakhand',
  Panaji: 'Goa',
  Goa: 'Goa',
};

const KNOWN_STATES = new Set([
  'maharashtra',
  'karnataka',
  'telangana',
  'tamil nadu',
  'haryana',
  'uttar pradesh',
  'delhi',
  'west bengal',
  'gujarat',
  'rajasthan',
  'chandigarh',
  'punjab',
  'madhya pradesh',
  'odisha',
  'kerala',
  'andhra pradesh',
  'bihar',
  'assam',
  'jharkhand',
  'chhattisgarh',
  'uttarakhand',
  'goa',
  'himachal pradesh',
  'jammu and kashmir',
  'tripura',
  'meghalaya',
  'manipur',
  'nagaland',
  'arunachal pradesh',
  'mizoram',
  'sikkim',
  'puducherry',
]);

const NOISE_LOCATION_PATTERN =
  /\b(street|st\.?|road|rd\.?|lane|ln\.?|avenue|ave\.?|floor|flr|suite|ste|building|bldg|tower|plot|survey|block|phase|sector|sec\.?|zone|tech\s*park|business\s*park|it\s*park|campus|layout|extension|extn|colony|nagar|vihar|enclave|marg|chowk|circle|cross|main|stage|near|opp\.?|opposite|behind|baner|hinjewadi|wakad|kharadi|viman\s*nagar|kothrud|hadapsar|aundh|magarpatta|whitefield|indiranagar|koramangala|marathahalli|electronic\s*city|bellandur|hsr|btm|yelahanka|hebbal|mg\s*road|jayanagar|rajajinagar|andheri|bandra|powai|lower\s*parel|worli|malad|goregaon|kurla|bkc|hitec\s*city|hitech\s*city|madhapur|gachibowli|kondapur|banjara\s*hills|jubilee\s*hills|begumpet|kukatpally|dlf|cyber\s*city|cyber\s*hub|udyog\s*vihar|sohna\s*road|golf\s*course|salt\s*lake|rajarhat|new\s*town|t\.?\s*nagar|adyar|guindy|velachery|sholinganallur|omr|anna\s*nagar|connaught\s*place|nehru\s*place|okhla|saket)\b/i;

function titleCase(str: string): string {
  return str
    .trim()
    .split(/\s+/)
    .map((word) => (word.length <= 2 && /^[A-Z]{2}$/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join(' ');
}

/**
 * Normalizes a job location into clean "City, State" format (or city alone if state is unknown),
 * stripping street names, building names, office numbers, pin codes, sectors, phases, and localities.
 */
export function normalizeJobLocationToCityState(rawLocation: string): string {
  const original = rawLocation.trim();
  if (!original) return '';

  // Remove parenthetical tags like (Hybrid), (On-site), (WFO) unless whole string is Remote
  let cleaned = original
    .replace(/^preferred\s*location\s*:\s*/i, '')
    .replace(/\((hybrid|on-?site|in-?person|remote|wfo|work from office|flexible)[^)]*\)/gi, '')
    .replace(/\b\d{6}\b/g, '') // Indian 6-digit PIN codes
    .replace(/\b\d{5}(?:-\d{4})?\b/g, '') // US 5-digit ZIP codes
    .replace(/\b(india|bharat|usa|u\.s\.a\.|united states|united kingdom|uk)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return original;
  if (/^(remote|work from home|wfh)$/i.test(cleaned)) {
    return 'Remote';
  }

  // Split by comma or dash separator when used as delimiter
  const rawSegments = cleaned
    .split(/[,;|]+/)
    .map((s) => s.replace(/^[-–—\s]+|[-–—\s]+$/g, '').trim())
    .filter(Boolean);

  // Detect any canonical city across segments (preferring later segments since addresses go Locality, City, State)
  let detectedCity = '';
  let detectedState = '';

  const aliasKeys = Object.keys(CITY_ALIASES).sort((a, b) => b.length - a.length);

  for (const seg of rawSegments) {
    const segLower = seg.toLowerCase().replace(/\./g, '').trim();

    if (KNOWN_STATES.has(segLower)) {
      detectedState = titleCase(segLower);
      continue;
    }

    if (CITY_ALIASES[segLower]) {
      detectedCity = CITY_ALIASES[segLower];
      continue;
    }

    // Check if segment contains a canonical city alongside sector/locality (e.g. "Noida Sector 62", "Pune - Baner")
    for (const key of aliasKeys) {
      const re = new RegExp(`\\b${key.replace(/\s+/g, '\\s+')}\\b`, 'i');
      if (re.test(segLower)) {
        detectedCity = CITY_ALIASES[key];
        break;
      }
    }
  }

  if (detectedCity) {
    const mappedState = CITY_TO_STATE[detectedCity] || '';
    const finalState = detectedState || mappedState;
    if (!finalState || finalState.toLowerCase() === detectedCity.toLowerCase()) {
      return detectedCity;
    }
    return `${detectedCity}, ${finalState}`;
  }

  // Fallback for international / unrecognized cities: strip noisy street/locality segments and deduplicate
  const cleanSegments: string[] = [];
  for (const seg of rawSegments) {
    const stripped = seg
      .replace(/^\d+[a-zA-Z/-]*\s+/, '')
      .trim();
    if (!stripped) continue;
    if (/^\d+$/.test(stripped)) continue;
    if (NOISE_LOCATION_PATTERN.test(stripped) && rawSegments.length > 1) continue;

    // Deduplicate identical consecutive values
    if (!cleanSegments.some((prev) => prev.toLowerCase() === stripped.toLowerCase())) {
      cleanSegments.push(stripped);
    }
  }

  if (cleanSegments.length >= 2) {
    const lastTwo = cleanSegments.slice(-2);
    return `${lastTwo[0]}, ${lastTwo[1]}`;
  }
  if (cleanSegments.length === 1) {
    return cleanSegments[0];
  }

  return rawSegments[rawSegments.length - 1] || cleaned;
}

export async function extractPdfTextAndLayout(pdfBuffer: Buffer): Promise<ExtractedPdfData> {
  const uint8 = new Uint8Array(pdfBuffer);
  const standardFontDataUrl =
    path.resolve(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts') + path.sep;

  const loadingTask = pdfjsLib.getDocument({
    data: uint8,
    useWorkerFetch: false,
    disableFontFace: true,
    standardFontDataUrl,
  });

  const pdf = await loadingTask.promise;
  const pageTexts: string[] = [];
  const page1Items: TextLineItem[] = [];
  let page1Size = { width: 595, height: 842 };

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    if (pageNum === 1) {
      const viewport = page.getViewport({ scale: 1 });
      page1Size = { width: viewport.width, height: viewport.height };
    }
    const content = await page.getTextContent();
    const items = content.items as Array<{
      str?: string;
      transform?: number[];
      width?: number;
      height?: number;
      hasEOL?: boolean;
    }>;

    const lineChunks: string[] = [];
    for (const item of items) {
      const str = item.str ?? '';
      if (str) {
        lineChunks.push(str);
      }
      if (item.hasEOL) {
        lineChunks.push('\n');
      } else if (str) {
        lineChunks.push(' ');
      }

      if (pageNum === 1 && str.trim().length > 0 && Array.isArray(item.transform)) {
        const fontSize = Math.max(
          7,
          Math.round(Math.hypot(item.transform[0], item.transform[1]) || item.transform[3] || 10)
        );
        const w = Math.max(2, item.width ?? str.length * fontSize * 0.5);
        const h = Math.max(fontSize, item.height || fontSize);
        page1Items.push({
          str,
          x: item.transform[4] ?? 0,
          y: item.transform[5] ?? 0,
          w,
          h,
          fontSize,
        });
      }
    }

    pageTexts.push(lineChunks.join('').replace(/[ \t]+\n/g, '\n').trim());
  }

  // Group page 1 items into visual rows first (top-to-bottom), then split by column gaps
  const sorted = [...page1Items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: TextLineItem[][] = [];

  for (const item of sorted) {
    const row = rows.find((r) => Math.abs(r[0].y - item.y) <= 3.5);
    if (!row) {
      rows.push([item]);
    } else {
      row.push(item);
    }
  }

  const page1Segments: TextSegment[] = [];
  const page1Lines: ExtractedPdfData['page1Lines'] = [];

  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);

    // Full visual row entry (preserved for backwards-compatible inspection)
    const rowLeft = row[0].x;
    const rowRight = Math.max(...row.map((i) => i.x + i.w));
    page1Lines.push({
      text: row
        .map((i) => i.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
      x: rowLeft,
      y: row[0].y,
      w: rowRight - rowLeft,
      h: Math.max(...row.map((i) => i.h)),
      fontSize: Math.max(...row.map((i) => i.fontSize)),
    });

    // Split row into contiguous column-aware segments (never merge across horizontal gaps > 10pt)
    let curSeg: TextSegment | null = null;
    for (const item of row) {
      if (!curSeg) {
        curSeg = {
          text: item.str.trim(),
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
          fontSize: item.fontSize,
          items: [item],
        };
        continue;
      }

      const curRight = curSeg.x + curSeg.w;
      const gap = item.x - curRight;
      // Normal word spacing is ~0.25-0.35 * fontSize; anything > 0.52 * fontSize (min 4.5pt) is a column or tab gap
      const maxInlineGap = Math.max(4.5, curSeg.fontSize * 0.52);

      if (gap <= maxInlineGap) {
        const nextRight = Math.max(curRight, item.x + item.w);
        curSeg.w = nextRight - curSeg.x;
        curSeg.h = Math.max(curSeg.h, item.h);
        curSeg.fontSize = Math.max(curSeg.fontSize, item.fontSize);
        curSeg.text = `${curSeg.text}${gap > 1.5 ? ' ' : ''}${item.str}`.replace(/\s+/g, ' ').trim();
        curSeg.items.push(item);
      } else {
        page1Segments.push(curSeg);
        curSeg = {
          text: item.str.trim(),
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
          fontSize: item.fontSize,
          items: [item],
        };
      }
    }
    if (curSeg) {
      page1Segments.push(curSeg);
    }
  }

  return {
    extractedText: pageTexts.join('\n\n').trim(),
    page1Items,
    page1Segments,
    page1Lines,
    page1Size,
    pageCount: pdf.numPages,
  };
}

export function findLocationBoxOnPage1(
  segments: TextSegment[] | ExtractedPdfData['page1Lines'],
  originalLocation: string
): PdfLocationBox {
  const empty: PdfLocationBox = {
    hasLocationBox: false,
    locPage: 0,
    locX: 0,
    locY: 0,
    locW: 0,
    locH: 0,
    locFontSize: 10,
  };

  const target = originalLocation.trim().toLowerCase();
  if (!target) return empty;

  const city = target.split(',')[0]?.trim();
  const match =
    segments.find((seg) => seg.text.toLowerCase().includes(target)) ||
    segments.find((seg) => city && city.length >= 3 && seg.text.toLowerCase().includes(city));

  if (!match) return empty;

  return {
    hasLocationBox: true,
    locPage: 0,
    locX: Number(match.x.toFixed(2)),
    locY: Number(match.y.toFixed(2)),
    locW: Number(match.w.toFixed(2)),
    locH: Number(match.h.toFixed(2)),
    locFontSize: Number(match.fontSize.toFixed(2)),
  };
}

interface RectBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rectsOverlap(a: RectBox, b: RectBox, padX = 2, padY = 2): boolean {
  return (
    a.x < b.x + b.w + padX &&
    a.x + a.w + padX > b.x &&
    a.y < b.y + b.h + padY &&
    a.y + a.h + padY > b.y
  );
}

function hasAnyCollision(candidate: RectBox, obstacles: RectBox[], padX = 3, padY = 2): boolean {
  return obstacles.some((obs) => rectsOverlap(candidate, obs, padX, padY));
}

export async function createTailoredResumePdf(params: {
  originalPdfBuffer: Buffer;
  originalLocation: string;
  replacementLocationText: string;
  locationBox: PdfLocationBox;
}): Promise<{
  buffer: Buffer;
  placementMode: PdfValidationReport['placementMode'];
  layout: ExtractedPdfData;
}> {
  const pdfDoc = await PDFDocument.load(params.originalPdfBuffer);
  const pages = pdfDoc.getPages();
  if (pages.length === 0) {
    throw new Error('Uploaded PDF has no pages.');
  }

  // Always compute fresh column-aware segments from original PDF bytes so wide/stale coordinates cannot erase neighbors
  const layout = await extractPdfTextAndLayout(params.originalPdfBuffer);
  const target = params.originalLocation.trim().toLowerCase();
  const cityToken = target.split(',')[0]?.trim() || '';

  const matchedSegment: TextSegment | undefined = target
    ? layout.page1Segments.find((s) => s.text.toLowerCase().includes(target)) ||
      layout.page1Segments.find(
        (s) => cityToken.length >= 3 && s.text.toLowerCase().includes(cityToken)
      )
    : undefined;

  const page = pages[Math.min(params.locationBox.locPage || 0, pages.length - 1)];
  const { width: pageWidth, height: pageHeight } = page.getSize();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const labelText = params.replacementLocationText.trim();
  const colonIdx = labelText.indexOf(':');
  const labelPrefix = colonIdx !== -1 ? labelText.slice(0, colonIdx + 1).trim() : 'Preferred Location:';
  const labelCityState = colonIdx !== -1 ? labelText.slice(colonIdx + 1).trim() : labelText;

  let placementMode: PdfValidationReport['placementMode'] = 'header_badge';

  if (matchedSegment) {
    const matchedSet = new Set(matchedSegment.items);
    const otherItems: RectBox[] = layout.page1Items
      .filter((it) => !matchedSet.has(it))
      .map((it) => ({ x: it.x, y: it.y, w: it.w, h: it.h }));

    // Check if there is a right-column neighbor on the same baseline (e.g. LinkedIn URL)
    const rightNeighbors = layout.page1Items.filter(
      (it) => !matchedSet.has(it) && Math.abs(it.y - matchedSegment.y) <= 4.5 && it.x > matchedSegment.x + 2
    );
    const nearestRightNeighborX =
      rightNeighbors.length > 0 ? Math.min(...rightNeighbors.map((it) => it.x)) : pageWidth - 24;

    const maxInlineRightEdge = nearestRightNeighborX - 8;
    const baseFontSize = Math.min(Math.max(matchedSegment.fontSize || 9.5, 8.5), 11.5);

    // Mask ONLY the original location segment, strictly clamped away from any right-column neighbor
    const maskX = Math.max(0, matchedSegment.x - 1.5);
    const maxSafeMaskW = Math.max(10, nearestRightNeighborX - 3 - maskX);
    const maskW = Math.min(matchedSegment.w + 3, maxSafeMaskW);
    page.drawRectangle({
      x: maskX,
      y: Math.max(0, matchedSegment.y - 2.5),
      width: maskW,
      height: Math.max(matchedSegment.h + 5, baseFontSize + 5),
      color: rgb(1, 1, 1),
    });

    // Preserve any non-location prefix/suffix inside the tight segment (rare single-line headers)
    let inlineCandidateText = labelText;
    const segLower = matchedSegment.text.toLowerCase();
    const origIdx = segLower.indexOf(target);
    if (origIdx !== -1 && matchedSegment.text.length > params.originalLocation.trim().length + 4) {
      const before = matchedSegment.text.slice(0, origIdx);
      const after = matchedSegment.text.slice(origIdx + params.originalLocation.trim().length);
      inlineCandidateText = `${before}${labelText}${after}`.replace(/\s+/g, ' ').trim();
    }

    // Strategy 1: Single-line inline placement at original coordinates if zero collision & fits before right neighbor
    const inlineW = font.widthOfTextAtSize(inlineCandidateText, baseFontSize);
    const inlineBox: RectBox = {
      x: matchedSegment.x,
      y: matchedSegment.y,
      w: inlineW,
      h: baseFontSize,
    };

    if (
      matchedSegment.x + inlineW <= maxInlineRightEdge &&
      !hasAnyCollision(inlineBox, otherItems, 4, 2)
    ) {
      page.drawText(inlineCandidateText, {
        x: matchedSegment.x,
        y: matchedSegment.y,
        size: baseFontSize,
        font,
        color: rgb(0.1, 0.13, 0.18),
      });
      placementMode = 'inline';
    } else {
      // Strategy 2: Two-line column wrap ("Preferred Location:" / "City, State") inside the same left column
      const wrapFontSize = Math.max(8.5, Math.min(baseFontSize, 9.5));
      const lineStep = Math.max(10.5, wrapFontSize * 1.24);
      const line1W = font.widthOfTextAtSize(labelPrefix, wrapFontSize);
      const line2W = font.widthOfTextAtSize(labelCityState, wrapFontSize);

      const line1Box: RectBox = {
        x: matchedSegment.x,
        y: matchedSegment.y,
        w: line1W,
        h: wrapFontSize,
      };
      const line2Box: RectBox = {
        x: matchedSegment.x,
        y: matchedSegment.y - lineStep,
        w: line2W,
        h: wrapFontSize,
      };

      const maxColRight =
        Math.min(
          maxInlineRightEdge,
          ...layout.page1Items
            .filter(
              (it) =>
                !matchedSet.has(it) &&
                Math.abs(it.y - (matchedSegment.y - lineStep)) <= 5 &&
                it.x > matchedSegment.x + 2
            )
            .map((it) => it.x - 8)
        ) || maxInlineRightEdge;

      // Also verify line2 stays safely above lower body sections (check vertical clearance below line2 unless a parallel right-column line like wrapped LinkedIn is already at that row)
      const hasParallelRightItemOnRow3 = layout.page1Items.some(
        (it) =>
          !matchedSet.has(it) &&
          Math.abs(it.y - (matchedSegment.y - lineStep)) <= 5 &&
          it.x > matchedSegment.x + line1W
      );
      const line2ClearPadY = hasParallelRightItemOnRow3 ? 2 : 7;

      const fitsColumnWrap =
        inlineCandidateText === labelText &&
        line2Box.y > 40 &&
        matchedSegment.x + Math.max(line1W, line2W) <= maxColRight &&
        !hasAnyCollision(line1Box, otherItems, 4, 2) &&
        !hasAnyCollision(line2Box, otherItems, 4, line2ClearPadY);

      if (fitsColumnWrap) {
        page.drawText(labelPrefix, {
          x: matchedSegment.x,
          y: matchedSegment.y,
          size: wrapFontSize,
          font,
          color: rgb(0.1, 0.13, 0.18),
        });
        page.drawText(labelCityState, {
          x: matchedSegment.x,
          y: matchedSegment.y - lineStep,
          size: wrapFontSize,
          font,
          color: rgb(0.1, 0.13, 0.18),
        });
        placementMode = 'wrapped_column';
      } else {
        // Strategy 3: Move Preferred Location to a dedicated guaranteed collision-free full-width line
        const sepFontSize = 9;
        const sepW = font.widthOfTextAtSize(labelText, sepFontSize);
        const candidates: Array<{ x: number; y: number }> = [
          // Top-right header corner
          { x: Math.max(24, pageWidth - sepW - 24), y: pageHeight - 18 },
          // Top-left margin
          { x: Math.max(24, matchedSegment.x), y: pageHeight - 18 },
          // Top centered band
          { x: Math.max(24, (pageWidth - sepW) / 2), y: pageHeight - 18 },
          // Bottom footer margin
          { x: Math.max(24, matchedSegment.x), y: 14 },
        ];

        // Scan open vertical gaps in upper half of page
        for (let scanY = Math.round(pageHeight - 24); scanY >= Math.round(pageHeight * 0.55); scanY -= 4) {
          candidates.push({ x: Math.max(24, matchedSegment.x), y: scanY });
        }

        const chosen =
          candidates.find(
            (pt) =>
              !hasAnyCollision(
                { x: pt.x, y: pt.y, w: sepW, h: sepFontSize },
                otherItems,
                6,
                4
              )
          ) || candidates[candidates.length - 1];

        page.drawRectangle({
          x: Math.max(4, chosen.x - 4),
          y: Math.max(4, chosen.y - 3),
          width: sepW + 8,
          height: sepFontSize + 6,
          color: rgb(0.97, 0.98, 0.99),
        });
        page.drawText(labelText, {
          x: chosen.x,
          y: chosen.y,
          size: sepFontSize,
          font,
          color: rgb(0.15, 0.2, 0.3),
        });
        placementMode = 'separate_line';
      }
    }
  } else {
    // No original location text existed in master PDF — place clean collision-free header badge
    const fontSize = 9;
    const textWidth = font.widthOfTextAtSize(labelText, fontSize);
    const otherItems: RectBox[] = layout.page1Items.map((it) => ({
      x: it.x,
      y: it.y,
      w: it.w,
      h: it.h,
    }));

    const candidates = [
      { x: Math.max(24, pageWidth - textWidth - 28), y: pageHeight - 20 },
      { x: 28, y: pageHeight - 20 },
      { x: Math.max(24, pageWidth - textWidth - 28), y: 14 },
    ];
    const chosen =
      candidates.find(
        (pt) =>
          !hasAnyCollision(
            { x: pt.x, y: pt.y, w: textWidth, h: fontSize },
            otherItems,
            6,
            4
          )
      ) || candidates[0];

    page.drawRectangle({
      x: chosen.x - 6,
      y: chosen.y - 4,
      width: textWidth + 12,
      height: 15,
      color: rgb(0.96, 0.97, 0.99),
    });

    page.drawText(labelText, {
      x: chosen.x,
      y: chosen.y,
      size: fontSize,
      font,
      color: rgb(0.15, 0.2, 0.3),
    });
    placementMode = 'header_badge';
  }

  const savedBytes = await pdfDoc.save();
  return {
    buffer: Buffer.from(savedBytes),
    placementMode,
    layout,
  };
}

/**
 * Parses the ACTUAL generated PDF bytes to verify:
 * 1. The normalized Preferred Location is rendered in the PDF.
 * 2. All original contact tokens (phone, email, LinkedIn URL) remain intact.
 * 3. No text items in the generated PDF's contact/location zone overlap each other.
 */
export async function validateGeneratedTailoredPdf(
  originalLayout: ExtractedPdfData,
  tailoredPdfBuffer: Buffer,
  normalizedLocation: string,
  placementMode: PdfValidationReport['placementMode']
): Promise<PdfValidationReport> {
  const generatedLayout = await extractPdfTextAndLayout(tailoredPdfBuffer);
  const compactGenerated = generatedLayout.extractedText.replace(/\s+/g, ' ').toLowerCase();
  const normalizedCity = normalizedLocation.split(',')[0]?.trim().toLowerCase() || '';

  const locationDisplayed =
    compactGenerated.includes('preferred location') &&
    (!normalizedCity || compactGenerated.includes(normalizedCity));

  // Collect essential contact strings from original page 1 (phones, emails, LinkedIn/URL fragments)
  const contactTokens: string[] = [];
  for (const item of originalLayout.page1Items) {
    const t = item.str.trim();
    if (!t) continue;
    if (
      /@/.test(t) ||
      /\d{7,}/.test(t.replace(/[\s()-]/g, '')) ||
      /linkedin\.com|github\.com|https?:\/\//i.test(t)
    ) {
      contactTokens.push(t.toLowerCase());
    }
  }

  const compactGeneratedNoSpace = generatedLayout.extractedText.replace(/\s+/g, '').toLowerCase();
  const contactFieldsPreserved = contactTokens.every((tok) =>
    compactGeneratedNoSpace.includes(tok.replace(/\s+/g, ''))
  );

  // Identify items masked underneath the white replacement rectangle (they come from originalLocation at the exact same coords)
  const maskedOriginalLocationItems = new Set<TextLineItem>();
  if (placementMode === 'inline' || placementMode === 'wrapped_column') {
    const locCityLower = normalizedCity;
    for (const item of generatedLayout.page1Items) {
      const s = item.str.trim().toLowerCase();
      // Skip newly drawn Preferred Location text itself
      if (s.includes('preferred location') || (locCityLower && s.includes(locCityLower))) continue;
      // Match original location item that shares exact coords with an original location item
      const wasInOrigLoc = originalLayout.page1Items.some(
        (orig) =>
          orig.str.trim().toLowerCase() === s &&
          Math.abs(orig.x - item.x) <= 1 &&
          Math.abs(orig.y - item.y) <= 1 &&
          !/@|https?:|www\.|linkedin|github|\d{6,}/i.test(s)
      );
      if (wasInOrigLoc) {
        // Only treat as masked if a newly drawn Preferred Location / city item sits on top of it
        const coveredByReplacement = generatedLayout.page1Items.some(
          (rep) =>
            rep !== item &&
            /preferred location/i.test(rep.str) &&
            Math.abs(rep.x - item.x) <= 3 &&
            Math.abs(rep.y - item.y) <= 3
        );
        if (coveredByReplacement) {
          maskedOriginalLocationItems.add(item);
        }
      }
    }
  }

  const visiblePage1Items = generatedLayout.page1Items.filter(
    (it) => !maskedOriginalLocationItems.has(it)
  );

  // Check overlaps for every contact/location item against all OTHER visible items on page 1
  const isContactOrLocationItem = (item: TextLineItem) => {
    const s = item.str.trim();
    if (!s) return false;
    return (
      /@|https?:|www\.|linkedin|github|\d{6,}|preferred|location/i.test(s) ||
      (normalizedCity.length >= 3 && s.toLowerCase().includes(normalizedCity))
    );
  };

  const contactOrLocItems = visiblePage1Items.filter(isContactOrLocationItem);
  const contactYs = contactOrLocItems.map((it) => it.y);
  const allContactZoneItems = visiblePage1Items.filter(
    (it) =>
      it.str.trim().length > 1 &&
      (isContactOrLocationItem(it) || contactYs.some((cy) => Math.abs(it.y - cy) <= 4))
  );

  let noOverlapDetected = true;
  for (const focusItem of allContactZoneItems) {
    for (const other of visiblePage1Items) {
      if (focusItem === other || other.str.trim().length <= 1) continue;
      const sameBaseline = Math.abs(focusItem.y - other.y) <= 1.5;
      const overlapX = Math.min(focusItem.x + focusItem.w, other.x + other.w) - Math.max(focusItem.x, other.x);
      const overlapY = Math.min(focusItem.y + focusItem.h, other.y + other.h) - Math.max(focusItem.y, other.y);
      const xThreshold = sameBaseline ? 4 : 2;
      if (overlapX > xThreshold && overlapY > 2) {
        noOverlapDetected = false;
        break;
      }
    }
    if (!noOverlapDetected) break;
  }

  return {
    locationDisplayed,
    contactFieldsPreserved,
    noOverlapDetected,
    normalizedLocation,
    placementMode,
  };
}

function sanitizePdfText(raw: string): string {
  return raw
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2022/g, '*')
    .replace(/\t/g, '  ')
    // Strip characters outside printable Latin-1 range so WinAnsi never throws
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wrapLineToWidth(
  text: string,
  font: Awaited<ReturnType<PDFDocument['embedFont']>>,
  fontSize: number,
  maxWidth: number
): string[] {
  const clean = sanitizePdfText(text);
  if (!clean) return [];
  const words = clean.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      cur = candidate;
    } else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export async function buildManualResumePdf(params: {
  candidateName: string;
  candidateEmail: string;
  candidatePhone: string;
  originalLocation: string;
  resumeText: string;
}): Promise<{
  pdfBuffer: Buffer;
  extractedText: string;
  locationBox: PdfLocationBox;
}> {
  const pdfDoc = await PDFDocument.create();
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 595.28; // A4
  const pageHeight = 841.89;
  const marginX = 48;
  const topMargin = 52;
  const bottomMargin = 48;
  const contentWidth = pageWidth - marginX * 2;

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - topMargin;

  const ensureSpace = (needed: number) => {
    if (y - needed < bottomMargin) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - topMargin;
    }
  };

  const nameText = sanitizePdfText(params.candidateName || 'Candidate');
  const emailText = sanitizePdfText(params.candidateEmail || '');
  const phoneText = sanitizePdfText(params.candidatePhone || '');
  const locText = sanitizePdfText(params.originalLocation || '');

  // Header: Candidate Name
  page.drawText(nameText, {
    x: marginX,
    y,
    size: 18,
    font: fontBold,
    color: rgb(0.06, 0.09, 0.16),
  });
  y -= 22;

  // Header: Contact Details line (Phone | Email)
  const contactParts = [phoneText, emailText].filter(Boolean);
  if (contactParts.length > 0) {
    const contactLine = contactParts.join('  |  ');
    const wrappedContact = wrapLineToWidth(contactLine, fontRegular, 10, contentWidth);
    for (const cLine of wrappedContact) {
      page.drawText(cLine, {
        x: marginX,
        y,
        size: 10,
        font: fontRegular,
        color: rgb(0.2, 0.25, 0.33),
      });
      y -= 14;
    }
  }

  // Dedicated Location Line on Page 1 with measured locationBox for future tailoring
  let locationBox: PdfLocationBox = {
    hasLocationBox: false,
    locPage: 0,
    locX: 0,
    locY: 0,
    locW: 0,
    locH: 0,
    locFontSize: 10,
  };

  if (locText) {
    const locFontSize = 10;
    const locWidth = Math.max(80, fontRegular.widthOfTextAtSize(locText, locFontSize));
    page.drawText(locText, {
      x: marginX,
      y,
      size: locFontSize,
      font: fontRegular,
      color: rgb(0.2, 0.25, 0.33),
    });
    locationBox = {
      hasLocationBox: true,
      locPage: 0,
      locX: marginX,
      locY: Number(y.toFixed(2)),
      locW: Number(locWidth.toFixed(2)),
      locH: 12,
      locFontSize,
    };
    y -= 15;
  }

  // Divider line
  y -= 4;
  page.drawRectangle({
    x: marginX,
    y,
    width: contentWidth,
    height: 1,
    color: rgb(0.11, 0.31, 0.85),
  });
  y -= 16;

  // Body lines: avoid duplicating contact header lines if pasted at very top of resumeText
  const rawLines = params.resumeText.split(/\r?\n/);
  const normStrip = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const headerNorms = [nameText, emailText, phoneText, locText]
    .map(normStrip)
    .filter((s) => s.length >= 4);

  let startIdx = 0;
  while (startIdx < Math.min(rawLines.length, 6)) {
    const lineTrim = rawLines[startIdx].trim();
    if (!lineTrim) {
      startIdx++;
      continue;
    }
    const lineNorm = normStrip(lineTrim);
    const matchesHeader =
      lineNorm.length > 0 &&
      headerNorms.some((h) => lineNorm === h || (lineNorm.includes(h) && lineNorm.length <= h.length + 25));
    if (matchesHeader) {
      startIdx++;
    } else {
      break;
    }
  }

  const SECTION_HEADING_RE =
    /^(summary|professional summary|profile|objective|experience|work experience|employment history|skills|core competencies|key skills|technical skills|education|certifications|projects|achievements|awards|languages)$/i;

  for (let i = startIdx; i < rawLines.length; i++) {
    const trimmed = rawLines[i].trim();
    if (!trimmed) {
      y -= 6;
      continue;
    }

    const cleanCheck = sanitizePdfText(trimmed).replace(/:$/, '');
    const isAllCapsHeading =
      cleanCheck.length >= 3 &&
      cleanCheck.length <= 48 &&
      cleanCheck === cleanCheck.toUpperCase() &&
      /[A-Z]/.test(cleanCheck);
    const isHeading = isAllCapsHeading || SECTION_HEADING_RE.test(cleanCheck);

    if (isHeading) {
      ensureSpace(24);
      y -= 5;
      page.drawText(cleanCheck.toUpperCase(), {
        x: marginX,
        y,
        size: 11,
        font: fontBold,
        color: rgb(0.06, 0.16, 0.38),
      });
      y -= 4;
      page.drawRectangle({
        x: marginX,
        y,
        width: contentWidth,
        height: 0.5,
        color: rgb(0.82, 0.85, 0.9),
      });
      y -= 13;
      continue;
    }

    const isBullet = /^[-*•▪]\s+/.test(trimmed);
    const lineBody = isBullet ? trimmed.replace(/^[-*•▪]\s+/, '') : trimmed;
    const textIndent = isBullet ? 12 : 0;
    const wrapped = wrapLineToWidth(lineBody, fontRegular, 10, contentWidth - textIndent);

    for (let li = 0; li < wrapped.length; li++) {
      ensureSpace(14.5);
      if (isBullet && li === 0) {
        page.drawText('*', {
          x: marginX + 2,
          y,
          size: 10,
          font: fontBold,
          color: rgb(0.2, 0.25, 0.33),
        });
      }
      page.drawText(wrapped[li], {
        x: marginX + textIndent,
        y,
        size: 10,
        font: fontRegular,
        color: rgb(0.12, 0.16, 0.23),
      });
      y -= 14;
    }
  }

  const bytes = await pdfDoc.save();
  const pdfBuffer = Buffer.from(bytes);
  const extractedLayout = await extractPdfTextAndLayout(pdfBuffer);
  const detectedBox = findLocationBoxOnPage1(extractedLayout.page1Segments, locText);

  return {
    pdfBuffer,
    extractedText: extractedLayout.extractedText || params.resumeText,
    locationBox: detectedBox.hasLocationBox ? detectedBox : locationBox,
  };
}
