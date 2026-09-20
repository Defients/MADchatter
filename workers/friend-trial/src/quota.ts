import type { TrialUsage } from "./types";

export const TRIAL_RESET_TIMEZONE = "America/New_York";
export const TRIAL_RESET_HOUR = 12;
export const TRIAL_TEXT_COST = 1;
export const TRIAL_VISION_COST = 2;

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: TRIAL_RESET_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsAt(timestamp: number): DateParts {
  const values = Object.fromEntries(
    ET_PARTS.formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return values as unknown as DateParts;
}

function addLocalDays(date: Pick<DateParts, "year" | "month" | "day">, days: number) {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** Convert a non-ambiguous Eastern local wall-clock time to an absolute time. */
function easternLocalToUtc(parts: DateParts): number {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let candidate = target;
  // Noon is never inside a DST gap/overlap. Iteration resolves the applicable
  // offset without hardcoding EST or EDT and naturally follows tzdata.
  for (let i = 0; i < 4; i += 1) {
    const observed = partsAt(candidate);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    const correction = target - observedAsUtc;
    candidate += correction;
    if (correction === 0) break;
  }
  return candidate;
}

function dateId(date: Pick<DateParts, "year" | "month" | "day">): string {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

export interface TrialQuotaWindow {
  windowId: string;
  startsAt: string;
  resetAt: string;
}

/** Canonical noon-to-noon America/New_York quota window. */
export function getTrialQuotaWindow(nowMs = Date.now()): TrialQuotaWindow {
  const local = partsAt(nowMs);
  const beforeNoon = local.hour < TRIAL_RESET_HOUR;
  const startDate = addLocalDays(local, beforeNoon ? -1 : 0);
  const resetDate = addLocalDays(startDate, 1);
  const startsAtMs = easternLocalToUtc({ ...startDate, hour: TRIAL_RESET_HOUR, minute: 0, second: 0 });
  const resetAtMs = easternLocalToUtc({ ...resetDate, hour: TRIAL_RESET_HOUR, minute: 0, second: 0 });
  return {
    windowId: dateId(startDate),
    startsAt: new Date(startsAtMs).toISOString(),
    resetAt: new Date(resetAtMs).toISOString(),
  };
}

export function makeTrialUsage(used: number, limit: number, resetAt: string): TrialUsage {
  const safeLimit = Math.max(1, Math.floor(limit));
  const safeUsed = Math.max(0, Math.min(safeLimit, Math.floor(used)));
  return {
    used: safeUsed,
    remaining: Math.max(0, safeLimit - safeUsed),
    limit: safeLimit,
    resetAt,
  };
}
