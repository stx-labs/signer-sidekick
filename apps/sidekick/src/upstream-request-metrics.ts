/** Process-local, bounded counters at the transport boundary: retries count as separate requests.
 * Never label credentials, query strings, contract IDs, transaction IDs, or arbitrary URL paths. */
const routes: readonly [RegExp, string][] = [
  [/\/extended\/?$/, "/extended"],
  [/\/extended\/v1\/status$/, "/extended/v1/status"],
  [/\/extended\/v2\/burn-blocks$/, "/extended/v2/burn-blocks"],
  [
    /\/extended\/v3\/staking\/signers\/[^/]+\/stakers$/,
    "/extended/v3/staking/signers/:principal/stakers",
  ],
  [/\/extended\/v2\/smart-contracts\/[^/]+\/logs$/, "/extended/v2/smart-contracts/:contract/logs"],
  [
    /\/extended\/v3\/principals\/[^/]+\/transactions$/,
    "/extended/v3/principals/:principal/transactions",
  ],
  [/\/extended\/v3\/transactions\/[^/]+\/events$/, "/extended/v3/transactions/:txid/events"],
  [/\/extended\/v3\/transactions\/[^/]+$/, "/extended/v3/transactions/:txid"],
  [/\/extended\/v1\/tx\/[^/]+$/, "/extended/v1/tx/:txid"],
  [/\/extended\/v2\/blocks\/[^/]+$/, "/extended/v2/blocks/:block"],
  [/\/extended\/v3\/mempool\/transactions$/, "/extended/v3/mempool/transactions"],
  [/\/v2\/info$/, "/v2/info"],
  [/\/v2\/pox$/, "/v2/pox"],
  [/\/v2\/accounts\/[^/]+$/, "/v2/accounts/:principal"],
  [/\/v2\/fees\/transaction$/, "/v2/fees/transaction"],
  [/\/v2\/transactions$/, "/v2/transactions"],
  [/\/v2\/transactions\/unconfirmed\/[^/]+$/, "/v2/transactions/unconfirmed/:txid"],
  [/\/v3\/transaction\/[^/]+$/, "/v3/transaction/:txid"],
  [/\/v3\/health$/, "/v3/health"],
  [/\/v3\/tenures\/info$/, "/v3/tenures/info"],
  [/\/v2\/headers\/[^/]+$/, "/v2/headers/:count"],
  [/\/v3\/blocks\/height\/[^/]+$/, "/v3/blocks/height/:height"],
  [/\/v3\/blocks\/[^/]+$/, "/v3/blocks/:id"],
  [/\/v2\/contracts\/source\/[^/]+\/[^/]+$/, "/v2/contracts/source/:address/:contract"],
  [/\/v2\/contracts\/interface\/[^/]+\/[^/]+$/, "/v2/contracts/interface/:address/:contract"],
  [
    /\/v2\/contracts\/call-read\/[^/]+\/[^/]+\/[^/]+$/,
    "/v2/contracts/call-read/:address/:contract/:function",
  ],
  [/\/v2\/data_var\/[^/]+\/[^/]+\/[^/]+$/, "/v2/data_var/:address/:contract/:variable"],
  [/\/v2\/map_entry\/[^/]+\/[^/]+\/[^/]+$/, "/v2/map_entry/:address/:contract/:map"],
  [/\/metrics$/, "/metrics"],
  [/\/heartbeat$/, "/heartbeat"],
  [/\/info$/, "/info"],
];

export class UpstreamRequestMetrics {
  private readonly counts = new Map<string, number>();

  record(url: string, method: string, status: number | null): void {
    let origin = "unknown";
    let route = "other";
    try {
      const parsed = new URL(url);
      origin = parsed.origin;
      route = routes.find(([pattern]) => pattern.test(parsed.pathname))?.[1] ?? "other";
    } catch {
      /* Instrumentation must never change request behavior. */
    }
    const verb = ["GET", "POST", "PUT", "DELETE", "HEAD"].includes(method) ? method : "other";
    const response =
      status !== null && Number.isInteger(status) && status >= 100 && status <= 599
        ? String(status)
        : "no_response";
    let labels = `{origin=${JSON.stringify(origin)},route=${JSON.stringify(route)},method=${JSON.stringify(verb)},status=${JSON.stringify(response)}}`;
    if (!this.counts.has(labels) && this.counts.size >= 512)
      labels = '{origin="other",route="other",method="other",status="other"}';
    this.counts.set(labels, (this.counts.get(labels) ?? 0) + 1);
  }

  samples(): readonly (readonly [string, number])[] {
    return [...this.counts.entries()].sort(([left], [right]) => left.localeCompare(right));
  }
}

export const upstreamRequestMetrics = new UpstreamRequestMetrics();
