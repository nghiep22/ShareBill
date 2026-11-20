import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';

const grpcCodes = ['OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND',
  'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED',
  'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'];
const failureCodes = new Set(['INTERNAL_ERROR', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND',
  'BALANCE_INVARIANT_FAILED', 'EXPENSE_TOTALS_INVARIANT_FAILED', 'SETTLEMENT_INVARIANT_FAILED',
  'TRIP_INVARIANT_FAILED', 'RECEIPT_INVARIANT_FAILED', ...grpcCodes.map(code => 'GRPC_' + code)]);
const events = new Set(['http.request.completed', 'http.request.failed']);
const methods = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PATCH', 'PUT', 'DELETE']);

export function failureCode(error: unknown): string {
  try {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (typeof code === 'number' && Number.isInteger(code) && code >= 0 && code < grpcCodes.length) return 'GRPC_' + grpcCodes[code];
    return typeof code === 'string' && failureCodes.has(code) ? code : 'INTERNAL_ERROR';
  } catch { return 'INTERNAL_ERROR'; }
}

// Keep a small structured vocabulary; raw messages/stack traces, URL values and arbitrary objects never reach Pino.
function logFields(input: unknown): Record<string, string | number> {
  const source = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const fields: Record<string, string | number> = {
    event: typeof source.event === 'string' && events.has(source.event) ? source.event : 'service.event',
  };
  if (typeof source.method === 'string' && methods.has(source.method)) fields.method = source.method;
  if (typeof source.routeTemplate === 'string' && (['unmatched', '*'].includes(source.routeTemplate) || /^\/[A-Za-z0-9_/*:.-]{0,180}$/.test(source.routeTemplate))) fields.routeTemplate = source.routeTemplate;
  if (Number.isInteger(source.statusCode) && Number(source.statusCode) >= 100 && Number(source.statusCode) <= 599) fields.statusCode = Number(source.statusCode);
  if (typeof source.durationMs === 'number' && Number.isFinite(source.durationMs) && source.durationMs >= 0) fields.durationMs = Math.round(source.durationMs * 100) / 100;
  if (typeof source.releaseSha === 'string' && /^[a-f0-9]{40}$/i.test(source.releaseSha)) fields.releaseSha = source.releaseSha;
  if (typeof source.environment === 'string' && ['local', 'staging', 'production'].includes(source.environment)) fields.environment = source.environment;
  if (input instanceof Error || source.err || source.errorCode !== undefined) {
    fields.errorCode = source.errorCode !== undefined ? failureCode({ code: source.errorCode }) : failureCode(source.err ?? input);
  }
  return fields;
}

export function createServer(options: { stream?: { write(message: string): void } } = {}) {
  return Fastify({
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'requestId' }),
    logger: {
      level: 'info', base: { service: 'sharebill-be' }, ...options,
      hooks: {
        logMethod(args, method) {
          let fields: Record<string, string | number>;
          try { fields = logFields(args[0]); }
          catch { fields = { event: 'service.event', errorCode: 'INTERNAL_ERROR' }; }
          method.apply(this, [fields, String(fields.event)]);
        },
      },
    },
  });
}
