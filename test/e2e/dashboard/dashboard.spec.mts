import { expect, type Page, test } from "@playwright/test";
import { health, responseFor, roster, snapshot } from "./large-pool-fixture.mjs";

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
  return { approval, job, jobId, status, summary };
}

test("renders every operator screen without leaking the credential", async ({ page }) => {
  await login(page);
  const navigationTargets = await page
    .locator(".sidebar nav a.item")
    .evaluateAll((items) => items.map((item) => item.getAttribute("href")));
  expect(navigationTargets.slice(0, 6)).toEqual([
    "#overview",
    "#registration",
    "#pool",
    "#rewards",
    "#operations",
    "#health",
  ]);
  const screens = [
    ["health", "Signer Health"],
    ["registration", "Registration"],
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

test("treats an HTTP 501 transaction engine as an unavailable Observe surface", async ({
  page,
}) => {
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    const unavailable = request.pathname.startsWith("/api/v1/engine");
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
  await expect(page.getByText("Observe unavailable", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Existing ingestion, reconciliation, and alerts remain available"),
  ).toBeVisible();
  consoleErrors.set(page, []);
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
    if (request.pathname === "/api/v1/engine") {
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
  await expect(page.getByText("Exact transaction review", { exact: true })).toBeVisible();
  await expect(page.getByText("Last reward compute height", { exact: true })).toBeVisible();
  await expect(page.getByText("Maximum asset outflow", { exact: true })).toBeVisible();
  await expect(page.getByText("Attestation hash", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Approve intent" }).evaluate((button) => {
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
  await expect(cards.nth(2)).toContainText("~10d 16h · 24h average");
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
    detail:
      "Sidekick has not synchronized the individual staker roster. Run Reconcile now before relying on payout totals.",
    action: { kind: "reconcile", label: "Reconcile now" },
  };
  const withdrawalAlert = {
    id: "withdrawals:pending",
    severity: "info",
    title: "L1 Withdrawals Await Resolution",
    detail: "Open Rewards → L1 withdrawals to review each request's current state.",
    action: { kind: "navigate", label: "Review L1 withdrawals", target: "rewards" },
  };
  const informationalAlert = {
    id: "manager:custom-read-only",
    severity: "info",
    title: "Custom Manager — Read-only",
    detail: "No action is required unless reference-manager Assist is intended.",
  };
  const actionSnapshot = {
    ...snapshot,
    alerts: [rewardsAlert, withdrawalAlert, informationalAlert],
  };
  let syncRequests = 0;

  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    let body: unknown;
    if (request.pathname === "/api/v1/status") {
      body = actionSnapshot;
    } else if (request.pathname === "/api/v1/sync") {
      syncRequests += 1;
      body = { snapshot: actionSnapshot };
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
  await expect(page.getByText("2 item(s) need attention")).toBeVisible();
  await expect(requiredActions.getByText("Reward Roster Is Incomplete")).toBeVisible();
  await expect(requiredActions.getByText("L1 Withdrawals Await Resolution")).toBeVisible();
  await expect(requiredActions.getByText("Custom Manager — Read-only")).not.toBeVisible();

  await requiredActions.getByRole("button", { name: "Reconcile now" }).click();
  await expect.poll(() => syncRequests).toBe(1);

  await requiredActions.getByRole("button", { name: "Review L1 withdrawals" }).click();
  await expect(page.getByRole("heading", { name: "Rewards", exact: true })).toBeVisible();

  await openPage(page, "operations", "Operations");
  const informationalRow = page.locator(".alert-row", { hasText: "Custom Manager — Read-only" });
  await expect(informationalRow).toBeVisible();
  await expect(informationalRow.getByRole("button")).toHaveCount(0);
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

test("explains the manager trust tier on registration and settings", async ({ page }) => {
  await login(page);
  await openPage(page, "registration", "Registration");
  await expect(page.getByText("Reference — built in")).toBeVisible();
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
  await expect(page.getByText(/revision 1 is built into Sidekick/)).toBeVisible();
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
  await expect(page.getByText("Node and signer setup stay outside Sidekick.")).toBeVisible();
  await expect(page.getByText(/Sidekick generates the deployment files/)).toBeVisible();
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
  await expect(page.getByText(/verified Hiro chainstate archive/)).toBeVisible();

  await openPage(page, "settings", "Settings");
  await expect(page.getByText("Network compatibility: matched")).toBeVisible();
  await expect(
    page.getByText(/compatible upgrades do not require a Sidekick release/),
  ).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Deploy outside Sidekick" })).toBeVisible();
  await expect(page.getByText(/manifest records the values you must review/)).toBeVisible();
  await expect(page.getByText("signer-manager", { exact: true })).toBeVisible();
  await expect(page.getByText("testnet", { exact: true })).toBeVisible();
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

test("advances fresh setup after a transient deployment refresh failure", async ({ page }) => {
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
  await expect(page.getByText("Request failed: fresh setup refresh failed")).toBeVisible();

  await page.clock.runFor(20_000);

  await expect(page.getByRole("button", { name: "Generate signer command" })).toBeVisible();
  await expect(page.getByText("Request failed: fresh setup refresh failed")).toHaveCount(0);
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
  await expect(page.getByText(/Sidekick checked the configured node/)).toBeVisible();
  await expect(page.getByText("sidekick preflight --json")).not.toBeVisible();
  await page.getByText("CLI equivalent (advanced)").click();
  await expect(page.getByText("sidekick preflight --json")).toBeVisible();

  currentStep = "render-manager";
  await page.reload();
  await expect(page.getByText(/generated the manager source/)).toBeVisible();
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
  await expect(page.getByText(/Sidekick never receives the key or broadcasts/)).toBeVisible();
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
  await expect(
    page.getByText(/Guided repair for an existing manager is not yet available/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Public Pool Page" })).toBeVisible();
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
  await expect(page.getByText(/never accesses the signer key or broadcasts/)).toBeVisible();
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
  await expect(page.getByText(/reject output for a different manager, auth ID/)).toBeVisible();
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
  await expect(page.getByText(/supported wallet or enrollment tools/)).toBeVisible();
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
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const response = structuredClone(responseFor(route.request().url()));
    if (new URL(route.request().url()).pathname === "/api/v1/status") {
      const status = response as typeof import("./large-pool-fixture.mjs").snapshot;
      status.manager.source.tier = tier;
      status.manager.source.recognized = tier !== "unrecognized";
      status.manager.source.profileId = tier === "unrecognized" ? null : `operator-${tier}`;
      status.manager.source.origin = tier === "unrecognized" ? null : "operator-installed";
      status.manager.automationEligible = tier === "reference-render";
      status.manager.automationEligibilityReason =
        tier === "reference-render"
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
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(response),
    });
  });

  await login(page);
  await openPage(page, "registration", "Registration");
  await expect(page.getByText("Not recognized — read-only")).toBeVisible();
  await expect(page.getByText(/Attach and all data display work normally/)).toBeVisible();

  tier = "custom-observe";
  await page.reload();
  await openPage(page, "registration", "Registration");
  await expect(page.getByText("Custom — read-only")).toBeVisible();

  tier = "reference-render";
  await page.reload();
  await openPage(page, "registration", "Registration");
  await expect(page.getByText("Reference render — verified")).toBeVisible();
  await expect(page.getByText("Operator-installed")).toBeVisible();
});

test("paginates and searches a pool with hundreds of stakers", async ({ page }) => {
  await login(page);
  await openPage(page, "pool", "Pool positions");
  await expect(page.getByText(`1–50 of ${roster.length}`)).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText(`51–100 of ${roster.length}`)).toBeVisible();
  await page.getByLabel("Search principal").fill(roster[122].stakerPrincipal);
  await expect(page.getByText("1–1 of 1")).toBeVisible();
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
