# Aesop

**The fee autopilot for [Fables](https://www.fables.fi), executed by [KeeperHub](https://keeperhub.com).**

**Fables' own FAQ:** *"Claim-all and automatic claiming remain research topics."*

This is that, built on KeeperHub.

[Fables](https://www.fables.fi) is a Uniswap v4 exchange for tokenised stocks on Robinhood Chain: about **$23M deposited** and **$1.09M of trading fees in the last 30 days**. People who provide liquidity earn those fees — but on the nine older markets (NVDA, TSLA, AAPL, SPY, GLD, META, ETH/USDG and two stock pairs) the fees are **not** paid out with a withdrawal. Each position has to be claimed on its own, and the provider has to judge for themselves when the fees are worth the gas.

Fables builds the transactions. It never sends them. **KeeperHub sends them.**

## What it does

| Command | What happens |
|---|---|
| `node bin/status.mjs` | Reads the position through Fables' own lens contract: fees ready, Fables' current cut, whether claiming is paused, whether the range is still earning — then states what it would do, and why |
| `node bin/claim.mjs` | Collects the fees into your own wallet, but only when they are worth at least 3× the gas. **This is the default: claim and keep.** |
| `node bin/compound.mjs` | Optional. Puts idle wallet balance (the collected fees included) back into the same range |
| `node bin/rewards.mjs` | Finds every provider with unclaimed weekly USDG rewards, and delivers them, to their own wallet, for any provider who says go |
| `node bin/buy-stock.mjs` | Spends the collected USDG on the tokenised stock itself, through KeeperHub's Robinhood node |

Every write goes the same way: **dry run → send with an idempotency key → wait for settlement → read the chain back**.

## Proof it runs, on mainnet

All on Robinhood Chain (chain 4663), sent through KeeperHub's execution API from the organisation's own non-custodial wallet, `0x7643c07eeeF6A02c3D712cdA8A42CE817409781F`.

| What | Transaction |
|---|---|
| Approve exactly 6 USDG to Fables (never unlimited) | [`0xc342…2156`](https://robinhoodchain.blockscout.com/tx/0xc34218b704eb71b4f54b1e6a20a7a3206c5e80b4e9d5822cf165ceeca23a2156) |
| Deposit into the ETH/USDG market | [`0xe662…9380`](https://robinhoodchain.blockscout.com/tx/0xe6626aa06e63daaac13ae3d955441fa7d16c8cb94ec534a8305c6a7fc8869380) |
| **Collect the fees** (0.000002578 ETH + 0.011718 USDG, chain then read back at zero) | [`0xf4bc…4e0a`](https://robinhoodchain.blockscout.com/tx/0xf4bc424fbff190e0287d4117ae7470c757ad7f3ea99f2963e0801254dbce4e0a) |
| **Reinvest**, position $4.15 → $4.82 | [`0x250c…834a`](https://robinhoodchain.blockscout.com/tx/0x250c3151595c7d17977972e24de43272a683fd56d28c7f1f18ab7d224d7b834a) |
| Approve exactly 3 USDG to Permit2, then the router | [`0x0716…9fd9`](https://robinhoodchain.blockscout.com/tx/0x0716941bf1f2cef18a0cfd61dac7930901b43b9c0a9939c05f2faf51c8f39fd9) · [`0x364c…258c`](https://robinhoodchain.blockscout.com/tx/0x364c7ca6ea8cfbfea67b2c385a74f196d7834fb561dd3aa24859e997e4d2258c) |
| **Fee money into stock**: 2 USDG → 0.00909 NVDA, through KeeperHub's Robinhood node | [`0x3e9f…3305`](https://robinhoodchain.blockscout.com/tx/0x3e9fdfd7014f48c481d355f10782be837320b96e58e4909ce47619e4e05c3305) |
| The same buy, run by the **five-step KeeperHub workflow** (5/5 steps, receipt verified by KeeperHub) | [`0xeff3…fb6e`](https://robinhoodchain.blockscout.com/tx/0xeff3c11bbae83daf63f88f250bfd921d8141793f6f390ec263b9a9a021d7fb6e) |

The claim ran with the threshold lowered on purpose (`GAS_MULTIPLE=0.3`), so the whole loop could be shown on a $4 position within one evening. The default is 3×, and the log says which rule was in force.

Receipts for every run are written to `proof/`.

## The decision, written down

Fables leaves the judgement to the provider, so the autopilot writes it down instead of hiding it (`src/policy.js`):

- **Claim only when the fees are worth ≥ 3× the gas.** Fees keep accruing; gas does not come back.
- **Never claim when Fables' cut is above 1%.** Fables may raise it to 20% (`MAX_CLAIM_FEE_BPS` in their contract is 2000). The same limit is passed to Fables as `maxFeeBps`, so if the cut rises between the check and the transaction landing, **Fables itself reverts the claim** rather than taking it.
- **Never claim while claiming is paused, or while the ledger is mid-operation.**
- **Approve exact amounts.** Fables' own agent-facing tooling asks for unlimited allowances; this never does.

A skipped run always says why:

```
fees ready $0.0177   gas $0.0371   Fables' cut 0%
skipping: $0.0177 is under 3x the $0.0371 gas
```

## Why KeeperHub, specifically

- **The dry run stops mistakes before they cost money.** The first deposit attempt was priced wrong; KeeperHub's simulation returned Fables' own `PrincipalAboveMax(691032378611649, 593639999999977)` and nothing was sent. `bin/compound.mjs` now reads that error and resizes itself until the chain agrees.
- **The idempotency key means a retry cannot claim twice.** The key is stable per range per hour, and per address per reward week.
- **A broadcast is not a settlement.** Every write polls `GET /api/execute/{id}/status` and then re-reads the position on chain before reporting what was collected.
- **No key on this machine.** The wallet is KeeperHub's non-custodial Turnkey wallet; this repo builds calldata and nothing else.

## Fees, into the stock they came from

The fees an ETH/USDG or NVDA/USDG position earns arrive as USDG. `bin/buy-stock.mjs` spends them on the tokenised stock itself through **KeeperHub's Robinhood node**, the one surface that knows a stock token is not an ordinary ERC-20: it resolves `NVDA` through the issuer's registry rather than a pasted address, refuses while the market behind the token is halted or paused, and takes an explicit pool and a minimum in shares rather than guessing a route.

That node is workflow-only — the execution API answers `Direct execution not supported for "robinhood/get-stock-price"` — so Aesop drives a KeeperHub **workflow** for this step and reads the result back from the workflow's own execution record, which carries KeeperHub's own receipt verification.

The workflow (`workflows/fees-into-stock.json`) is the guard, not just the trade:

```
Every hour  →  Fables: what is the claim fee right now?
            →  Robinhood: is the market behind NVDA open?
            →  Condition: tradeable == true
            →  Robinhood: buy NVDA with USDG
```

It refuses loudly rather than half-sending. The run before this one stopped at the trade with
`0x5fc5…d168 is not approved to Permit2` — five steps ran, nothing was spent, and the reason
named the fix.

```
status: success   tx 0x3e9f…3305
KeeperHub verified the receipt itself: success, block 65755691
```

## The weekly rewards

Fables also pays weekly USDG rewards through a Merkle distributor, published at `fables.fi/rewards/proofs.json`. **Anyone may submit anyone's claim** — the contract pays the address named in the proof, never the caller.

Read from the chain today:

```
Fables weekly rewards: 2693 providers, 3003.67 USDG unclaimed
worth sweeping (over $0.05): 1180
  0xf4c3b5f85773b16c9e1460cc45fd71d0b302aabc  410.13 USDG
```

That $410 claim dry-runs successfully for about half a cent of gas. Aesop finds every one of them and, once a provider gives the go-ahead, delivers their rewards to their own wallet through KeeperHub — they never have to open the app, and the money can only ever land with them. `bin/rewards.mjs --for <address> --send` does exactly that.

## Run it

```bash
export KEEPERHUB_API_KEY=kh_...      # an organisation key
npm run status                       # read-only
npm run claim -- --dry               # dry run only
```

The npm scripts set `--dns-result-order=ipv4first`: both the RPC and Fables sit behind Cloudflare, which answers AAAA on networks that cannot route IPv6, and the failure looks like a ten-second hang rather than a DNS problem.

Node 20+. No dependencies: the ABI encoding this needs is 60 lines in `src/abi.js`, and every selector is written next to the signature it came from.

| File | What it is |
|---|---|
| `src/fables.js` | Fables, read from the chain and from its published files. Builds calldata; signs nothing |
| `src/keeperhub.js` | The only thing that signs: dry run, send, settle |
| `src/policy.js` | When a claim is worth making |
| `bin/` | The four commands above |

## Scope, and why

- **One market, wired end to end.** Aesop runs on ETH/USDG. The other eight older markets are the same call with different ticks; proving the loop on one market with real money was worth more than listing nine untested ones.
- **One transaction per range.** Fables has no on-chain claim-all, so claiming several ranges is several transactions. Batching would need a multicall Fables does not expose. KeeperHub's idempotency keys make running them in a loop safe.
- **Claim and keep is the default.** `bin/claim.mjs` sends fees to the owner's own wallet. Reinvesting is a separate command, because a provider who wants their fees in hand should not have to opt out of anything.

## Feedback for KeeperHub

Three things this integration hit, each with a reproduction in this repo:

1. **The workflow builder cannot call Fables.** `web3/write-contract` config takes `abiFunction` + `functionArgs`, which cannot express a struct argument such as Uniswap v4's `PoolKey`, and the node has no raw-calldata field. The execution API's `data` parameter handles it, so the capability exists one layer down. The Fables steps therefore run through the API, while the Robinhood step runs as a workflow.
2. **`simulate` does not check affordability.** A payable deposit dry-ran clean and then failed at broadcast with `insufficient funds for gas * price + value`, because the broadcast prices gas well above the chain's current rate (a 513k limit at 1.12 gwei on a 0.07 gwei chain). A simulation that priced gas the way the broadcast does would have caught it.
3. **Typed `functionArgs` rejects tuples on the execution API too.** `deposit((address,address,uint24,int24,address),…)` returns `invalid address (argument="currency0")` when the tuple is passed as an array. Raw `data` works.
4. **Plugin actions are workflow-only, and the two surfaces disagree about where a run lives.** `POST /api/execute/robinhood/trade-stock-token` refuses with "Direct execution not supported", which is clear enough; but a workflow run's id is then *not* readable from `GET /api/execute/{id}/status` ("Execution not found") — it only appears in `GET /api/workflows/{id}/executions`. One id, two lookup paths, and the error does not say which one to use.
5. **`web3Connection` is rejected on plugin action config.** The workflows API documents it as the sender-routing field, but `robinhood/trade-stock-token` returns `UNKNOWN_FIELD` for it.

## Licence

[MIT](LICENSE)
