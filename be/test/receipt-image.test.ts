import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { processReceiptImage } from '../src/services/receipt-image.js';
import { MAX_RECEIPT_BYTES } from '../src/database/receipt.js';

describe('receipt image processing', () => {
  it('rotates, resizes, strips private metadata and emits bounded JPEG', async () => {
    const source = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#fff4da' } })
      .withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const result = await processReceiptImage(source, 'image/jpeg');
    expect([result.width, result.height]).toEqual([800, 1600]);
    expect(result.buffer.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.exif).toBeUndefined(); expect(metadata.icc).toBeUndefined(); expect(metadata.orientation).toBeUndefined();
  });
  it('rejects empty/oversize, spoofed or corrupt inputs and unsupported formats', async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).png().toBuffer();
    for (const [bytes, type] of [
      [Buffer.alloc(0), 'image/png'], [Buffer.alloc(MAX_RECEIPT_BYTES + 1), 'image/png'],
      [png, 'image/jpeg'], [png.subarray(0, 24), 'image/png'], [Buffer.from('<svg><rect/></svg>'), 'image/png'],
      [Buffer.from('GIF89a'), 'image/webp'], [Buffer.from('%PDF-1.0'), 'image/jpeg'],
    ] as [Buffer, string][]) {
      await expect(processReceiptImage(bytes, type)).rejects.toMatchObject({ status: 422, code: 'INVALID_RECEIPT_IMAGE' });
    }
  });
  it('rejects more than 20 megapixels and animated WebP', async () => {
    const large = await sharp({ create: { width: 4500, height: 4500, channels: 3, background: '#fff' } }).png().toBuffer();
    await expect(processReceiptImage(large, 'image/png')).rejects.toMatchObject({ code: 'INVALID_RECEIPT_IMAGE' });
    const frames = Buffer.from([...Array.from({ length: 4 }, () => [255, 0, 0]).flat(),
      ...Array.from({ length: 4 }, () => [0, 0, 255]).flat()]);
    const animated = await sharp(frames, { raw: { width: 2, height: 4, pageHeight: 2, channels: 3 } })
      .webp({ loop: 0, delay: [100, 100] }).toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(2);
    await expect(processReceiptImage(animated, 'image/webp')).rejects.toMatchObject({ code: 'INVALID_RECEIPT_IMAGE' });
  });
});
