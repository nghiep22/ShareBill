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
const everyone = ['an', 'binh', 'chi'];
export const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, '0')).join('');

export function splitEqually(amount: number, ids: string[]) {
  if (!ids.length) return {};
  const base = Math.floor(amount / ids.length);
  const remainder = amount % ids.length;
  return Object.fromEntries(ids.map((id, index) => [id, base + Number(index < remainder)]));
}

export const initialDemo: Demo = {
  trip: { name: 'Đà Lạt 3N2Đ', place: 'Đà Lạt, Lâm Đồng', start: '2026-12-20', end: '2026-12-22', closed: false, cover: true },
  members: [
    { id: me, name: 'An', tone: 0, linked: true },
    { id: 'binh', name: 'Bình', tone: 1, linked: true },
    { id: 'chi', name: 'Chi', tone: 2 },
  ],
  expenses: [
    { id: 'hotel', title: 'Khách sạn', amount: 900000, payer: me, date: '2026-12-20', category: 'stay', note: 'Hai đêm tại Đà Lạt', mode: 'equal', shares: splitEqually(900000, everyone), createdBy: me },
    { id: 'dinner', title: 'Ăn tối', amount: 180000, payer: 'binh', date: '2026-12-20', category: 'food', note: 'Lẩu gà lá é', mode: 'equal', shares: splitEqually(180000, everyone), createdBy: 'binh' },
    { id: 'scooter', title: 'Thuê xe máy', amount: 150000, payer: me, date: '2026-12-20', category: 'transport', note: 'Đã đổi phương tiện di chuyển.', mode: 'equal', shares: splitEqually(150000, everyone), voided: true, createdBy: me },
  ],
  settlements: [],
  plans: [
    { id: 'arrival', day: '2026-12-20', time: '09:00', title: 'Đến Đà Lạt', place: 'Bến xe liên tỉnh Đà Lạt', note: 'Tập trung ở cổng chính để đón xe về homestay.' },
    { id: 'check-in', day: '2026-12-20', time: '14:00', title: 'Nhận phòng và nghỉ ngơi', place: 'The Wilder-nest' },
    { id: 'market', day: '2026-12-20', time: '18:30', title: 'Ăn tối và dạo chợ đêm', place: 'Chợ Đà Lạt' },
    { id: 'cafe', day: '2026-12-21', time: '09:00', title: 'Cà phê và ngắm đồi thông', place: 'Trại Mát' },
  ],
  ideas: [{ id: 'garden', title: 'Ghé vườn hoa Cẩm Tú Cầu', by: 'binh' }],
  activity: [
    { id: 'activity-dinner', at: '2026-11-16T10:20:00+07:00', title: 'Thêm khoản chi', detail: 'Ăn tối · 180.000đ', actor: 'binh', href: '#khoan-chi/dinner' },
    { id: 'activity-hotel', at: '2026-11-16T09:00:00+07:00', title: 'Thêm khoản chi', detail: 'Khách sạn · 900.000đ', actor: me, href: '#khoan-chi/hotel' },
  ],
};

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

export function balances(data: Demo, reservePending = false) {
  if (data.remote) return Object.fromEntries(data.remote.balances.map(item => [item.participantId, item.netMinor]));
  const totals: Record<string, number> = Object.fromEntries(data.members.map(({ id }) => [id, 0]));
  for (const expense of activeExpenses(data)) {
    totals[expense.payer] += expense.amount;
    for (const [id, share] of Object.entries(expense.shares)) totals[id] -= share;
  }
  for (const settlement of data.settlements) {
    if (settlementStatus(settlement) === 'confirmed') {
      totals[settlement.from] += settlement.amount;
      totals[settlement.to] -= settlement.amount;
    }
  }
  if (reservePending) {
    for (const settlement of data.settlements) {
      if (settlementStatus(settlement) === 'pending' && totals[settlement.from] <= -settlement.amount && totals[settlement.to] >= settlement.amount) {
        totals[settlement.from] += settlement.amount;
        totals[settlement.to] -= settlement.amount;
      }
    }
  }
  return totals;
}

export function suggestions(data: Demo): Transfer[] {
  if (data.remote) return data.remote.suggestions;
  const entries = Object.entries(balances(data, true));
  const debtors = entries.filter(([, total]) => total < 0).map(([id, total]) => ({ id, left: -total }));
  const creditors = entries.filter(([, total]) => total > 0).map(([id, total]) => ({ id, left: total }));
  const transfers: Transfer[] = [];
  for (const debtor of debtors) {
    for (const creditor of creditors) {
      const amount = Math.min(debtor.left, creditor.left);
      if (amount > 0) {
        transfers.push({ from: debtor.id, to: creditor.id, amount });
        debtor.left -= amount;
        creditor.left -= amount;
      }
    }
  }
  return transfers;
}
