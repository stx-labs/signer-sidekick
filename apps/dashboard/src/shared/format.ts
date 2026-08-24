export function short(value: string | null | undefined, left = 7, right = 5): string {
  if (!value) return "—";
  return value.length <= left + right + 1
    ? value
    : `${value.slice(0, left)}…${value.slice(-right)}`;
}

export function number(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return BigInt(value).toLocaleString("en-US");
}

export function compactDuration(seconds: number): string {
  if (seconds <= 0) return "now";
  const minutes = Math.max(1, Math.round(seconds / 60));
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const remainingMinutes = minutes % 60;
  if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  if (hours > 0) return `${hours}h${remainingMinutes > 0 ? ` ${remainingMinutes}m` : ""}`;
  return `${minutes}m`;
}

export function stx(ustx: string | null | undefined): string {
  if (!ustx) return "—";
  return (Number(ustx) / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function sbtc(sats: string | null | undefined): string {
  if (sats === null || sats === undefined || !/^(0|[1-9]\d*)$/.test(sats)) return "—";
  return (Number(sats) / 100_000_000).toLocaleString("en-US", { maximumFractionDigits: 8 });
}

export function formatUstx(value: string | undefined): string {
  if (!value) return "Unavailable";
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").slice(0, 4);
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

const SATS_WORD_THRESHOLD = 100_000n;

function isSatsText(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && /^(0|[1-9]\d*)$/.test(value);
}

/**
 * Three significant figures of a BTC-denominated amount given in sats, without trailing noise.
 * `12_900_000` → "0.129", `1_287_000` → "0.0129", `100_000` → "0.001".
 */
function threeSignificantBtc(sats: bigint): string {
  const digits = sats.toString();
  const keep = 3;
  const rounded =
    digits.length <= keep
      ? sats
      : (() => {
          const scale = 10n ** BigInt(digits.length - keep);
          return ((sats + scale / 2n) / scale) * scale;
        })();
  const whole = rounded / 100_000_000n;
  const fraction = (rounded % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Reward amount rule (plan §1.3): below 100,000 sats show whole sats with the word; at or above,
 * three significant figures with the unit word. `asset` says what the amount is denominated in:
 * sBTC for anything held or moved on Stacks, BTC for payouts that went out over Bitcoin.
 */
export function amount(sats: string | null | undefined, asset: "sBTC" | "BTC" = "sBTC"): string {
  if (!isSatsText(sats)) return "—";
  const value = BigInt(sats);
  if (value < SATS_WORD_THRESHOLD) return `${value.toLocaleString("en-US")} sats`;
  return `${threeSignificantBtc(value)} ${asset}`;
}

/** The numeric part and unit separately, for tiles that style the unit. */
export function amountParts(
  sats: string | null | undefined,
  asset: "sBTC" | "BTC" = "sBTC",
): { value: string; unit: "sats" | "sBTC" | "BTC" } | null {
  if (!isSatsText(sats)) return null;
  const value = BigInt(sats);
  if (value < SATS_WORD_THRESHOLD) return { value: value.toLocaleString("en-US"), unit: "sats" };
  return { value: threeSignificantBtc(value), unit: asset };
}

/** Exact sats with thousands separators, for tooltips and exports ("1,287,000 sats"). */
export function exactSats(sats: string | null | undefined): string {
  if (!isSatsText(sats)) return "—";
  return `${BigInt(sats).toLocaleString("en-US")} sats`;
}

/** STX with two decimals from micro-STX ("12.48 STX"). */
export function stxAmount(ustx: string | null | undefined): string {
  if (!ustx || !/^(0|[1-9]\d*)$/.test(ustx)) return "—";
  const value = BigInt(ustx);
  const whole = value / 1_000_000n;
  const cents = ((value % 1_000_000n) + 5_000n) / 10_000n;
  const carry = cents >= 100n ? 1n : 0n;
  const shownCents = (cents % 100n).toString().padStart(2, "0");
  return `${(whole + carry).toLocaleString("en-US")}.${shownCents} STX`;
}

/** Fee in basis points as a percentage ("5%", "2.5%"). */
export function feePercent(bips: string | null | undefined): string {
  if (!bips || !/^(0|[1-9]\d*)$/.test(bips)) return "—";
  const value = Number(bips) / 100;
  return `${Number.isInteger(value) ? value : value.toFixed(2).replace(/0+$/, "")}%`;
}

/** Short UTC timestamp for tooltips ("Aug 22, 03:14 UTC"). */
export function shortUtc(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = date.getUTCDate();
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  return `${month} ${day}, ${hours}:${minutes} UTC`;
}
