import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";

let wake: (() => void) | undefined;
export function wakeReportScheduler() { wake?.(); }

export function startReportScheduler(databasePath: string, log: { error: (value: unknown) => void; info?: (value: unknown) => void }) {
  let worker: Worker | undefined;
  let restart: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  function start() {
    if (closed) return;
    const compiled = new URL("./report-worker.js", import.meta.url);
    worker = existsSync(compiled)
      ? new Worker(compiled, { workerData: { databasePath } })
      : new Worker(`const { workerData } = require('node:worker_threads');
          require('tsx/esm/api').tsImport(workerData.entry, workerData.parent).catch(e => { console.error(e); process.exit(1); });`,
        { eval: true, workerData: { databasePath, entry: new URL("./report-worker.ts", import.meta.url).href, parent: import.meta.url } });
    worker.on("message", (message) => {
      if (message.type === "error") log.error({ reportWorker: message.message });
      else if (message.type === "settled") log.info?.({ reportDay: message.day, durationMs: message.durationMs });
    });
    worker.on("error", (error) => log.error(error));
    worker.on("exit", () => {
      if (!closed) { restart = setTimeout(start, 5 * 60_000); restart.unref(); }
    });
    worker.unref();
    wake = () => worker?.postMessage("wake");
  }
  start();
  return async () => {
    closed = true; wake = undefined; clearTimeout(restart);
    if (!worker) return;
    const current = worker;
    await new Promise<void>((resolve) => {
      const deadline = setTimeout(() => { void current.terminate().then(() => resolve()); }, 10_000);
      current.once("exit", () => { clearTimeout(deadline); resolve(); });
      current.postMessage("stop");
    });
  };
}
