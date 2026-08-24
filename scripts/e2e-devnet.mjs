import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { openSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { basename, resolve } from "node:path";
import {
  artifactDirectory,
  ensureDirectories,
  generateSignerGrant,
  harnessDirectory,
  managerPrincipal,
  newAuthToken,
  proxyControl,
  readState,
  root,
  run,
  runtimeDirectory,
  sha256,
  sidekickFetch,
  statePath,
  waitFor,
  writeState,
} from "../test/e2e/devnet/harness.mjs";
import { createOperatorActor, DEVNET_ACCOUNTS } from "../test/e2e/devnet/operator-actor.mjs";
import {
  acquireHarnessLock,
  deriveHarnessStatus,
  releaseHarnessLock,
  updateHarnessLock,
} from "./devnet-harness-state.mjs";

const command = process.argv[2] ?? "help";
const arguments_ = new Set(process.argv.slice(3));
const keepOnFailure = arguments_.has("--keep-on-failure");
const skipBuild = arguments_.has("--no-build") || process.env.SIDEKICK_E2E_BUILD === "0";
const lock = JSON.parse(await readFile(resolve(harnessDirectory, "versions.lock.json"), "utf8"));
const clarinetProject = "signer-sidekick-pox5-e2e";
const harnessLockPath = resolve(
  process.env.XDG_CACHE_HOME ?? resolve(homedir(), ".cache"),
  "signer-sidekick",
  "devnet-harness.lock",
);
const browserArtifactDirectories = [
  resolve(harnessDirectory, "test-results"),
  resolve(harnessDirectory, "playwright-report"),
];

function log(message) {
  console.log(`[sidekick-devnet] ${message}`);
}

function safeProcessKill(pid, signal = "SIGINT") {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function running(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function existingState() {
  try {
    return await readState();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function setBootstrapPhase(state, phase, message) {
  state.bootstrap = { phase, updatedAt: new Date().toISOString() };
  await writeState(state);
  await updateHarnessLock(harnessLockPath, state.runId, {
    phase,
    pid: state.pids.clarinet ?? process.pid,
  });
  log(message);
}

function platformKey() {
  const os = platform();
  const cpu = arch();
  if (!["darwin", "linux"].includes(os) || !["arm64", "x64"].includes(cpu)) {
    throw new Error(`No pinned Clarinet binary for ${os}-${cpu}`);
  }
  return `${os}-${cpu}`;
}

async function resolveClarinet() {
  if (process.env.CLARINET_BIN) {
    const version = run(process.env.CLARINET_BIN, ["--version"]);
    if (!version.includes(lock.clarinet.version)) {
      throw new Error(`CLARINET_BIN is ${version}, expected ${lock.clarinet.version}`);
    }
    return process.env.CLARINET_BIN;
  }
  const release = lock.clarinet.archives[platformKey()];
  const cache = resolve(
    process.env.XDG_CACHE_HOME ?? resolve(homedir(), ".cache"),
    "signer-sidekick",
    `clarinet-${lock.clarinet.version}-${platformKey()}`,
  );
  const binary = resolve(cache, "clarinet");
  try {
    const version = run(binary, ["--version"]);
    if (version.includes(lock.clarinet.version)) return binary;
  } catch {}

  await mkdir(cache, { recursive: true });
  const archive = resolve(cache, release.file);
  log(`Downloading pinned Clarinet ${lock.clarinet.version} for ${platformKey()}`);
  const response = await fetch(`${lock.clarinet.releaseBaseUrl}/${release.file}`);
  if (!response.ok) throw new Error(`Clarinet download returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== release.sha256) {
    throw new Error(`Clarinet archive hash mismatch: expected ${release.sha256}, got ${digest}`);
  }
  await writeFile(archive, bytes, { mode: 0o600 });
  run("tar", ["-xzf", archive, "-C", cache]);
  await chmod(binary, 0o755);
  const version = run(binary, ["--version"]);
  if (!version.includes(lock.clarinet.version)) {
    throw new Error(`Downloaded Clarinet is ${version}, expected ${lock.clarinet.version}`);
  }
  return binary;
}

function spawnDetached(commandName, args, logPath, environment = {}) {
  const descriptor = openSync(logPath, "a", 0o600);
  const child = spawn(commandName, args, {
    cwd: root,
    detached: true,
    stdio: ["ignore", descriptor, descriptor],
    env: { ...process.env, ...environment },
  });
  child.unref();
  return child.pid;
}

async function waitForLog(path, text, timeoutMs = 900_000) {
  return await waitFor(
    async () => {
      const content = await readFile(path, "utf8").catch(() => "");
      if (/Fatal:/i.test(content)) throw new Error(content.slice(-4_000));
      return content.includes(text) ? content : null;
    },
    `"${text}" in ${basename(path)}`,
    timeoutMs,
    1_000,
  );
}

async function waitForHttp(url, label, timeoutMs = 180_000) {
  return await waitFor(
    async () => {
      const response = await fetch(url);
      return response.ok ? response : null;
    },
    label,
    timeoutMs,
  );
}

function sidekickRuntimeArgs(
  state,
  volume = state.volumeName,
  {
    manager = managerPrincipal,
    publish = true,
    trustedProfilesDirectory = null,
    profileOutputDirectory = null,
  } = {},
) {
  return [
    "--read-only",
    "--tmpfs",
    "/tmp:size=64m,mode=1777",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--add-host",
    "host.docker.internal:host-gateway",
    "--mount",
    `source=${volume},target=/data`,
    ...(publish ? ["--publish", "127.0.0.1:3998:3998", "--publish", "127.0.0.1:3700:3700"] : []),
    "--env",
    "SIDEKICK_NETWORK=devnet",
    "--env",
    "STACKS_NODE_RPC_URL=http://host.docker.internal:21443",
    "--env",
    "STACKS_API_URL=http://host.docker.internal:13999",
    "--env",
    `SIDEKICK_MANAGER_PRINCIPAL=${manager}`,
    "--env",
    `SIDEKICK_AUTH_TOKEN=${state.authToken}`,
    "--env",
    "SIDEKICK_ENGINE_MODE=operator-run",
    "--env",
    "SIDEKICK_MAX_API_BURN_BLOCK_LAG=0",
    "--env",
    "SIDEKICK_STAKER_PAGE_LIMIT=1",
    "--env",
    "SIDEKICK_EVENT_PAGE_LIMIT=1",
    "--env",
    "SIDEKICK_EVENT_HTTP_HOST=0.0.0.0",
    ...(trustedProfilesDirectory
      ? [
          "--mount",
          `type=bind,source=${trustedProfilesDirectory},target=/etc/sidekick/trusted-managers,readonly`,
          "--env",
          "SIDEKICK_TRUSTED_MANAGER_PROFILES_DIR=/etc/sidekick/trusted-managers",
        ]
      : []),
    ...(profileOutputDirectory
      ? ["--mount", `type=bind,source=${profileOutputDirectory},target=/profiles`]
      : []),
  ];
}

async function startSidekick(
  state,
  {
    volume = state.volumeName,
    container = state.containerName,
    manager = managerPrincipal,
    trustedProfilesDirectory = null,
  } = {},
) {
  if (!skipBuild && !state.imageBuilt) {
    log(`Building production Sidekick image ${state.sidekickImage}`);
    run("docker", [
      "build",
      "--target",
      "runtime",
      "--tag",
      state.sidekickImage,
      "--build-arg",
      `VCS_REF=${state.gitCommit}`,
      ".",
    ]);
    state.imageBuilt = true;
    await writeState(state);
  }
  run("docker", ["volume", "create", volume]);
  run("docker", [
    "run",
    "--detach",
    "--name",
    container,
    ...sidekickRuntimeArgs(state, volume, { manager, trustedProfilesDirectory }),
    state.sidekickImage,
    "serve",
  ]);
  await waitForHttp("http://127.0.0.1:3998/health/live", "Sidekick dashboard");
}

async function stopSidekick(container) {
  run("docker", ["rm", "--force", container], { allowedExitCodes: [0, 1] });
}

async function enableDevnetTransactionIndex() {
  const configPath = resolve(runtimeDirectory, "clarinet/conf/Stacks.toml");
  const current = await readFile(configPath, "utf8");
  let updated = current;
  if (/^txindex\s*=/m.test(current)) {
    updated = current.replace(/^txindex\s*=.*$/m, "txindex = true");
  } else {
    updated = current.replace(/^\[node\]\s*$/m, "[node]\ntxindex = true");
  }
  if (updated === current && !/^txindex\s*=\s*true\s*$/m.test(current)) {
    throw new Error("Clarinet's generated Stacks node config did not contain a [node] section");
  }
  if (updated !== current) await writeFile(configPath, updated);

  const containers = run(
    "docker",
    [
      "ps",
      "--filter",
      `label=com.docker.compose.project=${clarinetProject}`,
      "--filter",
      "label=com.docker.compose.service=stacks-node",
      "--format",
      "{{.ID}}",
    ],
    { allowedExitCodes: [0, 1] },
  )
    .split("\n")
    .filter(Boolean);
  if (containers.length !== 1) {
    throw new Error(`Expected one released Stacks node container, found ${containers.length}`);
  }
  log("Bootstrap: enabling the released node transaction index");
  run("docker", ["restart", containers[0]]);
  await Promise.all([
    waitForHttp("http://127.0.0.1:20443/v2/info", "transaction-indexed stacks-node", 120_000),
    waitForHttp(
      "http://127.0.0.1:3999/extended/v1/status",
      "Stacks API after node restart",
      120_000,
    ),
  ]);
}

async function up() {
  const runId = `${Date.now()}-${process.pid}`;
  await acquireHarnessLock(harnessLockPath, { runId, pid: process.pid, phase: "starting" });
  try {
    const previous = await existingState();
    if (
      previous &&
      (running(previous.pids?.clarinet) ||
        running(previous.pids?.proxy) ||
        running(previous.pids?.resource))
    ) {
      throw new Error(`Devnet is already running; use pnpm e2e:devnet:status or :down`);
    }
    if (previous) await down();
    else removeOrphanedHarnessDockerResources();
    await ensureDirectories();
    await rm(resolve(harnessDirectory, "deployments"), { recursive: true, force: true });
    run("docker", ["info"]);
    run(process.execPath, ["scripts/verify-devnet-lock.mjs", "--offline"]);
    const clarinet = await resolveClarinet();
    const state = {
      schemaVersion: 1,
      runId,
      startedAt: new Date().toISOString(),
      // Clarinet 3.21.1 embeds a stacks-core 3.4 snapshot. Using it with the
      // released stacks-core 4.0 image can strand the miner during the Epoch 3
      // run-loop transition, so every released-binary run uses a clean chain.
      fromGenesis: true,
      gitCommit: run("git", ["rev-parse", "HEAD"]),
      managerPrincipal,
      authToken: newAuthToken(),
      sidekickImage: process.env.SIDEKICK_E2E_IMAGE ?? "signer-sidekick:e2e",
      containerName: `signer-sidekick-e2e-${runId}`,
      volumeName: `signer-sidekick-e2e-${runId}`,
      bootstrap: { phase: "starting", updatedAt: new Date().toISOString() },
      pids: {},
      logs: {
        clarinet: resolve(runtimeDirectory, "clarinet.log"),
        proxy: resolve(runtimeDirectory, "proxy.log"),
        resourceMonitor: resolve(runtimeDirectory, "resource-monitor.log"),
      },
      resourceUsagePath: resolve(runtimeDirectory, "resource-usage.jsonl"),
    };
    await Promise.all(
      Object.values(state.logs).map((path) => writeFile(path, "", { mode: 0o600 })),
    );
    await writeFile(state.resourceUsagePath, "", { mode: 0o600 });
    // Persist the cleanup manifest before starting any detached process. The test wrapper can now
    // recover from failures at every subsequent bootstrap gate, even before `up()` returns.
    await writeState(state);

    state.pids.proxy = spawnDetached(
      process.execPath,
      ["scripts/devnet-proxy.mjs"],
      state.logs.proxy,
    );
    await writeState(state);
    await waitForHttp("http://127.0.0.1:21999/state", "failure-injection proxy");
    if (process.env.SIDEKICK_E2E_FAIL_AFTER_PROXY === "1") {
      throw new Error("Injected bootstrap failure after proxy startup");
    }
    state.pids.resource = spawnDetached(
      process.execPath,
      [
        "scripts/devnet-resource-monitor.mjs",
        "--output",
        state.resourceUsagePath,
        "--sidekick-prefix",
        state.containerName,
      ],
      state.logs.resourceMonitor,
    );
    await writeState(state);
    const clarinetArgs = [
      "devnet",
      "start",
      "--manifest-path",
      resolve(harnessDirectory, "Clarinet.toml"),
      "--no-dashboard",
      "--save-container-logs",
      "--use-computed-deployment-plan",
    ];
    clarinetArgs.push("--from-genesis");
    state.pids.clarinet = spawnDetached(clarinet, clarinetArgs, state.logs.clarinet);
    await writeState(state);
    await updateHarnessLock(harnessLockPath, state.runId, { pid: state.pids.clarinet });

    log("Bootstrap: starting local chain, signer, API, and proxy");
    await waitForLog(state.logs.clarinet, "Local Devnet network ready");
    await Promise.all([
      waitForHttp("http://127.0.0.1:20443/v2/info", "stacks-node", 300_000),
      waitForHttp("http://127.0.0.1:3999/extended/v1/status", "Stacks API", 300_000),
    ]);
    await enableDevnetTransactionIndex();
    await setBootstrapPhase(
      state,
      "chain-ready",
      "Bootstrap: chain, signer, node, and API are ready",
    );

    const actor = createOperatorActor();
    await setBootstrapPhase(
      state,
      "waiting-for-pox-5",
      "Bootstrap: waiting for the local chain to activate PoX-5",
    );
    const pox = await waitFor(
      async () => {
        const response = await fetch("http://127.0.0.1:20443/v2/pox");
        if (!response.ok) return null;
        const value = await response.json();
        return String(value.contract_id).endsWith(".pox-5") ? value : null;
      },
      "PoX-5 activation at Clarinet's controlled mining cadence",
      300_000,
      1_000,
    );
    const node = await actor.nodeInfo();
    await actor.waitForTip(node.burn_block_height);
    await setBootstrapPhase(state, "dashboard-starting", "Bootstrap: starting Sidekick dashboard");
    await startSidekick(state);
    await setBootstrapPhase(state, "ready", "Bootstrap: dashboard is ready");
    log(`Dashboard: http://127.0.0.1:3998`);
    log(`Manager: ${managerPrincipal}`);
    log(`Reward cycle: ${pox.reward_cycle_id}; burn height: ${node.burn_block_height}`);
    log(`Runtime state: ${statePath}`);
    return state;
  } catch (error) {
    const state = await existingState();
    if (!state || state.runId !== runId) await releaseHarnessLock(harnessLockPath, runId);
    throw error;
  }
}

async function connectExistingManager(state) {
  const actor = createOperatorActor();
  // Day-zero deployment belongs to the external setup harness. Sidekick starts observing once the
  // manager exists and then owns the recurring operator lifecycle.
  const source = await readFile(resolve(root, lock.manager.source), "utf8");
  if (sha256(source) !== lock.manager.sha256) {
    throw new Error(`Pinned manager source hash mismatch: ${sha256(source)}`);
  }
  const deployment = await actor.deployManager(source);
  const grant = generateSignerGrant("1");
  const registration = await actor.registerManager(grant);
  const connection = await sidekickFetch(state, "/api/v1/connection/recheck", {
    method: "POST",
    body: "{}",
  });
  if (connection.status !== "connected") {
    throw new Error(
      `Sidekick connection remained ${connection.status}: ${JSON.stringify(connection)}`,
    );
  }
  await waitForHttp("http://127.0.0.1:3700/health/live", "Sidekick private event listener");
  await proxyControl("observer", "pass");
  const observed = await waitFor(
    async () => {
      const status = await sidekickFetch(state, "/api/v1/status?refresh=1");
      return status.registration?.registered ? status : null;
    },
    "Sidekick to observe the externally completed manager registration",
    120_000,
    1_000,
  );
  return {
    artifactSha256: sha256(source),
    deployTxid: deployment.txid ?? null,
    registerTxid: registration.txid,
    signerKey: grant.signerKey,
    connection: {
      status: connection.status,
      managerPrincipal: connection.configured.managerPrincipal,
      bindingSource: connection.deploymentIdentity.stored?.bindingSource ?? null,
    },
    readiness: observed.readiness?.status ?? observed.setup?.status ?? "unavailable",
  };
}

async function ensureRewardPhase(actor) {
  return await actor.waitFor(
    async () => {
      const pox = await fetch("http://127.0.0.1:20443/v2/pox").then((response) => response.json());
      const untilPrepare = pox.next_cycle?.blocks_until_prepare_phase;
      // The active-pool fixture confirms seven transactions serially. Leave enough reward-phase
      // runway for every staking mutation to anchor before PoX rejects updates in prepare phase.
      return typeof untilPrepare !== "number" || untilPrepare > 10 ? pox : null;
    },
    "a PoX reward phase with at least eleven blocks before prepare",
    180_000,
  );
}

async function waitForEligibleFirstDistributionTarget() {
  return await waitFor(
    async () => {
      const pox = await fetch("http://127.0.0.1:20443/v2/pox").then((response) => response.json());
      const cycle = pox.reward_cycle_id;
      const burnHeight = pox.current_burnchain_block_height;
      const cycleLength = pox.reward_cycle_length;
      const nextCycleStart = pox.next_cycle?.reward_phase_start_block_height;
      if (
        !Number.isSafeInteger(cycle) ||
        !Number.isSafeInteger(burnHeight) ||
        !Number.isSafeInteger(cycleLength) ||
        !Number.isSafeInteger(nextCycleStart)
      ) {
        return null;
      }
      const cycleStart = nextCycleStart - cycleLength;
      const firstCalculationEligibleHeight = cycleStart + Math.floor(cycleLength / 2);
      return burnHeight >= firstCalculationEligibleHeight ? { cycle, distribution: 1 } : null;
    },
    "the first reward calculation checkpoint for the manager's active cycle",
    300_000,
    500,
  );
}

async function executePreparedRewardRun(state, prepared, label) {
  const approved = await sidekickFetch(state, `/api/v1/rewards/runs/${prepared.runId}/approve`, {
    method: "POST",
    body: JSON.stringify({ recipeSha256: prepared.recipeSha256 }),
  });
  // The HTTP caller is deliberately done after approval. The server-owned loop must finish the
  // work without a browser connection or a second action request.
  const completed = await waitFor(
    async () => {
      const run = await sidekickFetch(state, `/api/v1/rewards/runs/${prepared.runId}`);
      return ["completed", "halted", "cancelled", "expired"].includes(run.status) ? run : null;
    },
    label,
    300_000,
    500,
  );
  if (completed.status !== "completed") {
    throw new Error(`${label} ended ${completed.status}: ${completed.failureReason ?? "unknown"}`);
  }
  return { approvedStatus: approved.status, completed };
}

async function withdrawalRequestIdForChild(child) {
  if (!child.txid) throw new Error("Confirmed Bitcoin-route payment did not retain its txid");
  return await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:3999/extended/v1/tx/${child.txid}`);
      if (!response.ok) return null;
      const transaction = await response.json();
      const match = transaction.tx_result?.repr?.match(/\(withdrawal-request \(some u(\d+)\)\)/);
      return match ? BigInt(match[1]) : null;
    },
    `the withdrawal request emitted by ${child.txid}`,
    120_000,
    500,
  );
}

async function prepareRewardRunWhenAvailable(
  state,
  operations,
  target,
  label,
  maxTransactions = 1,
) {
  let lastError = null;
  const requestId = randomUUID();
  const prepared = await waitFor(
    async () => {
      await sidekickFetch(state, "/api/v1/status?refresh=1").catch(() => null);
      try {
        return await sidekickFetch(state, "/api/v1/rewards/runs", {
          method: "POST",
          body: JSON.stringify({
            requestId,
            cycle: target.cycle,
            distribution: target.distribution,
            operations,
            maxTransactions,
          }),
        });
      } catch (error) {
        lastError = error;
        return null;
      }
    },
    label,
    300_000,
    1_000,
  ).catch((error) => {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${lastError ? `: ${lastError.message}` : ""}`,
    );
  });
  // Exercise the creation idempotency contract with the same public request key and body.
  const retried = await sidekickFetch(state, "/api/v1/rewards/runs", {
    method: "POST",
    body: JSON.stringify({
      requestId: prepared.runId,
      cycle: prepared.recipe.cycle,
      distribution: prepared.recipe.distribution,
      operations,
      maxTransactions,
    }),
  });
  if (retried.runId !== prepared.runId || retried.recipeSha256 !== prepared.recipeSha256) {
    throw new Error(`${label} did not return the original sealed run on retry`);
  }
  return prepared;
}

async function runGasWalletCollectScenario(state, actor) {
  const rewardFunding = await actor.fundPox5Rewards();
  const created = await sidekickFetch(state, "/api/v1/settings/gas-wallet", {
    method: "POST",
    body: "{}",
  });
  if (!created.principal)
    throw new Error("Sidekick did not return the generated gas-wallet address");
  const funding = await actor.fundGasWallet(created.principal);
  const enabled = await sidekickFetch(state, "/api/v1/settings/gas-wallet/enable", {
    method: "POST",
    body: "{}",
  });
  if (!enabled.enabled || enabled.signer !== "ready") {
    throw new Error(`Devnet gas wallet did not activate: ${JSON.stringify(enabled)}`);
  }
  const target = await waitForEligibleFirstDistributionTarget();
  const calculationDraft = await prepareRewardRunWhenAvailable(
    state,
    ["calculate-rewards"],
    target,
    "a permissionless Devnet reward calculation to become runnable",
  );
  const calculation = await executePreparedRewardRun(
    state,
    calculationDraft,
    "the API-approved Devnet reward calculation",
  );
  const collectTarget = {
    cycle: calculationDraft.recipe.cycle,
    distribution: calculationDraft.recipe.distribution,
  };
  const collectDraft = await prepareRewardRunWhenAvailable(
    state,
    ["claim-rewards"],
    collectTarget,
    "the Devnet manager collect to become runnable",
  );
  const collect = await executePreparedRewardRun(
    state,
    collectDraft,
    "the API-approved Devnet manager collect",
  );
  if (
    collect.completed.children.length !== 1 ||
    collect.completed.children[0]?.operation !== "claim-rewards" ||
    collect.completed.children[0]?.status !== "confirmed"
  ) {
    throw new Error(
      `Devnet collect run had unexpected children: ${JSON.stringify(collect.completed.children)}`,
    );
  }
  const distributionDraft = await prepareRewardRunWhenAvailable(
    state,
    ["claim-staker-rewards"],
    collectTarget,
    "at least two Devnet staker payments to become runnable",
    10,
  );
  if (
    distributionDraft.recipe.eligibleTransactions < 2 ||
    distributionDraft.recipe.accounts.filter(({ payoutRoute }) => payoutRoute === "bitcoin-l1")
      .length < 2
  ) {
    throw new Error(
      `Devnet distribution did not seal two Bitcoin-route payments: ${JSON.stringify(distributionDraft.recipe)}`,
    );
  }
  const distribution = await executePreparedRewardRun(
    state,
    distributionDraft,
    "the API-approved Devnet staker distribution",
  );
  const paymentChildren = distribution.completed.children.filter(
    ({ operation, status }) => operation === "claim-staker-rewards" && status === "confirmed",
  );
  if (paymentChildren.length < 2) {
    throw new Error(
      `Devnet distribution did not confirm two payments: ${JSON.stringify(distribution.completed.children)}`,
    );
  }
  const withdrawalRequestIds = await Promise.all(
    paymentChildren.slice(0, 2).map(withdrawalRequestIdForChild),
  );
  const withdrawalResults = await actor.completeWithdrawalRequests({
    rejectedRequestId: withdrawalRequestIds[0],
    acceptedRequestId: withdrawalRequestIds[1],
  });
  const finishDraft = await prepareRewardRunWhenAvailable(
    state,
    ["settle-accepted-withdrawal", "reclaim-failed-withdrawal"],
    collectTarget,
    "the accepted and rejected Devnet Bitcoin payouts to become finishable",
    10,
  );
  const finish = await executePreparedRewardRun(
    state,
    finishDraft,
    "the API-approved Devnet Bitcoin payout finishers",
  );
  const finishedOperations = new Set(
    finish.completed.children
      .filter(({ status }) => status === "confirmed")
      .map(({ operation }) => operation),
  );
  if (
    !finishedOperations.has("settle-accepted-withdrawal") ||
    !finishedOperations.has("reclaim-failed-withdrawal")
  ) {
    throw new Error(
      `Devnet finish run did not confirm both outcomes: ${JSON.stringify(finish.completed.children)}`,
    );
  }
  return {
    walletPrincipal: created.principal,
    fundingTxid: funding.txid,
    rewardFundingTxid: rewardFunding.txid,
    calculationRunId: calculation.completed.runId,
    collectRunId: collect.completed.runId,
    collectTxid: collect.completed.children[0].txid,
    distributionRunId: distribution.completed.runId,
    paymentTxids: paymentChildren.map(({ txid }) => txid),
    withdrawalRequestIds: withdrawalRequestIds.map(String),
    withdrawalResolutionTxids: {
      rejected: withdrawalResults.rejected.txid,
      accepted: withdrawalResults.accepted.txid,
    },
    finishRunId: finish.completed.runId,
    finishTxids: finish.completed.children.map(({ txid }) => txid),
    backgroundCompletion: true,
  };
}

async function readSynchronizationOperation(state) {
  const payload = await sidekickFetch(state, "/api/v1/sync");
  const operation = payload?.operation;
  if (
    !operation ||
    !["idle", "running", "succeeded", "failed"].includes(operation.status) ||
    !(operation.operationId === null || typeof operation.operationId === "string")
  ) {
    throw new Error(
      `Sidekick returned an invalid synchronization operation: ${JSON.stringify(payload)}`,
    );
  }
  return operation;
}

async function waitForSynchronizationCompletion(state, operationId, label) {
  return await waitFor(
    async () => {
      const operation = await readSynchronizationOperation(state);
      if (operation.operationId !== operationId) {
        throw new Error(
          `Sidekick replaced synchronization ${operationId} with ${operation.operationId ?? "none"}`,
        );
      }
      return operation.status === "running" ? null : operation;
    },
    label,
    180_000,
    250,
  );
}

async function synchronizeSidekick(state, options = {}) {
  const expectedStatus = options.expectedStatus ?? "succeeded";
  const label = options.label ?? "Sidekick synchronization";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await waitFor(
      async () => {
        const operation = await readSynchronizationOperation(state);
        return operation.status === "running" ? null : operation;
      },
      "any existing Sidekick synchronization to finish",
      180_000,
      250,
    );
    const accepted = await sidekickFetch(state, "/api/v1/sync", { method: "POST", body: "{}" });
    const started = accepted?.operation;
    if (!started || typeof started.operationId !== "string") {
      throw new Error(
        `Sidekick did not accept a synchronization operation: ${JSON.stringify(accepted)}`,
      );
    }
    if (started.trigger !== "manual") {
      await waitForSynchronizationCompletion(
        state,
        started.operationId,
        "the competing automatic Sidekick synchronization to finish",
      );
      continue;
    }
    const completed =
      started.status === "running"
        ? await waitForSynchronizationCompletion(state, started.operationId, label)
        : started;
    if (completed.status !== expectedStatus) {
      throw new Error(
        `${label} ${completed.operationId} finished ${completed.status}, expected ${expectedStatus}: ${JSON.stringify(completed.error)}`,
      );
    }
    return completed;
  }
  throw new Error(
    `${label} could not start because automatic synchronization kept winning the race`,
  );
}

function synchronizationReconciliation(operation, label) {
  const reconciliation = operation.result?.reconciliation;
  if (!reconciliation) {
    throw new Error(
      `${label} ${operation.operationId ?? "unknown"} did not include a reconciliation result`,
    );
  }
  return reconciliation;
}

async function interruptSynchronization(
  state,
  pathContains,
  { target = "api", passCount = 1 } = {},
) {
  await proxyControl(target, "fail-after", { pathContains, passCount, statusCode: 503 });
  try {
    const operation = await synchronizeSidekick(state, {
      expectedStatus: "failed",
      label: `Interrupted synchronization through ${target} ${pathContains}`,
    });
    return {
      target,
      pathContains,
      operationId: operation.operationId,
      status: operation.status,
      error: operation.error,
    };
  } finally {
    await proxyControl(target, "pass");
  }
}

async function activePool(state) {
  const connection = await connectExistingManager(state);
  const deploymentRequirements = await sidekickFetch(
    state,
    "/api/v1/deployment-requirements/refresh",
    { method: "POST" },
  );
  const transactionIndex = deploymentRequirements.checks?.find(
    ({ id }) => id === "node-transaction-index",
  );
  if (!deploymentRequirements.requiredReady || transactionIndex?.status !== "pass") {
    throw new Error(
      `Devnet did not prove the required node deployment features: ${JSON.stringify(deploymentRequirements)}`,
    );
  }
  const actor = createOperatorActor();
  await ensureRewardPhase(actor);
  const positions = [];
  const observerBefore = await readObserverMetrics();
  const firstPosition = await actor.updateFees(100);
  positions.push(firstPosition);
  const observer = await verifyRealObserverCallback(state, firstPosition, observerBefore);
  positions.push(await actor.updateFees(250));
  positions.push(await actor.stake(DEVNET_ACCOUNTS.staker1, { bitcoinPayoutMaxFeeSats: 1_000n }));
  positions.push(await actor.stake(DEVNET_ACCOUNTS.staker2, { bitcoinPayoutMaxFeeSats: 1_000n }));
  positions.push(await actor.stake(DEVNET_ACCOUNTS.staker3));
  positions.push(
    await actor.stakeUpdate(DEVNET_ACCOUNTS.staker2, { bitcoinPayoutMaxFeeSats: 1_000n }),
  );
  positions.push(await actor.unstake(DEVNET_ACCOUNTS.staker3));

  // Let the API enumeration seal its page checkpoint, then fail the first node verification read.
  // Restart recovery must reuse that sealed, exact-tip-fenced roster instead of rediscovering it.
  const rosterInterruption = await interruptSynchronization(state, "/get-bond-membership", {
    target: "node",
    passCount: 0,
  });
  await restartSidekick(state);
  const firstSync = await synchronizeSidekick(state, { label: "Roster resume synchronization" });
  const firstSyncResult = synchronizationReconciliation(firstSync, "Roster resume synchronization");
  if (!firstSyncResult.stakers.resumed) {
    throw new Error("Roster synchronization did not resume after restart");
  }
  let eventInterruption;
  await proxyControl("observer", "ack");
  try {
    positions.push(await actor.updateFees(300));
    positions.push(await actor.updateFees(400));
    eventInterruption = await interruptSynchronization(state, "/extended/v2/smart-contracts/");
  } finally {
    await proxyControl("observer", "pass");
  }
  await restartSidekick(state);
  // Startup anti-entropy owns this restart recovery and runs before the HTTP control plane can
  // accept a manual sync. The injected failure allowed exactly one event page to commit, so a
  // successful startup manager-activity run necessarily continued that persisted cursor.
  const eventResumeMetrics = await waitFor(
    async () => {
      const metrics = await readObserverMetrics();
      return metrics.managerSuccesses > 0 ? metrics : null;
    },
    "startup manager-activity reconciliation to resume the event cursor",
    120_000,
    250,
  );
  const replay = await synchronizeSidekick(state, {
    label: "Manager event replay synchronization",
  });
  const replayResult = synchronizationReconciliation(
    replay,
    "Manager event replay synchronization",
  );
  if (firstSyncResult.stakers.activeStakers < 2) throw new Error("Expected at least two stakers");
  if (replayResult.events.newEvents !== 0) throw new Error("Event replay inserted duplicates");

  const before = await fetch("http://127.0.0.1:20443/v2/pox").then((response) => response.json());
  const after = await actor.waitFor(
    async () => {
      const pox = await fetch("http://127.0.0.1:20443/v2/pox").then((response) => response.json());
      return pox.reward_cycle_id === before.reward_cycle_id ? null : pox;
    },
    "the next PoX reward cycle",
    240_000,
  );
  const cycleSync = await synchronizeSidekick(state, { label: "Reward-cycle synchronization" });
  const cycleSyncResult = synchronizationReconciliation(cycleSync, "Reward-cycle synchronization");
  const rewardRun = await runGasWalletCollectScenario(state, actor);
  return {
    connection,
    deploymentRequirements: {
      status: deploymentRequirements.status,
      requiredReady: deploymentRequirements.requiredReady,
      transactionIndex: transactionIndex.status,
    },
    observer,
    transactionIds: positions.map((position) => position.txid),
    interruptions: { roster: rosterInterruption, events: eventInterruption },
    firstSync: firstSyncResult,
    eventResume: {
      startupAntiEntropy: true,
      managerSuccesses: eventResumeMetrics.managerSuccesses,
    },
    replay: replayResult,
    cycle: { before: before.reward_cycle_id, after: after.reward_cycle_id },
    cycleSync: cycleSyncResult,
    rewardRun,
  };
}

function prometheusMetric(metrics, name, labels = null) {
  const prefix = labels === null ? name : `${name}{${labels}}`;
  const line = metrics.split("\n").find((candidate) => candidate.startsWith(`${prefix} `));
  if (!line) throw new Error(`Sidekick metrics did not include ${prefix}`);
  const value = Number(line.slice(prefix.length + 1));
  if (!Number.isFinite(value)) throw new Error(`Sidekick metric ${prefix} was not numeric`);
  return value;
}

async function readObserverMetrics() {
  const response = await fetch("http://127.0.0.1:3998/metrics");
  if (!response.ok) throw new Error(`Sidekick metrics returned HTTP ${response.status}`);
  const metrics = await response.text();
  const domain = (name, label) => prometheusMetric(metrics, name, `domain="${label}"`);
  return {
    deliveries: prometheusMetric(metrics, "sidekick_observer_deliveries_total"),
    verified: prometheusMetric(metrics, "sidekick_observer_node_verified"),
    quarantined: prometheusMetric(metrics, "sidekick_observer_quarantined"),
    queueDepth: prometheusMetric(metrics, "sidekick_observer_queue_depth"),
    currentSuccesses: domain("sidekick_observer_reconciliation_successes_total", "current"),
    currentLatencySamples: domain(
      "sidekick_observer_reconciliation_latency_seconds_count",
      "current",
    ),
    currentWithinTwoSeconds: domain(
      "sidekick_observer_reconciliation_within_two_seconds_total",
      "current",
    ),
    managerSuccesses: domain(
      "sidekick_observer_reconciliation_successes_total",
      "manager-activity",
    ),
    managerLatencySamples: domain(
      "sidekick_observer_reconciliation_latency_seconds_count",
      "manager-activity",
    ),
  };
}

async function verifyRealObserverCallback(state, transaction, before) {
  const blockHeight = transaction.confirmed.block_height;
  const blockHash = transaction.confirmed.block_hash;
  if (
    !Number.isSafeInteger(blockHeight) ||
    typeof blockHash !== "string" ||
    !/^0x[0-9a-f]{64}$/i.test(blockHash)
  ) {
    throw new Error(
      `Confirmed Devnet transaction did not expose its canonical block anchor: ${JSON.stringify(transaction.confirmed)}`,
    );
  }
  const blockResponse = await fetch(`http://127.0.0.1:3999/extended/v2/blocks/${blockHeight}`);
  if (!blockResponse.ok) {
    throw new Error(`Stacks API block projection returned HTTP ${blockResponse.status}`);
  }
  const block = await blockResponse.json();
  const rawIndexBlockHash = block.index_block_hash;
  if (
    block.canonical !== true ||
    block.height !== blockHeight ||
    typeof block.hash !== "string" ||
    block.hash.toLowerCase() !== blockHash.toLowerCase() ||
    typeof rawIndexBlockHash !== "string" ||
    !/^(?:0x)?[0-9a-f]{64}$/i.test(rawIndexBlockHash)
  ) {
    throw new Error(
      `Stacks API did not prove the confirmed transaction's canonical index block: ${JSON.stringify(block)}`,
    );
  }
  const indexBlockHash = `0x${rawIndexBlockHash.replace(/^0x/i, "").toLowerCase()}`;
  let lastMetrics = before;
  let metrics;
  try {
    metrics = await waitFor(
      async () => {
        const current = await readObserverMetrics();
        lastMetrics = current;
        return current.deliveries > before.deliveries &&
          current.verified > before.verified &&
          current.currentSuccesses > before.currentSuccesses &&
          current.currentLatencySamples > before.currentLatencySamples &&
          current.managerSuccesses > before.managerSuccesses &&
          current.managerLatencySamples > before.managerLatencySamples &&
          current.queueDepth === 0
          ? current
          : null;
      },
      "a real stacks-node callback to verify and reconcile",
      120_000,
      500,
    );
  } catch (error) {
    const support = await sidekickFetch(state, "/api/v1/support-bundle").catch((supportError) => ({
      error: supportError instanceof Error ? supportError.message : String(supportError),
    }));
    const observer = support.sections?.observer?.data ?? support;
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify({ before, lastMetrics, observer })}`,
    );
  }
  const bundle = await sidekickFetch(state, "/api/v1/support-bundle");
  const observer = bundle.sections?.observer?.data;
  const verified = observer?.inbox?.lastVerifiedStacksBlock;
  if (
    !observer?.listening ||
    verified?.height < blockHeight ||
    (verified.height === blockHeight &&
      verified.indexBlockHash?.toLowerCase() !== indexBlockHash.toLowerCase())
  ) {
    throw new Error(
      `Sidekick did not retain the real callback's canonical anchor: ${JSON.stringify({ blockHeight, indexBlockHash, observer })}`,
    );
  }
  if (metrics.quarantined > before.quarantined) {
    throw new Error("The real stacks-node callback was quarantined instead of verified");
  }
  return {
    txid: transaction.txid,
    blockHeight,
    indexBlockHash,
    deliveryDelta: metrics.deliveries - before.deliveries,
    verifiedDelta: metrics.verified - before.verified,
    currentLatencySamples: metrics.currentLatencySamples - before.currentLatencySamples,
    currentWithinTwoSeconds: metrics.currentWithinTwoSeconds - before.currentWithinTwoSeconds,
    lastCurrentLatencySeconds: observer.reconciliation.domains.current.callbackLatency.lastSeconds,
    lastManagerActivityLatencySeconds:
      observer.reconciliation.domains["manager-activity"].callbackLatency.lastSeconds,
  };
}

async function eventResumeScenario(state) {
  const actor = createOperatorActor();
  const transactions = [];
  let interruption;
  await proxyControl("observer", "ack");
  try {
    transactions.push(await actor.updateFees(500), await actor.updateFees(600));
    interruption = await interruptSynchronization(state, "/extended/v2/smart-contracts/");
  } finally {
    await proxyControl("observer", "pass");
  }
  await restartSidekick(state);
  const resumedMetrics = await waitFor(
    async () => {
      const metrics = await readObserverMetrics();
      return metrics.managerSuccesses > 0 ? metrics : null;
    },
    "startup manager-activity reconciliation to resume the standalone event cursor",
    120_000,
    250,
  );
  const replay = await synchronizeSidekick(state, {
    label: "Standalone event replay synchronization",
  });
  const replayResult = synchronizationReconciliation(
    replay,
    "Standalone event replay synchronization",
  );
  if (replayResult.events.newEvents !== 0) throw new Error("Event replay inserted duplicates");
  return {
    transactionIds: transactions.map(({ txid }) => txid),
    interruption,
    resumed: {
      startupAntiEntropy: true,
      managerSuccesses: resumedMetrics.managerSuccesses,
    },
    replay: replayResult.events,
  };
}

async function connectWithCleanDatabase(state) {
  const originalContainer = state.containerName;
  const connectionContainer = `${originalContainer}-connection`;
  const connectionVolume = `${state.volumeName}-connection`;
  await stopSidekick(originalContainer);
  try {
    await startSidekick(state, { container: connectionContainer, volume: connectionVolume });
    const connection = await sidekickFetch(state, "/api/v1/connection");
    if (connection.status !== "connected") {
      throw new Error(`Clean database connection was ${connection.status}`);
    }
    const observed = await sidekickFetch(state, "/api/v1/status?refresh=1");
    return {
      connectionStatus: connection.status,
      bindingSource: connection.deploymentIdentity.stored?.bindingSource ?? null,
      managerTier: observed.manager.source.tier,
      readiness: observed.readiness?.status ?? observed.setup?.status ?? "unavailable",
    };
  } finally {
    await stopSidekick(connectionContainer);
    run("docker", ["volume", "rm", "--force", connectionVolume], {
      allowedExitCodes: [0, 1],
    });
    await startSidekick(state, { container: originalContainer, volume: state.volumeName });
  }
}

async function restartSidekick(state) {
  await stopSidekick(state.containerName);
  await startSidekick(state);
  const status = await sidekickFetch(state, "/api/v1/status");
  if (status.managerPrincipal !== managerPrincipal) throw new Error("Restart lost manager state");
  return { managerPrincipal: status.managerPrincipal, rosterTotal: status.rosterTotal };
}

async function installedManagerProfileScenario(state) {
  const actor = createOperatorActor();
  const alternateSbtcDeployer = DEVNET_ACCOUNTS.staker1;
  const alternateManagerAccount = DEVNET_ACCOUNTS.staker2;
  const dependencyDeployments = [];
  for (const contractName of ["sbtc-registry", "sbtc-token", "sbtc-withdrawal"]) {
    const source = await readFile(
      resolve(root, `contracts/upstream/sbtc-mainnet/${contractName}.clar`),
      "utf8",
    );
    dependencyDeployments.push(
      await actor.deployContract(contractName, source, 3, alternateSbtcDeployer),
    );
  }

  const builtInSbtcDeployer = DEVNET_ACCOUNTS.deployer.address;
  const builtInSource = await readFile(
    resolve(root, "contracts/reference-manager/generated/devnet/signer-manager.clar"),
    "utf8",
  );
  const replacementCount = builtInSource.split(builtInSbtcDeployer).length - 1;
  if (replacementCount !== 13) {
    throw new Error(`Expected 13 manager sBTC substitutions, found ${replacementCount}`);
  }
  const alternateSource = builtInSource.replaceAll(
    builtInSbtcDeployer,
    alternateSbtcDeployer.address,
  );
  const managerDeployment = await actor.deployManager(
    alternateSource,
    alternateManagerAccount,
    "signer-manager-alt",
  );
  const alternateManager = managerDeployment.principal;
  const unknown = JSON.parse(
    run("docker", [
      "run",
      "--rm",
      ...sidekickRuntimeArgs(state, state.volumeName, {
        manager: alternateManager,
        publish: false,
      }),
      state.sidekickImage,
      "manager",
      "verify",
      alternateManager,
    ]),
  );
  if (
    unknown.manager?.source?.tier !== "unrecognized" ||
    unknown.manager?.attachAllowed !== true ||
    unknown.manager?.automationEligible !== false
  ) {
    throw new Error(
      `Alternate manager did not begin read-only: ${JSON.stringify(unknown.manager)}`,
    );
  }

  const profilesDirectory = resolve(runtimeDirectory, "trusted-manager-acceptance");
  await rm(profilesDirectory, { recursive: true, force: true });
  await mkdir(profilesDirectory, { recursive: true });
  const generated = JSON.parse(
    run("docker", [
      "run",
      "--rm",
      ...sidekickRuntimeArgs(state, state.volumeName, {
        manager: alternateManager,
        publish: false,
        profileOutputDirectory: profilesDirectory,
      }),
      state.sidekickImage,
      "manager",
      "trust",
      alternateManager,
      "--output",
      "/profiles/alternate-manager.json",
    ]),
  );
  if (generated.profile?.tier !== "reference-render") {
    throw new Error(`Trust helper did not prove a reference render: ${JSON.stringify(generated)}`);
  }

  const originalContainer = state.containerName;
  const profileContainer = `${originalContainer}-trusted-profile`;
  const profileVolume = `${state.volumeName}-trusted-profile`;
  await stopSidekick(originalContainer);
  try {
    await startSidekick(state, {
      container: profileContainer,
      volume: profileVolume,
      manager: alternateManager,
      trustedProfilesDirectory: profilesDirectory,
    });
    const status = await sidekickFetch(state, "/api/v1/status");
    if (
      status.manager?.source?.tier !== "reference-render" ||
      status.manager?.source?.origin !== "operator-installed" ||
      status.manager?.provenance?.status !== "verified" ||
      status.manager?.automationEligible !== true
    ) {
      throw new Error(
        `Installed reference render did not pass the built-in eligibility gate: ${JSON.stringify(status.manager)}`,
      );
    }
    return {
      managerPrincipal: alternateManager,
      sourceSha256: status.manager.source.sha256,
      profileId: status.manager.source.profileId,
      beforeInstall: unknown.manager.source.tier,
      afterInstall: status.manager.source.tier,
      provenance: status.manager.provenance.status,
      automationEligible: status.manager.automationEligible,
      dependencyTxids: dependencyDeployments.map(({ txid }) => txid).filter(Boolean),
      managerTxid: managerDeployment.txid ?? null,
    };
  } finally {
    await stopSidekick(profileContainer);
    run("docker", ["volume", "rm", "--force", profileVolume], { allowedExitCodes: [0, 1] });
    await rm(profilesDirectory, { recursive: true, force: true });
    await startSidekick(state, { container: originalContainer, volume: state.volumeName });
  }
}

async function filesUnder(paths) {
  const files = [];
  const visit = async (path) => {
    const entries = await readdir(path, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (!entries) {
      const content = await readFile(path).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (content) files.push({ path, content });
      return;
    }
    for (const entry of entries) await visit(resolve(path, entry.name));
  };
  for (const path of paths) await visit(path);
  return files;
}

async function scanArtifacts(state, paths) {
  const devnetSettings = await readFile(resolve(harnessDirectory, "settings/Devnet.toml"), "utf8");
  const forbidden = [
    state.authToken,
    ...Object.values(DEVNET_ACCOUNTS).map(({ privateKey }) => privateKey),
    ...[...devnetSettings.matchAll(/mnemonic\s*=\s*"([^"]+)"/g)].map((match) => match[1]),
    ...[...devnetSettings.matchAll(/stacks_signers_keys\s*=\s*\["([^"]+)"\]/g)].map(
      (match) => match[1],
    ),
    process.env.STACKS_API_KEY,
  ].filter(Boolean);
  for (const { path, content } of await filesUnder(paths)) {
    const text = content.toString("utf8");
    if (/sidekick-devnet-[0-9a-f]{48}/i.test(text)) {
      throw new Error(`Sidekick bootstrap credential found in ${path}`);
    }
    for (const secret of forbidden) {
      if (content.includes(Buffer.from(secret))) {
        throw new Error(`Sensitive test material found in ${path}`);
      }
    }
  }
}

async function collectDiagnostics(state, result) {
  const runArtifacts = resolve(artifactDirectory, state.runId);
  await mkdir(runArtifacts, { recursive: true });
  const resultPath = resolve(runArtifacts, "result.json");
  const logs = [];
  for (const [name, source] of Object.entries(state.logs)) {
    const destination = resolve(runArtifacts, `${name}.log`);
    await copyFile(source, destination).catch(() => {});
    logs.push(destination);
  }
  const resourceUsage = resolve(runArtifacts, "resource-usage.jsonl");
  await copyFile(state.resourceUsagePath, resourceUsage).catch(() => {});
  logs.push(resourceUsage);
  const containerLog = resolve(runArtifacts, "sidekick.log");
  await writeFile(
    containerLog,
    `${run("docker", ["logs", state.containerName], { allowedExitCodes: [0, 1] })}\n`,
  );
  logs.push(containerLog);
  const devnetContainers = run(
    "docker",
    [
      "ps",
      "--filter",
      `label=com.docker.compose.project=${clarinetProject}`,
      "--format",
      "{{.Names}}",
    ],
    { allowedExitCodes: [0, 1] },
  );
  for (const name of devnetContainers.split("\n").filter(Boolean)) {
    const destination = resolve(
      runArtifacts,
      `container-${name.replaceAll(/[^a-zA-Z0-9_.-]/g, "_")}.log`,
    );
    await writeFile(
      destination,
      `${run("docker", ["logs", name], { allowedExitCodes: [0, 1], includeStderr: true })}\n`,
    );
    logs.push(destination);
  }
  const imageInspection = {};
  for (const [name, image] of Object.entries(lock.images)) {
    imageInspection[name] = { reference: image.reference, digest: image.digest };
  }
  const sidekickImageId = run(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", state.sidekickImage],
    { allowedExitCodes: [0, 1] },
  );
  const resourceSamples = (await readFile(resourceUsage, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const resourcePeaks = {};
  for (const sample of resourceSamples) {
    for (const container of sample.containers ?? []) {
      if (!resourcePeaks[container.name]) {
        resourcePeaks[container.name] = {
          image: container.image,
          samples: 0,
          peakCpuPercent: 0,
          peakMemoryBytes: 0,
          peakMemoryPercent: 0,
          peakWritableLayerBytes: 0,
          peakBlockReadBytes: 0,
          peakBlockWriteBytes: 0,
          peakPids: 0,
        };
      }
      const peak = resourcePeaks[container.name];
      peak.samples += 1;
      peak.peakCpuPercent = Math.max(peak.peakCpuPercent, container.cpuPercent ?? 0);
      peak.peakMemoryBytes = Math.max(peak.peakMemoryBytes, container.memoryBytes ?? 0);
      peak.peakMemoryPercent = Math.max(peak.peakMemoryPercent, container.memoryPercent ?? 0);
      peak.peakWritableLayerBytes = Math.max(
        peak.peakWritableLayerBytes,
        container.writableLayerBytes ?? 0,
      );
      peak.peakBlockReadBytes = Math.max(peak.peakBlockReadBytes, container.blockReadBytes ?? 0);
      peak.peakBlockWriteBytes = Math.max(peak.peakBlockWriteBytes, container.blockWriteBytes ?? 0);
      peak.peakPids = Math.max(peak.peakPids, container.pids ?? 0);
    }
  }
  const completedAt = new Date().toISOString();
  const document = {
    schemaVersion: 2,
    status: result.status,
    runId: state.runId,
    startedAt: state.startedAt,
    completedAt,
    fromGenesis: state.fromGenesis,
    gitCommit: state.gitCommit,
    managerPrincipal: state.managerPrincipal,
    host: {
      platform: platform(),
      architecture: arch(),
      nodeVersion: process.version,
    },
    versions: {
      clarinet: lock.clarinet.version,
      stacksCore: lock.stacksCore,
      images: imageInspection,
      sidekick: { reference: state.sidekickImage, imageId: sidekickImageId || null },
      managerSha256: lock.manager.sha256,
    },
    timings: result.timings ?? {},
    resources: {
      sampleIntervalMs: Number(process.env.SIDEKICK_RESOURCE_SAMPLE_INTERVAL_MS ?? "5000"),
      sampleCount: resourceSamples.length,
      containers: resourcePeaks,
    },
    scenarios: result.scenarios ?? {},
    error: result.error ?? null,
  };
  await writeFile(resultPath, `${JSON.stringify(document, null, 2)}\n`);
  try {
    await scanArtifacts(state, [resultPath, ...logs, ...browserArtifactDirectories]);
  } catch (error) {
    // CI uploads evidence even when the scenario fails. Remove every potentially affected output
    // before propagating the scan failure so a detected credential can never be uploaded.
    await Promise.all([
      rm(runArtifacts, { recursive: true, force: true }),
      ...browserArtifactDirectories.map((path) => rm(path, { recursive: true, force: true })),
    ]);
    throw error;
  }
  return { runArtifacts, resultPath };
}

function removeOrphanedHarnessDockerResources() {
  const containerIds = new Set();
  for (const filter of [
    `label=com.docker.compose.project=${clarinetProject}`,
    "name=signer-sidekick-e2e-",
  ]) {
    const output = run("docker", ["ps", "--all", "--filter", filter, "--format", "{{.ID}}"], {
      allowedExitCodes: [0, 1],
    });
    for (const id of output.split("\n").filter(Boolean)) containerIds.add(id);
  }
  for (const id of containerIds) {
    run("docker", ["rm", "--force", id], { allowedExitCodes: [0, 1] });
  }

  const volumes = run("docker", ["volume", "ls", "--format", "{{.Name}}"], {
    allowedExitCodes: [0, 1],
  });
  for (const volume of volumes
    .split("\n")
    .filter((name) => name.startsWith("signer-sidekick-e2e-"))) {
    run("docker", ["volume", "rm", "--force", volume], { allowedExitCodes: [0, 1] });
  }

  const networks = run("docker", ["network", "ls", "--format", "{{.Name}}"], {
    allowedExitCodes: [0, 1],
  });
  for (const network of networks
    .split("\n")
    .filter((name) => name.startsWith(`${clarinetProject}.`))) {
    run("docker", ["network", "rm", network], { allowedExitCodes: [0, 1] });
  }
}

async function down(options = {}) {
  const state = await existingState();
  if (!state) {
    removeOrphanedHarnessDockerResources();
    await rm(runtimeDirectory, { recursive: true, force: true });
    log("No Devnet runtime state exists; orphan sweep completed");
    return;
  }
  await stopSidekick(state.containerName);
  safeProcessKill(state.pids?.clarinet, "SIGINT");
  safeProcessKill(state.pids?.proxy, "SIGTERM");
  safeProcessKill(state.pids?.resource, "SIGTERM");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  for (const pid of [state.pids?.clarinet, state.pids?.proxy, state.pids?.resource]) {
    if (running(pid)) safeProcessKill(pid, "SIGKILL");
  }
  const clarinetContainers = run(
    "docker",
    [
      "ps",
      "--all",
      "--filter",
      `label=com.docker.compose.project=${clarinetProject}`,
      "--format",
      "{{.ID}}",
    ],
    { allowedExitCodes: [0, 1] },
  );
  for (const id of clarinetContainers.split("\n").filter(Boolean)) {
    run("docker", ["rm", "--force", id], { allowedExitCodes: [0, 1] });
  }
  run("docker", ["volume", "rm", "--force", state.volumeName], { allowedExitCodes: [0, 1] });
  removeOrphanedHarnessDockerResources();
  if (!options.keepRuntime) await rm(runtimeDirectory, { recursive: true, force: true });
  await releaseHarnessLock(harnessLockPath, state.runId);
  log("Devnet containers, processes, volume, and runtime credentials removed");
}

async function status() {
  const state = await existingState();
  if (!state) {
    console.log(JSON.stringify({ status: "stopped" }, null, 2));
    return;
  }
  const node = await fetch("http://127.0.0.1:20443/v2/info")
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  const api = await fetch("http://127.0.0.1:3999/extended/v1/status")
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  const dashboardReady = await fetch("http://127.0.0.1:3998/health/live")
    .then((response) => response.ok)
    .catch(() => false);
  const phase = state.bootstrap?.phase ?? "starting";
  const clarinetRunning = running(state.pids?.clarinet);
  console.log(
    JSON.stringify(
      {
        status: deriveHarnessStatus({ phase, clarinetRunning, dashboardReady }),
        runId: state.runId,
        startedAt: state.startedAt,
        bootstrap: { phase, updatedAt: state.bootstrap?.updatedAt ?? null },
        dashboard: {
          url: "http://127.0.0.1:3998",
          status: dashboardReady ? "ready" : "unavailable",
        },
        managerPrincipal: state.managerPrincipal,
        node: node
          ? { burnBlockHeight: node.burn_block_height, stacksTipHeight: node.stacks_tip_height }
          : null,
        api: api?.chain_tip
          ? {
              burnBlockHeight: api.chain_tip.burn_block_height,
              stacksTipHeight: api.chain_tip.block_height,
            }
          : null,
      },
      null,
      2,
    ),
  );
}

async function scenario(name) {
  const state = await readState();
  if (name === "connect") return await connectExistingManager(state);
  if (name === "active-pool") return await activePool(state);
  if (name === "reward-run") return await runGasWalletCollectScenario(state, createOperatorActor());
  if (name === "clean-connection") return await connectWithCleanDatabase(state);
  if (name === "restart") return await restartSidekick(state);
  if (name === "event-resume") return await eventResumeScenario(state);
  if (name === "trusted-manager-profile") return await installedManagerProfileScenario(state);
  if (name === "failure-injection") return await failureInjection(state);
  throw new Error(
    `Unknown scenario ${name}; use connect, active-pool, reward-run, clean-connection, restart, trusted-manager-profile, failure-injection, or event-resume`,
  );
}

async function failureInjection(state) {
  const failedSync = async (target, mode, additional = {}) => {
    await proxyControl(target, mode, additional);
    try {
      const operation = await synchronizeSidekick(state, {
        expectedStatus: "failed",
        label: `Injected ${target} ${mode} failure`,
      });
      return {
        operationId: operation.operationId,
        status: operation.status,
        error: operation.error,
      };
    } finally {
      await proxyControl(target, "pass");
    }
  };
  const apiRateLimit = await failedSync("api", "status", { statusCode: 429 });
  const apiDisconnect = await failedSync("api", "drop");
  const nodeDisconnect = await failedSync("node", "drop");
  const currentApiStatus = await fetch("http://127.0.0.1:3999/extended/v1/status").then(
    (response) => response.json(),
  );
  currentApiStatus.chain_tip.burn_block_height += 2;
  await proxyControl("api", "fixture", {
    pathContains: "/extended/v1/status",
    body: currentApiStatus,
    fixtureStatus: 200,
  });
  let indexerLag;
  try {
    const operation = await synchronizeSidekick(state, {
      expectedStatus: "failed",
      label: "Injected local-node-behind failure",
    });
    indexerLag = {
      operationId: operation.operationId,
      status: operation.status,
      error: operation.error,
      failClosed: true,
    };
  } finally {
    await proxyControl("api", "pass");
  }
  await synchronizeSidekick(state, { label: "Failure-injection recovery synchronization" });
  return {
    apiRateLimit,
    apiDisconnect,
    nodeDisconnect,
    indexerLag,
    recovered: true,
  };
}

async function recordScenario(result, name, action) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const value = await action();
    result.scenarios[name] = value;
    return value;
  } finally {
    result.timings[name] = {
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
    };
  }
}

async function test() {
  let state;
  let failure;
  const stateAtStart = await existingState();
  const result = { status: "fail", scenarios: {}, timings: {} };
  try {
    const bootstrapStartedAt = new Date().toISOString();
    const bootstrapStarted = performance.now();
    state = await up();
    result.timings.bootstrap = {
      startedAt: bootstrapStartedAt,
      completedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - bootstrapStarted),
    };
    await recordScenario(result, "activePool", async () => await activePool(state));
    await recordScenario(result, "restart", async () => await restartSidekick(state));
    await recordScenario(
      result,
      "cleanConnection",
      async () => await connectWithCleanDatabase(state),
    );
    await recordScenario(result, "liveDashboard", async () => {
      run("pnpm", ["test:e2e:dashboard:live"], {
        env: { SIDEKICK_LIVE_PHASE: "inspect" },
      });
      return { status: "pass" };
    });
    await recordScenario(result, "walletAction", async () => {
      run("pnpm", ["test:e2e:dashboard:live"], {
        env: { SIDEKICK_LIVE_PHASE: "action" },
      });
      return { status: "pass", action: "update-fees" };
    });

    const smokeEnvironment = {
      SIDEKICK_NETWORK: "devnet",
      STACKS_NODE_RPC_URL: "http://127.0.0.1:21443",
      STACKS_API_URL: "http://127.0.0.1:13999",
      SIDEKICK_MANAGER_PRINCIPAL: managerPrincipal,
      SIDEKICK_SMOKE_EXPECT_MIN_STAKERS: "2",
      SIDEKICK_SMOKE_IMAGE: state.sidekickImage,
      SIDEKICK_SMOKE_BUILD: "0",
      SIDEKICK_STAKER_PAGE_LIMIT: "2",
      SIDEKICK_EVENT_PAGE_LIMIT: "1",
    };
    await recordScenario(result, "externalSmoke", async () => {
      run("pnpm", ["test:regtest:external"], { env: smokeEnvironment });
      run("pnpm", ["test:container:external"], { env: smokeEnvironment });
      return { status: "pass" };
    });

    await recordScenario(
      result,
      "trustedManagerProfile",
      async () => await installedManagerProfileScenario(state),
    );
    await recordScenario(result, "failureInjection", async () => await failureInjection(state));
    result.status = "pass";
  } catch (error) {
    result.error = error.stack ?? error.message;
    failure = error;
  } finally {
    const discoveredState = state ?? (await existingState());
    const cleanupState =
      state ?? (discoveredState?.runId !== stateAtStart?.runId ? discoveredState : null);
    if (cleanupState) {
      let artifactError;
      try {
        const artifacts = await collectDiagnostics(cleanupState, result);
        log(`Result: ${artifacts.resultPath}`);
      } catch (error) {
        artifactError = error;
        log(`Artifact safety/collection failed: ${error.message}`);
      }
      if (artifactError || result.status === "pass" || !keepOnFailure) await down();
      else log("Keeping failed environment running because --keep-on-failure was set");
      failure ??= artifactError;
    }
  }
  if (failure) throw failure;
}

if (command === "doctor") {
  run("docker", ["info"]);
  run(process.execPath, ["scripts/verify-devnet-lock.mjs", "--offline"]);
  const clarinet = await resolveClarinet();
  console.log(JSON.stringify({ status: "pass", docker: true, clarinet }, null, 2));
} else if (command === "up") {
  const stateAtStart = await existingState();
  try {
    await up();
  } catch (error) {
    const stateAfterFailure = await existingState();
    if (stateAfterFailure && stateAfterFailure.runId !== stateAtStart?.runId) await down();
    throw error;
  }
} else if (command === "down") {
  await down();
} else if (command === "reset") {
  await down();
  await up();
} else if (command === "status") {
  await status();
} else if (command === "scenario") {
  console.log(JSON.stringify(await scenario(process.argv[3]), null, 2));
} else if (command === "mine") {
  const count = Number(process.argv[3] ?? "1");
  if (!Number.isSafeInteger(count) || count < 1 || count > 100)
    throw new Error("mine count must be 1-100");
  const actor = createOperatorActor();
  for (let index = 0; index < count; index += 1) await actor.mineBurnBlock();
  console.log(JSON.stringify(await actor.nodeInfo(), null, 2));
} else if (command === "test") {
  await test();
} else {
  console.log(`Signer Sidekick PoX-5 Devnet harness

Usage:
  pnpm e2e:devnet:doctor
  pnpm e2e:devnet:up [--no-build]
  pnpm e2e:devnet:scenario connect|active-pool|reward-run|clean-connection|restart|trusted-manager-profile|failure-injection|event-resume
  pnpm e2e:devnet:mine [count]
  pnpm e2e:devnet:status
  pnpm e2e:devnet:reset
  pnpm e2e:devnet:down
  pnpm e2e:devnet:test [--keep-on-failure]
`);
}
