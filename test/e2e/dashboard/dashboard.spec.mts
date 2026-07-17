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

test("renders every operator screen without leaking the credential", async ({ page }) => {
  await login(page);
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

test("summarizes the cycle clock and links health details", async ({ page }) => {
  await login(page);
  const cards = page.locator(".cycle-clock > *");
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(0)).toContainText("Reward cycle");
  await expect(cards.nth(1)).toContainText("Burn height");
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
    detail: "No action is required unless reference-manager automation is intended.",
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
  await expect(page.getByRole("button", { name: /Copy manager principal/ })).toBeVisible();
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
  await expect(page.getByText(/No action is required.*burn height 10880/)).toBeVisible();

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
          : "Reference-manager automation is disabled";
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
