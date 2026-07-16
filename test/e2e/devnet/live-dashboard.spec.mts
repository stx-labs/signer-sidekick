import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";

const state = JSON.parse(
  await readFile(new URL("./.runtime/run.json", import.meta.url), "utf8"),
) as {
  authToken: string;
  managerPrincipal: string;
  signerGrantPath?: string;
};
const lock = JSON.parse(
  await readFile(new URL("./versions.lock.json", import.meta.url), "utf8"),
) as { manager: { sha256: string } };
const phase = process.env.SIDEKICK_LIVE_PHASE ?? "inspect";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Operator credential").fill(state.authToken);
  await page.getByRole("button", { name: "Open console" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
}

async function openPage(page: Page, id: string, heading: string) {
  await page.locator(`a[href="#${id}"]`).click();
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
}

test("prepares Fresh Setup and downloads the exact manager artifact", async ({ page }) => {
  test.skip(phase !== "fresh-artifact", `live phase is ${phase}`);
  await login(page);
  await openPage(page, "setup", "Initial Setup");
  await page.getByRole("button", { name: "Fresh setup" }).click();
  const prepare = page.getByRole("button", { name: "Prepare manager artifact" });
  const downloadButton = page.getByRole("button", { name: "Download .clar" });
  const laterStep = page
    .getByRole("button", { name: "Prepare signer-host instruction" })
    .or(page.getByRole("button", { name: "Verify registration" }));
  await expect(prepare.or(downloadButton).or(laterStep)).toBeVisible();
  if (await laterStep.isVisible()) {
    await expect(page.locator("body")).not.toContainText(state.authToken);
    return;
  }
  if (await prepare.isVisible()) {
    await page.getByLabel("Manager admin principal").fill(state.managerPrincipal.split(".")[0]);
    await page.getByLabel("Contract name").fill("signer-manager");
    await page.getByLabel("Signer grant auth ID").fill("1");
    await page
      .getByLabel("Signer config path in generated instruction")
      .fill("/src/stacks-signer/Signer-0.toml");
    await prepare.click();
  }
  await expect(page.getByRole("button", { name: "Download .clar" })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download .clar" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("Manager source download did not produce a local file");
  const source = await readFile(path);
  expect(createHash("sha256").update(source).digest("hex")).toBe(lock.manager.sha256);
  await expect(page.locator("body")).not.toContainText(state.authToken);
});

test("imports the released signer grant through Fresh Setup", async ({ page }) => {
  test.skip(phase !== "signer-grant", `live phase is ${phase}`);
  if (!state.signerGrantPath) throw new Error("signerGrantPath is missing from runtime state");
  const grant = await readFile(state.signerGrantPath, "utf8");

  await login(page);
  await openPage(page, "setup", "Initial Setup");
  const verified = page.getByRole("button", { name: "Verify registration" });
  if (await verified.isVisible()) {
    await expect(page.locator("body")).not.toContainText(state.authToken);
    return;
  }
  const verifyDeployment = page.getByRole("button", { name: "Verify deployment" });
  if (await verifyDeployment.isVisible()) await verifyDeployment.click();
  await page.getByRole("button", { name: "Prepare signer-host instruction" }).click();
  await expect(
    page.getByText("stacks-signer generate-staking-signature", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Signer command JSON output").fill(grant);
  await page.getByRole("button", { name: "Verify signer output" }).click();
  await expect(page.getByRole("button", { name: "Verify registration" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(state.authToken);
});

test("attaches an existing manager through a clean dashboard", async ({ page }) => {
  test.skip(phase !== "attach", `live phase is ${phase}`);
  await login(page);
  await openPage(page, "setup", "Initial Setup");
  await page.getByRole("button", { name: "Verify and attach" }).click();
  await expect(page.getByRole("button", { name: "Re-run verification" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(state.authToken);
});

test("operator can inspect the live Devnet pool across every dashboard screen", async ({
  page,
}) => {
  test.skip(phase !== "inspect", `live phase is ${phase}`);
  const failedResponses: string[] = [];
  const consoleErrors: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 500) {
      failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await login(page);
  await expect(page.locator(".app")).toHaveAttribute("data-network", "devnet");
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

  expect(failedResponses).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await expect(page.locator("body")).not.toContainText(state.authToken);
});

test("operator can bypass and resume the guided onboarding wizard", async ({ page }) => {
  test.skip(phase !== "inspect", `live phase is ${phase}`);
  await login(page);
  await openPage(page, "setup", "Initial Setup");
  await page.getByRole("button", { name: "Skip guided setup" }).click();
  await expect(page.getByRole("heading", { name: "Using manual configuration" })).toBeVisible();
  await openPage(page, "overview", "Overview");
  await openPage(page, "setup", "Initial Setup");
  await page.getByRole("button", { name: "Open guided setup" }).click();
  await expect(page.getByRole("button", { name: "Skip guided setup" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(state.authToken);
});
