import { Space_Grotesk, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const spaceGrotesk = Space_Grotesk({
  variable: '--font-space-grotesk',
  subsets: ['latin'],
});

const jetbrainsMono = JetBrains_Mono({
  variable: '--font-jetbrains-mono',
  subsets: ['latin'],
});

export const metadata = {
  title: 'SatelLocator',
  description: 'Live 3D tracker for every active satellite, with pass predictions for your location.',
};

export const viewport = {
  themeColor: '#02040a',
};

export default function RootLayout({ children }) {
  return (
    // Font variables live on <html> so :root tokens like --font-ui can reference them
    <html lang="en" className={`${spaceGrotesk.variable} ${jetbrainsMono.variable}`}>
      <body>
        {children}
      </body>
    </html>
  );
}
