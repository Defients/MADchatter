/** Shared cost ceiling for optional moment and episode enrichment. */
export class IntelligenceSynthesisBudget {
  private lastStartedAt = -Infinity;
  private inFlight = false;
  private waiting = new Set<string>();

  constructor(private readonly spacingMs = 10 * 60_000) {}

  available(now = Date.now(), owner = "default"): boolean {
    this.waiting.add(owner);
    return !this.inFlight && now - this.lastStartedAt >= this.spacingMs &&
      this.waiting.values().next().value === owner;
  }

  cancel(owner: string): void { this.waiting.delete(owner); }

  acquire(now = Date.now(), owner = "default"): (() => void) | null {
    if (!this.available(now, owner)) return null;
    this.waiting.delete(owner);
    this.inFlight = true;
    this.lastStartedAt = now;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight = false;
    };
  }
}

export const intelligenceSynthesisBudget = new IntelligenceSynthesisBudget();
