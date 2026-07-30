import { ClarityType, deserializeCV } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  createStakeCalldataTemplates,
  ENABLED_SIGNUP_PROVIDERS,
  encodeNoneCalldata,
  encodeStakeManagerArg,
  POOL_SIGNUP_SCRIPT,
} from "./pool-signup.js";

const MANAGER = "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR.signer-manager";

/** Evaluate exactly the script that ships, in a sandbox that stands in for `window`. */
function loadRuntime() {
  const sandbox: Record<string, unknown> = { crypto: globalThis.crypto };
  const factory = new Function(
    "window",
    "globalThis",
    `${POOL_SIGNUP_SCRIPT}\nreturn globalThis.sidekickPoolSignup;`,
  );
  return factory(undefined, sandbox) as {
    stxToUstx(input: unknown): bigint | null;
    uintHex(value: bigint): string;
    decodeMainnetPoxAddress(
      address: unknown,
    ): Promise<{ version?: number; hashbytes?: Uint8Array; error?: string }>;
    encodeMainnetPoxAddress(version: number, hashbytes: Uint8Array): Promise<string>;
    isPreparePhase(pox: unknown): boolean | null;
    pickStacksAddress(response: unknown): string | null;
    unwrapResponse(response: unknown): unknown;
    resolveProvider(id: string): unknown;
    hexToBytes(hex: string): Uint8Array;
    buildCalldataHex(signup: unknown, version: number, hashbytes: Uint8Array): string | null;
    buildFunctionArgs(
      signup: unknown,
      amountUstx: bigint,
      numCycles: number,
      burnHeight: number,
      calldataHex: string,
    ): string[];
  };
}

function signupPayload(maxFeeSats: bigint) {
  return {
    managerArgHex: encodeStakeManagerArg(MANAGER),
    noneCalldataHex: encodeNoneCalldata(),
    calldataTemplates: createStakeCalldataTemplates(maxFeeSats),
  };
}

/** Decode the full `stake` argument list back into plain values. */
function decodeStakeArgs(args: string[]) {
  const [manager, amount, cycles, burnHeight, calldata] = args.map((arg) =>
    deserializeCV(arg.startsWith("0x") ? arg.slice(2) : arg),
  );
  if (manager.type !== ClarityType.PrincipalContract) throw new Error("expected a contract");
  if (amount.type !== ClarityType.UInt) throw new Error("expected uint amount");
  if (cycles.type !== ClarityType.UInt) throw new Error("expected uint cycles");
  if (burnHeight.type !== ClarityType.UInt) throw new Error("expected uint burn height");

  let payout: { versionHex: string; hashbytesHex: string; maxFee: bigint } | null = null;
  if (calldata.type === ClarityType.OptionalSome) {
    const buffer = calldata.value;
    if (buffer.type !== ClarityType.Buffer) throw new Error("expected a buff payload");
    const preference = deserializeCV(buffer.value);
    if (preference.type !== ClarityType.Tuple) throw new Error("expected a tuple payload");
    const poxAddr = preference.value["pox-addr"];
    const maxFee = preference.value["max-fee"];
    if (poxAddr?.type !== ClarityType.Tuple) throw new Error("expected pox-addr");
    if (maxFee?.type !== ClarityType.UInt) throw new Error("expected max-fee");
    const version = poxAddr.value.version;
    const hashbytes = poxAddr.value.hashbytes;
    if (version?.type !== ClarityType.Buffer) throw new Error("expected version buff");
    if (hashbytes?.type !== ClarityType.Buffer) throw new Error("expected hashbytes buff");
    payout = {
      versionHex: version.value,
      hashbytesHex: hashbytes.value,
      maxFee: maxFee.value,
    };
  } else if (calldata.type !== ClarityType.OptionalNone) {
    throw new Error("expected an optional calldata argument");
  }

  return {
    manager: manager.value,
    amountUstx: amount.value,
    numCycles: cycles.value,
    burnHeight: burnHeight.value,
    payout,
  };
}

describe("pool signup calldata", () => {
  it("decodes a complete direct-sBTC stake argument list", () => {
    const runtime = loadRuntime();
    const signup = signupPayload(10_000n);

    const args = runtime.buildFunctionArgs(
      signup,
      49_000_000_000n,
      6,
      960_262,
      signup.noneCalldataHex,
    );

    expect(decodeStakeArgs(args)).toEqual({
      manager: MANAGER,
      amountUstx: 49_000_000_000n,
      numCycles: 6n,
      burnHeight: 960_262n,
      payout: null,
    });
  });

  it.each([
    ["P2WPKH", 4, "751e76e8199196d454941c45d1b3a323f1433bd6"],
    ["P2TR", 6, "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"],
  ])("decodes a complete L1 stake argument list for %s", (_label, version, hashbytesHex) => {
    const runtime = loadRuntime();
    const signup = signupPayload(12_345n);
    const hashbytes = runtime.hexToBytes(hashbytesHex);

    const calldataHex = runtime.buildCalldataHex(signup, version, hashbytes);
    expect(calldataHex).not.toBeNull();
    const args = runtime.buildFunctionArgs(signup, 1_000_000n, 12, 960_263, calldataHex as string);

    expect(decodeStakeArgs(args)).toEqual({
      manager: MANAGER,
      amountUstx: 1_000_000n,
      numCycles: 12n,
      burnHeight: 960_263n,
      payout: {
        versionHex: version.toString(16).padStart(2, "0"),
        hashbytesHex,
        maxFee: 12_345n,
      },
    });
  });

  it("has no template for an unsupported hashbytes length", () => {
    const runtime = loadRuntime();
    expect(runtime.buildCalldataHex(signupPayload(0n), 0, new Uint8Array(21))).toBeNull();
  });

  it("ships the enabled public-page wallets", () => {
    expect(ENABLED_SIGNUP_PROVIDERS.map(({ id }) => id)).toEqual([
      "LeatherProvider",
      "XverseProviders.BitcoinProvider",
    ]);
  });
});

describe("pool signup amount conversion", () => {
  it.each([
    ["1", 1_000_000n],
    ["0.000001", 1n],
    ["123.456789", 123_456_789n],
    ["  10.5  ", 10_500_000n],
    ["49000", 49_000_000_000n],
  ])("converts %s STX exactly", (input, expected) => {
    expect(loadRuntime().stxToUstx(input)).toBe(expected);
  });

  it.each([
    ["0.1234567", "seven decimals"],
    ["", "empty"],
    ["abc", "non-numeric"],
    ["-1", "negative"],
    ["0", "zero"],
    ["1e6", "exponent"],
    ["1.", "trailing separator"],
  ])("rejects %s (%s)", (input) => {
    expect(loadRuntime().stxToUstx(input)).toBeNull();
  });
});

describe("pool signup Bitcoin address handling", () => {
  it.each([
    ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", 0, "62e907b15cbf27d5425399ebf6f0fb50ebb88f18"],
    ["BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", 4, "751e76e8199196d454941c45d1b3a323f1433bd6"],
    [
      "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3",
      5,
      "1863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262",
    ],
    [
      "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
      6,
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    ],
  ])("accepts mainnet %s", async (address, version, hashbytesHex) => {
    const runtime = loadRuntime();
    const decoded = await runtime.decodeMainnetPoxAddress(address);
    expect(decoded.error).toBeUndefined();
    expect(decoded.version).toBe(version);
    expect(Buffer.from(decoded.hashbytes as Uint8Array).toString("hex")).toBe(hashbytesHex);
  });

  it.each([
    ["tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "testnet segwit"],
    ["mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", "testnet P2PKH"],
    ["bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080", "regtest"],
  ])("rejects %s (%s)", async (address) => {
    expect((await loadRuntime().decodeMainnetPoxAddress(address)).error).toBe("not-mainnet");
  });

  it.each([
    ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb", "bad base58 checksum"],
    ["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5", "bad bech32 checksum"],
    ["bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v", "taproot as bech32"],
    ["not an address", "garbage"],
  ])("rejects %s (%s)", async (address) => {
    const decoded = await loadRuntime().decodeMainnetPoxAddress(address);
    expect(decoded.version).toBeUndefined();
    expect(decoded.error).toBeTruthy();
  });

  // Base58Check is case-sensitive and round-trips exactly; Bech32 canonicalises to lower case.
  it.each([
    ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"],
    ["BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"],
    [
      "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
      "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
    ],
  ])("round-trips %s so the staker can verify before signing", async (address, canonical) => {
    const runtime = loadRuntime();
    const decoded = await runtime.decodeMainnetPoxAddress(address);
    const encoded = await runtime.encodeMainnetPoxAddress(
      decoded.version as number,
      decoded.hashbytes as Uint8Array,
    );
    expect(encoded).toBe(canonical);
  });
});

describe("pool signup preflight guards", () => {
  it.each([
    [{ next_cycle: { blocks_until_prepare_phase: 738, blocks_until_reward_phase: 838 } }, false],
    [{ next_cycle: { blocks_until_prepare_phase: 0, blocks_until_reward_phase: 100 } }, true],
    [{ next_cycle: { blocks_until_prepare_phase: -5, blocks_until_reward_phase: 95 } }, true],
    [{ next_cycle: { blocks_until_prepare_phase: 0, blocks_until_reward_phase: 0 } }, false],
  ])("classifies the reward window", (pox, expected) => {
    expect(loadRuntime().isPreparePhase(pox)).toBe(expected);
  });

  it.each([
    [{}, "missing next_cycle"],
    [{ next_cycle: {} }, "missing counters"],
    [null, "no response"],
  ])("returns null rather than guessing when phase data is unusable (%s)", (pox) => {
    expect(loadRuntime().isPreparePhase(pox)).toBeNull();
  });

  it("selects a single mainnet Stacks address", () => {
    const response = {
      addresses: [
        { address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4" },
        { address: "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR" },
      ],
    };
    expect(loadRuntime().pickStacksAddress(response)).toBe(
      "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR",
    );
  });

  it.each([
    [{ addresses: [] }, "no addresses"],
    [{ addresses: [{ address: "ST2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMWTMWWE" }] }, "testnet only"],
    [
      {
        addresses: [
          { address: "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR" },
          { address: "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE" },
        ],
      },
      "ambiguous",
    ],
  ])("refuses to guess an address (%s)", (response) => {
    expect(loadRuntime().pickStacksAddress(response)).toBeNull();
  });
});

describe("pool signup wallet responses", () => {
  const STX = "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR";

  it("unwraps a JSON-RPC getAddresses envelope", () => {
    const runtime = loadRuntime();
    const envelope = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        addresses: [
          { address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", publicKey: "02ab" },
          { address: STX, publicKey: "02cd" },
        ],
      },
    };

    // Without unwrapping, the envelope has no `addresses` and the lookup silently reads as empty.
    expect(runtime.pickStacksAddress(envelope)).toBeNull();
    expect(runtime.pickStacksAddress(runtime.unwrapResponse(envelope))).toBe(STX);
  });

  it("unwraps a JSON-RPC stx_callContract envelope", () => {
    const runtime = loadRuntime();
    const txid = `0x${"ab".repeat(32)}`;
    const envelope = { jsonrpc: "2.0", id: 1, result: { txid } };

    expect((envelope as { txid?: string }).txid).toBeUndefined();
    expect(runtime.unwrapResponse(envelope)).toEqual({ txid });
  });

  it("raises a JSON-RPC error response rather than reading it as a result", () => {
    const runtime = loadRuntime();
    const envelope = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: 4001, message: "User rejected the request" },
    };

    expect(() => runtime.unwrapResponse(envelope)).toThrow("User rejected the request");
  });

  it("passes through a provider that already returns an unwrapped body", () => {
    const runtime = loadRuntime();
    const bare = { addresses: [{ address: STX }] };

    expect(runtime.unwrapResponse(bare)).toBe(bare);
    expect(runtime.pickStacksAddress(runtime.unwrapResponse(bare))).toBe(STX);
  });
});
