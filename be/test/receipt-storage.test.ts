import { expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => ({ file: vi.fn(), getFiles: vi.fn() }));
vi.mock('../src/firebase.js', () => ({ receiptBucket: () => sdk }));
import { CloudReceiptStorage } from '../src/services/receipt-storage.js';

it('constrains signed capabilities and pins generation for reads/deletes without exposing SDK failures', async () => {
  const file = { generateSignedPostPolicyV4: vi.fn().mockResolvedValue([{ url: 'https://storage.example.test', fields: { key: 'staging' } }]),
    getSignedUrl: vi.fn().mockResolvedValue(['https://storage.example.test/signed']),
    delete: vi.fn().mockResolvedValue([]), save: vi.fn().mockResolvedValue(undefined),
    getMetadata: vi.fn().mockResolvedValue([{ generation: '9007199254740993', size: '10', contentType: 'image/jpeg' }]) };
  sdk.file.mockReturnValue(file);
  const storage = new CloudReceiptStorage(), expiresAt = Date.now() + 300_000;
  await storage.uploadPolicy('staging', 'image/png', 5242880, expiresAt);
  expect(file.generateSignedPostPolicyV4).toHaveBeenCalledWith({ expires: expiresAt,
    fields: { 'Content-Type': 'image/png' }, conditions: [['content-length-range', 1, 5242880]] });
  await storage.write('processed', Buffer.from('bytes'));
  expect(file.save).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ preconditionOpts: { ifGenerationMatch: 0 },
    metadata: { contentType: 'image/jpeg', cacheControl: 'private, no-store' } }));
  await storage.viewUrl('processed', '9007199254740993', expiresAt);
  expect(file.getSignedUrl).toHaveBeenCalledWith({ version: 'v4', action: 'read', expires: expiresAt,
    queryParams: { generation: '9007199254740993' } });
  await storage.delete('processed', '9007199254740993');
  expect(sdk.file).toHaveBeenLastCalledWith('processed', { generation: '9007199254740993', preconditionOpts: { ifGenerationMatch: '9007199254740993' } });
  file.getSignedUrl.mockRejectedValue(new Error('secret signed URL must not be logged'));
  await expect(storage.viewUrl('processed', '1', expiresAt)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', status: 503 });
});
