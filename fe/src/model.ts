export const categories = {
  stay: 'Lưu trú',
  food: 'Ăn uống',
  transport: 'Di chuyển',
  fun: 'Vui chơi',
  other: 'Khác',
};

export type Category = keyof typeof categories;
export type Member = { id: string; name: string; tone: number };
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
};
export type Transfer = { from: string; to: string; amount: number };
export type Settlement = Transfer & { id: string; confirmed: boolean };
export type Plan = { id: string; day: string; time: string; title: string; place: string };
export type Trip = { name: string; place: string; start: string; end: string; closed: boolean };
export type Demo = { trip: Trip; members: Member[]; expenses: Expense[]; settlements: Settlement[]; plans: Plan[] };

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
  trip: { name: 'Đà Lạt 3N2Đ', place: 'Đà Lạt, Lâm Đồng', start: '2026-12-20', end: '2026-12-22', closed: false },
  members: [
    { id: me, name: 'An', tone: 0 },
    { id: 'binh', name: 'Bình', tone: 1 },
    { id: 'chi', name: 'Chi', tone: 2 },
  ],
  expenses: [
    { id: 'hotel', title: 'Khách sạn', amount: 900000, payer: me, date: '2026-12-20', category: 'stay', note: 'Hai đêm tại Đà Lạt', mode: 'equal', shares: splitEqually(900000, everyone) },
    { id: 'dinner', title: 'Ăn tối', amount: 180000, payer: 'binh', date: '2026-12-20', category: 'food', note: 'Lẩu gà lá é', mode: 'equal', shares: splitEqually(180000, everyone) },
    { id: 'scooter', title: 'Thuê xe máy', amount: 150000, payer: me, date: '2026-12-20', category: 'transport', note: 'Đã đổi phương tiện di chuyển.', mode: 'equal', shares: splitEqually(150000, everyone), voided: true },
  ],
  settlements: [],
  plans: [
    { id: 'arrival', day: '2026-12-20', time: '09:00', title: 'Đến Đà Lạt', place: 'Bến xe liên tỉnh Đà Lạt' },
    { id: 'check-in', day: '2026-12-20', time: '14:00', title: 'Nhận phòng và nghỉ ngơi', place: 'The Wilder-nest' },
    { id: 'market', day: '2026-12-20', time: '18:30', title: 'Ăn tối và dạo chợ đêm', place: 'Chợ Đà Lạt' },
    { id: 'cafe', day: '2026-12-21', time: '09:00', title: 'Cà phê và ngắm đồi thông', place: 'Trại Mát' },
  ],
};

const number = new Intl.NumberFormat('vi-VN');
export const money = (amount: number) => `${number.format(amount)}đ`;
export const moneyInput = (value: string) => /^\d+$/.test(value) ? number.format(Number(value)) : value;
export const dateLabel = (date: string) => date.split('-').reverse().join('/');
export const memberFor = (data: Demo, id: string) => data.members.find(member => member.id === id);
export const nameOf = (data: Demo, id: string) => memberFor(data, id)?.name ?? 'Thành viên';
export const netLabel = (net: number) => net > 0 ? 'Bạn được nhận' : net < 0 ? 'Bạn cần trả' : 'Đã cân bằng';
export const activeExpenses = (data: Demo) => data.expenses.filter(expense => !expense.voided);

export function balances(data: Demo, reservePending = false) {
  const totals: Record<string, number> = Object.fromEntries(data.members.map(({ id }) => [id, 0]));
  for (const expense of activeExpenses(data)) {
    totals[expense.payer] += expense.amount;
    for (const [id, share] of Object.entries(expense.shares)) totals[id] -= share;
  }
  for (const settlement of data.settlements) {
    if (settlement.confirmed) {
      totals[settlement.from] += settlement.amount;
      totals[settlement.to] -= settlement.amount;
    }
  }
  if (reservePending) {
    for (const settlement of data.settlements) {
      if (!settlement.confirmed && totals[settlement.from] <= -settlement.amount && totals[settlement.to] >= settlement.amount) {
        totals[settlement.from] += settlement.amount;
        totals[settlement.to] -= settlement.amount;
      }
    }
  }
  return totals;
}

export function suggestions(data: Demo): Transfer[] {
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
