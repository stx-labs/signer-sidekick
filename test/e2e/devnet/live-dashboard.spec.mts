import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";

const state = JSON.parse(
  await readFile(new URL("./.runtime/run.json", import.meta.url), "utf8"),
) as {
  authToken: string;
  managerPrincipal: string;
};
const phase = process.env.SIDEKICK_LIVE_PHASE ?? "inspect";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Operator credential").fill(state.authToken);
  await page.getByRole("button", { name: "Open console" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
}

async function openPage(page: Page, id: string, heading: string) {
  const picker = page.getByRole("button", { name: "Dashboard page", exact: true });
  if (await picker.isVisible()) {
    await picker.click();
    await page.locator(`.mobile-page-menu a[href="#${id}"]`).click();
  } else await page.locator(`.sidebar a[href="#${id}"]`).click();
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
}

test("operator can inspect the running Devnet signer across every Sidekick screen", async ({
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
  for (const [id, heading] of [
    ["health", "Signer Health"],
    ["manager", "Manager"],
    ["pool", "Pool positions"],
    ["rewards", "Rewards"],
    ["operations", "Operations"],
    ["settings", "Settings"],
  ]) {
    await openPage(page, id, heading);
  }

  expect(failedResponses).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await expect(page.locator("body")).not.toContainText(state.authToken);
});

test("Sidekick recognizes the externally deployed manager and signer registration", async ({
  page,
}) => {
  test.skip(phase !== "inspect", `live phase is ${phase}`);
  await login(page);
  await openPage(page, "manager", "Manager");
  await expect(page.getByText(state.managerPrincipal, { exact: true })).toBeVisible();
  await expect(page.getByText("Connect a running signer manager.")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Review signer rotation" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(state.authToken);
});
