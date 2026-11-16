export type Share = { participantId: string; amountMinor: number };
export type Balance = {
  participantId: string;
  paidMinor: number;
  owedMinor: number;
  sentMinor: number;
  receivedMinor: number;
  netMinor: number;
};

export const MAX_AMOUNT_MINOR = 1_000_000_000_000;

export function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_AMOUNT_MINOR) {
    throw new Error('INVALID_AMOUNT');
  }
}

export function splitEqual(amount: number, participantIds: string[]): Share[] {
  assertAmount(amount);
  const ids = [...participantIds].sort();
  if (ids.length === 0 || ids.length > 50 || new Set(ids).size !== ids.length) {
    throw new Error('INVALID_PARTICIPANTS');
  }
  const total = BigInt(amount);
  const count = BigInt(ids.length);
  const base = total / count;
  const remainder = total % count;
  return ids.map((participantId, index) => ({
    participantId,
    amountMinor: Number(base + (BigInt(index) < remainder ? 1n : 0n)),
  }));
}

export function validateExact(amount: number, shares: Share[]): Share[] {
  assertAmount(amount);
  if (shares.length === 0 || shares.length > 50 || new Set(shares.map(s => s.participantId)).size !== shares.length) {
    throw new Error('INVALID_SHARES');
  }
  let sum = 0n;
  for (const share of shares) {
    if (!Number.isSafeInteger(share.amountMinor) || share.amountMinor < 0) throw new Error('INVALID_SHARES');
    sum += BigInt(share.amountMinor);
  }
  if (sum !== BigInt(amount)) throw new Error('SPLIT_TOTAL_MISMATCH');
  return [...shares].sort((a, b) => a.participantId.localeCompare(b.participantId, 'en'));
}

export function expenseDelta(amount: number, payerParticipantId: string, shares: Share[], sign: 1 | -1): Map<string, { paidMinor: number; owedMinor: number; netMinor: number }> {
  const deltas = new Map<string, { paidMinor: number; owedMinor: number; netMinor: number }>();
  function get(id: string) {
    let item = deltas.get(id);
    if (!item) { item = { paidMinor: 0, owedMinor: 0, netMinor: 0 }; deltas.set(id, item); }
    return item;
  }
  const payer = get(payerParticipantId);
  payer.paidMinor += sign * amount;
  payer.netMinor += sign * amount;
  for (const share of shares) {
    const item = get(share.participantId);
    item.owedMinor += sign * share.amountMinor;
    item.netMinor -= sign * share.amountMinor;
  }
  if ([...deltas.values()].reduce((n, d) => n + d.netMinor, 0) !== 0) throw new Error('BALANCE_INVARIANT_FAILED');
  return deltas;
}

export function applyBalanceDelta(balance: Balance, delta: { paidMinor: number; owedMinor: number; netMinor: number }): Balance {
  const next = {
    ...balance,
    paidMinor: balance.paidMinor + delta.paidMinor,
    owedMinor: balance.owedMinor + delta.owedMinor,
    netMinor: balance.netMinor + delta.netMinor,
  };
  if (Object.values(next).some(value => typeof value === 'number' && !Number.isSafeInteger(value)) ||
      next.netMinor !== next.paidMinor - next.owedMinor + next.sentMinor - next.receivedMinor) {
    throw new Error('BALANCE_INVARIANT_FAILED');
  }
  return next;
}
