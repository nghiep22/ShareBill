import { tripSnapshot, type TripOverview } from './api-data';
import { financialSnapshot } from './finance-view';
import { categories, type Category } from './model';

export type ExpenseDraft = {
  fields: { title: string; date: string; category: Category; note: string };
  amount: string; payer: string; mode: 'equal' | 'exact'; selected: string[];
  exact: Record<string, string>;
};
export type DeviceScope = { uid: string; tripId: string };
export type PrivateRecord<T> = DeviceScope & { kind: 'overview' | 'expense-new'; at: number; value: T };

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit;
const id = (value: unknown): value is string => text(value, 128) && value.length > 0;
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min;
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 50 && value.every(id) && new Set(value).size === value.length;
const moneyInput = (value: unknown): value is string => typeof value === 'string' && /^\d{0,13}$/.test(value);

function day(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isExpenseDraft(value: unknown): value is ExpenseDraft {
  if (!object(value) || !object(value.fields) || !object(value.exact)) return false;
  const { fields } = value;
  return text(fields.title, 120) && text(fields.note, 1000) && (fields.date === '' || day(fields.date)) &&
    typeof fields.category === 'string' && Object.hasOwn(categories, fields.category) &&
    moneyInput(value.amount) && text(value.payer, 128) && (value.mode === 'equal' || value.mode === 'exact') && ids(value.selected) &&
    Object.keys(value.exact).length <= 50 && Object.entries(value.exact).every(([key, amount]) => id(key) && moneyInput(amount));
}

export function isTripSnapshot(value: unknown, scope: DeviceScope): value is TripOverview {
  if (!object(value) || !object(value.trip) || !Array.isArray(value.participants) || !Array.isArray(value.balances)) return false;
  const { trip, participants, balances } = value;
  if (trip.id !== scope.tripId || !text(trip.name, 100) || !trip.name || !id(trip.ownerUid) ||
      !['active', 'archived'].includes(String(trip.status)) || !['normal', 'suspended'].includes(String(trip.moderationStatus)) ||
      !integer(trip.version, 1) || !integer(trip.ledgerVersion) || !integer(trip.participantCount, 1) ||
      !integer(trip.activeExpenseCount) || !integer(trip.totalExpenseMinor) || !integer(trip.pendingSettlementCount) ||
      !(trip.destination === null || text(trip.destination, 150)) || !(trip.note === null || text(trip.note, 1000)) ||
      !(trip.startDate === null || day(trip.startDate)) || !(trip.endDate === null || day(trip.endDate)) ||
      (trip.startDate === null) !== (trip.endDate === null) ||
      (typeof trip.startDate === 'string' && typeof trip.endDate === 'string' && trip.startDate > trip.endDate)) return false;
  if (trip.sharingMode !== 'group-equal' && trip.sharingMode !== 'per-expense' && !(trip.status === 'archived' && trip.sharingMode === undefined)) return false;
  if (trip.timezone !== undefined) {
    if (!text(trip.timezone, 100)) return false;
    try { new Intl.DateTimeFormat('vi-VN', { timeZone: trip.timezone }); } catch { return false; }
  }
  if (!participants.length || participants.length > 50 || balances.length > 50 || !balances.every(object) ||
      !participants.every(person => object(person) && id(person.id) && text(person.displayName, 80) && person.displayName.length > 0 &&
        (person.status === 'active' || person.status === 'inactive') && (person.linkedUid === null || id(person.linkedUid)) && integer(person.version, 1))) return false;
  const people = participants as TripOverview['participants'];
  if (trip.myParticipantId !== undefined && trip.myParticipantId !== null && !people.some(person => person.id === trip.myParticipantId)) return false;
  return financialSnapshot(tripSnapshot(value as TripOverview, scope.uid)).complete;
}

export function readPrivateRecord<T>(value: unknown, scope: DeviceScope, kind: PrivateRecord<T>['kind'], valid: (value: unknown) => value is T, now = Date.now()): PrivateRecord<T> | undefined {
  if (!object(value) || value.uid !== scope.uid || value.tripId !== scope.tripId || value.kind !== kind ||
      !integer(value.at, 1) || value.at > now || now - value.at >= 24 * 60 * 60_000 || !valid(value.value)) return;
  return value as PrivateRecord<T>;
}
