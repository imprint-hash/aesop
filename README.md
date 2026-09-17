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
| `node bin/rewards.mjs` | Finds every provider with unclaimed weekly USDG rewards, and can claim for anyone who opts in |

Every write goes the same way: **dry run → send with an idempotency key → wait for settlement → read the chain back**.

## Proof it runs, on mainnet

All on Robinhood Chain (chain 4663), sent through KeeperHub's execution API from the organisation's own non-custodial wallet, `0x7643c07eeeF6A02c3D712cdA8A42CE817409781F`.

| What | Transaction |
|---|---|
| Approve exactly 6 USDG to Fables (never unlimited) | [`0xc342…2156`](https://robinhoodchain.blockscout.com/tx/0xc34218b704eb71b4f54b1e6a20a7a3206c5e80b4e9d5822cf165ceeca23a2156) |
| Deposit into the ETH/USDG market | [`0xe662…9380`](https://robinhoodchain.blockscout.com/tx/0xe6626aa06e63daaac13ae3d955441fa7d16c8cb94ec534a8305c6a7fc8869380) |
| **Collect the fees** (0.000002578 ETH + 0.011718 USDG, chain then read back at zero) | [`0xf4bc…4e0a`](https://robinhoodchain.blockscout.com/tx/0xf4bc424fbff190e0287d4117ae7470c757ad7f3ea99f2963e0801254dbce4e0a) |
| **Reinvest**, position $4.15 → $4.82 | [`0x250c…834a`](https://robinhoodchain.blockscout.com/tx/0x250c3151595c7d17977972e24de43272a683fd56d28c7f1f18ab7d224d7b834a) |

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

## The weekly rewards, and a deliberate limit

Fables also pays weekly USDG rewards through a Merkle distributor, published at `fables.fi/rewards/proofs.json`. **Anyone may submit anyone's claim** — the contract pays the address named in the proof, never the caller.

Read from the chain today:

```
Fables weekly rewards: 2693 providers, 3003.67 USDG unclaimed
worth sweeping (over $0.05): 1180
  0xf4c3b5f85773b16c9e1460cc45fd71d0b302aabc  410.13 USDG
```

That $410 claim dry-runs successfully for about half a cent of gas. **We do not send it.** Moving someone's money without being asked is not a feature, even when the money can only ever land in their own wallet. `bin/rewards.mjs` reports and dry-runs for everyone, and sends only for an address that opts in.

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

## What is unfinished

- **One market.** The autopilot runs on ETH/USDG. The other eight older markets need only their ticks added, but they are not wired up yet.
- **Fables' claim-all does not exist on chain,** so "claim everything" is still one transaction per range. Batching them would need a multicall Fables does not expose.
- **Compounding is two transactions** (claim, then deposit), because Fables has no "claim and redeposit" path.
- **KeeperHub's visual workflow builder is not used.** Its `web3/write-contract` config cannot express Fables' pool-key tuple argument, and it has no field for raw calldata, so the schedule runs the same code through KeeperHub's execution API instead. Reported to KeeperHub as feedback.
- **Compounding needs a healthy gas reserve.** KeeperHub prices gas well above the chain's current rate, and a payable deposit must afford value plus that padding; the dry run does not check affordability, so an under-reserved compound fails at broadcast. Reported to KeeperHub as feedback; `bin/compound.mjs` now reserves 0.0009 ETH.
- **Amounts are small on purpose.** This is real money on mainnet, not a testnet screenshot.

## Licence

[MIT](LICENSE)
