import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OmniVM Protocol - Omnichain Execution Console",
  description:
    "LayerZero V2 Omnichain Execution Environment with EIP-1153 and EIP-712 Relayer",
  metadataBase: new URL("https://github.com/Tonto417/omnivm-protocol"),
  openGraph: {
    title: "OmniVM Protocol",
    description: "High-performance decentralized transactional infrastructure engine.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#020617",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark h-full">
      <body className="bg-slate-950 text-slate-100 min-h-screen font-mono antialiased selection:bg-emerald-500 selection:text-slate-950">
        {children}
      </body>
    </html>
  );
}
