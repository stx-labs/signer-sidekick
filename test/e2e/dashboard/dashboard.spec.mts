import { expect, type Page, test } from "@playwright/test";
import {
  health,
  operationReadiness,
  reconciliationResponse,
  responseFor,
  roster,
  snapshot,
} from "./large-pool-fixture.mjs";

const credential = "fixture-operator-token-32-characters";
const consoleErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  consoleErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("**/api/v1/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(responseFor(route.request().url())),
    });
  });
});

test.afterEach(async ({ page }) => {
  expect(consoleErrors.get(page) ?? []).toEqual([]);
});

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Operator credential").fill(credential);
  await page.getByRole("button", { name: "Open console" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
}

function discardExpectedHttpConsoleError(page: Page, status: number) {
  consoleErrors.set(
    page,
    (consoleErrors.get(page) ?? []).filter(
      (message) => !message.includes(`server responded with a status of ${status}`),
    ),
  );
}

async function openPage(page: Page, id: string, heading: string) {
  const picker = page.getByLabel("Dashboard page");
  if (await picker.isVisible()) await picker.selectOption(id);
  else await page.locator(`.sidebar a[href="#${id}"]`).click();
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
}

type FixtureStep = {
  id: string;
  status: "complete" | "ready" | "pending" | "attention" | "blocked";
  title: string;
  detail: string;
  command: string | null;
};

function freshOnboardingResponse({
  currentStep,
  steps,
  preparation = null,
  verified = null,
}: {
  currentStep: string;
  steps: FixtureStep[];
  preparation?: null | { command: string; expectedMessageHashHex: string; authId: string };
  verified?: null | {
    managerPrincipal: string;
    authId: string;
    signerKeyHex: string;
    signerSignatureHex: string;
    expectedMessageHashHex: string;
    registerSelfCall: {
      contract: string;
      functionName: string;
      arguments: string[];
      signingPrincipal: string;
    };
  };
}) {
  const adminPrincipal = snapshot.managerPrincipal.split(".")[0];
  return {
    onboarding: {
      path: "fresh",
      status: "in-progress",
      currentStep,
      managerPrincipal: snapshot.managerPrincipal,
      updatedAt: "2026-07-17T12:00:00.000Z",
      activationPlan: { status: "ready", steps },
      freshInput: {
        adminPrincipal,
        contractName: "signer-manager",
        authId: "1",
        signerConfigPath: "/path/to/Signer.toml",
      },
      artifact: {
        available: true,
        sourceFile: "signer-manager.clar",
        manifestFile: "signer-manager.deployment.json",
        manifest: {
          operatorReviewRequired: true,
          warnings: [],
          network: "testnet",
          adminPrincipal,
          artifact: {
            sourceSha256: snapshot.manager.source.sha256,
            canonicalSourceSha256: snapshot.manager.source.sha256,
          },
          transaction: { contractName: "signer-manager", clarityVersion: 6 },
        },
      },
      signerGrant: { preparation, verified },
      audit: [],
      safety: {
        acceptsManagerAdminKey: false,
        acceptsSignerPrivateKey: false,
        signsTransactions: false,
        broadcastsTransactions: false,
      },
    },
    wizard: { dismissed: false, dismissedAt: null, updatedAt: null, audit: [] },
  };
}

function deployWalletIntent({
  adminPrincipal,
  source,
  id = "4e011bf7-f291-42c4-a35b-ab299a87ff8c",
}: {
  adminPrincipal: string;
  source: string;
  id?: string;
}) {
  return {
    intent: {
      schemaVersion: 1,
      id,
      action: "deploy-manager",
      network: "mainnet",
      chainId: 1,
      requiredSender: adminPrincipal,
      createdAt: "2026-07-18T18:00:00.000Z",
      expiresAt: "2099-07-18T19:00:00.000Z",
      transaction: {
        method: "stx_deployContract",
        params: {
          name: "signer-manager",
          clarityCode: source,
          clarityVersion: 6,
          network: "mainnet",
          address: adminPrincipal,
          sponsored: false,
          postConditionMode: "deny",
          postConditions: [],
        },
      },
      review: {
        title: "Deploy the reviewed signer manager",
        summary: `Deploy ${adminPrincipal}.signer-manager from ${adminPrincipal} using Clarity 6.`,
        expectedPostState:
          "The exact reviewed manager source is canonical and trusted by Sidekick.",
      },
      seal: { factsSha256: "11".repeat(32), manifestSha256: "22".repeat(32) },
      status: "prepared",
      txid: null,
      verification: null,
    },
  };
}

function walletNetworkSnapshot(
  network: "mainnet" | "testnet" | "devnet" | "regtest",
  chainId: number,
  managerPrincipal: string,
) {
  const value = structuredClone(snapshot);
  value.network = network;
  value.managerPrincipal = managerPrincipal;
  value.preflight.node.networkId = chainId;
  value.preflight.checks = value.preflight.checks.map((check) =>
    check.id === "node-network" ? { ...check, message: `Node network matches ${network}` } : check,
  );
  return value;
}

function registerWalletIntent(actorPrincipal: string) {
  return {
    intent: {
      schemaVersion: 2,
      id: "6ed58dac-c42c-4cb5-ad02-ed50671f3d27",
      action: "register-self",
      network: "pox5-testnet",
      chainId: 0x80000005,
      requiredSender: actorPrincipal,
      createdAt: "2026-07-18T18:00:00.000Z",
      expiresAt: "2099-07-18T19:00:00.000Z",
      transaction: {
        method: "stx_callContract",
        params: {
          contract: snapshot.managerPrincipal,
          functionName: "register-self",
          functionArgs: ["0x01", "0x02", "0x03", "0x04"],
          network: "pox5-testnet",
          address: actorPrincipal,
          sponsored: false,
          postConditionMode: "deny",
          postConditions: [],
        },
      },
      request: { action: "register-self", actorPrincipal },
      review: {
        title: "Register the fresh signer authorization",
        summary: "Register the independently verified signer grant.",
        expectedPostState: "The exact signer key is registered and its PoX-5 grant is valid.",
        fields: [
          { label: "Signer key", value: `02${"12".repeat(32)}` },
          { label: "Signer signature", value: "00".repeat(65) },
          { label: "Manager", value: snapshot.managerPrincipal },
          { label: "Authorization ID", value: "141" },
        ],
      },
      seal: { factsSha256: "11".repeat(32), manifestSha256: "22".repeat(32) },
      status: "prepared",
      txid: null,
      verification: null,
    },
  };
}

function updateFeesWalletIntent(
  actorPrincipal: string,
  status: "submitted" | "mempool" | "complete",
) {
  const base = registerWalletIntent(actorPrincipal).intent;
  const txid = `0x${"cd".repeat(32)}`;
  return {
    intent: {
      ...base,
      action: "update-fees",
      request: { action: "update-fees", actorPrincipal, feeBips: "250" },
      transaction: {
        ...base.transaction,
        params: {
          ...base.transaction.params,
          functionName: "update-fees",
          functionArgs: ["0x0100000000000000fa"],
        },
      },
      review: {
        title: "Update the manager fee",
        summary: "Set the manager fee to 250 basis points.",
        expectedPostState: "The configured manager fee is 250 basis points.",
        fields: [
          { label: "Manager", value: snapshot.managerPrincipal },
          { label: "Sender", value: actorPrincipal },
          { label: "Fee", value: "250 basis points" },
        ],
      },
      status,
      txid,
      verification:
        status === "complete"
          ? {
              outcome: "complete",
              observedAt: "2026-07-19T18:00:00.000Z",
              canonical: true,
              blockHeight: 14_201,
              indexBlockHash: `0x${"ef".repeat(32)}`,
              detail: "The manual refresh verified the fee update.",
            }
          : {
              outcome: status,
              observedAt: "2026-07-19T17:59:00.000Z",
              canonical: null,
              blockHeight: null,
              indexBlockHash: null,
              detail: "The transaction is awaiting canonical confirmation.",
            },
    },
  };
}

function finalVerificationOnboarding() {
  const complete = (id: string, title: string): FixtureStep => ({
    id,
    title,
    status: "complete",
    detail: `${title} complete`,
    command: null,
  });
  return freshOnboardingResponse({
    currentStep: "verify-setup",
    steps: [
      complete("preflight", "Prerequisites"),
      complete("render-manager", "Manager artifact"),
      complete("deploy-manager", "Deploy manager"),
      complete("prepare-signer-grant", "Prepare signer grant"),
      complete("verify-signer-grant", "Verify signer grant"),
      complete("register-manager", "Register manager"),
      {
        id: "verify-setup",
        title: "Verify setup",
        status: "attention",
        detail: "Manager is not yet eligible",
        command: `sidekick setup status '${snapshot.managerPrincipal}'`,
      },
      {
        id: "publish-enrollment-info",
        title: "Publish enrollment information",
        status: "pending",
        detail: "Pending activation",
        command: null,
      },
    ],
  });
}

function engineFixture() {
  const jobId = "3ef4ee75-c4d9-4ee7-980d-4fdb2914ef28";
  const approvalId = "7f8ff935-9cb4-4677-a167-17257625bd14";
  const now = "2026-07-17T12:00:00.000Z";
  const expiresAt = "2026-07-17T12:10:00.000Z";
  const review = {
    adapter: { id: "reference-manager-claim-rewards", revision: 1 },
    network: "pox-5-testnet",
    managerPrincipal: snapshot.managerPrincipal,
    call: {
      contract: snapshot.managerPrincipal,
      functionName: "claim-rewards",
      arguments: [{ name: "reward-cycle", clarityValue: "u95", displayValue: "95" }],
    },
    anchor: {
      stacksBlockHeight: 1_000,
      indexBlockHash: `0x${"1a".repeat(32)}`,
      burnBlockHeight: 900,
      rewardCycle: 95,
      rewardCycleLength: 2_100,
      prepareCycleLength: 100,
      cyclePosition: 1_050,
      phase: "reward",
      checkpoint: "second-half",
    },
    checkpoint: {
      rewardCycle: 95,
      calculationCheckpoint: "first-half",
      lastRewardComputeHeight: 1_000,
      rewardsPerToken: "125000",
    },
    expectedEffect: {
      recipient: { kind: "manager", principal: snapshot.managerPrincipal },
      asset: {
        assetId: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token",
        symbol: "sBTC",
        maximumOutflow: "0",
        unit: "sats",
      },
      postconditions: ["Deny unexpected asset outflows"],
      reconciliationPredicate: "manager reward state records checkpoint 1000",
    },
    fee: {
      snapshot: { state: "missing", feeBips: null, source: "manager read-only" },
      estimatedFeeUstx: "1200",
      maximumFeeUstx: "5000",
      policyRevision: 1,
    },
    hashes: {
      intentSha256: "a".repeat(64),
      policySha256: "b".repeat(64),
      attestationSha256: "c".repeat(64),
    },
    expectedPostState: "The manager stores the exact reward checkpoint and fee snapshot.",
  };
  const job = {
    schemaVersion: 1,
    jobId,
    mode: "assist",
    state: "awaiting_approval",
    stateVersion: 3,
    blockReason: null,
    supersededByJobId: null,
    review,
    approvalWindow: { eligible: true, expiresAt, reason: null },
    approval: null,
    nonce: null,
    attempts: [],
    reconciliation: null,
    createdAt: now,
    updatedAt: now,
  };
  const status = {
    schemaVersion: 1,
    mode: "assist",
    forcedObserve: { active: false, reason: null, actor: null, forcedAt: null },
    adapters: [
      {
        adapter: review.adapter,
        label: "Reference manager claim rewards",
        mode: "assist",
        enabled: true,
        availability: "available",
        blockReason: null,
      },
    ],
    jobs: { active: 1, awaitingApproval: 1, ambiguous: 0 },
    generatedAt: now,
  };
  const summary = {
    jobId,
    mode: "assist",
    state: "awaiting_approval",
    blockReason: null,
    adapter: review.adapter,
    network: review.network,
    managerPrincipal: review.managerPrincipal,
    contract: review.call.contract,
    functionName: review.call.functionName,
    rewardCycle: 95,
    approvalState: "awaiting",
    updatedAt: now,
  };
  const approval = {
    approvalId,
    jobId,
    review,
    approvalSha256: "d".repeat(64),
    actor: "operator-session",
    createdAt: now,
    expiresAt,
    invalidatedAt: null,
    invalidationReason: null,
    version: 0,
  };
  const readiness = {
    ...operationReadiness,
    generatedAt: now,
    checks: operationReadiness.checks.map((check) =>
      check.id === "engine"
        ? { ...check, detail: "Transaction engine adapters are available." }
        : check,
    ),
  };
  return { approval, job, jobId, readiness, status, summary };
}

test("keeps Settings and Signer Health usable when initial operator state fails", async ({
  page,
}) => {
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    if (request.pathname === "/api/v1/status") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "operator_state_temporarily_unavailable", retryable: true }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(responseFor(route.request().url())),
    });
  });

  await page.goto("/#settings");
  await page.getByLabel("Operator credential").fill(credential);
  await page.getByRole("button", { name: "Open console" }).click();

  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByText("Couldn’t load status")).toBeVisible();
  await expect(page.getByLabel("Display name")).toBeVisible();

  await openPage(page, "health", "Signer Health");
  await expect(page.getByRole("heading", { name: "Stacks node" })).toBeVisible();
  discardExpectedHttpConsoleError(page, 503);
});

test("keeps setup read-only until saved progress loads", async ({ page }) => {
  let onboardingAvailable = false;
  let startRequests = 0;
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    if (request.pathname === "/api/v1/onboarding" && route.request().method() === "GET") {
      if (!onboardingAvailable) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "upstream_temporarily_unavailable", retryable: true }),
        });
        return;
      }
    }
    if (request.pathname === "/api/v1/onboarding/start") startRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(responseFor(route.request().url())),
    });
  });

  await login(page);
  await openPage(page, "setup", "Initial Setup");
  await expect(page.getByRole("button", { name: "Retry setup" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Attach Existing Contracts" })).toHaveCount(0);
  expect(startRequests).toBe(0);

  onboardingAvailable = true;
  await page.getByRole("button", { name: "Retry setup" }).click();
  await expect(page.getByRole("button", { name: "Attach Existing Contracts" })).toBeVisible();
  expect(startRequests).toBe(0);
  discardExpectedHttpConsoleError(page, 503);
});

test("blocks manager actions until stale operator state refreshes", async ({ page }) => {
  let current = false;
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    const body =
      request.pathname === "/api/v1/status" && !current
        ? {
            ...snapshot,
            generatedAt: "2026-07-15T12:10:00.000Z",
            freshness: {
              status: "stale",
              snapshotGeneratedAt: "2026-07-15T12:10:00.000Z",
              servedAt: new Date().toISOString(),
              reason: "refresh-failed",
            },
          }
        : responseFor(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await login(page);
  await openPage(page, "manager", "Manager");
  await expect(page.getByRole("button", { name: /Add admin/ })).toBeDisabled();
  current = true;
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByRole("button", { name: /Add admin/ })).toBeEnabled();
});

test("links readiness blockers to their repair pages", async ({ page }) => {
  const readiness = {
    ...operationReadiness,
    checks: [
      {
        id: "control-plane",
        status: "attention",
        detail: "One or more node, API, network, lag, or PoX-5 checks need review.",
      },
      { id: "setup", status: "blocked", detail: "Manager setup is blocked." },
      { id: "engine", status: "ready", detail: "Transaction engine adapters are available." },
    ],
    status: "blocked",
  };
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    const body =
      request.pathname === "/api/v1/operations/readiness" ? readiness : responseFor(request.href);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await login(page);
  await openPage(page, "operations", "Operations");
  const readinessCard = page.locator(".engine-readiness-card");
  await readinessCard.getByRole("button", { name: "Open Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();

  await openPage(page, "operations", "Operations");
  await readinessCard.getByRole("button", { name: "Open Initial Setup" }).click();
  await expect(page.getByRole("heading", { name: "Initial Setup", exact: true })).toBeVisible();
});

test("returns to login with a clear message when the credential is rejected", async ({ page }) => {
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    if (request.pathname === "/api/v1/status") {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "unauthorized" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(responseFor(route.request().url())),
    });
  });

  await page.goto("/");
  await page.getByLabel("Operator credential").fill(credential);
  await page.getByRole("button", { name: "Open console" }).click();

  await expect(page.getByRole("heading", { name: "Operator access" })).toBeVisible();
  await expect(
    page.getByText("The operator credential was rejected. Check it and try again."),
  ).toBeVisible();
  discardExpectedHttpConsoleError(page, 401);
});

test("renders every operator screen without leaking the credential", async ({ page }) => {
  await login(page);
  const navigationTargets = await page
    .locator(".sidebar nav a.item")
    .evaluateAll((items) => items.map((item) => item.getAttribute("href")));
  expect(navigationTargets.slice(0, 6)).toEqual([
    "#overview",
    "#manager",
    "#pool",
    "#rewards",
    "#operations",
    "#health",
  ]);
  const screens = [
    ["health", "Signer Health"],
    ["manager", "Manager"],
    ["pool", "Pool positions"],
    ["rewards", "Rewards"],
    ["operations", "Operations"],
    ["setup", "Initial Setup"],
    ["settings", "Settings"],
    ["enrollment", "Public Pool Page"],
  ];
  for (const [id, heading] of screens) await openPage(page, id, heading);
  await expect(page.locator("body")).not.toContainText(credential);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("treats HTTP 501 engine and readiness endpoints as an unavailable Observe surface", async ({
  page,
}) => {
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    const unavailable =
      request.pathname.startsWith("/api/v1/engine") ||
      request.pathname === "/api/v1/operations/readiness";
    await route.fulfill({
      status: unavailable ? 501 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        unavailable ? { error: "engine_not_implemented" } : responseFor(route.request().url()),
      ),
    });
  });
  await login(page);
  await openPage(page, "operations", "Operations");
  const engine = page.getByRole("region", { name: "Transaction engine" });
  await expect(engine.getByText("Unavailable", { exact: true })).toBeVisible();
  await expect(
    engine.getByText(
      "Transaction execution is unavailable. Monitoring, chain data, and alerts remain available.",
    ),
  ).toBeVisible();
  consoleErrors.set(page, []);
});

test("uses a compact empty state when the transaction engine has no jobs", async ({ page }) => {
  const fixture = engineFixture();
  const emptyStatus = {
    ...fixture.status,
    jobs: { active: 0, awaitingApproval: 0, ambiguous: 0 },
  };

  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    const body =
      request.pathname === "/api/v1/operations/readiness"
        ? fixture.readiness
        : request.pathname === "/api/v1/engine"
          ? emptyStatus
          : request.pathname === "/api/v1/engine/jobs"
            ? { schemaVersion: 1, items: [], nextCursor: null, total: 0 }
            : responseFor(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await login(page);
  await openPage(page, "operations", "Operations");
  await expect(page.getByRole("heading", { name: "No transaction jobs" })).toBeVisible();
  await expect(
    page.getByText("Sidekick will list a job here when a supported operation needs review."),
  ).toBeVisible();
  await expect(page.locator(".engine-workspace")).toHaveCount(0);
});

test("reviews exact engine intent and keeps approval and emergency controls idempotent", async ({
  page,
}) => {
  const fixture = engineFixture();
  let approvalRequests = 0;
  let invalidationRequests = 0;
  let forceObserveRequests = 0;
  let disableRequests = 0;
  let currentJob = fixture.job;
  let currentStatus = fixture.status;

  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    let body: unknown;
    if (request.pathname === "/api/v1/operations/readiness") {
      body = fixture.readiness;
    } else if (request.pathname === "/api/v1/engine") {
      body = currentStatus;
    } else if (request.pathname === "/api/v1/engine/jobs") {
      body = { schemaVersion: 1, items: [fixture.summary], nextCursor: null, total: 1 };
    } else if (request.pathname === `/api/v1/engine/jobs/${fixture.jobId}`) {
      body = currentJob;
    } else if (request.pathname === `/api/v1/engine/jobs/${fixture.jobId}/approval/invalidate`) {
      invalidationRequests += 1;
      const requestBody = route.request().postDataJSON();
      expect(requestBody).toEqual({
        decision: "invalidate",
        reason: "Operator invalidated approval from the dashboard",
      });
      const invalidatedApproval = {
        ...fixture.approval,
        invalidatedAt: "2026-07-17T12:05:00.000Z",
        invalidationReason: "Operator invalidated approval from the dashboard",
        version: 1,
      };
      currentJob = { ...currentJob, approval: invalidatedApproval, stateVersion: 5 };
      body = { approval: invalidatedApproval, job: currentJob };
    } else if (request.pathname === `/api/v1/engine/jobs/${fixture.jobId}/approval`) {
      approvalRequests += 1;
      expect(route.request().postDataJSON()).toEqual({
        decision: "approve",
        intentSha256: "a".repeat(64),
        policySha256: "b".repeat(64),
        expiresAt: "2026-07-17T12:10:00.000Z",
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      currentJob = {
        ...currentJob,
        state: "nonce_reserved",
        stateVersion: 4,
        approval: fixture.approval,
      };
      body = { approval: fixture.approval, job: currentJob, created: approvalRequests === 1 };
    } else if (request.pathname === "/api/v1/engine/force-observe") {
      forceObserveRequests += 1;
      currentStatus = {
        ...currentStatus,
        mode: "observe",
        forcedObserve: {
          active: true,
          reason: "Operator confirmed emergency force-Observe from the dashboard",
          actor: "operator-session",
          forcedAt: "2026-07-17T12:06:00.000Z",
        },
      };
      body = { status: currentStatus };
    } else if (
      request.pathname === "/api/v1/engine/adapters/reference-manager-claim-rewards/disable"
    ) {
      disableRequests += 1;
      const adapter = {
        ...currentStatus.adapters[0],
        enabled: false,
        availability: "disabled",
        blockReason: "Operator disabled adapter from the dashboard",
      };
      currentStatus = { ...currentStatus, adapters: [adapter] };
      body = { adapter, status: currentStatus };
    } else {
      body = responseFor(route.request().url());
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await login(page);
  await openPage(page, "operations", "Operations");
  await expect(page.getByText("assist", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /claim-rewards/ }).click();
  await expect(page.getByText("Transaction review", { exact: true })).toBeVisible();
  await expect(page.getByText("Last reward compute height", { exact: true })).toBeVisible();
  await expect(page.getByText("Maximum asset outflow", { exact: true })).toBeVisible();
  await expect(page.getByText("Attestation hash", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Approve transaction" }).evaluate((button) => {
    button.click();
    button.click();
  });
  await expect.poll(() => approvalRequests).toBe(1);
  await expect(page.getByText("Approved", { exact: true })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Invalidate approval" }).click();
  await expect.poll(() => invalidationRequests).toBe(1);
  await expect(page.locator(".engine-approval .badge").getByText("Invalidated")).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Force Observe" }).click();
  await expect.poll(() => forceObserveRequests).toBe(1);
  await expect(page.getByText("Forced Observe", { exact: true })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Disable adapter" }).click();
  await expect.poll(() => disableRequests).toBe(1);
  await expect(page.getByText("disabled", { exact: true })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("summarizes the cycle clock and links health details", async ({ page }) => {
  await login(page);
  const cards = page.locator(".cycle-clock > *");
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(0)).toContainText("Reward cycle");
  await expect(cards.nth(1)).toContainText("Bitcoin block height");
  await expect(cards.nth(2)).toContainText("Next prepare phase");
  await expect(cards.nth(2)).toContainText("~10d 16h");
  await expect(cards.nth(2)).toContainText("Bitcoin blocks (#10,780)");
  await expect(cards.nth(3)).toContainText("Node & Signer Health");
  await expect(cards.nth(3)).toContainText("Node");
  await expect(cards.nth(3)).toContainText("Signer");
  await expect(cards.nth(3).locator(".health-light.green")).toHaveCount(2);

  await cards.nth(3).click();
  await expect(page.getByRole("heading", { name: "Signer Health", exact: true })).toBeVisible();
});

test("required actions provide their resolving control and exclude informational notices", async ({
  page,
}) => {
  const rewardsAlert = {
    id: "rewards:incomplete",
    severity: "warning",
    title: "Reward Roster Is Incomplete",
    detail: "The individual staker roster has not been synced.",
    action: { kind: "reconcile", label: "Sync now" },
  };
  const withdrawalAlert = {
    id: "withdrawals:pending",
    severity: "info",
    title: "Bitcoin Withdrawals Await Resolution",
    detail: "2 Bitcoin withdrawal requests remain pending.",
    action: { kind: "navigate", label: "Review Bitcoin withdrawals", target: "rewards" },
  };
  const informationalAlert = {
    id: "manager:custom-read-only",
    severity: "info",
    title: "Custom Manager",
    detail: "Monitoring and browser wallet actions remain available. Assist is unavailable.",
  };
  const actionSnapshot = {
    ...snapshot,
    alerts: [rewardsAlert, withdrawalAlert, informationalAlert],
  };
  let syncRequests = 0;
  let syncStarted = false;

  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    let body: unknown;
    if (request.pathname === "/api/v1/status") {
      body = actionSnapshot;
    } else if (request.pathname === "/api/v1/sync") {
      const started = route.request().method() === "POST";
      if (started) {
        syncRequests += 1;
        syncStarted = true;
      }
      body = reconciliationResponse(started ? "running" : syncStarted ? "succeeded" : "idle");
    } else {
      body = responseFor(route.request().url());
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await login(page);
  const requiredActions = page.locator(".action-grid");
  await expect(page.getByText("2 items need attention")).toBeVisible();
  await expect(requiredActions.getByText("Reward Roster Is Incomplete")).toBeVisible();
  await expect(requiredActions.getByText("Bitcoin Withdrawals Await Resolution")).toBeVisible();
  await expect(requiredActions.getByText("Custom Manager", { exact: true })).not.toBeVisible();

  await requiredActions.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText("Syncing chain data")).toBeVisible();
  await expect(page.getByText("Syncing manager events · step 3 of 4")).toBeVisible();
  await expect.poll(() => syncRequests).toBe(1);

  await requiredActions.getByRole("button", { name: "Review Bitcoin withdrawals" }).click();
  await expect(page.getByRole("heading", { name: "Rewards", exact: true })).toBeVisible();

  await openPage(page, "operations", "Operations");
  const informationalRow = page.locator(".alert-row", { hasText: "Custom Manager" });
  await expect(informationalRow).toBeVisible();
  await expect(informationalRow.getByRole("button")).toHaveCount(0);
});

test("routes a proven signer-registration failure to Manager from every alert surface", async ({
  page,
}) => {
  const signerFailure = {
    ...structuredClone(snapshot),
    registration: {
      ...snapshot.registration,
      registered: false,
      signerKeyGrantValid: false,
    },
    setup: {
      ...structuredClone(snapshot.setup),
      status: "blocked",
      checks: [
        ...snapshot.setup.checks.filter(({ id }) => id !== "signer-registration"),
        {
          id: "signer-registration",
          status: "fail",
          message: "Manager does not have a verified PoX-5 signer registration",
        },
      ],
    },
    alerts: [
      {
        id: "setup:blocked",
        severity: "critical",
        title: "Pool Setup Is Blocked",
        detail: "Manager does not have a verified PoX-5 signer registration.",
        action: {
          kind: "navigate",
          label: "Repair signer authorization",
          target: "manager",
          managerAction: "register-self",
        },
      },
    ],
  };
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    const body =
      request.pathname === "/api/v1/status" ? signerFailure : responseFor(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await login(page);
  const requiredActions = page.locator(".action-grid");
  await expect(requiredActions).toContainText(
    "Manager does not have a verified PoX-5 signer registration.",
  );
  await requiredActions.getByRole("button", { name: "Repair signer authorization" }).click();
  await expect(page).toHaveURL(/#manager\?action=register-self$/);
  await expect(page.getByRole("heading", { name: "Register or rotate signer" })).toBeVisible();

  await openPage(page, "operations", "Operations");
  const operationsAlert = page.locator(".alert-row", { hasText: "Pool Setup Is Blocked" });
  await operationsAlert.getByRole("button", { name: "Repair signer authorization" }).click();
  await expect(page).toHaveURL(/#manager\?action=register-self$/);
});

test("guides first-time operators to setup and remembers dismissal", async ({ page }) => {
  await login(page);
  const notice = page.getByRole("region", { name: "Start with Initial Setup" });
  await expect(notice).toBeVisible();

  await notice.getByRole("button", { name: "Open Initial Setup" }).click();
  await expect(page.getByRole("heading", { name: "Initial Setup", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Attach Existing Contracts" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Deploy New Contracts" })).toBeVisible();

  await openPage(page, "overview", "Overview");
  await notice.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(notice).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await expect(notice).not.toBeVisible();
});

test("does not show first-time guidance after onboarding starts", async ({ page }) => {
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    const body =
      request.pathname === "/api/v1/onboarding"
        ? {
            onboarding: { path: "attach" },
            wizard: { dismissed: false, dismissedAt: null, updatedAt: null, audit: [] },
          }
        : responseFor(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await login(page);
  await expect(page.getByRole("region", { name: "Start with Initial Setup" })).not.toBeVisible();
});

test("shows the PoX-5 Testnet label and network ID", async ({ page }) => {
  await login(page);
  await openPage(page, "health", "Signer Health");
  await expect(page.getByText("PoX-5 Testnet · 0x80000005")).toBeVisible();

  await openPage(page, "settings", "Settings");
  await expect(page.getByText(/Profile PoX-5 Testnet revision 1/)).toBeVisible();
});

test("keeps sustained health findings on the Signer Health page", async ({ page }) => {
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    const body =
      request.pathname === "/api/v1/health"
        ? {
            ...health,
            overallStatus: "needs-attention",
            findings: [
              {
                id: "signer-node-heartbeat-failed",
                severity: "critical",
                title: "Signer cannot reach its Stacks node",
                detail: "The signer heartbeat failed three consecutive checks.",
                source: "signer",
              },
            ],
          }
        : responseFor(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await login(page);
  await expect(page.getByText("Signer cannot reach its Stacks node")).not.toBeVisible();
  await expect(page.getByLabel("Signer health: unavailable")).toBeVisible();
  await openPage(page, "health", "Signer Health");
  await expect(page.getByText("Signer cannot reach its Stacks node")).toBeVisible();
  await openPage(page, "overview", "Overview");
  await expect(page.getByText("Signer cannot reach its Stacks node")).not.toBeVisible();
});

test("refreshes signer health without declaring an empty JSON body", async ({ page }) => {
  let refreshContentType: string | undefined;
  let refreshBody: string | null | undefined;
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    const body =
      request.pathname === "/api/v1/health/refresh"
        ? (() => {
            refreshContentType = route.request().headers()["content-type"];
            refreshBody = route.request().postData();
            return health;
          })()
        : responseFor(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await login(page);
  await openPage(page, "health", "Signer Health");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => refreshBody).toBeNull();
  expect(refreshContentType).toBeUndefined();
  await expect(page.getByText(/Latest refresh failed/)).not.toBeVisible();
});

test("explains the manager trust tier on Manager and Settings", async ({ page }) => {
  await login(page);
  await openPage(page, "manager", "Manager");
  await expect(page.getByText("Built-in reference", { exact: true })).toBeVisible();
  await expect(page.getByText("Built into Sidekick")).toBeVisible();
  const managerRow = page.locator(".statline", { hasText: "Manager principal" });
  const copyBox = await managerRow.locator(".copy-identifier-button").boundingBox();
  const valueBox = await managerRow.locator(".copyable-identifier-value").boundingBox();
  expect(copyBox).not.toBeNull();
  expect(valueBox).not.toBeNull();
  expect((copyBox?.x ?? 0) + (copyBox?.width ?? 0)).toBeLessThanOrEqual(valueBox?.x ?? 0);
  await openPage(page, "settings", "Settings");
  await expect(page.getByText("Manager trust")).toBeVisible();
  await expect(page.getByText("Installed profile store")).toBeVisible();
  await expect(page.getByText(/Profile PoX-5 Testnet revision 1 · built in/)).toBeVisible();
});

test("starts an admin-history sync from Manager", async ({ page }) => {
  let syncRequests = 0;
  let syncStarted = false;
  await page.route("**/api/v1/sync", async (route) => {
    const started = route.request().method() === "POST";
    if (started) {
      syncRequests += 1;
      syncStarted = true;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        reconciliationResponse(started ? "running" : syncStarted ? "succeeded" : "idle"),
      ),
    });
  });

  await login(page);
  await openPage(page, "manager", "Manager");
  await page.getByRole("button", { name: "Sync admin history" }).click();

  await expect(page.getByText("Syncing chain data")).toBeVisible();
  await expect.poll(() => syncRequests).toBe(1);
});

test("deep-links reward administration and blocks manager-admin self-removal", async ({ page }) => {
  const adminPrincipal = snapshot.managerPrincipal.split(".")[0];
  await login(page);
  await openPage(page, "rewards", "Rewards");
  await page.getByRole("button", { name: "Update manager fee" }).click();
  await expect(page).toHaveURL(/#manager\?action=update-fees$/);
  await expect(page.getByRole("heading", { name: "Update manager fee" })).toBeVisible();
  await page.getByLabel("Signing manager admin").fill(adminPrincipal);
  await page.getByLabel("New fee (basis points)").fill("250");
  await expect(page.getByLabel("Browser wallet")).toBeVisible();

  await openPage(page, "rewards", "Rewards");
  await page.getByRole("button", { name: "Withdraw earned fees" }).click();
  await expect(page).toHaveURL(/#manager\?action=withdraw-fees$/);
  await expect(page.getByRole("heading", { name: "Withdraw earned fees" })).toBeVisible();

  await openPage(page, "rewards", "Rewards");
  await page.getByRole("button", { name: "Sweep fee refunds" }).click();
  await expect(page).toHaveURL(/#manager\?action=sweep-fee-refunds$/);
  await expect(page.getByRole("heading", { name: "Sweep fee-refund dust" })).toBeVisible();

  await page.evaluate(() => {
    location.hash = "#manager?action=remove-admin";
  });
  await expect(page.getByRole("heading", { name: "Remove manager admin" })).toBeVisible();
  await page.getByLabel("Signing manager admin").fill(adminPrincipal);
  await page.getByLabel("Admin principal to remove").fill(adminPrincipal);
  await expect(page.getByText("An admin cannot remove itself.")).toBeVisible();
  await expect(page.getByLabel("Browser wallet")).toHaveCount(0);
});

test("prepares a staker settlement through the browser-wallet flow", async ({ page }) => {
  await login(page);
  await openPage(page, "rewards", "Rewards");

  await page.getByRole("button", { name: "Check what settling this cycle costs" }).click();
  await expect(page.getByRole("button", { name: "Settle" })).toBeVisible();
  await page.getByRole("button", { name: "Settle" }).click();

  await expect(page.getByText("One transaction settles this tuple.")).toBeVisible();
  await page.getByLabel("Signing account").fill(snapshot.managerPrincipal.split(".")[0] ?? "");
  await expect(page.getByLabel("Browser wallet")).toBeVisible();
});

test("keeps pending and empty staker settlement views compact", async ({ page }) => {
  const pendingSnapshot = structuredClone(snapshot);
  pendingSnapshot.rewards.calculation = {
    ...pendingSnapshot.rewards.calculation,
    state: "pending",
  };
  let settlementReads = 0;

  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    if (request.pathname === "/api/v1/status") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(pendingSnapshot),
      });
      return;
    }
    if (request.pathname === "/api/v1/rewards/staker-claims") settlementReads += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(responseFor(route.request().url())),
    });
  });

  await login(page);
  await openPage(page, "rewards", "Rewards");
  await expect(
    page.getByText("Staker rewards become available after the global calculation runs."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check what settling this cycle costs" }),
  ).toHaveCount(0);
  expect(settlementReads).toBe(0);
});

test("does not list every zero-value staker in settlement discovery", async ({ page }) => {
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    const body =
      request.pathname === "/api/v1/rewards/staker-claims"
        ? {
            generatedAt: snapshot.generatedAt,
            rewardCycle: snapshot.rewards.rewardCycle,
            page: {
              stakerPrincipals: [roster[1].stakerPrincipal],
              offset: 0,
              limit: 50,
              stakersTotal: 1,
              nextCursor: null,
            },
            settlement: {
              scope: "page",
              stakersScanned: 1,
              outstandingClaims: 0,
              transactionCount: 0,
              totalNetSats: "0",
              blockedClaims: 0,
            },
            candidates: [
              {
                stakerPrincipal: roster[1].stakerPrincipal,
                bondIndex: null,
                payout: { kind: "direct-sbtc", maxFeeSats: null },
                rewards: { earnedSats: "0", feeSats: "0", grossSats: "0" },
                claimable: false,
                blockedReason: "nothing-settled",
              },
            ],
          }
        : responseFor(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await login(page);
  await openPage(page, "rewards", "Rewards");
  await page.getByRole("button", { name: "Check what settling this cycle costs" }).click();
  await expect(page.getByText("No staker rewards are settleable for this cycle")).toBeVisible();
  await expect(page.getByText("Nothing settled")).toHaveCount(0);
});

test("explains a temporary chain-source mismatch while preparing a wallet request", async ({
  page,
}) => {
  let walletAttempts = 0;
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    const walletRequest =
      request.pathname === "/api/v1/wallet-intents" && route.request().method() === "POST";
    if (walletRequest) walletAttempts += 1;
    await route.fulfill({
      status: walletRequest ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        walletRequest
          ? walletAttempts === 1
            ? {
                error: "wallet_intent_anchor_mismatch",
                retryable: true,
                node: { stacksTipHeight: 28_079, burnBlockHeight: 4_818 },
                api: { stacksTipHeight: 28_097, burnBlockHeight: 4_819 },
                poxBurnBlockHeight: 4_819,
              }
            : { error: "wallet_intent_anchor_unstable", retryable: true }
          : responseFor(route.request().url()),
      ),
    });
  });

  await login(page);
  await openPage(page, "manager", "Manager");
  await page.evaluate(() => {
    location.hash = "#manager?action=update-fees";
  });
  await page.getByLabel("Signing manager admin").fill(snapshot.managerPrincipal.split(".")[0]);
  await page.getByLabel("New fee (basis points)").fill("250");

  const walletReview = page.getByRole("region", { name: "Browser wallet" });
  await walletReview.getByRole("button", { name: "Review wallet transaction" }).click();

  const alert = walletReview.getByRole("alert");
  await expect(alert).toContainText("Node, API, and PoX chain data are temporarily out of sync.");
  await expect(alert).toContainText("Node: Stacks 28,079, Bitcoin 4,818.");
  await expect(alert).toContainText("API: Stacks 28,097, Bitcoin 4,819.");
  await expect(alert).toContainText(
    "Sidekick retried. This attempt did not send a new transaction to the wallet or submit one.",
  );
  await expect(alert).toContainText("If this persists, verify the node and API URLs in Settings.");
  await expect(
    walletReview.getByRole("button", { name: "Review wallet transaction" }),
  ).toBeEnabled();

  await walletReview.getByRole("button", { name: "Review wallet transaction" }).click();
  await expect(alert).toContainText(
    "The chain position changed while Sidekick checked the request.",
  );
  await expect(alert).not.toContainText("Node: Stacks");
  await expect(
    walletReview.getByRole("button", { name: "Review wallet transaction" }),
  ).toBeEnabled();
  expect(consoleErrors.get(page)).toEqual([
    "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
    "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
  ]);
  consoleErrors.set(page, []);
});

test("requires a fresh signer grant before preparing a Testnet registration wallet request", async ({
  page,
}) => {
  const actorPrincipal = snapshot.managerPrincipal.split(".")[0];
  const preparation = {
    command: "stacks-signer generate-stacking-signature --config /srv/signer/Signer.toml",
    expectedMessageHashHex: "ab".repeat(32),
    authId: "141",
  };
  const verified = {
    managerPrincipal: snapshot.managerPrincipal,
    authId: "141",
    signerKeyHex: `02${"12".repeat(32)}`,
    signerSignatureHex: "34".repeat(65),
    expectedMessageHashHex: preparation.expectedMessageHashHex,
    registerSelfCall: {
      contract: snapshot.managerPrincipal,
      functionName: "register-self",
      arguments: ["0x01", "0x02", "0x03", "0x04"],
      signingPrincipal: actorPrincipal,
    },
  };
  const grantResponse = (withVerification: boolean) =>
    freshOnboardingResponse({
      currentStep: "verify-signer-grant",
      steps: [],
      preparation,
      verified: withVerification ? verified : null,
    }).onboarding;
  let prepareBody: unknown = null;
  let verifyBody: unknown = null;
  let walletBody: unknown = null;

  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    let body: unknown;
    if (request.pathname === "/api/v1/status") {
      body = { ...structuredClone(snapshot), network: "testnet" };
    } else if (request.pathname === "/api/v1/manager/signer-grant/prepare") {
      prepareBody = route.request().postDataJSON();
      body = { onboarding: grantResponse(false) };
    } else if (request.pathname === "/api/v1/manager/signer-grant/verify") {
      verifyBody = route.request().postDataJSON();
      body = { onboarding: grantResponse(true) };
    } else if (request.pathname === "/api/v1/wallet-intents") {
      walletBody = route.request().postDataJSON();
      body = registerWalletIntent(actorPrincipal);
    } else {
      body = responseFor(route.request().url());
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await login(page);
  await openPage(page, "manager", "Manager");
  await page.getByRole("button", { name: "Review signer rotation" }).click();
  await expect(page.getByLabel("Browser wallet")).toHaveCount(0);
  await page.getByLabel("Authorization ID").fill("141");
  await page.getByLabel("Signer configuration path").fill("/srv/signer/Signer.toml");
  await page.getByRole("button", { name: "Generate signer command" }).click();
  expect(prepareBody).toEqual({ authId: "141", signerConfigPath: "/srv/signer/Signer.toml" });
  await expect(page.getByText(preparation.command)).toBeVisible();
  await expect(page.getByLabel("Browser wallet")).toHaveCount(0);

  const signerOutput = { signerManager: snapshot.managerPrincipal, authId: "141" };
  await page.getByLabel("Signer command output").fill(JSON.stringify(signerOutput));
  await page.getByRole("button", { name: "Verify signer output" }).click();
  expect(verifyBody).toEqual({ signerOutput });
  await expect(page.getByText("Signer authorization verified.")).toBeVisible();
  await expect(page.getByLabel("Browser wallet")).toHaveCount(0);

  await page.getByLabel("Signing manager admin").fill(actorPrincipal);
  await expect(page.getByLabel("Browser wallet")).toContainText("Supported wallet: Leather.");
  await page.getByRole("button", { name: "Review wallet transaction" }).click();
  expect(walletBody).toEqual({ action: "register-self", actorPrincipal });
});

test("keeps desktop settings chrome visible while the form scrolls", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) <= 1080, "Desktop settings shell only");
  await login(page);
  await openPage(page, "settings", "Settings");

  const settingsScroll = page.locator(".settings-scroll");
  const saveButton = page.getByRole("button", { name: "Save changes" });
  const settingsMenu = page.locator(".set-nav");
  await expect(settingsScroll).toHaveCSS("overflow-y", "auto");
  const saveBefore = await saveButton.boundingBox();
  const menuBefore = await settingsMenu.boundingBox();

  await settingsScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() => settingsScroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);

  const saveAfter = await saveButton.boundingBox();
  const menuAfter = await settingsMenu.boundingBox();
  expect(saveAfter?.y).toBe(saveBefore?.y);
  expect(menuAfter?.y).toBe(menuBefore?.y);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("recommends verified Hiro chainstate seeding for a fresh node", async ({ page }) => {
  await login(page);
  await openPage(page, "setup", "Initial Setup");
  await page.getByRole("button", { name: "Deploy New Contracts" }).click();
  await expect(page.getByText("Check prerequisites.")).toBeVisible();
  await expect(page.getByText(/Sidekick prepares the manager deployment/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: /Manager admin principal/ })).toHaveAttribute(
    "readonly",
    "",
  );
  await expect(page.getByRole("textbox", { name: /Contract name/ })).toHaveAttribute(
    "readonly",
    "",
  );
  await expect(page.getByRole("button", { name: "Generate deployment files" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Regenerate" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Hiro Archive guide/ })).toHaveAttribute(
    "href",
    "https://docs.hiro.so/en/resources/archive/stacks-blockchain",
  );
  await expect(page.getByRole("link", { name: /Node setup/ })).toHaveAttribute(
    "href",
    "https://docs.stacks.co/operate/readme/run-a-node-with-docker",
  );
  await expect(page.getByRole("link", { name: /Signer quickstart/ })).toHaveAttribute(
    "href",
    "https://docs.stacks.co/operate/run-a-signer/signer-quickstart",
  );
  await openPage(page, "settings", "Settings");
  await expect(page.getByText("Network compatibility: matched")).toBeVisible();
  await expect(page.getByText(/Profile PoX-5 Testnet revision 1 · built in/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Signer configuration/ })).toHaveAttribute(
    "href",
    "https://docs.stacks.co/reference/node-operations/signer-configuration",
  );
});

test("explains how to deploy a generated manager outside Sidekick", async ({ page }) => {
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    const body =
      request.pathname === "/api/v1/onboarding"
        ? freshOnboardingResponse({
            currentStep: "deploy-manager",
            steps: [
              {
                id: "preflight",
                status: "complete",
                title: "Prerequisites",
                detail: "Node and API are ready.",
                command: null,
              },
              {
                id: "render-manager",
                status: "complete",
                title: "Manager artifact",
                detail: "Manager artifact prepared.",
                command: null,
              },
              {
                id: "deploy-manager",
                status: "ready",
                title: "Deploy manager",
                detail: "Deploy the generated manager contract.",
                command: null,
              },
            ],
          })
        : responseFor(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await login(page);
  await openPage(page, "setup", "Initial Setup");
  await expect(page.getByRole("heading", { name: "Manager contract" })).toBeVisible();
  await expect(page.getByText(/This contract represents your pool/)).toBeVisible();
  await expect(page.getByText(/starts at 0%; set your pool fee in Manager/)).toBeVisible();
  await expect(page.getByRole("link", { name: /View reference source/ })).toHaveAttribute(
    "href",
    "https://github.com/stacks-network/stacks-core/blob/efc34a07a225c4b950ab9404a1652aa5e14affaf/contrib/core-contract-tests/contracts/signer-manager.clar",
  );
  await expect(page.getByRole("link", { name: /Pool operator guide/ })).toHaveAttribute(
    "href",
    "https://docs.stacks.co/operate/stacking-stx/operate-a-stacking-pool",
  );
  await expect(page.getByRole("heading", { name: "Manual deployment" })).toBeVisible();
  await expect(page.getByText(/manifest records the values you must review/)).toBeVisible();
  await expect(page.getByText("signer-manager", { exact: true })).toBeVisible();
  await expect(page.locator(".deployment-target")).toContainText(/Network\s+testnet/);
  await expect(page.locator(".deployment-target")).toContainText("Clarity 6");
  await expect(page.getByRole("link", { name: /Explorer Sandbox/ })).toHaveAttribute(
    "href",
    "https://explorer.hiro.so/sandbox/deploy",
  );
  await expect(page.getByRole("link", { name: /Clarinet deployment guide/ })).toHaveAttribute(
    "href",
    "https://docs.stacks.co/clarinet/contract-deployment",
  );
  await expect(page.locator("body")).not.toContainText(credential);
});

test("shows the exact sealed mainnet deployment before browser-wallet signing", async ({
  page,
}) => {
  const adminPrincipal = "SP000000000000000000002Q6VF78";
  const managerPrincipal = `${adminPrincipal}.signer-manager`;
  const exactSource = "(define-public (reviewed-ping)\n  (ok true))";
  const onboardingResponse = freshOnboardingResponse({
    currentStep: "deploy-manager",
    steps: [
      {
        id: "deploy-manager",
        status: "ready",
        title: "Deploy manager",
        detail: "Deploy the generated manager contract.",
        command: null,
      },
    ],
  });
  if (!onboardingResponse.onboarding.artifact.manifest) {
    throw new Error("Fresh onboarding fixture is missing its manager manifest");
  }
  onboardingResponse.onboarding.managerPrincipal = managerPrincipal;
  onboardingResponse.onboarding.freshInput.adminPrincipal = adminPrincipal;
  onboardingResponse.onboarding.artifact.manifest.network = "mainnet";
  onboardingResponse.onboarding.artifact.manifest.adminPrincipal = adminPrincipal;
  let createRequest: unknown = null;
  let releaseIntentResponse: (() => void) | null = null;
  const intentResponseReady = new Promise<void>((resolve) => {
    releaseIntentResponse = resolve;
  });

  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    let body: unknown;
    if (request.pathname === "/api/v1/status") {
      body = walletNetworkSnapshot("mainnet", 1, managerPrincipal);
    } else if (request.pathname === "/api/v1/onboarding") {
      body = onboardingResponse;
    } else if (request.pathname === "/api/v1/onboarding/wallet-intents") {
      createRequest = route.request().postDataJSON();
      await intentResponseReady;
      body = deployWalletIntent({ adminPrincipal, source: exactSource });
    } else {
      body = responseFor(route.request().url());
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await login(page);
  await openPage(page, "setup", "Initial Setup");
  const walletReview = page.getByRole("region", { name: "Browser wallet" });
  await walletReview.getByRole("button", { name: "Review wallet transaction" }).click();
  try {
    await expect(walletReview).toHaveAttribute("aria-busy", "true");
    await expect(walletReview.getByRole("status")).toHaveText("Preparing transaction review…");
  } finally {
    releaseIntentResponse?.();
  }
  await expect.poll(() => createRequest).toEqual({ action: "deploy-manager" });

  await walletReview.getByText("Transaction details", { exact: true }).click();
  await expect(walletReview.getByText("Contract source", { exact: true })).toBeVisible();
  await expect(walletReview.locator("pre", { hasText: exactSource })).toHaveText(exactSource);
  await expect(walletReview).toContainText(/Post-condition mode\s+deny/i);
  await expect(walletReview).toContainText(/Post-conditions\s+(?:none|empty)/i);
  await expect(walletReview.getByRole("button", { name: "Connect wallet and sign" })).toBeVisible();
});

test("restores and records a wallet broadcast after reload without signing again", async ({
  page,
}) => {
  const adminPrincipal = "SP000000000000000000002Q6VF78";
  const exactSource = "(define-public (reviewed-ping) (ok true))";
  const onboardingResponse = freshOnboardingResponse({
    currentStep: "deploy-manager",
    steps: [
      {
        id: "deploy-manager",
        status: "ready",
        title: "Deploy manager",
        detail: "Deploy the generated manager contract.",
        command: null,
      },
    ],
  });
  if (!onboardingResponse.onboarding.artifact.manifest) {
    throw new Error("Fresh onboarding fixture is missing its manager manifest");
  }
  onboardingResponse.onboarding.managerPrincipal = `${adminPrincipal}.signer-manager`;
  onboardingResponse.onboarding.freshInput.adminPrincipal = adminPrincipal;
  onboardingResponse.onboarding.artifact.manifest.network = "mainnet";
  onboardingResponse.onboarding.artifact.manifest.adminPrincipal = adminPrincipal;
  const prepared = deployWalletIntent({ adminPrincipal, source: exactSource });
  const replacement = deployWalletIntent({
    adminPrincipal,
    source: exactSource,
    id: "9f4d2b32-0eed-4e7c-bf92-7217418d8248",
  });
  const txid = `0x${"ab".repeat(32)}`;
  const pending = {
    intentId: prepared.intent.id,
    network: "mainnet",
    chainId: 1,
    managerPrincipal: `${adminPrincipal}.signer-manager`,
    action: "deploy-manager",
    txid,
    sender: adminPrincipal,
    providerId: "LeatherProvider",
  };
  const pendingKey = `signer-sidekick:browser-wallet:pending:v3:mainnet:00000001:${encodeURIComponent(pending.managerPrincipal)}:deploy-manager:${pending.intentId}`;
  let submissions = 0;
  let releaseSubmission: (() => void) | null = null;
  const submissionReleased = new Promise<void>((resolve) => {
    releaseSubmission = resolve;
  });

  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, JSON.stringify(value));
    },
    { key: pendingKey, value: pending },
  );
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    let body: unknown;
    if (request.pathname === "/api/v1/status") {
      body = walletNetworkSnapshot("mainnet", 1, `${adminPrincipal}.signer-manager`);
    } else if (request.pathname === "/api/v1/onboarding") {
      body = onboardingResponse;
    } else if (
      request.pathname === `/api/v1/onboarding/wallet-intents/${prepared.intent.id}/submission`
    ) {
      submissions += 1;
      expect(route.request().postDataJSON()).toEqual({ txid });
      await submissionReleased;
      body = { intent: { ...prepared.intent, status: "submitted", txid } };
    } else if (request.pathname === `/api/v1/onboarding/wallet-intents/${prepared.intent.id}`) {
      body = { intent: { ...prepared.intent, status: "expired" } };
    } else if (
      request.pathname === `/api/v1/onboarding/wallet-intents/${prepared.intent.id}/refresh`
    ) {
      body = {
        intent: {
          ...prepared.intent,
          status: "failed",
          txid,
          verification: {
            outcome: "abort",
            observedAt: "2026-07-18T18:05:00.000Z",
            canonical: true,
            blockHeight: 9_001,
            indexBlockHash: `0x${"ef".repeat(32)}`,
            detail: "Canonical transaction abort by response",
          },
        },
      };
    } else if (
      request.pathname === "/api/v1/onboarding/wallet-intents" &&
      route.request().method() === "POST"
    ) {
      expect(route.request().postDataJSON()).toEqual({ action: "deploy-manager" });
      body = replacement;
    } else {
      body = responseFor(route.request().url());
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await login(page);
  await openPage(page, "setup", "Initial Setup");
  const walletReview = page.getByRole("region", { name: "Browser wallet" });
  await expect.poll(() => submissions).toBe(1);
  try {
    await expect(
      walletReview.getByRole("button", { name: "Clear saved recovery record" }),
    ).toHaveCount(0);
    await expect(
      walletReview.getByRole("button", { name: "Connect wallet and sign", exact: true }),
    ).toHaveCount(0);
  } finally {
    releaseSubmission?.();
  }
  await expect(walletReview).toContainText("Transaction submitted.");
  await expect(walletReview).toContainText(txid);
  await expect(
    walletReview.getByRole("button", { name: "Connect wallet and sign", exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), pendingKey)).toBeNull();

  await walletReview.getByRole("button", { name: "Refresh verification" }).click();
  await expect(
    walletReview.getByRole("button", { name: "Review a new wallet transaction" }),
  ).toBeVisible();
  await walletReview.getByRole("button", { name: "Review a new wallet transaction" }).click();
  await expect(walletReview.getByRole("button", { name: "Connect wallet and sign" })).toBeVisible();
  await expect(walletReview).not.toContainText("The wallet reported a broadcast");
});

test("advances fresh setup after a transient deployment refresh failure", async ({ page }) => {
  const refreshFailure =
    "Could not update setup: fresh setup refresh failed. Refresh setup progress before retrying; it may already have updated.";
  await page.clock.install();
  const complete = (id: string, title: string): FixtureStep => ({
    id,
    title,
    status: "complete",
    detail: `${title} complete`,
    command: null,
  });
  const deploymentSteps: FixtureStep[] = [
    complete("preflight", "Prerequisites"),
    complete("render-manager", "Manager artifact"),
    {
      id: "deploy-manager",
      status: "ready",
      title: "Deploy manager",
      detail: "Waiting for the deployed manager.",
      command: null,
    },
  ];
  const grantSteps: FixtureStep[] = [
    complete("preflight", "Prerequisites"),
    complete("render-manager", "Manager artifact"),
    complete("deploy-manager", "Deploy manager"),
    {
      id: "prepare-signer-grant",
      status: "ready",
      title: "Prepare signer grant",
      detail: "Prepare the live PoX-5 signer grant.",
      command: null,
    },
  ];
  const deploymentResponse = freshOnboardingResponse({
    currentStep: "deploy-manager",
    steps: deploymentSteps,
  });
  const grantResponse = freshOnboardingResponse({
    currentStep: "prepare-signer-grant",
    steps: grantSteps,
  });
  let refreshCalls = 0;

  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    if (request.pathname === "/api/v1/onboarding") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(deploymentResponse),
      });
      return;
    }
    if (request.pathname === "/api/v1/onboarding/fresh/refresh") {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "fresh_setup_refresh_failed" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          onboarding: grantResponse.onboarding,
          preflight: snapshot.preflight,
          setup: snapshot.setup,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(responseFor(route.request().url())),
    });
  });

  await login(page);
  await openPage(page, "setup", "Initial Setup");
  await page.getByRole("button", { name: "Verify deployment" }).click();
  await expect(page.getByText(refreshFailure)).toBeVisible();

  await page.clock.runFor(20_000);

  await expect(page.getByRole("button", { name: "Generate signer command" })).toBeVisible();
  await expect(page.getByText(refreshFailure)).toHaveCount(0);
  expect(refreshCalls).toBe(2);
  expect(consoleErrors.get(page)).toEqual([
    "Failed to load resource: the server responded with a status of 400 (Bad Request)",
  ]);
  consoleErrors.set(page, []);
});

test("keeps setup commands behind advanced disclosure", async ({ page }) => {
  const steps: FixtureStep[] = [
    {
      id: "preflight",
      status: "ready",
      title: "Prerequisites",
      detail: "Review the connected environment.",
      command: "sidekick preflight --json",
    },
    {
      id: "render-manager",
      status: "complete",
      title: "Manager artifact",
      detail: "Manager artifact prepared.",
      command: "sidekick manager render --json",
    },
  ];
  let currentStep = "preflight";
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    const body =
      request.pathname === "/api/v1/onboarding"
        ? freshOnboardingResponse({ currentStep, steps })
        : responseFor(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await login(page);
  await openPage(page, "setup", "Initial Setup");
  await expect(page.getByText(/Node, API, network, and PoX-5 checks are complete/)).toBeVisible();
  await expect(page.getByText("sidekick preflight --json")).not.toBeVisible();
  await page.getByText("CLI equivalent (advanced)").click();
  await expect(page.getByText("sidekick preflight --json")).toBeVisible();

  currentStep = "render-manager";
  await page.reload();
  await expect(
    page.getByText(/Download the contract source and deployment manifest, then deploy them/),
  ).toBeVisible();
  await expect(page.getByText("sidekick manager render --json")).not.toBeVisible();
});

test("hands manager registration to the external admin wallet", async ({ page }) => {
  const adminPrincipal = snapshot.managerPrincipal.split(".")[0];
  const verified = {
    managerPrincipal: snapshot.managerPrincipal,
    authId: "42",
    signerKeyHex: `02${"11".repeat(32)}`,
    signerSignatureHex: "22".repeat(65),
    expectedMessageHashHex: "33".repeat(32),
    registerSelfCall: {
      contract: snapshot.managerPrincipal,
      functionName: "register-self",
      arguments: ["0x0516", "0x0200000021", "0x01000000000000002a", "0x0200000041"],
      signingPrincipal: adminPrincipal,
    },
  };
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    const body =
      request.pathname === "/api/v1/onboarding"
        ? freshOnboardingResponse({
            currentStep: "register-manager",
            steps: [
              {
                id: "register-manager",
                status: "ready",
                title: "Register manager",
                detail: "Register the manager with PoX-5.",
                command: null,
              },
            ],
            verified,
          })
        : responseFor(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await login(page);
  await openPage(page, "setup", "Initial Setup");
  await expect(
    page.locator(".registration-handoff strong", { hasText: "Register the manager with PoX-5." }),
  ).toBeVisible();
  await expect(page.getByText(/Sign below or use the manual transaction details/)).toBeVisible();
  await expect(page.getByLabel("Browser wallet")).toBeVisible();
  await expect(page.getByText("u42", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Copy signer key/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check registration" })).toBeVisible();
  await expect(page.getByText(/0x0516/)).not.toBeVisible();
  await page.getByText("Encoded transaction arguments (advanced)").click();
  await expect(page.getByText(/0x0516/)).toBeVisible();
});

test("summarizes attach checks and explains external repair", async ({ page }) => {
  const attachResponse = {
    onboarding: {
      path: "attach",
      status: "blocked",
      currentStep: "verify-signer-grant",
      managerPrincipal: snapshot.managerPrincipal,
      updatedAt: "2026-07-17T12:00:00.000Z",
      activationPlan: {
        status: "blocked",
        steps: [
          {
            id: "verify-sources",
            status: "complete",
            title: "Verify sources",
            detail: "Manager source recognized.",
            command: null,
          },
          {
            id: "verify-signer-grant",
            status: "blocked",
            title: "Verify signer grant",
            detail: "Signer grant missing.",
            command: null,
          },
        ],
      },
      freshInput: null,
      artifact: { available: false, sourceFile: null, manifestFile: null, manifest: null },
      signerGrant: { preparation: null, verified: null },
      audit: [],
    },
    wizard: { dismissed: false, dismissedAt: null, updatedAt: null, audit: [] },
  };
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const body =
      new URL(route.request().url()).pathname === "/api/v1/onboarding"
        ? attachResponse
        : responseFor(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await login(page);
  await openPage(page, "setup", "Initial Setup");
  await expect(page.getByRole("button", { name: /Verify existing manager/ })).toHaveCount(1);
  await expect(page.getByText("Manager attached with operational blockers.")).toBeVisible();
  await expect(page.getByText(/Signer authorization needs repair/)).toBeVisible();
  const repair = page.getByRole("button", { name: "Review repair ceremony" });
  await expect(repair).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Public Pool Page" })).toBeVisible();
  await repair.click();
  await expect(page).toHaveURL(/#manager\?action=register-self$/);
});

test("guides the signer grant ceremony from command generation through verification", async ({
  page,
}) => {
  const signerCommand =
    `stacks-signer generate-staking-signature --config '/path/to/Signer.toml' ` +
    `--signer-manager '${snapshot.managerPrincipal}' --auth-id 1 --json`;
  let prepared = false;
  const ceremonyResponse = () =>
    freshOnboardingResponse({
      currentStep: prepared ? "verify-signer-grant" : "prepare-signer-grant",
      steps: [
        {
          id: "prepare-signer-grant",
          status: prepared ? "complete" : "ready",
          title: "Prepare signer grant",
          detail: "Prepare the live PoX-5 signer grant.",
          command: "sidekick signer-grant prepare",
        },
        {
          id: "verify-signer-grant",
          status: "ready",
          title: "Verify signer grant",
          detail: "Verify the public signer output.",
          command: "sidekick signer-grant verify",
        },
      ],
      preparation: prepared
        ? {
            command: signerCommand,
            expectedMessageHashHex: "ab".repeat(32),
            authId: "1",
          }
        : null,
    });

  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    let body: unknown;
    if (request.pathname === "/api/v1/onboarding/fresh/grant/prepare") {
      prepared = true;
      body = ceremonyResponse();
    } else if (request.pathname === "/api/v1/onboarding") {
      body = ceremonyResponse();
    } else {
      body = responseFor(route.request().url());
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await login(page);
  await openPage(page, "setup", "Initial Setup");
  await expect(page.getByText("Authorize this manager with your signer")).toBeVisible();
  await expect(
    page.getByText(/Sidekick verifies its output before preparing registration/),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("sidekick signer-grant prepare");

  await page.getByRole("button", { name: "Generate signer command" }).click();
  await expect(page.getByText("Run on the signer host")).toBeVisible();
  await expect(
    page.locator("pre", { hasText: "stacks-signer generate-staking-signature" }),
  ).toHaveText(signerCommand);
  await expect(page.getByRole("button", { name: /Copy signer command/ })).toBeVisible();
  await expect(page.getByLabel("JSON output from the signer command")).toHaveAttribute(
    "placeholder",
    "Paste the complete JSON object printed by stacks-signer",
  );
  await expect(page.getByText(/Never paste the signer configuration or private key/)).toBeVisible();
  await expect(page.locator("body")).not.toContainText(credential);
});

test("makes each signer activation state explicit and actionable", async ({ page }) => {
  const thresholdUstx = "50000000000";
  const eligibility = (cycleId: number, delegatedUstx: string, inSignerSet: boolean) => ({
    cycleId,
    delegatedUstx,
    thresholdUstx,
    marginUstx: (BigInt(delegatedUstx) - BigInt(thresholdUstx)).toString(),
    meetsThreshold: BigInt(delegatedUstx) >= BigInt(thresholdUstx),
    inSignerSet,
  });
  const foundationChecks = [
    { id: "manager-attachment", status: "pass", message: "Manager compatible" },
    { id: "manager-artifact", status: "pass", message: "Manager source verified" },
    { id: "signer-registration", status: "pass", message: "Signer registered" },
    { id: "signer-grant", status: "pass", message: "Signer grant valid" },
  ];
  let setup = {
    status: "attention",
    enrollmentWindow: {
      status: "open",
      targetCycleId: 140,
      preparePhaseStartBurnHeight: 10_780,
      blocksUntilPreparePhase: 1_540,
    },
    eligibility: {
      current: eligibility(139, "0", false),
      next: eligibility(140, "0", false),
    },
    checks: [
      ...foundationChecks,
      { id: "next-cycle-eligibility", status: "warn", message: "Stake required" },
    ],
  };
  const onboardingResponse = finalVerificationOnboarding();
  const preflight = {
    ...snapshot.preflight,
    cycle: {
      ...snapshot.preflight.cycle,
      currentId: 139,
      nextId: 140,
      preparePhaseStartBurnHeight: 10_780,
      blocksUntilPreparePhase: 1_540,
      rewardPhaseStartBurnHeight: 10_880,
      blocksUntilRewardPhase: 1_640,
      isPreparePhase: false,
    },
  };

  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    let body: unknown;
    if (request.pathname === "/api/v1/status") {
      body = { ...snapshot, preflight, setup };
    } else if (request.pathname === "/api/v1/onboarding") {
      body = onboardingResponse;
    } else if (request.pathname === "/api/v1/onboarding/fresh/refresh") {
      body = { onboarding: onboardingResponse.onboarding, preflight, setup };
    } else {
      body = responseFor(route.request().url());
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  const reloadSetup = async () => {
    await page.reload();
    await expect(page.getByRole("heading", { name: "Initial Setup", exact: true })).toBeVisible();
  };

  await login(page);
  await openPage(page, "setup", "Initial Setup");
  await expect(page.getByRole("heading", { name: "Activate your signer" })).toBeVisible();
  await expect(page.getByText("Initial setup complete")).toBeVisible();
  await expect(page.getByText("Manager deployed · Signer registered · Grant valid")).toBeVisible();
  await expect(page.getByText("Stake required", { exact: true })).toBeVisible();
  await expect(page.getByText("0 STX of 50,000 STX required")).toBeVisible();
  await expect(page.getByText(/Stake at least 50,000 STX total to this manager/)).toBeVisible();
  const copyManagerButton = page.getByRole("button", { name: /Copy manager principal/ });
  await expect(copyManagerButton).toBeVisible();
  await expect(copyManagerButton).toHaveCSS("flex-basis", "auto");
  await expect(copyManagerButton).toHaveCSS("white-space", "nowrap");
  await expect(page.getByRole("button", { name: "Open Public Pool Page" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh after staking" })).toBeVisible();
  await expect(page.getByText(/sidekick setup status/)).not.toBeVisible();

  setup = {
    ...setup,
    status: "ready",
    eligibility: {
      current: eligibility(139, "0", false),
      next: eligibility(140, "55000000000", true),
    },
    checks: [
      ...foundationChecks,
      { id: "next-cycle-eligibility", status: "pass", message: "Ready" },
    ],
  };
  await reloadSetup();
  await expect(page.getByText("Activation scheduled", { exact: true })).toBeVisible();
  await expect(page.getByText(/No action is required.*Bitcoin block 10880/)).toBeVisible();

  setup = {
    ...setup,
    eligibility: {
      current: eligibility(139, "55000000000", true),
      next: eligibility(140, "55000000000", true),
    },
  };
  await reloadSetup();
  await expect(page.getByText("Signer active", { exact: true })).toBeVisible();
  await expect(page.getByText("Signer active for cycle 139")).toBeVisible();

  setup = {
    ...setup,
    status: "attention",
    enrollmentWindow: {
      ...setup.enrollmentWindow,
      status: "prepare-phase",
      blocksUntilPreparePhase: 0,
    },
    eligibility: {
      current: eligibility(139, "0", false),
      next: eligibility(140, "0", false),
    },
    checks: [
      ...foundationChecks,
      { id: "next-cycle-eligibility", status: "warn", message: "Enrollment closed" },
    ],
  };
  await reloadSetup();
  await expect(page.getByText("Enrollment closed", { exact: true })).toBeVisible();
  await expect(page.getByText(/Target cycle 141 when enrollment reopens/)).toBeVisible();
});

test("explains operator-installed and unrecognized trust tiers", async ({ page }) => {
  let tier: "unrecognized" | "custom-observe" | "reference-render" = "unrecognized";
  let compatibilityStatus: "matched" | "inconsistent" = "matched";
  let automationEligible = false;
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const response = structuredClone(responseFor(route.request().url()));
    if (new URL(route.request().url()).pathname === "/api/v1/status") {
      const status = response as typeof import("./large-pool-fixture.mjs").snapshot;
      status.manager.source.tier = tier;
      status.manager.source.recognized = tier !== "unrecognized";
      status.manager.source.profileId = tier === "unrecognized" ? null : `operator-${tier}`;
      status.manager.source.origin = tier === "unrecognized" ? null : "operator-installed";
      status.manager.automationEligible = automationEligible;
      status.manager.automationEligibilityReason = automationEligible
        ? "Pinned reference render and network approval verified"
        : "Reference-manager Assist is disabled";
      status.manager.provenance.status =
        tier === "reference-render"
          ? "verified"
          : tier === "custom-observe"
            ? "not-applicable"
            : "failed";
      status.manager.provenance.reason = status.manager.automationEligibilityReason;
      status.manager.installedProfiles = {
        directory: tier === "unrecognized" ? null : "/profiles",
        loaded: tier === "unrecognized" ? 0 : 1,
        issues: [],
      };
      status.preflight.compatibility.status = compatibilityStatus;
      status.preflight.compatibility.reason =
        compatibilityStatus === "matched"
          ? "Live network fingerprint matches PoX-5 Testnet"
          : "No matching compatibility profile";
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(response),
    });
  });

  await login(page);
  await openPage(page, "manager", "Manager");
  await expect(page.getByText("Unverified manager", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Add admin/ })).toBeEnabled();
  await page.evaluate(() => {
    location.hash = "#manager?action=update-fees";
  });
  await expect(page.getByRole("heading", { name: "Update manager fee" })).toBeVisible();
  await expect(page.getByLabel("Signing manager admin")).toBeVisible();

  tier = "custom-observe";
  await page.reload();
  await openPage(page, "manager", "Manager");
  await expect(page.getByText("Custom manager", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Add admin/ })).toBeEnabled();

  tier = "reference-render";
  await page.reload();
  await openPage(page, "manager", "Manager");
  await expect(page.getByText("Verified reference", { exact: true })).toBeVisible();
  await expect(page.getByText("Operator-installed")).toBeVisible();
  await expect(
    page.locator(".statline", { hasText: "Assist" }).getByText("Unavailable", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Add admin/ })).toBeEnabled();
  await page.evaluate(() => {
    location.hash = "#manager?action=update-fees";
  });
  await expect(page.getByRole("heading", { name: "Update manager fee" })).toBeVisible();
  await expect(page.getByLabel("Signing manager admin")).toBeVisible();
  await expect(page.getByText("Guided manager actions are unavailable.")).toHaveCount(0);
  await openPage(page, "rewards", "Rewards");
  await expect(page.getByRole("button", { name: "Update manager fee" })).toBeEnabled();
  await expect(page.getByText("Guided manager actions are unavailable.")).toHaveCount(0);
  await expect(page.getByText("Unverified manager source.")).toHaveCount(0);

  await openPage(page, "manager", "Manager");
  automationEligible = true;
  compatibilityStatus = "inconsistent";
  await page.reload();
  await page.evaluate(() => {
    location.hash = "#manager?action=update-fees";
  });
  await expect(page.getByRole("heading", { name: "Update manager fee" })).toBeVisible();
  await expect(page.getByLabel("Signing manager admin")).toBeVisible();
  await expect(page.getByText("Guided manager actions are unavailable.")).toHaveCount(0);
  await openPage(page, "rewards", "Rewards");
  await expect(page.getByRole("button", { name: "Update manager fee" })).toBeEnabled();
});

test("paginates and searches a pool with hundreds of stakers", async ({ page }) => {
  await login(page);
  await openPage(page, "pool", "Pool positions");
  await expect(page.getByText(`1–50 of ${roster.length}`)).toBeVisible();
  const amountSort = page.getByRole("button", { name: "Sort by Amount, ascending" });
  await expect(amountSort).toHaveCount(1);
  await amountSort.click();
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(50);
  const smallestStaker = roster[0]?.stakerPrincipal ?? "";
  await expect(rows.nth(0).locator(`[data-copy-value="${smallestStaker}"]`)).toHaveCount(1);
  const descendingAmountSort = page.getByRole("button", { name: "Sort by Amount, descending" });
  await expect(descendingAmountSort).toHaveCount(1);
  await descendingAmountSort.click();
  const largestStaker = roster.at(-1)?.stakerPrincipal ?? "";
  await expect(rows.nth(0).locator(`[data-copy-value="${largestStaker}"]`)).toHaveCount(1);
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText(`51–100 of ${roster.length}`)).toBeVisible();
  await page.getByLabel("Search principal").fill(roster[122].stakerPrincipal);
  await expect(page.getByText("1–1 of 1")).toBeVisible();
});

test("manual wallet verification supersedes an overlapping automatic poll", async ({ page }) => {
  await page.clock.install();
  const actorPrincipal = snapshot.managerPrincipal.split(".")[0];
  let refreshCalls = 0;
  let releaseAutomaticRefresh: (() => void) | null = null;
  const automaticRefreshReleased = new Promise<void>((resolve) => {
    releaseAutomaticRefresh = resolve;
  });
  let finishAutomaticRefresh: (() => void) | null = null;
  const automaticRefreshFinished = new Promise<void>((resolve) => {
    finishAutomaticRefresh = resolve;
  });

  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    let body: unknown;
    let heldAutomaticRefresh = false;
    if (request.pathname === "/api/v1/wallet-intents" && route.request().method() === "POST") {
      body = updateFeesWalletIntent(actorPrincipal, "submitted");
    } else if (
      request.pathname ===
      `/api/v1/wallet-intents/${registerWalletIntent(actorPrincipal).intent.id}/refresh`
    ) {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        heldAutomaticRefresh = true;
        await automaticRefreshReleased;
        body = updateFeesWalletIntent(actorPrincipal, "mempool");
      } else {
        body = updateFeesWalletIntent(actorPrincipal, "complete");
      }
    } else {
      body = responseFor(route.request().url());
    }
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    } catch (cause) {
      if (!heldAutomaticRefresh) throw cause;
    } finally {
      if (heldAutomaticRefresh) finishAutomaticRefresh?.();
    }
  });

  try {
    await login(page);
    await page.evaluate(() => {
      location.hash = "#manager?action=update-fees";
    });
    await page.getByLabel("Signing manager admin").fill(actorPrincipal);
    await page.getByLabel("New fee (basis points)").fill("250");
    const walletReview = page.getByRole("region", { name: "Browser wallet" });
    await walletReview.getByRole("button", { name: "Review wallet transaction" }).click();
    await expect(walletReview.getByRole("button", { name: "Refresh verification" })).toBeVisible();

    await page.clock.runFor(15_000);
    await expect.poll(() => refreshCalls).toBe(1);
    await walletReview.getByRole("button", { name: "Refresh verification" }).click();
    await expect.poll(() => refreshCalls).toBe(2);
    await expect(walletReview).toContainText("The manual refresh verified the fee update.");
  } finally {
    releaseAutomaticRefresh?.();
    await automaticRefreshFinished;
  }

  await expect(page.getByRole("region", { name: "Browser wallet" })).toContainText(
    "The manual refresh verified the fee update.",
  );
});

test("forced Signer Health refresh supersedes an overlapping ordinary poll", async ({ page }) => {
  await page.clock.install();
  let holdNextOrdinaryPoll = false;
  let ordinaryPollStarted = false;
  let releaseOrdinaryPoll: (() => void) | null = null;
  const ordinaryPollReleased = new Promise<void>((resolve) => {
    releaseOrdinaryPoll = resolve;
  });
  let finishOrdinaryPoll: (() => void) | null = null;
  const ordinaryPollFinished = new Promise<void>((resolve) => {
    finishOrdinaryPoll = resolve;
  });

  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    let body: unknown;
    let heldOrdinaryPoll = false;
    if (request.pathname === "/api/v1/health" && route.request().method() === "GET") {
      if (holdNextOrdinaryPoll && !ordinaryPollStarted) {
        heldOrdinaryPoll = true;
        ordinaryPollStarted = true;
        await ordinaryPollReleased;
        body = { ...health, node: { ...health.node, version: "stale-poll-version" } };
      } else {
        body = health;
      }
    } else if (
      request.pathname === "/api/v1/health/refresh" &&
      route.request().method() === "POST"
    ) {
      body = { ...health, node: { ...health.node, version: "forced-refresh-version" } };
    } else {
      body = responseFor(route.request().url());
    }
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    } catch (cause) {
      if (!heldOrdinaryPoll) throw cause;
    } finally {
      if (heldOrdinaryPoll) finishOrdinaryPoll?.();
    }
  });

  try {
    await login(page);
    await openPage(page, "health", "Signer Health");
    await expect(page.getByText(health.node.version, { exact: true })).toBeVisible();
    holdNextOrdinaryPoll = true;
    await page.clock.runFor(30_000);
    await expect.poll(() => ordinaryPollStarted).toBe(true);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText("forced-refresh-version", { exact: true })).toBeVisible();
  } finally {
    releaseOrdinaryPoll?.();
    await ordinaryPollFinished;
  }

  await expect(page.getByText("forced-refresh-version", { exact: true })).toBeVisible();
  await expect(page.getByText("stale-poll-version", { exact: true })).toHaveCount(0);
});

test("editing a Settings source invalidates its overlapping connection test", async ({ page }) => {
  let sourceTestCalls = 0;
  let releaseSourceTest: (() => void) | null = null;
  const sourceTestReleased = new Promise<void>((resolve) => {
    releaseSourceTest = resolve;
  });
  let finishSourceTest: (() => void) | null = null;
  const sourceTestFinished = new Promise<void>((resolve) => {
    finishSourceTest = resolve;
  });

  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    const heldSourceTest = request.pathname === "/api/v1/health/test-source";
    let body: unknown;
    if (heldSourceTest) {
      sourceTestCalls += 1;
      await sourceTestReleased;
      body = { status: "connected", signals: 7 };
    } else {
      body = responseFor(route.request().url());
    }
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    } catch (cause) {
      if (!heldSourceTest) throw cause;
    } finally {
      if (heldSourceTest) finishSourceTest?.();
    }
  });

  try {
    await login(page);
    await openPage(page, "settings", "Settings");
    const metricsUrl = page.getByLabel("Node metrics URL");
    await metricsUrl.locator("xpath=following-sibling::button").click();
    await expect.poll(() => sourceTestCalls).toBe(1);
    await expect(page.getByText("Connecting…", { exact: true })).toBeVisible();

    await metricsUrl.fill("http://replacement-node:9153");
    await expect(page.getByText("Connecting…", { exact: true })).toHaveCount(0);
  } finally {
    releaseSourceTest?.();
    await sourceTestFinished;
  }

  await expect(page.getByLabel("Node metrics URL")).toHaveValue("http://replacement-node:9153");
  await expect(page.getByText("Connected · 7 recognized signals", { exact: true })).toHaveCount(0);
});

test("copies the full principal from an abbreviated address", async ({ page }) => {
  await login(page);
  await openPage(page, "pool", "Pool positions");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => sessionStorage.setItem("copied-principal", value),
      },
    });
  });

  const principal = roster[0].stakerPrincipal;
  const copy = page.locator(`button[data-copy-value="${principal}"]`);
  const value = copy.locator("xpath=preceding-sibling::*[1]");
  await expect(copy).toHaveCount(1);
  const copyBox = await copy.boundingBox();
  const valueBox = await value.boundingBox();
  expect(copyBox).not.toBeNull();
  expect(valueBox).not.toBeNull();
  expect(copyBox?.x ?? 0).toBeGreaterThanOrEqual((valueBox?.x ?? 0) + (valueBox?.width ?? 0));
  await expect(copy).toHaveCSS("opacity", "0");
  await copy.hover();
  await expect(copy).toHaveCSS("opacity", "1");
  await copy.click();
  await expect(copy).toHaveAttribute("aria-label", "Copied staker principal");
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("copied-principal")))
    .toBe(principal);
});

test("paginates multi-year reward history", async ({ page }) => {
  await login(page);
  await openPage(page, "rewards", "Rewards");
  await expect(page.getByText("1–10 of 48")).toBeVisible();
  const paginations = page.getByRole("navigation", { name: "Table pagination" });
  await paginations.first().getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("11–20 of 48")).toBeVisible();
});
