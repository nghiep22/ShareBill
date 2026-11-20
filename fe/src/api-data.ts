import { ApiError, operationId, type ShareBillApi } from './api-client';
import { categories, money, today, type Activity, type BalanceLine, type Category, type Demo, type Expense, type Plan, type Receipt, type Settlement, type Trip } from './model';
import type { ReceiptActions, TripCommand } from './trip-command';
import { tripRoute } from './workspace-route';

export type TripDto = {
  id: string; name: string; destination: string | null; note: string | null;
  startDate: string | null; endDate: string | null; status: 'active' | 'archived';
  ownerUid: string; moderationStatus: string; version: number; ledgerVersion: number; timezone?: string;
  participantCount: number; activeExpenseCount: number; totalExpenseMinor: number; pendingSettlementCount: number;
  myParticipantId?: string | null;
  sharingMode?: 'group-equal' | 'per-expense'; equalParticipantIds?: string[];
};
type ParticipantDto = { id: string; displayName: string; status: 'active' | 'inactive'; linkedUid: string | null; version: number; paymentQrReceiptId?: string | null };
export type Membership = {
  uid: string; displayName?: string | null; role: 'owner' | 'member'; status: 'active' | 'removed';
  participantId: string | null; version: number; joinedAt: string;
};
export type Memberships = { memberships: Membership[]; participants: ParticipantDto[] };
export type TripOverview = { trip: TripDto; participants: ParticipantDto[]; balances: BalanceLine[]; revision?: number };
export type TransferDto = { fromParticipantId: string; toParticipantId: string; amountMinor: number };
export type ExpenseDto = {
  id: string; title: string; amountMinor: number; payerParticipantId: string; occurredOn: string;
  category: Category; status: 'active' | 'void'; version: number; note: string | null;
  voidReason: string | null; createdBy: string; updatedBy: string; splitMethod: 'equal' | 'exact';
  shares: { participantId: string; amountMinor: number }[]; receiptIds?: string[];
};
export type SettlementDto = TransferDto & {
  id: string; status: 'pending' | 'confirmed' | 'cancelled' | 'void'; version: number; occurredOn: string;
  createdBy: string; confirmedBy: string | null; voidReason?: string | null;
  confirmationMode?: 'recipient' | 'owner_on_behalf' | null; confirmedAt?: string | null;
  receiptIds?: string[];
};
export type InviteDto = {
  id: string; version: number; maxUses: number; usedCount: number; expiresAt: string;
  status: 'active' | 'revoked' | 'invalidated' | 'exhausted' | 'expired';
  token?: string; message?: string;
};
export type InvitePreview = { trip: { id: string; name: string; sharingMode?: 'group-equal' | 'per-expense' | null }; inviter: { displayName: string | null }; expiresAt: string; alreadyMember?: boolean };
export type ItineraryDto = {
  version: number;
  activities: (Omit<Plan, 'suggestionId'> & { suggestionId: string | null })[];
  suggestions: { id: string; title: string; author: string | null; status: 'pending' | 'scheduled' | 'declined' }[];
};
export type ActivityDto = {
  eventId: string; action: string; actorUid: string | null; actorDisplayNameSnapshot: string | null;
  entityType: string | null; entityId: string | null; reason: string | null; createdAt: string | null;
  amountBeforeMinor?: number | null; amountAfterMinor?: number | null;
};

export function tripSnapshot(overview: TripOverview, uid: string): Demo {
  const { trip, participants, balances } = overview;
  const members = participants.map((item, tone) => ({
    id: item.id, name: item.displayName, tone, inactive: item.status === 'inactive',
    linked: Boolean(item.linkedUid), uid: item.linkedUid ?? undefined, version: item.version,
    paymentQrReceiptId: item.paymentQrReceiptId,
  }));
  return {
    trip: { name: trip.name, place: trip.destination ?? '', note: trip.note ?? '', start: trip.startDate ?? '', end: trip.endDate ?? '', timezone: trip.timezone,
      closed: trip.status === 'archived' },
    viewerId: members.find(item => item.uid === uid)?.id ?? trip.myParticipantId ?? '',
    ownerId: members.find(item => item.uid === trip.ownerUid)?.id,
    members, expenses: [], settlements: [], plans: [],
    remote: {
      tripId: trip.id, actorUid: uid, owner: trip.ownerUid === uid,
      suspended: trip.moderationStatus === 'suspended', writable: trip.status === 'active' && trip.moderationStatus === 'normal',
      version: trip.version, ledgerVersion: trip.ledgerVersion, participantCount: trip.participantCount,
      expenseCount: trip.activeExpenseCount, pendingCount: trip.pendingSettlementCount, total: trip.totalExpenseMinor,
      balances, suggestions: [],
      sharingMode: trip.sharingMode, equalParticipantIds: trip.equalParticipantIds,
    },
  };
}

export const expenseFrom = (item: ExpenseDto): Expense => ({
  id: item.id, title: item.title, amount: item.amountMinor, payer: item.payerParticipantId, date: item.occurredOn,
  category: Object.hasOwn(categories, item.category) ? item.category : 'other',
  note: item.note ?? '', shares: Object.fromEntries(item.shares.map(share => [share.participantId, share.amountMinor])),
  mode: item.splitMethod, voided: item.status === 'void', voidReason: item.voidReason ?? undefined, version: item.version,
  receipts: item.receiptIds?.map((id, index) => ({ id, name: 'Hóa đơn ' + (index + 1) })), createdBy: item.createdBy,
  editedBy: item.version > 1 ? item.updatedBy : undefined,
});

export const transferFrom = (item: TransferDto) => ({ from: item.fromParticipantId, to: item.toParticipantId, amount: item.amountMinor });
export const settlementFrom = (item: SettlementDto): Settlement => ({
  ...transferFrom(item), id: item.id, status: item.status, confirmed: item.status === 'confirmed',
  date: item.occurredOn, version: item.version, recordedBy: item.createdBy, confirmedBy: item.confirmedBy ?? undefined,
  reason: item.voidReason ?? undefined,
  confirmationMode: item.confirmationMode ?? undefined, confirmedAt: item.confirmedAt ?? undefined,
  receipts: item.receiptIds?.map((id, index) => ({ id, name: 'Ảnh chuyển khoản ' + (index + 1) })),
});

const activityLabels: Record<string, string> = {
  'trip.created': 'Tạo chuyến đi', 'trip.updated': 'Cập nhật chuyến đi', 'trip.archived': 'Chốt chuyến đi', 'trip.reopened': 'Mở lại chuyến đi',
  'trip.sharing_equal': 'Chia đều tổng chi cho nhóm',
  'participant.created': 'Thêm người chia tiền', 'participant.updated': 'Cập nhật người chia tiền',
  'expense.created': 'Thêm khoản chi', 'expense.updated': 'Sửa khoản chi', 'expense.voided': 'Hủy khoản chi',
  'settlement.created': 'Ghi nhận chuyển tiền', 'settlement.confirmed': 'Xác nhận chuyển tiền',
  'settlement.cancelled': 'Hủy khoản chuyển', 'settlement.voided': 'Hủy hiệu lực khoản chuyển',
  'invite.created': 'Tạo lời mời', 'invite.revoked': 'Thu hồi lời mời',
  'membership.joined': 'Tham gia chuyến đi', 'participant.linked': 'Liên kết tài khoản', 'participant.unlinked': 'Bỏ liên kết tài khoản',
  'membership.removed': 'Gỡ quyền truy cập', 'membership.restored': 'Khôi phục quyền truy cập',
  'trip.owner_transferred': 'Chuyển quyền chủ chuyến',
  'receipt.ready': 'Chuẩn bị ảnh hóa đơn', 'receipt.attached': 'Đính kèm ảnh hóa đơn', 'receipt.discarded': 'Bỏ ảnh hóa đơn',
  'itinerary.activity_added': 'Thêm hoạt động vào lịch trình', 'itinerary.activity_updated': 'Sửa lịch trình',
  'itinerary.activity_removed': 'Xóa hoạt động khỏi lịch trình', 'itinerary.suggestion_created': 'Đề xuất điểm đến',
  'itinerary.suggestion_declined': 'Từ chối đề xuất',
};

export function activityFrom(item: ActivityDto, tripId: string): Activity[] {
  if (!item.createdAt) return [];
  const before = item.amountBeforeMinor, after = item.amountAfterMinor;
  const amount = before != null && after != null && before !== after ? money(before) + ' → ' + money(after)
    : after != null ? money(after) : before != null ? money(before) : '';
  return [{
    id: item.eventId, at: item.createdAt, title: activityLabels[item.action] ?? 'Cập nhật chuyến đi',
    actor: item.actorUid ?? '', actorName: item.actorDisplayNameSnapshot ?? undefined, detail: [amount, item.reason].filter(Boolean).join(' · '),
    href: item.entityType === 'expense' && item.entityId ? '#' + tripRoute(tripId, 'khoan-chi', item.entityId)
      : item.entityType === 'itinerary' ? '#' + tripRoute(tripId, 'lich-trinh') : undefined,
  }];
}

export const tripBody = (trip: Trip) => ({
  name: trip.name, destination: trip.place || null, note: trip.note || null,
  startDate: trip.start || null, endDate: trip.end || null,
  ...(trip.timezone && { timezone: trip.timezone }),
});

function expenseBody(expense: Expense, previous?: Expense) {
  const items = Object.entries(expense.shares).sort(([a], [b]) => a.localeCompare(b));
  const financial = {
    amountMinor: expense.amount, payerParticipantId: expense.payer, splitMethod: expense.mode,
    split: expense.mode === 'equal' ? { participantIds: items.map(([id]) => id) } :
      { shares: items.map(([participantId, amountMinor]) => ({ participantId, amountMinor })) },
  };
  const financialChanged = !previous || expense.amount !== previous.amount || expense.payer !== previous.payer ||
    expense.mode !== previous.mode || items.length !== Object.keys(previous.shares).length ||
    items.some(([id, share]) => previous.shares[id] !== share);
  const receiptIds = expense.receipts?.map(receipt => receipt.id) ?? [];
  const oldReceiptIds = previous?.receipts?.map(receipt => receipt.id) ?? [];
  return {
    ...(!previous || expense.title !== previous.title ? { title: expense.title } : {}),
    ...(!previous || expense.note !== previous.note ? { note: expense.note || null } : {}),
    ...(!previous || expense.date !== previous.date ? { occurredOn: expense.date } : {}),
    ...(!previous || expense.category !== previous.category ? { category: expense.category } : {}),
    ...(!previous || receiptIds.length !== oldReceiptIds.length || receiptIds.some((id, index) => id !== oldReceiptIds[index]) ? { receiptIds } : {}),
    ...(financialChanged && financial),
  };
}

export async function sendTripCommand(api: ShareBillApi, tripId: string, data: Demo, action: TripCommand) {
  const path = '/trips/' + tripId;
  const remote = data.remote!;
  switch (action.type) {
    case 'save-expense': {
      const { expense, previous } = action;
      const body = expenseBody(expense, previous);
      if (previous && !Object.keys(body).length) return { id: previous.id };
      return api.write<{ id: string }>(path + '/expenses' + (previous ? '/' + previous.id : ''), body,
        previous ? { method: 'PATCH', version: previous.version } : undefined);
    }
    case 'void-expense':
      return api.write<{ id: string }>(path + '/expenses/' + action.expense.id + '/void', { reason: action.reason }, { version: action.expense.version });
    case 'record-settlement':
      return api.write<{ id: string }>(path + '/settlements', {
        fromParticipantId: action.transfer.from, toParticipantId: action.transfer.to, amountMinor: action.transfer.amount,
        occurredOn: today(data.trip.timezone), note: null, basedOnLedgerVersion: action.ledgerVersion ?? remote.ledgerVersion,
        receiptIds: action.receipts?.map(receipt => receipt.id) ?? [],
      });
    case 'save-payment-qr':
      return api.write<{ id: string }>(path + '/participants/' + action.member.id + '/payment-qr',
        { receiptId: action.receipt?.id ?? null }, { method: 'PATCH', version: action.member.version });
    case 'settlement-status': {
      const name = { confirmed: 'confirm', cancelled: 'cancel', void: 'void' }[action.status];
      const body = action.status === 'confirmed' ? { basedOnLedgerVersion: action.ledgerVersion ?? remote.ledgerVersion } :
        action.status === 'void' ? { reason: action.reason } : {};
      return api.write<{ id: string }>(path + '/settlements/' + action.item.id + '/' + name, body, { version: action.item.version });
    }
    case 'save-trip':
      return api.write<{ id: string }>(path, tripBody(action.trip), { method: 'PATCH', version: action.version ?? remote.version });
    case 'close-trip':
      return api.write<{ id: string }>(path + (action.closed ? '/archive' : '/reopen'), {}, { version: action.version ?? remote.version });
    case 'itinerary':
      return api.write<{ id: string }>(path + '/itinerary', action.change, { version: action.version ?? remote.itineraryVersion });
    case 'save-member':
      return action.previous
        ? api.write<{ id: string }>(path + '/participants/' + action.previous.id,
          { displayName: action.member.name, status: action.member.inactive ? 'inactive' : 'active' },
          { method: 'PATCH', version: action.previous.version })
        : api.write<{ id: string }>(path + '/participants', { displayName: action.member.name });
  }
}

type Intent = { id: string; version: number; expiresAt: string; upload: { url: string; fields: Record<string, string>; method?: 'PUT'; headers?: Record<string, string> } };
type UploadAttempt = { intentKey: string; finalizeKey: string; intent?: Intent; uploaded: boolean };

export function receiptActions(api: ShareBillApi, tripId: string): ReceiptActions {
  const attempts = new WeakMap<File, UploadAttempt>();
  const path = '/trips/' + tripId + '/receipts';
  return {
    async upload(file, progress) {
      let attempt = attempts.get(file);
      if (!attempt || (!attempt.uploaded && attempt.intent && Date.parse(attempt.intent.expiresAt) <= Date.now())) {
        attempt = { intentKey: operationId(), finalizeKey: operationId(), uploaded: false };
        attempts.set(file, attempt);
      }
      try {
        if (!attempt.uploaded) {
          progress('Đang xin quyền tải ảnh…');
          const intent = await api.write<Intent>(path + '/upload-intents', { contentType: file.type, bytes: file.size }, { key: attempt.intentKey });
          attempt.intent = intent;
          progress('Đang tải ảnh…');
          const form = new FormData();
          for (const [name, value] of Object.entries(intent.upload.fields)) form.append(name, value);
          form.append('file', file);
          let uploaded;
          try {
            uploaded = await fetch(intent.upload.url, { method: intent.upload.method ?? 'POST',
              body: intent.upload.method === 'PUT' ? file : form, headers: intent.upload.headers,
              credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(60_000) });
          } catch {
            throw new Error('Tải ảnh bị gián đoạn. Hãy thử lại.');
          }
          if (!uploaded.ok) throw new Error('Kho lưu trữ chưa nhận ảnh. Hãy thử lại.');
          attempt.uploaded = true;
        }
        const intent = attempt.intent!;
        progress('Máy chủ đang kiểm tra ảnh…');
        const ready = await api.write<Receipt>(path + '/' + intent.id + '/finalize', {}, { key: attempt.finalizeKey, version: intent.version });
        attempts.delete(file);
        return { id: ready.id, name: file.name, version: ready.version };
      } catch (cause) {
        if (cause instanceof ApiError && ['INVALID_RECEIPT_IMAGE', 'UPLOAD_INTENT_EXPIRED', 'RECEIPT_NOT_FINALIZABLE'].includes(cause.code ?? '')) attempts.delete(file);
        throw cause;
      }
    },
    async discard(receipt) {
      await api.write(path + '/' + receipt.id + '/discard', {}, { version: receipt.version });
    },
    async view(id) {
      return (await api.read<{ url: string }>(path + '/' + id + '/view-url')).url;
    },
  };
}
