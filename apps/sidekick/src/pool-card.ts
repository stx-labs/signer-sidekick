import { z } from "zod";
import { isHttpUrl, parseEndpointUrl } from "./config.js";
import type { PoolEnrollmentDocument } from "./enrollment-info.js";
import {
  createStakeCalldataTemplates,
  ENABLED_SIGNUP_PROVIDERS,
  encodeNoneCalldata,
  encodeStakeManagerArg,
  POOL_SIGNUP_SCRIPT,
  type PoolSignupPayload,
} from "./pool-signup.js";

export const poolCardModeSchema = z.enum(["live", "static"]);
export type PoolCardMode = z.infer<typeof poolCardModeSchema>;

export interface PoolCardArtifact {
  schemaVersion: 2;
  mode: PoolCardMode;
  /** Whether the rendered page actually offers the staking form. */
  stakingForm: boolean;
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

/**
 * Staking is offered only where it can actually work: the operator asked for it, the page can read
 * a live burn height, and the deployment is mainnet. `stake` pins `start-burn-ht` to the current
 * reward cycle, so a static snapshot's height is guaranteed to fail after the next rollover.
 */
function stakingActive(enrollment: PoolEnrollmentDocument, mode: PoolCardMode): boolean {
  return enrollment.staking.enabled && mode === "live" && enrollment.chain.network === "mainnet";
}

function signupPayload(enrollment: PoolEnrollmentDocument): PoolSignupPayload {
  const maxFee = enrollment.staking.l1MaxFeeSats;
  return {
    pox5ContractId: enrollment.chain.pox5ContractId,
    functionName: "stake",
    managerArgHex: encodeStakeManagerArg(enrollment.manager.principal),
    noneCalldataHex: encodeNoneCalldata(),
    minCycles: enrollment.durationPolicy.minimumCycles,
    maxCycles: enrollment.durationPolicy.maximumCycles,
    explorerTxUrlPrefix: "https://explorer.hiro.so/txid/",
    bitcoinL1: enrollment.rewardDestinations.bitcoinL1 && maxFee !== null,
    l1MaxFeeSats: maxFee,
    calldataTemplates: maxFee === null ? [] : createStakeCalldataTemplates(BigInt(maxFee)),
    providers: ENABLED_SIGNUP_PROVIDERS.map((provider) => ({ ...provider })),
  };
}

function signupFormHtml(enrollment: PoolEnrollmentDocument, payload: PoolSignupPayload): string {
  const platform = enrollment.links.officialPlatforms[0];
  const updateHref = platform?.url ?? "https://earn.leather.io";
  const l1Section = payload.bitcoinL1
    ? `
      <div class="signup-l1" id="sk-l1" hidden>
        <label for="sk-btc">Bitcoin address</label>
        <input id="sk-btc" type="text" autocomplete="off" spellcheck="false" placeholder="bc1...">
        <p class="signup-echo" id="sk-btc-echo"></p>
        <p class="signup-hint">A fee budget of ${html(payload.l1MaxFeeSats ?? "0")} sats is deducted from each Bitcoin withdrawal. L1 payouts only begin once your earned rewards exceed that budget.</p>
      </div>`
    : "";
  const payoutChoice = payload.bitcoinL1
    ? `
      <fieldset class="signup-payout">
        <legend>Reward payout</legend>
        <label><input type="radio" name="sk-payout" value="sbtc" checked> Direct sBTC</label>
        <label><input type="radio" name="sk-payout" value="l1"> Bitcoin L1 address</label>
      </fieldset>${l1Section}`
    : `<p class="signup-hint">Rewards are paid directly in sBTC.</p>`;
  return `
    <section class="signup" aria-labelledby="sk-title">
      <h2 id="sk-title">Stake STX to this pool</h2>
      <p class="signup-hint">Your wallet holds your key, signs, and broadcasts. This page never receives a key or seed phrase, and sends nothing to the pool operator.</p>
      <label for="sk-amount">Amount (STX)</label>
      <input id="sk-amount" type="text" inputmode="decimal" autocomplete="off" placeholder="1000">
      <label for="sk-cycles">Lock duration (reward cycles)</label>
      <input id="sk-cycles" type="number" min="${payload.minCycles}" max="${payload.maxCycles}" value="${payload.minCycles}">
      ${payoutChoice}
      <div class="signup-wallets" id="sk-wallets"></div>
      <p class="signup-status" id="sk-status" role="status" aria-live="polite"></p>
      <p class="signup-result" id="sk-result"></p>
      <p class="signup-hint">Already staking with this pool? This form creates new stakes only. Use <a href="${html(updateHref)}" rel="noopener noreferrer">an official staking interface</a> to extend or change an existing position.</p>
    </section>`;
}

/**
 * DOM wiring. The testable logic lives in POOL_SIGNUP_SCRIPT; this only reads controls, orders the
 * submit steps, and reports outcomes.
 */
const SIGNUP_WIRING_SCRIPT = `
(function () {
  var api = window.sidekickPoolSignup;
  var data = JSON.parse(document.getElementById("sidekick-pool-data").textContent);
  var signup = data.signup;
  if (!api || !signup) return;

  var statusEl = document.getElementById("sk-status");
  var resultEl = document.getElementById("sk-result");
  var echoEl = document.getElementById("sk-btc-echo");
  var l1El = document.getElementById("sk-l1");
  var btcEl = document.getElementById("sk-btc");

  function status(message) { statusEl.textContent = message || ""; }

  function payoutMode() {
    var checked = document.querySelector("input[name=sk-payout]:checked");
    return checked ? checked.value : "sbtc";
  }

  function syncPayout() {
    if (l1El) l1El.hidden = payoutMode() !== "l1";
  }

  var payoutInputs = document.querySelectorAll("input[name=sk-payout]");
  for (var p = 0; p < payoutInputs.length; p += 1) {
    payoutInputs[p].addEventListener("change", syncPayout);
  }
  syncPayout();

  var ADDRESS_ERRORS = {
    empty: "Enter your Bitcoin address.",
    invalid: "That is not a valid Bitcoin address.",
    "not-mainnet": "That is a test-network address. Enter a Bitcoin mainnet address.",
    unsupported: "That Bitcoin address type is not supported for PoX payouts.",
    "insecure-context": "Address checks need a secure (HTTPS) connection."
  };

  function readAddress() {
    if (!btcEl) return Promise.resolve(null);
    return api.decodeMainnetPoxAddress(btcEl.value).then(function (decoded) {
      if (decoded.error) {
        if (echoEl) echoEl.textContent = ADDRESS_ERRORS[decoded.error] || "Check the address.";
        return { error: decoded.error };
      }
      return api
        .encodeMainnetPoxAddress(decoded.version, decoded.hashbytes)
        .then(function (roundTrip) {
          if (echoEl) echoEl.textContent = "Rewards will be sent to " + roundTrip + " — confirm this matches your wallet before signing.";
          return decoded;
        });
    });
  }

  if (btcEl) btcEl.addEventListener("change", function () { void readAddress(); });

  var buttons = [];
  var inFlight = false;

  function setBusy(busy) {
    inFlight = busy;
    for (var b = 0; b < buttons.length; b += 1) buttons[b].disabled = busy;
  }

  function submit(providerId) {
    // A second wallet request would race the first and, if both were approved, the later
    // transaction would fail on-chain having already cost the staker a fee.
    if (inFlight) return;
    resultEl.textContent = "";
    var amountUstx = api.stxToUstx(document.getElementById("sk-amount").value);
    if (amountUstx === null) return status("Enter an amount in STX using at most six decimal places.");
    var cycles = Number(document.getElementById("sk-cycles").value);
    if (!Number.isInteger(cycles) || cycles < signup.minCycles || cycles > signup.maxCycles) {
      return status("Choose between " + signup.minCycles + " and " + signup.maxCycles + " reward cycles.");
    }
    var provider = api.resolveProvider(providerId);
    if (!provider) return status("That wallet is no longer available. Reload and try again.");

    setBusy(true);
    status("Confirm the connection request in your wallet.");
    Promise.resolve()
      .then(function () { return payoutMode() === "l1" ? readAddress() : null; })
      .then(function (payout) {
        if (payout && payout.error) throw new Error("address");
        return provider
          .request("getAddresses", { network: "mainnet" })
          .then(api.unwrapResponse)
          .then(function (response) {
          var sender = api.pickStacksAddress(response);
          if (!sender) throw new Error("address-selection");
          status("Checking the reward window...");
          return fetch(data.publicApiUrl + "/v2/pox", { headers: { accept: "application/json" } })
            .then(function (response) {
              if (!response.ok) throw new Error("pox");
              return response.json();
            })
            .then(function (pox) {
              var preparePhase = api.isPreparePhase(pox);
              if (preparePhase === null) throw new Error("pox");
              if (preparePhase) throw new Error("prepare-phase");
              var burnHeight = pox.current_burnchain_block_height;
              if (typeof burnHeight !== "number") throw new Error("pox");
              var calldataHex = signup.noneCalldataHex;
              if (payout) {
                calldataHex = api.buildCalldataHex(signup, payout.version, payout.hashbytes);
                if (!calldataHex) throw new Error("address");
              }
              status("Review and approve the transaction in your wallet.");
              return provider.request("stx_callContract", {
                contract: signup.pox5ContractId,
                functionName: signup.functionName,
                functionArgs: api.buildFunctionArgs(signup, amountUstx, cycles, burnHeight, calldataHex),
                network: "mainnet",
                address: sender,
                sponsored: false,
                postConditionMode: "deny",
                postConditions: []
              }).then(api.unwrapResponse);
            });
        });
      })
      .then(function (response) {
        var txid = response && response.txid;
        if (!txid) throw new Error("txid");
        var normalized = txid.indexOf("0x") === 0 ? txid : "0x" + txid;
        status("Submitted. Your stake takes effect from the next reward cycle.");
        var link = document.createElement("a");
        link.href = signup.explorerTxUrlPrefix + normalized + "?chain=mainnet";
        link.rel = "noopener noreferrer";
        link.target = "_blank";
        link.textContent = "View transaction " + normalized;
        resultEl.textContent = "";
        resultEl.appendChild(link);
      })
      .catch(function (error) {
        var reason = error && error.message;
        if (reason === "address") return status("Check the Bitcoin address before continuing.");
        if (reason === "address-selection") return status("Select a single Bitcoin mainnet Stacks account in your wallet, then try again.");
        if (reason === "prepare-phase") return status("Staking is closed during the prepare phase. Try again in the next reward phase.");
        if (reason === "pox") return status("Could not read current chain data. Try again shortly.");
        if (reason === "txid") return status("The wallet did not return a transaction id.");
        return status("The wallet request was cancelled or failed.");
      })
      .then(function () { setBusy(false); }, function () { setBusy(false); });
  }

  var wallets = document.getElementById("sk-wallets");
  for (var i = 0; i < signup.providers.length; i += 1) {
    (function (entry) {
      if (!api.resolveProvider(entry.id)) return;
      var button = document.createElement("button");
      button.type = "button";
      button.className = "button";
      button.textContent = "Stake with " + entry.label;
      button.addEventListener("click", function () { submit(entry.id); });
      buttons.push(button);
      wallets.appendChild(button);
    })(signup.providers[i]);
  }
  if (!wallets.children.length) {
    status("Install a supported Stacks wallet to stake from this page.");
  }
})();
`;

function cardHtml(
  enrollment: PoolEnrollmentDocument,
  mode: PoolCardMode,
  publicApiUrl: string,
  signup: PoolSignupPayload | null,
): string {
  const website = enrollment.pool.websiteUrl ?? "";
  const current = enrollment.eligibility.current;
  const poolStx = current ? formatUstx(current.delegatedUstx) : "Unavailable";
  const payload = scriptJson({ enrollment, publicApiUrl, mode, signup });
  const signupForm = signup ? signupFormHtml(enrollment, signup) : "";
  const signupScript = signup
    ? `<script>${POOL_SIGNUP_SCRIPT}</script>\n  <script>${SIGNUP_WIRING_SCRIPT}</script>`
    : "";
  const notice = signup
    ? "Staking happens in your own wallet. This page never asks for a private key or seed phrase, and sends nothing to the pool operator."
    : "This page is informational. It never asks for an amount, Bitcoin address, wallet connection, signature, or private key.";
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
    a { color: #a63e1d; } .button { padding: 10px 14px; border-radius: 8px; background: #fc6432; color: #111; text-decoration: none; font-weight: 600; }
    footer { margin-top: 18px; color: #77736a; font-size: 11px; }
    .signup { margin-top: 22px; padding-top: 18px; border-top: 1px solid #e6e4dd; }
    .signup h2 { margin: 0 0 8px; font-size: 18px; }
    .signup label { display: block; margin: 12px 0 4px; font-size: 13px; color: #77736a; }
    .signup input[type=text], .signup input[type=number] { width: 100%; box-sizing: border-box; padding: 9px 10px; border: 1px solid #d9d7cf; border-radius: 8px; background: #fff; color: inherit; font: inherit; }
    .signup fieldset { margin: 14px 0 0; padding: 10px 12px; border: 1px solid #e6e4dd; border-radius: 8px; }
    .signup legend { padding: 0 4px; font-size: 13px; color: #77736a; }
    .signup fieldset label { display: inline-flex; gap: 6px; align-items: center; margin: 0 14px 0 0; color: inherit; }
    .signup-hint, .signup-echo, .signup-status { margin: 8px 0 0; font-size: 12px; color: #77736a; }
    .signup-echo { overflow-wrap: anywhere; }
    .signup-status { min-height: 1.2em; color: #a63e1d; }
    .signup-result { margin: 6px 0 0; font-size: 13px; overflow-wrap: anywhere; }
    .signup-wallets { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
    .signup-wallets .button { border: 0; cursor: pointer; font: inherit; font-weight: 600; }
    @media (prefers-color-scheme: dark) { body { background: #171714; color: #f4f1e8; } .pool-card { background: #24231f; border-color: #47443b; } dt, dd { border-color: #47443b; } p, footer, dt { color: #b9b4a7; } .notice { background: #302e28; } .signup { border-color: #47443b; } .signup input[type=text], .signup input[type=number] { background: #1d1c19; border-color: #47443b; } .signup fieldset { border-color: #47443b; } .signup-hint, .signup-echo, .signup label, .signup legend { color: #b9b4a7; } .signup-status { color: #f2a58c; } }
    @media (max-width: 520px) { body { padding: 12px; } .pool-card { padding: 18px; } dl { grid-template-columns: 1fr; } dt { padding-bottom: 3px; border-bottom: 0; } dd { padding-top: 0; } }
  </style>
</head>
<body>
  <main class="pool-card">
    <span class="status">${html(eligibilityLabel(enrollment))}</span>
    <h1>${html(enrollment.pool.displayName)}</h1>
    <p>PoX-5 STX-only pool information · ${html(enrollment.chain.network)}</p>
    <div class="notice">${html(notice)}</div>
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
    ${signupForm}
    <footer><span data-sidekick-freshness>${mode === "live" ? "Loading public API" : "Static snapshot"}</span> · schema v2 · hosted on your site, not by Sidekick</footer>
  </main>
  <script id="sidekick-pool-data" type="application/json">${payload}</script>
  ${liveScript}
  ${signupScript}
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
  const active = stakingActive(enrollment, mode);
  // The published JSON must describe the page that was actually rendered. If staking was requested
  // but the mode or network rules it out, correct the document rather than let the two disagree.
  const published: PoolEnrollmentDocument = active
    ? enrollment
    : {
        ...enrollment,
        staking: { enabled: false, l1MaxFeeSats: null },
        userInteraction: {
          ...enrollment.userInteraction,
          collectsAmount: false,
          collectsBitcoinAddress: false,
          connectsWallet: false,
          signsTransactions: false,
        },
      };
  const signup = active ? signupPayload(published) : null;
  const jsonBody = `${JSON.stringify({ schemaVersion: 2, generatedBy: "signer-sidekick", enrollment: published }, null, 2)}\n`;
  return {
    schemaVersion: 2,
    mode,
    stakingForm: active,
    filename: "signer-sidekick-pool.html",
    contentType: "text/html; charset=utf-8",
    body: cardHtml(published, mode, normalizedApiUrl, signup),
    json: {
      filename: "signer-sidekick-pool.json",
      contentType: "application/json; charset=utf-8",
      body: jsonBody,
    },
    enrollment: published,
    liveFields: isStatic ? [] : ["rewardCycleId", "burnBlockHeight"],
    safety: {
      containsApiKey: false,
      containsGasPayer: false,
      containsPrivateKey: false,
      requiresSidekickPublicRoute: false,
    },
  };
}
