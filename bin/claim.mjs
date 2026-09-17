#!/usr/bin/env node
/**
 * Collect the fees on a Fables position, through KeeperHub.
 *
 *   node bin/claim.mjs                 # obey the policy
 *   node bin/claim.mjs --force         # claim even if the fees are worth less than the gas
 *   node bin/claim.mjs --dry           # stop after the dry run
 *
 * Fables only lets the position's owner collect, so the position has to live in
 * the KeeperHub wallet. The weekly rewards (bin/rewards.mjs) need no such thing.
 */

import { writeFileSync } from "node:fs";
import * as F from "../src/fables.js";
import * as KH from "../src/keeperhub.js";
import { DEFAULTS, ethUsdFromTick, shouldClaim } from "../src/policy.js";
import hookAbi from "../src/hook-abi.json" with { type: "json" };

const args = new Set(process.argv.slice(2));
const RANGE = { tickLower: -198410, tickUpper: -198200 };

const owner = await KH.wallet();
const { tick } = await F.poolPrice();
const ethUsd = ethUsdFromTick(tick);
const gasPriceWei = BigInt(await F.rpc("eth_gasPrice", []));

const id = BigInt(await F.rangeId(RANGE.tickLower, RANGE.tickUpper));
const [row] = await F.positions(owner, [id]);
if (!row) throw new Error("no position in that range");

const verdict = shouldClaim(row, { ethUsd, gasPriceWei });
console.log(`fees ready $${verdict.value.toFixed(4)}   gas $${verdict.gasUsd.toFixed(4)}   Fables' cut ${row.claimFeeBps / 100}%`);

if (!verdict.claim && !args.has("--force")) {
  console.log(`skipping: ${verdict.reasons.join("; ")}`);
  process.exit(0);
}
if (row.claimPaused || row.claimFeeBps > DEFAULTS.maxClaimFeeBps) {
  // Never overridable by --force: these two are about safety, not economics.
  console.log("refusing: claiming is paused, or Fables' cut is above the limit");
  process.exit(1);
}

// `maxFeeBps` is the same limit again, enforced by Fables itself: if their cut
// rises between this read and the transaction landing, the call reverts instead
// of paying it.
const data = F.claimFeesCalldata(RANGE.tickLower, RANGE.tickUpper, owner, DEFAULTS.maxClaimFeeBps);
const call = { to: F.MARKET.hook, chainId: F.CHAIN_ID, data, abi: hookAbi, value: undefined };

const dry = await KH.dryRun(call);
console.log(`dry run: ${dry.ok ? `ok, ~${dry.gasEstimate} gas` : `would fail - ${dry.reason}`}`);
if (!dry.ok) process.exit(1);
if (args.has("--dry")) process.exit(0);

// One key per range per hour: a crash-and-retry inside the hour claims once.
const hour = new Date().toISOString().slice(0, 13);
const sent = await KH.send({ ...call, idempotencyKey: `fables-claim-${id}-${hour}` });
console.log(`sent: ${sent.state}${sent.replayed ? " (replay of an earlier identical run)" : ""}  ${sent.link || sent.error || ""}`);
if (!sent.executionId) process.exit(1);

const settled = await KH.settle(sent.executionId);
console.log(`settled: ${settled.status}  ${settled.transactionHash || ""}`);

// The chain, not the response, is the last word.
const [after] = await F.positions(owner, [id]);
const paid = {
  eth: Number(row.claimable0 - after.claimable0) / 1e18,
  usdg: Number(row.claimable1 - after.claimable1) / 1e6,
};
console.log(`collected: ${paid.eth.toFixed(9)} ETH + ${paid.usdg.toFixed(6)} USDG  (left to claim: $${((Number(after.claimable0) / 1e18) * ethUsd + Number(after.claimable1) / 1e6).toFixed(4)})`);

writeFileSync(
  new URL(`../proof/claim-${settled.transactionHash || sent.executionId}.json`, import.meta.url),
  JSON.stringify({ when: new Date().toISOString(), verdict, sent, settled, paid }, (k, v) => (typeof v === "bigint" ? v.toString() : v), 1),
);
