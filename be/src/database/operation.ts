import { createHash } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { ApiError } from '../http.js';

export type OperationCommand = {
  method: string;
  canonicalPath: string;
  body: Record<string, unknown>;
  ifMatch?: number;
  legacyBody?: Record<string, unknown>;
};

const dataSchema = z.record(z.string(), z.unknown());
const responseSnapshotSchema = z.strictObject({
  data: dataSchema,
  meta: z.strictObject({ revision: z.int().nonnegative().optional(), ledgerVersion: z.int().nonnegative().optional() }),
});

export const operationDocumentSchema = z.strictObject({
  actorUid: z.string().min(1),
  tripId: z.uuid().nullable(),
  method: z.string().min(1),
  canonicalPath: z.string().startsWith('/'),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  state: z.literal('committed'),
  resourceType: z.enum(['trip', 'participant', 'expense', 'settlement', 'invite', 'membership', 'receipt', 'itinerary', 'supportTicket', 'adminUser']),
  resourceId: z.string().min(1).max(128).regex(/^[^/]+$/),
  httpStatus: z.int().min(200).max(299),
  responseSnapshot: responseSnapshotSchema,
  responseEtag: z.string().regex(/^"[1-9][0-9]*"$/).nullable(),
  committedAt: z.instanceof(Timestamp),
}).refine(value => value.resourceType === 'membership' || value.resourceType === 'adminUser' || z.uuid().safeParse(value.resourceId).success,
  { path: ['resourceId'] });

type OperationDocument = z.infer<typeof operationDocumentSchema>;
export type OperationOutcome = Pick<OperationDocument, 'tripId' | 'httpStatus' | 'responseSnapshot' | 'responseEtag'>;

/** A running receipt workflow reserves the UID-scoped key before it has a committed OperationDoc. */
export async function readOperationSnapshot(tx: FirebaseFirestore.Transaction, ref: FirebaseFirestore.DocumentReference) {
  const workflowRef = ref.parent.parent!.collection('receiptWorkflows').doc(ref.id);
  const [operation, workflow] = await Promise.all([tx.get(ref), tx.get(workflowRef)]);
  if (!operation.exists && workflow.exists) keyReused();
  return operation;
}

function sha256(serialized: string): string {
  return createHash('sha256').update(serialized).digest('hex');
}

export function operationRequestHash({ method, canonicalPath, body, ifMatch }: OperationCommand): string {
  const serialized = JSON.stringify({ method, canonicalPath, body, ifMatch: ifMatch ?? null }, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const fields = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(fields).sort().map(key => [key, fields[key]]));
  });
  return sha256(serialized);
}

function legacyHash({ body, ifMatch, legacyBody = body }: OperationCommand): string {
  // Older writers hashed the parsed body in schema order, wrapping it for versioned actions.
  return sha256(JSON.stringify(ifMatch === undefined ? legacyBody : { body: legacyBody, expectedVersion: ifMatch }));
}

type OperationWrite = Omit<OperationDocument, 'method' | 'canonicalPath' | 'requestHash' | 'state' | 'responseEtag'>;

export function createOperationDocument(command: OperationCommand, input: OperationWrite): OperationDocument {
  const version = input.responseSnapshot.data.version;
  return operationDocumentSchema.parse({
    ...input,
    method: command.method,
    canonicalPath: command.canonicalPath,
    requestHash: operationRequestHash(command),
    state: 'committed',
    responseEtag: typeof version === 'number' ? `"${version}"` : null,
  });
}

function keyReused(): never {
  throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Mã yêu cầu đã được dùng.');
}

function resultUnavailable(): never {
  throw new ApiError(409, 'OPERATION_RESULT_UNAVAILABLE', 'Không thể tải kết quả đã lưu của yêu cầu.');
}

export function readOperationResult(
  stored: FirebaseFirestore.DocumentData | undefined, command: OperationCommand, actorUid: string, tripId?: string,
): OperationOutcome | null {
  if (!stored) return null;
  if ('canonicalPath' in stored) {
    if (stored.method !== command.method || stored.canonicalPath !== command.canonicalPath ||
        stored.requestHash !== operationRequestHash(command)) keyReused();
    const parsed = operationDocumentSchema.safeParse(stored);
    if (!parsed.success || parsed.data.actorUid !== actorUid || (tripId !== undefined && parsed.data.tripId !== tripId)) {
      resultUnavailable();
    }
    return parsed.data;
  }

  if (command.method !== 'POST' || stored.path !== command.canonicalPath || stored.requestHash !== legacyHash(command)) keyReused();
  const response = dataSchema.safeParse(stored.response);
  if (!response.success) resultUnavailable();
  // Legacy create-trip operations have no tripId field. Their response contains the trip ID.
  const legacyTripId = z.uuid().safeParse(tripId === undefined ? response.data.id : stored.tripId);
  if (!legacyTripId.success || (tripId !== undefined && legacyTripId.data !== tripId)) resultUnavailable();
  return { tripId: legacyTripId.data, httpStatus: 200, responseSnapshot: { data: response.data, meta: {} }, responseEtag: null };
}
