import { expect, type Page, test } from "@playwright/test";
import {
  completedFirstRewardLedger,
  connection,
  deploymentRequirements,
  engineStatus,
  gasWalletCreated,
  gasWalletStatus,
  health,
  healthFinding,
  operationReadiness,
  overview,
  reconciliationResponse,
  responseFor,
  rewardRunFixture,
  rewardRunPreparationFixture,
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
    await route.fulfill(fixtureFulfillment(responseFor(route.request().url())));
  });
});

function fixtureFulfillment(body: unknown) {
  const record = body as {
    fixtureStatus?: number;
    fixtureContentType?: string;
    fixtureText?: string;
  };
  if (record && typeof record === "object" && record.fixtureText !== undefined) {
    return {
      status: record.fixtureStatus ?? 200,
      contentType: record.fixtureContentType ?? "text/plain",
      body: record.fixtureText,
    };
  }
  return {
    status: record?.fixtureStatus ?? 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

test.afterEach(async ({ page }) => {
  expect(consoleErrors.get(page) ?? []).toEqual([]);
});

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Operator credential").fill(credential);
  await page.getByRole("button", { name: "Open console" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
}

async function openSettingsSection(
  page: Page,
  section: "attachment" | "sources" | "capabilities" | "support",
  heading: string,
) {
  await page.evaluate((settingsSection) => {
    location.hash = `#settings?section=${settingsSection}`;
  }, section);
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
}

async function editConnection(page: Page, label: string) {
  const row = page.locator(".st-connection", { hasText: label });
  await row.getByRole("button", { name: "Edit" }).click();
  return row;
}

test("shows focused recovery when the configured signer manager is not deployed", async ({
  page,
}) => {
  const missing = {
    ...connection,
    status: "blocked",
    outcomeCode: "manager-not-deployed",
    stale: false,
    observed: {
      ...connection.observed,
      manager: {
        deployed: false,
        traitCompatible: false,
        missingRequirements: ["A contract must exist at the configured principal"],
        publishHeight: null,
        clarityVersion: null,
        epoch: null,
      },
    },
    lastSuccessful: null,
    deploymentIdentity: { status: "unbound", stored: null, reason: null },
  };
  await page.route("**/api/v1/connection*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(missing),
    });
  });

  await page.goto("/");
  await page.getByLabel("Operator credential").fill(credential);
  await page.getByRole("button", { name: "Open console" }).click();

  await expect(page.getByRole("heading", { name: "Signer manager not found" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Zero to Signing" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Recheck" })).toBeVisible();
});

test("keeps diagnostics readable and actions disabled during identity safe mode", async ({
  page,
}) => {
  const mismatch = {
    ...connection,
    status: "blocked",
    outcomeCode: "deployment-identity-mismatch",
    observed: null,
    deploymentIdentity: {
      status: "mismatch",
      stored: connection.deploymentIdentity.stored,
      reason: "The configured manager differs from the stored deployment identity.",
    },
    checks: connection.checks.map((check) =>
      check.id === "deployment-identity"
        ? { ...check, status: "fail", message: "Deployment identity does not match." }
        : check,
    ),
  };
  await page.route("**/api/v1/connection*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mismatch),
    });
  });

  await page.goto("/");
  await page.getByLabel("Operator credential").fill(credential);
  await page.getByRole("button", { name: "Open console" }).click();
  await expect(
    page.getByRole("heading", { name: "This database belongs to another deployment" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Review Activity" }).click();
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(
    page.getByText("Deployment identity mismatch · Read-only diagnostic mode"),
  ).toBeVisible();
  await page.getByRole("link", { name: "Update manager fee" }).click();
  await expect(page.getByText(/signing controls stay disabled/)).toBeVisible();
  await expect(page.getByLabel("Browser wallet")).toHaveCount(0);

  await openPage(page, "health", "Signer Health");
  await expect(page.getByRole("button", { name: "Refresh" })).toBeDisabled();

  await openPage(page, "settings", "Settings");
  await expect(page.getByText(/changes and source tests are disabled/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Save / })).toHaveCount(0);
  const supportButtons = page.getByRole("button", { name: "Support bundle" });
  await expect(supportButtons).toHaveCount(1);
  await expect(supportButtons).toBeEnabled();
});

test("keeps retained operator evidence visible during a temporary local-node outage", async ({
  page,
}) => {
  const unavailable = {
    ...connection,
    status: "unavailable",
    outcomeCode: "node-unreachable",
    stale: true,
    checkedAt: "2026-08-13T12:05:00.000Z",
    observed: null,
  };
  await page.route("**/api/v1/connection*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(unavailable),
    });
  });

  await login(page);

  await expect(page.getByText("Local node unavailable · actions paused")).toBeVisible();
  await expect(page.getByText(/Retained domain evidence remains visible/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
});

test("loads the independent operator Overview without the shared status endpoint", async ({
  page,
}) => {
  let statusRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/status") statusRequests += 1;
  });

  await login(page);

  await expect(page.getByText("Next cycle is below threshold")).toBeVisible();
  await expect(page.getByText("Reward claim is awaiting approval")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Local node" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Rewards — ready to distribute" })).toBeVisible();
  const rewardsSummary = page.locator("#overview-rewards");
  await expect(rewardsSummary.getByText("Cycle 140 · First Distribution")).toBeVisible();
  await expect(rewardsSummary.getByText("Ready to collect & distribute")).toBeVisible();
  await expect(rewardsSummary.getByText("To stakers")).toBeVisible();
  await expect(rewardsSummary.getByText("Your fee")).toBeVisible();
  await expect(rewardsSummary.getByRole("link", { name: "Review payments" })).toBeVisible();
  await expect(rewardsSummary).not.toContainText("stakers ready for payout");
  await expect(rewardsSummary).not.toContainText("Reward calculation:");
  await expect.poll(() => statusRequests).toBe(0);
});

test("preserves spacing between emphasized callout titles and their details", async ({ page }) => {
  const expectNoConcatenatedStrongSpanPairs = async () => {
    const violations = await page
      .locator(".callout .body > span, .overview-loading span")
      .evaluateAll((spans) =>
        spans.flatMap((span) => {
          const previous = span.previousSibling;
          if (!(previous instanceof HTMLElement) || previous.tagName !== "STRONG") return [];
          return [`${previous.textContent ?? ""}${span.textContent ?? ""}`];
        }),
      );
    expect(violations).toEqual([]);
  };
  const clearOverview = structuredClone(overview);
  clearOverview.attention = [];
  await page.route("**/api/v1/overview*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(clearOverview),
    });
  });

  await login(page);

  await expect(page.locator(".overview-clear-state .body")).toHaveText(
    /No action is required right now\. Current evidence was checked/,
  );
  await expectNoConcatenatedStrongSpanPairs();

  await openPage(page, "activity", "Activity");
  await expectNoConcatenatedStrongSpanPairs();
  await openPage(page, "health", "Signer Health");
  await expectNoConcatenatedStrongSpanPairs();
  await openSettingsSection(page, "capabilities", "Manager");
  await expectNoConcatenatedStrongSpanPairs();
});

test("keeps healthy Overview domains visible when one domain is unavailable", async ({ page }) => {
  const partial = structuredClone(overview);
  partial.node = {
    ...partial.node,
    status: "unavailable",
    stacksTipHeight: null,
    burnBlockHeight: null,
    peerHeightDifference: null,
    lastAdvancedAt: null,
    detail: "The local node sample is temporarily unavailable.",
    evidence: [
      {
        status: "unavailable",
        observedAt: null,
        anchor: null,
        source: "local-node",
        reason: "node request timed out",
      },
    ],
  };
  await page.route("**/api/v1/overview*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(partial),
    });
  });

  await login(page);

  await expect(page.getByText("The local node sample is temporarily unavailable.")).toBeVisible();
  await expect(
    page.getByText("The independently observed network tip is advancing."),
  ).toBeVisible();
  await expect(
    page.getByText("Signer monitoring is healthy and aligned with the node."),
  ).toBeVisible();
  await expect(
    page.locator("#overview-rewards").getByText("Cycle 140 · First Distribution", { exact: true }),
  ).toBeVisible();
});

test("retains the last Overview projection when a forced refresh fails", async ({ page }) => {
  await page.route("**/api/v1/overview*", async (route) => {
    const request = new URL(route.request().url());
    if (request.searchParams.get("refresh") === "1") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "overview_refresh_failed", retryable: true }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(overview),
    });
  });

  await login(page);
  await page.getByRole("button", { name: "Refresh current state" }).click();

  await expect(page.getByText("Could not refresh Overview")).toBeVisible();
  await expect(page.getByText("Next cycle is below threshold")).toBeVisible();
  discardExpectedHttpConsoleError(page, 503);
});

test("expands long attention lists and follows typed section actions", async ({ page }) => {
  const crowded = structuredClone(overview);
  crowded.attention = Array.from({ length: 6 }, (_, index) => ({
    ...structuredClone(overview.attention[0]),
    attentionId: `fixture:attention:${index + 1}`,
    title: `Attention item ${index + 1}`,
    primaryAction: {
      kind: "open-domain",
      page: "pool",
      section: "forecast",
      label: `Review item ${index + 1}`,
    },
  }));
  await page.route("**/api/v1/overview*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(crowded),
    });
  });

  await login(page);
  await expect(page.getByText("Attention item 6")).toHaveCount(0);
  const showAll = page.getByRole("button", { name: "Show all 6 items" });
  await showAll.click();
  await expect(page.getByText("Attention item 6")).toBeVisible();
  await expect(page.getByRole("button", { name: "All 6 items shown" })).toBeFocused();
  await expect(page.getByText("6 of 6 current attention items shown.")).toBeAttached();
  await page.getByRole("link", { name: "Review item 6" }).click();
  await expect(page).toHaveURL(/#pool\?section=forecast$/);
  await expect(page.getByRole("heading", { name: "Pool positions" })).toBeVisible();
});

test("keeps the operator Overview within the viewport", async ({ page }) => {
  await login(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("opens the dashboard from an authenticated proxy session", async ({ page }) => {
  await page.route("**/api/v1/auth/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ authenticated: true, method: "trusted-header" }),
    });
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByLabel("Operator credential")).toHaveCount(0);
});

test("provides viewport-contained touch navigation on smaller screens", async ({ page }) => {
  await login(page);
  const picker = page.getByRole("button", { name: "Dashboard page" });
  const viewport = page.viewportSize();
  if (!viewport || viewport.width > 1080) {
    await expect(picker).toBeHidden();
    return;
  }

  await picker.click();
  const navigation = page.getByRole("navigation", { name: "Dashboard pages" });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByText("Operate", { exact: true })).toBeVisible();
  await expect(navigation.getByText("Configure", { exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Overview" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  const navigationBox = await navigation.boundingBox();
  expect(navigationBox).not.toBeNull();
  expect(navigationBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((navigationBox?.x ?? 0) + (navigationBox?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
  const poolLink = navigation.getByRole("link", { name: "Pool", exact: true });
  const poolLinkBox = await poolLink.boundingBox();
  expect(poolLinkBox?.height).toBeGreaterThanOrEqual(44);

  await page.keyboard.press("Escape");
  await expect(navigation).toBeHidden();
  await expect(picker).toBeFocused();

  await picker.click();
  await poolLink.click();
  await expect(page.getByRole("heading", { name: "Pool positions", exact: true })).toBeVisible();
  await expect(navigation).toBeHidden();
});

test("keeps the single-page Settings flow responsive and preserves reward section spacing", async ({
  page,
}) => {
  const rewardsWithBond = structuredClone(snapshot);
  rewardsWithBond.rewards.buckets.push({
    bondIndex: "0",
    managerSharesSats: "0",
    signerEarnedBeforeManagerClaimSats: "0",
    rewardsPerToken: "0",
    feeSnapshotBips: "100",
    participating: false,
  });
  await page.route("**/api/v1/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(rewardsWithBond),
    });
  });
  await login(page);
  await openPage(page, "settings", "Settings");

  await expect(page.getByRole("button", { name: /Settings section/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Node & signer requirements/, exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Manager", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Reward runs/, exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Access & audit", exact: true })).toBeVisible();
  const viewport = page.viewportSize();
  if (viewport && viewport.width <= 640) {
    const indexed = await editConnection(page, "Indexed chain API");
    await expect(indexed.locator(".st-editor")).toBeVisible();
    const editorBox = await indexed.locator(".st-editor").boundingBox();
    expect(editorBox).not.toBeNull();
    expect(editorBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((editorBox?.x ?? 0) + (editorBox?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width,
    );
  }

  await openPage(page, "rewards", "Rewards");
  const nowCard = page.locator(".rw-now").first();
  const projection = page.locator("#rewards-outlook");
  await expect(nowCard).toBeVisible();
  await expect(projection).toBeVisible();
  const nowBox = await nowCard.boundingBox();
  const projectionBox = await projection.boundingBox();
  expect(nowBox).not.toBeNull();
  expect(projectionBox).not.toBeNull();
  expect(
    (projectionBox?.y ?? 0) - ((nowBox?.y ?? 0) + (nowBox?.height ?? 0)),
  ).toBeGreaterThanOrEqual(12);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    viewport.width,
  );
});

function discardExpectedHttpConsoleError(page: Page, status: number) {
  consoleErrors.set(
    page,
    (consoleErrors.get(page) ?? []).filter(
      (message) => !message.includes(`server responded with a status of ${status}`),
    ),
  );
}

async function openPage(page: Page, id: string, heading: string) {
  const picker = page.getByRole("button", { name: "Dashboard page", exact: true });
  if (await picker.isVisible()) {
    await picker.click();
    await page.locator(`.mobile-page-menu a[href="#${id}"]`).click();
  } else await page.locator(`.sidebar a[href="#${id}"]`).click();
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
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
    approvalWindow: {
      eligible: false,
      expiresAt: null,
      reason: "Single-job approvals are retired; run reward calls from Rewards",
    },
    approval: null,
    nonce: null,
    attempts: [],
    reconciliation: null,
    createdAt: now,
    updatedAt: now,
  };
  const status = {
    schemaVersion: 1,
    mode: "operator-run",
    forcedObserve: { active: false, reason: null, actor: null, forcedAt: null },
    adapters: [
      {
        adapter: review.adapter,
        label: "Reference manager claim rewards",
        mode: "operator-run",
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
  await openSettingsSection(page, "sources", "Connections");
  await editConnection(page, "Stacks node");
  await expect(page.getByLabel("Stacks node RPC URL")).toBeVisible();

  await openPage(page, "health", "Signer Health");
  await expect(page.getByRole("heading", { name: "Stacks node" })).toBeVisible();
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
  await openPage(page, "settings", "Settings");
  await openSettingsSection(page, "capabilities", "Manager");
  await expect(page.getByRole("link", { name: "Rotate", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  current = true;
  await openSettingsSection(page, "attachment", "Manager");
  await page.getByRole("button", { name: "Refresh attachment", exact: true }).click();
  await openSettingsSection(page, "capabilities", "Manager");
  await expect(page.getByRole("link", { name: "Rotate", exact: true })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
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
      { id: "manager", status: "blocked", detail: "Manager attachment is blocked." },
      { id: "signer", status: "ready", detail: "Signer registration is ready." },
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
  await openSettingsSection(page, "capabilities", "Manager");
  const readinessBlock = page.locator('section[aria-label="Reward runs"]');
  await readinessBlock.getByRole("link", { name: "Review connections" }).click();
  await expect(page).toHaveURL(/#settings\?section=sources$/);

  await openSettingsSection(page, "capabilities", "Manager");
  await readinessBlock.getByRole("link", { name: "Review manager" }).click();
  await expect(page).toHaveURL(/#settings\?section=attachment$/);
});

test("returns to login with a clear message when the credential is rejected", async ({ page }) => {
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    if (request.pathname === "/api/v1/overview") {
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
  expect(navigationTargets).toEqual([
    "#overview",
    "#pool",
    "#rewards",
    "#activity",
    "#health",
    "#settings",
  ]);
  const screens = [
    ["health", "Signer Health"],
    ["pool", "Pool positions"],
    ["rewards", "Rewards"],
    ["activity", "Activity"],
    ["settings", "Settings"],
  ];
  for (const [id, heading] of screens) await openPage(page, id, heading);
  await expect(page.locator("body")).not.toContainText(credential);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("shows active work and durable Activity evidence without horizontal overflow", async ({
  page,
}) => {
  const activityIntentId = "6ed58dac-c42c-4cb5-ad02-ed50671f3d27";
  const historicalTxid = `0x${"ab".repeat(32)}`;
  let evidenceRefreshRequests = 0;
  await page.route(`**/api/v1/wallet-intents/${activityIntentId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        updateFeesWalletIntent(snapshot.managerPrincipal.split(".")[0] ?? "", "submitted"),
      ),
    });
  });
  await page.route(`**/api/v1/wallet-intents/${activityIntentId}/refresh`, async (route) => {
    evidenceRefreshRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        updateFeesWalletIntent(snapshot.managerPrincipal.split(".")[0] ?? "", "submitted"),
      ),
    });
  });
  await login(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => sessionStorage.setItem("copied-activity-id", value),
      },
    });
  });
  await openPage(page, "activity", "Activity");

  await expect(page.getByText("Active work", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Update manager fee" })).toBeVisible();
  await expect(page.getByText("Staker reward claimed", { exact: true })).toBeVisible();
  await expect(
    page.locator("article").filter({ hasText: "Staker reward claimed" }).locator("time"),
  ).toHaveAttribute("datetime", "2026-08-13T16:00:00.000Z");

  await page.getByRole("link", { name: "Update manager fee" }).click();
  await expect(page.getByRole("heading", { name: "Operation summary" })).toBeVisible();
  await expect(page.getByLabel("Browser wallet")).toBeVisible();
  await expect(page.getByText("Transaction recorded; verification pending.")).toBeVisible();
  await expect(page.getByText("Evidence timeline", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Return to Activity" })).toBeVisible();
  await page.locator(".page-head").getByRole("button", { name: "Refresh verification" }).click();
  await expect.poll(() => evidenceRefreshRequests).toBe(1);
  await expect(page.getByText(/Verification checked\. Sidekick queried/)).toBeVisible();

  await page.getByRole("link", { name: "Return to Activity" }).click();
  await page.getByRole("link", { name: "Staker reward claimed", exact: true }).click();
  const activityIdCopy = page.locator(`button[data-copy-value="${historicalTxid}"]`).first();
  await expect(activityIdCopy).toHaveAttribute(
    "aria-label",
    `Copy transaction ID: ${historicalTxid}`,
  );
  await activityIdCopy.click();
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("copied-activity-id")))
    .toBe(historicalTxid);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("treats HTTP 501 engine and readiness endpoints as unavailable Settings capabilities", async ({
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
  await openPage(page, "settings", "Settings");
  const engine = page.locator('section[aria-label="Reward runs"]');
  await expect(engine.getByText("Unavailable", { exact: true }).first()).toBeVisible();
  await expect(engine.getByText("engine status unavailable", { exact: true })).toBeVisible();
  consoleErrors.set(page, []);
});

test("summarizes empty transaction work in Settings and links to Activity", async ({ page }) => {
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
          : responseFor(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await login(page);
  await openPage(page, "settings", "Settings");
  const engine = page.locator('section[aria-label="Reward runs"]');
  await expect(engine).toContainText("0 runs active");
  await expect(engine).toContainText("0 awaiting approval");
  await expect(engine).toContainText("0 ambiguous");
  await expect(engine.getByRole("link", { name: "Activity" })).toHaveAttribute(
    "href",
    "#activity?type=actions",
  );
});

test("reviews exact engine intent and keeps emergency controls idempotent", async ({ page }) => {
  const fixture = engineFixture();
  let forceObserveRequests = 0;
  let disableRequests = 0;
  const currentJob = fixture.job;
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
  await page.evaluate((jobId) => {
    location.hash = `#action/claim-rewards?context=engine-job&jobId=${jobId}`;
  }, fixture.jobId);
  await expect(page.getByText("Transaction review", { exact: true })).toBeVisible();
  await expect(page.getByText("Last reward compute height", { exact: true })).toBeVisible();
  await expect(page.getByText("Maximum asset outflow", { exact: true })).toBeVisible();
  await expect(page.getByText("Attestation hash", { exact: true })).toBeVisible();
  // Single-job approvals are retired (ADR 0010): the review stays read-only.
  await expect(page.getByRole("button", { name: "Approve transaction" })).toHaveCount(0);
  await expect(
    page.getByText("Single-job approvals are retired; run reward calls from Rewards"),
  ).toBeVisible();

  await openPage(page, "settings", "Settings");
  const engine = page.locator('section[aria-label="Reward runs"]');
  await expect(engine).toContainText("1 runs active · 1 awaiting approval · 0 ambiguous");
  page.once("dialog", (dialog) => dialog.accept());
  await engine.getByRole("button", { name: "Force Observe" }).click();
  await expect.poll(() => forceObserveRequests).toBe(1);
  await expect(engine.getByText("Forced Observe", { exact: true }).first()).toBeVisible();

  await engine.getByRole("button", { name: "Manage" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await engine.getByRole("button", { name: "Disable", exact: true }).click();
  await expect.poll(() => disableRequests).toBe(1);
  await expect(page.getByText("disabled", { exact: true })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("opens one exact engine job in the shared action workspace", async ({ page }) => {
  const fixture = engineFixture();
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    const body =
      request.pathname === "/api/v1/engine"
        ? fixture.status
        : request.pathname === `/api/v1/engine/jobs/${fixture.jobId}`
          ? fixture.job
          : responseFor(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await login(page);
  await page.evaluate((jobId) => {
    location.hash = `#action/claim-rewards?context=engine-job&jobId=${jobId}`;
  }, fixture.jobId);

  await expect(page.getByRole("heading", { name: "Claim manager rewards" })).toBeVisible();
  await expect(page.getByText("WHY THIS ACTION", { exact: true })).toBeVisible();
  await expect(page.getByText("Transaction review", { exact: true })).toBeVisible();
  await expect(page.getByText(fixture.jobId, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve transaction" })).toHaveCount(0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("summarizes the operation clock and links exact health evidence", async ({ page }) => {
  await login(page);
  const moments = page.locator(".overview-identity > *");
  await expect(moments).toHaveCount(3);
  await expect(moments.nth(0)).toContainText("Reward cycle");
  await expect(moments.nth(0)).toContainText("#140");
  await expect(moments.nth(1)).toContainText("Next reward calculation");
  await expect(moments.nth(1)).toContainText("9 Bitcoin blocks");
  await expect(moments.nth(2)).toContainText("Next prepare phase");
  await expect(moments.nth(2)).toContainText("1,000 Bitcoin blocks");
  await expect(page.getByText("Monitoring", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Stacks / Bitcoin", { exact: true })).toHaveCount(0);

  await page.getByRole("link", { name: "Review signer evidence" }).click();
  await expect(page).toHaveURL(/#health\?section=signer$/);
  await expect(page.getByRole("heading", { name: "Signer Health", exact: true })).toBeVisible();
  const operatingStatus = page.getByLabel("Signer operating status");
  await expect(
    operatingStatus.getByRole("heading", { name: "Signer is operating as expected" }),
  ).toBeVisible();
  await expect(operatingStatus).toContainText(
    "The signer responded as expected to all 4 observed proposals in the last 15 minutes.",
  );
  await expect(operatingStatus).toContainText("Node and signer connected");
  await expect(operatingStatus).toContainText("Aligned");
  await expect(operatingStatus).toContainText("4 proposals · no response gaps");
  await expect(operatingStatus).toContainText("0.5s");
  await expect(operatingStatus).not.toContainText("Likely source");
  await expect(operatingStatus).not.toContainText("Confidence");
  await expect(operatingStatus).toHaveClass(/health-diagnosis-healthy/);
  const signerDetails = page.locator(".health-signer-details");
  const recentSignerTelemetry = page.locator(".health-signer-window");
  await expect(signerDetails).toContainText("Manager registration");
  await expect(signerDetails).toContainText("Signer-key grant");
  await expect(signerDetails).toContainText("Current cycle");
  await expect(signerDetails).toContainText("Next cycle");
  await expect(recentSignerTelemetry).toContainText("Last 15 minutes");
  await expect(recentSignerTelemetry).not.toContainText("Manager registration");
  await expect(recentSignerTelemetry).not.toContainText("Signer-key grant");
  await expect(recentSignerTelemetry).not.toContainText("Current cycle");
  await expect(recentSignerTelemetry).not.toContainText("Next cycle");
});

test("does not claim signer responses during a healthy quiet window", async ({ page }) => {
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    const body =
      request.pathname === "/api/v1/health"
        ? {
            ...health,
            signer: {
              ...health.signer,
              last15Minutes: {
                ...health.signer.last15Minutes,
                proposals: 0,
                validationAccepted: 0,
                accepted: 0,
                preCommits: 0,
                validationP95Seconds: null,
              },
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
  await openPage(page, "health", "Signer Health");
  const operatingStatus = page.getByLabel("Signer operating status");
  await expect(operatingStatus).toContainText(
    "No signing opportunities were observed in the last 15 minutes.",
  );
  await expect(operatingStatus).toContainText("No opportunities observed");
  await expect(operatingStatus).toContainText("Not enough samples");
  await expect(operatingStatus).not.toContainText("responded as expected");
});

test("downloads the server-collected support bundle", async ({ page }) => {
  let supportRequests = 0;
  await page.route("**/api/v1/support-bundle", async (route) => {
    supportRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "content-disposition":
          'attachment; filename="signer-sidekick-support-2026-08-13T12-00-00Z.json"',
      },
      body: JSON.stringify({ documentType: "signer-sidekick-operator-support-bundle" }),
    });
  });

  await login(page);
  await openPage(page, "settings", "Settings");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Support bundle" }).click();
  const download = await downloadPromise;

  expect(supportRequests).toBe(1);
  expect(download.suggestedFilename()).toBe("signer-sidekick-support-2026-08-13T12-00-00Z.json");
});

test("routes a typed Overview action directly to its operation workspace", async ({ page }) => {
  const signerFailure = structuredClone(overview);
  signerFailure.attention = [
    {
      ...structuredClone(overview.attention[0]),
      attentionId: "manager:registration-missing",
      tier: "urgent",
      domain: "manager",
      affectedDomains: ["manager", "signer"],
      code: "signer-registration-missing",
      title: "Signer registration needs attention",
      summary: "The signer manager does not have a verified PoX-5 signer registration.",
      impact: "The signer cannot participate until registration is repaired.",
      primaryAction: {
        kind: "launch-operation",
        operation: "register-self",
        context: { kind: "none" },
        label: "Repair signer authorization",
      },
    },
  ];
  await page.route("**/api/v1/overview*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(signerFailure),
    });
  });

  await login(page);
  await expect(page.getByText("Signer registration needs attention")).toBeVisible();
  await page.getByRole("link", { name: "Repair signer authorization" }).click();
  await expect(page).toHaveURL(/#action\/register-self$/);
  await expect(page.getByRole("heading", { name: "Register or rotate signer" })).toBeVisible();
});

test("shows the PoX-5 Testnet label and network ID", async ({ page }) => {
  await login(page);
  await openPage(page, "health", "Signer Health");
  await expect(page.getByText("PoX-5 Testnet · 0x80000005")).toBeVisible();

  await openPage(page, "settings", "Settings");
  const deployment = page.locator("#st-deployment");
  await expect(deployment).toContainText("PoX-5 Testnet");
  await expect(deployment).toContainText("chain 0x80000005");
  await expect(deployment).toContainText("revision 1 · built in");
});

test("edits indexed and comparison API credentials independently", async ({ page }) => {
  const submissions: Record<string, unknown>[] = [];
  await page.route("**/api/v1/settings", async (route) => {
    if (route.request().method() === "PUT") {
      submissions.push(route.request().postDataJSON() as Record<string, unknown>);
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(snapshot.runtimeSettings),
    });
  });

  await login(page);
  await openSettingsSection(page, "sources", "Connections");
  await expect(page.getByLabel("Minimum fee")).toHaveValue("0.003");
  await expect(page.getByLabel("Standard fee")).toHaveValue("0.01");
  await page.getByLabel("Forecast horizon").fill("12");
  const indexed = await editConnection(page, "Indexed chain API");
  await expect(indexed.getByText("provided by the environment", { exact: true })).toBeVisible();
  await indexed.locator('input[type="password"]').fill("new-indexed-secret");
  await expect(indexed.getByRole("button", { name: "Test saved connection" })).toBeDisabled();

  const comparison = await editConnection(page, "Network comparison API");
  await expect(comparison.getByText("key saved in Sidekick", { exact: true })).toBeVisible();
  await comparison.locator('input[type="password"]').fill("new-reference-secret");
  await page.getByRole("button", { name: "Save connections" }).click();

  expect(submissions[0]).toMatchObject({
    dataSources: {
      apiKeyAction: { action: "replace", value: "new-indexed-secret" },
      hiroReferenceApiKeyAction: { action: "replace", value: "new-reference-secret" },
    },
    forecast: snapshot.runtimeSettings.forecast,
  });
  await expect(page.getByLabel("Forecast horizon")).toHaveValue("12");
  await page
    .locator('section[aria-label="Preferences"]')
    .getByRole("button", { name: "Save", exact: true })
    .click();
  expect(submissions[1]).toMatchObject({
    dataSources: {
      apiKeyAction: { action: "keep" },
      hiroReferenceApiKeyAction: { action: "keep" },
    },
    forecast: { horizonCycles: 12 },
  });
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
            diagnosis: {
              ...health.diagnosis,
              status: "needs-attention",
              title: "Signer cannot reach its Stacks node",
              summary: "The signer heartbeat failed three consecutive checks.",
              classification: "likely-local-signer",
              activeFindingIds: ["signer-node-heartbeat-failed"],
            },
            findings: [
              healthFinding({
                id: "signer-node-heartbeat-failed",
                severity: "critical",
                title: "Signer cannot reach its Stacks node",
                detail: "The signer heartbeat failed three consecutive checks.",
                source: "signer",
              }),
            ],
            history: {
              ...health.history,
              recentEpisodes: [
                {
                  ...healthFinding({}),
                  status: "active",
                  resolvedAt: null,
                  occurrences: 3,
                },
              ],
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
  await expect(page.getByText("Signer cannot reach its Stacks node")).not.toBeVisible();
  await expect(
    page.locator(".overview-health-card", {
      has: page.getByRole("heading", { name: "Signer", exact: true }),
    }),
  ).toContainText("healthy");
  await openPage(page, "health", "Signer Health");
  await expect(
    page.getByLabel("Health findings").getByText("Signer cannot reach its Stacks node"),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Current diagnosis" })).toBeVisible();
  await expect(page.getByText("This signer", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Incident history" })).toBeVisible();
  await expect(page.getByText(/3 observations/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
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

test("explains manager attachment and trust evidence in Settings", async ({ page }) => {
  await login(page);
  await openPage(page, "settings", "Settings");
  const deployment = page.locator("#st-deployment");
  await expect(deployment).toContainText(snapshot.managerPrincipal);
  await expect(deployment.locator(".copy-identifier-button")).toBeVisible();
  const manager = page.locator('section[aria-label="Manager"]');
  await expect(manager).toContainText("built-in reference · profile");
  await expect(manager).toContainText("6 reviewed adapters");
  await expect(manager.getByText("Verified", { exact: true })).toBeVisible();
  await expect(page.getByText("Manager trust", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Installed profile store")).toHaveCount(0);
});

test("uses the recovered operator-control styling and keyboard tooltips", async ({ page }) => {
  await login(page);

  await openPage(page, "rewards", "Rewards");
  await page.locator("#rewards-outlook summary").click();
  const rewardTerm = page.getByRole("button", { name: /^Network-wide rewards/ }).first();
  await rewardTerm.focus();
  await expect
    .poll(() => rewardTerm.evaluate((element) => getComputedStyle(element, "::after").visibility))
    .toBe("visible");
  if ((page.viewportSize()?.width ?? 0) <= 1080) {
    await expect
      .poll(() => rewardTerm.evaluate((element) => getComputedStyle(element, "::after").position))
      .toBe("fixed");
  }
  const rewardInfo = page.locator(".rw-now .rw-info").first();
  await rewardInfo.focus();
  await expect(rewardInfo).toHaveAttribute("data-tooltip", /.+/);
  await expect
    .poll(() => rewardInfo.evaluate((element) => getComputedStyle(element, "::after").visibility))
    .toBe("visible");

  await openPage(page, "activity", "Activity");
  const buttonLink = page.locator("a.btn").first();
  await expect(buttonLink).toBeVisible();
  await expect(buttonLink).toHaveCSS("text-decoration-line", "none");
  const activityStatus = page.getByRole("button", { name: "Status" });
  await expect(activityStatus).toHaveAttribute("aria-haspopup", "listbox");
  await expect(activityStatus).toHaveCSS("height", "36px");
  await activityStatus.click();
  const statusOptions = page.getByRole("listbox", { name: "Status" });
  await expect(statusOptions).toBeVisible();
  const statusMenuStyle = await statusOptions.evaluate((element) => {
    const style = getComputedStyle(element);
    const selected = element.querySelector('[role="option"][aria-selected="true"]');
    const bounds = element.getBoundingClientRect();
    const triggerBounds = element.previousElementSibling?.getBoundingClientRect();
    return {
      backgroundColor: style.backgroundColor,
      fontSize: selected ? getComputedStyle(selected).fontSize : null,
      left: bounds.left,
      right: bounds.right,
      triggerWidth: triggerBounds?.width ?? 0,
      width: bounds.width,
    };
  });
  expect(statusMenuStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(statusMenuStyle.fontSize).toBe("13px");
  expect(statusMenuStyle.width).toBeGreaterThanOrEqual(statusMenuStyle.triggerWidth - 0.5);
  expect(statusMenuStyle.left).toBeGreaterThanOrEqual(0);
  expect(statusMenuStyle.right).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  await page.getByRole("option", { name: "action required" }).click();
  await expect(activityStatus).toContainText("action required");

  const activityFilters = page.locator("form.activity-filters");
  const filterBarStyle = await activityFilters.evaluate((element) => {
    const style = getComputedStyle(element);
    const bodyStyle = getComputedStyle(document.body);
    return {
      backgroundColor: style.backgroundColor,
      bodyBackgroundColor: bodyStyle.backgroundColor,
      borderRadius: Number.parseFloat(style.borderRadius),
      overflowWidth: element.scrollWidth - element.clientWidth,
      paddingTop: style.paddingTop,
    };
  });
  expect(filterBarStyle.backgroundColor).not.toBe(filterBarStyle.bodyBackgroundColor);
  expect(filterBarStyle.borderRadius).toBeGreaterThanOrEqual(10);
  expect(filterBarStyle.overflowWidth).toBe(0);
  expect(filterBarStyle.paddingTop).toBe("12px");

  if ((page.viewportSize()?.width ?? 0) > 1080) {
    const filterBarBox = await activityFilters.boundingBox();
    expect(filterBarBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(80);
  }

  await openSettingsSection(page, "capabilities", "Manager");
  const capability = page
    .locator('section[aria-label="Manager"] .st-row', { hasText: "Reward calls" })
    .getByRole("button", { name: "Details" });
  await capability.focus();
  await expect
    .poll(() => capability.evaluate((element) => getComputedStyle(element, "::after").visibility))
    .toBe("visible");
});

test("checks deployment requirements and shows exact operator-owned remediation", async ({
  page,
}) => {
  await login(page);
  await openPage(page, "settings", "Settings");

  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Node & signer requirements/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run checks" })).toBeVisible();
  const transactionIndex = page.locator(".st-requirement", { hasText: "Node transaction index" });
  await expect(transactionIndex).toContainText("HTTP 501");
  await transactionIndex.getByRole("button", { name: "Resolve" }).click();
  await expect(transactionIndex.locator("pre")).toContainText("txindex = true");
  await expect(transactionIndex).toContainText("Restart after changing configuration: stacks-node");
  await expect(transactionIndex).toBeInViewport();
});

test("shows successful live checks as connected in every connection summary", async ({ page }) => {
  const readyRequirements = {
    ...deploymentRequirements,
    status: "ready",
    requiredReady: true,
    checks: [
      ...deploymentRequirements.checks.map((check) => ({
        ...check,
        status: "pass",
        summary: `${check.title} is ready.`,
        remediation: null,
      })),
      {
        id: "node-metrics",
        component: "node",
        importance: "recommended",
        status: "pass",
        title: "Node metrics",
        summary: "Sidekick recognized the node metrics endpoint.",
        observed: "3 recognized signals",
        remediation: null,
      },
      {
        id: "signer-monitoring",
        component: "signer",
        importance: "recommended",
        status: "pass",
        title: "Signer monitoring",
        summary: "Sidekick recognized the signer monitoring endpoint.",
        observed: "16 recognized signals",
        remediation: null,
      },
      {
        id: "sidekick-event-observer",
        component: "sidekick",
        importance: "recommended",
        status: "pass",
        title: "Stacks event observer",
        summary: "Verified callbacks are current.",
        observed: "Observer gap: 0 blocks",
        remediation: null,
      },
      {
        id: "hiro-reference",
        component: "sidekick",
        importance: "recommended",
        status: "pass",
        title: "Network comparison API",
        summary: "Sidekick verified the external comparison API.",
        observed: "https://api.testnet-pox5.hiro.so",
        remediation: null,
      },
    ],
  };
  await page.route("**/api/v1/deployment-requirements*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(readyRequirements),
    });
  });
  await page.route("**/api/v1/health/test-source", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "connected", signals: 4 }),
    });
  });

  await login(page);
  await openSettingsSection(page, "sources", "Connections");

  for (const label of ["Stacks node", "Node monitoring", "Signer monitoring"]) {
    const row = page.locator(".st-connection", { hasText: label });
    await expect(row.locator(".badge")).toHaveText("Connected");
  }

  const comparison = await editConnection(page, "Network comparison API");
  await expect(comparison.locator(".badge")).toHaveText("Connected");
  await comparison.getByRole("button", { name: "Test saved connection" }).click();
  await expect(comparison.locator(".badge")).toHaveText("Connected");

  await page.evaluate(() => {
    location.hash = "#settings?section=requirements";
  });
  await expect(page.getByRole("heading", { name: /Node & signer requirements/ })).toBeVisible();
  await expect(page.locator(".st-requirement", { hasText: "Stacks event observer" })).toHaveCount(
    1,
  );
});

test("starts an admin-history sync from Settings", async ({ page }) => {
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
  await openSettingsSection(page, "capabilities", "Manager");
  await page.getByRole("button", { name: "Sync admin history" }).click();

  await expect(page.getByText("Syncing chain data")).toBeVisible();
  await expect.poll(() => syncRequests).toBe(1);
});

test("deep-links reward administration and blocks manager-admin self-removal", async ({ page }) => {
  const adminPrincipal = snapshot.managerPrincipal.split(".")[0];
  await login(page);
  await openPage(page, "rewards", "Rewards");
  const projection = page.locator("#rewards-outlook");
  await projection.locator("summary").click();
  await expect(projection.getByText("0.025 sBTC", { exact: true })).toBeVisible();
  await expect(projection.getByText("0.05 sBTC", { exact: true }).first()).toBeVisible();
  await expect(projection.getByText("0.008 sBTC – 0.012 sBTC", { exact: true })).toBeVisible();
  await expect(projection).toContainText("in 1,050 Bitcoin blocks · about 7d 7h");
  await expect(projection).toContainText("low confidence");
  await page.getByRole("button", { name: "Update manager fee" }).click();
  await expect(page).toHaveURL(/#action\/update-fees$/);
  await expect(page.getByRole("heading", { name: "Update manager fee" })).toBeVisible();
  await page.getByLabel("Signing manager admin").fill(adminPrincipal);
  await page.getByLabel("New fee (basis points)").fill("250");
  await expect(page.getByLabel("Browser wallet")).toBeVisible();

  await openPage(page, "rewards", "Rewards");
  await page.getByRole("button", { name: "Withdraw earned fees" }).click();
  await expect(page).toHaveURL(/#action\/withdraw-fees$/);
  await expect(page.getByRole("heading", { name: "Withdraw earned fees" })).toBeVisible();

  await openPage(page, "rewards", "Rewards");
  await page.getByRole("button", { name: "Sweep fee refunds" }).click();
  await expect(page).toHaveURL(/#action\/sweep-fee-refunds$/);
  await expect(page.getByRole("heading", { name: "Sweep fee-refund dust" })).toBeVisible();

  await page.evaluate(() => {
    location.hash = "#action/remove-admin";
  });
  await expect(page.getByRole("heading", { name: "Remove manager admin" })).toBeVisible();
  await page.getByLabel("Signing manager admin").fill(adminPrincipal);
  await page.getByLabel("Admin principal to remove").fill(adminPrincipal);
  await expect(page.getByText("An admin cannot remove itself.")).toBeVisible();
  await expect(page.getByLabel("Browser wallet")).toHaveCount(0);
});

async function openWalletSettlement(page: Page) {
  const details = page.locator("details", {
    has: page.getByText("Distribute with your wallet", { exact: false }),
  });
  await details.locator("summary").click();
}

test("prepares a staker settlement through the browser-wallet flow", async ({ page }) => {
  await login(page);
  await openPage(page, "rewards", "Rewards");

  await openWalletSettlement(page);
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
  pendingSnapshot.rewardOutlook.calculation = {
    ...pendingSnapshot.rewardOutlook.calculation,
    state: "pending",
    next: {
      state: "due",
      targetRewardCycle: pendingSnapshot.rewardOutlook.calculation.targetRewardCycle,
      targetCheckpoint: pendingSnapshot.rewardOutlook.calculation.targetCheckpoint,
      calculationBurnHeight:
        pendingSnapshot.rewardOutlook.calculation.expectedLastRewardComputeBurnHeight,
      eligibleBurnHeight:
        pendingSnapshot.rewardOutlook.calculation.expectedLastRewardComputeBurnHeight + 1,
      blocksRemaining: 0,
      grace: {
        state: "action-required",
        firstEligibleObservedAt: "2026-08-13T11:50:00.000Z",
        firstEligibleStacksBlockHeight: 8_749_976,
        elapsedMinutes: 10,
        canonicalStacksBlocks: 24,
        requiredMinutes: 10,
        requiredCanonicalStacksBlocks: 24,
      },
    },
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
  await openWalletSettlement(page);
  await expect(
    page.getByText("Staker rewards become available after the global calculation runs."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check what settling this cycle costs" }),
  ).toHaveCount(0);
  expect(settlementReads).toBe(0);

  // The separate legacy calculation callout is intentionally gone; the distribution card owns
  // that action so the page never offers two competing paths for the same operation.
  await expect(page.getByRole("link", { name: "Review calculation" })).toHaveCount(0);
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
  await openWalletSettlement(page);
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
  await page.evaluate(() => {
    location.hash = "#action/update-fees";
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
    managerPrincipal: snapshot.managerPrincipal,
    pox5ContractId: "ST000000000000000000002AMW42H.pox-5",
    command: "stacks-signer generate-stacking-signature --config /srv/signer/Signer.toml",
    expectedMessageHashHex: "ab".repeat(32),
    authId: "141",
  };
  const verified = {
    managerPrincipal: snapshot.managerPrincipal,
    pox5ContractId: preparation.pox5ContractId,
    authId: "141",
    signerKeyHex: `02${"12".repeat(32)}`,
    signerSignatureHex: "34".repeat(65),
    expectedMessageHashHex: preparation.expectedMessageHashHex,
    signatureValid: true,
    registerSelfCall: {
      contract: snapshot.managerPrincipal,
      functionName: "register-self",
      arguments: ["0x01", "0x02", "0x03", "0x04"],
      signingPrincipal: actorPrincipal,
      signingAuthority: "external-offline-admin",
    },
  };
  const grantResponse = (withVerification: boolean) => ({
    preparation,
    verified: withVerification ? verified : null,
  });
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
      body = { signerGrant: grantResponse(false) };
    } else if (request.pathname === "/api/v1/manager/signer-grant/verify") {
      verifyBody = route.request().postDataJSON();
      body = { signerGrant: grantResponse(true) };
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
  await openPage(page, "settings", "Settings");
  await page.getByRole("link", { name: "Rotate", exact: true }).click();
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

test("uses one document scroll for desktop Settings", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) <= 1080, "Desktop settings shell only");
  await login(page);
  await openPage(page, "settings", "Settings");

  await expect(page.locator(".settings-scroll")).toHaveCount(0);
  await expect(page.locator(".set-nav")).toHaveCount(0);
  await page.getByRole("heading", { name: "Access & audit", exact: true }).scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(page.getByRole("heading", { name: "Access & audit", exact: true })).toBeInViewport();
});

test("hands first-time signer setup to the maintained external flow", async ({ page }) => {
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    const body =
      request.pathname === "/api/v1/status"
        ? {
            ...structuredClone(snapshot),
            manager: {
              ...structuredClone(snapshot.manager),
              attachAllowed: false,
              reasons: ["The configured manager contract is not deployed"],
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
  await openPage(page, "settings", "Settings");
  await expect(page.getByText("Connect a running signer manager.")).toBeVisible();
  await expect(page.getByText(/Complete first-time setup/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Zero to Signing/ })).toHaveAttribute(
    "href",
    "https://stx.fan/zero_to/signing/",
  );
  await expect(page.locator("body")).not.toContainText(credential);
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
        : "Reviewed reward calls are disabled for this manager";
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
  await openPage(page, "settings", "Settings");
  const manager = page.locator('section[aria-label="Manager"]');
  await expect(manager).toContainText("custom · profile none");
  await openSettingsSection(page, "capabilities", "Manager");
  await expect(page.getByRole("link", { name: "Rotate", exact: true })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  await page.evaluate(() => {
    location.hash = "#action/update-fees";
  });
  await expect(page.getByRole("heading", { name: "Update manager fee" })).toBeVisible();
  await expect(page.getByLabel("Signing manager admin")).toBeVisible();

  tier = "custom-observe";
  await page.reload();
  await openSettingsSection(page, "attachment", "Manager");
  await expect(manager).toContainText("recorded custom · profile operator-custom-observe");
  await openSettingsSection(page, "capabilities", "Manager");
  await expect(page.getByRole("link", { name: "Rotate", exact: true })).toHaveAttribute(
    "aria-disabled",
    "false",
  );

  tier = "reference-render";
  await page.reload();
  await openSettingsSection(page, "attachment", "Manager");
  await expect(manager).toContainText("reviewed · profile operator-reference-render");
  await openSettingsSection(page, "capabilities", "Manager");
  const rewardCalls = manager.locator(".st-row", { hasText: "Reward calls" });
  await expect(rewardCalls.getByText("Available", { exact: true })).toBeVisible();
  await expect(rewardCalls.getByRole("button", { name: "Details" })).toHaveAttribute(
    "data-tooltip",
    "Reviewed call adapters Sidekick can build and verify for this manager. Whether Sidekick signs them is controlled separately by Reward runs.",
  );
  await expect(page.getByRole("link", { name: "Rotate", exact: true })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  await page.evaluate(() => {
    location.hash = "#action/update-fees";
  });
  await expect(page.getByRole("heading", { name: "Update manager fee" })).toBeVisible();
  await expect(page.getByLabel("Signing manager admin")).toBeVisible();
  await expect(page.getByText("Guided manager actions are unavailable.")).toHaveCount(0);
  await openPage(page, "rewards", "Rewards");
  await expect(page.getByRole("button", { name: "Update manager fee" })).toBeEnabled();
  await expect(page.getByText("Guided manager actions are unavailable.")).toHaveCount(0);
  await expect(page.getByText("Unverified manager source.")).toHaveCount(0);

  await openPage(page, "settings", "Settings");
  automationEligible = true;
  compatibilityStatus = "inconsistent";
  await page.reload();
  await page.evaluate(() => {
    location.hash = "#action/update-fees";
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
  const forecast = page.locator(".forecast-card");
  const forecastSummary = forecast.getByRole("region", { name: "Pool forecast summary" });
  await expect(forecastSummary).toBeVisible();
  const forecastChart = forecast.getByRole("img", { name: "Pool total forecast" });
  await expect(forecastChart).toBeVisible();
  await expect(forecastSummary.getByText("16,800,000 STX", { exact: true })).toBeVisible();
  await expect(forecastSummary.getByText("Cycle 140", { exact: true })).toBeVisible();
  await expect(forecastSummary.getByText("−200,000 STX", { exact: true })).toBeVisible();
  await expect(forecastSummary.getByText("15,800,000 STX", { exact: true })).toBeVisible();
  await expect(forecastSummary.getByText("−1,000,000 STX · −6%", { exact: true })).toBeVisible();
  const axisLabels = await forecast.locator(".forecast-axis-label").allTextContents();
  expect(axisLabels).toHaveLength(3);
  expect(axisLabels.every((label) => label.endsWith(" STX"))).toBe(true);
  expect(axisLabels.some((label) => label.includes("%"))).toBe(false);
  const chartOverflow = await forecastChart.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(chartOverflow).toBeLessThanOrEqual(1);
  const forecastBox = await forecast.boundingBox();
  expect(forecastBox?.height).toBeLessThan(340);
  await expect(page.getByText(`1–50 of ${roster.length}`)).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) <= 640) {
    await page.getByLabel("Sort roster by").selectOption("amount");
  } else {
    const amountSort = page.getByRole("button", { name: "Sort by Amount, ascending" });
    await expect(amountSort).toHaveCount(1);
    await amountSort.click();
  }
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(50);
  const smallestStaker = roster[0]?.stakerPrincipal ?? "";
  await expect(rows.nth(0).locator(`[data-copy-value="${smallestStaker}"]`)).toHaveCount(1);
  if ((page.viewportSize()?.width ?? 0) <= 640) {
    await page.getByRole("button", { name: "Sort direction: ascending" }).click();
  } else {
    const descendingAmountSort = page.getByRole("button", {
      name: "Sort by Amount, descending",
    });
    await expect(descendingAmountSort).toHaveCount(1);
    await descendingAmountSort.click();
  }
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
      location.hash = "#action/update-fees";
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
    await openSettingsSection(page, "sources", "Connections");
    const nodeMonitoring = await editConnection(page, "Node monitoring");
    const metricsUrl = page.getByLabel("Node metrics URL");
    await nodeMonitoring.getByRole("button", { name: "Test", exact: true }).click();
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
  await expect(value).toHaveText(`${principal.slice(0, 6)}…${principal.slice(-6)}`);
  await expect(value.locator("xpath=parent::*")).toHaveAttribute("title", principal);
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

test("pages multi-year reward history and loads payments on demand", async ({ page }) => {
  await login(page);
  await openPage(page, "rewards", "Rewards");
  await expect(page.getByText("6 of 12 cycles")).toBeVisible();
  await page.getByRole("button", { name: "Show older" }).click();
  await expect(page.getByText("12 of 12 cycles")).toBeVisible();
  await page
    .locator("#rewards-cycle-139")
    .getByRole("button", { name: "Show distributions" })
    .click();
  const panel = page.locator(".rw-ledger-panel");
  await expect(panel.getByRole("tab", { name: /First Distribution/ })).toBeVisible();
  await expect(panel.getByRole("tab", { name: /Paid · 40/ })).toBeVisible();
});

test("keeps a completed current-cycle distribution accessible during the second half", async ({
  page,
}) => {
  await page.route("**/api/v1/rewards/ledger*", async (route) => {
    await route.fulfill(fixtureFulfillment(completedFirstRewardLedger(route.request().url())));
  });

  await login(page);
  await openPage(page, "rewards", "Rewards");

  const currentCycle = page.locator("#rewards-calculation");
  await expect(
    currentCycle.getByText("First Distribution complete", { exact: true }),
  ).toBeVisible();
  await expect(currentCycle.getByText(/40 of 40 paid/)).toBeVisible();
  const view = currentCycle.getByRole("button", { name: "View payments" });
  await expect(view).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("All available distributions have been completed.")).toBeVisible();

  await view.click();
  await expect(view).toHaveAttribute("aria-expanded", "true");
  const details = page.locator("#rewards-current-distribution-140-1");
  await expect(details.getByRole("heading", { name: "First Distribution details" })).toBeVisible();
  await expect(details.getByText(/Calculation confirmed · rewards collected/)).toBeVisible();
  await expect(details.getByRole("tab", { name: "Paid · 40" })).toBeVisible();
  const detailsBox = await details.boundingBox();
  const projectionBox = await page.locator("#rewards-outlook").boundingBox();
  expect(detailsBox).not.toBeNull();
  expect(projectionBox).not.toBeNull();
  expect(
    (projectionBox?.y ?? 0) - ((detailsBox?.y ?? 0) + (detailsBox?.height ?? 0)),
  ).toBeGreaterThanOrEqual(12);
  await details.getByRole("button", { name: "Close" }).click();
  await expect(details).toHaveCount(0);
  await expect(view).toBeFocused();
});

test("shows the ready distribution with payments, exports, and the wallet fallback", async ({
  page,
}) => {
  const downloads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/rewards/ledger/")) downloads.push(request.url());
  });
  await login(page);
  await openPage(page, "rewards", "Rewards");
  const now = page.locator(".rw-now");
  await expect(now.getByText("Cycle 140 · First Distribution")).toBeVisible();
  await expect(now.getByRole("heading", { name: "Ready to collect & distribute" })).toBeVisible();
  await expect(now.getByRole("button", { name: "Collect & distribute" })).toBeDisabled();
  await expect(now.getByText("Calculated for this pool", { exact: true })).toBeVisible();
  await expect(now.getByText("0 of 40", { exact: true })).toBeVisible();
  await expect(page.getByText("Sign with your own wallet.")).toBeVisible();

  const payments = page.locator("#rewards-distribution-140-1 .rw-payments");
  const principal = roster[0].stakerPrincipal;
  const principalValue = payments
    .locator(`[data-copy-value="${principal}"]`)
    .first()
    .locator("xpath=preceding-sibling::*[1]");
  await expect(principalValue).toHaveText(`${principal.slice(0, 6)}…${principal.slice(-6)}`);
  await expect(principalValue.locator("xpath=parent::*")).toHaveAttribute("title", principal);
  expect(
    await payments.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(
    0,
  );
  await expect(payments.getByRole("tab", { name: "Outstanding · 40" })).toBeVisible();
  await expect(payments.getByRole("tab", { name: "Paid · 0" })).toBeDisabled();
  await expect(payments.getByRole("tab", { name: "Arriving · 0" })).toBeDisabled();
  const l1Marker = payments.locator(".rw-l1").last();
  await l1Marker.click();
  const l1Popover = l1Marker.locator("xpath=following-sibling::*[contains(@class, 'rw-l1-pop')]");
  await expect(l1Popover).toBeVisible();
  await expect(l1Popover.getByText("L1 Payout", { exact: true })).toBeVisible();
  const popoverBox = await l1Popover.boundingBox();
  const viewport = page.viewportSize();
  expect(popoverBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(popoverBox?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((popoverBox?.y ?? 0) + (popoverBox?.height ?? 0)).toBeLessThanOrEqual(
    viewport?.height ?? 0,
  );
  expect(popoverBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((popoverBox?.x ?? 0) + (popoverBox?.width ?? 0)).toBeLessThanOrEqual(viewport?.width ?? 0);
  await page.getByRole("heading", { name: "Rewards" }).click();
  await expect(l1Popover).toBeHidden();
  await page.getByLabel("Search principal").fill(roster[1].stakerPrincipal);
  await expect(payments.getByText("1 of 40 payments")).toBeVisible();
  await page.getByLabel("Search principal").fill("");
  await expect(payments.getByText("1–10 of 40")).toBeVisible();
  await payments.getByRole("button", { name: "Next" }).click();
  await expect(payments.getByText("11–20 of 40")).toBeVisible();

  // Exports live with the data: a past cycle's panel exports that distribution or the cycle…
  await page
    .locator("#rewards-cycle-139")
    .getByRole("button", { name: "Show distributions" })
    .click();
  await page.getByRole("button", { name: "This distribution" }).click();
  await expect
    .poll(() => downloads.some((url) => url.includes("/payments.csv?cycle=139&distribution=1")))
    .toBe(true);
  await page.getByRole("button", { name: "Cycle 139", exact: true }).click();
  await expect
    .poll(() => downloads.some((url) => url.endsWith("/payments.csv?cycle=139")))
    .toBe(true);
  // …and the fee ledger exports the whole history.
  await page.getByRole("button", { name: "JSON" }).click();
  await page.getByRole("button", { name: "Staker Payments", exact: true }).click();
  await expect
    .poll(() => downloads.some((url) => url.includes("/payments.json?scope=all")))
    .toBe(true);
});

test("keeps the reward action tooltip inside intermediate desktop viewports", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Intermediate desktop regression");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/api/v1/engine", async (route) => {
    await route.fulfill(fixtureFulfillment({ ...engineStatus, mode: "operator-run" }));
  });
  await page.route("**/api/v1/settings/gas-wallet", async (route) => {
    await route.fulfill(
      fixtureFulfillment({ ...gasWalletCreated, enabled: true, signer: "ready" }),
    );
  });

  await login(page);
  await openPage(page, "rewards", "Rewards");
  await expect(page.locator(".rw-now-actions .rw-gas")).toBeVisible();
  for (const width of [1081, 1152, 1280, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
  }
});

test("seals, approves, and follows a reward run from the Rewards page", async ({ page }) => {
  let runStatus: string | null = null;
  const operatorRunEngine = { ...engineStatus, mode: "operator-run" };
  const readyWallet = { ...gasWalletCreated, enabled: true, signer: "ready" };
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    const method = route.request().method();
    if (request.pathname === "/api/v1/engine") {
      await route.fulfill(fixtureFulfillment(operatorRunEngine));
      return;
    }
    if (request.pathname === "/api/v1/settings/gas-wallet") {
      await route.fulfill(fixtureFulfillment(readyWallet));
      return;
    }
    if (request.pathname === "/api/v1/rewards/runs" && method === "GET") {
      await route.fulfill(fixtureFulfillment(runStatus ? [rewardRunFixture(runStatus)] : []));
      return;
    }
    if (request.pathname === "/api/v1/rewards/runs" && method === "POST") {
      await route.fulfill(fixtureFulfillment(rewardRunPreparationFixture("queued")));
      return;
    }
    if (request.pathname.startsWith("/api/v1/rewards/run-preparations/") && method === "GET") {
      runStatus = "awaiting-approval";
      await route.fulfill(fixtureFulfillment(rewardRunPreparationFixture("ready")));
      return;
    }
    if (request.pathname.endsWith("/approve") && method === "POST") {
      runStatus = "running";
      await route.fulfill(fixtureFulfillment(rewardRunFixture("running")));
      return;
    }
    if (request.pathname.endsWith("/resume") && method === "POST") {
      runStatus = "running";
      await route.fulfill(fixtureFulfillment(rewardRunFixture("running")));
      return;
    }
    if (request.pathname.startsWith("/api/v1/rewards/runs/") && method === "GET") {
      await route.fulfill(fixtureFulfillment(rewardRunFixture(runStatus ?? "awaiting-approval")));
      return;
    }
    await route.fulfill(fixtureFulfillment(responseFor(route.request().url())));
  });

  await login(page);
  await openPage(page, "rewards", "Rewards");
  const now = page.locator(".rw-now");
  await expect(now.getByRole("button", { name: "Collect & distribute" })).toBeEnabled();
  await expect(now.getByText(/Gas wallet 12\.48 STX/)).toBeVisible();
  await now.getByRole("button", { name: "Collect & distribute" }).click();

  const sheet = page.getByRole("dialog", { name: "Collect & distribute" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Collect into the manager")).toBeVisible();
  await expect(sheet.getByText("Distribute payments")).toBeVisible();
  await expect(sheet.getByText(/41 transactions/)).toBeVisible();
  await expect(sheet.getByText(/up to 4\.10 STX gas/)).toBeVisible();
  await sheet.getByRole("button", { name: "Go" }).click();

  await expect(now.getByRole("heading", { name: /Distributing… 13 of 41 payments/ })).toBeVisible();
  await expect(now.getByText("13 of 41 transactions", { exact: false })).toBeVisible();
  await expect(now.getByRole("button", { name: "Collect & distribute" })).toHaveCount(0);

  runStatus = "halted";
  await expect(now.getByRole("heading", { name: "Run halted" })).toBeVisible({ timeout: 15_000 });
  await expect(
    now.getByText("Broadcast outcome is ambiguous", { exact: false }).first(),
  ).toBeVisible();
  await now.getByRole("button", { name: "Resume" }).click();
  await expect(now.getByRole("heading", { name: /Distributing… 13 of 41 payments/ })).toBeVisible();
});

test("renders the last verified gas-wallet status immediately across a page reload", async ({
  page,
}) => {
  const operatorRunEngine = { ...engineStatus, mode: "operator-run" };
  const readyWallet = { ...gasWalletCreated, enabled: true, signer: "ready" };
  let holdWalletStatus = false;
  let releaseWalletStatus: (() => void) | null = null;
  const walletStatusReleased = new Promise<void>((resolve) => {
    releaseWalletStatus = resolve;
  });
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    if (request.pathname === "/api/v1/engine") {
      await route.fulfill(fixtureFulfillment(operatorRunEngine));
      return;
    }
    if (request.pathname === "/api/v1/settings/gas-wallet") {
      if (holdWalletStatus) await walletStatusReleased;
      await route.fulfill(fixtureFulfillment(readyWallet));
      return;
    }
    await route.fulfill(fixtureFulfillment(responseFor(route.request().url())));
  });

  try {
    await login(page);
    await openPage(page, "rewards", "Rewards");
    await expect(page.getByText(/Gas wallet 12\.48 STX/).first()).toBeVisible();
    holdWalletStatus = true;
    await page.reload();
    await expect(page.getByRole("heading", { name: "Rewards" })).toBeVisible();
    await expect(page.getByText(/Gas wallet 12\.48 STX/).first()).toBeVisible({ timeout: 2_000 });
  } finally {
    releaseWalletStatus?.();
  }
});

test("creates a gas wallet from Settings", async ({ page }) => {
  let created = false;
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const request = new URL(route.request().url());
    if (request.pathname === "/api/v1/settings/gas-wallet" && route.request().method() === "POST") {
      created = true;
      await route.fulfill(fixtureFulfillment(gasWalletCreated));
      return;
    }
    if (request.pathname === "/api/v1/settings/gas-wallet") {
      await route.fulfill(fixtureFulfillment(created ? gasWalletCreated : gasWalletStatus));
      return;
    }
    await route.fulfill(fixtureFulfillment(responseFor(route.request().url())));
  });
  await login(page);
  await page.evaluate(() => {
    location.hash = "#settings?section=gas-wallet";
  });
  const section = page.locator('section[aria-label="Reward runs"]');
  await expect(page.getByRole("heading", { name: /Reward runs/ })).toBeVisible();
  await expect(section.getByText("Not set up")).toBeVisible();
  await section.getByRole("button", { name: "Create gas wallet" }).click();
  await expect(section.getByText("ST2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7")).toBeVisible();
  await expect(section.getByText(/12\.48 STX/).first()).toBeVisible();
  await expect(section.getByRole("button", { name: "Enable" })).toBeVisible();
  await section.getByRole("button", { name: "Sweep remaining STX" }).click();
  await expect(section.getByRole("button", { name: "Prepare sweep" })).toBeDisabled();
});
