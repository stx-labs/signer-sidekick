/** The PoX-5 success receipt binds the exact checkpoint without another mutable state read. */
export function calculationResultMatchesTarget(
  resultRepr: string,
  targetRewardCycle: string,
  expectedLastRewardComputeBurnHeight: number,
): boolean {
  const result = resultRepr.trim().match(/^\(ok (\(tuple .*\))\)$/s)?.[1];
  if (!result) return false;
  const cycle = result.match(/\(stx-cycle u(\d+)\)/)?.[1];
  const height = result.match(/\(calculation-height u(\d+)\)/)?.[1];
  return cycle === targetRewardCycle && height === String(expectedLastRewardComputeBurnHeight);
}
