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
  if (!sats) return "0";
  return (Number(sats) / 100_000_000).toLocaleString("en-US", { maximumFractionDigits: 8 });
}

export function formatUstx(value: string | undefined): string {
  if (!value) return "Unavailable";
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").slice(0, 4);
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}
