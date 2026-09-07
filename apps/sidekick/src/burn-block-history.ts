import type { BurnBlockPage, StacksApiClient } from "./chain-clients.js";

type HistoryApi = Pick<StacksApiClient, "getBurnBlocks">;
const windowSize = 200;
const reconcileIntervalMs = 60 * 60_000;

function ordered(page: BurnBlockPage): boolean {
  return page.results.every(
    (block, index) =>
      index === 0 || block.burn_block_height < (page.results[index - 1]?.burn_block_height ?? -1),
  );
}

/** Display-only Bitcoin timing window. Never used for transaction or canonicality evidence. */
export class BurnBlockHistory {
  private cached: BurnBlockPage | null = null;
  private reconciledAt = 0;
  private pending: Promise<BurnBlockPage> | null = null;

  constructor(
    private readonly api: HistoryApi,
    private readonly now = Date.now,
  ) {}

  refresh(): Promise<BurnBlockPage> {
    this.pending ??= this.read().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async read(): Promise<BurnBlockPage> {
    const now = this.now();
    const previous = this.cached;
    if (previous && now >= this.reconciledAt && now - this.reconciledAt < reconcileIntervalMs) {
      const recent = await this.api.getBurnBlocks(30);
      const oldByHeight = new Map(
        previous.results.map((block) => [block.burn_block_height, block]),
      );
      const overlap = recent.results.filter((block) => oldByHeight.has(block.burn_block_height));
      const oldest = recent.results.at(-1)?.burn_block_height;
      const overlapMatches =
        overlap.length > 0 &&
        overlap.every(
          (block) =>
            oldByHeight.get(block.burn_block_height)?.burn_block_time === block.burn_block_time,
        );
      // Gaps in the indexed burn history are allowed, but changed/missing overlap, a rollback,
      // or a long outage triggers a full refresh instead of splicing incompatible windows.
      const expectedOverlap = previous.results.filter(
        (block) => oldest !== undefined && block.burn_block_height >= oldest,
      );
      if (
        ordered(recent) &&
        overlapMatches &&
        overlap.length === expectedOverlap.length &&
        recent.total >= previous.total &&
        (recent.results[0]?.burn_block_height ?? -1) >=
          (previous.results[0]?.burn_block_height ?? 0)
      ) {
        const results = [
          ...recent.results,
          ...previous.results.filter(
            (block) => oldest !== undefined && block.burn_block_height < oldest,
          ),
        ].slice(0, windowSize);
        if (results.length === Math.min(windowSize, recent.total)) {
          this.cached = { limit: windowSize, offset: 0, total: recent.total, results };
          return this.cached;
        }
      }
    }
    const full = await this.api.getBurnBlocks(windowSize);
    if (!ordered(full)) throw new Error("Burn-block history is not ordered by descending height");
    this.cached = full;
    this.reconciledAt = now;
    return full;
  }
}
