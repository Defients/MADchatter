/**
 * AI Request Orchestrator — centralized scheduling, priority, preemption,
 * and real cancellation for all AI inference requests.
 *
 * Design principles:
 * - Manual Forge (user-triggered) must never wait behind background work.
 * - Ollama (local GPU) uses a single active slot with preemption.
 * - Cloud providers allow concurrent requests (no artificial serialization).
 * - Timeout = real AbortController.abort(), not just a rejected wrapper.
 * - Intentional preemption is NOT a provider health failure.
 * - All requests are traceable via telemetry logs.
 */

// ─── Error Taxonomy ───────────────────────────────────────────────────────────

export class AIRequestTimeoutError extends Error {
  readonly code = "AI_TIMEOUT" as const;
  /** true = timed out waiting in the Ollama queue (capacity issue, not provider failure). */
  readonly queued: boolean;
  constructor(operation: string, timeoutMs: number, queued = false) {
    super(`${operation} timed out after ${timeoutMs}ms${queued ? " (in queue)" : ""}`);
    this.name = "AIRequestTimeoutError";
    this.queued = queued;
  }
}

export class AIRequestPreemptedError extends Error {
  readonly code = "AI_PREEMPTED" as const;
  constructor(operation: string, preemptedBy: string) {
    super(`${operation} preempted by ${preemptedBy}`);
    this.name = "AIRequestPreemptedError";
  }
}

export class AIRequestCancelledError extends Error {
  readonly code = "AI_CANCELLED" as const;
  constructor(operation: string, reason?: string) {
    super(`${operation} cancelled${reason ? ` (${reason})` : ""}`);
    this.name = "AIRequestCancelledError";
  }
}

export type AIRequestError =
  | AIRequestTimeoutError
  | AIRequestPreemptedError
  | AIRequestCancelledError;

/** Check if an error is an intentional scheduler cancellation (not a provider failure). */
export function isSchedulerCancellation(e: unknown): boolean {
  return e instanceof AIRequestPreemptedError || e instanceof AIRequestCancelledError;
}

/** Check if an error is a queue timeout (capacity issue, not a provider failure). */
export function isQueueTimeout(e: unknown): boolean {
  return e instanceof AIRequestTimeoutError && (e as AIRequestTimeoutError).queued;
}

/** Check if an error is a timeout (genuine provider stall or slow response). */
export function isSchedulerTimeout(e: unknown): boolean {
  return e instanceof AIRequestTimeoutError;
}

// ─── Priority System ──────────────────────────────────────────────────────────

export type AIRequestPriority = "critical" | "interactive" | "autonomous" | "background";

const PRIORITY_RANK: Record<AIRequestPriority, number> = {
  critical: 0,
  interactive: 1,
  autonomous: 2,
  background: 3,
};

// ─── Request Metadata ─────────────────────────────────────────────────────────

export interface AIRequestMeta {
  id: string;
  provider: string;
  model?: string;
  operation: string;
  priority: AIRequestPriority;
  preemptible: boolean;
  enqueuedAt: number;
  startedAt?: number;
  completedAt?: number;
  timeoutMs: number;
  /** Max time to wait for the Ollama slot before queue-timeout. Defaults to
      timeoutMs. Background ops can pass a larger budget so they survive a
      contended slot without extending their execution timeout. */
  queueTimeoutMs?: number;
  abortController: AbortController;
  dedupeKey?: string;
  botId?: string;
  channel?: string;
  status: "queued" | "active" | "completed" | "failed" | "preempted" | "timeout" | "cancelled";
  preemptedById?: string;
  preemptedByOp?: string;
  queueWaitMs?: number;
  durationMs?: number;
}

// ─── Telemetry ────────────────────────────────────────────────────────────────

export interface AIRequestMetrics {
  id: string;
  operation: string;
  provider: string;
  model?: string;
  priority: AIRequestPriority;
  status: AIRequestMeta["status"];
  queueWaitMs: number;
  durationMs: number;
  timeoutMs: number;
  preemptedById?: string;
  botId?: string;
  channel?: string;
}

const MAX_METRICS = 200;
const metricsHistory: AIRequestMetrics[] = [];

export function getMetricsHistory(): readonly AIRequestMetrics[] {
  return [...metricsHistory];
}

export function getMetricsSummary(): {
  totalRequests: number;
  timeouts: number;
  preemptions: number;
  cancellations: number;
  failures: number;
  avgQueueWaitMs: number;
  avgDurationMs: number;
} {
  const m = metricsHistory;
  const completed = m.filter((x) => x.status === "completed" || x.status === "failed");
  return {
    totalRequests: m.length,
    timeouts: m.filter((x) => x.status === "timeout").length,
    preemptions: m.filter((x) => x.status === "preempted").length,
    cancellations: m.filter((x) => x.status === "cancelled").length,
    failures: m.filter((x) => x.status === "failed").length,
    avgQueueWaitMs: completed.length ? Math.round(completed.reduce((s, x) => s + x.queueWaitMs, 0) / completed.length) : 0,
    avgDurationMs: completed.length ? Math.round(completed.reduce((s, x) => s + x.durationMs, 0) / completed.length) : 0,
  };
}

function recordMetrics(meta: AIRequestMeta) {
  const entry: AIRequestMetrics = {
    id: meta.id,
    operation: meta.operation,
    provider: meta.provider,
    model: meta.model,
    priority: meta.priority,
    status: meta.status,
    queueWaitMs: meta.queueWaitMs ?? 0,
    durationMs: meta.durationMs ?? 0,
    timeoutMs: meta.timeoutMs,
    preemptedById: meta.preemptedById,
    botId: meta.botId,
    channel: meta.channel,
  };
  metricsHistory.push(entry);
  if (metricsHistory.length > MAX_METRICS) metricsHistory.shift();
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

let requestCounter = 0;

function generateRequestId(): string {
  requestCounter++;
  return `ai_${Date.now().toString(36)}_${requestCounter}`;
}

export interface AIRequestOptions {
  operation: string;
  provider: string;
  model?: string;
  priority: AIRequestPriority;
  timeoutMs: number;
  preemptible?: boolean;
  dedupeKey?: string;
  botId?: string;
  channel?: string;
  /** Max time to wait for the Ollama slot before queue-timeout. Defaults to
      timeoutMs. See AIRequestMeta.queueTimeoutMs. */
  queueTimeoutMs?: number;
}

/**
 * Centralized AI request scheduler.
 *
 * For Ollama (local GPU): enforces a single active inference slot. When a
 * higher-priority request arrives, it preempts (aborts) any active
 * preemptible lower-priority request. Pending requests are queued by
 * priority.
 *
 * For cloud providers (Gemini, OpenAI, Claude, OpenRouter): requests run
 * concurrently with real cancellation on timeout. No artificial
 * serialization.
 */
class AIScheduler {
  /** All active requests for tracking/cleanup. */
  private active = new Map<string, AIRequestMeta>();

  /** Ollama: single active slot. */
  private ollamaActive: AIRequestMeta | null = null;

  /** Ollama: pending queue (sorted by priority on insertion). */
  private ollamaPending: AIRequestMeta[] = [];

  /** Dedup keys currently in flight. */
  private dedupeKeys = new Map<string, string>(); // key → request id

  /** Pending slot promises for queued Ollama requests. */
  private slotResolvers = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();

  /**
   * Execute an AI request through the scheduler.
   *
   * @param task - Factory that receives an AbortSignal and returns the provider promise.
   *   The signal is aborted on timeout or preemption.
   * @param options - Scheduling metadata.
   * @returns The result of `task`.
   * @throws AIRequestTimeoutError, AIRequestPreemptedError, AIRequestCancelledError, or provider errors.
   */
  async execute<T>(
    task: (signal: AbortSignal) => Promise<T>,
    options: AIRequestOptions,
  ): Promise<T> {
    const id = generateRequestId();
    const abortController = new AbortController();
    const meta: AIRequestMeta = {
      id,
      provider: options.provider,
      model: options.model,
      operation: options.operation,
      priority: options.priority,
      preemptible: options.preemptible ?? (options.priority === "autonomous" || options.priority === "background"),
      enqueuedAt: Date.now(),
      timeoutMs: options.timeoutMs,
      queueTimeoutMs: options.queueTimeoutMs,
      abortController,
      dedupeKey: options.dedupeKey,
      botId: options.botId,
      channel: options.channel,
      status: "queued",
    };

    // Dedup check: if a request with the same key is already in flight, skip.
    if (options.dedupeKey) {
      const existingId = this.dedupeKeys.get(options.dedupeKey);
      if (existingId) {
        throw new AIRequestCancelledError(options.operation, "duplicate request already in flight");
      }
      this.dedupeKeys.set(options.dedupeKey, id);
    }

    const isOllama = options.provider === "ollama";

    if (isOllama) {
      // Try to acquire the Ollama slot immediately, or preempt, or queue.
      const acquired = this.tryAcquireOllamaSlot(meta);
      if (!acquired) {
        // Wait in queue — bounded by the same timeout budget. Without this a
        // queued request could wait forever behind a hung active request,
        // wedging callers (e.g. isForging never releasing → all AutoForge
        // loops gated → NEXT CHECK stuck at 0s).
        try {
          await this.waitForOllamaSlot(meta);
        } catch (e) {
          // Cancelled or timed out while waiting in queue.
          if (meta.dedupeKey) this.dedupeKeys.delete(meta.dedupeKey);
          meta.queueWaitMs = Date.now() - meta.enqueuedAt;
          recordMetrics(meta);
          throw e;
        }
      }
    }

    // ── Run the request ──────────────────────────────────────────────────
    this.active.set(id, meta);
    meta.startedAt = Date.now();
    meta.status = "active";
    meta.queueWaitMs = meta.startedAt - meta.enqueuedAt;

    if (isOllama) this.ollamaActive = meta;

    this.logEnqueue(meta);

    // Timeout: abort the controller after timeoutMs.
    const timeoutHandle = setTimeout(() => {
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
    }, options.timeoutMs);

    try {
      const result = await task(abortController.signal);
      clearTimeout(timeoutHandle);
      meta.completedAt = Date.now();
      meta.durationMs = meta.completedAt - meta.startedAt;
      meta.status = "completed";
      this.logComplete(meta);
      return result;
    } catch (e: any) {
      clearTimeout(timeoutHandle);
      meta.completedAt = Date.now();
      meta.durationMs = meta.completedAt - (meta.startedAt ?? meta.enqueuedAt);

      if (abortController.signal.aborted) {
        // Distinguish preemption / explicit cancellation from timeout.
        if ((meta.status as AIRequestMeta["status"]) === "preempted") {
          this.logPreempted(meta);
          throw new AIRequestPreemptedError(options.operation, meta.preemptedByOp ?? "unknown");
        }
        if ((meta.status as AIRequestMeta["status"]) === "cancelled") {
          this.logCancelled(meta);
          throw new AIRequestCancelledError(options.operation, "cancelled by scheduler");
        }
        // Otherwise it's a timeout.
        meta.status = "timeout";
        this.logTimeout(meta);
        throw new AIRequestTimeoutError(options.operation, options.timeoutMs);
      }

      // Genuine provider error.
      meta.status = "failed";
      this.logFail(meta, e);
      throw e;
    } finally {
      this.cleanup(meta);
    }
  }

  // ── Ollama slot management ──────────────────────────────────────────────

  private tryAcquireOllamaSlot(meta: AIRequestMeta): boolean {
    if (!this.ollamaActive) {
      return true; // Slot is free.
    }

    // Try preemption: if new request is higher priority and active is preemptible.
    if (
      PRIORITY_RANK[meta.priority] < PRIORITY_RANK[this.ollamaActive.priority] &&
      this.ollamaActive.preemptible
    ) {
      this.preempt(this.ollamaActive, meta.id, meta.operation);
      this.ollamaActive = null;
      return true;
    }

    return false; // Must queue.
  }

  private waitForOllamaSlot(meta: AIRequestMeta): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.ollamaPending.push(meta);
      this.ollamaPending.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
      this.slotResolvers.set(meta.id, { resolve, reject });

      // Queue-wait deadline: don't wait longer than the request's queue
      // budget (defaults to its own timeout). Protects callers from an
      // unbounded wait if the active request never settles (e.g. an SDK call
      // that ignores the abort signal). Background ops may pass a larger
      // queueTimeoutMs so they survive contention without extending their
      // execution timeout.
      const waitBudgetMs = Math.max(1, meta.enqueuedAt + (meta.queueTimeoutMs ?? meta.timeoutMs) - Date.now());
      const timer = setTimeout(() => {
        const idx = this.ollamaPending.findIndex((m) => m.id === meta.id);
        if (idx < 0) return; // Already started or removed.
        this.ollamaPending.splice(idx, 1);
        this.slotResolvers.delete(meta.id);
        meta.status = "timeout";
        meta.queueWaitMs = Date.now() - meta.enqueuedAt;
        console.warn(
          `[AIQueue] queue-timeout ${meta.operation} waited=${meta.queueWaitMs}ms timeoutMs=${meta.timeoutMs}` +
          `${meta.botId ? ` bot=${meta.botId}` : ""}`,
        );
        reject(new AIRequestTimeoutError(meta.operation, meta.queueTimeoutMs ?? meta.timeoutMs, true));
      }, waitBudgetMs);

      // Cancel the deadline once the slot resolves or is rejected.
      const orig = this.slotResolvers.get(meta.id)!;
      this.slotResolvers.set(meta.id, {
        resolve: () => { clearTimeout(timer); orig.resolve(); },
        reject: (e) => { clearTimeout(timer); orig.reject(e); },
      });
    });
  }

  private startNextOllama() {
    if (this.ollamaActive || this.ollamaPending.length === 0) return;
    // Priority aging: a queued request is promoted one rank per 30s of wait
    // (critical-equivalent after ~90s for background work). Aging only picks
    // who gets the NEXT free slot — it never preempts in-flight work — so a
    // steady stream of autonomous/interactive requests can't starve
    // background ops (e.g. memory extraction) forever.
    const now = Date.now();
    const effRank = (m: AIRequestMeta) =>
      PRIORITY_RANK[m.priority] - Math.floor((now - m.enqueuedAt) / 30_000);
    this.ollamaPending.sort((a, b) => effRank(a) - effRank(b) || a.enqueuedAt - b.enqueuedAt);
    const next = this.ollamaPending.shift()!;
    const resolver = this.slotResolvers.get(next.id);
    this.slotResolvers.delete(next.id);
    if (resolver) {
      this.ollamaActive = next;
      resolver.resolve();
    }
  }

  private preempt(meta: AIRequestMeta, byId: string, byOperation: string) {
    meta.status = "preempted";
    meta.preemptedById = byId;
    meta.preemptedByOp = byOperation;
    meta.abortController.abort();
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  private cleanup(meta: AIRequestMeta) {
    this.active.delete(meta.id);
    if (meta.dedupeKey) this.dedupeKeys.delete(meta.dedupeKey);

    if (meta.provider === "ollama") {
      if (this.ollamaActive?.id === meta.id) {
        this.ollamaActive = null;
      }
      // Remove from pending if it was cancelled while queued.
      const pendingIdx = this.ollamaPending.findIndex((m) => m.id === meta.id);
      if (pendingIdx >= 0) {
        this.ollamaPending.splice(pendingIdx, 1);
        const resolver = this.slotResolvers.get(meta.id);
        if (resolver) {
          this.slotResolvers.delete(meta.id);
          resolver.reject(new AIRequestCancelledError(meta.operation, "removed from queue"));
        }
      }
      // Start next pending Ollama request.
      this.startNextOllama();
    }

    recordMetrics(meta);
  }

  // ── Public helpers ──────────────────────────────────────────────────────

  /** Cancel all active requests for a specific provider (e.g. on provider switch). */
  cancelProvider(provider: string, reason: string = "provider changed"): void {
    for (const meta of this.active.values()) {
      if (meta.provider === provider) {
        meta.status = "cancelled";
        meta.abortController.abort();
      }
    }
    // Also cancel pending Ollama requests for this provider.
    this.ollamaPending = this.ollamaPending.filter((m) => {
      if (m.provider === provider) {
        const resolver = this.slotResolvers.get(m.id);
        if (resolver) {
          this.slotResolvers.delete(m.id);
          resolver.reject(new AIRequestCancelledError(m.operation, reason));
        }
        return false;
      }
      return true;
    });
  }

  /** Cancel all active requests for a specific bot (e.g. on bot removal). */
  cancelBot(botId: string, reason: string = "bot removed"): void {
    for (const meta of this.active.values()) {
      if (meta.botId === botId) {
        meta.status = "cancelled";
        meta.abortController.abort();
      }
    }
    // Also drop queued Ollama requests for this bot so they don't run after
    // the bot is gone.
    this.ollamaPending = this.ollamaPending.filter((m) => {
      if (m.botId === botId) {
        const resolver = this.slotResolvers.get(m.id);
        if (resolver) {
          this.slotResolvers.delete(m.id);
          resolver.reject(new AIRequestCancelledError(m.operation, reason));
        }
        return false;
      }
      return true;
    });
  }

  /** Get the current active request count. */
  getActiveCount(): number {
    return this.active.size;
  }

  /** Get the Ollama queue depth. */
  getOllamaQueueDepth(): number {
    return this.ollamaPending.length;
  }

  /** Check if an Ollama request is currently active. */
  isOllamaBusy(): boolean {
    return this.ollamaActive !== null;
  }

  // ── Logging ────────────────────────────────────────────────────────────

  private logEnqueue(meta: AIRequestMeta) {
    const prefix = meta.provider === "ollama" ? "[AIQueue]" : "[AIRequest]";
    const wait = meta.queueWaitMs ?? 0;
    console.log(
      `${prefix} start ${meta.operation} priority=${meta.priority.toUpperCase()} provider=${meta.provider}` +
      `${meta.model ? ` model=${meta.model}` : ""} wait=${wait}ms` +
      `${meta.botId ? ` bot=${meta.botId}` : ""}`,
    );
  }

  private logComplete(meta: AIRequestMeta) {
    console.log(
      `[AIQueue] complete ${meta.operation} duration=${meta.durationMs}ms` +
      `${meta.botId ? ` bot=${meta.botId}` : ""}`,
    );
  }

  private logTimeout(meta: AIRequestMeta) {
    console.warn(
      `[AIQueue] timeout ${meta.operation} duration=${meta.durationMs}ms timeoutMs=${meta.timeoutMs}` +
      `${meta.botId ? ` bot=${meta.botId}` : ""}`,
    );
  }

  private logPreempted(meta: AIRequestMeta) {
    console.log(
      `[AIQueue] preempt ${meta.operation} → ${meta.preemptedByOp ?? "unknown"}` +
      ` duration=${meta.durationMs}ms` +
      `${meta.botId ? ` bot=${meta.botId}` : ""}`,
    );
  }

  private logCancelled(meta: AIRequestMeta) {
    console.log(
      `[AIQueue] cancelled ${meta.operation} duration=${meta.durationMs}ms` +
      `${meta.botId ? ` bot=${meta.botId}` : ""}`,
    );
  }

  private logFail(meta: AIRequestMeta, e: any) {
    console.warn(
      `[AIQueue] fail ${meta.operation} duration=${meta.durationMs}ms error=${e?.message ?? e}`,
    );
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const aiScheduler = new AIScheduler();

// ─── Provider Request Policy Helper ──────────────────────────────────────────

/**
 * Build provider-specific request options for Ollama thinking-capable models.
 *
 * For Ollama: explicitly set `reasoning_effort: "none"` to prevent hidden
 * reasoning that wastes GPU time on latency-sensitive tasks.
 *
 * For cloud providers: no reasoning_effort is added (semantics differ).
 *
 * NOTE: `num_ctx` is NOT set here because Ollama's OpenAI-compatible
 * `/v1/chat/completions` endpoint ignores the `options` field. Instead,
 * `createOllamaFetch()` rewrites requests to the native `/api/chat`
 * endpoint, which does support `options.num_ctx`.
 */
export function buildProviderRequestOptions(provider: string): Record<string, unknown> {
  if (provider === "ollama") {
    // Explicitly disable reasoning for all realtime paths. This prevents
    // thinking-capable models from spending GPU cycles on internal
    // deliberation that the user never sees and doesn't need for chat.
    return { reasoning_effort: "none" };
  }
  return {};
}

/**
 * Ollama context window size for the native `/api/chat` endpoint.
 * 32768 is 4× the default 8192, enough for Forge requests with full
 * memory context, chat history, and persona directives.
 */
const OLLAMA_NUM_CTX = 32768;

/**
 * Create a custom `fetch` for the OpenAI client when the provider is Ollama.
 *
 * Ollama's OpenAI-compatible `/v1/chat/completions` endpoint ignores the
 * `options` field, so `num_ctx` can't be set through it. This wrapper
 * rewrites chat completion requests to Ollama's native `/api/chat`
 * endpoint (which supports `options.num_ctx`), then converts the
 * response back to OpenAI format so the rest of the code is unchanged.
 */
export function createOllamaFetch(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);

    // Only rewrite chat completion requests
    if (url.pathname !== "/v1/chat/completions") {
      return fetch(input, init);
    }

    // Parse the OpenAI-format request body
    const openaiBody = init?.body ? JSON.parse(init.body as string) : {};

    // Convert OpenAI messages to Ollama native format.
    // OpenAI allows `content` as an array of parts (text + image_url) for
    // multimodal input; Ollama native expects `content: string` plus an
    // `images: string[]` array of base64-encoded image data (no data URL
    // prefix). Text parts are concatenated; image parts are extracted.
    const nativeMessages = (openaiBody.messages ?? []).map(
      (msg: { role: string; content?: unknown }) => {
        const content = msg.content;
        if (typeof content === "string") {
          return { role: msg.role, content };
        }
        if (!Array.isArray(content)) {
          return { role: msg.role, content: "" };
        }
        let text = "";
        const images: string[] = [];
        for (const part of content as Array<Record<string, unknown>>) {
          if (part.type === "text" && typeof part.text === "string") {
            text += part.text;
          } else if (part.type === "image_url" && part.image_url) {
            const imageUrl =
              typeof part.image_url === "string"
                ? part.image_url
                : (part.image_url as { url?: string }).url;
            if (typeof imageUrl === "string") {
              // Strip data URL prefix if present ("data:image/png;base64,...")
              const commaIdx = imageUrl.indexOf(",");
              images.push(commaIdx >= 0 ? imageUrl.slice(commaIdx + 1) : imageUrl);
            }
          }
        }
        const nativeMsg: Record<string, unknown> = { role: msg.role, content: text };
        if (images.length > 0) nativeMsg.images = images;
        return nativeMsg;
      },
    );

    // Convert to Ollama native /api/chat format
    const nativeBody: Record<string, unknown> = {
      model: openaiBody.model,
      messages: nativeMessages,
      stream: false,
      // Disable thinking for qwen3.5 and other thinking-capable models.
      // Without this, the model spends its output token budget on internal
      // reasoning tokens, leaving little/no room for the actual JSON response
      // (causing "Model returned no usable suggestions" on Forge).
      // The OpenAI-compatible endpoint ignores `reasoning_effort`, so we must
      // set `think: false` on the native endpoint instead.
      think: false,
      // keep_alive: 30m keeps the model loaded in memory between requests
      // so the user doesn't pay the cold-load penalty (30s+ for a 9B model)
      // on every Forge after a brief pause. Ollama's default is 5m.
      keep_alive: "30m",
      options: {
        num_ctx: OLLAMA_NUM_CTX,
        ...(openaiBody.temperature != null ? { temperature: openaiBody.temperature } : {}),
        ...(openaiBody.max_tokens != null ? { num_predict: openaiBody.max_tokens } : {}),
      },
    };
    if (openaiBody.response_format?.type === "json_object") {
      nativeBody.format = "json";
    }

    const nativeUrl = url.origin + "/api/chat";
    const nativeResponse = await fetch(nativeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nativeBody),
      signal: init?.signal,
    });

    // Pass through non-OK responses as-is (error handling happens upstream)
    if (!nativeResponse.ok) {
      const errorText = await nativeResponse.text();
      return new Response(errorText, {
        status: nativeResponse.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Convert native response to OpenAI format
    const nativeData = await nativeResponse.json();
    const content = nativeData.message?.content ?? "";
    const promptTokens = nativeData.prompt_eval_count ?? 0;
    const completionTokens = nativeData.eval_count ?? 0;

    const openaiResponse = {
      id: `ollama-${Date.now()}`,
      object: "chat.completion",
      model: nativeData.model ?? openaiBody.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };

    return new Response(JSON.stringify(openaiResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}


// ─── Operation-Aware Token Budgets ───────────────────────────────────────────

/**
 * Returns the max_tokens/maxOutputTokens budget for a given operation type.
 * Scales with requested card count for Forge to avoid giving a 1-card
 * request the same theoretical output volume as a multi-card generation.
 */
export function getOperationTokenBudget(
  operation: string,
  effort?: "low" | "medium" | "high" | "smart",
  count?: number,
): number {
  switch (operation) {
    case "forge":
      // Scale with card count. Base per-card budget + overhead.
      const cardCount = Math.max(1, count ?? 3);
      if (effort === "low") return Math.min(1024, 512 + cardCount * 128);
      if (effort === "high") return Math.min(4096, 1024 + cardCount * 512);
      return Math.min(3072, 768 + cardCount * 256); // medium / smart

    case "refine":
      return 1024;

    case "vision":
      return 512; // Concise structured description.

    case "autoforge_decide":
      return 1024; // Small structured JSON decision.

    case "autoforge_briefing":
      return 1024;

    case "moment_synthesis":
      // Room Model enrichment: small structured JSON (title + summary + hints).
      return 512;

    case "episode_synthesis":
      // Episodic Memory enrichment: small structured JSON (title + summary +
      // topics + kind).
      return 512;

    case "memory_extraction":
      return 1536; // Bounded structured JSON — memories + profiles + jokes.

    case "smart_reply":
      return 768; // 3 short replies.

    default:
      return 1024;
  }
}

/**
 * Returns the timeout for a given operation + provider.
 * Ollama gets shorter timeouts for background tasks (they should be small),
 * but Forge gets the full budget since the user is waiting.
 */
export function getOperationTimeout(
  operation: string,
  provider: string,
): number {
  const isOllama = provider === "ollama";

  switch (operation) {
    case "forge":
      // Ollama: 9B+ models with 32k context need room for cold model load
      // (can take 30s+ on first request) + prompt processing + generation.
      // 180s covers cold start + full Forge prompt + multi-variant generation.
      return isOllama ? 180_000 : 45_000; // User is waiting — give it room.
    case "refine":
      return isOllama ? 60_000 : 30_000;
    case "vision":
      // Ollama: vision is interactive priority (preempts autonomous), but a
      // critical manual Forge can still block the slot. 60s gives room for
      // one forge cycle to complete before vision queue-times out.
      return isOllama ? 60_000 : 30_000;
    case "autoforge_decide":
      // Ollama: allow extra room for multi-bot queue depth. Even with
      // staggered intervals, a vision preemption + retry can briefly
      // queue 2-3 bots. 90s gives ~3 × 30s execution slots of slack.
      return isOllama ? 90_000 : 30_000;
    case "autoforge_briefing":
      // Ollama: the prompt carries the event log, so prompt processing +
      // 1024-token generation needs more than 30s on local models. Give it
      // the same budget as forge (user is waiting on it).
      return isOllama ? 120_000 : 30_000;
    case "memory_extraction":
      return isOllama ? 45_000 : 30_000; // Background — shorter for Ollama so it yields faster.
    case "moment_synthesis":
      // Background Room Model enrichment — small JSON, but local models need
      // cold-start headroom. Yields to interactive/critical work regardless.
      return isOllama ? 60_000 : 30_000;
    case "episode_synthesis":
      // Background Episodic Memory enrichment — same profile as moment synthesis.
      return isOllama ? 60_000 : 30_000;
    case "smart_reply":
      return isOllama ? 30_000 : 20_000;
    default:
      return 30_000;
  }
}
