import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  acquireHarnessLock,
  deriveHarnessStatus,
  releaseHarnessLock,
  updateHarnessLock,
} from "./devnet-harness-state.mjs";

async function withLockPath(action) {
  const directory = await mkdtemp(resolve(tmpdir(), "sidekick-devnet-lock-"));
  try {
    await action(resolve(directory, "harness.lock"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("rejects a live Devnet harness lock", async () => {
  await withLockPath(async (path) => {
    await acquireHarnessLock(path, { runId: "first", pid: 101, phase: "starting" });
    await assert.rejects(
      acquireHarnessLock(
        path,
        { runId: "second", pid: 202, phase: "starting" },
        { isRunning: (pid) => pid === 101 },
      ),
      /PID 101/,
    );
  });
});

test("replaces a stale lock and preserves the current owner on release", async () => {
  await withLockPath(async (path) => {
    await acquireHarnessLock(path, { runId: "first", pid: 101, phase: "starting" });
    await acquireHarnessLock(path, { runId: "second", pid: 202, phase: "chain-ready" });
    await updateHarnessLock(path, "second", { phase: "ready", pid: 303 });
    await releaseHarnessLock(path, "first");
    const current = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(current, { runId: "second", pid: 303, phase: "ready" });
    await releaseHarnessLock(path, "second");
    await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
  });
});

test("reports readiness only when both the harness and dashboard are available", () => {
  assert.equal(
    deriveHarnessStatus({
      phase: "waiting-for-pox-5",
      clarinetRunning: true,
      dashboardReady: false,
    }),
    "waiting-for-pox-5",
  );
  assert.equal(
    deriveHarnessStatus({ phase: "ready", clarinetRunning: true, dashboardReady: false }),
    "stale",
  );
  assert.equal(
    deriveHarnessStatus({ phase: "ready", clarinetRunning: true, dashboardReady: true }),
    "ready",
  );
  assert.equal(
    deriveHarnessStatus({ phase: "ready", clarinetRunning: false, dashboardReady: true }),
    "stale",
  );
});
