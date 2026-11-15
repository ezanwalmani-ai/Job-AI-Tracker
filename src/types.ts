export type ApplicationMethod = 'email' | 'portal';

export type CaptureMethod =
  | 'web_gmail'
  | 'gmail_confirmation'
  | 'chrome_extension'
  | 'csv_import'
  | 'manual_portal';

export type ApplicationStatus =
  | 'Discovered'
  | 'Saved'
  | 'Applied – Confirmed'
  | 'Applied – Manually Recorded'
  | 'Awaiting Confirmation'
  | 'Follow-up Due'
  | 'Applied'
  | 'Email Sent'
  | 'Waiting for Response'
  | 'HR Responded'
  | 'Interview Scheduled'
  | 'Offer Received'
  | 'Rejected';

export type PortalId =
  | 'linkedin'
  | 'indeed'
  | 'naukri'
  | 'workindia'
  | 'apna'
  | 'company_career';

export type PortalConnectionStatus =
  | 'not_connected'
  | 'connected'
  | 'imported_only'
  | 'disconnected';

export type PortalConnectionMethod =
  | 'none'
  | 'gmail_confirmation'
  | 'chrome_extension'
  | 'csv_import'
  | 'manual_quick_save';

export type ReplyClassification =
  | 'Interview Invitation'
  | 'Further Information Requested'
  | 'Rejection'
  | 'Acknowledgement'
  | 'Other';

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  defaultFollowUpDays: number;
  activeResumeId: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface ResumeRecord {
  id: string;
  userId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  version: number;
  isActive: boolean;
  extractedText: string;
  candidateName: string;
  candidateEmail: string;
  candidatePhone: string;
  originalLocation: string;
  hasLocationBox: boolean;
  locPage: number;
  locX: number;
  locY: number;
  locW: number;
  locH: number;
  locFontSize: number;
  chunkCount: number;
  uploadedAt: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface JobApplicationRecord {
  id: string;
  userId: string;
  companyName: string;
  jobTitle: string;
  jobDescription: string;
  jobLocation: string;
  jobUrl: string;
  hrEmail: string;
  recruiterName?: string;
  companyAddress?: string;
  salary?: string;
  employmentType?: string;
  requiredExperience?: string;
  applicationInstructions?: string;
  applicationSource: string;
  applicationMethod: ApplicationMethod;
  captureMethod?: CaptureMethod;
  confirmationEvidence?: string;
  needsReview?: boolean;
  gmailConfirmationMessageId?: string;
  dateApplied: string;
  lastCommunicationDate: string;
  followUpDate: string;
  applicationStatus: ApplicationStatus;
  notes: string;
  aiSummary: string;
  keyRequirements: string[];
  applicationResumeId: string;
  gmailThreadId: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface ExtractedJobDetails {
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

export interface ApplicationResumeRecord {
  id: string;
  userId: string;
  applicationId: string;
  masterResumeId: string;
  fileName: string;
  originalLocation: string;
  targetLocation: string;
  updatedLocationLabel: string;
  chunkCount: number;
  createdAt?: unknown;
}

export interface ApplicationEmailRecord {
  id: string;
  userId: string;
  applicationId: string;
  recipientEmail: string;
  emailSubject: string;
  emailBody: string;
  attachmentFileName: string;
  attachmentResumeId: string;
  gmailMessageId: string;
  gmailThreadId: string;
  emailStatus: 'draft' | 'sent' | 'failed';
  errorMessage: string;
  sentAt: string;
  createdAt?: unknown;
}

export interface FollowUpRecord {
  id: string;
  userId: string;
  applicationId: string;
  followUpDate: string;
  recipientEmail: string;
  emailSubject: string;
  emailBody: string;
  gmailMessageId: string;
  status: 'sent' | 'logged' | 'failed';
  outcome: string;
  sentAt: string;
  createdAt?: unknown;
}

export interface EmailConnectionRecord {
  id: string;
  userId: string;
  provider: 'gmail';
  connectedEmail: string;
  status: 'connected' | 'disconnected' | 'expired';
  replyTrackingEnabled: boolean;
  autoProcessConfirmations?: boolean;
  lastSyncedAt: string;
  connectedAt: string;
  updatedAt?: unknown;
}

export interface EmailReplyRecord {
  id: string;
  userId: string;
  applicationId: string;
  gmailMessageId: string;
  gmailThreadId: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  classification: ReplyClassification;
  matchConfidence: 'high' | 'needs_review';
  reviewed: boolean;
  createdAt?: unknown;
}

export interface ConnectedPortalRecord {
  id: string;
  userId: string;
  portalId: PortalId;
  portalName: string;
  status: PortalConnectionStatus;
  connectionMethod: PortalConnectionMethod;
  gmailDetectionEnabled: boolean;
  extensionCaptureEnabled: boolean;
  csvImportEnabled: boolean;
  lastSyncedAt: string;
  lastSyncSummary: string;
  lastTestedAt: string;
  importedCount: number;
  extensionVerifiedAt?: string;
  gmailVerifiedAt?: string;
  lastImportFileName?: string;
  updatedAt?: unknown;
}

export interface GmailConfirmationRecord {
  id: string;
  userId: string;
  gmailMessageId: string;
  gmailThreadId: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  receivedAt: string;
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
  reviewStatus: 'imported' | 'pending_review' | 'dismissed' | 'duplicate_skipped';
  linkedApplicationId: string;
  createdAt?: unknown;
}

export interface ExtensionCapturePayload {
  companyName: string;
  jobTitle: string;
  jobDescription: string;
  jobLocation: string;
  jobUrl: string;
  portalName: string;
  didApply: boolean;
  capturedAt?: string;
}

export interface PdfLocationBox {
  hasLocationBox: boolean;
  locPage: number;
  locX: number;
  locY: number;
  locW: number;
  locH: number;
  locFontSize: number;
}

export type EmailPurposeType =
  | 'initial_application'
  | 'follow_up'
  | 'recruitment_enquiry'
  | 'response_to_hr_email'
  | 'application_unnamed_recruiter';

export interface PdfValidationReport {
  locationDisplayed: boolean;
  contactFieldsPreserved: boolean;
  noOverlapDetected: boolean;
  normalizedLocation: string;
  placementMode: 'inline' | 'wrapped_column' | 'separate_line' | 'header_badge';
}
