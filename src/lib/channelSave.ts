export type ChannelSaveOutcome = "success" | "failure" | "same" | "duplicate";

/** Small deterministic ownership gate behind ChannelEditRow. */
export class ChannelSaveGate {
  private busy = false;

  async submit(
    current: string,
    next: string,
    save: (name: string) => boolean | Promise<boolean>,
  ): Promise<ChannelSaveOutcome> {
    if (this.busy) return "duplicate";
    if (next === current) return "same";
    this.busy = true;
    try {
      return await save(next) ? "success" : "failure";
    } finally {
      this.busy = false;
    }
  }
}
