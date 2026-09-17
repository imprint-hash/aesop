#!/usr/bin/env node
/**
 * The weekly USDG rewards, claimed for Fables' providers.
 *
 *   node bin/rewards.mjs                     # report only: who is owed what
 *   node bin/rewards.mjs --for 0xabc...      # claim for one provider
 *   node bin/rewards.mjs --top 3 --send      # claim for the three largest
 *
 * Fables' reward contract pays the address named in the proof, never the caller,
 * so this can finish other people's claims without ever touching their money.
 * That is Fables' own "claim-all", the thing their FAQ still calls a research
 * topic, done for everyone rather than one position at a time.
 */

import { writeFileSync } from "node:fs";
import * as F from "../src/fables.js";
import * as KH from "../src/keeperhub.js";
import { DEFAULTS } from "../src/policy.js";
import distributorAbi from "../src/distributor-abi.json" with { type: "json" };

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);

const all = await F.proofs();
const addresses = Object.keys(all);
const claimed = await F.claimedAmounts(addresses);

const owed = [];
for (const a of addresses) {
  const done = claimed.get(a);
  if (done === null || done === undefined) continue;
  const left = BigInt(all[a].cumulativeAmount) - done;
  if (left > 0n) owed.push({ address: a, left, cumulative: BigInt(all[a].cumulativeAmount), proof: all[a].proof });
}
owed.sort((x, y) => (y.left > x.left ? 1 : -1));

const total = owed.reduce((sum, o) => sum + o.left, 0n);
console.log(`Fables weekly rewards: ${owed.length} providers, ${(Number(total) / 1e6).toFixed(2)} USDG unclaimed`);
console.log(`worth sweeping (over $${DEFAULTS.minRewardUsd}): ${owed.filter((o) => Number(o.left) / 1e6 >= DEFAULTS.minRewardUsd).length}`);
for (const o of owed.slice(0, 5)) console.log(`  ${o.address}  ${(Number(o.left) / 1e6).toFixed(2)} USDG`);

const one = value("--for");
const top = Number(value("--top") || 0);
let targets = [];
if (one) targets = owed.filter((o) => o.address.toLowerCase() === one.toLowerCase());
else if (top) targets = owed.slice(0, top);
if (!targets.length) {
  if (one) console.log(`\n${one} has nothing unclaimed`);
  process.exit(0);
}

const receipts = [];
for (const target of targets) {
  const amount = (Number(target.left) / 1e6).toFixed(6);
  if (Number(target.left) / 1e6 < DEFAULTS.minRewardUsd) {
    console.log(`\n${target.address}: skipping, only ${amount} USDG`);
    continue;
  }
  const data = F.rewardClaimCalldata(target.address, target.cumulative, target.proof);
  const call = { to: F.DISTRIBUTOR, chainId: F.CHAIN_ID, data, abi: distributorAbi };

  const dry = await KH.dryRun(call);
  console.log(`\n${target.address}: ${amount} USDG — dry run ${dry.ok ? `ok (~${dry.gasEstimate} gas)` : `would fail: ${dry.reason}`}`);
  if (!dry.ok || !flag("--send")) continue;

  const before = BigInt(await F.balanceOfUSDG(target.address));
  // The cumulative amount is part of the key: a later week is new work, not a retry.
  const sent = await KH.send({ ...call, idempotencyKey: `fables-reward-${target.address}-${target.cumulative}` });
  console.log(`  sent: ${sent.state}  ${sent.link || sent.error || ""}`);
  if (!sent.executionId) continue;
  const settled = await KH.settle(sent.executionId);
  const after = BigInt(await F.balanceOfUSDG(target.address));
  console.log(`  settled: ${settled.status}   they received ${(Number(after - before) / 1e6).toFixed(6)} USDG`);
  receipts.push({ ...target, left: target.left.toString(), cumulative: target.cumulative.toString(), hash: settled.transactionHash, received: (after - before).toString() });
}

if (receipts.length) {
  writeFileSync(
    new URL(`../proof/rewards-${Date.now()}.json`, import.meta.url),
    JSON.stringify({ when: new Date().toISOString(), receipts }, null, 1),
  );
}
