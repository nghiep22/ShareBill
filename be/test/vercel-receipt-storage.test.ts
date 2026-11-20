import { beforeEach, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => ({ issueSignedToken: vi.fn(), presignUrl: vi.fn(), head: vi.fn(), get: vi.fn(), put: vi.fn(), del: vi.fn(), list: vi.fn() }));
vi.mock('@vercel/blob', async importOriginal => ({ ...await importOriginal<object>(), ...sdk }));
import { VercelReceiptStorage } from '../src/services/vercel-receipt-storage.js';
import { BlobNotFoundError, BlobPreconditionFailedError } from '@vercel/blob';

beforeEach(() => { vi.resetAllMocks(); });

it('scopes private upload and read capabilities to one immutable pathname and a short expiry', async () => {
  const storage = new VercelReceiptStorage(), expiresAt = Date.now() + 60_000;
  sdk.issueSignedToken.mockResolvedValue({ delegationToken: 'delegation-secret', clientSigningToken: 'signing-secret' });
  sdk.presignUrl.mockResolvedValue({ presignedUrl: 'https://private.example.test/signed' });
  const policy = await storage.uploadPolicy('staging/original', 'image/png', 5242880, expiresAt);
  expect(policy).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/png' }, fields: {} });
  expect(JSON.stringify(policy)).not.toContain('signing-secret');
  expect(sdk.issueSignedToken).toHaveBeenCalledWith({ pathname: 'staging/original', operations: ['put'], validUntil: expiresAt,
    allowedContentTypes: ['image/png'], maximumSizeInBytes: 5242880 });
  expect(sdk.presignUrl).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ access: 'private',
    pathname: 'staging/original', allowOverwrite: false, addRandomSuffix: false, maximumSizeInBytes: 5242880, validUntil: expiresAt }));
  sdk.head.mockResolvedValue({ pathname: 'processed/image.jpg', etag: 'generation-2', size: 100, contentType: 'image/jpeg' });
  await storage.viewUrl('processed/image.jpg', 'generation-2', expiresAt);
  expect(sdk.issueSignedToken).toHaveBeenLastCalledWith({ pathname: 'processed/image.jpg', operations: ['get'], validUntil: expiresAt });
  expect(sdk.presignUrl).toHaveBeenLastCalledWith(expect.any(Object), expect.objectContaining({ operation: 'get', access: 'private', useCache: false }));
});

it('rejects changed and oversized streams before processing and conditionally deletes the pinned object', async () => {
  const storage = new VercelReceiptStorage();
  const cancelled = vi.fn(), stream = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('12345')); controller.close(); }, cancel: cancelled });
  sdk.get.mockImplementation(async () => ({ statusCode: 200, blob: { etag: 'generation-2', size: 5 }, stream: stream() }));
  await expect(storage.read('image', 'generation-1', 10)).rejects.toMatchObject({ code: 'STORAGE_GENERATION_CHANGED' });
  expect(cancelled).toHaveBeenCalledOnce();
  await expect(storage.read('image', 'generation-2', 4)).rejects.toMatchObject({ code: 'INVALID_RECEIPT_IMAGE' });
  sdk.get.mockImplementation(async () => ({ statusCode: 200, blob: { etag: 'generation-2', size: 1 }, stream: stream() }));
  await expect(storage.read('image', 'generation-2', 4)).rejects.toMatchObject({ code: 'INVALID_RECEIPT_IMAGE' });
  await storage.delete('image', 'generation-2');
  expect(sdk.del).toHaveBeenCalledWith('image', expect.objectContaining({ ifMatch: 'generation-2' }));
  sdk.del.mockRejectedValue(new BlobNotFoundError());
  await expect(storage.delete('image', 'generation-2')).resolves.toBeUndefined();
  sdk.del.mockRejectedValue(new BlobPreconditionFailedError());
  await expect(storage.delete('image', 'generation-2')).rejects.toMatchObject({ code: 'STORAGE_GENERATION_CHANGED' });
});

it('never exposes SDK capability text on errors and writes only private immutable output', async () => {
  const storage = new VercelReceiptStorage(), bytes = Buffer.from('processed');
  sdk.put.mockResolvedValue({ pathname: 'processed/image.jpg', etag: 'generation-2', contentType: 'image/jpeg' });
  expect(await storage.write('processed/image.jpg', bytes)).toMatchObject({ generation: 'generation-2', bytes: bytes.length });
  expect(sdk.put).toHaveBeenCalledWith('processed/image.jpg', bytes, expect.objectContaining({ access: 'private',
    allowOverwrite: false, addRandomSuffix: false, contentType: 'image/jpeg' }));
  sdk.head.mockRejectedValue(new Error('https://private.example.test/?token=private-capability'));
  await expect(storage.metadata('image')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', message: 'Kho ảnh tạm thời chưa sẵn sàng. Hãy thử lại.' });
});
