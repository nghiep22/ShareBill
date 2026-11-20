import type { Demo, Expense, Member, Plan, Receipt, Settlement, Transfer, Trip } from './model';

type ActivityFields = Pick<Plan, 'title' | 'day' | 'time' | 'place'> & { note: string };
export type ItineraryChange =
  | ({ action: 'add-activity'; suggestionId?: string } & ActivityFields)
  | ({ action: 'edit-activity'; id: string } & ActivityFields)
  | { action: 'remove-activity'; id: string }
  | { action: 'decline-suggestion'; id: string }
  | { action: 'suggest'; title: string };

export type TripCommand =
  | { type: 'save-expense'; expense: Expense; previous?: Expense }
  | { type: 'void-expense'; expense: Expense; reason: string }
  | { type: 'record-settlement'; transfer: Transfer; ledgerVersion?: number }
  | { type: 'settlement-status'; item: Settlement; status: 'confirmed' | 'cancelled' | 'void'; reason: string; ledgerVersion?: number }
  | { type: 'save-trip'; trip: Trip; version?: number }
  | { type: 'close-trip'; closed: boolean; version?: number }
  | { type: 'itinerary'; change: ItineraryChange; version?: number }
  | { type: 'save-member'; member: Member; previous?: Member };

export type UpdateTrip = (next: Demo, command?: TripCommand, onSaved?: (id?: string) => void) => void;

export type ReceiptActions = {
  upload: (file: File, progress: (status: string) => void) => Promise<Receipt>;
  discard: (receipt: Receipt) => Promise<void>;
  view: (id: string) => Promise<string>;
};
