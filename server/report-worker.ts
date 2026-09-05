import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { ReportStore } from "./report-store.js";

const database = new Database(workerData.databasePath, { timeout: 5000 });
database.pragma("foreign_keys=ON");
database.pragma("trusted_schema=OFF");
database.pragma("synchronous=FULL");
const store = new ReportStore(database, (day, durationMs) => parentPort?.postMessage({ type: "settled", day, durationMs }));
store.initialize();
let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
function tick() {
  if (stopped) return;
  let delay = 60_000;
  try {
    if (store.step()) delay = 20;
  } catch (error) {
    parentPort?.postMessage({ type: "error", message: error instanceof Error ? error.message : "Report calculation failed" });
    delay = 5 * 60_000;
  }
  timer = setTimeout(tick, delay);
}
parentPort?.on("message", (message) => {
  if (message === "wake" && !stopped) { clearTimeout(timer); tick(); }
  if (message === "stop") {
    stopped = true; clearTimeout(timer); database.close(); parentPort?.close();
  }
});
tick();
