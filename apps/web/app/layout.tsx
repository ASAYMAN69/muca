import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Muca — Ops Copilot',
  description:
    'Muca: an agent that triages deployment and CI failures over the Model Context Protocol, and asks before it writes anything.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#1a1917' },
    { media: '(prefers-color-scheme: light)', color: '#faf9f7' },
  ],
};

/**
 * The theme bootstrap.
 *
 * Muca is dark by default. The light theme is opt-in, so it is applied
 * before the first paint from `?theme=light` or from the last choice the
 * user made. Running it here, before the body renders, keeps the swap from
 * flashing.
 */
const themeBootstrap = `(function(){try{var q=new URLSearchParams(location.search).get('theme');var t=(q==='light'||q==='dark')?q:localStorage.getItem('muca-theme');if(t==='light'){document.documentElement.setAttribute('data-theme','light');}else if(t==='dark'){document.documentElement.removeAttribute('data-theme');}}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <a
          href="#timeline"
          className="sr-only rounded-md bg-accent px-3 py-2 text-[13px] font-semibold text-surface focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50"
        >
          Skip to the timeline
        </a>
        {children}
      </body>
    </html>
  );
}
