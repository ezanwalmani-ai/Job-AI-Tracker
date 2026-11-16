import { GoogleGenAI, Type, ThinkingLevel, type GenerateContentParameters } from '@google/genai';
import type { EmailPurposeType } from '../types.ts';
import { normalizeJobLocationToCityState } from './pdfService.ts';
import { aiCacheBuffer } from './aiCacheBuffer.ts';
import {
  isQuotaOrRateLimitError,
  findCompanyHrContactFreeWeb,
  extractCandidateInfoFallback,
  prepareLocationAndJdFallback,
  analyzeManualJdFallback,
  parseRawJobInputFallback,
  generateApplicationEmailFallback,
  generateFollowUpEmailFallback,
  classifyRepliesFallback,
  isLikelyNonApplicationDigest,
  detectPortalConfirmationsFallback,
} from './freeFallbacks.ts';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

const MODEL_PRIMARY_TEXT = 'gemini-4-hydrogen';
const MODEL_FAST_LITE = 'gemini-3.1-flash-lite';

// Brief per-model cooldown (ms) after hitting free-tier quota so repeated searches switch cleanly
// to the alternative model or built-in free engine without stalling.
const MODEL_QUOTA_COOLDOWN_MS = 90 * 1000;
const modelCooldownUntil = new Map<string, number>();

const TTL_24H = 24 * 60 * 60 * 1000;
const TTL_12H = 12 * 60 * 60 * 1000;
const TTL_6H = 6 * 60 * 60 * 1000;
const TTL_2H = 2 * 60 * 60 * 1000;
const TTL_30M = 30 * 60 * 1000;

function isModelInCooldown(model: string): boolean {
  const until = modelCooldownUntil.get(model) ?? 0;
  return Date.now() < until;
}

function markModelCooldown(model: string): void {
  modelCooldownUntil.set(model, Date.now() + MODEL_QUOTA_COOLDOWN_MS);
}

async function generateWithFallback(
  modelOrder: string[],
  buildConfig: (
    model: string,
    thinkingLevel: ThinkingLevel
  ) => Omit<GenerateContentParameters, 'model'>
) {
  let lastErr: unknown = null;

  for (const model of modelOrder) {
    if (isModelInCooldown(model)) continue;

    // gemini-3.1-flash-lite uses MINIMAL; gemini-4-hydrogen supports LOW (never MINIMAL)
    const thinkingLevel =
      model === MODEL_FAST_LITE ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW;

    try {
      const params = buildConfig(model, thinkingLevel);
      return await aiCacheBuffer.scheduleLiveCall(() =>
        ai.models.generateContent({
          model,
          ...params,
        })
      );
    } catch (err) {
      lastErr = err;
      if (isQuotaOrRateLimitError(err)) {
        markModelCooldown(model);
        continue;
      }
      throw err;
    }
  }

  throw lastErr ?? new Error('AI quota temporarily reached; using built-in free engine.');
}

export interface CandidateResumeInfo {
  candidateName: string;
  candidateEmail: string;
  candidatePhone: string;
  originalLocation: string;
}

export async function extractCandidateInfoFromText(
  extractedText: string
): Promise<CandidateResumeInfo> {
  const { value } = await aiCacheBuffer.getOrCompute<CandidateResumeInfo>({
    namespace: 'resume_extract',
    keyParts: [extractedText.slice(0, 12000)],
    ttlMs: TTL_24H,
    compute: async () => {
      try {
        const response = await generateWithFallback(
          [MODEL_FAST_LITE, MODEL_PRIMARY_TEXT],
          (_model, thinkingLevel) => ({
            contents: `Extract the candidate's contact header metadata from this resume text. Return the exact location/city/address substring as it literally appears on the resume (do not normalize or rewrite it). If a field is not found, return an empty string "".

RESUME TEXT:
${extractedText.slice(0, 12000)}`,
            config: {
              systemInstruction:
                'You extract exact factual contact metadata from a candidate resume without inventing or altering any values.',
              thinkingConfig: { thinkingLevel },
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  candidateName: { type: Type.STRING, description: 'Full name of the candidate.' },
                  candidateEmail: { type: Type.STRING, description: 'Email address on the resume.' },
                  candidatePhone: { type: Type.STRING, description: 'Phone number on the resume.' },
                  originalLocation: {
                    type: Type.STRING,
                    description:
                      'Exact literal city/state/location substring as printed in the resume header or contact section (e.g. "Bengaluru, Karnataka" or "San Francisco, CA"). Empty string if absent.',
                  },
                },
                required: [
                  'candidateName',
                  'candidateEmail',
                  'candidatePhone',
                  'originalLocation',
                ],
              },
            },
          })
        );

        const parsed = JSON.parse((response.text ?? '{}').trim()) as Partial<CandidateResumeInfo>;
        return {
          candidateName: (parsed.candidateName ?? '').trim(),
          candidateEmail: (parsed.candidateEmail ?? '').trim(),
          candidatePhone: (parsed.candidatePhone ?? '').trim(),
          originalLocation: (parsed.originalLocation ?? '').trim(),
        };
      } catch {
        aiCacheBuffer.recordFallback();
        return extractCandidateInfoFallback(extractedText);
      }
    },
  });

  return value;
}

export interface TailoredLocationResult {
  exactOriginalSubstring: string;
  replacementLocationText: string;
  jdSummary: string;
  keyRequirements: string[];
}

export async function prepareLocationAndJdAnalysis(params: {
  extractedText: string;
  originalLocation: string;
  jobLocation: string;
  companyName: string;
  jobTitle: string;
  jobDescription: string;
}): Promise<TailoredLocationResult> {
  const normalizedTarget =
    normalizeJobLocationToCityState(params.jobLocation) || params.jobLocation.trim();
  const enforcedReplacement = `Preferred Location: ${normalizedTarget}`;

  const { value } = await aiCacheBuffer.getOrCompute<TailoredLocationResult>({
    namespace: 'resume_location_jd',
    keyParts: [
      params.originalLocation,
      normalizedTarget,
      params.companyName.trim().toLowerCase(),
      params.jobTitle.trim().toLowerCase(),
      params.jobDescription.slice(0, 4000),
    ],
    ttlMs: TTL_6H,
    compute: async () => {
      try {
        const response = await generateWithFallback(
          [MODEL_FAST_LITE, MODEL_PRIMARY_TEXT],
          (_model, thinkingLevel) => ({
            contents: `You have two strict tasks:
1. Determine the exact literal location substring in the candidate's master resume to update with the clearly labelled target/preferred location "${enforcedReplacement}" WITHOUT falsely claiming it as the candidate's current residential address.
   - Candidate's stored original location string: ${JSON.stringify(params.originalLocation)}
   - Target normalized City, State: ${JSON.stringify(normalizedTarget)}
   - Confirm exactOriginalSubstring is the literal substring from the resume text to replace (or "" if none exists).
2. Analyze the Job Description for ${params.jobTitle} at ${params.companyName} and summarize its core focus and up to 6 key requirements.

RESUME EXCERPT:
${params.extractedText.slice(0, 6000)}

JOB DESCRIPTION:
${params.jobDescription.slice(0, 12000)}`,
            config: {
              systemInstruction:
                'Follow instructions strictly. Never alter employment history, skills, dates, titles, education, or contact details. Use City, State format only.',
              thinkingConfig: { thinkingLevel },
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  exactOriginalSubstring: {
                    type: Type.STRING,
                    description:
                      'Exact literal location substring in the resume to replace, or empty string.',
                  },
                  replacementLocationText: {
                    type: Type.STRING,
                    description:
                      'Clearly labelled target/preferred job location text, e.g., "Preferred Location: Pune, Maharashtra".',
                  },
                  jdSummary: {
                    type: Type.STRING,
                    description: 'Concise 2-sentence summary of the role and what the company seeks.',
                  },
                  keyRequirements: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: 'Up to 6 key requirements extracted from the job description.',
                  },
                },
                required: [
                  'exactOriginalSubstring',
                  'replacementLocationText',
                  'jdSummary',
                  'keyRequirements',
                ],
              },
            },
          })
        );

        const parsed = JSON.parse(
          (response.text ?? '{}').trim()
        ) as Partial<TailoredLocationResult>;
        return {
          exactOriginalSubstring: (parsed.exactOriginalSubstring ?? params.originalLocation).trim(),
          replacementLocationText: enforcedReplacement,
          jdSummary: (parsed.jdSummary ?? '').trim(),
          keyRequirements: Array.isArray(parsed.keyRequirements)
            ? parsed.keyRequirements.slice(0, 8)
            : [],
        };
      } catch {
        aiCacheBuffer.recordFallback();
        return prepareLocationAndJdFallback({
          originalLocation: params.originalLocation,
          jobLocation: normalizedTarget,
          companyName: params.companyName,
          jobTitle: params.jobTitle,
          jobDescription: params.jobDescription,
        });
      }
    },
  });

  return value;
}

function getCanonicalSubject(
  emailType: EmailPurposeType,
  jobTitle: string,
  companyName: string,
  candidateDisplay: string
): string {
  switch (emailType) {
    case 'follow_up':
      return `Follow-up on ${jobTitle} Application – ${companyName}`;
    case 'recruitment_enquiry':
      return `Recruitment Enquiry: ${jobTitle} Opportunities at ${companyName} – ${candidateDisplay}`;
    case 'response_to_hr_email':
      return `Application for ${jobTitle} – ${candidateDisplay}`;
    case 'application_unnamed_recruiter':
      return `Application for ${jobTitle} at ${companyName} – ${candidateDisplay}`;
    case 'initial_application':
    default:
      return `Application for ${jobTitle} at ${companyName} – ${candidateDisplay}`;
  }
}

function getEmailTypeGuidance(
  emailType: EmailPurposeType,
  params: {
    companyName: string;
    jobTitle: string;
    jobLocation: string;
    recruiterName?: string;
  }
): string {
  const locPart = params.jobLocation ? ` (${params.jobLocation})` : '';
  switch (emailType) {
    case 'follow_up':
      return `EMAIL TYPE: Follow-up after applying
- Write a courteous, concise follow-up checking on the status of your ${params.jobTitle} application at ${params.companyName}${locPart}.
- Briefly reinforce 2 verified qualifications from the resume that match the role without repeating your whole CV.
- Express readiness to share any extra details or schedule a discussion.`;
    case 'recruitment_enquiry':
      return `EMAIL TYPE: Recruitment enquiry
- Write a crisp, proactive recruitment enquiry to ${params.companyName} regarding ${params.jobTitle} or closely aligned openings${locPart}.
- Summarize the candidate's verified relevant domain experience and key skills from the resume, and note that the updated resume PDF is attached.`;
    case 'response_to_hr_email':
      return `EMAIL TYPE: Response to an HR vacancy email
- Write a direct, professional reply referencing the vacancy details shared by ${params.recruiterName?.trim() || 'the recruitment team'} for the ${params.jobTitle} position at ${params.companyName}${locPart}.
- Confirm fit with the stated requirements using strictly verified resume experience and state that the updated resume PDF is attached.`;
    case 'application_unnamed_recruiter':
      return `EMAIL TYPE: Application to a company without a named recruiter
- Do NOT invent any person's name. Address "Dear ${params.companyName} Hiring Team," or "Dear Hiring Manager,".
- Present a concise, persuasive application for ${params.jobTitle} at ${params.companyName}${locPart} grounded strictly in verified resume achievements, and note that the tailored resume PDF is attached.`;
    case 'initial_application':
    default:
      return `EMAIL TYPE: Initial job application
- Open clearly with your application for the exact ${params.jobTitle} role at ${params.companyName}${locPart}.
- Connect 2–3 verified work experiences and skills from the resume directly to the job's top requirements.
- Mention cleanly that your updated resume PDF is attached for review.`;
  }
}

export async function generateJobApplicationEmail(params: {
  extractedText: string;
  candidateName: string;
  candidateEmail: string;
  candidatePhone: string;
  companyName: string;
  jobTitle: string;
  jobLocation: string;
  jobDescription: string;
  recruiterName?: string;
  requiredExperience?: string;
  requiredSkills?: string[];
  responsibilities?: string[];
  applicationInstructions?: string;
  emailType?: EmailPurposeType;
  bypassCache?: boolean;
}): Promise<{ subject: string; body: string }> {
  const candidateDisplay = params.candidateName || 'Candidate';
  const emailType: EmailPurposeType =
    params.emailType ||
    (params.recruiterName?.trim() ? 'initial_application' : 'application_unnamed_recruiter');
  const normalizedLocation =
    normalizeJobLocationToCityState(params.jobLocation) || params.jobLocation;
  const targetSubject = getCanonicalSubject(
    emailType,
    params.jobTitle.trim(),
    params.companyName.trim(),
    candidateDisplay
  );

  const greetingInstruction =
    emailType !== 'application_unnamed_recruiter' && params.recruiterName?.trim()
      ? `Address the email directly to "${params.recruiterName.trim()}" (e.g., "Dear ${params.recruiterName.trim()},").`
      : `Use a professional greeting such as "Dear ${params.companyName} Hiring Team," or "Dear Hiring Manager,".`;

  const typeGuidance = getEmailTypeGuidance(emailType, {
    companyName: params.companyName,
    jobTitle: params.jobTitle,
    jobLocation: normalizedLocation,
    recruiterName: params.recruiterName,
  });

  const { value } = await aiCacheBuffer.getOrCompute<{ subject: string; body: string }>({
    namespace: 'email_generate',
    keyParts: [
      candidateDisplay,
      params.companyName.trim().toLowerCase(),
      params.jobTitle.trim().toLowerCase(),
      normalizedLocation,
      params.recruiterName?.trim() ?? '',
      emailType,
      params.jobDescription.slice(0, 4000),
      params.extractedText.slice(0, 2000),
    ],
    ttlMs: TTL_2H,
    bypassCache: params.bypassCache,
    shouldCache: (res) => Boolean(res.body.trim()),
    compute: async () => {
      try {
        const response = await generateWithFallback(
          [MODEL_PRIMARY_TEXT, MODEL_FAST_LITE],
          (_model, thinkingLevel) => ({
            contents: `Write a concise, convincing, professional business email using ONLY verified facts from the candidate's master resume and the job description below.

CANDIDATE DETAILS:
Name: ${candidateDisplay}
Email: ${params.candidateEmail}
Phone: ${params.candidatePhone}

VERIFIED MASTER RESUME:
${params.extractedText.slice(0, 14000)}

TARGET JOB:
Company: ${params.companyName}
Exact Job Title: ${params.jobTitle}
Location: ${normalizedLocation}
${params.recruiterName ? `Recruiter / HR Name: ${params.recruiterName}\n` : ''}${params.requiredExperience ? `Required Experience: ${params.requiredExperience}\n` : ''}${params.requiredSkills && params.requiredSkills.length > 0 ? `Key Skills Requested: ${params.requiredSkills.join(', ')}\n` : ''}${params.responsibilities && params.responsibilities.length > 0 ? `Key Responsibilities: ${params.responsibilities.join('; ')}\n` : ''}${params.applicationInstructions ? `Application Instructions: ${params.applicationInstructions}\n` : ''}Job Description:
${params.jobDescription.slice(0, 10000)}

${typeGuidance}

MANDATORY RULES:
1. Subject line MUST follow: ${targetSubject}
   - NEVER use generic subjects like "Job Application" or "Resume Attached".
   - NEVER alter or invent the job title — keep "${params.jobTitle}" exact.
   - NO emojis or promotional fluff.
2. Email body MUST use clean blank lines between short, scannable paragraphs:
   - Greeting: ${greetingInstruction}
   - Opening: Clear 1–2 sentence context referencing the exact ${params.jobTitle} role at ${params.companyName}${normalizedLocation ? ` (${normalizedLocation})` : ''}.
   - Relevant Experience: Highlight verified roles, companies, tools, or measurable outcomes strictly from the master resume that solve what this JD needs.
   - Suitability & Value: Connect verified skills/qualifications to the core responsibilities cleanly without copying the JD or repeating the resume line-by-line.
   - Next Step / Attachment: Natural closing sentence referencing the attached tailored resume PDF${emailType === 'follow_up' ? ' (or prior submission)' : ''} and openness to an interview/conversation.
   - Sign-off: Professional closing with ${candidateDisplay}${params.candidateEmail ? `, ${params.candidateEmail}` : ''}${params.candidatePhone ? `, ${params.candidatePhone}` : ''}.
3. STRICT GROUNDING: NEVER invent experience, metrics, employers, certifications, or skills not explicitly in the master resume.
4. AVOID clichés ("I am writing to express my keen interest", "dynamic self-starter", "hit the ground running", "esteemed organization"). Sound natural, confident, and human.`,
            config: {
              systemInstruction:
                'You are an executive business communications writer. Write tailored, concise, grounded job application emails strictly from verified resume facts without clichés or invented claims.',
              thinkingConfig: { thinkingLevel },
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  subject: { type: Type.STRING },
                  body: { type: Type.STRING },
                },
                required: ['subject', 'body'],
              },
            },
          })
        );

        const parsed = JSON.parse((response.text ?? '{}').trim()) as {
          subject?: string;
          body?: string;
        };
        let subject = (parsed.subject ?? '').trim();

        const lowerSubj = subject.toLowerCase();
        const isGeneric =
          !subject ||
          lowerSubj === 'job application' ||
          lowerSubj === 'resume attached' ||
          lowerSubj === 'application' ||
          !lowerSubj.includes(params.jobTitle.trim().toLowerCase());

        if (isGeneric) {
          subject = targetSubject;
        }

        return {
          subject,
          body: (parsed.body ?? '').trim(),
        };
      } catch {
        aiCacheBuffer.recordFallback();
        return generateApplicationEmailFallback(params);
      }
    },
  });

  return value;
}

export async function analyzeManualJobDescription(params: {
  companyName: string;
  jobTitle: string;
  jobLocation: string;
  jobDescription: string;
}): Promise<{ aiSummary: string; keyRequirements: string[] }> {
  const { value } = await aiCacheBuffer.getOrCompute<{
    aiSummary: string;
    keyRequirements: string[];
  }>({
    namespace: 'job_analyze_jd',
    keyParts: [
      params.companyName.trim().toLowerCase(),
      params.jobTitle.trim().toLowerCase(),
      params.jobLocation.trim().toLowerCase(),
      params.jobDescription.slice(0, 6000),
    ],
    ttlMs: TTL_6H,
    compute: async () => {
      try {
        const response = await generateWithFallback(
          [MODEL_FAST_LITE, MODEL_PRIMARY_TEXT],
          (_model, thinkingLevel) => ({
            contents: `Analyze this job posting for ${params.jobTitle} at ${params.companyName} (${params.jobLocation}). Provide a crisp 2-sentence summary and up to 6 key requirements.

JOB DESCRIPTION:
${params.jobDescription.slice(0, 12000)}`,
            config: {
              thinkingConfig: { thinkingLevel },
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  aiSummary: { type: Type.STRING },
                  keyRequirements: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                },
                required: ['aiSummary', 'keyRequirements'],
              },
            },
          })
        );

        const parsed = JSON.parse((response.text ?? '{}').trim()) as {
          aiSummary?: string;
          keyRequirements?: string[];
        };
        return {
          aiSummary: (parsed.aiSummary ?? '').trim(),
          keyRequirements: Array.isArray(parsed.keyRequirements)
            ? parsed.keyRequirements.slice(0, 8)
            : [],
        };
      } catch {
        aiCacheBuffer.recordFallback();
        return analyzeManualJdFallback(params);
      }
    },
  });

  return value;
}

export interface ParsedJobInput {
  companyName: string;
  jobTitle: string;
  extractedDescription: string;
  responsibilities: string[];
  requiredExperience: string;
  requiredSkills: string[];
  preferredQualifications: string[];
  jobLocation: string;
  companyAddress: string;
  recruiterName: string;
  hrEmail: string;
  jobUrl: string;
  salary: string;
  employmentType: string;
  applicationInstructions: string;
  applicationSource: string;
  notes: string;
  aiSummary: string;
  keyRequirements: string[];
}

export async function parseRawJobInput(rawText: string): Promise<ParsedJobInput> {
  const { value } = await aiCacheBuffer.getOrCompute<ParsedJobInput>({
    namespace: 'job_parse',
    keyParts: [rawText.trim().slice(0, 18000)],
    ttlMs: TTL_6H,
    compute: async () => {
      try {
        const response = await generateWithFallback(
          [MODEL_FAST_LITE, MODEL_PRIMARY_TEXT],
          (_model, thinkingLevel) => ({
            contents: `Extract structured job application details from the pasted job posting, recruitment email, LinkedIn/Naukri/Indeed ad, or careers page text below.

PASTED CONTENT:
${rawText.slice(0, 18000)}

EXTRACTION RULES (STRICT):
1. Understand ANY format (LinkedIn posting, HR recruitment email, Naukri/Indeed listing, company careers page, or plain text vacancy).
2. Extract ONLY factual information present in the pasted text. NEVER invent or guess an email address, company name, or URL.
   - companyName: Exact hiring company name if stated; otherwise "".
   - jobTitle: Exact role/position title if stated; otherwise "".
   - jobLocation: Extract ONLY "City, State" wherever available (or city alone if state cannot be identified; or "Remote" if explicitly remote). Strip street names, building names, office numbers, pin codes, sectors, phases, and localities. Examples: "Baner, Pune, Maharashtra" -> "Pune, Maharashtra"; "MG Road, Bengaluru, Karnataka" -> "Bengaluru, Karnataka"; "Hinjewadi Phase 2, Pune" -> "Pune, Maharashtra"; "Whitefield, Bangalore" -> "Bengaluru, Karnataka"; "Andheri East, Mumbai" -> "Mumbai, Maharashtra"; "HITEC City, Hyderabad" -> "Hyderabad, Telangana"; "Gurgaon, Haryana" -> "Gurugram, Haryana"; "Noida Sector 62, Uttar Pradesh" -> "Noida, Uttar Pradesh". Do NOT put "Remote" unless stated.
   - companyAddress: Full street/office address if stated (keep full address here, separate from jobLocation); otherwise "".
   - recruiterName: Name of the HR/recruiter/contact person if stated; otherwise "".
   - hrEmail: Application or HR/recruiter email address literally present in the text; otherwise "" (NEVER fabricate!).
   - jobUrl: Application URL literally present in the text; otherwise "".
   - salary: Salary, CTC, or pay range if stated; otherwise "".
   - employmentType: e.g., "Full-time", "Contract", "Internship", "Part-time", "Hybrid", "Remote" if stated; otherwise "".
   - requiredExperience: Experience range/years required (e.g., "2–4 years", "Freshers"); otherwise "".
   - responsibilities: Up to 8 concise job responsibility items.
   - requiredSkills: Up to 12 required technical or domain skills.
   - preferredQualifications: Up to 6 preferred/nice-to-have qualifications.
   - applicationInstructions: Any specific instructions (e.g., subject line instructions, portfolio request, call timing); otherwise "".
   - extractedDescription: Clean, readable full job description text preserving all role details.
   - applicationSource: Identify source if clear ("LinkedIn", "HR Email", "Naukri", "Indeed", "WorkIndia", "Apna", "Company Careers Page", "Wellfound", "Glassdoor", "Referral", or "Job Posting").
   - aiSummary: Crisp 2-sentence summary of the opportunity.
   - keyRequirements: Up to 6 top requirements.`,
            config: {
              systemInstruction:
                'You are a precision job-posting parser. Extract all available factual fields from any unstructured job advertisement or recruitment email without ever inventing missing emails, company names, or facts.',
              thinkingConfig: { thinkingLevel },
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  companyName: { type: Type.STRING },
                  jobTitle: { type: Type.STRING },
                  extractedDescription: { type: Type.STRING },
                  responsibilities: { type: Type.ARRAY, items: { type: Type.STRING } },
                  requiredExperience: { type: Type.STRING },
                  requiredSkills: { type: Type.ARRAY, items: { type: Type.STRING } },
                  preferredQualifications: { type: Type.ARRAY, items: { type: Type.STRING } },
                  jobLocation: { type: Type.STRING },
                  companyAddress: { type: Type.STRING },
                  recruiterName: { type: Type.STRING },
                  hrEmail: { type: Type.STRING },
                  jobUrl: { type: Type.STRING },
                  salary: { type: Type.STRING },
                  employmentType: { type: Type.STRING },
                  applicationInstructions: { type: Type.STRING },
                  applicationSource: { type: Type.STRING },
                  notes: { type: Type.STRING },
                  aiSummary: { type: Type.STRING },
                  keyRequirements: { type: Type.ARRAY, items: { type: Type.STRING } },
                },
                required: [
                  'companyName',
                  'jobTitle',
                  'extractedDescription',
                  'responsibilities',
                  'requiredExperience',
                  'requiredSkills',
                  'preferredQualifications',
                  'jobLocation',
                  'companyAddress',
                  'recruiterName',
                  'hrEmail',
                  'jobUrl',
                  'salary',
                  'employmentType',
                  'applicationInstructions',
                  'applicationSource',
                  'notes',
                  'aiSummary',
                  'keyRequirements',
                ],
              },
            },
          })
        );

        const parsed = JSON.parse((response.text ?? '{}').trim()) as Partial<ParsedJobInput>;
        return {
          companyName: (parsed.companyName ?? '').trim(),
          jobTitle: (parsed.jobTitle ?? '').trim(),
          extractedDescription: (parsed.extractedDescription ?? '').trim() || rawText.trim(),
          responsibilities: Array.isArray(parsed.responsibilities)
            ? parsed.responsibilities.slice(0, 8)
            : [],
          requiredExperience: (parsed.requiredExperience ?? '').trim(),
          requiredSkills: Array.isArray(parsed.requiredSkills)
            ? parsed.requiredSkills.slice(0, 12)
            : [],
          preferredQualifications: Array.isArray(parsed.preferredQualifications)
            ? parsed.preferredQualifications.slice(0, 6)
            : [],
          jobLocation: normalizeJobLocationToCityState((parsed.jobLocation ?? '').trim()),
          companyAddress: (parsed.companyAddress ?? '').trim(),
          recruiterName: (parsed.recruiterName ?? '').trim(),
          hrEmail: (parsed.hrEmail ?? '').trim(),
          jobUrl: (parsed.jobUrl ?? '').trim(),
          salary: (parsed.salary ?? '').trim(),
          employmentType: (parsed.employmentType ?? '').trim(),
          applicationInstructions: (parsed.applicationInstructions ?? '').trim(),
          applicationSource: (parsed.applicationSource ?? '').trim() || 'Job Posting',
          notes: (parsed.notes ?? '').trim(),
          aiSummary: (parsed.aiSummary ?? '').trim(),
          keyRequirements: Array.isArray(parsed.keyRequirements)
            ? parsed.keyRequirements.slice(0, 8)
            : [],
        };
      } catch {
        aiCacheBuffer.recordFallback();
        return parseRawJobInputFallback(rawText);
      }
    },
  });

  return value;
}

export async function findCompanyHrContact(params: {
  companyName: string;
  jobLocation?: string;
  jobUrl?: string;
}): Promise<{ hrEmail: string; sourceTitle: string; sourceUrl: string; message: string }> {
  const normalizedCompany = params.companyName.trim().toLowerCase();
  const normalizedLoc = (params.jobLocation ?? '').trim().toLowerCase();
  const normalizedUrl = (params.jobUrl ?? '').trim().toLowerCase();

  // Check negative/transient results separately via short TTL vs positive hits for 12h
  const posKey = aiCacheBuffer.makeKey('hr_lookup_hit', [normalizedCompany, normalizedLoc, normalizedUrl]);
  const cachedPositive = aiCacheBuffer.get<{
    hrEmail: string;
    sourceTitle: string;
    sourceUrl: string;
    message: string;
  }>(posKey);
  if (cachedPositive) {
    aiCacheBuffer.recordHit();
    return cachedPositive;
  }

  const { value } = await aiCacheBuffer.getOrCompute<{
    hrEmail: string;
    sourceTitle: string;
    sourceUrl: string;
    message: string;
  }>({
    namespace: 'hr_lookup',
    keyParts: [normalizedCompany, normalizedLoc, normalizedUrl],
    ttlMs: TTL_30M,
    compute: async () => {
      // 1. Unlimited zero-AI-quota direct website + public search lookup first
      const freeResult = await findCompanyHrContactFreeWeb(params);
      if (freeResult && freeResult.hrEmail) {
        aiCacheBuffer.set(posKey, 'hr_lookup_hit', freeResult, TTL_12H);
        return freeResult;
      }

      // 2. Optionally query Gemini Google Search Grounding (with cooldown + fallback)
      try {
        const response = await generateWithFallback(
          [MODEL_FAST_LITE, MODEL_PRIMARY_TEXT],
          (_model, thinkingLevel) => ({
            contents: `Search for the official careers or HR recruitment email address for "${params.companyName}"${params.jobLocation ? ` (${params.jobLocation})` : ''}${params.jobUrl ? ` related to ${params.jobUrl}` : ''}.
Return ONLY a verified official careers/HR/recruitment email address explicitly published on the company's official website or official careers/contact page.
If no verified official recruitment email address is publicly published in the search results, explicitly state "NONE_FOUND" and do NOT guess or invent an email.`,
            config: {
              tools: [{ googleSearch: {} }],
              thinkingConfig: { thinkingLevel },
            },
          })
        );

        const text = (response.text ?? '').trim();
        const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
        const firstWeb = chunks.find((c) => c.web?.uri)?.web;

        if (!text || text.includes('NONE_FOUND')) {
          return {
            hrEmail: '',
            sourceTitle: firstWeb?.title || '',
            sourceUrl: firstWeb?.uri || '',
            message: 'No verified official recruitment email found in public web results.',
          };
        }

        const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (!emailMatch) {
          return {
            hrEmail: '',
            sourceTitle: firstWeb?.title || '',
            sourceUrl: firstWeb?.uri || '',
            message: 'No verified official recruitment email found in public web results.',
          };
        }

        const hit = {
          hrEmail: emailMatch[0],
          sourceTitle: firstWeb?.title || 'Official web search result',
          sourceUrl: firstWeb?.uri || '',
          message: `Discovered ${emailMatch[0]} via public web search.`,
        };
        aiCacheBuffer.set(posKey, 'hr_lookup_hit', hit, TTL_12H);
        return hit;
      } catch {
        aiCacheBuffer.recordFallback();
        return {
          hrEmail: '',
          sourceTitle: 'Free direct web check',
          sourceUrl: '',
          message:
            'No public HR email found on company career/contact pages (AI web search quota temporarily reached — you can still enter an HR email manually or record as a Job Portal application).',
        };
      }
    },
  });

  return value;
}

export async function generateFollowUpEmail(params: {
  candidateName: string;
  companyName: string;
  jobTitle: string;
  dateApplied: string;
  originalEmailSubject?: string;
  originalEmailBody?: string;
  previousFollowUps?: string[];
  bypassCache?: boolean;
}): Promise<{ subject: string; body: string }> {
  const candidateDisplay = params.candidateName || 'Candidate';
  const expectedSubject = `Follow-up on ${params.jobTitle} Application – ${params.companyName}`;

  const { value } = await aiCacheBuffer.getOrCompute<{ subject: string; body: string }>({
    namespace: 'email_followup',
    keyParts: [
      candidateDisplay,
      params.companyName.trim().toLowerCase(),
      params.jobTitle.trim().toLowerCase(),
      params.dateApplied,
      params.originalEmailSubject ?? '',
      (params.previousFollowUps ?? []).length,
    ],
    ttlMs: TTL_2H,
    bypassCache: params.bypassCache,
    shouldCache: (res) => Boolean(res.body.trim()),
    compute: async () => {
      try {
        const response = await generateWithFallback(
          [MODEL_PRIMARY_TEXT, MODEL_FAST_LITE],
          (_model, thinkingLevel) => ({
            contents: `Write a polite, concise, professional follow-up email for a job application.

Candidate Name: ${candidateDisplay}
Company: ${params.companyName}
Job Title: ${params.jobTitle}
Date Applied: ${params.dateApplied}
Original Application Subject: ${params.originalEmailSubject || `Application for ${params.jobTitle} – ${candidateDisplay}`}
Original Email Summary: ${(params.originalEmailBody || '').slice(0, 2000)}
Previous Follow-Ups: ${(params.previousFollowUps || []).join('\n---\n').slice(0, 1500)}

RULES:
1. Subject line MUST follow: ${expectedSubject}
2. Keep it courteous, respectful of the recruiter's time, and concise (3 short paragraphs max).
3. Reference the specific role (${params.jobTitle}) at ${params.companyName} and application date (${params.dateApplied}).
4. Reiterate enthusiasm and readiness to share any additional details or schedule a conversation.
5. Never fabricate facts or use clichés.`,
            config: {
              thinkingConfig: { thinkingLevel },
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  subject: { type: Type.STRING },
                  body: { type: Type.STRING },
                },
                required: ['subject', 'body'],
              },
            },
          })
        );

        const parsed = JSON.parse((response.text ?? '{}').trim()) as {
          subject?: string;
          body?: string;
        };
        let subject = (parsed.subject ?? '').trim();
        if (!subject || !subject.toLowerCase().includes(params.jobTitle.trim().toLowerCase())) {
          subject = expectedSubject;
        }
        return {
          subject,
          body: (parsed.body ?? '').trim(),
        };
      } catch {
        aiCacheBuffer.recordFallback();
        return generateFollowUpEmailFallback({
          candidateName: candidateDisplay,
          companyName: params.companyName,
          jobTitle: params.jobTitle,
          dateApplied: params.dateApplied,
        });
      }
    },
  });

  return value;
}

export type ReplyClassificationType =
  | 'Interview Invitation'
  | 'Further Information Requested'
  | 'Rejection'
  | 'Acknowledgement'
  | 'Other';

export interface ClassifiedReplyItem {
  gmailMessageId: string;
  matchedApplicationId: string;
  matchConfidence: 'high' | 'needs_review';
  classification: ReplyClassificationType;
}

export async function classifyIncomingEmailReplies(params: {
  messages: Array<{
    gmailMessageId: string;
    gmailThreadId: string;
    fromEmail: string;
    fromName: string;
    subject: string;
    snippet: string;
  }>;
  applications: Array<{
    id: string;
    companyName: string;
    jobTitle: string;
    hrEmail: string;
    gmailThreadId: string;
  }>;
}): Promise<ClassifiedReplyItem[]> {
  if (params.messages.length === 0) return [];

  const appDigest = params.applications
    .slice(0, 60)
    .map((a) => a.id)
    .join(',');

  const cachedItems: ClassifiedReplyItem[] = [];
  const uncachedMessages: typeof params.messages = [];

  for (const m of params.messages.slice(0, 25)) {
    const mKey = aiCacheBuffer.makeKey('gmail_classify_msg', [m.gmailMessageId, appDigest]);
    const hit = aiCacheBuffer.get<ClassifiedReplyItem>(mKey);
    if (hit) {
      aiCacheBuffer.recordHit();
      cachedItems.push(hit);
    } else {
      uncachedMessages.push(m);
    }
  }

  if (uncachedMessages.length === 0) return cachedItems;

  let freshResults: ClassifiedReplyItem[];
  try {
    const response = await generateWithFallback(
      [MODEL_FAST_LITE, MODEL_PRIMARY_TEXT],
      (_model, thinkingLevel) => ({
        contents: `Match and classify incoming emails against the candidate's tracked job applications.

TRACKED APPLICATIONS:
${JSON.stringify(params.applications.slice(0, 60), null, 2)}

INCOMING MESSAGES:
${JSON.stringify(uncachedMessages, null, 2)}

RULES:
1. If a message shares the exact gmailThreadId with an application, or clearly comes from the company's domain/HR email and references the company/job title, match it with matchConfidence = "high".
2. If it looks job-application-related (e.g. from a recruiter, ATS, or mentions an application/interview/role) but cannot be matched with high certainty to one specific application, set matchedApplicationId = "" (or best guess) and matchConfidence = "needs_review".
3. Classify every message as one of:
   - "Interview Invitation"
   - "Further Information Requested"
   - "Rejection"
   - "Acknowledgement"
   - "Other"`,
        config: {
          thinkingConfig: { thinkingLevel },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                gmailMessageId: { type: Type.STRING },
                matchedApplicationId: { type: Type.STRING },
                matchConfidence: { type: Type.STRING },
                classification: { type: Type.STRING },
              },
              required: ['gmailMessageId', 'matchedApplicationId', 'matchConfidence', 'classification'],
            },
          },
        },
      })
    );

    const parsed = JSON.parse((response.text ?? '[]').trim()) as Array<Partial<ClassifiedReplyItem>>;
    const validClasses = new Set<ReplyClassificationType>([
      'Interview Invitation',
      'Further Information Requested',
      'Rejection',
      'Acknowledgement',
      'Other',
    ]);

    freshResults = parsed.map((item) => ({
      gmailMessageId: String(item.gmailMessageId ?? ''),
      matchedApplicationId: String(item.matchedApplicationId ?? ''),
      matchConfidence: item.matchConfidence === 'high' ? 'high' : 'needs_review',
      classification: validClasses.has(item.classification as ReplyClassificationType)
        ? (item.classification as ReplyClassificationType)
        : 'Other',
    }));
  } catch {
    aiCacheBuffer.recordFallback();
    freshResults = classifyRepliesFallback({
      messages: uncachedMessages,
      applications: params.applications,
    });
  }

  for (const item of freshResults) {
    if (item.gmailMessageId) {
      const mKey = aiCacheBuffer.makeKey('gmail_classify_msg', [item.gmailMessageId, appDigest]);
      aiCacheBuffer.set(mKey, 'gmail_classify_msg', item, TTL_24H);
    }
  }

  return [...cachedItems, ...freshResults];
}

export interface DetectedPortalConfirmationItem {
  gmailMessageId: string;
  isConfirmedApplication: boolean;
  confidence: 'high' | 'incomplete' | 'not_application';
  companyName: string;
  jobTitle: string;
  jobLocation: string;
  jobUrl: string;
  applicationSource: string;
  applicationDate: string;
  confirmationMessage: string;
  recruiterName: string;
  recruiterEmail: string;
}

export async function detectPortalApplicationConfirmations(params: {
  messages: Array<{
    gmailMessageId: string;
    fromEmail: string;
    fromName: string;
    subject: string;
    snippet: string;
    bodyExcerpt: string;
    receivedAt: string;
  }>;
}): Promise<DetectedPortalConfirmationItem[]> {
  if (params.messages.length === 0) return [];

  const cachedOrSkipped: DetectedPortalConfirmationItem[] = [];
  const candidateMessages: typeof params.messages = [];

  for (const m of params.messages.slice(0, 20)) {
    const mKey = aiCacheBuffer.makeKey('gmail_confirm_msg', [m.gmailMessageId]);
    const cached = aiCacheBuffer.get<DetectedPortalConfirmationItem>(mKey);
    if (cached) {
      aiCacheBuffer.recordHit();
      cachedOrSkipped.push(cached);
      continue;
    }

    if (isLikelyNonApplicationDigest(m.subject, m.snippet)) {
      const skippedItem: DetectedPortalConfirmationItem = {
        gmailMessageId: m.gmailMessageId,
        isConfirmedApplication: false,
        confidence: 'not_application',
        companyName: '',
        jobTitle: '',
        jobLocation: '',
        jobUrl: '',
        applicationSource: 'Company Career Page',
        applicationDate: m.receivedAt.slice(0, 10),
        confirmationMessage: '',
        recruiterName: '',
        recruiterEmail: '',
      };
      aiCacheBuffer.set(mKey, 'gmail_confirm_msg', skippedItem, TTL_24H);
      cachedOrSkipped.push(skippedItem);
    } else {
      candidateMessages.push(m);
    }
  }

  if (candidateMessages.length === 0) return cachedOrSkipped;

  const compactMessages = candidateMessages.map((m) => ({
    gmailMessageId: m.gmailMessageId,
    fromEmail: m.fromEmail,
    fromName: m.fromName,
    subject: m.subject,
    receivedAt: m.receivedAt,
    content: (m.bodyExcerpt || m.snippet || '').slice(0, 2200),
  }));

  let freshResults: DetectedPortalConfirmationItem[];
  try {
    const response = await generateWithFallback(
      [MODEL_FAST_LITE, MODEL_PRIMARY_TEXT],
      (_model, thinkingLevel) => ({
        contents: `Analyze these emails from a job seeker's inbox and identify ONLY genuine job application submission confirmations.

EMAILS TO ANALYZE:
${JSON.stringify(compactMessages, null, 2)}

STRICT DETECTION RULES:
1. Set isConfirmedApplication = true ONLY when the email proves the user actually SUBMITTED an application (e.g., "Your application has been submitted", "Thank you for applying", "Your application was received", "Application confirmation", "You have successfully applied", "We received your application for...").
2. Set isConfirmedApplication = false and confidence = "not_application" for:
   - Job alerts / daily or weekly job digests ("New jobs matching...", "Jobs recommended for you", "10 new jobs in...")
   - Application invitations ("You're invited to apply", "Apply now", "Recruiter thinks you'd be a great fit")
   - Saved job reminders, incomplete drafts, newsletters, account security alerts, or marketing emails.
3. For confirmed submissions (isConfirmedApplication = true):
   - companyName: Exact hiring company name if stated; otherwise "".
   - jobTitle: Exact job role/title applied for if stated; otherwise "".
   - jobLocation: Normalized City, State (e.g., "Pune, Maharashtra") or "" if absent.
   - jobUrl: Direct job posting or application URL present in the email; otherwise "".
   - applicationSource: Identify portal cleanly ("LinkedIn", "Indeed", "Naukri", "WorkIndia", "Apna", "Wellfound", "Glassdoor", or "Company Career Page").
   - applicationDate: YYYY-MM-DD of submission (or receivedAt date YYYY-MM-DD if not explicitly printed in body).
   - confirmationMessage: Concise verbatim evidence phrase proving submission (max 240 chars).
   - recruiterName: Recruiter/HR contact name if named; otherwise "".
   - recruiterEmail: Employer/recruiter reply email if explicitly stated (do NOT invent); otherwise "".
   - confidence:
     - "high" if isConfirmedApplication = true AND both companyName and jobTitle are clearly present.
     - "incomplete" if isConfirmedApplication = true BUT companyName or jobTitle is missing/unclear.`,
        config: {
          systemInstruction:
            'You accurately distinguish confirmed job application submission receipts from job recommendations, vacancy alerts, and invitations. Never fabricate company names, titles, or emails.',
          thinkingConfig: { thinkingLevel },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                gmailMessageId: { type: Type.STRING },
                isConfirmedApplication: { type: Type.BOOLEAN },
                confidence: { type: Type.STRING },
                companyName: { type: Type.STRING },
                jobTitle: { type: Type.STRING },
                jobLocation: { type: Type.STRING },
                jobUrl: { type: Type.STRING },
                applicationSource: { type: Type.STRING },
                applicationDate: { type: Type.STRING },
                confirmationMessage: { type: Type.STRING },
                recruiterName: { type: Type.STRING },
                recruiterEmail: { type: Type.STRING },
              },
              required: [
                'gmailMessageId',
                'isConfirmedApplication',
                'confidence',
                'companyName',
                'jobTitle',
                'jobLocation',
                'jobUrl',
                'applicationSource',
                'applicationDate',
                'confirmationMessage',
                'recruiterName',
                'recruiterEmail',
              ],
            },
          },
        },
      })
    );

    const parsed = JSON.parse((response.text ?? '[]').trim()) as Array<
      Partial<DetectedPortalConfirmationItem>
    >;

    freshResults = parsed.map((item) => {
      const confirmed = Boolean(item.isConfirmedApplication);
      const companyName = String(item.companyName ?? '').trim();
      const jobTitle = String(item.jobTitle ?? '').trim();
      let confidence: DetectedPortalConfirmationItem['confidence'] = 'not_application';
      if (confirmed) {
        confidence =
          item.confidence === 'high' && companyName && jobTitle ? 'high' : 'incomplete';
      }

      const rawLoc = String(item.jobLocation ?? '').trim();
      const normalizedLoc = rawLoc ? normalizeJobLocationToCityState(rawLoc) : '';

      return {
        gmailMessageId: String(item.gmailMessageId ?? '').trim(),
        isConfirmedApplication: confirmed,
        confidence,
        companyName,
        jobTitle,
        jobLocation: normalizedLoc,
        jobUrl: String(item.jobUrl ?? '').trim(),
        applicationSource: String(item.applicationSource ?? '').trim() || 'Company Career Page',
        applicationDate: String(item.applicationDate ?? '').trim().slice(0, 10),
        confirmationMessage: String(item.confirmationMessage ?? '').trim().slice(0, 300),
        recruiterName: String(item.recruiterName ?? '').trim(),
        recruiterEmail: String(item.recruiterEmail ?? '').trim(),
      };
    });
  } catch {
    aiCacheBuffer.recordFallback();
    freshResults = detectPortalConfirmationsFallback({ messages: candidateMessages });
  }

  for (const item of freshResults) {
    if (item.gmailMessageId) {
      const mKey = aiCacheBuffer.makeKey('gmail_confirm_msg', [item.gmailMessageId]);
      aiCacheBuffer.set(mKey, 'gmail_confirm_msg', item, TTL_24H);
    }
  }

  return [...cachedOrSkipped, ...freshResults];
}
