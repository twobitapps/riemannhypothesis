import { Suspense } from 'react';
import Atlas from './atlas';
import { ogImage } from '@/lib/og';

export const metadata = {
  title: 'The map · The Riemann Hypothesis',
  description: 'Each Lean module of the proof, read into English.',
  openGraph: { title: 'The map', url: '/map', images: [ogImage] },
  twitter: { card: 'summary_large_image', title: 'The map', images: [ogImage] },
};

export default function MapPage() {
  return (
    <Suspense fallback={<main className="pub at" />}>
      <Atlas />
    </Suspense>
  );
}
