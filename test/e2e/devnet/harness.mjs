import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const root = resolve(import.meta.dirname, "../../..");
export const harnessDirectory = resolve(root, "test/e2e/devnet");
export const runtimeDirectory = resolve(harnessDirectory, ".runtime");
export const artifactDirectory = resolve(harnessDirectory, "artifacts");
export const statePath = resolve(runtimeDirectory, "run.json");
export const managerPrincipal = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.signer-manager";
export const authHeader = "authorization";

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.stdio ?? "pipe",
  });
  if (result.error) throw result.error;
  if (!(options.allowedExitCodes ?? [0]).includes(result.status)) {
    throw new Error(
      `${command} ${args.slice(0, 8).join(" ")} failed with exit ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return `${String(result.stdout ?? "")}${options.includeStderr ? String(result.stderr ?? "") : ""}`.trim();
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function ensureDirectories() {
  await Promise.all([
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(artifactDirectory, { recursive: true }),
  ]);
}

export async function readState() {
  return JSON.parse(await readFile(statePath, "utf8"));
}

export async function writeState(state) {
  await ensureDirectories();
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(statePath, 0o600);
}

export function newAuthToken() {
  return `sidekick-devnet-${randomBytes(24).toString("hex")}`;
}

export async function waitFor(predicate, label, timeoutMs = 180_000, intervalMs = 500) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

export async function sidekickFetch(state, path, init = {}) {
  const response = await fetch(`http://127.0.0.1:3998${path}`, {
    ...init,
    headers: {
      [authHeader]: `Bearer ${state.authToken}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Sidekick ${path} returned HTTP ${response.status}: ${text.slice(0, 1_000)}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/json") ? await response.json() : await response.text();
}

export async function proxyControl(target, mode, additional = {}) {
  const response = await fetch("http://127.0.0.1:21999/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, mode, ...additional }),
  });
  if (!response.ok) throw new Error(`Proxy control returned HTTP ${response.status}`);
  return await response.json();
}

export function signerContainerId() {
  const output = run("docker", ["ps", "--filter", "name=stacks-signer-0", "--format", "{{.ID}}"]);
  const id = output.split("\n").find(Boolean);
  if (!id) throw new Error("Could not locate the Clarinet stacks-signer-0 container");
  return id;
}

export function generateSignerGrant(authId = "1") {
  const output = run("docker", [
    "exec",
    signerContainerId(),
    "stacks-signer",
    "generate-staking-signature",
    "--config",
    "/src/stacks-signer/Signer-0.toml",
    "--signer-manager",
    managerPrincipal,
    "--auth-id",
    String(authId),
    "--json",
  ]);
  const line = output
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.startsWith("{") && item.endsWith("}"));
  if (!line) throw new Error(`Released signer command did not return JSON: ${output}`);
  const grant = JSON.parse(line);
  if (
    grant.signerManager !== managerPrincipal ||
    String(grant.authId) !== String(authId) ||
    !/^(02|03)[0-9a-f]{64}$/i.test(grant.signerKey) ||
    !/^[0-9a-f]{130}$/i.test(grant.signerSignature)
  ) {
    throw new Error("Released signer grant JSON has an unexpected shape");
  }
  return grant;
}
