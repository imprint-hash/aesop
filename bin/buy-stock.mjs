#!/usr/bin/env node
/**
 * Turn Fables fee income into the stock the pool trades.
 *
 *   node bin/buy-stock.mjs [--symbol NVDA] [--amount 2] [--dry]
 *
 * The fees an ETH/USDG or NVDA/USDG position earns arrive as USDG. This spends
 * them on the tokenised stock itself, through KeeperHub's Robinhood node, which
 * is the one surface that knows what a stock token is: it resolves the ticker
 * through the issuer's registry rather than a pasted address, refuses while the
 * market behind the token is halted or paused, and takes an explicit pool and a
 * minimum rather than guessing a route.
 *
 * That node is workflow-only - the execution API refuses it with "Direct
 * execution not supported" - so Aesop drives a KeeperHub workflow here instead
 * of calling a contract itself. `workflows/fees-into-stock.json` is the
 * definition; `WORKFLOW_ID` names the copy this repo runs.
 */

import { readFileSync } from "node:fs";
import { setDefaultResultOrder } from "node:dns";
import { homedir } from "node:os";
import { join } from "node:path";
import * as F from "./../src/fables.js";
import * as KH from "./../src/keeperhub.js";
import { ethUsdFromTick } from "../src/policy.js";

setDefaultResultOrder("ipv4first");

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const WORKFLOW_ID = process.env.AESOP_BUY_WORKFLOW_ID || "74q1ue8732yyuo2i5218n";
const BASE = process.env.KEEPERHUB_API_URL || "https://app.keeperhub.com";

const key = () =>
  process.env.KEEPERHUB_API_KEY?.trim() || readFileSync(join(homedir(), ".chainops", "kh_key"), "utf8").trim();

const api = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${key()}`, "content-type": "application/json", "user-agent": "aesop" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const symbol = opt("--symbol", "NVDA");
const spend = Number(opt("--amount", "2"));
const owner = await KH.wallet();

const usdg = Number(BigInt(await F.balanceOfUSDG(owner))) / 1e6;
console.log(`wallet holds ${usdg.toFixed(6)} USDG, spending ${spend.toFixed(2)} on ${symbol}`);
if (usdg < spend) {
  console.log("not enough USDG: collect fees first (npm run claim)");
  process.exit(0);
}

/* The minimum is stated in shares, so it needs a price. The pool Aesop already
   reads gives ETH in USDG; the stock price comes from the same Robinhood
   registry the node itself uses, so both sides of the trade agree. */
const quote = await fetch(`https://api.robinhood.com/rhj/prices`, { headers: { accept: "application/json" } })
  .then((r) => r.json())
  .then((d) => d.quotes.find((q) => q.tokenSymbol === symbol));
if (!quote) throw new Error(`${symbol} is not in Robinhood's registry`);

const ask = Number(quote.ask);
const expected = spend / ask;
const minOut = (expected * 0.97).toFixed(6); // 3% below the issuer's ask
console.log(`${symbol} ask $${ask} → expect ${expected.toFixed(6)} shares, refusing below ${minOut}`);

if (args.includes("--dry")) process.exit(0);

const run = await api("POST", `/api/workflows/${WORKFLOW_ID}/execute`, {
  input: { symbol, amountIn: String(spend), minAmountOut: minOut },
});
if (run.status !== 200 && run.status !== 202) {
  console.log(`workflow refused: ${run.status} ${JSON.stringify(run.body).slice(0, 200)}`);
  process.exit(1);
}
console.log(`workflow running: ${run.body.executionId}`);

/* Workflow runs are read from the workflow's own execution list; the
   /api/execute/{id}/status route only knows direct executions. */
let record = null;
for (let i = 0; i < 20; i++) {
  const list = await api("GET", `/api/workflows/${WORKFLOW_ID}/executions?limit=5`);
  record = (list.body || []).find((e) => e.id === run.body.executionId);
  if (record && record.status !== "running") break;
  await new Promise((r) => setTimeout(r, 3000));
}

if (!record) {
  console.log("no execution record yet; check the workflow in KeeperHub");
  process.exit(1);
}
const tx = (record.transactionHashes || [])[0];
console.log(`status: ${record.status}${record.error ? ` — ${record.error}` : ""}`);
if (tx) {
  console.log(`tx: https://robinhoodchain.blockscout.com/tx/${tx.hash}`);
  console.log(`KeeperHub verified the receipt itself: ${tx.receiptStatus}, block ${tx.blockNumber}`);
}
