import sharp from 'sharp';
import { ApiError } from '../http.js';
import { MAX_PROCESSED_BYTES, MAX_RECEIPT_BYTES } from '../database/receipt.js';

export type ProcessedReceiptImage = { buffer: Buffer; width: number; height: number };
export type ReceiptImageProcessor = (bytes: Buffer, declaredContentType: string) => Promise<ProcessedReceiptImage>;
function invalid(): never { throw new ApiError(422, 'INVALID_RECEIPT_IMAGE', 'Ảnh không hợp lệ. Chọn JPEG, PNG hoặc WebP tĩnh, tối đa 5 MiB và 20 megapixel.'); }
function hasAnimation(bytes: Buffer, type: string) {
  if (type === 'image/png') {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = bytes.readUInt32BE(offset), name = bytes.toString('ascii', offset + 4, offset + 8);
      if (name === 'acTL') return true;
      offset += size + 12;
    }
  }
  if (type === 'image/webp') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const name = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
      if (name === 'ANIM' || name === 'ANMF' || name === 'VP8X' && size > 0 && ((bytes[offset + 8] ?? 0) & 2)) return true;
      offset += 8 + size + size % 2;
    }
  }
  return false;
}
export const processReceiptImage: ReceiptImageProcessor = async (bytes, declaredContentType) => {
  if (!bytes.length || bytes.length > MAX_RECEIPT_BYTES) return invalid();
  const type = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' :
    bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' :
      bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
  if (!type || type !== declaredContentType || hasAnimation(bytes, type)) return invalid();
  try {
    const image = sharp(bytes, { limitInputPixels: 20_000_000, failOn: 'warning' });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > 20_000_000 || (metadata.pages ?? 1) > 1) return invalid();
    const output = await image.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).toColourspace('srgb').jpeg({ quality: 82 }).timeout({ seconds: 10 }).toBuffer({ resolveWithObject: true });
    if (!output.data.length || output.data.length > MAX_PROCESSED_BYTES) return invalid();
    return { buffer: output.data, width: output.info.width, height: output.info.height };
  } catch { return invalid(); }
};
