<p align="left"><sub><b>EN</b> · <a href="README.pt-BR.md">PT</a></sub></p>

<p align="right"><a href="https://raelales.com/apoiar" title="Support Rael Ales and his projects"><img src=".github/assets/support-en.svg" alt="Support me — help keep Monitor BTC up to date"></a></p>

# Monitor BTC

<!-- English · [Português (Brasil)](README.pt-BR.md) -->

Watch-only Bitcoin wallet on Cloudflare Workers. The browser reads the
account **xpub** (or `zpub`/`ypub`), derives the addresses locally and sends
the Worker only the address/scripthash set; the Worker reads the balance, the
receive addresses and the transaction history from an **Electrum** server. It
can also build an unsigned PSBT and broadcast the signed transaction that
comes back from the offline **Cofre BTC** signer.

Nothing is stored: no wallet data in the browser, no database in Cloudflare,
and the xpub is not sent to the Worker.

## What it is

- A **watch-only** wallet: it never sees a private key and cannot spend on its
  own.
- A **single-page interface** with three screens: wallet, history and about.
  The interface is translated into Portuguese, English, Spanish, French,
  Italian, German, Dutch, Catalan and Galician. The automatic choice follows
  the browser; a manual choice lasts only for the session.
- A **PSBT builder**: amount, destination and the live fee estimate are enough
  to produce an unsigned PSBT v0 with change.
- A **history viewer**: transactions grouped by `txid`, from the mempool to
  the most recent block, with direction, values, fee and the wallet addresses
  involved. A pending transaction can be accelerated with CPFP.
- A **broadcast gate**: the signed PSBT is checked against the wallet before
  anything reaches the network. Publishing only happens after the explicit
  confirmation.

It is not a full node, not a custody wallet, and it does not keep a
background watch with the page closed.

## What the screen shows

1. **Available balance** below the xpub field, in BTC, with the time of the
   last update. It includes confirmed unspent outputs plus the change of your
   own pending transaction, because that change is spendable before
   confirmation. Third-party payments still in the mempool do not count until
   they confirm. The `pending +…/-…` line shows what is outside that number.
2. **One receive address per type**, all four, including the zeroed ones:
   the first unused index of each branch (`last used + 1`), so the payer can
   choose the address format. The label is only the BIP (`bip86`, `bip84`,
   `bip49`, `bip44`), and the address has a copy button.
3. **History grouped by transaction**, newest first, with `[ pending ]` or
   `[ confirmed ]`, direction (sent, received or self), input/output counts,
   values, fee and the wallet addresses involved; the list is paginated, with
   the page size fitted to the visible area. A pending transaction that still
   has an unspent wallet output gets the **accelerate** button, which builds
   an unsigned CPFP child PSBT.
4. **Send BTC**: amount, destination and the fee calculated live from the
   Bitcoin Core `estimatefee` (2-block target), refreshed every 60 seconds.
   There is no fee picker. The amount uses a BTC mask: digits only, with the
   decimal point moving right to left. The note below the field shows the
   maximum sendable amount for that destination and fee. A valid request
   builds the PSBT automatically; below dust (0.00000546 BTC) or above the
   maximum, the note explains why.
5. **Broadcast**: importing the signed PSBT does not publish it. The server
   checks that every input belongs to this wallet, that the values match, and
   that all inputs are finalized. Only then the review and the **confirm**
   button appear. Only that click sends the final transaction to Electrum.

## How it works

### Address discovery

- The accepted key is an extended **public account key** (`xpub`, `zpub` or
  `ypub`, depth 3). Addresses, private keys (`xprv`/`yprv`/`zprv`) and loose
  text are rejected before any lookup.
- `zpub` maps to BIP84 and `ypub` to BIP49. A plain `xpub` scans all four
  account types and marks the first one with history, in the order BIP44,
  BIP86, BIP84, BIP49.
- The scan walks both chains (`/0/i` receive, `/1/i` change) of the four
  types, **in the browser**. Each branch stops after **50 consecutive unused
  addresses**. The next address is always `last used + 1`.
- The screen derives the 50-address tail of each branch and sends the set to
  the Worker; the response says how many addresses are missing to close the
  gap. The screen derives that tail and repeats, without the Worker ever
  seeing the xpub. If the abuse brake answers **429**, the screen waits for
  `Retry-After` and repeats the same step.

### Balance

- The Worker downloads the raw transactions of the used addresses, parses
  them locally and sums outputs that pay the wallet minus outputs already
  spent.
- `total` is the **available** balance: confirmed unspent outputs plus the
  change of your own pending transaction. A third-party payment in the
  mempool appears as `pending_in` and only counts after confirmation.
  `pending_out` is what already left the wallet in a pending transaction
  (destination plus fee), net of the change that comes back.

### Electrum as the only source

`src/electrum.js` speaks the Electrum JSON-RPC protocol over
`cloudflare:sockets`. Derivation happens in the browser; the Worker receives
the derived addresses and queries by `scripthash`
(`blockchain.scripthash.get_history`, `blockchain.scripthash.get_mempool`,
`blockchain.transaction.get`), doing the UTXO accounting itself. There is no
Esplora, no blockchain.info and no private key anywhere.

A one-off query opens a connection and closes it at the end. During a live
session the connection is reused, with pipelining and a per-request timeout.
If the server fails in the middle, the response is an explicit 502; there is
no fallback to another source. `GET /api/health` shows the effective
configuration.

### Real time (Durable Object)

- One Durable Object per screen session, not per xpub. The Worker creates a
  random 256-bit session id and returns it from `POST /api/wallet`.
- The object holds the Electrum connection and the
  `blockchain.scripthash.subscribe` subscriptions for the used addresses plus
  the 50-address tail of each branch. When the server notifies a change, it
  re-queries only that scripthash and pushes the new payload over WebSocket.
- When the last screen closes, the object drops everything: socket,
  subscriptions, addresses, transaction cache, last payload and the observed
  set. There is no xpub in the object, no alarm and no storage to restore.
- Session loss returns **409**; the screen re-derives locally and reopens the
  channel. If the session is evicted or the Worker is redeployed, the next
  request rebuilds the query.

### Fees and PSBT

- The only fee source is `blockchain.estimatefee` with a **2-block target**
  (Bitcoin Core refuses to estimate 1 block). The value comes in BTC/kvB and
  is converted to exact sat/kvB; only the final fee in satoshis is rounded up.
- The PSBT builder selects confirmed outputs first, then your own pending
  change. It tries the smallest single input that covers the amount, then the
  smallest pair, then the largest inputs. The result favors fewer inputs, no
  change when the remainder would be dust, the smallest leftover, the cheapest
  input type, older confirmations and a stable derivation order.
- Dust is **546 sats**. When the remainder would be dust, no change output is
  created and the remainder goes to the fee; the response separates
  `fee_sats_at_rate` from `dust_sats`.
- Every input carries `witness_utxo`, the BIP32 origin and the full previous
  transaction (`non_witness_utxo`) so the offline signer can check the value.
  Taproot inputs use `tap_bip32_derivation`; p2sh-p2wpkh inputs carry the
  `redeem_script`. The fingerprint is the account fingerprint, which is all a
  watch-only xpub can know.
- The estimated vsize is an upper bound of the signed transaction, so the paid
  fee never falls below the requested rate. The trade-off is at most about
  1 vB of extra fee.

### CPFP

For a pending transaction whose inputs all belong to this wallet and that
still has an unspent wallet output, `POST /api/cpfp` builds the child PSBT.
The server sums the fee and vsize of the parent and any pending ancestors,
calculates the child fee needed to reach the requested package rate and sends
the remainder to the next change address. The parent does not change. Sign the
child in the Cofre BTC and import it in **wallet → broadcast**, like a normal
send.

### Broadcast

`POST /api/broadcast` receives the signed PSBT (base64 or hex) and checks:

- every input spends a script derived from this xpub;
- when the output is a known UTXO, the declared value matches the wallet;
- every input is finalized in the format required by its script type;
- outputs are classified as change, own receive or external, and the fee and
  vsize come from the final transaction, not from the estimate.

With `preview: true` it only checks and returns the summary. Without preview,
the final hex goes to `blockchain.transaction.broadcast`. Warnings cover zero
or very low fees, very high fees, dust outputs, more than one external output
and inputs the session has not seen. A broadcast cannot be undone.

## The Cofre BTC

The Cofre is a single standalone HTML file, `public/cofre-btc.html`, served
as a download at `/cofre-btc` (or `/cofre-btc.html`). It runs offline, in the
browser, without a server. The **generate** screen records 256 bits of entropy
using the method you choose; tossing a coin is just one suggestion (heads = 1,
tails = 0). The bits become a 24-word phrase and derive the four accounts; the
**key** screen also accepts the 24 words typed by hand. When a PSBT is
imported, it checks the account, the derivation, the public key, the script,
the outputs and the fee before signing. The private key never reaches the
Monitor.

Before opening it, compare the published hash: the sha256 of the published
file is `0557763a22376e72f629648c40a1a4ec3481e69c2c9823a87d7d6059aee5f6aa` —
run `sha256sum cofre-btc.html` on the downloaded file; the release asset
always has this fixed name. The Cofre's about
screen asks for the same check. Any edit to the Cofre requires updating this
value; `npm test` fails when the hash is out of date.

The “key” screen has an optional **secret phrase** field: it goes into the
BIP39 PBKDF2 after the 24 words, does not change the phrase, and changes the
seed, the accounts and the addresses. Editing or clearing the field reruns
the derivation; empty, it is the empty passphrase. Whoever loses the secret
phrase loses the wallet it defines.

## Requirements

- Node.js **22 or newer** and npm.
- A Cloudflare account for the Worker, the assets and the Durable Object.
- Access to Electrum servers over TLS. The default list is
  `electrum.blockstream.info:50002`, `blockstream.info:700` and
  `electrum.diynodes.com:50022`.
- A modern browser for the interface and the Cofre. The Cofre works offline.

## Development

```bash
npm install
npm run dev             # wrangler dev, with the real Electrum configuration
npm test                # all *.test.mjs, no network
npm run icons           # render the PWA icons from icon.svg (needs Chromium)
npm run sync:cofre-css  # re-inject the embedded style into the Cofre (maintainer)
npm run sync:browser-core # generate the local derivation used by the screen (SRI)
```

`sync:cofre-css` reads the ascii-ui skill's `estilo.css` by default; pass a
path to use another file. It rewrites only the marked block and its hash in
`public/cofre-btc.html`, and `npm test` fails when the copy is out of sync.

For a fully offline UI with a fake Electrum and a fixed scenario:

```bash
node test/dev-server.mjs
# http://127.0.0.1:8787/
```

The optional `test/cdp-ui.mjs` drives a headless Chromium (it expects
Chromium installed and the dev server running) and writes a screenshot to
`/tmp/cloud-ui.png`.

## Deploy

```bash
npx wrangler login
npm run deploy
```

The repository root is the Worker project: `wrangler.jsonc`, `src/`,
`public/`, `test/`. There is no database or schema; the only migration is the
Durable Object class declaration `v1` in `wrangler.jsonc`.

For **Workers Builds**, leave the root directory empty (the repository root),
use `npm ci` as the build command and `npx wrangler deploy` as the deploy
command. `routes` declares the project's custom domain, and
`workers_dev` and `preview_urls` are disabled, so the Worker responds only on
that domain. Observability is disabled to avoid keeping invocation logs in
Cloudflare.

### Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `ELECTRUM_SERVERS` | `electrum.blockstream.info:50002:tls, blockstream.info:700:tls, electrum.diynodes.com:50022:tls` | `host:port[:tls\|:tcp]` list. `off` disables Electrum and the API answers 503. |
| `ELECTRUM_TIMEOUT_MS` | `8000` | Per-request timeout in milliseconds. A non-positive or invalid value answers 503. |

The binding `WATCH` points to `WalletWatcher`; migration `v1` declares it as a
SQLite-backed Durable Object class, which is the only backend available on the
free plan. The object does not call `storage`.

## API

API routes answer JSON (the events route upgrades to WebSocket). Errors use
`{ "error": "..." }`; the common statuses are 400 (invalid request), 404/405
(unknown route or method), 409 (lost session), 429 (rate limit), 500
(unexpected failure), 502 (Electrum failure) and 503 (Electrum
disabled/misconfigured).

| Route | Purpose |
| --- | --- |
| `POST /api/wallet` | Wallet state: balance, the four account types, used addresses and transactions. |
| `POST /api/psbt` | Build the unsigned send PSBT; with `preview`, return limits/quote only. |
| `POST /api/cpfp` | Build the unsigned CPFP child PSBT for a pending transaction. |
| `POST /api/broadcast` | Check a signed PSBT; with `preview`, do not publish. |
| `GET /api/fees` | Live 2-block fee estimate. |
| `GET /api/events?session=…` | WebSocket upgrade for live updates. |
| `GET /api/health` | Effective Electrum configuration and service flags. |

### `POST /api/wallet`

```json
{ "watch": [{ "account_type": "bip84", "chain": 0, "idx": 0,
  "address": "bc1...", "path": "m/84'/0'/0'/0/0",
  "script": "0014...", "pub": "02..." }],
  "wallet_id": "64 hex chars", "fingerprint": "8 hex chars",
  "version_type": "xpub", "session": "optional" }
```

The body carries the addresses already derived by the browser; the xpub is not
part of the request. `wallet_id` is the random wallet identity for that
session and `fingerprint` is the account fingerprint used in the PSBT BIP32
origin. The Worker queries the scripthashes, closes the **50-unused-address
gap per branch** and returns `watch_status`:

- `watch_status.gap`: always 50;
- `watch_status.complete`: the gap is closed;
- `watch_status.branches["bip84:0"]`: `last_used`, `max_idx`, `next` and
  `need`. If `need > 0`, the screen derives `next .. next + need - 1` and
  repeats.

After the first step, the screen may send only `session` to the send routes;
the Durable Object keeps the set while the session exists. If the session is
lost (**409**), the screen re-derives and calls `POST /api/wallet` again.

The final payload contains `detected_type`, `balance`, `types`, `addresses`,
`transactions`, `warnings`, `updated_at` and `watch_status`. `types` always has
the four entries in BIP86, BIP84, BIP49, BIP44 order; `addresses` contains only
used addresses; `transactions` has one entry per `txid` with fee, direction,
addresses and CPFP eligibility; `session` is the random Durable Object id.

The route still accepts the old `xpub` body for compatibility, but the screen
does not send it. The documented and tested flow is `watch`.

### `POST /api/psbt`

```json
{ "session": "optional", "address": "bc1...",
  "amount_sats": 50000, "fee_rate": 6 }
```

Without a session (dev without the Durable Object), send `watch`,
`wallet_id`, `fingerprint` and `version_type` instead of `session`.
`amount_sats` is an integer; `fee_rate` is in sat/vB and accepts the
estimator's decimals (from 0.001 to 10000). Values below 546 sats are refused
as dust. The response carries the base64 `psbt`, `txid`, `vsize`, `fee_sats`,
`fee_sats_at_rate`, `dust_sats`, `fee_rate`, `total_in`, `total_out`,
`amount_sats`, `recipient`, `change` and `inputs`/`outputs` with their BIP32
paths and `own` classification.

With `preview: true` and no `amount_sats`, it returns the send limit:
`available_sats`, `min_sats`, `max_send_sats`, `fee_sats_at_max` and
`vsize_at_max`. With `amount_sats`, it also returns the fee and change for that
amount. `quote_rates` adds a `quotes` array with the cost of each requested
rate for the same amount.

### `POST /api/cpfp`

```json
{ "session": "optional", "txid": "...", "fee_rate": 11 }
```

The txid must be a pending transaction with all inputs from this wallet and a
checkable parent fee. The body accepts the same `watch` as `/api/wallet` when
there is no session. The response includes the child `psbt`, `txid`, `vsize`,
`fee_sats`, `parent`, `package`, `input` and `output`. The child has no
external destination; the remainder returns to the next change address.

### `POST /api/broadcast`

```json
{ "session": "optional", "psbt": "cHNidP8...", "preview": true }
```

The PSBT must be v0 and signed by the Cofre. Without a session, send the same
`watch`. The response summarizes the final transaction (`txid`, real `vsize`,
`fee_sats`, `fee_rate`, `total_in`, `total_out`, `inputs`, `outputs`,
`warnings`, `rbf`, `locktime`). Without `preview`, it also returns
`broadcast: true` and `server_txid`; the final hex never goes back to the
browser.

### `GET /api/fees?session=…`

Returns the live estimate with `levels.next`, `targets.next`,
`sat_per_kvb`, `sat_per_vb`, `floored`, `relay_min_kvb`, `unit`, `source` and
`updated_at`. A server without an estimate returns `null` for that level. The
relay floor (`0.1 sat/vB` since Bitcoin Core v30) is only a warning; the
estimated value is used as-is.

### `GET /api/events?session=…`

WebSocket upgrade. Messages are `{ "type": "payload", ... }`,
`{ "type": "progress", ... }` while the scan is running, or
`{ "type": "error", ... }` when Electrum fails. A session without a wallet
answers 409.

### `GET /api/health`

Returns `{ "ok": true, "service": "monitor-btc-electrum", "source":
"electrum", "storage": "nenhum", "realtime": true, "electrum": [...],
"time": "..." }`.

## Security

- The xpub is watch-only. **Never paste an `xprv`/`yprv`/`zprv`.** A leaked
  xpub costs privacy, not funds.
- The xpub lives only in the tab's memory. The Worker receives the derived
  address set (used addresses plus the 50-address tail), never the extended
  key; it does not log the set, does not put it in a URL and has no database.
  A compromised Worker still sees those addresses, the UTXOs and the queried
  history, but cannot derive future addresses outside the sent gap.
- **The screen code also comes from the Worker.** A compromised Worker can
  serve altered `index.html`/`app.js` and capture the xpub before any local
  derivation; SRI and CSP do not help when the page itself is replaced.
  Local derivation protects against a server that receives requests, not
  against a server that controls the delivered code. That guarantee would
  require a client downloaded and verified outside the Worker.
- The session id is a temporary capability. Whoever holds it while the screen
  is open can read that wallet's state; it is random and disappears when the
  last screen closes.
- The Monitor never sees a private key. The PSBT leaves unsigned and the Cofre
  BTC performs the authoritative check before signing.
- The broadcast summary is structural: it checks ownership, values and
  destinations, but the network validates the signatures. The Cofre check
  before signing is the one that matters.
- All responses carry HSTS, CSP, `X-Frame-Options`, `X-Content-Type-Options`,
  `Referrer-Policy`, `Permissions-Policy`, COOP, COEP and CORP. The static
  `public/_headers` and `SECURITY_HEADERS` in `src/config.js` keep those nine
  values identical; a test enforces it.
- `wallet-local.js`, `app.js`, `fontes.css` and `style.css` use SRI. Any edit requires updating
  the hash in `public/index.html`, and `npm test` fails on a stale hash. Keep
  Cloudflare minification and Rocket Loader off for the same reason.

## Tests

```bash
npm test
```

The suite runs without network, using a fake Electrum server and the project's
own BTC core:

| File | Covers |
| --- | --- |
| `electrum.test.mjs` | Protocol, pipelining, timeouts and errors. |
| `worker.test.mjs` | End-to-end wallet: balance, gap, step scan, validation and rate limits. |
| `address-totals.test.mjs` | Confirmed, own pending change and third-party mempool accounting. |
| `psbt.test.mjs` | Fee, coin selection, change, dust, BIP32 origins and PSBT signing. |
| `coin-selection.test.mjs` | Selection rule over randomized wallets. |
| `cpfp.test.mjs` | History grouped by txid, child PSBT and package fee. |
| `cofre-ui.test.mjs` | Cofre screens, the nine i18n columns and the embedded CSS hash. |
| `broadcast.test.mjs` | Signed PSBT checks and broadcast, including the Durable Object path. |
| `watcher.test.mjs` | Subscriptions, notifications, reconnect, eviction and total discard. |
| `watch-mode.test.mjs` | Local derivation, 50-address gap, PSBT and Durable Object without xpub. |
| `browser-core.test.mjs` | `wallet-local.js` up to date and derivation parity with the server. |
| `hardening.test.mjs` | Input caps, abuse brake and WebSocket Origin. |
| `security-headers.test.mjs` | Header parity, CSP, SRI hashes and the Cofre hash in this README. |
| `http-surface.test.mjs` | 404 status for unknown paths and the read-only asset surface. |
| `well-known-manifest.test.mjs` | ARD/ai-catalog manifests, `rel="ard"` and the `.well-known` route. |
| `cofre-core.test.mjs` / `cofre-core-parity.test.mjs` | The embedded Cofre core and its parity with `src/btc-core.js`. |

## Structure

```text
.github/assets/          support buttons used by this README
.github/workflows/       CI and Cofre release automation
public/
  app.js                 browser client (local derivation, render, WebSocket)
  wallet-local.js        generated browser derivation (SRI)
  apple-touch-icon.png   iOS home-screen icon
  cofre-btc.html         standalone offline key generator and PSBT signer
  fontes.css             embedded font
  index.html             published page
  llms.txt               guidance for language models
  manifest.webmanifest   installable PWA metadata
  icon.svg               icon source (round seal the PNGs are rendered from)
  icon-*.png             app icons
  LICENCAS-FONTES.txt    font license (Liberation Mono)
  og-image.png           link preview image
  robots.txt             crawler rules (the API is blocked)
  style.css              interface styles
  _headers               security headers for static assets
  .well-known/
    ard.json             ARD manifest (empty agent catalog)
    ai-catalog.json      previous name, same manifest
scripts/
  build-icons.mjs        renders the PWA icons from icon.svg
  sync-cofre-core.mjs    extracts the Cofre core for parity tests
  sync-cofre-css.mjs     reinjects the skill's style.css into the Cofre
  sync-browser-core.mjs  generates public/wallet-local.js from the core
src/
  btc-core.js            BTC core (keys, addresses, tx, PSBT, signing helpers)
  derivation.js          CKDpub, xpub parsing and the four address types
  electrum.js            Electrum JSON-RPC client over cloudflare:sockets
  address-totals.js      UTXO accounting per script
  psbt.js                coin selection, fee, change and send PSBT
  broadcast.js           signed PSBT checks and broadcast
  wallet-sync.js         local-set query, gap and wallet payload
  watch-set.js           validation of client-derived addresses
  watcher.js             Durable Object: socket, subscriptions, WebSocket
  config.js              environment, security headers and helpers
  worker.js              routes
test/
  *.test.mjs             automated tests
  fake-electrum.mjs      fake Electrum server with notifications
  tx-fixture.mjs         raw transactions built with the BTC core
  dev-server.mjs         offline UI server with a fixed scenario
  cdp-ui.mjs             optional headless Chromium check
wrangler.jsonc
package.json
```

## Known limitations

- **Full scan on every opening.** Without durable storage, each new session
  scans the gap of 50 again and downloads the used transactions. While the
  session is alive, later queries and notifications reuse memory.
- **Browser CPU.** Opening the screen derives about 400 addresses (8 branches
  × 50) locally and is CPU-heavy on the tab; the Worker only queries the
  scripthashes. The Durable Object only stays awake while a screen is open.
- **Gap limit.** Addresses after 50 consecutive unused ones are invisible; an
  interrupted scan shows "incomplete search" instead of a final balance.
- **Subscriptions cover used addresses and the gap tail**, not the whole
  wallet. A payment beyond the tail only appears in a new scan.
- **No 24/7 watch.** Closing the page ends the session; there is no monitoring
  or notification with the screen closed.
- **Change reuse.** The next change address only advances when the transaction
  is seen in the mempool, so two PSBTs built before the first broadcast use
  the same change address. This is a privacy limitation, not a balance one.
- **PSBT is a snapshot.** There is no coin reservation. If another wallet
  spends an input before signing/broadcasting, the network refuses the
  transaction and a new PSBT is needed.
- **Fallback polling.** Without a working WebSocket, the screen reloads every
  30 seconds; each reload starts a new full scan.
- **Fee estimator.** `estimatefee` is historical: it may be above or below the
  current queue. There is no histogram, median or economic floor; only the
  relay floor is shown as a warning.
- **Abuse brake.** 120 requests per minute per IP outside the scan and 600
  scan steps per minute per IP, with at most 6 simultaneous scans. The scan
  has its own budget; when it answers 429, the screen waits for
  `Retry-After` and resumes the same step, so even a very large wallet can
  finish while the sustained rate stays limited. The counter lives in the
  isolate's memory and is not a global quota: it contains bursts per Worker
  instance.
- **Electrum sees the queried scripthashes** (TLS hides them from the network
  path, not from the server). The Cofre remains the authoritative signer.
- **The Worker sees the sent set**: used addresses plus the 50-address tail of
  each branch, the UTXOs, the txids and the PSBT. The xpub stays in the
  browser, but a compromised Worker can still lie about balance, fee or
  censor; the Cofre check is the final defense before signing.
- **Mainnet only.** The project works with Bitcoin mainnet keys and addresses.
- **No RBF.** The builder uses final sequence values, so the summary reports
  `rbf: false`; the acceleration path is CPFP.

## Support

If this project helps you, you can support the work: https://raelales.com/apoiar
