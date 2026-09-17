/**
 * Fables, read from the chain and from its own published files.
 *
 * Everything here is a read. Nothing in this file can move money: the calldata
 * it builds is handed to KeeperHub (src/keeperhub.js), which is the only thing
 * that signs.
 *
 * Addresses come from Fables' own published list:
 * https://www.fables.fi/docs/contracts-and-addresses
 */

import { setDefaultResultOrder } from "node:dns";

import { address, bytes32ArrayTail, decodeUint, encode, toInt, word, wordAt } from "./abi.js";

// Both the RPC and Fables' site sit behind Cloudflare, which answers AAAA on
// networks that cannot route IPv6. Without this the first read hangs for ten
// seconds and then fails with a connect timeout.
setDefaultResultOrder("ipv4first");

export const CHAIN_ID = 4663; // Robinhood Chain
export const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b";
/** Fables' own read contract, the one their app reads positions through. */
export const LENS = "0xE44c0BAb43BdD47e7Ab40236bC183dCc77A9ED6c";
export const DISTRIBUTOR = "0xc9ecc11728a4955b31f77c077b97fec521d78760";
export const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const PROOFS_URL = "https://www.fables.fi/rewards/proofs.json";

/** The market this project runs on. ETH/USDG is one of the nine older markets whose fees need a separate claim. */
export const MARKET = {
  name: "ETH/USDG",
  hook: "0x06a889870C8f83640D6816319f72e2aA579b6080",
  currency0: "0x0000000000000000000000000000000000000000", // native ETH
  currency1: USDG,
  fee: 8388608, // 0x800000: the dynamic-fee flag. Fables sets the real fee before every swap.
  tickSpacing: 10,
  poolId: "0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551",
};

/** Selectors, each written next to the signature it came from so they can be re-derived by hand. */
const SEL = {
  claimed: "0xc884ef83", // claimed(address)
  claim: "0x3d13f874", // claim(address,uint256,bytes32[])
  claimable: "0xe8e24734", // claimable(address,uint256,bytes32[])
  root: "0xebf0c717", // root()
  balanceOf6909: "0x00fdd58e", // balanceOf(address,uint256)
  rangeId: "0xdf848a9f", // rangeId(bytes32,int24,int24)
  userPosition: "0x4eb5c4fd", // userPosition(uint256,address)
  rangeState: "0x41b69b2a", // rangeState(uint256)
  rangeGrowth: "0x936852d4", // rangeGrowth(uint256)
  effectiveClaimFee: "0xd677eaad", // effectiveClaimFee(uint256)
  claimFeeBps: "0x7a526f4e", // claimFeeBps()
  pausedUntil: "0xda748b10", // pausedUntil()
  claimFees: "0x4e8d0048", // claimFees((address,address,uint24,int24,address),int24,int24,address,uint16)
  deposit: "0x36a9ca1a", // deposit((address,address,uint24,int24,address),int24,int24,uint128,uint128,uint128,uint256)
  approve: "0x095ea7b3", // approve(address,uint256)
  erc20BalanceOf: "0x70a08231", // balanceOf(address)
  getSlot0: "0xc815641c", // getSlot0(bytes32) on the v4 StateView
  aggregate3: "0x82ad56cb", // aggregate3((address,bool,bytes)[])
  userRanges: "0xfd3caad1", // userRanges(address,address,uint256[]) on the Fables lens
};

/**
 * One row of the Fables lens's `userRanges`, by word index. Every field is a
 * value type, so a row is 28 fixed words and can be read positionally.
 */
const ROW = {
  rangeId: 0,
  keyVerified: 1,
  tickLower: 7,
  tickUpper: 8,
  shares: 9,
  staked: 10,
  claimable0: 11,
  claimable1: 12,
  effectiveClaimFeeBps: 15,
  claimPaused: 16,
  settling: 17,
  tick: 19,
  inRange: 20,
  shareOfActiveLiquidityE18: 24,
  amount0: 25,
  amount1: 26,
};
const ROW_WORDS = 27;

let rpcId = 0;

export async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

export const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);

/* ------------------------------- market reads ------------------------------- */

/** The pool key, encoded as the five words every Fables call starts with. */
const keyWords = () => [
  address(MARKET.currency0),
  address(MARKET.currency1),
  word(MARKET.fee),
  word(MARKET.tickSpacing),
  address(MARKET.hook),
];

export async function poolPrice() {
  const out = await call(STATE_VIEW, encode(SEL.getSlot0, [MARKET.poolId.slice(2)]));
  return { sqrtPriceX96: decodeUint(wordAt(out, 0)), tick: Number(toInt(wordAt(out, 1), 256)) };
}

export const rangeId = (tickLower, tickUpper) =>
  call(MARKET.hook, encode(SEL.rangeId, [MARKET.poolId.slice(2), word(tickLower), word(tickUpper)]));

/**
 * A position, read through Fables' own lens rather than re-derived here.
 *
 * The lens already answers the only questions the autopilot asks - what would a
 * claim pay, what cut would Fables take, is claiming paused, is the range still
 * earning - and it answers them the way Fables' own app sees them. Re-deriving
 * fee growth from the hook's raw accumulators would be a second, slightly
 * different implementation of Fables' accounting, and the two would disagree on
 * exactly the days that matter.
 */
export async function positions(owner, ids) {
  const args = [address(MARKET.hook), address(owner), word(96), word(ids.length), ...ids.map((id) => word(id))];
  const out = await call(LENS, encode(SEL.userRanges, args));
  const hex = out.slice(2);
  const rowsAt = Number(BigInt("0x" + hex.slice(0, 64))) * 2;
  const count = Number(BigInt("0x" + hex.slice(rowsAt, rowsAt + 64)));
  const rows = [];
  for (let i = 0; i < count; i++) {
    const base = rowsAt + 64 + i * ROW_WORDS * 64;
    const at = (index) => "0x" + hex.slice(base + index * 64, base + (index + 1) * 64);
    rows.push({
      rangeId: decodeUint(at(ROW.rangeId)),
      keyVerified: decodeUint(at(ROW.keyVerified)) === 1n,
      tickLower: Number(toInt(at(ROW.tickLower), 256)),
      tickUpper: Number(toInt(at(ROW.tickUpper), 256)),
      shares: decodeUint(at(ROW.shares)),
      claimable0: decodeUint(at(ROW.claimable0)),
      claimable1: decodeUint(at(ROW.claimable1)),
      claimFeeBps: Number(decodeUint(at(ROW.effectiveClaimFeeBps))),
      claimPaused: decodeUint(at(ROW.claimPaused)) === 1n,
      settling: decodeUint(at(ROW.settling)) === 1n,
      tick: Number(toInt(at(ROW.tick), 256)),
      inRange: decodeUint(at(ROW.inRange)) === 1n,
      amount0: decodeUint(at(ROW.amount0)),
      amount1: decodeUint(at(ROW.amount1)),
    });
  }
  return rows;
}

/* ------------------------------ reward reads ------------------------------- */

export async function proofs() {
  const res = await fetch(PROOFS_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Fables rewards file: HTTP ${res.status}`);
  return res.json();
}

/** How much each address has already pulled out of the reward contract, read in batches. */
export async function claimedAmounts(addresses, batch = 250) {
  const out = new Map();
  for (let i = 0; i < addresses.length; i += batch) {
    const slice = addresses.slice(i, i + batch);
    const calls = slice.map((a) => ({ target: DISTRIBUTOR, data: encode(SEL.claimed, [address(a)]) }));
    for (const [j, value] of (await aggregate3(calls)).entries()) {
      out.set(slice[j], value === null ? null : decodeUint(value));
    }
  }
  return out;
}

/** Multicall3, so 250 reads cost one request instead of 250. */
async function aggregate3(calls) {
  const head = word(32); // one dynamic argument, so its offset is one word
  const len = word(calls.length);
  const offsets = [];
  const bodies = [];
  let cursor = calls.length * 32;
  for (const c of calls) {
    const data = c.data.slice(2);
    const body = address(c.target) + word(1) + word(96) + word(data.length / 2) + data.padEnd(Math.ceil(data.length / 64) * 64, "0");
    offsets.push(word(cursor));
    bodies.push(body);
    cursor += body.length / 2;
  }
  const out = await call(MULTICALL, encode(SEL.aggregate3, [head, len, ...offsets, ...bodies]));
  const hex = out.slice(2);
  const results = [];
  const arrayAt = Number(BigInt("0x" + hex.slice(0, 64))) * 2;
  const count = Number(BigInt("0x" + hex.slice(arrayAt, arrayAt + 64)));
  for (let i = 0; i < count; i++) {
    const at = arrayAt + 64 + Number(BigInt("0x" + hex.slice(arrayAt + 64 + i * 64, arrayAt + 128 + i * 64))) * 2;
    const ok = BigInt("0x" + hex.slice(at, at + 64)) === 1n;
    const dataAt = at + Number(BigInt("0x" + hex.slice(at + 64, at + 128))) * 2;
    const size = Number(BigInt("0x" + hex.slice(dataAt, dataAt + 64)));
    results.push(ok ? "0x" + hex.slice(dataAt + 64, dataAt + 64 + size * 2) : null);
  }
  return results;
}

/* ------------------------------ calldata built ------------------------------ */

export const approveCalldata = (spender, amount) => encode(SEL.approve, [address(spender), word(amount)]);

export const claimFeesCalldata = (tickLower, tickUpper, to, maxFeeBps) =>
  encode(SEL.claimFees, [...keyWords(), word(tickLower), word(tickUpper), address(to), word(maxFeeBps)]);

export const depositCalldata = ({ tickLower, tickUpper, liquidity, amount0Max, amount1Max, deadline }) =>
  encode(SEL.deposit, [
    ...keyWords(),
    word(tickLower),
    word(tickUpper),
    word(liquidity),
    word(amount0Max),
    word(amount1Max),
    word(deadline),
  ]);

/** A reward claim for someone else. The contract pays the address in the proof, never the caller. */
export function rewardClaimCalldata(account, cumulativeAmount, proof) {
  const { head, tail } = bytes32ArrayTail(proof, 3);
  return encode(SEL.claim, [address(account), word(cumulativeAmount), head, tail]);
}

export const rewardClaimableCalldata = (account, cumulativeAmount, proof) => {
  const { head, tail } = bytes32ArrayTail(proof, 3);
  return encode(SEL.claimable, [address(account), word(cumulativeAmount), head, tail]);
};

export const balanceOfUSDG = (owner) => call(USDG, encode(SEL.erc20BalanceOf, [address(owner)]));
