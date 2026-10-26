import type { Metadata } from "import 'tailwindcss/tailwind.css'"; // or standard global import if using globals.css
import "./globals.css";

export const metadata: Metadata = {
  title: "OmniVM Protocol - Omnichain Execution Console",
  description: "LayerZero V2 Omnichain Execution Environment with EIP-1153 and EIP-712 Relayer",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-950 text-slate-100 min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
	

