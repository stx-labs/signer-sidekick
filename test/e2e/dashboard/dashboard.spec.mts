import { expect, type Page, test } from "@playwright/test";
import { responseFor, roster } from "./large-pool-fixture.mjs";

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
  else await page.locator(`a[href="#${id}"]`).click();
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
}

test("renders every operator screen without leaking the credential", async ({ page }) => {
  await login(page);
  const screens = [
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

test("explains the manager trust tier on registration and settings", async ({ page }) => {
  await login(page);
  await openPage(page, "registration", "Registration");
  await expect(page.getByText("Reference — built in")).toBeVisible();
  await expect(page.getByText("Built into Sidekick")).toBeVisible();
  await openPage(page, "settings", "Settings");
  await expect(page.getByText("Manager trust")).toBeVisible();
  await expect(page.getByText("Installed profile store")).toBeVisible();
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

test("paginates multi-year reward history", async ({ page }) => {
  await login(page);
  await openPage(page, "rewards", "Rewards");
  await expect(page.getByText("1–10 of 48")).toBeVisible();
  const paginations = page.getByRole("navigation", { name: "Table pagination" });
  await paginations.first().getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("11–20 of 48")).toBeVisible();
});
