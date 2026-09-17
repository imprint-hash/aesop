/**
 * KeeperHub: the only thing here that signs.
 *
 * This project never holds a private key. It builds calldata for Fables and
 * hands it to KeeperHub, which signs from the organisation's own non-custodial
 * wallet, lands the transaction, and keeps the record of every run.
 *
 * The order is always the same, and it is the whole point of using KeeperHub:
 *
 *   1. dry run   - `simulate: true`, so a call that would revert costs nothing
 *   2. send      - with an Idempotency-Key, so a retry can never pay twice
 *   3. confirm   - poll the execution, then read the chain back
 *
 * Env: KEEPERHUB_API_KEY (an organisation `kh_` key).
 */

import { setDefaultResultOrder } from "node:dns";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Some networks answer AAAA for app.keeperhub.com and then refuse the connection,
// which surfaces as a 10s connect timeout rather than an error worth reading.
setDefaultResultOrder("ipv4first");

const BASE = process.env.KEEPERHUB_API_URL || "https://app.keeperhub.com";

function apiKey() {
  if (process.env.KEEPERHUB_API_KEY) return process.env.KEEPERHUB_API_KEY.trim();
  // A convenience for local runs only; CI and the demo pass the env var.
  try {
    return readFileSync(join(homedir(), ".chainops", "kh_key"), "utf8").trim();
  } catch {
    throw new Error("Set KEEPERHUB_API_KEY to an organisation key (kh_...)");
  }
}

async function request(method, path, { body, idempotencyKey } = {}) {
  const headers = {
    authorization: `Bearer ${apiKey()}`,
    "content-type": "application/json",
    "user-agent": "fables-autopilot",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

export const wallet = async () => (await request("GET", "/api/user/wallet")).body.walletAddress;

export const spendCap = async () => (await request("GET", "/api/analytics/spend-cap")).body;

/**
 * A dry run. Returns what the chain says *would* happen, without signing.
 * `wouldRevert` carries the contract's own error, which is how the autopilot
 * learns that a deposit is priced wrong before it spends anything on finding out.
 */
export async function dryRun({ to, chainId, data, abi, value }) {
  const { status, body } = await request("POST", "/api/execute/contract-call", {
    body: { contractAddress: to, chainId, data, abi: JSON.stringify(abi), value, simulate: true },
  });
  return {
    ok: status === 200 && body.success !== false,
    wouldRevert: Boolean(body.wouldRevert),
    reason: body.revertReason || body.error || null,
    gasEstimate: body.gasEstimate ? Number(body.gasEstimate) : null,
    status,
  };
}

/**
 * Send it. `idempotencyKey` must be stable for the same intended work and
 * different for genuinely new work: KeeperHub replays the original response for
 * 24 hours, so a crashed run that retries claims once, not twice.
 */
export async function send({ to, chainId, data, abi, value, idempotencyKey }) {
  const { status, body } = await request("POST", "/api/execute/contract-call", {
    body: { contractAddress: to, chainId, data, abi: JSON.stringify(abi), value },
    idempotencyKey,
  });
  return {
    accepted: status === 202 || status === 200,
    status,
    executionId: body.executionId || null,
    state: body.status || null,
    hash: body.transactionHash || null,
    link: body.transactionLink || null,
    replayed: Boolean(body.idempotentReplay),
    error: body.error || body.detail || null,
  };
}

/** The stored record of a run, which outlives the response above. */
export async function execution(executionId) {
  const { body } = await request("GET", `/api/execute/${executionId}/status`);
  return body;
}

/**
 * A broadcast is not a settlement. `send` can return `unconfirmed` while the
 * transaction is still in flight, so every write waits here before anything
 * downstream treats it as done.
 */
export async function settle(executionId, { tries = 20, waitMs = 3000 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await execution(executionId);
    if (last.status && last.status !== "pending" && last.status !== "unconfirmed") return last;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return last;
}
