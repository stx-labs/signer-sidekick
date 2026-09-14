import type { ClarityValue } from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import type { ChainReadOptions } from "./chain-clients.js";
import { currentInteractiveRequestSignal } from "./request-context.js";
import type { RewardStatusNode } from "./reward-status.js";

const MAX_ENTRIES = 512;
const MAX_AGE_MS = 5 * 60_000;
const MAX_CONCURRENT_READS = 8;

/** Background display reads only. The caller must freshly prove the selected anchor canonical.
 * Never wrap preparation, signing, receipt verification or unanchored live health reads. */
export class BackgroundContractReads {
  private source: RewardStatusNode | null = null;
  private tip: string | null = null;
  private createdAt = 0;
  private entries = new Map<string, Promise<ClarityValue>>();
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  clear(): void {
    this.source = null;
    this.entries = new Map();
  }

  at(node: RewardStatusNode, tip: ChainReadOptions["tip"]): RewardStatusNode {
    const now = this.now();
    if (
      this.source !== node ||
      this.tip !== tip ||
      now < this.createdAt ||
      now - this.createdAt >= MAX_AGE_MS
    ) {
      this.source = node;
      this.tip = tip;
      this.createdAt = now;
      this.entries = new Map();
    }
    const entries = this.entries;
    const read = (
      key: unknown[],
      options: ChainReadOptions | undefined,
      run: () => Promise<ClarityValue>,
    ) => {
      const signal = options?.signal ?? currentInteractiveRequestSignal();
      signal?.throwIfAborted();
      // No "latest" caching, and a wrapper cannot silently rebind a different tip.
      if (!options || options.tip !== tip) return run();
      const encoded = JSON.stringify(key);
      const retained = entries.get(encoded);
      if (retained) return retained;
      const pending = this.run(run, signal);
      if (entries.size < MAX_ENTRIES) {
        entries.set(encoded, pending);
        void pending.catch(() => {
          if (entries.get(encoded) === pending) entries.delete(encoded);
        });
      }
      return pending;
    };
    return {
      callReadOnly: (principal, name, sender, args, options) =>
        read(["call", principal, name, sender, args], options, () =>
          node.callReadOnly(principal, name, sender, args, options),
        ),
      getDataVar: (principal, name, options) =>
        read(["var", principal, name], options, () => node.getDataVar(principal, name, options)),
      getMapEntry: (principal, name, key, options) =>
        read(["map", principal, name, key], options, () =>
          node.getMapEntry(principal, name, key, options),
        ),
    };
  }

  private async run(read: () => Promise<ClarityValue>, signal?: AbortSignal) {
    if (this.active >= MAX_CONCURRENT_READS) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else this.active += 1;
    try {
      signal?.throwIfAborted();
      return await read();
    } finally {
      const next = this.waiting.shift();
      if (next)
        next(); // Transfer this slot, including when a queued caller was cancelled.
      else this.active -= 1;
    }
  }
}
