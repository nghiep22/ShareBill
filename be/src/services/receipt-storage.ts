import { receiptBucket } from '../firebase.js';
import { ApiError } from '../http.js';

export type ReceiptObject = { path: string; generation: string; bytes: number; contentType: string };
export type UploadPolicy = { url: string; fields: Record<string, string>; expiresAt: string; method?: 'PUT'; headers?: Record<string, string> };
export interface ReceiptStorage {
  uploadPolicy(path: string, contentType: string, maxBytes: number, expiresAt: number): Promise<UploadPolicy>;
  metadata(path: string): Promise<ReceiptObject>;
  read(path: string, generation: string, maxBytes: number): Promise<Buffer>;
  write(path: string, bytes: Buffer): Promise<ReceiptObject>;
  viewUrl(path: string, generation: string, expiresAt: number): Promise<string>;
  delete(path: string, generation: string): Promise<void>;
  list(prefix: string, pageToken?: string): Promise<{ items: ReceiptObject[]; nextPageToken?: string }>;
}
function storageError(error: unknown): never {
  const code = typeof error === 'object' && error && 'code' in error ? Number(error.code) : null;
  if (code === 404 || code === 412) throw new ApiError(409, 'STORAGE_GENERATION_CHANGED', 'Ảnh upload chưa có hoặc đã thay đổi. Hãy thử lại.');
  // SDK errors may contain signed request URLs. Do not forward or log their raw contents.
  throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Kho ảnh tạm thời chưa sẵn sàng. Hãy thử lại.');
}
function object(path: string, data: { generation?: string | number; size?: string | number; contentType?: string }): ReceiptObject {
  const bytes = Number(data.size), generation = String(data.generation ?? '');
  if (!/^[0-9]+$/.test(generation) || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new ApiError(409, 'RECEIPT_INVARIANT_FAILED', 'Metadata object không hợp lệ.');
  }
  return { path, generation, bytes, contentType: data.contentType ?? '' };
}
export class CloudReceiptStorage implements ReceiptStorage {
  async uploadPolicy(path: string, contentType: string, maxBytes: number, expiresAt: number) {
    try {
      const [policy] = await receiptBucket().file(path).generateSignedPostPolicyV4({ expires: expiresAt,
        fields: { 'Content-Type': contentType }, conditions: [['content-length-range', 1, maxBytes]] });
      return { url: policy.url, fields: policy.fields as Record<string, string>, expiresAt: new Date(expiresAt).toISOString() };
    } catch (error) { return storageError(error); }
  }
  async metadata(path: string) {
    try { const [data] = await receiptBucket().file(path).getMetadata(); return object(path, data); }
    catch (error) { return storageError(error); }
  }
  async read(path: string, generation: string, maxBytes: number): Promise<Buffer> {
    try {
      const stream = receiptBucket().file(path, { generation }).createReadStream();
      const timeout = setTimeout(() => stream.destroy(new Error('READ_TIMEOUT')), 15_000);
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of stream) {
          const bytes = Buffer.from(chunk); size += bytes.length;
          if (size > maxBytes) { stream.destroy(); throw new ApiError(422, 'INVALID_RECEIPT_IMAGE', 'Ảnh vượt giới hạn dung lượng.'); }
          chunks.push(bytes);
        }
        return Buffer.concat(chunks, size);
      } finally { clearTimeout(timeout); }
    } catch (error) { if (error instanceof ApiError) throw error; return storageError(error); }
  }
  async write(path: string, bytes: Buffer) {
    try {
      const file = receiptBucket().file(path);
      await file.save(bytes, { resumable: false, validation: 'crc32c', preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { contentType: 'image/jpeg', cacheControl: 'private, no-store' } });
      const [data] = await file.getMetadata(); return object(path, data);
    } catch (error) { return storageError(error); }
  }
  async viewUrl(path: string, generation: string, expiresAt: number) {
    try {
      const [url] = await receiptBucket().file(path, { generation }).getSignedUrl({ version: 'v4', action: 'read', expires: expiresAt,
        queryParams: { generation } });
      return url;
    } catch (error) { return storageError(error); }
  }
  async delete(path: string, generation: string) {
    try { await receiptBucket().file(path, { generation, preconditionOpts: { ifGenerationMatch: generation } }).delete({ ignoreNotFound: true }); }
    catch (error) { return storageError(error); }
  }
  async list(prefix: string, pageToken?: string) {
    try {
      const [files, next] = await receiptBucket().getFiles({ prefix, pageToken, maxResults: 100, autoPaginate: false, versions: true });
      return { items: files.map(file => object(file.name, file.metadata)), nextPageToken: next?.pageToken };
    } catch (error) { return storageError(error); }
  }
}
