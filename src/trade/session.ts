/** Session profiles (rth/close/overnight) and their score weights/thresholds/sizing (TRADFI-AI-TRADE-V3 §4). */
export type SessionState = "rth" | "close" | "overnight";

export type SessionProfile = {
  readonly buy: number;
  readonly strong: number;
  readonly sizeMult: number;
  readonly maxOpen: number | null;
  readonly final: number;
};

export const SESSION_PROFILES: Readonly<Record<SessionState, SessionProfile>> = {
  rth: { buy: 14, strong: 38, sizeMult: 1, maxOpen: null, final: 60 },
  close: { buy: 12, strong: 34, sizeMult: 0.8, maxOpen: null, final: 58 },
  overnight: { buy: 16, strong: 40, sizeMult: 0.55, maxOpen: 3, final: 62 },
};

export type ScoreComponentId =
  | "orb" | "momentum" | "volume" | "ema" | "macd" | "regime" | "vwap" | "rsi" | "gap" | "roc1h" | "bollinger" | "stochRsi" | "atrGuard";

/** §2.2: weight per component per session, normalized over active components only at scoring time. */
export const SESSION_WEIGHTS: Readonly<Record<SessionState, Readonly<Record<ScoreComponentId, number>>>> = {
  rth: { orb: 18, momentum: 16, volume: 16, ema: 14, macd: 12, regime: 12, vwap: 10, rsi: 8, gap: 6, roc1h: 6, bollinger: 4, stochRsi: 4, atrGuard: 10 },
  close: { orb: 0, momentum: 14, volume: 12, ema: 16, macd: 14, regime: 12, vwap: 10, rsi: 10, gap: 12, roc1h: 8, bollinger: 6, stochRsi: 6, atrGuard: 10 },
  overnight: { orb: 0, momentum: 14, volume: 8, ema: 18, macd: 16, regime: 14, vwap: 0, rsi: 10, gap: 14, roc1h: 10, bollinger: 8, stochRsi: 6, atrGuard: 10 },
};

const OPEN_MINUTE_RTH = 9 * 60 + 30;
const CLOSE_MINUTE_RTH = 16 * 60;
const CLOSE_MINUTE_END = 20 * 60;

/** Local NY-clock session, same clock family as {@link isUsEquityOpen} in universe.ts. */
export function sessionState(nowMs: number): SessionState {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "NaN");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "NaN");
  const localMinute = hour * 60 + minute;
  const isWeekday = weekday !== "Sat" && weekday !== "Sun" && weekday !== undefined;
  if (isWeekday && localMinute >= OPEN_MINUTE_RTH && localMinute < CLOSE_MINUTE_RTH) return "rth";
  if (isWeekday && localMinute >= CLOSE_MINUTE_RTH && localMinute < CLOSE_MINUTE_END) return "close";
  return "overnight";
}
