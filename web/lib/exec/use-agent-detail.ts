"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOwnerActions } from "./use-owner-actions";
import { encodeReadHeader } from "./owner-action";
import { forgetReadExpiry, readSessionStorage, rememberReadExpiry, storedReadExpiryMs, subscribeReadExpiry } from "./read-session-window";
import { REVIEWED_MAJORS_56, WBNB_56 } from "./pairs";
import { parseTradeViewEnvelope, type TradeView } from "../trade";
import {
  mapAgentDetail,
  type LiveTick,
  ohlcvLimit,
  ohlcvRequestPath,
  priceInQuote,
  quoteKlinesPath,
  reduceOhlcv,
  reduceQuoteKlines,
  type AgentDetailView,
  type ChartCandle,
  type ChartInterval,
  type OhlcvResult,
} from "./agent-detail";

/** USD is the feed's own unit; "quote" prices the base in this grid's quote asset. */
export type ChartUnit = "usd" | "quote";

export type AgentDetailPollState =
  | "signed-out"
  | "loading"
  | "ready"
  | "auth-expired"
  | "rate-limited"
  | "execution-unavailable"
  | "invalid-response";

export type UseAgentDetailResult = {
  readonly state: AgentDetailPollState;
  readonly view: AgentDetailView | null;
  readonly market: OhlcvResult | null;
  /** Candles for the chart's own timeframe/unit; null means "use market.candles". */
  readonly chartCandles: readonly ChartCandle[] | null;
  readonly chartBanner: string | null;
  readonly chartInterval: ChartInterval;
  readonly chartUnit: ChartUnit;
  readonly setChartInterval: (interval: ChartInterval) => void;
  readonly setChartUnit: (unit: ChartUnit) => void;
  readonly trade: TradeView | null;
  readonly asOfMs: number | null;
  readonly message: string;
  /** Why the chart has no data, when it has none. Null while it is fine. */
  readonly marketReason: string | null;
  /** Empty for HttpOnly bearer mode; carries only the signed-read fallback. */
  readonly readHeaders: Readonly<Record<string, string>>;
  readonly signIn: () => Promise<void>;
  /** Re-reads the owner view and resolves with it, so a serial workflow can decide its next step on fresh data. */
  readonly refresh: () => Promise<AgentDetailView | null>;
  /** Re-reads the trading projection immediately for a drain/remove workflow. */
  readonly refreshTrade: () => Promise<TradeView | null>;
};

export function pollStateForStatus(status: number): AgentDetailPollState {
  if (status === 401) return "auth-expired";
  if (status === 429) return "rate-limited";
  if (status === 502) return "execution-unavailable";
  return status >= 200 && status < 300 ? "ready" : "invalid-response";
}

export function mayPoll(nowMs: number, expiryMs: number): boolean {
  return Number.isSafeInteger(nowMs) && Number.isSafeInteger(expiryMs)
    && nowMs >= 0 && expiryMs - nowMs > 5_000;
}

function stateMessage(state: AgentDetailPollState): string {
  if (state === "signed-out") return "Sign in to load this agent.";
  if (state === "loading") return "Loading the latest owner view…";
  if (state === "auth-expired") return "Your read session expired. Sign in again to refresh.";
  if (state === "rate-limited") return "Refresh is rate-limited. The last verified view remains below.";
  if (state === "execution-unavailable") return "The execution plane is unreachable. The last verified view remains below.";
  if (state === "invalid-response") return "The execution plane returned a response this page could not map.";
  return "";
}

type AuthWindow = { readonly expiryMs: number; readonly signedHeader?: string };

/**
 * Two-cadence polling for the exact agent id. Authentication is deliberately
 * exposed as `signIn`: no effect calls it, so a render/timer can never open a
 * passkey ceremony. The bearer itself remains in an HttpOnly cookie.
 */
function detailPool(view: AgentDetailView | null): string | null {
  if (view === null) return null;
  return view.hireSizingName === "lp-v1"
    ? view.lp?.pool?.poolAddress ?? null
    : view.grid.pool;
}

function detailBaseAddress(view: AgentDetailView | null): string | null {
  if (view === null) return null;
  return view.hireSizingName === "lp-v1"
    ? view.lp?.pool?.baseAddress ?? null
    : view.grid.baseAddress;
}

function detailQuoteAddress(view: AgentDetailView | null): string | null {
  if (view === null) return null;
  return view.hireSizingName === "lp-v1"
    ? view.lp?.pool?.quoteAddress ?? null
    : view.grid.quoteAddress;
}

function detailBaseSymbol(view: AgentDetailView | null): string | null {
  if (view === null) return null;
  return view.hireSizingName === "lp-v1"
    ? view.lp?.pool?.base ?? null
    : view.grid.base;
}

function detailQuoteSymbol(view: AgentDetailView | null): string | null {
  if (view === null) return null;
  return view.hireSizingName === "lp-v1"
    ? view.lp?.pool?.quote ?? null
    : view.grid.quote;
}

function detailTokens(view: AgentDetailView | null): readonly string[] {
  if (view === null) return [];
  if (view.hireSizingName === "lp-v1") {
    const pool = view.lp?.pool;
    return pool === null || pool === undefined ? [] : [pool.token0, pool.token1];
  }
  return [view.grid.token0, view.grid.token1].filter((token) => token.length > 0);
}

export function useAgentDetail(agentId: string): UseAgentDetailResult {
  const { signEnvelope } = useOwnerActions();
  const [auth, setAuth] = useState<AuthWindow | null>(null);
  const [state, setState] = useState<AgentDetailPollState>("signed-out");
  const [view, setView] = useState<AgentDetailView | null>(null);
  const [market, setMarket] = useState<OhlcvResult | null>(null);
  const [marketReason, setMarketReason] = useState<string | null>(null);
  // The chart's own timeframe and unit. The metric tiles stay on the 1m series
  // they were audited against, so changing the chart never moves HODL or the
  // freshness the owner view is judged on.
  const [chartInterval, setChartInterval] = useState<ChartInterval>("1m");
  const [chartUnit, setChartUnit] = useState<ChartUnit>("usd");
  const [chartCandles, setChartCandles] = useState<readonly ChartCandle[] | null>(null);
  const [chartBanner, setChartBanner] = useState<string | null>(null);
  const chartAbortRef = useRef<AbortController | null>(null);
  const [trade, setTrade] = useState<TradeView | null>(null);
  const [asOfMs, setAsOfMs] = useState<number | null>(null);
  const [mapperError, setMapperError] = useState<string | null>(null);
  const viewRef = useRef<AgentDetailView | null>(null);
  const ownerPayload = useRef<unknown>(undefined);
  const lpPayload = useRef<unknown>(undefined);
  const tokenPayload = useRef<unknown>(undefined);
  // Symbols and DECIMALS for legs the majors table does not cover, keyed by
  // lowercase address. Decimals are immutable, so one fetch per token per
  // session is enough; without them the mapper dashes every price rather than
  // scaling a tick by a guessed 18.
  const tokenMeta = useRef<Record<string, { symbol: string; decimals: number }>>({});
  const abortRef = useRef<AbortController | null>(null);
  const marketAbortRef = useRef<AbortController | null>(null);

  // The page's OWN tick, from `/api/pool-state` (the plane's direct-RPC reader,
  // no owner signature), polled every 10 s once the pool is known. The worker's
  // observation only exists after its first finalized cycle, so without this
  // an armed grid shows dashes for minutes. See `mapAgentDetail`'s `liveTick`.
  const liveTick = useRef<LiveTick | null>(null);
  const liveTickAbortRef = useRef<AbortController | null>(null);

  const publishView = useCallback((nowMs: number) => {
    if (ownerPayload.current === undefined || lpPayload.current === undefined) return;
    const mapped = mapAgentDetail(ownerPayload.current, lpPayload.current, nowMs, tokenPayload.current, tokenMeta.current, liveTick.current);
    viewRef.current = mapped;
    setView(mapped);
    setAsOfMs(nowMs);
  }, []);

  const pollLiveTick = useCallback(async (): Promise<void> => {
    const pool = detailPool(viewRef.current);
    if (pool === null || pool === undefined) return;
    liveTickAbortRef.current?.abort();
    const controller = new AbortController();
    liveTickAbortRef.current = controller;
    try {
      const response = await fetch(`/api/pool-state?address=${pool.toLowerCase()}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) return;
      const body = await response.json() as { data?: { currentTick?: unknown; blockNumber?: unknown } };
      const tick = body.data?.currentTick;
      const blockNumber = body.data?.blockNumber;
      if (typeof tick !== "number" || !Number.isSafeInteger(tick) || typeof blockNumber !== "string") return;
      if (controller.signal.aborted || liveTickAbortRef.current !== controller || detailPool(viewRef.current)?.toLowerCase() !== pool.toLowerCase()) return;
      liveTick.current = { tick, blockNumber, readAtMs: Date.now(), poolAddress: pool.toLowerCase() };
      publishView(Date.now());
    } catch {
      // An unreadable live tick changes nothing: the worker's record stands.
    }
  }, [publishView]);

  const requestHeaders = useCallback((window: AuthWindow): HeadersInit =>
    window.signedHeader === undefined ? {} : { "x-owner-action": window.signedHeader }, []);

  const pollOwner = useCallback(async (window: AuthWindow): Promise<void> => {
    const nowMs = Date.now();
    if (!mayPoll(nowMs, window.expiryMs)) {
      setState("auth-expired");
      setAuth(null);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const deadline = setTimeout(() => {
      if (abortRef.current !== controller) return;
      controller.abort();
      setState("execution-unavailable");
    }, 35_000);
    try {
      const headers = requestHeaders(window);
      const [ownerResponse, lpResponse] = await Promise.all([
        fetch(`/api/agents/${encodeURIComponent(agentId)}`, { headers, cache: "no-store", signal: controller.signal }),
        fetch(`/api/agents/${encodeURIComponent(agentId)}/lp`, { headers, cache: "no-store", signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      const failed = [ownerResponse, lpResponse].find((response) => !response.ok);
      if (failed !== undefined) {
        const next = pollStateForStatus(failed.status);
        setState(next);
        if (next === "auth-expired") {
          setAuth(null);
          forgetReadExpiry(readSessionStorage());
        }
        return;
      }
      ownerPayload.current = await ownerResponse.json() as unknown;
      lpPayload.current = await lpResponse.json() as unknown;
      const ownerData = typeof ownerPayload.current === "object" && ownerPayload.current !== null
        ? (ownerPayload.current as { readonly data?: { readonly hireSizing?: { readonly name?: unknown } } }).data : undefined;
      if (ownerData?.hireSizing?.name === "trade-v1") {
        const tradeResponse = await fetch(`/api/agents/${encodeURIComponent(agentId)}/trade/view`, { headers: requestHeaders(window), cache: "no-store", signal: controller.signal });
        if (!tradeResponse.ok) {
          const next = pollStateForStatus(tradeResponse.status);
          setState(next);
          if (next === "auth-expired") {
            setAuth(null);
            forgetReadExpiry(readSessionStorage());
          }
          return;
        }
        setTrade(parseTradeViewEnvelope(await tradeResponse.json() as unknown));
      } else setTrade(null);
    } catch (error) {
      if (!controller.signal.aborted) setState(error instanceof Error ? "execution-unavailable" : "invalid-response");
      return;
    } finally {
      clearTimeout(deadline);
      if (abortRef.current === controller) abortRef.current = null;
    }
    // A 200 that the strict mapper refuses is NOT "unreachable": name the
    // field, so a real-response/fixture mismatch is visible instead of
    // masquerading as an outage.
    try {
      publishView(nowMs);
      setState("ready");
      setMapperError(null);
    } catch (error) {
      setMapperError(error instanceof Error ? error.message : String(error));
      setState("invalid-response");
    }
  }, [agentId, publishView, requestHeaders]);

  const pollMarket = useCallback(async (window: AuthWindow): Promise<void> => {
    if (!mayPoll(Date.now(), window.expiryMs)) return;
    marketAbortRef.current?.abort();
    const controller = new AbortController();
    marketAbortRef.current = controller;
    try {
      const tokenResponse = await fetch(`/api/market-data/tokens/${WBNB_56}`, { cache: "no-store", signal: controller.signal });
      if (tokenResponse.ok) {
        tokenPayload.current = await tokenResponse.json() as unknown;
        publishView(Date.now());
      }
      const named = viewRef.current;
      if (named !== null) {
        const unresolved = detailTokens(named)
          .map((leg) => leg.toLowerCase())
          .filter((leg) => REVIEWED_MAJORS_56[leg] === undefined && tokenMeta.current[leg] === undefined);
        let learned = false;
        for (const leg of unresolved) {
          const metaResponse = await fetch(`/api/market-data/tokens/${leg}`, { cache: "no-store", signal: controller.signal });
          if (!metaResponse.ok) continue;
          const body = await metaResponse.json() as { data?: { symbol?: unknown; decimals?: unknown } };
          const symbol = body.data?.symbol;
          const decimals = body.data?.decimals;
          // Decimals are what a price NEEDS: a token the data plane cannot
          // scale stays unresolved and its pair keeps dashing, deliberately.
          if (typeof symbol !== "string" || typeof decimals !== "number") continue;
          tokenMeta.current[leg] = { symbol, decimals };
          learned = true;
        }
        if (learned) publishView(Date.now());
      }
      const current = viewRef.current;
      const pool = detailPool(current);
      if (current === null || pool === null || current.armMs === null) {
        setMarketReason(
          current === null ? "no owner view yet"
            : pool === null ? "this agent names no pool"
              : "no live position to date the chart from",
        );
        return;
      }
      const response = await fetch(ohlcvRequestPath(pool, current.armMs, Date.now()), { cache: "no-store", signal: controller.signal });
      if (response.ok) {
        setMarket(reduceOhlcv(await response.json() as unknown, current.armMs, Date.now(), {
          base: detailBaseAddress(current),
          quote: detailQuoteAddress(current),
          baseSymbol: detailBaseSymbol(current),
        }));
        setMarketReason(null);
      } else {
        if (response.status === 404) setMarket({ candles: [], stale: true, banner: "— no candles for this pool", priceNow: null, hodl: { value: null, reason: "— no candles for this pool" } });
        setMarketReason(response.status === 404 ? "no candles for this pool" : `market data HTTP ${response.status}`);
      }
    } catch (error) {
      // Market telemetry is independently optional — the verified owner view
      // stands either way — but the reason is kept so a blank chart can be
      // explained rather than guessed at.
      if (!controller.signal.aborted) {
        setMarketReason(error instanceof Error ? error.message : "market data unavailable");
      }
    }
  }, [publishView]);

  // The 1m USD series the tiles already load IS the default chart, so the
  // default view costs no extra request; only a changed timeframe or unit does.
  const pollChart = useCallback(async (
    window: AuthWindow,
    interval: ChartInterval,
    unit: ChartUnit,
  ): Promise<void> => {
    if (interval === "1m" && unit === "usd") {
      setChartCandles(null);
      setChartBanner(null);
      return;
    }
    if (!mayPoll(Date.now(), window.expiryMs)) return;
    const current = viewRef.current;
    const pool = detailPool(current);
    if (current === null || pool === null || current.armMs === null) return;
    chartAbortRef.current?.abort();
    const controller = new AbortController();
    chartAbortRef.current = controller;
    try {
      const nowMs = Date.now();
      const response = await fetch(ohlcvRequestPath(pool, current.armMs, nowMs, interval), {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        setChartCandles([]);
        setChartBanner(response.status === 404 ? `no ${interval} candles for this pool` : `chart data HTTP ${response.status}`);
        return;
      }
      const reduced = reduceOhlcv(await response.json() as unknown, current.armMs, nowMs, {
        base: detailBaseAddress(current),
        quote: detailQuoteAddress(current),
        baseSymbol: detailBaseSymbol(current),
        interval,
      });
      if (unit === "usd") {
        setChartCandles(reduced.candles);
        setChartBanner(reduced.banner);
        return;
      }
      const quoteAddress = detailQuoteAddress(current);
      const quoteSymbol = detailQuoteSymbol(current) ?? "the quote asset";
      if (quoteAddress === null) {
        setChartCandles([]);
        setChartBanner("this grid names no quote asset");
        return;
      }
      const klines = await fetch(quoteKlinesPath(quoteAddress, ohlcvLimit(current.armMs, nowMs, interval), interval), {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!klines.ok) {
        setChartCandles([]);
        setChartBanner(`${quoteSymbol} price HTTP ${klines.status}`);
        return;
      }
      const converted = priceInQuote(reduced.candles, reduceQuoteKlines(await klines.json() as unknown));
      setChartCandles(converted);
      setChartBanner(converted.length === 0 ? `no ${quoteSymbol} price covers these candles` : reduced.banner);
    } catch (error) {
      if (!controller.signal.aborted) {
        setChartCandles([]);
        setChartBanner(error instanceof Error ? error.message : "chart data unavailable");
      }
    }
  }, []);

  const signIn = useCallback(async (): Promise<void> => {
    setState("loading");
    const accountEnvelope = await signEnvelope("createAccountReadSession", "*", {});
    const response = await fetch("/api/account/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(accountEnvelope),
    });
    if (response.ok) {
      const payload = await response.json() as { data?: { expiry?: unknown } };
      if (!Number.isSafeInteger(payload.data?.expiry)) {
        setState("invalid-response");
        return;
      }
      const expirySec = Number(payload.data?.expiry);
      const expiryMs = expirySec * 1_000;
      if (!Number.isSafeInteger(expiryMs)) {
        setState("invalid-response");
        return;
      }
      const window = { expiryMs };
      rememberReadExpiry(readSessionStorage(), expiryMs);
      setAuth(window);
      await pollOwner(window);
      await pollMarket(window);
      return;
    }
    if (response.status !== 404) {
      setState(pollStateForStatus(response.status));
      return;
    }
    // Capability-hidden deployment: one explicit second signature creates the
    // short signed-read window. It is never attempted by a timer or effect.
    const fallback = await signEnvelope("read", agentId, {});
    const expiry = fallback.signed.expiry;
    if (typeof expiry !== "string" || !/^\d+$/u.test(expiry)) {
      setState("invalid-response");
      return;
    }
    const expiryMs = Number(BigInt(expiry) * 1_000n);
    if (!Number.isSafeInteger(expiryMs)) {
      setState("invalid-response");
      return;
    }
    const window = { expiryMs, signedHeader: encodeReadHeader(fallback) };
    setAuth(window);
    await pollOwner(window);
    await pollMarket(window);
  }, [agentId, pollMarket, pollOwner, signEnvelope]);

  const refresh = useCallback(async (): Promise<AgentDetailView | null> => {
    if (auth === null) return viewRef.current;
    await pollOwner(auth);
    return viewRef.current;
  }, [auth, pollOwner]);

  const refreshTrade = useCallback(async (): Promise<TradeView | null> => {
    if (auth === null || !mayPoll(Date.now(), auth.expiryMs)) return trade;
    const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/trade/view`, {
      headers: requestHeaders(auth), cache: "no-store",
    });
    if (!response.ok) {
      setState(pollStateForStatus(response.status));
      return trade;
    }
    const next = parseTradeViewEnvelope(await response.json() as unknown);
    setTrade(next);
    setAsOfMs(Date.now());
    return next;
  }, [agentId, auth, requestHeaders, trade]);

  // Expiry metadata can only resume a cookie-backed read; the server still
  // verifies the cookie. Signing on Account or another tab resumes this page.
  useEffect(() => {
    const resume = () => {
      const expiryMs = storedReadExpiryMs(readSessionStorage());
      if (expiryMs === null) { setAuth(null); return; }
      const resumedWindow = { expiryMs };
      setAuth(resumedWindow);
      setState("loading");
      void (async () => {
        await pollOwner(resumedWindow);
        await pollMarket(resumedWindow);
      })().catch(() => setState("signed-out"));
    };
    resume();
    return subscribeReadExpiry(resume);
  }, [pollOwner, pollMarket]);

  // Redraws when the owner picks a timeframe or unit, and again on each market
  // poll so the chart keeps pace with the tiles.
  useEffect(() => {
    if (auth === null) return;
    void pollChart(auth, chartInterval, chartUnit);
  }, [auth, chartInterval, chartUnit, pollChart, market]);

  const tradingLoaded = trade !== null;
  useEffect(() => {
    if (auth === null) return;
    // A slow read must finish (or hit its deadline); restarting it every tick
    // can keep the initial view loading forever and starve later valuations.
    const ownerTimer = window.setInterval(() => {
      if (abortRef.current === null) void pollOwner(auth);
    }, tradingLoaded ? 5_000 : 30_000);
    // Retained successful responses age even while every new request fails.
    let priceWasFresh: boolean | null = null;
    let tickWasFresh: boolean | null = null;
    const freshnessTimer = window.setInterval(() => {
      const price = tokenPayload.current as { meta?: { asOf?: number; staleness?: string } } | undefined;
      const age = Date.now() - (price?.meta?.asOf ?? 0);
      const priceFresh = price?.meta?.staleness === "fresh" && age >= 0 && age <= 60_000;
      const tickAge = Date.now() - (liveTick.current?.readAtMs ?? 0);
      const tickFresh = liveTick.current !== null && tickAge >= 0 && tickAge <= 60_000;
      if (priceWasFresh !== null && (priceWasFresh !== priceFresh || tickWasFresh !== tickFresh)) publishView(Date.now());
      priceWasFresh = priceFresh; tickWasFresh = tickFresh;
    }, 1_000);
    const marketTimer = window.setInterval(() => { void pollMarket(auth); }, 60_000);
    void pollLiveTick();
    const liveTickTimer = window.setInterval(() => { void pollLiveTick(); }, 10_000);
    return () => {
      window.clearInterval(ownerTimer);
      window.clearInterval(marketTimer);
      window.clearInterval(freshnessTimer);
      window.clearInterval(liveTickTimer);
      liveTickAbortRef.current?.abort();
      abortRef.current?.abort();
      marketAbortRef.current?.abort();
      chartAbortRef.current?.abort();
    };
  }, [auth, pollLiveTick, pollMarket, pollOwner, tradingLoaded, publishView]);

  const readHeaders = useMemo<Readonly<Record<string, string>>>(() => {
    const signedHeader = auth?.signedHeader;
    const headers: Record<string, string> = {};
    if (signedHeader !== undefined) headers["x-owner-action"] = signedHeader;
    return headers;
  }, [auth?.signedHeader]);

  return {
    state,
    view,
    market,
    chartCandles,
    chartBanner,
    chartInterval,
    chartUnit,
    setChartInterval,
    setChartUnit,
    trade,
    asOfMs,
    message: mapperError === null ? stateMessage(state) : `${stateMessage(state)} (${mapperError})`,
    marketReason,
    readHeaders,
    signIn,
    refresh,
    refreshTrade,
  };
}
