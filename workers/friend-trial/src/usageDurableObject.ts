import { getTrialQuotaWindow, makeTrialUsage } from "./quota";
import type { TrialEnv, TrialUsage } from "./types";

interface PendingReservation {
  cost: number;
  createdAt: number;
}

interface UsageState {
  windowId: string;
  used: number;
  pending: Record<string, PendingReservation>;
}

interface ReserveResult {
  allowed: boolean;
  reservationId?: string;
  usage: TrialUsage;
}

const STATE_KEY = "usage-v1";
// Upstream inference is bounded to 30s. A 2-minute lease repairs a request
// terminated after reservation but before commit/refund without a cron job.
const RESERVATION_LEASE_MS = 2 * 60 * 1000;

/**
 * SQLite-backed Durable Object. One instance is addressed per opaque qid.
 * Storage transactions serialize the read/check/write reservation boundary.
 *
 * This class intentionally uses the constructor/fetch Durable Object contract
 * already supported by the project's Node test harness; Wrangler exports it as
 * a normal Durable Object class via the configured binding and migration.
 */
export class TrialUsageDurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly _env: TrialEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/reserve") {
        const body = await request.json<{ cost?: number; limit?: number }>();
        const cost = Number(body.cost);
        const limit = Number(body.limit);
        if (!Number.isInteger(cost) || cost < 1 || !Number.isInteger(limit) || limit < 1) {
          return Response.json({ ok: false }, { status: 400 });
        }
        return Response.json(await this.reserve(cost, limit));
      }
      if (request.method === "POST" && url.pathname === "/commit") {
        const body = await request.json<{ reservationId?: string; limit?: number }>();
        if (!body.reservationId || !Number.isInteger(body.limit) || Number(body.limit) < 1) {
          return Response.json({ ok: false }, { status: 400 });
        }
        return Response.json({ ok: true, usage: await this.finish(body.reservationId, Number(body.limit), false) });
      }
      if (request.method === "POST" && url.pathname === "/refund") {
        const body = await request.json<{ reservationId?: string; limit?: number }>();
        if (!body.reservationId || !Number.isInteger(body.limit) || Number(body.limit) < 1) {
          return Response.json({ ok: false }, { status: 400 });
        }
        return Response.json({ ok: true, usage: await this.finish(body.reservationId, Number(body.limit), true) });
      }
      if (request.method === "GET" && url.pathname === "/usage") {
        const limit = Number(url.searchParams.get("limit"));
        if (!Number.isInteger(limit) || limit < 1) {
          return Response.json({ ok: false }, { status: 400 });
        }
        return Response.json({ ok: true, usage: await this.getUsage(limit) });
      }
      return Response.json({ ok: false }, { status: 404 });
    } catch (error) {
      console.error(JSON.stringify({ message: "trial usage durable object failure", error: error instanceof Error ? error.message : String(error) }));
      return Response.json({ ok: false }, { status: 500 });
    }
  }

  private async reserve(cost: number, limit: number): Promise<ReserveResult> {
    return this.state.storage.transaction(async (txn) => {
      const { current, window } = await this.readCurrent(txn, limit);
      if (current.used + cost > limit) {
        return { allowed: false, usage: makeTrialUsage(current.used, limit, window.resetAt) };
      }
      const reservationId = crypto.randomUUID();
      current.used = Math.min(limit, current.used + cost);
      current.pending[reservationId] = { cost, createdAt: Date.now() };
      await txn.put(STATE_KEY, current);
      return {
        allowed: true,
        reservationId,
        usage: makeTrialUsage(current.used, limit, window.resetAt),
      };
    });
  }

  private async finish(reservationId: string, limit: number, refund: boolean): Promise<TrialUsage> {
    return this.state.storage.transaction(async (txn) => {
      const { current, window } = await this.readCurrent(txn, limit);
      const pending = current.pending[reservationId];
      if (pending) {
        delete current.pending[reservationId];
        if (refund) current.used = Math.max(0, current.used - pending.cost);
        await txn.put(STATE_KEY, current);
      }
      return makeTrialUsage(current.used, limit, window.resetAt);
    });
  }

  private async getUsage(limit: number): Promise<TrialUsage> {
    return this.state.storage.transaction(async (txn) => {
      const { current, window, changed } = await this.readCurrent(txn, limit);
      if (changed) await txn.put(STATE_KEY, current);
      return makeTrialUsage(current.used, limit, window.resetAt);
    });
  }

  private async readCurrent(
    txn: DurableObjectTransaction,
    limit: number,
  ): Promise<{ current: UsageState; window: ReturnType<typeof getTrialQuotaWindow>; changed: boolean }> {
    const window = getTrialQuotaWindow();
    const stored = await txn.get<UsageState>(STATE_KEY);
    let current: UsageState = stored && stored.windowId === window.windowId
      ? {
          windowId: stored.windowId,
          used: Math.max(0, Math.min(limit, Number(stored.used) || 0)),
          pending: stored.pending && typeof stored.pending === "object" ? { ...stored.pending } : {},
        }
      : { windowId: window.windowId, used: 0, pending: {} };
    let changed = !stored || stored.windowId !== window.windowId || current.used !== stored.used;
    const now = Date.now();
    for (const [id, reservation] of Object.entries(current.pending)) {
      if (!reservation || now - reservation.createdAt >= RESERVATION_LEASE_MS) {
        current.used = Math.max(0, current.used - Math.max(0, reservation?.cost || 0));
        delete current.pending[id];
        changed = true;
      }
    }
    return { current, window, changed };
  }
}
