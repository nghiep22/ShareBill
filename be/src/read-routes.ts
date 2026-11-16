import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from './firebase.js';
import { ApiError, requireUser } from './http.js';
import { expenseReadData } from './database/expense.js';

function idParams(value: unknown): { tripId: string; id?: string } {
  const result = z.strictObject({ tripId: z.uuid(), id: z.uuid().optional() }).safeParse(value);
  if (!result.success) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy dữ liệu.');
  return result.data;
}
function dto(snapshot: FirebaseFirestore.DocumentSnapshot) {
  const value = snapshot.data();
  if (!value) return null;
  const result: Record<string, unknown> = { ...value };
  for (const key of ['createdAt', 'updatedAt', 'voidedAt', 'confirmedAt']) {
    if (result[key] && typeof (result[key] as { toDate?: unknown }).toDate === 'function') {
      result[key] = (result[key] as FirebaseFirestore.Timestamp).toDate().toISOString();
    }
  }
  return result;
}
async function membership(uid: string, tripId: string) {
  const member = await db().doc(`trips/${tripId}/memberships/${uid}`).get();
  if (!member.exists || member.get('status') !== 'active') throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy chuyến đi.');
}

export async function registerReadRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/trips', async request => {
    const uid = await requireUser(request), store = db();
    const refs = await store.collection(`users/${uid}/tripRefs`).orderBy('joinedAt', 'desc').limit(20).get();
    const trips = await Promise.all(refs.docs.filter(ref => ref.get('status') === 'active').map(async ref => {
      const tripId = ref.id;
      const [trip, member] = await Promise.all([store.doc(`trips/${tripId}`).get(), store.doc(`trips/${tripId}/memberships/${uid}`).get()]);
      if (!trip.exists || !member.exists || member.get('status') !== 'active') return null;
      return { ...dto(trip), role: member.get('role'), myParticipantId: member.get('participantId') };
    }));
    return { data: { items: trips.filter(Boolean), nextCursor: null } };
  });

  app.get('/api/v1/trips/:tripId/expenses', async request => {
    const uid = await requireUser(request), { tripId } = idParams(request.params), store = db();
    await membership(uid, tripId);
    const result = await store.collection(`trips/${tripId}/expenses`).orderBy('createdAt', 'desc').limit(30).get();
    return { data: { items: result.docs.map(doc => expenseReadData(dto(doc)!)), nextCursor: null } };
  });

  app.get('/api/v1/trips/:tripId/expenses/:id', async request => {
    const uid = await requireUser(request), { tripId, id } = idParams(request.params), store = db();
    await membership(uid, tripId);
    const expense = await store.doc(`trips/${tripId}/expenses/${id}`).get();
    if (!expense.exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy khoản chi.');
    return { data: expenseReadData(dto(expense)!) };
  });

  app.get('/api/v1/trips/:tripId/settlements', async request => {
    const uid = await requireUser(request), { tripId } = idParams(request.params), store = db();
    await membership(uid, tripId);
    const result = await store.collection(`trips/${tripId}/settlements`).orderBy('createdAt', 'desc').limit(30).get();
    return { data: { items: result.docs.map(doc => dto(doc)!), nextCursor: null } };
  });
}
