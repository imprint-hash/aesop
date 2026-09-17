#!/usr/bin/env node
/**
 * Put collected fees back to work in the same Fables range, through KeeperHub.
 *
 *   node bin/compound.mjs [--dry]
 *
 * Sizing a v4 deposit is the part that quietly goes wrong: `liquidity` says
 * nothing about what it costs, the pool's live price decides that, and Fables
 * caps the spend at the `amount0Max` / `amount1Max` the caller states. So rather
 * than trusting arithmetic, this asks KeeperHub to dry-run the deposit and
 * shrinks it until the chain agrees. Nothing is signed until it does.
 */

import { writeFileSync } from "node:fs";
import * as F from "../src/fables.js";
import * as KH from "../src/keeperhub.js";
import { ethUsdFromTick } from "../src/policy.js";
import hookAbi from "../src/hook-abi.json" with { type: "json" };

const args = new Set(process.argv.slice(2));
const RANGE = { tickLower: -198410, tickUpper: -198200 };
const SPEND_RATIO = Number(process.env.SPEND_RATIO || 0.8); // never sweep the wallet empty

const owner = await KH.wallet();
const { tick, sqrtPriceX96 } = await F.poolPrice();
const ethUsd = ethUsdFromTick(tick);

const ethBalance = BigInt(await F.rpc("eth_getBalance", [owner, "latest"]));
const usdgBalance = BigInt(await F.balanceOfUSDG(owner));
// KeeperHub pads the gas price well above the chain's current one (a 513k limit
// at 1.12 gwei on a 0.07 gwei chain), and a payable deposit has to afford value
// PLUS that padding. The dry run does not check affordability, so the reserve is
// deliberately generous: an under-reserved compound fails at broadcast, which is
// the one failure that costs gas to discover.
const gasReserve = 900_000_000_000_000n; // 0.0009 ETH
const ethBudget = ethBalance > gasReserve ? BigInt(Math.floor(Number(ethBalance - gasReserve) * SPEND_RATIO)) : 0n;
const usdgBudget = BigInt(Math.floor(Number(usdgBalance) * SPEND_RATIO));

console.log(`wallet: ${(Number(ethBalance) / 1e18).toFixed(6)} ETH + ${(Number(usdgBalance) / 1e6).toFixed(6)} USDG`);
console.log(`budget: ${(Number(ethBudget) / 1e18).toFixed(6)} ETH + ${(Number(usdgBudget) / 1e6).toFixed(6)} USDG`);
if (ethBudget === 0n || usdgBudget === 0n) {
  console.log("nothing to compound: an in-range deposit needs both sides");
  process.exit(0);
}

/* A first guess at liquidity from the live price; the dry run corrects it. */
const Q96 = 2 ** 96;
const sqrtP = Number(sqrtPriceX96) / Q96;
const sqrtA = Math.sqrt(1.0001 ** RANGE.tickLower);
const sqrtB = Math.sqrt(1.0001 ** RANGE.tickUpper);
const fromEth = (Number(ethBudget) * (sqrtP * sqrtB)) / (sqrtB - sqrtP);
const fromUsdg = Number(usdgBudget) / (sqrtP - sqrtA);
let liquidity = BigInt(Math.floor(Math.min(fromEth, fromUsdg) * 0.97));

let plan = null;
for (let attempt = 0; attempt < 5 && liquidity > 0n; attempt++) {
  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const data = F.depositCalldata({ ...RANGE, liquidity, amount0Max: ethBudget, amount1Max: usdgBudget, deadline });
  const call = { to: F.MARKET.hook, chainId: F.CHAIN_ID, data, abi: hookAbi, value: (Number(ethBudget) / 1e18).toFixed(18) };
  const dry = await KH.dryRun(call);
  console.log(`  liquidity ${liquidity}: ${dry.ok ? `ok, ~${dry.gasEstimate} gas` : dry.reason}`);
  if (dry.ok) {
    plan = { call, liquidity, deadline };
    break;
  }
  // Fables says exactly how much it wanted: PrincipalAboveMax(needed, allowed).
  const bounds = /PrincipalAboveMax\((\d+), (\d+)\)/.exec(dry.reason || "");
  if (!bounds) break;
  liquidity = (liquidity * BigInt(bounds[2]) * 95n) / (BigInt(bounds[1]) * 100n);
}

if (!plan) {
  console.log("no size passed the dry run; nothing sent");
  process.exit(1);
}
if (args.has("--dry")) process.exit(0);

const sent = await KH.send({ ...plan.call, idempotencyKey: `fables-compound-${plan.deadline}` });
console.log(`sent: ${sent.state}  ${sent.link || sent.error || ""}`);
if (!sent.executionId) process.exit(1);
const settled = await KH.settle(sent.executionId);

const id = BigInt(await F.rangeId(RANGE.tickLower, RANGE.tickUpper));
const [after] = await F.positions(owner, [id]);
const positionUsd = (Number(after.amount0) / 1e18) * ethUsd + Number(after.amount1) / 1e6;
console.log(`settled: ${settled.status}  ${settled.transactionHash || ""}`);
console.log(`position now: $${positionUsd.toFixed(4)} (${after.shares} shares)`);

writeFileSync(
  new URL(`../proof/compound-${settled.transactionHash || sent.executionId}.json`, import.meta.url),
  JSON.stringify({ when: new Date().toISOString(), liquidity: plan.liquidity.toString(), sent, settled, positionUsd }, null, 1),
);
