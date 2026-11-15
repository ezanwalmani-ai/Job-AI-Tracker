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

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

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
  if (forceConsent) {
    provider.setCustomParameters({ prompt: 'consent select_account' });
  }
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
