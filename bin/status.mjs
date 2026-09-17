#!/usr/bin/env node
/**
 * What the autopilot can see, and what it would do right now.
 *
 *   node bin/status.mjs [address]
 *
 * Reads only. Nothing here can move money.
 */

import * as F from "../src/fables.js";
import * as KH from "../src/keeperhub.js";
import { DEFAULTS, ethUsdFromTick, shouldClaim, usdValue } from "../src/policy.js";

const RANGES = [{ tickLower: -198410, tickUpper: -198200 }];

const usd = (n) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

const owner = process.argv[2] || (await KH.wallet());
const { tick } = await F.poolPrice();
const ethUsd = ethUsdFromTick(tick);
const gasPriceWei = BigInt(await F.rpc("eth_gasPrice", []));

console.log(`Fables ${F.MARKET.name} on Robinhood Chain`);
console.log(`  wallet     ${owner}`);
console.log(`  ETH price  ${usd(ethUsd)}   gas ${(Number(gasPriceWei) / 1e9).toFixed(4)} gwei`);

const ids = [];
for (const r of RANGES) ids.push(BigInt(await F.rangeId(r.tickLower, r.tickUpper)));
const rows = await F.positions(owner, ids);

for (const row of rows) {
  const position = usdValue({ eth: row.amount0, usdg: row.amount1 }, ethUsd);
  const verdict = shouldClaim(row, { ethUsd, gasPriceWei });
  console.log(`\n  range ${row.tickLower}..${row.tickUpper}  ${row.inRange ? "earning" : "OUT OF RANGE, earning nothing"}`);
  console.log(`  position   ${usd(position)}  (${(Number(row.amount0) / 1e18).toFixed(6)} ETH + ${(Number(row.amount1) / 1e6).toFixed(2)} USDG)`);
  console.log(`  fees ready ${usd(verdict.value)}  (${(Number(row.claimable0) / 1e18).toFixed(9)} ETH + ${(Number(row.claimable1) / 1e6).toFixed(6)} USDG)`);
  console.log(`  claim fee  ${row.claimFeeBps / 100}% (limit ${DEFAULTS.maxClaimFeeBps / 100}%)   gas to claim ${usd(verdict.gasUsd)}`);
  console.log(`  verdict    ${verdict.claim ? "CLAIM" : `wait: ${verdict.reasons.join("; ")}`}`);
}

/* The weekly USDG rewards, which anyone may claim on anyone's behalf. */
const all = await F.proofs();
const addresses = Object.keys(all);
const claimed = await F.claimedAmounts(addresses);
let unclaimedTotal = 0n;
let people = 0;
for (const a of addresses) {
  const done = claimed.get(a);
  if (done === null || done === undefined) continue;
  const left = BigInt(all[a].cumulativeAmount) - done;
  if (left > 0n) {
    unclaimedTotal += left;
    people++;
  }
}
console.log(`\n  weekly rewards: ${people} providers have ${usd(Number(unclaimedTotal) / 1e6)} USDG unclaimed`);
console.log(`  (anyone may claim these for them; the contract always pays the provider)`);
