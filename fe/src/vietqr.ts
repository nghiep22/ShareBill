type Field = { id: string; value: string };

function invalid(): never { throw new Error('UNSUPPORTED_VIETQR'); }

function fields(text: string): Field[] {
  const result: Field[] = [], seen = new Set<string>();
  for (let offset = 0; offset < text.length;) {
    const header = text.slice(offset, offset + 4);
    if (!/^\d{4}$/.test(header)) return invalid();
    const id = header.slice(0, 2), size = Number(header.slice(2));
    if (!size || seen.has(id) || offset + 4 + size > text.length) return invalid();
    result.push({ id, value: text.slice(offset + 4, offset + 4 + size) });
    seen.add(id); offset += 4 + size;
  }
  return result;
}

function crc16(text: string): string {
  let crc = 0xffff;
  for (let index = 0; index < text.length; index++) {
    crc ^= text.charCodeAt(index) << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** NAPAS account-transfer VietQR (EMV TLV): retain the recipient, replace only initiation/amount/CRC.
 * Reject other schemes, ambiguous recipients and non-ASCII rather than guessing their encoding.
 */
export function withVietQrAmount(source: string, amount: number): string {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000_000_000) return invalid();
  if (source.length > 4096 || !/^[\x20-\x7e]+$/.test(source)) return invalid();
  const root = fields(source), get = (id: string) => root.find(field => field.id === id)?.value;
  if (root[0]?.id !== '00' || get('00') !== '01' || root.at(-1)?.id !== '63' ||
      !/^[0-9A-Fa-f]{4}$/.test(get('63') ?? '') || crc16(source.slice(0, -4)) !== get('63')!.toUpperCase() ||
      (get('01') !== undefined && !['11', '12'].includes(get('01')!)) || get('53') !== '704' || get('58') !== 'VN') return invalid();
  const accounts = root.filter(field => Number(field.id) >= 2 && Number(field.id) <= 51);
  const bankAccount = accounts[0];
  if (accounts.length !== 1 || !bankAccount || bankAccount.id !== '38' || root.some(field => ['55', '56', '57'].includes(field.id))) return invalid();
  const account = fields(bankAccount.value), nested = (id: string) => account.find(field => field.id === id)?.value;
  if (nested('00') !== 'A000000727' || nested('02') !== 'QRIBFTTA' || !nested('01')) return invalid();
  const recipient = fields(nested('01')!);
  if (recipient.length !== 2 || !/^\d{6}$/.test(recipient.find(field => field.id === '00')?.value ?? '') ||
      !/^[A-Za-z0-9]{1,19}$/.test(recipient.find(field => field.id === '01')?.value ?? '')) return invalid();
  const next = root.filter(field => !['01', '54', '63'].includes(field.id));
  next.push({ id: '01', value: '12' }, { id: '54', value: String(amount) });
  next.sort((a, b) => Number(a.id) - Number(b.id));
  const payload = next.map(field => field.id + String(field.value.length).padStart(2, '0') + field.value).join('') + '6304';
  return payload + crc16(payload);
}
