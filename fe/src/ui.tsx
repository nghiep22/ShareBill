import { Building2, CarFront, ChevronLeft, CircleEllipsis, Compass, ShoppingBag, Ticket, Utensils, X, type LucideIcon } from 'lucide-react';
import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from 'react';
import { categories, type Category, type Member, money } from './model';

export const categoryIcons: Record<Category, LucideIcon> = {
  stay: Building2, food: Utensils, transport: CarFront, fun: Compass, tickets: Ticket, shopping: ShoppingBag, other: CircleEllipsis,
};

export function CategoryIcon({ category }: { category: Category }) {
  const Icon = categoryIcons[category];
  return <span className={`tile-icon category-${category}`}><Icon size={20} aria-hidden /></span>;
}

export function Avatar({ member }: { member?: Member }) {
  const [initial] = Array.from(member?.name ?? '');
  return <span className={`avatar tone-${(member?.tone ?? 0) % 5}`} aria-hidden>{initial?.toLocaleUpperCase('vi')}</span>;
}

export function PageTitle({ title, description, back, children }: {
  title: string; description?: string; back?: string; children?: ReactNode;
}) {
  return <div className="page-title">
    {back && <a className="icon-button back" href={back} aria-label="Quay lại"><ChevronLeft size={22} aria-hidden /></a>}
    <div><h1>{title}</h1>{description && <p>{description}</p>}</div>
    {children}
  </div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Amount({ value, signed = false }: { value: number; signed?: boolean }) {
  return <span className="amount">{signed && value > 0 ? '+' : ''}{money(value)}</span>;
}

export function CategorySelect({ value, onChange, remote }: { value: Category; onChange: (value: Category) => void; remote?: boolean }) {
  return <select name="category" aria-label="Danh mục" value={value} onChange={event => onChange(event.target.value as Category)}>
    {Object.entries(categories).filter(([id]) => !remote || id !== 'fun').map(([id, label]) => <option key={id} value={id}>{label}</option>)}
  </select>;
}

export const MutationFeedback = createContext<{ busy: boolean; offline?: boolean; error: string; recovery?: { label: string; href: string } }>({ busy: false, error: '' });

export function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const label = useId();
  const feedback = useContext(MutationFeedback);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} className={footer ? 'dialog-with-footer' : undefined} aria-labelledby={label} onCancel={event => { event.preventDefault(); if (!feedback.busy) onClose(); }}>
    <div className="dialog-header"><h2 id={label}>{title}</h2>
      <button type="button" className="icon-button" autoFocus disabled={feedback.busy} aria-label="Đóng" onClick={onClose}><X size={21} aria-hidden /></button>
    </div>
    {feedback.busy && <p role="status">Đang lưu…</p>}
    {feedback.offline && !feedback.busy && <p role="status">Cần kết nối mạng để gửi thao tác. Bạn có thể đóng cửa sổ này.</p>}
    {feedback.error && <p className="inline-note error" role="alert">{feedback.error}</p>}
    {feedback.recovery && <a className="secondary-button" href={feedback.recovery.href}>{feedback.recovery.label}</a>}
    <div className="dialog-content" inert={feedback.busy || feedback.offline || undefined}>{children}</div>
    {footer && <div className="dialog-footer" inert={feedback.busy || feedback.offline || undefined}>{footer}</div>}
  </dialog>;
}
