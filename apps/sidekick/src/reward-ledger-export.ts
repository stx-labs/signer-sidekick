import { mkdtemp, open, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rewardLedgerSchema } from "@stx-labs/signer-sidekick-api-contracts";
import {
  type RewardLedgerQuery,
  rewardLedgerDistributionsCsv,
  rewardLedgerFeeRows,
  rewardLedgerFeesCsv,
  rewardLedgerPaymentsCsv,
} from "./reward-ledger.js";

/** Page to an anonymous temporary file so completeness is known BEFORE response headers.
 * JS memory is bounded by a page, and closing the handle releases the file even after a disconnect.
 */
export async function prepareRewardLedgerExport(options: {
  load: (query: RewardLedgerQuery) => Promise<unknown>;
  query: RewardLedgerQuery;
  name: "payments" | "distributions" | "fees";
  format: "csv" | "json";
  aborted?: () => boolean;
}) {
  const directory = await mkdtemp(join(tmpdir(), "sidekick-export-"));
  const path = join(directory, "export");
  const file = await open(path, "wx+", 0o600).catch(async (error: unknown) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  try {
    // Supported deployment platforms are POSIX (Linux container, macOS development).
    await unlink(path);
    await rm(directory, { recursive: true, force: true });
    let first = true;
    let anyJsonRows = false;
    let complete = true;
    let beforeCycle = options.query.beforeCycle ?? null;
    let identity: string | null = null;
    do {
      if (options.aborted?.()) throw new Error("Reward export cancelled");
      const ledger = rewardLedgerSchema.parse(
        await options.load({ ...options.query, ...(beforeCycle === null ? {} : { beforeCycle }) }),
      );
      const pageIdentity = `${ledger.network}:${ledger.managerPrincipal}:${ledger.pox5ContractId}`;
      if (identity !== null && pageIdentity !== identity)
        throw new Error("Reward export identity changed");
      identity = pageIdentity;
      complete &&=
        ledger.fees.historyComplete &&
        (options.name !== "fees" || ledger.fees.refundsTruncated !== true) &&
        !ledger.paymentsTruncated &&
        !ledger.evidenceWindow.truncated;
      if (options.format === "csv") {
        const csv =
          options.name === "payments"
            ? rewardLedgerPaymentsCsv(ledger)
            : options.name === "distributions"
              ? rewardLedgerDistributionsCsv(ledger)
              : rewardLedgerFeesCsv(ledger, first);
        const newline = csv.indexOf("\n");
        const chunk = first ? csv : newline === -1 ? "" : csv.slice(newline + 1);
        if (chunk) await file.writeFile(`${first ? "" : "\n"}${chunk}`);
      } else {
        if (first)
          await file.writeFile(
            options.name === "fees" ? `{"fees":${JSON.stringify(ledger.fees)},"rows":[` : "[",
          );
        const rows =
          options.name === "payments"
            ? ledger.payments
            : options.name === "distributions"
              ? ledger.cycles.flatMap((cycle) => cycle.distributions)
              : rewardLedgerFeeRows(ledger, first);
        if (rows.length) {
          await file.writeFile(`${anyJsonRows ? "," : ""}${JSON.stringify(rows).slice(1, -1)}`);
          anyJsonRows = true;
        }
      }
      first = false;
      const next: number | null =
        options.query.scope === "all" ? (ledger.pagination?.nextBeforeCycle ?? null) : null;
      if (next !== null && beforeCycle !== null && next >= beforeCycle)
        throw new Error("Reward export cursor did not advance");
      beforeCycle = next;
    } while (beforeCycle !== null);
    if (options.format === "json") await file.writeFile(options.name === "fees" ? "]}" : "]");
    return { complete, stream: file.createReadStream({ start: 0, autoClose: true }) };
  } catch (error) {
    await file.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
