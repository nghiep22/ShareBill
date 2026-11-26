import { describe, expect, it } from 'vitest';
import { withVietQrAmount } from '../../fe/src/vietqr.js';

// Account-transfer fixture with an existing amount and description (never used to send funds).
const example = '00020101021238590010A0000007270129000697044101156607040600001290208QRIBFTTA5204999953037045405100005802VN62180814SHAREBILL TEST630403F2';
const account = '38590010A0000007270129000697044101156607040600001290208QRIBFTTA';

// Independent table-based CRC reference; a changed recipient with a valid CRC must still be checked.
function seal(body: string) {
  const table = Array.from({ length: 256 }, (_, index) => {
    let crc = index << 8;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    return crc;
  });
  let crc = 0xffff;
  for (const byte of Buffer.from(body + '6304')) crc = ((crc << 8) ^ table[((crc >> 8) ^ byte) & 255]!) & 0xffff;
  return body + '6304' + crc.toString(16).toUpperCase().padStart(4, '0');
}
const body = example.slice(0, -8);

describe('VietQR transfer amounts', () => {
  it('matches the reference CRC and retains bank, account and description while replacing the amount', () => {
    expect(seal(body)).toBe(example);
    const generated = withVietQrAmount(example, 1141666);
    expect(generated).toContain(account);
    expect(generated).toContain('54071141666');
    expect(generated).not.toContain('540510000');
    expect(generated).toContain('62180814SHAREBILL TEST');
    expect(seal(generated.slice(0, -8))).toBe(generated);
    expect(withVietQrAmount(generated, 1141666)).toBe(generated);
  });
  it.each([1, 120000, 1_000_000_000_000])('adds an amount to a static QR: %s VND', amount => {
    const staticQr = seal(body.replace('010212', '010211').replace('540510000', ''));
    const generated = withVietQrAmount(staticQr, amount);
    expect(generated).toContain('010212' + account);
    expect(generated).toContain('54' + String(amount).length.toString().padStart(2, '0') + amount);
    expect(seal(generated.slice(0, -8))).toBe(generated);
  });
  it.each([0, -1, 1.5, NaN, Infinity, 1_000_000_000_001])('rejects an invalid amount: %s', amount => {
    expect(() => withVietQrAmount(example, amount)).toThrow();
  });
  it.each([
    example.slice(0, -1) + '0', example + '000201', 'https://bank.example/qr/123', example.slice(1),
    seal(body.replace('5303704', '5303840')),
    seal(body.replace('5802VN', '5802US')),
    seal(body.replace('A000000727', 'A000000999')),
    seal(body.replace('QRIBFTTA', 'QRIBFTTC')),
    seal(body.replace('QRIBFTTA', 'QRPUSHXX')),
    seal(body.replace('010212', '010213')),
    seal(body.replace('0006970441', '0006ABC441')),
    seal(body + '540510000'), // Duplicate amount.
    seal(body + '26080004TEST'), // Another payment scheme/recipient.
    seal(body + '5502025603100'), // Fees need separate handling.
    seal(body.replace('3800', '3801').replace('3859', '3800')),
    seal(body.replace('TEST', 'TÉST')),
  ])('does not regenerate unsupported or corrupted payment data (%#)', source => {
    expect(() => withVietQrAmount(source, 120000)).toThrow();
  });
});
