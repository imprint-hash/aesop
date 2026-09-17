/**
 * When is a claim worth making?
 *
 * Fables' FAQ leaves this judgement to the user: "Fees remain claimable while
 * you decide when gas makes a claim worthwhile." That sentence is the whole
 * product, so the judgement is written down here rather than buried in a script.
 */

import { MARKET } from "./fables.js";

export const DEFAULTS = {
  /** Claim only when the fees are worth at least this many times the gas they cost. */
  gasMultiple: Number(process.env.GAS_MULTIPLE || 3),
  /** Never claim for less than this, even when gas is almost free. */
  minClaimUsd: Number(process.env.MIN_CLAIM_USD || 0.01),
  /** The largest cut of the fees the autopilot will let Fables take. Fables may raise it to 20%. */
  maxClaimFeeBps: Number(process.env.MAX_CLAIM_FEE_BPS || 100),
  /** Sweep a stranger's rewards only above this, so a claim never costs them more than it pays. */
  minRewardUsd: Number(process.env.MIN_REWARD_USD || 0.05),
};

/** The ETH price, taken from the pool the autopilot is already reading. No outside price feed. */
export const ethUsdFromTick = (tick) => 1.0001 ** tick * 1e12;

export const usdValue = ({ eth = 0n, usdg = 0n }, ethUsd) => Number(eth) / 1e18 * ethUsd + Number(usdg) / 1e6;

/**
 * The decision, with its reason. Returning the reason (rather than a bare
 * boolean) is what lets every skipped run explain itself in the log, which is
 * the difference between an autopilot people trust and one they turn off.
 */
export function shouldClaim(row, { ethUsd, gasPriceWei, gasEstimate = 260_000, policy = DEFAULTS }) {
  const value = usdValue({ eth: row.claimable0, usdg: row.claimable1 }, ethUsd);
  const gasUsd = (Number(gasPriceWei) * gasEstimate) / 1e18 * ethUsd;
  const reasons = [];
  if (row.claimPaused) reasons.push("Fables has claiming paused");
  if (row.settling) reasons.push("the ledger is mid-operation");
  if (row.claimFeeBps > policy.maxClaimFeeBps) {
    reasons.push(`Fables' claim fee is ${row.claimFeeBps / 100}%, above the ${policy.maxClaimFeeBps / 100}% limit`);
  }
  if (value < policy.minClaimUsd) reasons.push(`only $${value.toFixed(4)} to claim`);
  if (value < gasUsd * policy.gasMultiple) {
    reasons.push(`$${value.toFixed(4)} is under ${policy.gasMultiple}x the $${gasUsd.toFixed(4)} gas`);
  }
  return { claim: reasons.length === 0, value, gasUsd, reasons, market: MARKET.name };
}
