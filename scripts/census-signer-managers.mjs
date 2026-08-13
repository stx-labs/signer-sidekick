#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ClarityType, cvToHex, hexToCV, principalCV, uintCV } from "@stacks/transactions";

const mainnetPox5 = "SP000000000000000000002Q6VF78.pox-5";
const mainnetBootAddress = "SP000000000000000000002Q6VF78";
const cursorPattern = /^\d+:\d+:\d+:\d+$/;
const contractPrincipalPattern = /^S[PM][0-9A-HJKMNP-TV-Z]+\.[a-zA-Z][a-zA-Z0-9-_]{0,39}$/;
const hex32Pattern = /^(?:0x)?[0-9a-f]{64}$/i;
const hex33Pattern = /^0x[0-9a-f]{66}$/i;

export const signerManagerTraitAbi = {
  functions: [
    {
      name: "validate-stake!",
      access: "public",
      args: [
        { name: "staker", type: "principal" },
        { name: "first-index", type: "uint128" },
        { name: "num-indexes", type: "uint128" },
        { name: "amount-ustx", type: "uint128" },
        { name: "amount-sats", type: "uint128" },
        { name: "is-bond", type: "bool" },
        {
          name: "signer-calldata",
          type: { optional: { buffer: { length: 500 } } },
        },
      ],
      outputs: {
        type: { response: { ok: "bool", error: "uint128" } },
      },
    },
  ],
};

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function clarityTokenSha256(source) {
  const tokens = [];
  const delimiters = "(){}[],:";
  for (let index = 0; index < source.length; ) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === ";" && source[index + 1] === ";") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === '"') {
      let token = character;
      index += 1;
      let escaped = false;
      let terminated = false;
      while (index < source.length) {
        const current = source[index];
        token += current;
        index += 1;
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === '"') {
          terminated = true;
          break;
        }
      }
      if (!terminated) throw new Error("Clarity source contains an unterminated string");
      tokens.push(token);
      continue;
    }
    if (delimiters.includes(character)) {
      tokens.push(character);
      index += 1;
      continue;
    }
    let token = "";
    while (index < source.length) {
      const current = source[index];
      if (
        /\s/.test(current) ||
        delimiters.includes(current) ||
        current === '"' ||
        (current === ";" && source[index + 1] === ";")
      ) {
        break;
      }
      token += current;
      index += 1;
    }
    if (token.length === 0) throw new Error(`Cannot tokenize Clarity source at byte ${index}`);
    tokens.push(token);
  }
  return sha256(canonicalJson(tokens));
}

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function canonicalHex32(value, label) {
  const parsed = assertString(value, label);
  if (!hex32Pattern.test(parsed)) throw new Error(`${label} must be 32-byte hex`);
  return `0x${parsed.replace(/^0x/i, "").toLowerCase()}`;
}

function assertContractPrincipal(value, label) {
  const parsed = assertString(value, label);
  if (!contractPrincipalPattern.test(parsed)) {
    throw new Error(`${label} must be a contract principal`);
  }
  return parsed;
}

function optionalValue(value, expectedType, label) {
  if (value.type === ClarityType.OptionalNone) return null;
  if (value.type !== ClarityType.OptionalSome || value.value.type !== expectedType) {
    throw new Error(`${label} returned an unexpected Clarity value`);
  }
  return value.value.value;
}

function principalFromTuple(tuple, field) {
  const value = tuple.value[field];
  if (
    value?.type !== ClarityType.PrincipalStandard &&
    value?.type !== ClarityType.PrincipalContract
  ) {
    return null;
  }
  return value.value;
}

function stringFromTuple(tuple, field) {
  const value = tuple.value[field];
  if (value?.type !== ClarityType.StringASCII && value?.type !== ClarityType.StringUTF8) {
    return null;
  }
  return value.value;
}

function bufferFromTuple(tuple, field) {
  const value = tuple.value[field];
  return value?.type === ClarityType.Buffer ? `0x${value.value}` : null;
}

export function decodePoxPrintEvent(hex) {
  let value;
  try {
    value = hexToCV(hex);
  } catch {
    return null;
  }
  if (value.type !== ClarityType.Tuple) return null;
  const topic = stringFromTuple(value, "topic");
  if (topic === null) return null;
  return {
    topic,
    signer: principalFromTuple(value, "signer"),
    signerKey: bufferFromTuple(value, "signer-key"),
  };
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function retryAfterMilliseconds(response) {
  const value = response.headers.get("retry-after");
  if (value === null) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

async function fetchJson(fetchImpl, url, options = {}) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) return response.json();
    const retryAfter = retryAfterMilliseconds(response);
    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      await response.body?.cancel();
      await sleep(Math.min(30_000, retryAfter ?? 250 * 2 ** (attempt - 1)));
      continue;
    }
    await response.body?.cancel();
    throw new Error(`${new URL(url).pathname} returned HTTP ${response.status}`);
  }
  throw new Error(`${new URL(url).pathname} exhausted its retry budget`);
}

function endpoint(baseUrl, path) {
  return new URL(path, `${baseUrl.replace(/\/$/, "")}/`);
}

async function readNodeAnchor(fetchImpl, nodeUrl, expectedPoxContract) {
  const readTip = async () => {
    const [infoValue, tenureValue] = await Promise.all([
      fetchJson(fetchImpl, endpoint(nodeUrl, "/v2/info")),
      fetchJson(fetchImpl, endpoint(nodeUrl, "/v3/tenures/info")),
    ]);
    return {
      info: assertObject(infoValue, "node info"),
      tenure: assertObject(tenureValue, "node tenure info"),
    };
  };
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const before = await readTip();
    if (before.info.network_id !== 1) {
      throw new Error(`Expected mainnet network_id 1, got ${before.info.network_id}`);
    }
    if (before.info.is_fully_synced === false) {
      throw new Error("Local node reports that it is not fully synced");
    }
    const stacksTipHeight = assertSafeInteger(before.tenure.tip_height, "node tenure tip height");
    const stacksTip = canonicalHex32(before.tenure.tip_block_id, "node tenure tip block id");
    const burnBlockHeight = assertSafeInteger(
      before.info.burn_block_height,
      "node burn block height",
    );
    const poxUrl = endpoint(nodeUrl, "/v2/pox");
    poxUrl.searchParams.set("tip", stacksTip.slice(2));
    const pox = assertObject(await fetchJson(fetchImpl, poxUrl), "PoX info");
    const after = await readTip();
    const tipStayedStable =
      before.info.stacks_tip_height === after.info.stacks_tip_height &&
      before.info.burn_block_height === after.info.burn_block_height &&
      before.tenure.tip_height === after.tenure.tip_height &&
      before.tenure.tip_block_id === after.tenure.tip_block_id &&
      before.tenure.reward_cycle === after.tenure.reward_cycle;
    if (!tipStayedStable) {
      if (attempt === 5) throw new Error("Node tip moved during all five anchor attempts");
      continue;
    }
    if (before.info.stacks_tip_height !== stacksTipHeight) {
      throw new Error("Node info and tenure endpoints disagree on the Stacks tip height");
    }
    const poxBurnBlockHeight = assertSafeInteger(
      pox.current_burnchain_block_height,
      "PoX burn block height",
    );
    if (burnBlockHeight !== poxBurnBlockHeight) {
      throw new Error("Node info and anchored PoX state disagree on the Bitcoin height");
    }
    const poxContract = assertContractPrincipal(pox.contract_id, "PoX contract");
    if (poxContract !== expectedPoxContract) {
      throw new Error(`Expected PoX contract ${expectedPoxContract}, got ${poxContract}`);
    }
    const currentCycle = assertSafeInteger(
      assertObject(pox.current_cycle, "PoX current cycle").id,
      "PoX current cycle id",
    );
    if (currentCycle !== before.tenure.reward_cycle) {
      throw new Error("Node tenure and anchored PoX state disagree on the reward cycle");
    }
    const nextCycle = assertSafeInteger(
      assertObject(pox.next_cycle, "PoX next cycle").id,
      "PoX next cycle id",
    );
    return {
      networkId: before.info.network_id,
      stacksTipHeight,
      stacksTip,
      burnBlockHeight,
      poxBurnBlockHeight,
      poxContract,
      currentCycle,
      nextCycle,
    };
  }
  throw new Error("Unable to capture a stable local node anchor");
}

async function callReadOnly(fetchImpl, nodeUrl, anchor, functionName, args) {
  const [address, contractName] = anchor.poxContract.split(".");
  const url = endpoint(
    nodeUrl,
    `/v2/contracts/call-read/${encodeURIComponent(address)}/${encodeURIComponent(contractName)}/${encodeURIComponent(functionName)}`,
  );
  url.searchParams.set("tip", anchor.stacksTip.slice(2));
  const response = assertObject(
    await fetchJson(fetchImpl, url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sender: mainnetBootAddress, arguments: args }),
    }),
    `${functionName} response`,
  );
  if (response.okay !== true) {
    throw new Error(`${functionName} failed: ${String(response.cause ?? "unknown cause")}`);
  }
  return hexToCV(assertString(response.result, `${functionName} result`));
}

async function getSignerInfo(fetchImpl, nodeUrl, anchor, manager) {
  const value = await callReadOnly(fetchImpl, nodeUrl, anchor, "get-signer-info", [
    cvToHex(principalCV(manager)),
  ]);
  const signerKey = optionalValue(value, ClarityType.Buffer, "get-signer-info");
  if (signerKey === null) return null;
  const canonical = `0x${signerKey}`;
  if (!hex33Pattern.test(canonical)) throw new Error("get-signer-info returned a non-33-byte key");
  return canonical;
}

export async function enumerateSignerSet({ cycle, readFirst, readNext, maxItems = 512 }) {
  const managers = [];
  const seen = new Set();
  let current = await readFirst(cycle);
  while (current !== null) {
    if (seen.has(current))
      throw new Error(`Signer-set cycle ${cycle} contains a loop at ${current}`);
    if (managers.length >= maxItems) {
      throw new Error(`Signer-set cycle ${cycle} exceeds the ${maxItems}-manager safety bound`);
    }
    seen.add(current);
    managers.push(current);
    current = await readNext(current, cycle);
  }
  return managers;
}

async function readSignerSet(fetchImpl, nodeUrl, anchor, cycle) {
  return enumerateSignerSet({
    cycle,
    readFirst: async (requestedCycle) => {
      const value = await callReadOnly(
        fetchImpl,
        nodeUrl,
        anchor,
        "get-signer-set-first-item-for-cycle",
        [cvToHex(uintCV(requestedCycle))],
      );
      return optionalValue(value, ClarityType.PrincipalContract, "signer-set first item");
    },
    readNext: async (manager, requestedCycle) => {
      const value = await callReadOnly(
        fetchImpl,
        nodeUrl,
        anchor,
        "get-signer-set-next-item-for-cycle",
        [cvToHex(principalCV(manager)), cvToHex(uintCV(requestedCycle))],
      );
      return optionalValue(value, ClarityType.PrincipalContract, "signer-set next item");
    },
  });
}

function parseLogPage(value) {
  const page = assertObject(value, "PoX log page");
  const results = Array.isArray(page.results) ? page.results : null;
  if (results === null) throw new Error("PoX log page results must be an array");
  for (const [index, resultValue] of results.entries()) {
    const result = assertObject(resultValue, `PoX log result ${index}`);
    assertSafeInteger(result.event_index, `PoX log result ${index} event index`);
    canonicalHex32(result.tx_id, `PoX log result ${index} transaction id`);
    const log = assertObject(result.contract_log, `PoX log result ${index} contract log`);
    assertString(assertObject(log.value, `PoX log result ${index} value`).hex, "PoX event hex");
  }
  if (page.prev_cursor !== null && !cursorPattern.test(page.prev_cursor)) {
    throw new Error("PoX log page returned an invalid previous cursor");
  }
  return page;
}

async function discoverPoxActivity(fetchImpl, apiUrl, poxContract, apiHeaders) {
  const registrations = new Map();
  const latestActivity = new Map();
  const seenCursors = new Set();
  let cursor = null;
  let pages = 0;
  let events = 0;
  while (true) {
    if (seenCursors.has(cursor)) throw new Error(`PoX log API repeated cursor ${cursor}`);
    seenCursors.add(cursor);
    const url = endpoint(
      apiUrl,
      `/extended/v2/smart-contracts/${encodeURIComponent(poxContract)}/logs`,
    );
    url.searchParams.set("limit", "100");
    url.searchParams.set("offset", "0");
    if (cursor !== null) url.searchParams.set("cursor", cursor);
    const page = parseLogPage(await fetchJson(fetchImpl, url, { headers: apiHeaders }));
    pages += 1;
    events += page.results.length;
    for (const result of page.results) {
      const decoded = decodePoxPrintEvent(result.contract_log.value.hex);
      if (decoded?.signer === null || decoded?.signer === undefined) continue;
      const activities = latestActivity.get(decoded.signer) ?? [];
      activities.push({
        topic: decoded.topic,
        txId: canonicalHex32(result.tx_id, "PoX activity transaction id"),
        eventIndex: result.event_index,
      });
      latestActivity.set(decoded.signer, activities);
      if (decoded.topic === "register-signer") {
        if (decoded.signerKey === null || !hex33Pattern.test(decoded.signerKey)) {
          throw new Error(`Registration event for ${decoded.signer} lacks a 33-byte signer key`);
        }
        const managerRegistrations = registrations.get(decoded.signer) ?? [];
        managerRegistrations.push({
          signerKey: decoded.signerKey,
          txId: canonicalHex32(result.tx_id, "registration transaction id"),
          eventIndex: result.event_index,
          valueHex: result.contract_log.value.hex.toLowerCase(),
          valueRepr: assertString(result.contract_log.value.repr, "registration event repr"),
        });
        registrations.set(decoded.signer, managerRegistrations);
      }
    }
    if (page.prev_cursor === null || page.results.length === 0) break;
    cursor = page.prev_cursor;
    if (pages >= 1_000) throw new Error("PoX log discovery exceeded 1,000 pages");
  }
  return { registrations, latestActivity, pages, events };
}

async function mapWithConcurrency(entries, limit, action) {
  const results = new Array(entries.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, entries.length) }, async () => {
    while (cursor < entries.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await action(entries[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function parseTransactionSummary(value, expectedTxId) {
  const transaction = assertObject(value, `transaction ${expectedTxId}`);
  const txId = canonicalHex32(transaction.tx_id, "transaction id");
  if (txId !== expectedTxId)
    throw new Error(`Transaction lookup returned ${txId}, not ${expectedTxId}`);
  if (transaction.status !== "success") {
    throw new Error(`PoX print event transaction ${txId} has status ${String(transaction.status)}`);
  }
  const block = assertObject(transaction.block, `transaction ${txId} block`);
  const bitcoinBlock = assertObject(transaction.bitcoin_block, `transaction ${txId} Bitcoin block`);
  return {
    blockHeight: assertSafeInteger(block.height, "transaction block height"),
    indexBlockHash: canonicalHex32(block.index_hash, "transaction index block hash"),
    burnBlockHeight: assertSafeInteger(bitcoinBlock.height, "transaction Bitcoin block height"),
  };
}

async function selectEventsAtAnchor(
  fetchImpl,
  apiUrl,
  apiHeaders,
  candidates,
  anchorHeight,
  cache,
) {
  const selected = await mapWithConcurrency(
    [...candidates.entries()],
    8,
    async ([manager, events]) => {
      for (const event of events) {
        let transactionPromise = cache.get(event.txId);
        if (transactionPromise === undefined) {
          const url = endpoint(apiUrl, `/extended/v3/transactions/${event.txId}`);
          transactionPromise = fetchJson(fetchImpl, url, { headers: apiHeaders }).then((value) =>
            parseTransactionSummary(value, event.txId),
          );
          cache.set(event.txId, transactionPromise);
        }
        const inclusion = await transactionPromise;
        if (inclusion.blockHeight <= anchorHeight) return [manager, { ...event, ...inclusion }];
      }
      return [manager, null];
    },
  );
  return new Map(selected.filter((entry) => entry[1] !== null));
}

function parseContractDeployment(value, index) {
  const result = assertObject(value, `trait result ${index}`);
  const abiText = assertString(result.abi, `trait result ${index} ABI`);
  let abi;
  try {
    abi = JSON.parse(abiText);
  } catch (error) {
    throw new Error(`trait result ${index} ABI is not JSON`, { cause: error });
  }
  return {
    principal: assertContractPrincipal(result.contract_id, `trait result ${index} contract`),
    txId: canonicalHex32(result.tx_id, `trait result ${index} transaction id`),
    canonical: result.canonical === true,
    blockHeight: assertSafeInteger(result.block_height, `trait result ${index} block height`),
    clarityVersion:
      result.clarity_version === null
        ? null
        : assertSafeInteger(result.clarity_version, `trait result ${index} Clarity version`),
    source: assertString(result.source_code, `trait result ${index} source`),
    abi,
  };
}

function interfaceClarityVersion(abi) {
  const version = abi.clarity_version;
  return typeof version === "string" && /^Clarity[1-9][0-9]*$/.test(version) ? version : null;
}

function interfaceEpoch(abi) {
  const epoch = abi.epoch;
  return typeof epoch === "string" && /^Epoch[0-9]+(?:_[0-9]+)*$/.test(epoch) ? epoch : null;
}

async function discoverTraitContracts(fetchImpl, apiUrl, apiHeaders) {
  const deployments = [];
  const seen = new Set();
  for (let offset = 0; ; offset += 50) {
    const url = endpoint(apiUrl, "/extended/v1/contract/by_trait");
    url.searchParams.set("trait_abi", JSON.stringify(signerManagerTraitAbi));
    url.searchParams.set("limit", "50");
    url.searchParams.set("offset", String(offset));
    const page = assertObject(
      await fetchJson(fetchImpl, url, { headers: apiHeaders }),
      "trait discovery page",
    );
    if (!Array.isArray(page.results)) throw new Error("trait discovery results must be an array");
    const parsed = page.results.map(parseContractDeployment);
    for (const deployment of parsed) {
      if (seen.has(deployment.principal)) {
        throw new Error(`Trait discovery repeated ${deployment.principal}`);
      }
      seen.add(deployment.principal);
      deployments.push(deployment);
    }
    if (parsed.length < 50) break;
    if (offset >= 4_950) throw new Error("Trait discovery exceeded 5,000 contracts");
  }
  return deployments;
}

function interfaceSignatures(abi) {
  if (!Array.isArray(abi.functions)) return [];
  return abi.functions
    .map((entry) => {
      if (entry === null || typeof entry !== "object") return null;
      if (typeof entry.name !== "string" || typeof entry.access !== "string") return null;
      return `${entry.access}:${entry.name}:${sha256(canonicalJson({ args: entry.args, outputs: entry.outputs }))}`;
    })
    .filter((entry) => entry !== null)
    .sort();
}

export function classifyManager({ current, next, registered, traitMatched }) {
  const cycles = [current ? "current" : null, next ? "next" : null].filter(Boolean);
  let lifecycle;
  if (cycles.length > 0) lifecycle = "active";
  else if (registered) lifecycle = "historical-registered";
  else if (traitMatched) lifecycle = "not-yet-registered";
  else lifecycle = "unknown";
  return {
    lifecycle,
    signerSetCycles: cycles,
    sourceDiscovery: traitMatched ? "trait-matched" : "unknown",
  };
}

function testUnusedNameHint(principal) {
  return /(?:^|[-_.])(test|unused|not-used)(?:$|[-_.0-9])/i.test(principal);
}

function summarizeManagers(managers) {
  const byLifecycle = {};
  const bySourceDiscovery = {};
  for (const manager of managers) {
    byLifecycle[manager.lifecycle] = (byLifecycle[manager.lifecycle] ?? 0) + 1;
    bySourceDiscovery[manager.sourceDiscovery] =
      (bySourceDiscovery[manager.sourceDiscovery] ?? 0) + 1;
  }
  return {
    managers: managers.length,
    byLifecycle,
    bySourceDiscovery,
    currentSignerSet: managers.filter(({ signerSetCycles }) => signerSetCycles.includes("current"))
      .length,
    nextSignerSet: managers.filter(({ signerSetCycles }) => signerSetCycles.includes("next"))
      .length,
    nodeVerifiedRegistrations: managers.filter(({ nodeSignerKey }) => nodeSignerKey !== null)
      .length,
    registrationEvents: managers.filter(({ registrationEvent }) => registrationEvent !== null)
      .length,
    traitDeployments: managers.filter(({ deployment }) => deployment !== null).length,
  };
}

function summarizeSourceFamilies(managers) {
  const families = new Map();
  for (const manager of managers) {
    if (manager.deployment === null) continue;
    const key = manager.deployment.sourceSha256;
    const family = families.get(key) ?? {
      sourceSha256: key,
      interfaceSha256s: [],
      clarityVersions: [],
      epochs: [],
      clarityTokenSha256: manager.deployment.clarityTokenSha256,
      deployments: [],
      lifecycleCounts: {},
      interfaceSignatures: manager.deployment.interfaceSignatures,
    };
    if (!family.interfaceSha256s.includes(manager.deployment.interfaceSha256)) {
      family.interfaceSha256s.push(manager.deployment.interfaceSha256);
    }
    if (
      manager.deployment.interfaceClarityVersion !== null &&
      !family.clarityVersions.includes(manager.deployment.interfaceClarityVersion)
    ) {
      family.clarityVersions.push(manager.deployment.interfaceClarityVersion);
    }
    if (
      manager.deployment.interfaceEpoch !== null &&
      !family.epochs.includes(manager.deployment.interfaceEpoch)
    ) {
      family.epochs.push(manager.deployment.interfaceEpoch);
    }
    family.deployments.push(manager.principal);
    family.lifecycleCounts[manager.lifecycle] =
      (family.lifecycleCounts[manager.lifecycle] ?? 0) + 1;
    families.set(key, family);
  }
  return [...families.values()]
    .map((family) => ({
      ...family,
      interfaceSha256s: family.interfaceSha256s.sort(),
      clarityVersions: family.clarityVersions.sort(),
      epochs: family.epochs.sort(),
      deployments: family.deployments.sort(),
    }))
    .sort((left, right) => left.sourceSha256.localeCompare(right.sourceSha256));
}

export async function collectManagerCensus({
  nodeUrl,
  apiUrl = "https://api.mainnet.hiro.so",
  apiKey,
  fetchImpl = fetch,
  capturedAt = new Date().toISOString(),
  expectedPoxContract = mainnetPox5,
}) {
  if (!nodeUrl) throw new Error("nodeUrl is required");
  const apiHeaders = apiKey ? { "x-api-key": apiKey } : undefined;
  const anchor = await readNodeAnchor(fetchImpl, nodeUrl, expectedPoxContract);
  const [currentSignerSet, nextSignerSet, activity, traitDeployments] = await Promise.all([
    readSignerSet(fetchImpl, nodeUrl, anchor, anchor.currentCycle),
    readSignerSet(fetchImpl, nodeUrl, anchor, anchor.nextCycle),
    discoverPoxActivity(fetchImpl, apiUrl, anchor.poxContract, apiHeaders),
    discoverTraitContracts(fetchImpl, apiUrl, apiHeaders),
  ]);
  const transactionCache = new Map();
  const [anchoredRegistrations, anchoredActivity] = await Promise.all([
    selectEventsAtAnchor(
      fetchImpl,
      apiUrl,
      apiHeaders,
      activity.registrations,
      anchor.stacksTipHeight,
      transactionCache,
    ),
    selectEventsAtAnchor(
      fetchImpl,
      apiUrl,
      apiHeaders,
      activity.latestActivity,
      anchor.stacksTipHeight,
      transactionCache,
    ),
  ]);
  const current = new Set(currentSignerSet);
  const next = new Set(nextSignerSet);
  const deployments = new Map(
    traitDeployments
      .filter(({ canonical, blockHeight }) => canonical && blockHeight <= anchor.stacksTipHeight)
      .map((deployment) => [deployment.principal, deployment]),
  );
  const candidates = new Set([
    ...currentSignerSet,
    ...nextSignerSet,
    ...anchoredRegistrations.keys(),
    ...deployments.keys(),
  ]);
  const nodeSignerKeys = new Map();
  for (const manager of [...candidates].sort()) {
    nodeSignerKeys.set(manager, await getSignerInfo(fetchImpl, nodeUrl, anchor, manager));
  }
  const managers = [...candidates].sort().map((principal) => {
    const rawDeployment = deployments.get(principal) ?? null;
    const nodeSignerKey = nodeSignerKeys.get(principal) ?? null;
    const classification = classifyManager({
      current: current.has(principal),
      next: next.has(principal),
      registered: nodeSignerKey !== null,
      traitMatched: rawDeployment !== null,
    });
    const deployment =
      rawDeployment === null
        ? null
        : {
            txId: rawDeployment.txId,
            blockHeight: rawDeployment.blockHeight,
            clarityVersion: rawDeployment.clarityVersion,
            sourceSha256: sha256(rawDeployment.source),
            interfaceSha256: sha256(canonicalJson(rawDeployment.abi)),
            interfaceClarityVersion: interfaceClarityVersion(rawDeployment.abi),
            interfaceEpoch: interfaceEpoch(rawDeployment.abi),
            clarityTokenSha256: clarityTokenSha256(rawDeployment.source),
            interfaceSignatures: interfaceSignatures(rawDeployment.abi),
          };
    return {
      principal,
      ...classification,
      nodeSignerKey,
      registrationEvent: anchoredRegistrations.get(principal) ?? null,
      latestObservedPoxActivity: anchoredActivity.get(principal) ?? null,
      deployment,
      evidenceHints: {
        testOrUnusedName: testUnusedNameHint(principal),
        authoritative: false,
      },
    };
  });
  const deploymentsAtAnchor = [...deployments.values()];
  const sources = Object.fromEntries(
    deploymentsAtAnchor.map(({ source }) => [sha256(source), source]),
  );
  const interfaces = Object.fromEntries(
    deploymentsAtAnchor.map(({ abi }) => [sha256(canonicalJson(abi)), abi]),
  );
  const artifact = {
    schemaVersion: 1,
    capturedAt,
    purpose: "research-and-test-input-only",
    authority: {
      chainState: "anchored-local-stacks-node",
      discovery: "public-indexer-supplement",
      runtimeAllowlist: false,
    },
    anchor,
    discovery: {
      poxLogs: {
        apiPath: `/extended/v2/smart-contracts/${anchor.poxContract}/logs`,
        pages: activity.pages,
        events: activity.events,
      },
      signerManagerTrait: {
        apiPath: "/extended/v1/contract/by_trait",
        traitAbi: signerManagerTraitAbi,
        traitAbiSha256: sha256(canonicalJson(signerManagerTraitAbi)),
        canonicalDeploymentsAtAnchor: deployments.size,
      },
    },
    summary: summarizeManagers(managers),
    sourceFamilies: summarizeSourceFamilies(managers),
    managers,
  };
  return { artifact, sources, interfaces };
}

export async function writeManagerCensus({ outputPath, artifact, sources, interfaces }) {
  const absoluteOutput = resolve(outputPath);
  const directory = dirname(absoluteOutput);
  await mkdir(join(directory, "sources"), { recursive: true });
  await mkdir(join(directory, "interfaces"), { recursive: true });
  const artifactText = `${JSON.stringify(artifact, null, 2)}\n`;
  await writeFile(absoluteOutput, artifactText, "utf8");
  for (const [digest, source] of Object.entries(sources)) {
    await writeFile(join(directory, "sources", `${digest}.clar`), source, "utf8");
  }
  for (const [digest, abi] of Object.entries(interfaces)) {
    await writeFile(
      join(directory, "interfaces", `${digest}.json`),
      `${JSON.stringify(abi, null, 2)}\n`,
      "utf8",
    );
  }
  await writeFile(
    `${absoluteOutput}.sha256`,
    `${sha256(artifactText)}  ${absoluteOutput.split("/").at(-1)}\n`,
  );
  return { outputPath: absoluteOutput, sha256: sha256(artifactText) };
}

export async function verifyManagerCensus(inputPath) {
  const absoluteInput = resolve(inputPath);
  const directory = dirname(absoluteInput);
  const artifactText = await readFile(absoluteInput, "utf8");
  const checksumText = await readFile(`${absoluteInput}.sha256`, "utf8");
  const checksumMatch = checksumText.match(/^([0-9a-f]{64}) {2}([^\n]+)\n$/);
  if (checksumMatch === null || checksumMatch[2] !== absoluteInput.split("/").at(-1)) {
    throw new Error(`${absoluteInput}.sha256 has an invalid checksum record`);
  }
  const artifactSha256 = sha256(artifactText);
  if (checksumMatch[1] !== artifactSha256) {
    throw new Error(`${absoluteInput} does not match its recorded SHA-256`);
  }
  const artifact = assertObject(JSON.parse(artifactText), "census artifact");
  if (artifact.schemaVersion !== 1) throw new Error("Unsupported census schema version");
  if (artifact.purpose !== "research-and-test-input-only") {
    throw new Error("Census artifact has an invalid purpose boundary");
  }
  if (assertObject(artifact.authority, "census authority").runtimeAllowlist !== false) {
    throw new Error("Census artifact must explicitly reject runtime allowlist use");
  }
  if (!Array.isArray(artifact.managers)) throw new Error("Census managers must be an array");
  const sourceHashes = new Set();
  const interfaceHashes = new Set();
  for (const [index, managerValue] of artifact.managers.entries()) {
    const manager = assertObject(managerValue, `census manager ${index}`);
    assertContractPrincipal(manager.principal, `census manager ${index} principal`);
    if (manager.deployment === null) continue;
    const deployment = assertObject(manager.deployment, `census manager ${index} deployment`);
    sourceHashes.add(canonicalHex32(deployment.sourceSha256, "source SHA-256").slice(2));
    interfaceHashes.add(canonicalHex32(deployment.interfaceSha256, "interface SHA-256").slice(2));
  }
  for (const digest of sourceHashes) {
    const source = await readFile(join(directory, "sources", `${digest}.clar`), "utf8");
    if (sha256(source) !== digest) throw new Error(`Source artifact ${digest} failed SHA-256`);
  }
  for (const digest of interfaceHashes) {
    const text = await readFile(join(directory, "interfaces", `${digest}.json`), "utf8");
    const abi = JSON.parse(text);
    if (sha256(canonicalJson(abi)) !== digest) {
      throw new Error(`Interface artifact ${digest} failed canonical SHA-256`);
    }
  }
  return {
    inputPath: absoluteInput,
    artifactSha256,
    managers: artifact.managers.length,
    sources: sourceHashes.size,
    interfaces: interfaceHashes.size,
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--node-url" || argument === "--api-url" || argument === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      options[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
      continue;
    }
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: pnpm census:managers -- --node-url URL --output PATH [--api-url URL]

Create a mainnet signer-manager research census from an anchored local Stacks node. HIRO_API_KEY
is optional. The generated artifact is evidence for adapter review and never a runtime allowlist.`);
    return;
  }
  if (!options.nodeUrl || !options.output) {
    throw new Error("--node-url and --output are required; use --help for usage");
  }
  const result = await collectManagerCensus({
    nodeUrl: options.nodeUrl,
    apiUrl: options.apiUrl,
    apiKey: process.env.HIRO_API_KEY,
  });
  const written = await writeManagerCensus({ outputPath: options.output, ...result });
  console.log(
    JSON.stringify(
      {
        output: written.outputPath,
        sha256: written.sha256,
        anchor: result.artifact.anchor,
        summary: result.artifact.summary,
      },
      null,
      2,
    ),
  );
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (import.meta.url === entrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
