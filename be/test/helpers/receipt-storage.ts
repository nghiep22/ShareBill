import { ApiError } from '../../src/http.js';
import type { ReceiptObject, ReceiptStorage } from '../../src/services/receipt-storage.js';

export class MemoryReceiptStorage implements ReceiptStorage {
  objects = new Map<string, ReceiptObject & { buffer: Buffer }>();
  policies: { path: string; contentType: string; maxBytes: number; expiresAt: number }[] = [];
  deleted: { path: string; generation: string }[] = [];
  counter = 0;
  seed(path: string, buffer: Buffer, contentType = 'image/png') {
    const data = { path, generation: String(++this.counter), bytes: buffer.length, contentType, buffer: Buffer.from(buffer) };
    this.objects.set(path, data); return data;
  }
  async uploadPolicy(path: string, contentType: string, maxBytes: number, expiresAt: number) {
    this.policies.push({ path, contentType, maxBytes, expiresAt });
    return { url: 'https://storage.example.test/upload', fields: { key: path, 'Content-Type': contentType,
      policy: 'fake-policy-secret', 'x-goog-signature': 'fake-upload-signature' }, expiresAt: new Date(expiresAt).toISOString() };
  }
  async metadata(path: string) {
    const object = this.objects.get(path);
    if (!object) throw new ApiError(409, 'STORAGE_GENERATION_CHANGED', 'Missing object');
    const { buffer: _buffer, ...metadata } = object; return metadata;
  }
  async read(path: string, generation: string, maxBytes: number) {
    const object = this.objects.get(path);
    if (!object || object.generation !== generation) throw new ApiError(409, 'STORAGE_GENERATION_CHANGED', 'Object changed');
    if (object.bytes > maxBytes) throw new ApiError(422, 'INVALID_RECEIPT_IMAGE', 'Too large');
    return Buffer.from(object.buffer);
  }
  async write(path: string, bytes: Buffer) {
    if (this.objects.has(path)) throw new ApiError(409, 'STORAGE_GENERATION_CHANGED', 'Existing object');
    const { buffer: _buffer, ...object } = this.seed(path, bytes, 'image/jpeg'); return object;
  }
  async viewUrl(path: string, generation: string, expiresAt: number) {
    return `https://storage.example.test/${encodeURIComponent(path)}?generation=${generation}&expires=${expiresAt}&X-Goog-Signature=fake-view-signature`;
  }
  async delete(path: string, generation: string) {
    const object = this.objects.get(path);
    if (!object) return;
    if (object.generation !== generation) throw new ApiError(409, 'STORAGE_GENERATION_CHANGED', 'Delete generation changed');
    this.objects.delete(path); this.deleted.push({ path, generation });
  }
  async list(prefix: string) {
    const all = [...this.objects.values()].filter(item => item.path.startsWith(prefix)).sort((a, b) => a.path.localeCompare(b.path));
    return { items: all.slice(0, 100).map(({ buffer: _buffer, ...item }) => item), nextPageToken: all.length > 100 ? 'more' : undefined };
  }
}
