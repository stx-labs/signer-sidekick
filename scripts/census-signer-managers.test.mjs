import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  bufferCV,
  cvToHex,
  hexToCV,
  noneCV,
  principalCV,
  someCV,
  stringAsciiCV,
  tupleCV,
} from "@stacks/transactions";
import {
  canonicalJson,
  classifyManager,
  collectManagerCensus,
  decodePoxPrintEvent,
  enumerateSignerSet,
  sha256,
  verifyManagerCensus,
  writeManagerCensus,
} from "./census-signer-managers.mjs";

const boot = "SP000000000000000000002Q6VF78";
const pox5 = `${boot}.pox-5`;
const managerA = `${boot}.manager-a`;
const managerB = `${boot}.manager-b`;
const managerHistorical = `${boot}.manager-historical`;
const managerTraitOnly = `${boot}.manager-test-unused`;
const tip = `0x${"11".repeat(32)}`;
const source = "(define-public (validate-stake! (staker principal)) (ok true))\n";
const abi = {
  functions: [
    {
      name: "validate-stake!",
      access: "public",
      args: [{ name: "staker", type: "principal" }],
      outputs: { type: { response: { ok: "bool", error: "uint128" } } },
    },
  ],
};

function eventHex(topic, signer, signerKey = null) {
  const value = {
    topic: stringAsciiCV(topic),
    signer: principalCV(signer),
  };
  if (signerKey !== null) value["signer-key"] = bufferCV(Buffer.from(signerKey, "hex"));
  return cvToHex(tupleCV(value));
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function clarityResponse(value) {
  return jsonResponse({ okay: true, result: cvToHex(value) });
}

function decodeArgument(body, index) {
  return hexToCV(JSON.parse(body).arguments[index]);
}

function mockFetch() {
  return async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === "/v2/info") {
      return jsonResponse({
        network_id: 1,
        burn_block_height: 1000,
        stacks_tip_height: 2000,
        stacks_tip: tip,
        is_fully_synced: true,
      });
    }
    if (url.pathname === "/v2/pox") {
      assert.equal(url.searchParams.get("tip"), tip.slice(2));
      return jsonResponse({
        contract_id: pox5,
        current_burnchain_block_height: 1000,
        current_cycle: { id: 141 },
        next_cycle: { id: 142 },
      });
    }
    if (url.pathname === "/v3/tenures/info") {
      return jsonResponse({ tip_block_id: tip, tip_height: 2000, reward_cycle: 141 });
    }
    if (url.pathname.endsWith("/get-signer-set-first-item-for-cycle")) {
      const cycle = Number(decodeArgument(init.body, 0).value);
      return clarityResponse(
        someCV(hexToCV(eventHex("ignored", cycle === 141 ? managerA : managerB)).value.signer),
      );
    }
    if (url.pathname.endsWith("/get-signer-set-next-item-for-cycle")) {
      return clarityResponse(noneCV());
    }
    if (url.pathname.endsWith("/get-signer-info")) {
      const manager = decodeArgument(init.body, 0).value;
      return clarityResponse(
        manager === managerTraitOnly
          ? noneCV()
          : someCV(bufferCV(Buffer.alloc(33, manager === managerA ? 2 : 3))),
      );
    }
    if (url.pathname === `/extended/v2/smart-contracts/${pox5}/logs`) {
      return jsonResponse({
        limit: 100,
        offset: 0,
        total: 2,
        next_cursor: null,
        prev_cursor: null,
        cursor: "2000:2147483647:1:0",
        results: [
          {
            event_index: 0,
            event_type: "smart_contract_log",
            tx_id: `0x${"22".repeat(32)}`,
            contract_log: {
              contract_id: pox5,
              topic: "print",
              value: {
                hex: eventHex("register-signer", managerA, `02${"aa".repeat(32)}`),
                repr: `(tuple (signer '${managerA}) (topic "register-signer"))`,
              },
            },
          },
          {
            event_index: 1,
            event_type: "smart_contract_log",
            tx_id: `0x${"33".repeat(32)}`,
            contract_log: {
              contract_id: pox5,
              topic: "print",
              value: {
                hex: eventHex("register-signer", managerHistorical, `03${"bb".repeat(32)}`),
                repr: `(tuple (signer '${managerHistorical}) (topic "register-signer"))`,
              },
            },
          },
        ],
      });
    }
    if (url.pathname === "/extended/v1/contract/by_trait") {
      assert.equal(url.searchParams.get("limit"), "50");
      assert.ok(url.searchParams.get("trait_abi").includes("validate-stake!"));
      return jsonResponse({
        limit: 50,
        offset: 0,
        results: [managerA, managerTraitOnly].map((contractId, index) => ({
          tx_id: `0x${String(index + 4).repeat(64)}`,
          canonical: true,
          contract_id: contractId,
          block_height: 1900 + index,
          clarity_version: 3,
          source_code: source,
          abi: JSON.stringify(abi),
        })),
      });
    }
    if (url.pathname.startsWith("/extended/v3/transactions/")) {
      const txId = url.pathname.split("/").at(-1);
      return jsonResponse({
        tx_id: txId,
        status: "success",
        block: {
          height: 1999,
          hash: `0x${"44".repeat(32)}`,
          index_hash: `0x${"55".repeat(32)}`,
          time: 1,
          tx_index: 0,
        },
        bitcoin_block: { height: 999, time: 1 },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
}

test("canonical JSON and hashes are stable across object key order", () => {
  const first = canonicalJson({ z: [2, 1], a: { d: true, c: null } });
  const second = canonicalJson({ a: { c: null, d: true }, z: [2, 1] });
  assert.equal(first, second);
  assert.equal(sha256(first), sha256(second));
});

test("decodes registration and generic PoX print evidence", () => {
  assert.deepEqual(
    decodePoxPrintEvent(eventHex("register-signer", managerA, `02${"ab".repeat(32)}`)),
    {
      topic: "register-signer",
      signer: managerA,
      signerKey: `0x02${"ab".repeat(32)}`,
    },
  );
  assert.equal(decodePoxPrintEvent("0x03"), null);
});

test("enumerates a bounded signer-set linked list and rejects loops", async () => {
  const next = new Map([
    [managerA, managerB],
    [managerB, null],
  ]);
  await assert.doesNotReject(async () => {
    assert.deepEqual(
      await enumerateSignerSet({
        cycle: 141,
        readFirst: async () => managerA,
        readNext: async (manager) => next.get(manager),
      }),
      [managerA, managerB],
    );
  });
  await assert.rejects(
    enumerateSignerSet({
      cycle: 141,
      readFirst: async () => managerA,
      readNext: async () => managerA,
    }),
    /contains a loop/,
  );
});

test("classifies lifecycle separately from source discovery", () => {
  assert.deepEqual(
    classifyManager({ current: true, next: false, registered: true, traitMatched: false }),
    { lifecycle: "active", signerSetCycles: ["current"], sourceDiscovery: "unknown" },
  );
  assert.equal(
    classifyManager({ current: false, next: false, registered: false, traitMatched: true })
      .lifecycle,
    "not-yet-registered",
  );
});

test("builds a node-anchored census and writes checksummed evidence", async () => {
  const result = await collectManagerCensus({
    nodeUrl: "http://node.example.test:20443",
    apiUrl: "https://api.example.test",
    fetchImpl: mockFetch(),
    capturedAt: "2026-08-13T12:00:00.000Z",
  });
  assert.deepEqual(result.artifact.summary.byLifecycle, {
    active: 2,
    "historical-registered": 1,
    "not-yet-registered": 1,
  });
  assert.equal(result.artifact.summary.currentSignerSet, 1);
  assert.equal(result.artifact.summary.nextSignerSet, 1);
  assert.equal(result.artifact.authority.runtimeAllowlist, false);
  assert.equal(result.artifact.sourceFamilies.length, 1);
  const traitOnly = result.artifact.managers.find(
    ({ principal }) => principal === managerTraitOnly,
  );
  assert.equal(traitOnly.lifecycle, "not-yet-registered");
  assert.equal(traitOnly.evidenceHints.testOrUnusedName, true);
  assert.equal(traitOnly.evidenceHints.authoritative, false);

  const directory = await mkdtemp(resolve(tmpdir(), "sidekick-manager-census-"));
  try {
    const outputPath = resolve(directory, "mainnet.json");
    const written = await writeManagerCensus({ outputPath, ...result });
    assert.equal((await readFile(`${outputPath}.sha256`, "utf8")).startsWith(written.sha256), true);
    assert.equal(JSON.parse(await readFile(outputPath, "utf8")).schemaVersion, 1);
    assert.equal(
      await readFile(resolve(directory, "sources", `${sha256(source)}.clar`), "utf8"),
      source,
    );
    await assert.doesNotReject(verifyManagerCensus(outputPath));
    await writeFile(
      resolve(directory, "sources", `${sha256(source)}.clar`),
      `${source};; tampered\n`,
    );
    await assert.rejects(verifyManagerCensus(outputPath), /failed SHA-256/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
