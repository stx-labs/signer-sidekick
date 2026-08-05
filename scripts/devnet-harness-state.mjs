import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const bootstrapPhases = new Set([
  "starting",
  "chain-ready",
  "waiting-for-pox-5",
  "dashboard-starting",
  "ready",
]);

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function lockError(record) {
  return new Error(
    `Devnet harness is already running (PID ${record.pid}, phase ${record.phase ?? "starting"}). ` +
      "Use pnpm e2e:devnet:status or pnpm e2e:devnet:down.",
  );
}

function processRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireHarnessLock(path, record, { isRunning = processRunning } = {}) {
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await readJson(path);
    if (existing) {
      if (Number.isSafeInteger(existing.pid) && existing.pid > 0 && isRunning(existing.pid)) {
        throw lockError(existing);
      }
      await rm(path, { force: true });
    }
    try {
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return record;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const existing = await readJson(path);
  if (existing) throw lockError(existing);
  throw new Error("Could not acquire Devnet harness lock");
}

export async function updateHarnessLock(path, runId, update) {
  const current = await readJson(path);
  if (!current || current.runId !== runId) return;
  await writeFile(path, `${JSON.stringify({ ...current, ...update }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function releaseHarnessLock(path, runId) {
  const current = await readJson(path);
  if (!current || (runId && current.runId !== runId)) return;
  await rm(path, { force: true });
}

export function deriveHarnessStatus({ phase, clarinetRunning, dashboardReady }) {
  if (!clarinetRunning) return "stale";
  if (phase === "ready") return dashboardReady ? "ready" : "stale";
  return bootstrapPhases.has(phase) ? phase : "starting";
}
