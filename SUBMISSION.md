# Aesop — what to paste into the DoraHacks form

Hackathon: **KeeperHub, The Agent Economy** · closes **18 Sep 2026, 12:00 CEST (10:00 UTC)**
Submit at: https://dorahacks.io/hackathon/agent-economy → **Submit BUIDL**
Track: **Best Integration into a Live Project** (one BUIDL only; the feedback bounty needs its own).

---

**Name**
Aesop

**Tagline**
The fee autopilot for Fables, executed by KeeperHub.

**Source code**
https://github.com/imprint-hash/aesop

**Demo video**
(upload the file from your Desktop to YouTube as **Public**, then paste the link)

**A transaction executed through KeeperHub**
https://robinhoodchain.blockscout.com/tx/0xf4bc424fbff190e0287d4117ae7470c757ad7f3ea99f2963e0801254dbce4e0a

---

**Which project did you integrate with, and what does the integration do?**

Fables (fables.fi), a Uniswap v4 exchange for tokenised stocks on Robinhood Chain: about $23M deposited and $1.09M of trading fees in the last 30 days. On its nine older markets (NVDA, TSLA, AAPL, SPY, GLD, META, ETH/USDG and two stock pairs) liquidity providers' fees are not paid out with a withdrawal — each position has to be claimed on its own, and Fables' FAQ says plainly: "Claim-all and automatic claiming remain research topics. Fees remain claimable while you decide when gas makes a claim worthwhile."

Aesop is that decision, automated, with KeeperHub as the execution layer. It reads the position through Fables' own lens contract (fees ready, Fables' current claim fee, whether claiming is paused, whether the range is still in range), applies a written-down rule — claim only when the fees are worth at least 3× the gas, never when Fables' cut is above the caller's limit, never while paused — and then claims through KeeperHub, optionally redepositing into the same range. It also reads Fables' published Merkle file, finds every provider with unclaimed weekly USDG rewards, and can deliver those rewards to their own wallets through KeeperHub — the reward contract pays the provider named in the proof, never the caller.

**Which KeeperHub surfaces did you use?**

The execution API: `POST /api/execute/contract-call` with raw calldata, `simulate` for every write before it is sent, `Idempotency-Key` on every send, `GET /api/execute/{id}/status` to settle, `/api/user/wallet` and `/api/analytics/spend-cap`. The signing wallet is the organisation's non-custodial Turnkey wallet; no key exists in the repo or on the machine. Every run leaves a KeeperHub execution record, and the repo writes its own receipt next to it in `proof/`.

Not used: the visual workflow builder. Its `web3/write-contract` config takes `abiFunction` + `functionArgs` and cannot express Uniswap v4's `PoolKey` struct, and has no raw-calldata field — see the feedback below. The schedule therefore runs the same code through the API.

**Testnet or mainnet?**

Mainnet, Robinhood Chain (4663), with real money. Four transactions, all sent by KeeperHub:

- approve exactly 6 USDG (never unlimited): `0xc34218b704eb71b4f54b1e6a20a7a3206c5e80b4e9d5822cf165ceeca23a2156`
- deposit into ETH/USDG: `0xe6626aa06e63daaac13ae3d955441fa7d16c8cb94ec534a8305c6a7fc8869380`
- claim the fees: `0xf4bc424fbff190e0287d4117ae7470c757ad7f3ea99f2963e0801254dbce4e0a`
- redeposit them: `0x250c3151595c7d17977972e24de43272a683fd56d28c7f1f18ab7d224d7b834a`

Amounts are small on purpose ($10 of the builder's own money). The position went from $4.15 to $4.82 across one cycle.

**What still breaks or is unfinished?**

- One market is wired end to end (ETH/USDG). The other eight older markets are the same call with different ticks, untested.
- Fables has no on-chain claim-all, so several ranges means several transactions. Idempotency keys make a loop safe, but it is still N transactions.
- The claim in the video ran with the threshold lowered (`GAS_MULTIPLE=0.3`) so a $4 position could show the whole loop in one evening. The default is 3×, and the log states which rule was in force.
- Compounding needs a generous gas reserve: KeeperHub prices gas well above the chain's current rate, and `simulate` does not check affordability, so an under-reserved payable deposit dry-runs clean and then fails at broadcast. It failed that way once before the reserve was raised.
- Fables' weekly rewards can be claimed by anyone for anyone. 2,693 providers are owed $3,003, and the largest ($410.13) dry-runs fine for about half a cent of gas. Aesop finds them all and delivers them through KeeperHub for any provider who gives the go-ahead — the contract pays the provider, never the caller. Delivering to providers who have not asked is left switched off.
- Fables is young (about six weeks), unaudited, and run by an anonymous team. Its contracts are immutable and withdrawals cannot be paused, which is why a small real position was acceptable for this.

**Contact**
imprint76810@gmail.com · X: (your handle) · Discord: (your handle)

---

## Second BUIDL, for the $1,000 feedback bounty

Enter separately, titled something like **"Aesop: three KeeperHub findings from a Uniswap v4 integration"**, linking the same repo's *Feedback for KeeperHub* section:

1. The workflow builder cannot call a contract whose function takes a struct (v4's `PoolKey`), and has no raw-calldata field. The execution API's `data` handles it.
2. `simulate` does not price gas the way the broadcast does, so a payable call can pass the dry run and then fail with `insufficient funds for gas * price + value`.
3. The execution API's typed `functionArgs` rejects tuple arguments: `invalid address (argument="currency0")`.
