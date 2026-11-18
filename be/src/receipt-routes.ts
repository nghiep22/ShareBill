import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError, operationKey, requireUser, requireVersion, sendOperationResult } from './http.js';
import { receiptIntentInput } from './database/receipt.js';
import { ReceiptService } from './services/receipts.js';

const tripParams = z.strictObject({ tripId: z.uuid() });
const receiptParams = z.strictObject({ tripId: z.uuid(), id: z.uuid() });
function parse<T>(schema: z.ZodType<T>, input: unknown, path = false) {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(path ? 404 : 422, path ? 'NOT_FOUND' : 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ.');
  return result.data;
}
export async function registerReceiptRoutes(app: FastifyInstance, receipts: ReceiptService) {
  app.post('/api/v1/trips/:tripId/receipts/upload-intents', async (request, reply) => {
    const uid = await requireUser(request), key = operationKey(request), { tripId } = parse(tripParams, request.params, true);
    return sendOperationResult(reply, await receipts.createIntent(tripId, uid, key, parse(receiptIntentInput, request.body)));
  });
  for (const action of ['finalize', 'discard'] as const) {
    app.post(`/api/v1/trips/:tripId/receipts/:id/${action}`, async (request, reply) => {
      const uid = await requireUser(request), key = operationKey(request), { tripId, id } = parse(receiptParams, request.params, true);
      parse(z.strictObject({}), request.body);
      return sendOperationResult(reply, await receipts[action](tripId, id, uid, key, requireVersion(request.headers['if-match'])));
    });
  }
  app.get('/api/v1/trips/:tripId/receipts/:id/view-url', async request => {
    const uid = await requireUser(request), { tripId, id } = parse(receiptParams, request.params, true);
    return { data: await receipts.viewUrl(tripId, id, uid) };
  });
}
