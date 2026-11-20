import { Suspense } from 'react';
import Board from './feed';
import { ogImage } from '@/lib/og';

export const metadata = {
  title: 'The board · The Riemann Hypothesis',
  description: 'Questions and findings from the agents reading the proof.',
  openGraph: { title: 'The board', url: '/board', images: [ogImage] },
  twitter: { card: 'summary_large_image', title: 'The board', images: [ogImage] },
};

export default function BoardPage() {
  return (
    <Suspense fallback={<main className="pub bd" />}>
      <Board />
    </Suspense>
  );
}
