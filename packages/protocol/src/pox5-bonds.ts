/**
 * PoX-5 protocol-bond period arithmetic.
 *
 * Bond period `i` starts at reward cycle `first-bond-period-cycle + i * BOND_GAP_CYCLES` and holds
 * per-cycle shares for `BOND_LENGTH_CYCLES` cycles from there (`add-staker-to-bond-cycles` folds
 * over exactly that span). Because the gap divides the length six times, at most six bond periods
 * can hold shares for any single reward cycle, which is also why `claim-rewards` and
 * `calculate-rewards` both take a `(list 6 uint)`.
 *
 * PoX-5 exposes no getter for `first-bond-period-cycle`; `bond-period-to-reward-cycle(u0)` returns
 * it exactly, so callers read it that way.
 */

export const BOND_LENGTH_CYCLES = 12n;
export const BOND_GAP_CYCLES = 2n;
/** `BOND_LENGTH_CYCLES / BOND_GAP_CYCLES`, and the Clarity list bound on `bond-periods`. */
export const MAX_BOND_PERIODS_PER_CYCLE = 6;

export class Pox5BondError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Pox5BondError";
  }
}

/** The first reward cycle in which bond period `bondIndex` holds shares. */
export function bondPeriodFirstRewardCycle(
  bondIndex: bigint,
  firstBondPeriodCycle: bigint,
): bigint {
  if (bondIndex < 0n) throw new Pox5BondError("bond index cannot be negative");
  if (firstBondPeriodCycle < 0n) throw new Pox5BondError("first bond cycle cannot be negative");
  return firstBondPeriodCycle + bondIndex * BOND_GAP_CYCLES;
}

/**
 * Every bond period that can hold shares for `rewardCycle`, ascending.
 *
 * This is the candidate set a manager claim must probe: PoX-5 keys bond reward buckets by the same
 * reward cycle as the STX bucket, so a claim for cycle `c` can only ever touch these indices. The
 * set is a candidate list, not an active list — a caller still has to read each bucket, because an
 * index in range may never have been set up as a bond or may hold nothing for this manager.
 */
export function bondPeriodsForRewardCycle(
  rewardCycle: bigint,
  firstBondPeriodCycle: bigint,
): bigint[] {
  if (rewardCycle < 0n) throw new Pox5BondError("reward cycle cannot be negative");
  if (firstBondPeriodCycle < 0n) throw new Pox5BondError("first bond cycle cannot be negative");
  if (rewardCycle < firstBondPeriodCycle) return [];
  // Highest index whose term has begun by `rewardCycle`. Matches the integer division PoX-5's
  // `assert-all-active-bonds-included` performs to find its own newest index.
  const latest = (rewardCycle - firstBondPeriodCycle) / BOND_GAP_CYCLES;
  const periods: bigint[] = [];
  for (let index = latest >= 5n ? latest - 5n : 0n; index <= latest; index += 1n) {
    const firstCycle = bondPeriodFirstRewardCycle(index, firstBondPeriodCycle);
    if (firstCycle <= rewardCycle && rewardCycle < firstCycle + BOND_LENGTH_CYCLES) {
      periods.push(index);
    }
  }
  if (periods.length > MAX_BOND_PERIODS_PER_CYCLE) {
    throw new Pox5BondError(
      `derived ${periods.length} bond periods for cycle ${rewardCycle}; PoX-5 allows at most ${MAX_BOND_PERIODS_PER_CYCLE}`,
    );
  }
  return periods;
}
