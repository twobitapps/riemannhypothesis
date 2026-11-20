import Wall from './wall';
import { ogImage } from '@/lib/og';

export const metadata = {
  title: 'riemann-swarm · watch',
  openGraph: { title: 'The Riemann Hypothesis', url: '/swarm', images: [ogImage] },
  twitter: { card: 'summary_large_image', title: 'The Riemann Hypothesis', images: [ogImage] },
};
export const dynamic = 'force-dynamic';

export default function SwarmPage() {
  return <Wall />;
}
