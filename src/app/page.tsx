import React, { Suspense } from "react";
import { Providers } from "./providers";
import OmniVMDApp from "../OmniVMDApp";

export default function HomePage() {
  return (
    <Providers>
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between">
        <header className="border-b border-slate-900 px-6 py-4 flex items-center justify-between max-w-4xl mx-auto w-full">
          <div className="flex items-center space-x-2">
            <div className="h-3 w-3 rounded-full bg-emerald-500 animate-pulse" />
            <span className="font-mono text-sm font-bold tracking-wider text-slate-200">
              OMNIVM // PROTOCOL v1.0
            </span>
          </div>
          <span className="text-xs font-mono text-slate-500">
            LayerZero V2 Engine
          </span>
        </header>

        <main className="flex-1 flex items-center justify-center p-4">
          <Suspense
            fallback={
              <div className="text-center font-mono text-xs text-slate-500 animate-pulse">
                Loading OmniVM Console...
              </div>
            }
          >
            <OmniVMDApp />
          </Suspense>
        </main>

        <footer className="border-t border-slate-900 px-6 py-4 text-center text-xs font-mono text-slate-600 max-w-4xl mx-auto w-full">
          OmniVM Protocol &copy; 2026 — Decentralized Intent & Transactional Infrastructure
        </footer>
      </div>
    </Providers>
  );
}
