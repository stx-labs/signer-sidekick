import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { createOperatorActor, DEVNET_ACCOUNTS } from "./operator-actor.mjs";

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

  // The signed-out shell intentionally probes the session endpoint and receives 401 before the
  // operator submits a credential. Observe console/network health only after login succeeds.
  await login(page);
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 500) {
      failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await expect(page.locator(".app")).toHaveAttribute("data-network", "devnet");
  for (const [id, heading] of [
    ["health", "Signer Health"],
    ["pool", "Pool positions"],
    ["rewards", "Rewards"],
    ["activity", "Activity"],
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
  await openPage(page, "settings", "Settings");
  await expect(
    page.getByRole("button", { name: `Copy manager principal: ${state.managerPrincipal}` }),
  ).toBeVisible();
  await expect(page.getByText("Connect a running signer manager.")).not.toBeVisible();
  await expect(
    page.getByRole("link", { name: "Review signer registration or rotation" }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(state.authToken);
});

test("operator completes one reviewed wallet action through the released Devnet stack", async ({
  page,
}) => {
  test.skip(phase !== "action", `live phase is ${phase}`);
  test.setTimeout(180_000);
  const actor = createOperatorActor();
  const statusResponse = await fetch("http://127.0.0.1:3998/api/v1/status", {
    headers: { authorization: `Bearer ${state.authToken}` },
  });
  if (!statusResponse.ok) throw new Error(`Status returned HTTP ${statusResponse.status}`);
  const status = (await statusResponse.json()) as {
    rewards?: { manager?: { configuredFeeBips?: number | string } };
  };
  const currentFeeBips = Number(status.rewards?.manager?.configuredFeeBips ?? 0);
  const targetFeeBips = currentFeeBips >= 9_999 ? 0 : currentFeeBips + 1;
  const walletMethods: string[] = [];
  await page.exposeFunction(
    "__sidekickDevnetWalletRequest",
    async (method: string, parameters: Record<string, unknown> | undefined) => {
      walletMethods.push(method);
      return await actor.browserWalletRequest(method, parameters);
    },
  );
  await page.addInitScript(() => {
    const controlled = window as typeof window & {
      LeatherProvider?: {
        request(method: string, parameters?: Record<string, unknown>): Promise<unknown>;
      };
      __sidekickDevnetWalletRequest(
        method: string,
        parameters?: Record<string, unknown>,
      ): Promise<unknown>;
    };
    controlled.localStorage.removeItem("STX_PROVIDER");
    controlled.LeatherProvider = {
      async request(method, parameters) {
        return {
          jsonrpc: "2.0",
          id: "sidekick-devnet-wallet",
          result: await controlled.__sidekickDevnetWalletRequest(method, parameters),
        };
      },
    };
  });

  await login(page);
  await page.evaluate(() => {
    location.hash = "#action/update-fees";
  });
  await expect(
    page.getByRole("heading", { name: "Update manager fee", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Signing manager admin").fill(DEVNET_ACCOUNTS.deployer.address);
  await page.getByLabel("New fee (basis points)").fill(String(targetFeeBips));
  await page.getByRole("button", { name: "Review wallet transaction" }).click();
  const wallet = page.getByRole("region", { name: "Browser wallet" });
  await expect(wallet).toContainText("Update manager fee");
  await expect(wallet).toContainText(`New fee (bips)${targetFeeBips}`);
  await page.getByRole("button", { name: "Connect wallet and sign" }).click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(wallet).toContainText("Transaction submitted.", { timeout: 120_000 });

  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await wallet.getByText("complete", { exact: true }).isVisible()) break;
    const refresh = wallet.getByRole("button", { name: "Refresh verification" });
    if (await refresh.isVisible()) await refresh.click();
    await page.waitForTimeout(1_000);
  }
  await expect(wallet.getByText("complete", { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(walletMethods).toEqual(["getAddresses", "stx_callContract"]);

  await openPage(page, "activity", "Activity");
  await page.getByRole("button", { name: "Refresh Activity" }).click();
  const activity = page.locator("article").filter({ hasText: "Update manager fees" }).first();
  await expect(activity).toBeVisible();
  await expect(activity).toContainText("complete");
  await expect(page.locator("body")).not.toContainText(state.authToken);
});
