import {
  bufferCV,
  cvToHex,
  noneCV,
  principalCV,
  serializeCVBytes,
  someCV,
  tupleCV,
  uintCV,
} from "@stacks/transactions";

/**
 * Staker-facing PoX-5 `stake` support for the generated public pool page.
 *
 * The page is a self-contained artifact the operator hosts. It never talks to Sidekick, so
 * everything it cannot derive on its own is baked in here at generation time: the encoded
 * signer-manager argument, and byte templates for the `{ pox-addr, max-fee }` consensus payload.
 * The page only splices a version byte and hashbytes into a template, which keeps Clarity
 * serialization out of browser code entirely.
 */

/** Hashbytes lengths permitted by the reference manager's `check-pox-addr`. */
export const POX_ADDRESS_HASHBYTES_LENGTHS = [20, 32] as const;
export type PoxAddressHashbytesLength = (typeof POX_ADDRESS_HASHBYTES_LENGTHS)[number];

export interface StakeCalldataTemplate {
  hashbytesLength: PoxAddressHashbytesLength;
  /** Serialized `(optional (buff 500))` with placeholder version and hashbytes bytes. */
  templateHex: string;
  versionOffset: number;
  hashbytesOffset: number;
}

export interface PoolSignupPayload {
  pox5ContractId: string;
  functionName: "stake";
  managerArgHex: string;
  noneCalldataHex: string;
  minCycles: number;
  maxCycles: number;
  explorerTxUrlPrefix: string;
  bitcoinL1: boolean;
  l1MaxFeeSats: string | null;
  calldataTemplates: StakeCalldataTemplate[];
  providers: Array<{ id: string; label: string }>;
}

/**
 * Wallets certified for this exact call. A public money-moving page should not surface arbitrary
 * detected extensions, so adding an entry here requires a real-origin mainnet `stake` test
 * covering both direct-sBTC and L1 payouts.
 */
export const CERTIFIED_SIGNUP_PROVIDERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "LeatherProvider", label: "Leather" },
];

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function serializeStakeCalldata(
  maxFeeSats: bigint,
  version: Uint8Array,
  hashbytes: Uint8Array,
): Uint8Array {
  const preference = tupleCV({
    "pox-addr": tupleCV({ version: bufferCV(version), hashbytes: bufferCV(hashbytes) }),
    "max-fee": uintCV(maxFeeSats),
  });
  return serializeCVBytes(someCV(bufferCV(serializeCVBytes(preference))));
}

/**
 * Byte ranges that differ between two serializations. Because the two inputs differ in every
 * variable byte (0x00 against 0xff) and are identical everywhere else, the differing ranges are
 * exactly the version and hashbytes spans — derived rather than assumed, so this stays correct if
 * the Clarity serialization format ever changes shape.
 */
function variableSpans(
  left: Uint8Array,
  right: Uint8Array,
): Array<{ offset: number; length: number }> {
  if (left.length !== right.length) {
    throw new Error("Calldata templates must serialize to the same length");
  }
  const spans: Array<{ offset: number; length: number }> = [];
  let start = -1;
  for (let index = 0; index <= left.length; index += 1) {
    const differs = index < left.length && left[index] !== right[index];
    if (differs && start === -1) start = index;
    if (!differs && start !== -1) {
      spans.push({ offset: start, length: index - start });
      start = -1;
    }
  }
  return spans;
}

export function createStakeCalldataTemplate(
  maxFeeSats: bigint,
  hashbytesLength: PoxAddressHashbytesLength,
): StakeCalldataTemplate {
  if (maxFeeSats < 0n) throw new Error("l1MaxFeeSats must not be negative");
  const low = serializeStakeCalldata(
    maxFeeSats,
    new Uint8Array(1).fill(0x00),
    new Uint8Array(hashbytesLength).fill(0x00),
  );
  const high = serializeStakeCalldata(
    maxFeeSats,
    new Uint8Array(1).fill(0xff),
    new Uint8Array(hashbytesLength).fill(0xff),
  );
  const spans = variableSpans(low, high);
  const versionSpan = spans.find((span) => span.length === 1);
  const hashbytesSpan = spans.find((span) => span.length === hashbytesLength);
  if (spans.length !== 2 || !versionSpan || !hashbytesSpan) {
    throw new Error("Could not locate the version and hashbytes spans in the calldata template");
  }
  return {
    hashbytesLength,
    templateHex: bytesToHex(low),
    versionOffset: versionSpan.offset,
    hashbytesOffset: hashbytesSpan.offset,
  };
}

export function createStakeCalldataTemplates(maxFeeSats: bigint): StakeCalldataTemplate[] {
  return POX_ADDRESS_HASHBYTES_LENGTHS.map((length) =>
    createStakeCalldataTemplate(maxFeeSats, length),
  );
}

export function encodeStakeManagerArg(managerPrincipal: string): string {
  return cvToHex(principalCV(managerPrincipal));
}

export function encodeNoneCalldata(): string {
  return cvToHex(noneCV());
}

/**
 * The staking runtime, inlined verbatim into the generated page. It is exported so tests can
 * evaluate exactly what ships rather than a parallel implementation.
 *
 * Deliberately dependency-free and ES5-ish in style: the artifact has no build step and no
 * bundler. Wallets are window providers exposing `.request(method, params)`.
 */
export const POOL_SIGNUP_SCRIPT = `
(function (global) {
  "use strict";

  var BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  var BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  var GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  var BECH32_CONST = 1;
  var BECH32M_CONST = 0x2bc830a3;

  function bytesToHex(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i += 1) {
      out += bytes[i].toString(16).padStart(2, "0");
    }
    return out;
  }

  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i += 1) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }

  /** Clarity uint: type byte 0x01 followed by a 16-byte big-endian value. */
  function uintHex(value) {
    return "0x01" + value.toString(16).padStart(32, "0");
  }

  /** Human STX to uSTX. String arithmetic only -- floating point loses precision here. */
  function stxToUstx(input) {
    var text = String(input == null ? "" : input).trim();
    if (!/^\\d+(\\.\\d{1,6})?$/.test(text)) return null;
    var parts = text.split(".");
    var fraction = (parts[1] || "").padEnd(6, "0");
    var total = BigInt(parts[0]) * 1000000n + BigInt(fraction);
    return total > 0n ? total : null;
  }

  function base58Decode(text) {
    var bytes = [0];
    for (var i = 0; i < text.length; i += 1) {
      var value = BASE58.indexOf(text.charAt(i));
      if (value < 0) return null;
      var carry = value;
      for (var j = 0; j < bytes.length; j += 1) {
        carry += bytes[j] * 58;
        bytes[j] = carry & 0xff;
        carry >>= 8;
      }
      while (carry > 0) {
        bytes.push(carry & 0xff);
        carry >>= 8;
      }
    }
    for (var k = 0; k < text.length && text.charAt(k) === "1"; k += 1) bytes.push(0);
    return new Uint8Array(bytes.reverse());
  }

  function sha256(bytes) {
    if (!global.crypto || !global.crypto.subtle) {
      return Promise.reject(new Error("insecure-context"));
    }
    return global.crypto.subtle.digest("SHA-256", bytes).then(function (digest) {
      return new Uint8Array(digest);
    });
  }

  function decodeBase58Check(address) {
    var raw = base58Decode(address);
    if (!raw || raw.length !== 25) return Promise.resolve(null);
    var payload = raw.slice(0, 21);
    var checksum = raw.slice(21);
    return sha256(payload)
      .then(sha256)
      .then(function (digest) {
        for (var i = 0; i < 4; i += 1) {
          if (digest[i] !== checksum[i]) return null;
        }
        return { versionByte: payload[0], hash: payload.slice(1) };
      });
  }

  function bech32Polymod(values) {
    var chk = 1;
    for (var p = 0; p < values.length; p += 1) {
      var top = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ values[p];
      for (var i = 0; i < 5; i += 1) {
        if ((top >>> i) & 1) chk ^= GENERATOR[i];
      }
    }
    return chk >>> 0;
  }

  function bech32HrpExpand(hrp) {
    var out = [];
    for (var i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) >>> 5);
    out.push(0);
    for (var j = 0; j < hrp.length; j += 1) out.push(hrp.charCodeAt(j) & 31);
    return out;
  }

  function convertBits(data, from, to, pad) {
    var acc = 0;
    var bits = 0;
    var out = [];
    var maxValue = (1 << to) - 1;
    for (var i = 0; i < data.length; i += 1) {
      if (data[i] < 0 || data[i] >> from !== 0) return null;
      acc = (acc << from) | data[i];
      bits += from;
      while (bits >= to) {
        bits -= to;
        out.push((acc >> bits) & maxValue);
      }
    }
    if (pad) {
      if (bits > 0) out.push((acc << (to - bits)) & maxValue);
    } else if (bits >= from || ((acc << (to - bits)) & maxValue) !== 0) {
      return null;
    }
    return out;
  }

  function decodeBech32(address) {
    var lower = address.toLowerCase();
    if (lower !== address && address.toUpperCase() !== address) return null;
    var split = lower.lastIndexOf("1");
    if (split < 1 || split + 7 > lower.length || lower.length > 90) return null;
    var hrp = lower.slice(0, split);
    var values = [];
    for (var i = split + 1; i < lower.length; i += 1) {
      var value = BECH32.indexOf(lower.charAt(i));
      if (value < 0) return null;
      values.push(value);
    }
    var checksum = bech32Polymod(bech32HrpExpand(hrp).concat(values));
    var encoding =
      checksum === BECH32_CONST ? "bech32" : checksum === BECH32M_CONST ? "bech32m" : null;
    if (!encoding) return null;
    var payload = values.slice(0, values.length - 6);
    var witnessVersion = payload[0];
    var program = convertBits(payload.slice(1), 5, 8, false);
    if (program === null || witnessVersion > 16) return null;
    if (witnessVersion === 0 && encoding !== "bech32") return null;
    if (witnessVersion > 0 && encoding !== "bech32m") return null;
    return { hrp: hrp, witnessVersion: witnessVersion, program: new Uint8Array(program) };
  }

  /**
   * Bitcoin mainnet address to a PoX address. Mainnet only: testnet version bytes and the "tb"
   * human-readable part are rejected rather than warned about, because a testnet payout address
   * on a mainnet stake is always a mistake.
   */
  function decodeMainnetPoxAddress(address) {
    var text = String(address == null ? "" : address).trim();
    if (!text) return Promise.resolve({ error: "empty" });
    if (/^(bc1|BC1)/.test(text)) {
      var decoded = decodeBech32(text);
      if (!decoded || decoded.hrp !== "bc") return Promise.resolve({ error: "invalid" });
      var length = decoded.program.length;
      if (decoded.witnessVersion === 0 && length === 20) {
        return Promise.resolve({ version: 4, hashbytes: decoded.program });
      }
      if (decoded.witnessVersion === 0 && length === 32) {
        return Promise.resolve({ version: 5, hashbytes: decoded.program });
      }
      if (decoded.witnessVersion === 1 && length === 32) {
        return Promise.resolve({ version: 6, hashbytes: decoded.program });
      }
      return Promise.resolve({ error: "unsupported" });
    }
    if (/^(tb1|TB1|bcrt1)/i.test(text)) return Promise.resolve({ error: "not-mainnet" });
    return decodeBase58Check(text).then(function (decoded) {
      if (!decoded) return { error: "invalid" };
      if (decoded.versionByte === 0x00) return { version: 0, hashbytes: decoded.hash };
      if (decoded.versionByte === 0x05) return { version: 1, hashbytes: decoded.hash };
      if (decoded.versionByte === 0x6f || decoded.versionByte === 0xc4) {
        return { error: "not-mainnet" };
      }
      return { error: "unsupported" };
    });
  }

  /** Re-encode so the staker can compare against what they pasted before signing. */
  function encodeMainnetPoxAddress(version, hashbytes) {
    if (version === 0 || version === 1) {
      var payload = new Uint8Array(21);
      payload[0] = version === 0 ? 0x00 : 0x05;
      payload.set(hashbytes, 1);
      return sha256(payload)
        .then(sha256)
        .then(function (digest) {
          var full = new Uint8Array(25);
          full.set(payload, 0);
          full.set(digest.slice(0, 4), 21);
          var value = 0n;
          for (var i = 0; i < full.length; i += 1) value = value * 256n + BigInt(full[i]);
          var out = "";
          while (value > 0n) {
            out = BASE58.charAt(Number(value % 58n)) + out;
            value = value / 58n;
          }
          for (var z = 0; z < full.length && full[z] === 0; z += 1) out = "1" + out;
          return out;
        });
    }
    var witnessVersion = version === 6 ? 1 : 0;
    var data = [witnessVersion].concat(convertBits(Array.from(hashbytes), 8, 5, true));
    var constant = witnessVersion === 0 ? BECH32_CONST : BECH32M_CONST;
    var polymod =
      bech32Polymod(bech32HrpExpand("bc").concat(data).concat([0, 0, 0, 0, 0, 0])) ^ constant;
    var checksum = [];
    for (var c = 0; c < 6; c += 1) checksum.push((polymod >> (5 * (5 - c))) & 31);
    var encoded = "bc1";
    var combined = data.concat(checksum);
    for (var d = 0; d < combined.length; d += 1) encoded += BECH32.charAt(combined[d]);
    return Promise.resolve(encoded);
  }

  function resolveProvider(id) {
    var target = global;
    var parts = id.split(".");
    for (var i = 0; i < parts.length; i += 1) {
      if (!target) return null;
      target = target[parts[i]];
    }
    return target && typeof target.request === "function" ? target : null;
  }

  /** PoX prepare phase, matching apps/sidekick/src/preflight.ts. */
  function isPreparePhase(pox) {
    var next = pox && pox.next_cycle;
    if (!next) return null;
    if (typeof next.blocks_until_prepare_phase !== "number") return null;
    if (typeof next.blocks_until_reward_phase !== "number") return null;
    return next.blocks_until_prepare_phase <= 0 && next.blocks_until_reward_phase > 0;
  }

  /**
   * Wallets answer over JSON-RPC. Stacks Connect unwraps the envelope before returning, so a raw
   * provider call has to do the same or a successful response reads as empty: no addresses, no
   * txid. Bare (already-unwrapped) responses are passed through, since providers differ.
   */
  function unwrapResponse(response) {
    if (!response || typeof response !== "object") return response;
    if ("error" in response && response.error) {
      var detail = response.error;
      var error = new Error(detail && detail.message ? detail.message : "wallet-error");
      error.walletError = true;
      throw error;
    }
    if ("result" in response) return response.result;
    return response;
  }

  function pickStacksAddress(response) {
    var addresses = (response && response.addresses) || [];
    var candidates = [];
    for (var i = 0; i < addresses.length; i += 1) {
      var entry = addresses[i];
      var value = typeof entry === "string" ? entry : entry && entry.address;
      if (typeof value === "string" && /^S[PM][0-9A-Z]{20,50}$/.test(value)) {
        if (candidates.indexOf(value) === -1) candidates.push(value);
      }
    }
    return candidates.length === 1 ? candidates[0] : null;
  }

  global.sidekickPoolSignup = {
    stxToUstx: stxToUstx,
    uintHex: uintHex,
    decodeMainnetPoxAddress: decodeMainnetPoxAddress,
    encodeMainnetPoxAddress: encodeMainnetPoxAddress,
    isPreparePhase: isPreparePhase,
    pickStacksAddress: pickStacksAddress,
    unwrapResponse: unwrapResponse,
    resolveProvider: resolveProvider,
    bytesToHex: bytesToHex,
    hexToBytes: hexToBytes,

    /** Splice a decoded PoX address into the server-generated consensus-payload template. */
    buildCalldataHex: function (signup, version, hashbytes) {
      var template = null;
      for (var i = 0; i < signup.calldataTemplates.length; i += 1) {
        if (signup.calldataTemplates[i].hashbytesLength === hashbytes.length) {
          template = signup.calldataTemplates[i];
        }
      }
      if (!template) return null;
      var bytes = hexToBytes(template.templateHex);
      bytes[template.versionOffset] = version;
      bytes.set(hashbytes, template.hashbytesOffset);
      return "0x" + bytesToHex(bytes);
    },

    buildFunctionArgs: function (signup, amountUstx, numCycles, burnHeight, calldataHex) {
      return [
        signup.managerArgHex,
        uintHex(amountUstx),
        uintHex(BigInt(numCycles)),
        uintHex(BigInt(burnHeight)),
        calldataHex,
      ];
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
`;
