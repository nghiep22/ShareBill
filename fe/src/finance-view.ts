import type { BalanceLine, Demo, Transfer } from './model';
import { maximumMoney } from './money-input';

export function transferLimit(fromNet: number, toNet: number) {
  return Number.isSafeInteger(fromNet) && Number.isSafeInteger(toNet) && fromNet < 0 && toNet > 0
    ? Math.min(-fromNet, toNet, maximumMoney) : 0;
}

/** Money views use the complete server snapshot, never sums of a filtered/paginated expense list. */
export function financialSnapshot(data: Demo) {
  const remote = data.remote;
  const unavailable = { complete: false, lines: {} as Record<string, BalanceLine>, net: {} as Record<string, number>, balanced: false };
  if (!remote || !Array.isArray(remote.balances) || data.members.length < 1 || data.members.length !== remote.participantCount || remote.balances.length !== data.members.length ||
      !Number.isSafeInteger(remote.total) || remote.total < 0 || !Number.isSafeInteger(remote.pendingCount) || remote.pendingCount < 0 ||
      !Number.isSafeInteger(remote.expenseCount) || remote.expenseCount < 0 || (remote.expenseCount === 0) !== (remote.total === 0) ||
      !Number.isSafeInteger(remote.ledgerVersion) || remote.ledgerVersion < 0) return unavailable;
  const ids = new Set(data.members.map(member => member.id));
  if (ids.size !== data.members.length) return unavailable;
  const lines: Record<string, BalanceLine> = Object.create(null);
  let paid = 0, owed = 0, sent = 0, received = 0, net = 0;
  for (const row of remote.balances) {
    if (!row || !ids.has(row.participantId) || Object.hasOwn(lines, row.participantId) ||
        ![row.paidMinor, row.owedMinor, row.sentMinor, row.receivedMinor, row.netMinor].every(Number.isSafeInteger) ||
        [row.paidMinor, row.owedMinor, row.sentMinor, row.receivedMinor].some(value => value < 0) ||
        row.netMinor !== row.paidMinor - row.owedMinor + row.sentMinor - row.receivedMinor) return unavailable;
    lines[row.participantId] = row;
    paid += row.paidMinor; owed += row.owedMinor; sent += row.sentMinor; received += row.receivedMinor; net += row.netMinor;
  }
  if (![paid, owed, sent, received, net].every(Number.isSafeInteger) || paid !== remote.total || owed !== remote.total || sent !== received || net !== 0) return unavailable;
  if (remote.sharingMode === 'group-equal') {
    const group = remote.equalParticipantIds;
    if (!Array.isArray(group) || !group.length || group.length > 50 || new Set(group).size !== group.length || group.some(id => !ids.has(id))) return unavailable;
    const sorted = [...group].sort(), total = BigInt(remote.total), count = BigInt(sorted.length);
    const expected = new Map(sorted.map((id, index) => [id, Number(total / count + (BigInt(index) < total % count ? BigInt(1) : BigInt(0)))]));
    if (Object.values(lines).some(row => row.owedMinor !== (expected.get(row.participantId) ?? 0))) return unavailable;
  }
  return { complete: true, lines, net: Object.fromEntries(Object.values(lines).map(row => [row.participantId, row.netMinor])),
    balanced: Object.values(lines).every(row => row.netMinor === 0) && remote.pendingCount === 0 };
}

export function validSuggestions(data: Demo): Transfer[] {
  const state = financialSnapshot(data);
  if (!state.complete || !data.remote?.suggestionsReady) return [];
  const remaining = { ...state.net };
  for (const transfer of data.remote.suggestions) {
    const from = remaining[transfer.from], to = remaining[transfer.to];
    if (!Number.isSafeInteger(transfer.amount) || transfer.amount < 1 || transfer.from === transfer.to ||
        from === undefined || to === undefined || !(from < 0) || !(to > 0) || transfer.amount > Math.min(-from, to)) return [];
    remaining[transfer.from] = from + transfer.amount;
    remaining[transfer.to] = to - transfer.amount;
  }
  return Object.values(remaining).every(value => value === 0) ? data.remote.suggestions : [];
}
