import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import { getFirestore, doc, getDocFromServer } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const resolvedAuthDomain =
  (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined)?.trim() ||
  firebaseConfig.authDomain;

const app = initializeApp({
  ...firebaseConfig,
  authDomain: resolvedAuthDomain,
});
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
auth.useDeviceLanguage();

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];

let cachedGmailAccessToken: string | null = null;
let isSigningIn = false;

async function testFirestoreConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration: Firestore client is offline.');
    }
  }
}
void testFirestoreConnection();

function buildGoogleProvider(forceConsent = false): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  for (const scope of GMAIL_SCOPES) {
    provider.addScope(scope);
  }
  provider.setCustomParameters({
    prompt: forceConsent ? 'consent select_account' : 'select_account',
  });
  return provider;
}

export function subscribeToAuth(
  onUserChange: (user: User | null, hasGmailToken: boolean) => void
) {
  return onAuthStateChanged(auth, (user) => {
    if (!user) {
      cachedGmailAccessToken = null;
      onUserChange(null, false);
    } else if (!isSigningIn) {
      onUserChange(user, Boolean(cachedGmailAccessToken));
    }
  });
}

export async function signInWithGoogle(
  forceConsent = false
): Promise<{ user: User; gmailAccessToken: string | null }> {
  isSigningIn = true;
  try {
    const provider = buildGoogleProvider(forceConsent);
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (credential?.accessToken) {
      cachedGmailAccessToken = credential.accessToken;
    }
    return {
      user: result.user,
      gmailAccessToken: cachedGmailAccessToken,
    };
  } catch (err: unknown) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code)
        : '';
    if (code === 'auth/unauthorized-domain') {
      const host = typeof window !== 'undefined' ? window.location.hostname : 'this domain';
      throw new Error(
        `Domain "${host}" is not authorized for Google Sign-In in Firebase project "${firebaseConfig.projectId}". Add "${host}" to Firebase Console → Authentication → Settings → Authorized domains and Google Cloud OAuth Authorized JavaScript origins.`
      );
    }
    if (code === 'auth/popup-blocked') {
      throw new Error(
        'Google Sign-In popup was blocked by your browser. Please allow popups for this site and try again.'
      );
    }
    throw err;
  } finally {
    isSigningIn = false;
  }
}

export function getGmailAccessToken(): string | null {
  return cachedGmailAccessToken;
}

export function clearGmailAccessToken(): void {
  cachedGmailAccessToken = null;
}

export async function getFirebaseIdToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('You are not signed in.');
  }
  return user.getIdToken();
}

export async function signOutUser(): Promise<void> {
  cachedGmailAccessToken = null;
  await auth.signOut();
}
