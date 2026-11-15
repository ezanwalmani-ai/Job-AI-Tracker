import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAuth, AuthRequest } from './src/server/firebaseAdmin.ts';
import {
  extractPdfTextAndLayout,
  findLocationBoxOnPage1,
  createTailoredResumePdf,
  normalizeJobLocationToCityState,
  validateGeneratedTailoredPdf,
} from './src/server/pdfService.ts';
import type { EmailPurposeType } from './src/types.ts';
import {
  extractCandidateInfoFromText,
  prepareLocationAndJdAnalysis,
  generateJobApplicationEmail,
  analyzeManualJobDescription,
  parseRawJobInput,
  findCompanyHrContact,
  generateFollowUpEmail,
  classifyIncomingEmailReplies,
  detectPortalApplicationConfirmations,
} from './src/server/gemini.ts';
import {
  sendGmailMessage,
  fetchRecentGmailReplies,
  verifyGmailReadonlyProfile,
  fetchJobConfirmationEmails,
} from './src/server/gmailService.ts';
import { createZipBuffer } from './src/server/zipBuilder.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  const allowedOrigins = new Set(
    [
      'https://jobaitracker.netlify.app',
      'https://www.jobaitracker.netlify.app',
      process.env.APP_URL,
      'http://localhost:3000',
    ]
      .filter((v): v is string => Boolean(v))
      .map((u) => u.replace(/\/+$/, ''))
  );

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (
      origin &&
      (allowedOrigins.has(origin) ||
        /^https:\/\/[a-z0-9-]+\.netlify\.app$/i.test(origin) ||
        /^https:\/\/[a-z0-9-]+\.run\.app$/i.test(origin))
    ) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Gmail-Token');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '25mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // 1. Parse uploaded PDF master resume
  app.post('/api/resume/parse', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { pdfBase64 } = req.body as { pdfBase64?: string };
      if (!pdfBase64 || typeof pdfBase64 !== 'string') {
        res.status(400).json({ error: 'PDF content is required.' });
        return;
      }

      const buffer = Buffer.from(pdfBase64, 'base64');
      if (buffer.length < 5 || buffer.subarray(0, 4).toString('utf8') !== '%PDF') {
        res.status(400).json({ error: 'The uploaded file is not a valid PDF document.' });
        return;
      }

      const layout = await extractPdfTextAndLayout(buffer);
      if (!layout.extractedText || layout.extractedText.trim().length < 20) {
        res.status(400).json({
          error:
            'Could not extract selectable text from this PDF. Please upload a text-based PDF resume (not a scanned image).',
        });
        return;
      }

      const candidateInfo = await extractCandidateInfoFromText(layout.extractedText);
      const locationBox = findLocationBoxOnPage1(
        layout.page1Segments,
        candidateInfo.originalLocation
      );

      res.json({
        extractedText: layout.extractedText,
        pageCount: layout.pageCount,
        candidateName: candidateInfo.candidateName,
        candidateEmail: candidateInfo.candidateEmail,
        candidatePhone: candidateInfo.candidatePhone,
        originalLocation: candidateInfo.originalLocation,
        locationBox,
      });
    } catch (error: unknown) {
      console.error('Resume parse error:', error);
      const message = error instanceof Error ? error.message : 'Failed to parse PDF resume.';
      res.status(500).json({ error: message });
    }
  });

  // 2. Generate job-specific tailored PDF (updating ONLY the location field)
  app.post('/api/resume/tailor', requireAuth, async (req: AuthRequest, res) => {
    try {
      const {
        originalPdfBase64,
        extractedText,
        originalLocation,
        locationBox,
        jobLocation,
        companyName,
        jobTitle,
        jobDescription,
        candidateName,
        cachedJdSummary,
        cachedKeyRequirements,
      } = req.body as {
        originalPdfBase64?: string;
        extractedText?: string;
        originalLocation?: string;
        locationBox?: {
          hasLocationBox: boolean;
          locPage: number;
          locX: number;
          locY: number;
          locW: number;
          locH: number;
          locFontSize: number;
        };
        jobLocation?: string;
        companyName?: string;
        jobTitle?: string;
        jobDescription?: string;
        candidateName?: string;
        cachedJdSummary?: string;
        cachedKeyRequirements?: string[];
      };

      if (!originalPdfBase64 || !extractedText || !jobLocation || !companyName || !jobTitle || !jobDescription) {
        res.status(400).json({
          error: 'Master resume, company name, job title, job location, and job description are required.',
        });
        return;
      }

      const originalBuffer = Buffer.from(originalPdfBase64, 'base64');
      const normalizedLocation = normalizeJobLocationToCityState(jobLocation) || jobLocation.trim();
      const replacementLocationText = `Preferred Location: ${normalizedLocation}`;
      let effectiveOriginalLocation = (originalLocation || '').trim();
      let jdSummary = (cachedJdSummary || '').trim();
      let keyRequirements = Array.isArray(cachedKeyRequirements) ? cachedKeyRequirements : [];

      if (!jdSummary) {
        const aiResult = await prepareLocationAndJdAnalysis({
          extractedText,
          originalLocation: effectiveOriginalLocation,
          jobLocation: normalizedLocation,
          companyName,
          jobTitle,
          jobDescription,
        });
        effectiveOriginalLocation = aiResult.exactOriginalSubstring || effectiveOriginalLocation;
        jdSummary = aiResult.jdSummary;
        keyRequirements = aiResult.keyRequirements;
      }

      const layout = await extractPdfTextAndLayout(originalBuffer);
      const tightSegmentBox = findLocationBoxOnPage1(
        layout.page1Segments,
        effectiveOriginalLocation
      );
      const resolvedBox = tightSegmentBox.hasLocationBox
        ? tightSegmentBox
        : locationBox && locationBox.hasLocationBox
          ? locationBox
          : tightSegmentBox;

      const { buffer: tailoredBuffer, placementMode, layout: freshLayout } =
        await createTailoredResumePdf({
          originalPdfBuffer: originalBuffer,
          originalLocation: effectiveOriginalLocation,
          replacementLocationText,
          locationBox: resolvedBox,
        });

      if (tailoredBuffer.length < 100 || tailoredBuffer.subarray(0, 4).toString('utf8') !== '%PDF') {
        throw new Error('Generated resume PDF failed integrity verification.');
      }

      const validationReport = await validateGeneratedTailoredPdf(
        freshLayout,
        tailoredBuffer,
        normalizedLocation,
        placementMode
      );

      const slug = (str: string) =>
        str
          .replace(/[^a-zA-Z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 36);

      const fileName = `${slug(candidateName || 'Candidate')}_${slug(companyName)}_${slug(jobTitle)}.pdf`;

      res.json({
        tailoredPdfBase64: tailoredBuffer.toString('base64'),
        tailoredFileName: fileName,
        originalLocationText: effectiveOriginalLocation || 'Not specified on master resume',
        updatedLocationText: replacementLocationText,
        normalizedLocation,
        pdfByteLength: tailoredBuffer.length,
        validated:
          validationReport.locationDisplayed &&
          validationReport.contactFieldsPreserved &&
          validationReport.noOverlapDetected,
        validationReport,
        jdSummary,
        keyRequirements,
      });
    } catch (error: unknown) {
      console.error('Resume tailor error:', error);
      const message = error instanceof Error ? error.message : 'Failed to generate job-specific PDF.';
      res.status(500).json({ error: message });
    }
  });

  // 3. AI Job Application Email Generator
  app.post('/api/ai/generate-email', requireAuth, async (req: AuthRequest, res) => {
    try {
      const {
        extractedText,
        candidateName,
        candidateEmail,
        candidatePhone,
        companyName,
        jobTitle,
        jobLocation,
        jobDescription,
        recruiterName,
        requiredExperience,
        requiredSkills,
        responsibilities,
        applicationInstructions,
        emailType,
      } = req.body as {
        extractedText?: string;
        candidateName?: string;
        candidateEmail?: string;
        candidatePhone?: string;
        companyName?: string;
        jobTitle?: string;
        jobLocation?: string;
        jobDescription?: string;
        recruiterName?: string;
        requiredExperience?: string;
        requiredSkills?: string[];
        responsibilities?: string[];
        applicationInstructions?: string;
        emailType?: EmailPurposeType;
      };

      if (!extractedText || !companyName || !jobTitle || !jobDescription) {
        res.status(400).json({
          error: 'Master resume text, company name, job title, and job description are required.',
        });
        return;
      }

      const email = await generateJobApplicationEmail({
        extractedText,
        candidateName: candidateName || req.user?.name || '',
        candidateEmail: candidateEmail || req.user?.email || '',
        candidatePhone: candidatePhone || '',
        companyName,
        jobTitle,
        jobLocation: jobLocation || '',
        jobDescription,
        recruiterName,
        requiredExperience,
        requiredSkills,
        responsibilities,
        applicationInstructions,
        emailType,
      });

      res.json(email);
    } catch (error: unknown) {
      console.error('Email generation error:', error);
      const message = error instanceof Error ? error.message : 'Failed to generate application email.';
      res.status(500).json({ error: message });
    }
  });

  // 4. Analyze JD for manual portal applications
  app.post('/api/ai/analyze-jd', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { companyName, jobTitle, jobLocation, jobDescription } = req.body as {
        companyName?: string;
        jobTitle?: string;
        jobLocation?: string;
        jobDescription?: string;
      };

      if (!companyName || !jobTitle || !jobDescription) {
        res.status(400).json({
          error: 'Company name, job title, and job description are required.',
        });
        return;
      }

      const analysis = await analyzeManualJobDescription({
        companyName,
        jobTitle,
        jobLocation: jobLocation || '',
        jobDescription,
      });

      res.json(analysis);
    } catch (error: unknown) {
      console.error('JD analysis error:', error);
      const message = error instanceof Error ? error.message : 'Failed to analyze job description.';
      res.status(500).json({ error: message });
    }
  });

  // 4b. Parse raw pasted job prompt / JD into structured fields
  app.post('/api/ai/parse-job-input', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { rawText } = req.body as { rawText?: string };
      if (!rawText || typeof rawText !== 'string' || rawText.trim().length < 10) {
        res.status(400).json({
          error: 'Please paste a job description, posting, or prompt.',
        });
        return;
      }

      const parsed = await parseRawJobInput(rawText.trim());
      res.json(parsed);
    } catch (error: unknown) {
      console.error('Parse job input error:', error);
      const message = error instanceof Error ? error.message : 'Failed to extract job details.';
      res.status(500).json({ error: message });
    }
  });

  // 4c. Optional web-search HR contact lookup when HR email is missing from posting
  app.post('/api/ai/find-hr-contact', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { companyName, jobLocation, jobUrl } = req.body as {
        companyName?: string;
        jobLocation?: string;
        jobUrl?: string;
      };
      if (!companyName || !companyName.trim()) {
        res.status(400).json({ error: 'Company name is required to search for recruitment contact.' });
        return;
      }

      const result = await findCompanyHrContact({
        companyName: companyName.trim(),
        jobLocation: jobLocation?.trim(),
        jobUrl: jobUrl?.trim(),
      });
      res.json(result);
    } catch (error: unknown) {
      console.error('Find HR contact error:', error);
      const message = error instanceof Error ? error.message : 'Failed to search for official HR contact.';
      res.status(500).json({ error: message });
    }
  });

  // 5. Generate AI Follow-Up Email
  app.post('/api/ai/generate-followup', requireAuth, async (req: AuthRequest, res) => {
    try {
      const {
        candidateName,
        companyName,
        jobTitle,
        dateApplied,
        originalEmailSubject,
        originalEmailBody,
        previousFollowUps,
      } = req.body as {
        candidateName?: string;
        companyName?: string;
        jobTitle?: string;
        dateApplied?: string;
        originalEmailSubject?: string;
        originalEmailBody?: string;
        previousFollowUps?: string[];
      };

      if (!companyName || !jobTitle || !dateApplied) {
        res.status(400).json({
          error: 'Company name, job title, and application date are required.',
        });
        return;
      }

      const followUp = await generateFollowUpEmail({
        candidateName: candidateName || req.user?.name || '',
        companyName,
        jobTitle,
        dateApplied,
        originalEmailSubject,
        originalEmailBody,
        previousFollowUps,
      });

      res.json(followUp);
    } catch (error: unknown) {
      console.error('Follow-up generation error:', error);
      const message = error instanceof Error ? error.message : 'Failed to generate follow-up email.';
      res.status(500).json({ error: message });
    }
  });

  // 6. Send Email via connected Gmail account (with optional PDF attachment)
  app.post('/api/gmail/send', requireAuth, async (req: AuthRequest, res) => {
    try {
      const gmailToken = req.headers['x-gmail-token'];
      if (!gmailToken || typeof gmailToken !== 'string') {
        res.status(401).json({
          error: 'Gmail authorization token is missing or expired. Please reconnect your Gmail account.',
        });
        return;
      }

      const {
        toEmail,
        subject,
        body,
        attachmentFileName,
        attachmentBase64,
        threadId,
      } = req.body as {
        toEmail?: string;
        subject?: string;
        body?: string;
        attachmentFileName?: string;
        attachmentBase64?: string;
        threadId?: string;
      };

      if (!toEmail || !subject || !body) {
        res.status(400).json({
          error: 'Recipient email, subject, and email body are required.',
        });
        return;
      }

      const result = await sendGmailMessage({
        accessToken: gmailToken,
        fromEmail: req.user?.email,
        toEmail: toEmail.trim(),
        subject: subject.trim(),
        body,
        attachment:
          attachmentBase64 && attachmentFileName
            ? {
                fileName: attachmentFileName,
                mimeType: 'application/pdf',
                base64Data: attachmentBase64,
              }
            : undefined,
        threadId: threadId || undefined,
      });

      res.json({
        gmailMessageId: result.id,
        gmailThreadId: result.threadId,
        sentAt: new Date().toISOString(),
      });
    } catch (error: unknown) {
      console.error('Gmail send error:', error);
      const message = error instanceof Error ? error.message : 'Failed to send email via Gmail.';
      res.status(502).json({ error: message });
    }
  });

  // 7. Sync and classify incoming HR email replies from Gmail
  app.post('/api/gmail/sync-replies', requireAuth, async (req: AuthRequest, res) => {
    try {
      const gmailToken = req.headers['x-gmail-token'];
      if (!gmailToken || typeof gmailToken !== 'string') {
        res.status(401).json({
          error: 'Gmail authorization token is missing or expired. Please reconnect Gmail to sync replies.',
        });
        return;
      }

      const { applications, existingMessageIds } = req.body as {
        applications?: Array<{
          id: string;
          companyName: string;
          jobTitle: string;
          hrEmail: string;
          gmailThreadId: string;
        }>;
        existingMessageIds?: string[];
      };

      const inboxMessages = await fetchRecentGmailReplies({
        accessToken: gmailToken,
        userEmail: req.user?.email || '',
        maxResults: 15,
      });

      const knownIds = new Set(existingMessageIds || []);
      const freshMessages = inboxMessages.filter(
        (m) => !knownIds.has(m.gmailMessageId)
      );

      if (freshMessages.length === 0) {
        res.json({ replies: [] });
        return;
      }

      const classifications = await classifyIncomingEmailReplies({
        messages: freshMessages,
        applications: applications || [],
      });

      const enriched = freshMessages.map((msg) => {
        const match = classifications.find(
          (c) => c.gmailMessageId === msg.gmailMessageId
        );
        return {
          ...msg,
          matchedApplicationId: match?.matchedApplicationId || '',
          matchConfidence: match?.matchConfidence || 'needs_review',
          classification: match?.classification || 'Other',
        };
      });

      res.json({ replies: enriched });
    } catch (error: unknown) {
      console.error('Gmail reply sync error:', error);
      const message = error instanceof Error ? error.message : 'Failed to sync Gmail replies.';
      res.status(502).json({ error: message });
    }
  });

  // 8. Verify read-only Gmail access for portal confirmation detection
  app.post('/api/gmail/verify-readonly', requireAuth, async (req: AuthRequest, res) => {
    try {
      const gmailToken = req.headers['x-gmail-token'];
      if (!gmailToken || typeof gmailToken !== 'string') {
        res.status(401).json({
          error: 'Gmail read-only authorization token is missing. Authorize read-only Gmail access first.',
        });
        return;
      }

      const profile = await verifyGmailReadonlyProfile(gmailToken);
      res.json({
        ok: true,
        emailAddress: profile.emailAddress,
        messagesTotal: profile.messagesTotal,
        verifiedAt: new Date().toISOString(),
      });
    } catch (error: unknown) {
      console.error('Gmail verify-readonly error:', error);
      const message =
        error instanceof Error ? error.message : 'Failed to verify read-only Gmail connection.';
      res.status(502).json({ error: message });
    }
  });

  // 9. Scan Gmail for job portal & ATS application submission confirmations
  app.post('/api/gmail/scan-confirmations', requireAuth, async (req: AuthRequest, res) => {
    try {
      const gmailToken = req.headers['x-gmail-token'];
      if (!gmailToken || typeof gmailToken !== 'string') {
        res.status(401).json({
          error: 'Gmail read-only authorization token is missing. Authorize Gmail inbox scanning first.',
        });
        return;
      }

      const { portalFilter, existingMessageIds } = req.body as {
        portalFilter?: string;
        existingMessageIds?: string[];
      };

      const candidates = await fetchJobConfirmationEmails({
        accessToken: gmailToken,
        userEmail: req.user?.email || '',
        maxResults: 20,
        portalFilter,
      });

      const knownIds = new Set(existingMessageIds || []);
      const freshMessages = candidates.filter((m) => !knownIds.has(m.gmailMessageId));

      if (freshMessages.length === 0) {
        res.json({
          checkedCount: candidates.length,
          freshCount: 0,
          confirmations: [],
        });
        return;
      }

      const detections = await detectPortalApplicationConfirmations({
        messages: freshMessages,
      });

      const merged = freshMessages.map((msg) => {
        const det = detections.find((d) => d.gmailMessageId === msg.gmailMessageId);
        return {
          gmailMessageId: msg.gmailMessageId,
          gmailThreadId: msg.gmailThreadId,
          fromEmail: msg.fromEmail,
          fromName: msg.fromName,
          subject: msg.subject,
          snippet: msg.snippet,
          receivedAt: msg.receivedAt,
          isConfirmedApplication: det?.isConfirmedApplication ?? false,
          confidence: det?.confidence ?? 'not_application',
          companyName: det?.companyName ?? '',
          jobTitle: det?.jobTitle ?? '',
          jobLocation: det?.jobLocation ?? '',
          jobUrl: det?.jobUrl ?? '',
          applicationSource: det?.applicationSource ?? '',
          applicationDate: det?.applicationDate || msg.receivedAt.slice(0, 10),
          confirmationMessage: det?.confirmationMessage ?? '',
          recruiterName: det?.recruiterName ?? '',
          recruiterEmail: det?.recruiterEmail ?? '',
        };
      });

      res.json({
        checkedCount: candidates.length,
        freshCount: freshMessages.length,
        confirmations: merged,
      });
    } catch (error: unknown) {
      console.error('Gmail scan-confirmations error:', error);
      const message =
        error instanceof Error ? error.message : 'Failed to scan Gmail for application confirmations.';
      res.status(502).json({ error: message });
    }
  });

  // 10. Download Chrome Extension ZIP bundle (preconfigured with current app URL & public Firebase project info)
  app.get('/api/extension/download.zip', async (req, res) => {
    try {
      const extDir = path.join(__dirname, 'chrome-extension');
      const fileNames = [
        'manifest.json',
        'background.js',
        'content.js',
        'popup.html',
        'popup.css',
        'popup.js',
        'README.txt',
      ];

      const entries = await Promise.all(
        fileNames.map(async (name) => ({
          name: `save-to-my-job-tracker/${name}`,
          content: await fs.readFile(path.join(extDir, name)),
        }))
      );

      let fbConfig: { apiKey?: string; projectId?: string; firestoreDatabaseId?: string } = {};
      try {
        const rawCfg = await fs.readFile(path.join(__dirname, 'firebase-applet-config.json'), 'utf8');
        fbConfig = JSON.parse(rawCfg) as typeof fbConfig;
      } catch {
        // optional
      }

      const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
      const protocol = forwardedProto || req.protocol || 'https';
      const host = req.get('host');
      const resolvedAppUrl = (
        process.env.APP_URL ||
        (host ? `${protocol}://${host}` : 'https://jobaitracker.netlify.app')
      ).replace(/\/+$/, '');

      const defaultConfig = {
        appUrl: resolvedAppUrl,
        apiKey: fbConfig.apiKey || '',
        projectId: fbConfig.projectId || '',
        databaseId: fbConfig.firestoreDatabaseId || '(default)',
      };

      entries.push({
        name: 'save-to-my-job-tracker/default-config.json',
        content: Buffer.from(JSON.stringify(defaultConfig, null, 2), 'utf8'),
      });

      const zipBuf = createZipBuffer(entries);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="save-to-my-job-tracker-extension.zip"'
      );
      res.setHeader('Content-Length', String(zipBuf.length));
      res.send(zipBuf);
    } catch (error: unknown) {
      console.error('Extension ZIP download error:', error);
      res.status(500).json({ error: 'Failed to package Chrome extension archive.' });
    }
  });

  // Vite middleware in development, static assets in production
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`My Job Tracker server listening on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
