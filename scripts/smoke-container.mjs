import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const requiredEnvironment = [
  "SIDEKICK_NETWORK",
  "STACKS_NODE_RPC_URL",
  "STACKS_API_URL",
  "SIDEKICK_MANAGER_PRINCIPAL",
];
for (const name of requiredEnvironment) {
  if (!process.env[name]?.trim()) throw new Error(`${name} is required`);
}

const image = process.env.SIDEKICK_SMOKE_IMAGE?.trim() || "signer-sidekick:smoke";
const buildImage = process.env.SIDEKICK_SMOKE_BUILD !== "0";
const expectedMinimumStakers = Number.parseInt(
  process.env.SIDEKICK_SMOKE_EXPECT_MIN_STAKERS ?? "0",
  10,
);
if (!Number.isSafeInteger(expectedMinimumStakers) || expectedMinimumStakers < 0) {
  throw new Error("SIDEKICK_SMOKE_EXPECT_MIN_STAKERS must be a non-negative integer");
}

const suffix = `${process.pid}-${Date.now()}`;
const volumeName = `signer-sidekick-smoke-${suffix}`;
const containerName = `signer-sidekick-smoke-${suffix}`;
const authToken = "sidekick-container-smoke-token-0001";
const managerPrincipal = process.env.SIDEKICK_MANAGER_PRINCIPAL.trim();
const trustedManagerProfilesDirectory = process.env.SIDEKICK_TRUSTED_MANAGER_PROFILES_DIR?.trim()
  ? resolve(process.env.SIDEKICK_TRUSTED_MANAGER_PROFILES_DIR.trim())
  : null;

function dockerReachableUrl(value) {
  const url = new URL(value.trim());
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1") {
    url.hostname = "host.docker.internal";
  }
  return url.toString().replace(/\/$/, "");
}

function runDocker(args, options = {}) {
  const allowedExitCodes = options.allowedExitCodes ?? [0];
  const result = spawnSync("docker", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowedExitCodes.includes(result.status)) {
    throw new Error(
      `docker ${args.slice(0, 4).join(" ")} failed with exit ${result.status}\n` +
        `${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function parseJson(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error.message}\n${output.slice(0, 2_000)}`);
  }
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const runtimeEnvironment = [
  "--env",
  `SIDEKICK_NETWORK=${process.env.SIDEKICK_NETWORK.trim()}`,
  "--env",
  `STACKS_NODE_RPC_URL=${dockerReachableUrl(process.env.STACKS_NODE_RPC_URL)}`,
  "--env",
  `STACKS_API_URL=${dockerReachableUrl(process.env.STACKS_API_URL)}`,
  "--env",
  `SIDEKICK_MANAGER_PRINCIPAL=${managerPrincipal}`,
  "--env",
  `SIDEKICK_AUTH_TOKEN=${authToken}`,
];
for (const name of [
  "SIDEKICK_NETWORK_ID",
  "STACKS_API_KEY",
  "STACKS_API_KEY_HEADER",
  "SIDEKICK_FORECAST_HORIZON_CYCLES",
  "SIDEKICK_MAX_API_BURN_BLOCK_LAG",
  "SIDEKICK_STAKER_PAGE_LIMIT",
  "SIDEKICK_EVENT_PAGE_LIMIT",
]) {
  if (process.env[name]?.trim()) runtimeEnvironment.push("--env", name);
}
if (trustedManagerProfilesDirectory) {
  runtimeEnvironment.push(
    "--env",
    "SIDEKICK_TRUSTED_MANAGER_PROFILES_DIR=/etc/sidekick/trusted-managers",
  );
}

const hardenedRuntime = [
  "--add-host",
  "host.docker.internal:host-gateway",
  "--read-only",
  "--tmpfs",
  "/tmp:size=64m,mode=1777",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges:true",
  "--mount",
  `source=${volumeName},target=/data`,
  ...(trustedManagerProfilesDirectory
    ? [
        "--mount",
        `type=bind,source=${trustedManagerProfilesDirectory},target=/etc/sidekick/trusted-managers,readonly`,
      ]
    : []),
  ...runtimeEnvironment,
];

function runCli(args, allowedExitCodes = [0]) {
  return parseJson(
    runDocker(["run", "--rm", ...hardenedRuntime, image, ...args], { allowedExitCodes }),
    args.join(" "),
  );
}

let volumeCreated = false;
let containerCreated = false;
try {
  if (buildImage) runDocker(["build", "--tag", image, "."]);
  runDocker(["image", "inspect", image]);
  runDocker(["volume", "create", volumeName]);
  volumeCreated = true;

  const configuration = runCli(["config", "validate"]);
  invariant(configuration.valid === true, "Configuration validation failed");
  invariant(
    configuration.config.network === process.env.SIDEKICK_NETWORK,
    "Container used the wrong network",
  );
  if (process.env.SIDEKICK_NETWORK_ID?.trim()) {
    invariant(
      configuration.config.expectedNetworkId === Number(process.env.SIDEKICK_NETWORK_ID),
      "Container did not receive SIDEKICK_NETWORK_ID",
    );
  }

  const doctor = runCli(["doctor"]);
  invariant(doctor.status === "ok", "Database doctor failed");
  invariant(doctor.database.foreignKeys === true, "SQLite foreign keys are disabled");

  const preflight = runCli(["preflight"]);
  invariant(preflight.result.status !== "fail", "Connected preflight failed");
  invariant(preflight.result.pox.pox5Available === true, "PoX-5 is unavailable");

  const attach = runCli(["attach", managerPrincipal]);
  invariant(attach.manager.attachAllowed === true, "Manager attachment was rejected");
  invariant(attach.registration?.registered === true, "Manager is not registered");
  invariant(attach.registration?.signerKeyGrantValid === true, "Manager signer grant is invalid");

  const setup = runCli(["setup", "status", managerPrincipal], [0, 2]);
  invariant(setup.setup.status !== "blocked", "Manager setup is blocked");

  const synchronizations = [];
  for (let run = 0; run < 2; run += 1) {
    const synchronization = runCli(["pool", "sync-stakers", managerPrincipal]);
    invariant(synchronization.result.status === "completed", "Staker sync did not complete");
    invariant(
      synchronization.result.activeStakers >= expectedMinimumStakers,
      `Expected at least ${expectedMinimumStakers} active staker(s)`,
    );
    invariant(
      synchronization.result.unverifiedStxDiscoveries === 0,
      "Staker sync returned unverified STX discoveries",
    );
    invariant(
      synchronization.result.discrepanciesObservedThisInvocation.length === 0,
      "Staker sync returned discrepancies",
    );
    synchronizations.push({
      activeStakers: synchronization.result.activeStakers,
      nodeVerifiedStxPositions: synchronization.result.nodeVerifiedStxPositions,
      pagesProcessed: synchronization.result.pagesProcessed,
      forecastStatus: synchronization.forecast.status,
    });
  }

  const pool = runCli(["pool", "status", managerPrincipal], [0, 2]);
  invariant(pool.forecast.cycles.length > 0, "Pool forecast returned no cycles");

  const rewards = runCli(["rewards", "status", managerPrincipal], [0, 2]);
  invariant(
    rewards.rewards.managerPrincipal === managerPrincipal,
    "Reward status manager mismatch",
  );

  const supportBundleOutput = runDocker([
    "run",
    "--rm",
    ...hardenedRuntime,
    image,
    "export",
    "support-bundle",
    managerPrincipal,
  ]);
  const supportBundle = parseJson(supportBundleOutput, "export support-bundle");
  invariant(supportBundle.schemaVersion === 2, "Support bundle schema mismatch");
  invariant(!supportBundleOutput.includes(authToken), "Support bundle exposed the auth token");
  if (process.env.STACKS_API_KEY) {
    invariant(
      !supportBundleOutput.includes(process.env.STACKS_API_KEY),
      "Support bundle exposed the API key",
    );
  }

  const backup = runCli(["database", "backup", "/data/smoke-backup.sqlite"]);
  invariant(backup.quickCheck === "ok", "SQLite backup quick_check failed");
  const restoredDoctor = parseJson(
    runDocker([
      "run",
      "--rm",
      ...hardenedRuntime,
      "--env",
      "SIDEKICK_DATABASE_PATH=/data/smoke-backup.sqlite",
      image,
      "doctor",
    ]),
    "restored database doctor",
  );
  invariant(restoredDoctor.status === "ok", "Restored database doctor failed");
  invariant(
    restoredDoctor.database.schemaVersion === doctor.database.schemaVersion,
    "Restored database schema version changed",
  );
  invariant(
    restoredDoctor.database.foreignKeys === true,
    "Restored database disabled foreign keys",
  );

  runDocker(["run", "--detach", "--name", containerName, ...hardenedRuntime, image, "serve"]);
  containerCreated = true;

  const httpProbeSource = String.raw`
const base = "http://127.0.0.1:3998";
const token = ${JSON.stringify(authToken)};
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    const response = await fetch(base + "/health/live");
    if (response.ok) break;
  } catch {}
  if (attempt === 29) throw new Error("server did not become live");
  await new Promise((resolve) => setTimeout(resolve, 250));
}
const dashboard = await fetch(base + "/");
const dashboardBody = await dashboard.text();
const denied = await fetch(base + "/api/v1/status");
const ready = await fetch(base + "/health/ready");
const status = await fetch(base + "/api/v1/status", {
  headers: { authorization: "Bearer " + token },
});
const sync = await fetch(base + "/api/v1/sync", {
  method: "POST",
  headers: { authorization: "Bearer " + token, "content-type": "application/json" },
  body: "{}",
});
const syncBody = await sync.json();
const metrics = await (await fetch(base + "/metrics")).text();
console.log(JSON.stringify({
  dashboardStatus: dashboard.status,
  dashboardHasAssets: dashboardBody.includes("/assets/"),
  deniedStatus: denied.status,
  readyStatus: ready.status,
  statusStatus: status.status,
  syncStatus: sync.status,
  syncResult: syncBody.result?.stakers?.status,
  zeroSyncFailures: /sidekick_sync_failures_total 0(?:\n|$)/.test(metrics),
}));
`;
  const http = parseJson(
    runDocker(["exec", containerName, "node", "--input-type=module", "--eval", httpProbeSource]),
    "container HTTP probe",
  );
  invariant(http.dashboardStatus === 200 && http.dashboardHasAssets, "Dashboard probe failed");
  invariant(http.deniedStatus === 401, "Operator API did not reject an unauthenticated request");
  invariant(http.readyStatus === 200, "Readiness probe failed");
  invariant(http.statusStatus === 200, "Authenticated status probe failed");
  invariant(http.syncStatus === 200 && http.syncResult === "completed", "HTTP sync failed");
  invariant(http.zeroSyncFailures === true, "HTTP metrics reported a sync failure");

  const logs = runDocker(["logs", containerName]);
  invariant(
    !logs.includes("operator API request failed"),
    "Container logged an operator API error",
  );

  console.log(
    JSON.stringify(
      {
        status: "pass",
        image,
        network: process.env.SIDEKICK_NETWORK,
        expectedNetworkId: configuration.config.expectedNetworkId ?? null,
        managerPrincipal,
        preflight: preflight.result.status,
        setup: setup.setup.status,
        synchronizations,
        forecast: pool.forecast.status,
        rewards: rewards.rewards.status,
        backup: backup.quickCheck,
        restore: restoredDoctor.status,
        http,
      },
      null,
      2,
    ),
  );
} finally {
  if (containerCreated) {
    runDocker(["rm", "--force", containerName], { allowedExitCodes: [0, 1] });
  }
  if (volumeCreated) {
    runDocker(["volume", "rm", "--force", volumeName], { allowedExitCodes: [0, 1] });
  }
}
