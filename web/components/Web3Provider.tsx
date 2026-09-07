"use client";

import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, darkTheme, getDefaultConfig } from "@rainbow-me/rainbowkit";
import { WagmiProvider } from "wagmi";
import { bsc } from "wagmi/chains";

import "@rainbow-me/rainbowkit/styles.css";

/**
 * PLACEHOLDER. Replace with a real WalletConnect Cloud project id via
 * `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` in `web/.env.local` (gitignored).
 * Injected wallets (MetaMask, Rabby, ...) still connect without it; the
 * WalletConnect QR flow does not.
 */
const PLACEHOLDER_PROJECT_ID = "REPLACE_ME_WALLETCONNECT_PROJECT_ID";

const config = getDefaultConfig({
  appName: "4lpha Agent Marketplace",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || PLACEHOLDER_PROJECT_ID,
  chains: [bsc],
  ssr: true,
});

export function Web3Provider({ children }: { children: React.ReactNode }) {
  // One client per browser session; never recreated on re-render.
  const [queryClient] = React.useState(() => new QueryClient());

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: "var(--brand)",
            borderRadius: "small",
            overlayBlur: "small",
          })}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
