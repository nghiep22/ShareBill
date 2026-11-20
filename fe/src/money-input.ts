export const maximumMoney = 1_000_000_000_000;

export function parseMoney(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^\d{0,13}$/.test(trimmed)) return trimmed;
  if (!/^(?:\d{1,3}(?:\.\d{3})+|\d{1,3}(?:,\d{3})+)$/.test(trimmed)) return;
  const plain = trimmed.replace(/[.,]/g, '');
  if (plain.length <= 13) return plain;
}

export function parsePositiveMoney(value: string): number | undefined {
  const normalized = parseMoney(value);
  const amount = normalized ? Number(normalized) : NaN;
  return Number.isSafeInteger(amount) && amount > 0 && amount <= maximumMoney ? amount : undefined;
}
