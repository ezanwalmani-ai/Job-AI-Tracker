import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  serverTimestamp,
  onSnapshot,
  writeBatch,
  Unsubscribe,
} from 'firebase/firestore';
import { User } from 'firebase/auth';
import { auth, db } from './firebase.ts';
import type {
  UserProfile,
  ResumeRecord,
  JobApplicationRecord,
  ApplicationResumeRecord,
  ApplicationEmailRecord,
  FollowUpRecord,
  EmailConnectionRecord,
  EmailReplyRecord,
} from '../types.ts';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export function generateDocId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${rand}`;
}

const CHUNK_SIZE = 400_000;

function splitBase64IntoChunks(base64: string): string[] {
  const clean = base64.trim();
  const chunks: string[] = [];
  for (let i = 0; i < clean.length; i += CHUNK_SIZE) {
    chunks.push(clean.slice(i, i + CHUNK_SIZE));
  }
  return chunks.length > 0 ? chunks : [''];
}

export async function ensureUserProfile(user: User): Promise<UserProfile> {
  const path = `users/${user.uid}`;
  const ref = doc(db, 'users', user.uid);
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      return snap.data() as UserProfile;
    }
    const profile: UserProfile = {
      uid: user.uid,
      email: (user.email || '').slice(0, 320),
      displayName: (user.displayName || user.email?.split('@')[0] || 'Candidate').slice(0, 200),
      defaultFollowUpDays: 7,
      activeResumeId: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await setDoc(ref, profile);
    return profile;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function updateUserProfile(
  uid: string,
  updates: Partial<Pick<UserProfile, 'displayName' | 'defaultFollowUpDays' | 'activeResumeId'>>
): Promise<void> {
  const path = `users/${uid}`;
  try {
    await updateDoc(doc(db, 'users', uid), {
      ...updates,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export function subscribeUserProfile(
  uid: string,
  onData: (profile: UserProfile | null) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const path = `users/${uid}`;
  return onSnapshot(
    doc(db, 'users', uid),
    (snap) => {
      onData(snap.exists() ? (snap.data() as UserProfile) : null);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, path);
      } catch (e) {
        onError(e as Error);
      }
    }
  );
}

function getTimestampMillis(value: unknown): number {
  if (!value) return 0;
  if (typeof value === 'object' && value !== null && 'toMillis' in value) {
    const fn = (value as { toMillis?: () => number }).toMillis;
    if (typeof fn === 'function') return fn.call(value);
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
}

export function subscribeCollection<T>(
  uid: string,
  subcollection: string,
  onData: (items: T[]) => void,
  onError: (err: Error) => void,
  orderField = 'createdAt'
): Unsubscribe {
  const path = `users/${uid}/${subcollection}`;
  const q = query(
    collection(db, 'users', uid, subcollection),
    where('userId', '==', uid)
  );
  return onSnapshot(
    q,
    (snapshot) => {
      const items = snapshot.docs.map((d) => d.data() as T & Record<string, unknown>);
      items.sort(
        (a, b) => getTimestampMillis(b[orderField]) - getTimestampMillis(a[orderField])
      );
      onData(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (e) {
        onError(e as Error);
      }
    }
  );
}

export async function saveMasterResumeVersion(params: {
  uid: string;
  existingResumes: ResumeRecord[];
  fileName: string;
  mimeType: string;
  fileSize: number;
  pdfBase64: string;
  extractedText: string;
  candidateName: string;
  candidateEmail: string;
  candidatePhone: string;
  originalLocation: string;
  locationBox: {
    hasLocationBox: boolean;
    locPage: number;
    locX: number;
    locY: number;
    locW: number;
    locH: number;
    locFontSize: number;
  };
}): Promise<ResumeRecord> {
  const resumeId = generateDocId('res');
  const path = `users/${params.uid}/resumes/${resumeId}`;
  const chunks = splitBase64IntoChunks(params.pdfBase64);
  const nextVersion =
    params.existingResumes.reduce((max, r) => Math.max(max, r.version || 0), 0) + 1;

  try {
    // Deactivate previously active resumes while preserving all versions
    for (const prev of params.existingResumes) {
      if (prev.isActive) {
        await updateDoc(doc(db, 'users', params.uid, 'resumes', prev.id), {
          isActive: false,
          updatedAt: serverTimestamp(),
        });
      }
    }

    const record: ResumeRecord = {
      id: resumeId,
      userId: params.uid,
      fileName: params.fileName.slice(0, 255),
      mimeType: (params.mimeType || 'application/pdf').slice(0, 100),
      fileSize: params.fileSize,
      version: nextVersion,
      isActive: true,
      extractedText: params.extractedText.slice(0, 200000),
      candidateName: params.candidateName.slice(0, 200),
      candidateEmail: params.candidateEmail.slice(0, 320),
      candidatePhone: params.candidatePhone.slice(0, 60),
      originalLocation: params.originalLocation.slice(0, 300),
      hasLocationBox: params.locationBox.hasLocationBox,
      locPage: Math.round(params.locationBox.locPage),
      locX: params.locationBox.locX,
      locY: params.locationBox.locY,
      locW: params.locationBox.locW,
      locH: params.locationBox.locH,
      locFontSize: params.locationBox.locFontSize,
      chunkCount: chunks.length,
      uploadedAt: new Date().toISOString(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    await setDoc(doc(db, 'users', params.uid, 'resumes', resumeId), record);

    const batch = writeBatch(db);
    chunks.forEach((chunkData, idx) => {
      const chunkId = `chunk_${idx}`;
      batch.set(doc(db, 'users', params.uid, 'resumes', resumeId, 'chunks', chunkId), {
        userId: params.uid,
        index: idx,
        data: chunkData,
        createdAt: serverTimestamp(),
      });
    });
    await batch.commit();

    await updateUserProfile(params.uid, { activeResumeId: resumeId });
    return record;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function switchActiveMasterResume(
  uid: string,
  allResumes: ResumeRecord[],
  targetResumeId: string
): Promise<void> {
  const path = `users/${uid}/resumes/${targetResumeId}`;
  try {
    for (const r of allResumes) {
      const shouldBeActive = r.id === targetResumeId;
      if (r.isActive !== shouldBeActive) {
        await updateDoc(doc(db, 'users', uid, 'resumes', r.id), {
          isActive: shouldBeActive,
          updatedAt: serverTimestamp(),
        });
      }
    }
    await updateUserProfile(uid, { activeResumeId: targetResumeId });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function loadPdfBase64Chunks(
  uid: string,
  parentCollection: 'resumes' | 'applicationResumes',
  docId: string
): Promise<string> {
  const path = `users/${uid}/${parentCollection}/${docId}/chunks`;
  try {
    const snap = await getDocs(
      query(
        collection(db, 'users', uid, parentCollection, docId, 'chunks'),
        where('userId', '==', uid)
      )
    );
    const chunks = snap.docs
      .map((d) => d.data() as { index?: number; data?: string })
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return chunks.map((c) => String(c.data || '')).join('');
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function saveEmailApplicationRecord(params: {
  uid: string;
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
  applicationSource?: string;
  notes?: string;
  dateApplied: string;
  followUpDate: string;
  aiSummary: string;
  keyRequirements: string[];
  masterResumeId: string;
  tailoredFileName: string;
  originalLocation: string;
  updatedLocationLabel: string;
  tailoredPdfBase64: string;
  emailSubject: string;
  emailBody: string;
  gmailMessageId: string;
  gmailThreadId: string;
  sentAt: string;
}): Promise<{ applicationId: string; appResumeId: string; emailId: string }> {
  const applicationId = generateDocId('app');
  const appResumeId = generateDocId('appres');
  const emailId = generateDocId('email');

  const appPath = `users/${params.uid}/jobApplications/${applicationId}`;
  const chunks = splitBase64IntoChunks(params.tailoredPdfBase64);

  try {
    const appDoc: JobApplicationRecord = {
      id: applicationId,
      userId: params.uid,
      companyName: params.companyName.slice(0, 200),
      jobTitle: params.jobTitle.slice(0, 200),
      jobDescription: params.jobDescription.slice(0, 60000),
      jobLocation: params.jobLocation.slice(0, 200),
      jobUrl: params.jobUrl.slice(0, 2000),
      hrEmail: params.hrEmail.slice(0, 320),
      recruiterName: (params.recruiterName || '').slice(0, 200),
      companyAddress: (params.companyAddress || '').slice(0, 400),
      salary: (params.salary || '').slice(0, 200),
      employmentType: (params.employmentType || '').slice(0, 100),
      requiredExperience: (params.requiredExperience || '').slice(0, 300),
      applicationInstructions: (params.applicationInstructions || '').slice(0, 2000),
      applicationSource: (params.applicationSource || 'Direct Email (Gmail)').slice(0, 120),
      applicationMethod: 'email',
      dateApplied: params.dateApplied,
      lastCommunicationDate: params.dateApplied,
      followUpDate: params.followUpDate,
      applicationStatus: 'Email Sent',
      notes: (params.notes || '').slice(0, 10000),
      aiSummary: params.aiSummary.slice(0, 2000),
      keyRequirements: params.keyRequirements.slice(0, 15).map((s) => s.slice(0, 300)),
      applicationResumeId: appResumeId,
      gmailThreadId: params.gmailThreadId.slice(0, 200),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    await setDoc(doc(db, 'users', params.uid, 'jobApplications', applicationId), appDoc);

    const appResumeDoc: ApplicationResumeRecord = {
      id: appResumeId,
      userId: params.uid,
      applicationId,
      masterResumeId: params.masterResumeId,
      fileName: params.tailoredFileName.slice(0, 255),
      originalLocation: params.originalLocation.slice(0, 300),
      targetLocation: params.jobLocation.slice(0, 300),
      updatedLocationLabel: params.updatedLocationLabel.slice(0, 350),
      chunkCount: chunks.length,
      createdAt: serverTimestamp(),
    };

    await setDoc(doc(db, 'users', params.uid, 'applicationResumes', appResumeId), appResumeDoc);

    const batch = writeBatch(db);
    chunks.forEach((chunkData, idx) => {
      batch.set(
        doc(db, 'users', params.uid, 'applicationResumes', appResumeId, 'chunks', `chunk_${idx}`),
        {
          userId: params.uid,
          index: idx,
          data: chunkData,
          createdAt: serverTimestamp(),
        }
      );
    });
    await batch.commit();

    const emailDoc: ApplicationEmailRecord = {
      id: emailId,
      userId: params.uid,
      applicationId,
      recipientEmail: params.hrEmail.slice(0, 320),
      emailSubject: params.emailSubject.slice(0, 500),
      emailBody: params.emailBody.slice(0, 30000),
      attachmentFileName: params.tailoredFileName.slice(0, 255),
      attachmentResumeId: appResumeId,
      gmailMessageId: params.gmailMessageId.slice(0, 200),
      gmailThreadId: params.gmailThreadId.slice(0, 200),
      emailStatus: 'sent',
      errorMessage: '',
      sentAt: params.sentAt,
      createdAt: serverTimestamp(),
    };

    await setDoc(doc(db, 'users', params.uid, 'applicationEmails', emailId), emailDoc);

    return { applicationId, appResumeId, emailId };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, appPath);
  }
}

export async function saveManualApplicationRecord(params: {
  uid: string;
  companyName: string;
  jobTitle: string;
  jobDescription: string;
  jobLocation: string;
  jobUrl: string;
  hrEmail?: string;
  recruiterName?: string;
  companyAddress?: string;
  salary?: string;
  employmentType?: string;
  requiredExperience?: string;
  applicationInstructions?: string;
  applicationSource: string;
  dateApplied: string;
  followUpDate: string;
  applicationStatus: JobApplicationRecord['applicationStatus'];
  notes: string;
  aiSummary: string;
  keyRequirements: string[];
}): Promise<string> {
  const applicationId = generateDocId('app');
  const path = `users/${params.uid}/jobApplications/${applicationId}`;
  try {
    const record: JobApplicationRecord = {
      id: applicationId,
      userId: params.uid,
      companyName: params.companyName.slice(0, 200),
      jobTitle: params.jobTitle.slice(0, 200),
      jobDescription: params.jobDescription.slice(0, 60000),
      jobLocation: params.jobLocation.slice(0, 200),
      jobUrl: params.jobUrl.slice(0, 2000),
      hrEmail: (params.hrEmail || '').slice(0, 320),
      recruiterName: (params.recruiterName || '').slice(0, 200),
      companyAddress: (params.companyAddress || '').slice(0, 400),
      salary: (params.salary || '').slice(0, 200),
      employmentType: (params.employmentType || '').slice(0, 100),
      requiredExperience: (params.requiredExperience || '').slice(0, 300),
      applicationInstructions: (params.applicationInstructions || '').slice(0, 2000),
      applicationSource: params.applicationSource.slice(0, 120),
      applicationMethod: 'portal',
      dateApplied: params.dateApplied,
      lastCommunicationDate: params.dateApplied,
      followUpDate: params.followUpDate,
      applicationStatus: params.applicationStatus,
      notes: params.notes.slice(0, 10000),
      aiSummary: params.aiSummary.slice(0, 2000),
      keyRequirements: params.keyRequirements.slice(0, 15).map((s) => s.slice(0, 300)),
      applicationResumeId: '',
      gmailThreadId: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await setDoc(doc(db, 'users', params.uid, 'jobApplications', applicationId), record);
    return applicationId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateJobApplicationRecord(
  uid: string,
  applicationId: string,
  updates: Partial<
    Pick<
      JobApplicationRecord,
      'applicationStatus' | 'followUpDate' | 'lastCommunicationDate' | 'notes' | 'gmailThreadId'
    >
  >
): Promise<void> {
  const path = `users/${uid}/jobApplications/${applicationId}`;
  try {
    await updateDoc(doc(db, 'users', uid, 'jobApplications', applicationId), {
      ...updates,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteJobApplicationRecord(
  uid: string,
  applicationId: string
): Promise<void> {
  const path = `users/${uid}/jobApplications/${applicationId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'jobApplications', applicationId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function createFollowUpRecord(params: {
  uid: string;
  applicationId: string;
  followUpDate: string;
  recipientEmail: string;
  emailSubject: string;
  emailBody: string;
  gmailMessageId: string;
  status: 'sent' | 'logged' | 'failed';
  outcome: string;
  sentAt: string;
  nextFollowUpDate: string;
}): Promise<string> {
  const followUpId = generateDocId('fu');
  const path = `users/${params.uid}/followUpHistory/${followUpId}`;
  try {
    const docData: FollowUpRecord = {
      id: followUpId,
      userId: params.uid,
      applicationId: params.applicationId,
      followUpDate: params.followUpDate,
      recipientEmail: params.recipientEmail.slice(0, 320),
      emailSubject: params.emailSubject.slice(0, 500),
      emailBody: params.emailBody.slice(0, 30000),
      gmailMessageId: params.gmailMessageId.slice(0, 200),
      status: params.status,
      outcome: params.outcome.slice(0, 500),
      sentAt: params.sentAt,
      createdAt: serverTimestamp(),
    };
    await setDoc(doc(db, 'users', params.uid, 'followUpHistory', followUpId), docData);

    await updateJobApplicationRecord(params.uid, params.applicationId, {
      lastCommunicationDate: params.followUpDate,
      followUpDate: params.nextFollowUpDate,
      applicationStatus: 'Waiting for Response',
    });

    return followUpId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function saveEmailConnectionState(params: {
  uid: string;
  connectedEmail: string;
  status: EmailConnectionRecord['status'];
  replyTrackingEnabled: boolean;
  lastSyncedAt?: string;
  connectedAt?: string;
}): Promise<void> {
  const connectionId = 'gmail_primary';
  const path = `users/${params.uid}/emailConnections/${connectionId}`;
  const ref = doc(db, 'users', params.uid, 'emailConnections', connectionId);
  try {
    const existingSnap = await getDoc(ref);
    if (existingSnap.exists()) {
      const prev = existingSnap.data() as EmailConnectionRecord;
      await updateDoc(ref, {
        connectedEmail: params.connectedEmail.slice(0, 320),
        status: params.status,
        replyTrackingEnabled: params.replyTrackingEnabled,
        lastSyncedAt: params.lastSyncedAt ?? prev.lastSyncedAt,
        connectedAt: params.connectedAt ?? prev.connectedAt,
        updatedAt: serverTimestamp(),
      });
    } else {
      const record: EmailConnectionRecord = {
        id: connectionId,
        userId: params.uid,
        provider: 'gmail',
        connectedEmail: params.connectedEmail.slice(0, 320),
        status: params.status,
        replyTrackingEnabled: params.replyTrackingEnabled,
        lastSyncedAt: params.lastSyncedAt ?? '',
        connectedAt: params.connectedAt ?? new Date().toISOString(),
        updatedAt: serverTimestamp(),
      };
      await setDoc(ref, record);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function saveSyncedEmailReplies(
  uid: string,
  replies: Array<{
    applicationId: string;
    gmailMessageId: string;
    gmailThreadId: string;
    fromEmail: string;
    fromName: string;
    subject: string;
    snippet: string;
    receivedAt: string;
    classification: EmailReplyRecord['classification'];
    matchConfidence: 'high' | 'needs_review';
  }>
): Promise<void> {
  for (const r of replies) {
    const replyId = `reply_${r.gmailMessageId.replace(/[^a-zA-Z0-9_\-]/g, '_')}`.slice(0, 120);
    const path = `users/${uid}/emailReplies/${replyId}`;
    try {
      const docData: EmailReplyRecord = {
        id: replyId,
        userId: uid,
        applicationId: r.applicationId.slice(0, 128),
        gmailMessageId: r.gmailMessageId.slice(0, 200),
        gmailThreadId: r.gmailThreadId.slice(0, 200),
        fromEmail: r.fromEmail.slice(0, 320),
        fromName: r.fromName.slice(0, 200),
        subject: r.subject.slice(0, 500),
        snippet: r.snippet.slice(0, 4000),
        receivedAt: r.receivedAt.slice(0, 64),
        classification: r.classification,
        matchConfidence: r.matchConfidence,
        reviewed: r.matchConfidence === 'high',
        createdAt: serverTimestamp(),
      };
      await setDoc(doc(db, 'users', uid, 'emailReplies', replyId), docData);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  }
}

export async function assignOrDismissReply(
  uid: string,
  replyId: string,
  updates: { applicationId: string; matchConfidence: 'high' | 'needs_review'; reviewed: boolean }
): Promise<void> {
  const path = `users/${uid}/emailReplies/${replyId}`;
  try {
    await updateDoc(doc(db, 'users', uid, 'emailReplies', replyId), updates);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}
