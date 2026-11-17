import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/inter';
import './globals.css';

export const metadata: Metadata = {
  title: 'ShareBill · Chi tiêu chuyến đi',
  description: 'Theo dõi chi tiêu, chia tiền và quyết toán chuyến đi cùng bạn bè.',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icons/icon-192.png', apple: '/icons/apple-touch.png' },
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'ShareBill' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#f5f8fb',
};

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="vi"><body>{children}</body></html>;
}
