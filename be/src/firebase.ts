import { initializeApp, getApps, cert, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

function firebaseApp() {
  const existing = getApps()[0];
  if (existing) return existing;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID is required');
  if (process.env.NODE_ENV === 'production' && (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST ||
      process.env.FIREBASE_STORAGE_EMULATOR_HOST || process.env.STORAGE_EMULATOR_HOST)) {
    throw new Error('Firebase emulator cannot be used in production');
  }
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const credential = clientEmail && privateKey ? cert({ projectId, clientEmail, privateKey }) : applicationDefault();
  return initializeApp({ projectId, credential });
}

export function db() { return getFirestore(firebaseApp()); }
export function auth() { return getAuth(firebaseApp()); }
export function receiptBucket() {
  const name = process.env.FIREBASE_STORAGE_BUCKET;
  if (!name || !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(name)) throw new Error('FIREBASE_STORAGE_BUCKET is required');
  return getStorage(firebaseApp()).bucket(name);
}
