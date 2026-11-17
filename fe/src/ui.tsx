import { Building2, CarFront, ChevronLeft, CircleEllipsis, Coffee, Compass, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { categories, type Category, type Member, money } from './model';

export const categoryIcons: Record<Category, LucideIcon> = {
  stay: Building2, food: Coffee, transport: CarFront, fun: Compass, other: CircleEllipsis,
};

export function CategoryIcon({ category }: { category: Category }) {
  const Icon = categoryIcons[category];
  return <span className={`tile-icon category-${category}`}><Icon size={20} aria-hidden /></span>;
}

export function Avatar({ member }: { member?: Member }) {
  return <span className={`avatar tone-${(member?.tone ?? 0) % 5}`} aria-hidden>{member?.name.charAt(0).toLocaleUpperCase('vi')}</span>;
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

export function CategorySelect({ defaultValue }: { defaultValue?: Category }) {
  return <select name="category" defaultValue={defaultValue ?? 'food'}>
    {Object.entries(categories).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
  </select>;
}
