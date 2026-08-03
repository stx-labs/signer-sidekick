import { z } from "zod";
import { isHttpUrl, parseEndpointUrl } from "./config.js";
import type { PoolEnrollmentDocument } from "./enrollment-info.js";

export const poolCardModeSchema = z.enum(["live", "static"]);
export type PoolCardMode = z.infer<typeof poolCardModeSchema>;

export interface PoolCardArtifact {
  schemaVersion: 1;
  mode: PoolCardMode;
  filename: string;
  contentType: string;
  body: string;
  json: {
    filename: string;
    contentType: "application/json; charset=utf-8";
    body: string;
  };
  enrollment: PoolEnrollmentDocument;
  liveFields: string[];
  safety: {
    containsApiKey: false;
    containsGasPayer: false;
    containsPrivateKey: false;
    requiresSidekickPublicRoute: false;
  };
}

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function supportLabel(enrollment: PoolEnrollmentDocument): string {
  return enrollment.pool.support?.email ?? enrollment.pool.support?.url ?? "Not published";
}

function eligibilityLabel(enrollment: PoolEnrollmentDocument): string {
  const current = enrollment.eligibility.current;
  if (!current) return "Unavailable";
  return current.meetsThreshold && current.inSignerSet ? "Eligible" : "Needs attention";
}

function formatUstx(value: string): string {
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").slice(0, 4);
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

function cardHtml(
  enrollment: PoolEnrollmentDocument,
  mode: PoolCardMode,
  publicApiUrl: string,
): string {
  const website = enrollment.pool.websiteUrl ?? "";
  const current = enrollment.eligibility.current;
  const poolStx = current ? formatUstx(current.delegatedUstx) : "Unavailable";
  const payload = scriptJson({ enrollment, publicApiUrl, mode });
  const liveScript =
    mode === "live"
      ? `<script>
  (function () {
    var data = JSON.parse(document.getElementById("sidekick-pool-data").textContent);
    fetch(data.publicApiUrl + "/v2/pox", { headers: { "accept": "application/json" } })
      .then(function (response) { if (!response.ok) throw new Error("HTTP " + response.status); return response.json(); })
      .then(function (pox) {
        document.querySelector("[data-sidekick-cycle]").textContent = String(pox.reward_cycle_id);
        document.querySelector("[data-sidekick-burn]").textContent = String(pox.current_burnchain_block_height);
        document.querySelector("[data-sidekick-freshness]").textContent = "Live public API";
      })
      .catch(function () {
        document.querySelector("[data-sidekick-freshness]").textContent = "Snapshot data · public API unavailable";
      });
  })();
</script>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${html(enrollment.pool.displayName)} · PoX-5 pool information</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; padding: 24px; background: #f7f6f2; color: #151513; }
    .pool-card { max-width: 760px; margin: auto; padding: 24px; border: 1px solid #d9d7cf; border-radius: 12px; background: #fff; }
    h1 { margin: 0 0 6px; font-size: 24px; } p { margin: 0; color: #625f57; }
    dl { display: grid; grid-template-columns: minmax(150px, .8fr) minmax(0, 1.2fr); gap: 0; margin: 20px 0; }
    dt, dd { margin: 0; padding: 11px 0; border-bottom: 1px solid #e6e4dd; }
    dt { color: #77736a; } dd { overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
    .status { display: inline-flex; padding: 4px 8px; border-radius: 999px; background: #dff4e5; color: #176b35; font-size: 12px; }
    .notice { margin: 18px 0; padding: 12px; border-radius: 8px; background: #f0eee7; font-size: 13px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    a { color: #a63e1d; }
    footer { margin-top: 18px; color: #77736a; font-size: 11px; }
    @media (prefers-color-scheme: dark) { body { background: #171714; color: #f4f1e8; } .pool-card { background: #24231f; border-color: #47443b; } dt, dd { border-color: #47443b; } p, footer, dt { color: #b9b4a7; } .notice { background: #302e28; } }
    @media (max-width: 520px) { body { padding: 12px; } .pool-card { padding: 18px; } dl { grid-template-columns: 1fr; } dt { padding-bottom: 3px; border-bottom: 0; } dd { padding-top: 0; } }
  </style>
</head>
<body>
  <main class="pool-card">
    <span class="status">${html(eligibilityLabel(enrollment))}</span>
    <h1>${html(enrollment.pool.displayName)}</h1>
    <p>PoX-5 STX-only pool information · ${html(enrollment.chain.network)}</p>
    <div class="notice">This page is informational. It never asks for an amount, Bitcoin address, wallet connection, signature, or private key.</div>
    <dl>
      <dt>Signer-manager</dt><dd>${html(enrollment.manager.principal)}</dd>
      <dt>Signer public key</dt><dd>${html(enrollment.signer.publicKeyHex ?? "Not registered")}</dd>
      <dt>Grant</dt><dd>${enrollment.signer.grantValid ? "Valid" : "Not verified"}</dd>
      <dt>Configured fee</dt><dd>${(enrollment.fee.currentConfiguredBips / 100).toFixed(2)}%</dd>
      <dt>Reward cycle</dt><dd data-sidekick-cycle>${enrollment.chain.rewardCycleId}</dd>
      <dt>Pool size</dt><dd>${html(poolStx)} STX</dd>
      <dt>Bitcoin block height</dt><dd data-sidekick-burn>${enrollment.chain.burnBlockHeight}</dd>
      <dt>Website</dt><dd>${website ? `<a href="${html(website)}">${html(website)}</a>` : "Not published"}</dd>
      <dt>Support</dt><dd>${html(supportLabel(enrollment))}</dd>
    </dl>
    <div class="actions">
      <a href="${html(enrollment.links.managerExplorer)}" rel="noopener noreferrer">View manager on Explorer</a>
    </div>
    <footer><span data-sidekick-freshness>${mode === "live" ? "Loading public API" : "Static snapshot"}</span> · schema v1 · hosted on your site, not by Sidekick</footer>
  </main>
  <script id="sidekick-pool-data" type="application/json">${payload}</script>
  ${liveScript}
</body>
</html>`;
}

export function createPoolCardArtifact(
  enrollment: PoolEnrollmentDocument,
  modeInput: unknown,
  publicApiUrlInput: string,
): PoolCardArtifact {
  const mode = poolCardModeSchema.parse(modeInput);
  const hrefs = [
    enrollment.pool.websiteUrl,
    enrollment.pool.support?.url,
    enrollment.links.managerExplorer,
    ...enrollment.links.officialPlatforms.map(({ url }) => url),
  ].filter((value): value is string => Boolean(value));
  if (hrefs.some((value) => !isHttpUrl(value))) {
    throw new Error("Pool card links must use http or https");
  }
  const normalizedApiUrl = parseEndpointUrl(publicApiUrlInput, "Public embed API URL");
  const isStatic = mode === "static";
  const jsonBody = `${JSON.stringify({ schemaVersion: 1, generatedBy: "signer-sidekick", enrollment }, null, 2)}\n`;
  return {
    schemaVersion: 1,
    mode,
    filename: "signer-sidekick-pool.html",
    contentType: "text/html; charset=utf-8",
    body: cardHtml(enrollment, mode, normalizedApiUrl),
    json: {
      filename: "signer-sidekick-pool.json",
      contentType: "application/json; charset=utf-8",
      body: jsonBody,
    },
    enrollment,
    liveFields: isStatic ? [] : ["rewardCycleId", "burnBlockHeight"],
    safety: {
      containsApiKey: false,
      containsGasPayer: false,
      containsPrivateKey: false,
      requiresSidekickPublicRoute: false,
    },
  };
}
