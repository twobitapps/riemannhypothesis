import localFont from 'next/font/local';
import 'katex/dist/katex.min.css';
import './globals.css';
import { ogImage } from '@/lib/og';

// EB Garamond (SIL Open Font License), latin subset, self-hosted.
const serif = localFont({
  src: [
    { path: './fonts/eb-garamond-latin.woff2', weight: '400 500', style: 'normal' },
    { path: './fonts/eb-garamond-italic-latin.woff2', weight: '400', style: 'italic' },
  ],
  variable: '--f-serif',
  display: 'swap',
});

// Caveat (SIL Open Font License), for pencilled margin notes only.
const hand = localFont({
  src: [{ path: './fonts/caveat.ttf', weight: '400 700', style: 'normal' }],
  variable: '--f-hand',
  display: 'swap',
});

const OG_TITLE = 'The Riemann Hypothesis';
const OG_DESC = 'An agentic swarm to check two proofs.';

export const metadata = {
  metadataBase: new URL('https://riemannhypothesis.vercel.app'),
  title: 'The Riemann Hypothesis',
  description: 'An agentic swarm to check two proofs.',
  robots: { index: true, follow: true },
  openGraph: { title: OG_TITLE, description: OG_DESC, url: '/', siteName: 'The Riemann Hypothesis', type: 'website', images: [ogImage] },
  twitter: { card: 'summary_large_image', title: OG_TITLE, description: OG_DESC, images: [ogImage] },
};

export const viewport = { themeColor: '#000000', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${serif.variable} ${hand.variable}`}>
      <body>{children}</body>
    </html>
  );
}
