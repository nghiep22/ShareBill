import { financialSnapshot, validSuggestions } from './finance-view';

export const categories = {
  stay: 'Lưu trú',
  food: 'Ăn uống',
  transport: 'Di chuyển',
  fun: 'Vui chơi',
  tickets: 'Vé tham quan',
  shopping: 'Mua sắm',
  other: 'Khác',
};

export type Category = keyof typeof categories;
export type Member = { id: string; name: string; tone: number; inactive?: boolean; linked?: boolean; uid?: string; version?: number };
export type Receipt = { id: string; name: string; src?: string; version?: number };
export type Expense = {
  id: string;
  title: string;
  amount: number;
  payer: string;
  date: string;
  category: Category;
  note: string;
  shares: Record<string, number>;
  mode: 'equal' | 'exact';
  voided?: boolean;
  voidReason?: string;
  receipts?: Receipt[];
  createdBy?: string;
  editedBy?: string;
  version?: number;
};
export type Transfer = { from: string; to: string; amount: number };
export type Settlement = Transfer & {
  id: string; confirmed: boolean; status?: 'pending' | 'confirmed' | 'cancelled' | 'void';
  date?: string; recordedBy?: string; confirmedBy?: string; reason?: string;
  version?: number;
  confirmationMode?: 'recipient' | 'owner_on_behalf';
  confirmedAt?: string;
};
export type Plan = { id: string; day: string; time: string; title: string; place: string; note?: string; suggestionId?: string };
export type Idea = { id: string; title: string; by: string; author?: string; declined?: boolean; scheduled?: boolean };
export type InviteLink = { token: string; expiresAt: number; limit: number; uses: number; revoked?: boolean };
export type Activity = { id: string; at: string; title: string; detail: string; actor: string; actorName?: string; href?: string };
export type Trip = { name: string; place: string; start: string; end: string; closed: boolean; note?: string; cover?: boolean; timezone?: string };
export type BalanceLine = { participantId: string; paidMinor: number; owedMinor: number; sentMinor: number; receivedMinor: number; netMinor: number };
export type RemoteSnapshot = {
  sharingMode?: 'group-equal' | 'per-expense';
  equalParticipantIds?: string[];
  tripId: string;
  expenseQuery?: string;
  actorUid: string;
  owner: boolean;
  writable: boolean;
  suspended: boolean;
  version: number;
  ledgerVersion: number;
  participantCount: number;
  expenseCount: number;
  pendingCount: number;
  total: number;
  balances: BalanceLine[];
  suggestions: Transfer[];
  suggestionsReady?: boolean;
  itineraryVersion?: number;
};
export type Demo = {
  trip: Trip;
  members: Member[];
  expenses: Expense[];
  settlements: Settlement[];
  plans: Plan[];
  ownerId?: string;
  viewerId?: string;
  ideas?: Idea[];
  invites?: InviteLink[];
  activity?: Activity[];
  remote?: RemoteSnapshot;
};

export const me = 'an';
export const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, '0')).join('');

export function splitEqually(amount: number, ids: string[]) {
  if (!ids.length) return {};
  ids = [...ids].sort();
  const base = Math.floor(amount / ids.length);
  const remainder = amount % ids.length;
  return Object.fromEntries(ids.map((id, index) => [id, base + Number(index < remainder)]));
}

const number = new Intl.NumberFormat('vi-VN');
export const money = (amount: number) => `${number.format(amount)}đ`;
export const dateLabel = (date: string) => date.split('-').reverse().join('/');
export const dateRange = (trip: Trip) => trip.start ? trip.start === trip.end ? dateLabel(trip.start) : `${dateLabel(trip.start)} – ${dateLabel(trip.end)}` : 'Chưa chọn ngày';
export const defaultTimezone = 'Asia/Ho_Chi_Minh';
export function today(timeZone = defaultTimezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts();
  const part = (type: string) => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export const viewerOf = (data: Demo) => data.viewerId ?? me;
export const ownerOf = (data: Demo) => data.ownerId ?? me;
export const isOwner = (data: Demo) => data.remote?.owner ?? (viewerOf(data) === ownerOf(data));
export const canWrite = (data: Demo) => data.remote?.writable ?? (!data.trip.closed && data.members.some(member => member.id === viewerOf(data) && !member.inactive));
export const canEditExpense = (data: Demo, expense: Expense) =>
  canWrite(data) && !expense.voided && (isOwner(data) || expense.createdBy === (data.remote?.actorUid ?? viewerOf(data)));
export const settlementStatus = (entry: Settlement) => entry.status ?? (entry.confirmed ? 'confirmed' : 'pending');
export const memberFor = (data: Demo, id: string) => data.members.find(member => member.id === id);
export const sharingMembers = (data: Demo) => data.members.filter(member => data.remote?.sharingMode === 'group-equal' ? data.remote.equalParticipantIds?.includes(member.id) : !member.inactive);
export function nameOf(data: Demo, id: string) {
  const member = memberFor(data, id) ?? data.members.find(item => item.uid === id);
  if (!member) return 'Thành viên';
  const duplicate = data.members.some(item => item.id !== member.id && item.name.toLocaleLowerCase('vi') === member.name.toLocaleLowerCase('vi'));
  return duplicate ? `${member.name} · ${member.id.slice(-4)}` : member.name;
}
export const netLabel = (net: number) => net > 0 ? 'Bạn được nhận' : net < 0 ? 'Bạn cần trả' : 'Đã cân bằng';
export const activeExpenses = (data: Demo) => data.expenses.filter(expense => !expense.voided);

export function record(data: Demo, title: string, detail: string, href?: string): Demo {
  const entry = { id: newId(), at: new Date().toISOString(), title, detail, actor: viewerOf(data), href };
  return { ...data, activity: [entry, ...(data.activity ?? [])] };
}

export function balances(data: Demo) {
  return financialSnapshot(data).net;
}

export function suggestions(data: Demo): Transfer[] {
  return validSuggestions(data);
}
