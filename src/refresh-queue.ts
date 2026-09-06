/** One in-flight read plus one coalesced trailing read. Hidden views retain only invalidation. */
export class RefreshQueue<A extends unknown[], T> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private args: A | null = null;
  private waiters: Array<(value: T) => void> = [];
  private disposed = false;
  private urgent = false;
  constructor(private run: (signal: AbortSignal, ...args: A) => Promise<T>, private visible = () => typeof document === "undefined" || document.visibilityState !== "hidden") {}
  request(args: A, urgent = false): Promise<T> {
    if (this.disposed) return Promise.resolve(undefined as T);
    this.args = args; this.urgent ||= urgent;
    if (urgent && this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    const result = new Promise<T>(resolve => this.waiters.push(resolve));
    this.schedule();
    return result;
  }
  resume() { this.schedule(); }
  activate() { this.disposed = false; }
  private schedule() {
    if (this.disposed || !this.args || this.controller || this.timer || !this.visible() && !this.urgent) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.urgent ? 0 : 200);
  }
  private async flush() {
    if (!this.args || this.disposed || !this.visible() && !this.urgent) return;
    const args = this.args, waiters = this.waiters;
    this.args = null; this.waiters = []; this.urgent = false;
    const controller = new AbortController(); this.controller = controller;
    try {
      const value = await this.run(controller.signal, ...args);
      for (const resolve of waiters) resolve(value);
    } catch {
      // Loaders own error presentation. Cancellation must not create unhandled rejections.
      for (const resolve of waiters) resolve(undefined as T);
    } finally {
      this.controller = null; this.schedule();
    }
  }
  abort() { this.controller?.abort(); }
  dispose() {
    this.disposed = true; this.abort(); if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.args = null;
    for (const resolve of this.waiters) resolve(undefined as T);
    this.waiters = [];
  }
}
