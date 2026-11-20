import type { Metadata } from 'next';
import { AdminWorkspace } from '../../admin-workspace';

export const metadata: Metadata = { title: 'ShareBill · Quản trị', robots: { index: false, follow: false } };

export default function Page() {
  return <AdminWorkspace />;
}
