import { BlobNotFoundError, BlobPreconditionFailedError, del, get, head, issueSignedToken, list, presignUrl, put } from '@vercel/blob';
import { ApiError } from '../http.js';
import type { ReceiptObject, ReceiptStorage } from './receipt-storage.js';

function storageError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof BlobNotFoundError || error instanceof BlobPreconditionFailedError) {
    throw new ApiError(409, 'STORAGE_GENERATION_CHANGED', 'Ảnh chưa có hoặc đã thay đổi. Hãy tải lại.');
  }
  throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Kho ảnh tạm thời chưa sẵn sàng. Hãy thử lại.');
}

/** Private, immutable objects; Blob ETags serve the same purpose as Cloud Storage generations. */
export class VercelReceiptStorage implements ReceiptStorage {
  async uploadPolicy(path: string, contentType: string, maxBytes: number, expiresAt: number) {
    try {
      const signed = await issueSignedToken({ pathname: path, operations: ['put'], validUntil: expiresAt,
        allowedContentTypes: [contentType], maximumSizeInBytes: maxBytes });
      const { presignedUrl } = await presignUrl(signed, { operation: 'put', pathname: path, access: 'private',
        validUntil: expiresAt, allowedContentTypes: [contentType], maximumSizeInBytes: maxBytes,
        allowOverwrite: false, addRandomSuffix: false, cacheControlMaxAge: 60 });
      return { url: presignedUrl, method: 'PUT' as const, headers: { 'Content-Type': contentType }, fields: {},
        expiresAt: new Date(expiresAt).toISOString() };
    } catch (error) { return storageError(error); }
  }

  async metadata(path: string): Promise<ReceiptObject> {
    try {
      const blob = await head(path, { abortSignal: AbortSignal.timeout(15_000) });
      if (blob.pathname !== path || !blob.etag || !Number.isSafeInteger(blob.size) || blob.size < 0) {
        throw new ApiError(409, 'RECEIPT_INVARIANT_FAILED', 'Dữ liệu ảnh chưa hợp lệ.');
      }
      return { path, generation: blob.etag, bytes: blob.size, contentType: blob.contentType };
    } catch (error) { return storageError(error); }
  }

  async read(path: string, generation: string, maxBytes: number): Promise<Buffer> {
    try {
      const result = await get(path, { access: 'private', useCache: false, abortSignal: AbortSignal.timeout(15_000) });
      if (!result || result.statusCode !== 200 || result.blob.etag !== generation) {
        if (result?.stream) await result.stream.cancel();
        throw new ApiError(409, 'STORAGE_GENERATION_CHANGED', 'Ảnh đã thay đổi. Hãy tải lại.');
      }
      if (result.blob.size > maxBytes) { await result.stream.cancel(); throw new ApiError(422, 'INVALID_RECEIPT_IMAGE', 'Ảnh vượt giới hạn dung lượng.'); }
      const reader = result.stream.getReader(), chunks: Buffer[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > maxBytes) { await reader.cancel(); throw new ApiError(422, 'INVALID_RECEIPT_IMAGE', 'Ảnh vượt giới hạn dung lượng.'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      return Buffer.concat(chunks, size);
    } catch (error) { return storageError(error); }
  }

  async write(path: string, bytes: Buffer): Promise<ReceiptObject> {
    try {
      const blob = await put(path, bytes, { access: 'private', allowOverwrite: false, addRandomSuffix: false,
        contentType: 'image/jpeg', cacheControlMaxAge: 60, abortSignal: AbortSignal.timeout(15_000) });
      return { path: blob.pathname, generation: blob.etag, bytes: bytes.length, contentType: blob.contentType };
    } catch (error) { return storageError(error); }
  }

  async viewUrl(path: string, generation: string, expiresAt: number) {
    try {
      if ((await this.metadata(path)).generation !== generation) throw new ApiError(409, 'STORAGE_GENERATION_CHANGED', 'Ảnh đã thay đổi.');
      const signed = await issueSignedToken({ pathname: path, operations: ['get'], validUntil: expiresAt });
      return (await presignUrl(signed, { operation: 'get', pathname: path, access: 'private', validUntil: expiresAt, useCache: false })).presignedUrl;
    } catch (error) { return storageError(error); }
  }

  async delete(path: string, generation: string) {
    try { await del(path, { ifMatch: generation, abortSignal: AbortSignal.timeout(15_000) }); }
    catch (error) { if (!(error instanceof BlobNotFoundError)) return storageError(error); }
  }

  async list(prefix: string, pageToken?: string) {
    try {
      const page = await list({ prefix, cursor: pageToken, limit: 100, abortSignal: AbortSignal.timeout(15_000) });
      return { items: page.blobs.map(blob => ({ path: blob.pathname, generation: blob.etag, bytes: blob.size,
        contentType: 'application/octet-stream' })), nextPageToken: page.hasMore ? page.cursor : undefined };
    } catch (error) { return storageError(error); }
  }
}
