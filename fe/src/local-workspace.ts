import { initialDemo, type Demo } from './model';

export type Profile = { name: string; email: string };
export type Report = { id: string; title: string; detail: string; at: string };
export type LocalWorkspace = {
  selected: string;
  trips: Record<string, Demo>;
  profile?: Profile;
  reports?: Report[];
  revision?: string;
};

const sampleId = 'da-lat';
export const initialWorkspace: LocalWorkspace = { selected: sampleId, trips: { [sampleId]: initialDemo } };
let database: Promise<IDBDatabase> | undefined;
export class WorkspaceChanged extends Error {}

function openDatabase() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('sharebill-preview', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspace');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Không mở được dữ liệu trên thiết bị.'));
  }).catch((error: unknown) => {
    database = undefined;
    throw error;
  });
  return database;
}

export async function loadWorkspace(): Promise<LocalWorkspace> {
  const db = await openDatabase();
  const saved = await new Promise<LocalWorkspace | undefined>((resolve, reject) => {
    const request = db.transaction('workspace').objectStore('workspace').get('current');
    request.onsuccess = () => resolve(request.result as LocalWorkspace | undefined);
    request.onerror = () => reject(request.error);
  });
  if (saved) return saved;

  const legacy = localStorage.getItem('sharebill-demo-v1');
  if (!legacy) return initialWorkspace;
  const old = JSON.parse(legacy) as Demo;
  if (!old.trip || !Array.isArray(old.members) || !Array.isArray(old.expenses) ||
      !Array.isArray(old.settlements) || !Array.isArray(old.plans)) return initialWorkspace;
  return {
    selected: sampleId,
    trips: {
      [sampleId]: {
        ...old,
        trip: { ...old.trip, cover: true },
        members: old.members.map(member => ({
          ...member, linked: initialDemo.members.find(sample => sample.id === member.id)?.linked,
        })),
      },
    },
  };
}

export async function saveWorkspace(state: LocalWorkspace, expectedRevision?: string) {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('workspace', 'readwrite');
    const store = transaction.objectStore('workspace');
    const current = store.get('current');
    let stale = false;
    current.onsuccess = () => {
      stale = (current.result as LocalWorkspace | undefined)?.revision !== expectedRevision;
      if (stale) transaction.abort();
      else store.put(state, 'current');
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(stale ? new WorkspaceChanged() : transaction.error);
  });
}

export async function resetWorkspace(state: LocalWorkspace, expectedRevision?: string) {
  await saveWorkspace(state, expectedRevision);
  localStorage.removeItem('sharebill-demo-v1');
}
