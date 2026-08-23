import { createHash } from "node:crypto";

/**
 * PoX `pox-addr` → Bitcoin address text. A staker's registered payout address reaches the
 * dashboard as the version byte and hash PoX stores; operators recognise (and copy) the encoded
 * form. Unknown versions or hash lengths that cannot encode return null rather than a guess.
 */

export type PoxAddressNetwork = "mainnet" | "testnet" | "regtest";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32M_CONSTANT = 0x2bc830a3;

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function parseHex(value: string): Uint8Array | null {
  const hex = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function base58check(prefix: number, payload: Uint8Array): string {
  const body = new Uint8Array(1 + payload.length + 4);
  body[0] = prefix;
  body.set(payload, 1);
  const checksum = sha256(sha256(body.subarray(0, 1 + payload.length))).subarray(0, 4);
  body.set(checksum, 1 + payload.length);
  let zeros = 0;
  while (zeros < body.length && body[zeros] === 0) zeros += 1;
  let value = 0n;
  for (const byte of body) value = (value << 8n) | BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    value /= 58n;
    encoded = `${BASE58_ALPHABET[remainder]}${encoded}`;
  }
  return `${"1".repeat(zeros)}${encoded}`;
}

function bech32Polymod(values: readonly number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = (((checksum & 0x1ffffff) << 5) ^ value) >>> 0;
    for (let bit = 0; bit < 5; bit += 1) {
      if ((top >>> bit) & 1) checksum = (checksum ^ (BECH32_GENERATOR[bit] ?? 0)) >>> 0;
    }
  }
  return checksum;
}

function hrpExpand(hrp: string): number[] {
  const expanded: number[] = [];
  for (const character of hrp) expanded.push(character.charCodeAt(0) >>> 5);
  expanded.push(0);
  for (const character of hrp) expanded.push(character.charCodeAt(0) & 31);
  return expanded;
}

function toFiveBitWords(bytes: Uint8Array): number[] {
  const words: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = ((accumulator << 8) | byte) & 0xffffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((accumulator >>> bits) & 31);
    }
  }
  if (bits > 0) words.push((accumulator << (5 - bits)) & 31);
  return words;
}

function bech32Encode(
  hrp: string,
  witnessVersion: number,
  program: Uint8Array,
  encoding: "bech32" | "bech32m",
): string {
  const data = [witnessVersion, ...toFiveBitWords(program)];
  const constant = encoding === "bech32" ? 1 : BECH32M_CONSTANT;
  const polymod = (bech32Polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ constant) >>> 0;
  const checksum: number[] = [];
  for (let index = 0; index < 6; index += 1) checksum.push((polymod >>> (5 * (5 - index))) & 31);
  return `${hrp}1${[...data, ...checksum].map((word) => BECH32_CHARSET[word]).join("")}`;
}

/** Sidekick network names map onto the three Bitcoin address namespaces. */
export function poxAddressNetwork(network: string): PoxAddressNetwork {
  return network === "mainnet" ? "mainnet" : network === "testnet" ? "testnet" : "regtest";
}

/**
 * Encodes a PoX address (version byte + hashbytes, both hex) for the given network. Versions
 * follow the PoX contract: 0x00 P2PKH, 0x01 P2SH, 0x02 P2SH-P2WPKH, 0x03 P2SH-P2WSH, 0x04 P2WPKH,
 * 0x05 P2WSH, 0x06 P2TR.
 */
export function poxAddressToBtcAddress(
  versionHex: string,
  hashbytesHex: string,
  network: PoxAddressNetwork,
): string | null {
  const version = parseHex(versionHex);
  const hash = parseHex(hashbytesHex);
  if (version === null || version.length !== 1 || hash === null) return null;
  const mainnet = network === "mainnet";
  const hrp = mainnet ? "bc" : network === "testnet" ? "tb" : "bcrt";
  switch (version[0]) {
    case 0x00:
      return hash.length === 20 ? base58check(mainnet ? 0x00 : 0x6f, hash) : null;
    case 0x01:
    case 0x02:
    case 0x03:
      return hash.length === 20 ? base58check(mainnet ? 0x05 : 0xc4, hash) : null;
    case 0x04:
      return hash.length === 20 ? bech32Encode(hrp, 0, hash, "bech32") : null;
    case 0x05:
      return hash.length === 32 ? bech32Encode(hrp, 0, hash, "bech32") : null;
    case 0x06:
      return hash.length === 32 ? bech32Encode(hrp, 1, hash, "bech32m") : null;
    default:
      return null;
  }
}
