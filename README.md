<p align="left"><sub><b>EN</b> · <a href="README.pt-BR.md">PT</a></sub></p>

<p align="right"><a href="https://raelales.com/apoiar" title="Support Rael Ales and his projects"><img src=".github/assets/support-en.svg" alt="Support me — help keep Monitor BTC up to date"></a></p>

# Monitor BTC

<!-- English · [Português (Brasil)](README.pt-BR.md) -->

Watch-only Bitcoin wallet on Cloudflare Workers. The browser reads the
account **xpub** (or `zpub`/`ypub`), derives addresses and **scripthashes**
locally and queries histories/transactions through the Worker, which only acts
as an **Electrum** proxy. The browser computes balance, history, UTXOs, PSBT and
CPFP; the Worker only broadcasts the signed transaction that comes back from
the offline **Cofre BTC** signer.

Nothing is stored: no wallet data in the browser, no database in Cloudflare,
and the xpub is not sent to the Worker.

## What it is

- A **watch-only** wallet: it never sees a private key and cannot spend on its
  own.
- A **single-page interface** with three main screens: wallet, history and
  about, plus the language picker and the 404 screen. The interface is
  translated into Portuguese, English, Spanish, French,
  Italian, German, Dutch, Catalan and Galician. The automatic choice follows
  the browser; a manual choice lasts only for the session.
- A **browser PSBT builder**: amount, destination and the live fee estimate
  are enough to produce an unsigned PSBT v0 with change, without the server
  choosing coins.
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
   primary source (2-block target), refreshed every 60 seconds. The screen does not show the source host.
   There is no fee picker. The amount uses a BTC mask: digits only, with the
   decimal point moving right to left. The note below the field shows the
   maximum sendable amount for that destination and fee. A valid request
   builds the PSBT automatically; below dust (0.00000546 BTC) or above the
   maximum, the note explains why.
5. **Broadcast**: importing the signed PSBT does not publish it. The browser
   checks that every input belongs to this wallet, that the values match, and
   that all inputs are finalized. Only then the review and the **confirm**
   button appear. Only that click sends the final transaction to the proxy.

## How it works

### Browser scanner

- The **xpub** is read and derived only in the browser. The scanner walks the
  four account types and both chains (`/0` receive, `/1` change), with the same
  **50 consecutive unused addresses per branch** rule and next address
  `last used + 1`.
- The browser computes **scripthashes**, sends only them to the proxy and gets
  histories and raw transactions back. It then computes balance, history,
  UTXOs, fee, change, PSBT and CPFP locally.
- The Worker never receives the xpub or the derived address/script/pubkey
  list; it keeps no wallet state and does not choose coins. The raw
  transactions it returns contain their public scripts.

### Electrum proxy

`POST /api/proxy` accepts a batch of up to 2,500 Electrum JSON-RPC calls from
a closed allowlist: `blockchain.scripthash.get_history`,
`blockchain.scripthash.get_mempool`, `blockchain.transaction.get`,
`blockchain.estimatefee` and `blockchain.transaction.broadcast`. Parameters are
validated (64-hex scripthash/txid, transaction hex under a cap). Without a
session, the Worker opens the connection, relays the calls and closes it; with
a session, the Durable Object reuses the connection. It stores nothing.

Electrum sees the scripthashes, txids, IP and timing. The Worker sees the same
plus raw transactions and the signed transaction at broadcast; raw
transactions include their public scripts. There is no Esplora, database,
D1/KV/R2 or private key.

### Real time

The `ProxyWatcher` Durable Object keeps the reused Electrum connection for the
proxy and stores only the **scripthash** set subscribed by the screen. When Electrum notifies a change it sends
`{ "type": "scripthash", "scripthash": "..." }`; the browser re-queries the
proxy and recomputes everything. When the last screen closes, the object drops
the connection and subscriptions after a short idle period. The object holds
no xpub, addresses or scanner.

### Fee

`GET /api/fees` uses the primary Electrum connection and returns the levels,
the relay floor and `sources` in JSON (without showing the host on screen),
with a short cache so it does not reopen a connection every minute. The final
fee and PSBT are still computed in the browser. The Worker remains a data
source and can lie.

### PSBT and CPFP

- The browser selects confirmed UTXOs and its own pending change, computes
  vsize, fee, change and dust, and writes the PSBT v0.
- Every input carries `witness_utxo`, the BIP32 origin and the full previous
  transaction (`non_witness_utxo`); the Cofre requires the previous
  transaction, checks value, script, destination and fee, and refuses an
  input without it.
- CPFP is also built in the browser: it adds the parent and pending ancestors,
  computes the child fee and sends the remainder to the next change address.
- The signed file returns to the screen; input, value, finalization and fee
  checks are local. Only then is the final hex sent to the proxy for
  `blockchain.transaction.broadcast`.

## The Cofre BTC

The Cofre is a single standalone HTML file, `public/cofre-btc.html`, served
as a download at `/cofre-btc` (or `/cofre-btc.html`). It runs offline, in the
browser, without a server. The **generate** screen records 256 bits of entropy
using the method you choose; the two buttons enter `1` and `0` directly, and
rolling a die is just one suggestion (1–3 = `0`, 4–6 = `1`). The bits become a
24-word phrase and derive the four accounts; the
**key** screen also accepts the 24 words typed by hand. When a PSBT is
imported, it checks the account, the derivation, the public key, the script,
the outputs and the fee before signing. The private key never reaches the
Monitor.

Before opening it, compare the published hash: the sha256 of the published
file is `f4c557b90a27114ffcfa59f38d94fd23ab9551f392814bd8b6d1fd84cdb3d9e8` —
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
npm run dev             # build + wrangler dev, with the real Electrum configuration
npm test                # all *.test.mjs, no network
npm run build           # minify into public/dist and update the index.html SRI
npm run check:assets    # check dist and SRI without writing
npm run icons           # render the PWA icons from icon.svg (needs Chromium)
npm run sync:cofre-css  # re-inject the embedded style into the Cofre (maintainer)
npm run sync:browser-core # generate the local derivation used by the screen
```

`sync:cofre-css` reads the ascii-ui skill's `estilo.css` by default; pass a
path to use another file. It rewrites only the marked block and its hash in
`public/cofre-btc.html`, and `npm test` fails when the copy is out of sync.
`sync:browser-core` generates `public/wallet-local.js` from the `src/` modules
listed in `scripts/sync-browser-core.mjs`; after running it, run
`npm run build` to regenerate `public/dist` and the SRI. `npm test` fails on a
stale bundle or hash.

For a fully offline UI with a fake Electrum and a fixed scenario:

```bash
node test/dev-server.mjs
# http://127.0.0.1:8787/
```

The optional `test/cdp-ui.mjs` drives a headless Chromium (it expects
Chromium installed and the dev server running) and writes a screenshot to
`/tmp/cloud-ui.png`.

### Assets and performance

`npm run build` minifies `public/app.js`, `public/wallet-local.js`,
`public/style.css` and `public/fontes.css` into `public/dist/` and rewrites
the SRI in `public/index.html`. The published page points only to the `dist`
bundles; the sources in `public/` stay versioned.

The `@font-face` CSS is kept out of the critical path: `app.js` loads it
after `load`, or on the first `pointerdown`/`keydown`/`touchstart`/`wheel`,
with a 5 s fallback. The first paint uses the system monospace; when the
embedded font arrives, `font-display: swap` applies it and a `resize` redoes
the grid and history measurements. Keep Cloudflare minification and Rocket
Loader off: the SRI is computed over the `dist` bytes.

## Deploy

```bash
npx wrangler login
npm run deploy
```

`npm run deploy` runs `npm run build` before `wrangler deploy`.

The repository root is the Worker project: `wrangler.jsonc`, `src/`,
`public/`, `test/`. There is no database or schema. The production entry is
`src/worker-proxy.js`; `wrangler.jsonc` declares the `WalletWatcher` class
(implemented by `ProxyWatcher`) in migration `v1`.

For **Workers Builds**, leave the root directory empty (the repository root),
use `npm ci && npm run build` as the build command and
`npx wrangler deploy` as the deploy command (or `npm run deploy`, which runs
the build first). `routes` declares the project's custom domain, and
`workers_dev` and `preview_urls` are disabled, so the Worker responds only on
that domain. Observability is disabled to avoid keeping invocation logs in
Cloudflare.

### Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `ELECTRUM_SERVERS` | `electrum.blockstream.info:50002:tls, blockstream.info:700:tls, electrum.diynodes.com:50022:tls` | `host:port[:tls\|:tcp]` list. `off` disables Electrum and the API answers 503. |
| `ELECTRUM_TIMEOUT_MS` | `8000` | Per-request timeout in milliseconds. A non-positive or invalid value answers 503. |

The `WATCH` binding points to `WalletWatcher` (the exported `ProxyWatcher`);
migration `v1` declares it as a SQLite-backed Durable Object class, the only
backend available on the free plan. The object does not call `storage`; it
keeps only scripthashes in memory.

## API

Routes return JSON. Errors use `{ "error": "..." }`; common statuses are 400
(invalid request), 404/405 (unknown route or method), 429 (rate limit), 500
(unexpected failure), 502 (Electrum failure) and 503 (service off or
misconfigured).

| Route | Function |
| --- | --- |
| `POST /api/proxy` | Allowed Electrum JSON-RPC batch (scripthash/txid/fee/broadcast). |
| `GET /api/fees` | Estimate from the primary source, with levels and a short cache. |
| `POST /api/session` | Create the proxy/notification Durable Object id. |
| `GET /api/events?session=…` | WebSocket that returns only changed scripthashes. |
| `GET /api/health` | Effective configuration and proxy flags. |

### `POST /api/proxy`

```json
{ "items": [
  { "method": "blockchain.scripthash.get_history", "params": ["<64 hex>"] },
  { "method": "blockchain.transaction.get", "params": ["<txid>"] }
] }
```

A single item is also accepted without `items`. An optional `session` field
routes the batch through the Durable Object that holds the reused connection.
A batch accepts at most 2,500 items. The response is
`{ "results": [...], "errors": [null|"..."] }`, in request order. Allowed
methods: `blockchain.scripthash.get_history`,
`blockchain.scripthash.get_mempool`, `blockchain.transaction.get`,
`blockchain.estimatefee` and `blockchain.transaction.broadcast`. Broadcast must
be alone in the batch and requires valid hex under the size cap.

The proxy does not accept an xpub, addresses, scripts, pubkeys or wallet
routes.

### `GET /api/fees`

Returns `levels`, `targets`, `sat_per_vb`, `sat_per_kvb`, `floored`,
`relay_min_kvb`, `unit`, `sources[]` and `updated_at`. The Worker path caches
the answer for 30 seconds; `?session=…` uses the Durable Object's reused
connection. The screen uses `levels.next` and does not show the source host. An
unavailable level comes back as `null`; a failed Electrum request returns 502.

### `POST /api/session`

Returns `{ "session": "<64 hex>" }`; it is the Durable Object id that keeps
the reused proxy connection and notifications. It contains no wallet.

### `GET /api/events?session=…`

WebSocket upgrade. The client sends
`{ "type": "subscribe", "scripthashes": ["<64 hex>", ...] }` with up to 2,500
scripthashes; the object subscribes on Electrum and answers
`{ "type": "subscribed", "count": n }`. Each change then arrives as
`{ "type": "scripthash", "scripthash": "..." }`, and a failure as
`{ "type": "error", "error": "..." }`. There is no wallet payload, xpub,
addresses or values.

### `GET /api/health`

Returns `{ "ok": true, "service": "monitor-btc-proxy", "source": "electrum",
"storage": "nenhum", "realtime": true, "electrum": [...], "time": "..." }`.

## Security

- The xpub is watch-only. **Never paste an `xprv`/`yprv`/`zprv`.** A leaked
  xpub costs privacy, not funds.
- The xpub lives only in the tab's memory. The Worker receives
  **scripthashes**, txids, raw transactions and the signed transaction at
  broadcast; never the extended key or the derived address/pubkey list. Raw
  transactions contain their public scripts. It does not log that data, put
  it in a URL or keep a database.
- **The screen code also comes from the Worker.** A compromised Worker can
  serve altered `index.html`/`app.js` and capture the xpub before any local
  derivation; SRI and CSP do not help when the page itself is replaced.
  Local derivation protects against a server that receives requests, not
  against a server that controls the delivered code. That guarantee would
  require a client downloaded and verified outside the Worker.
- The session id is a proxy/notification capability: whoever holds it while
  the screen is open can query scripthashes/txids and subscribe to changes,
  not read balance, addresses or PSBT. It is random and disappears when the
  last screen closes.
- The Monitor never sees a private key. The PSBT leaves unsigned and the Cofre
  BTC performs the authoritative check before signing.
- The send PSBT and the CPFP child are built in the browser from the raw
  transactions; the Worker does not choose coins or change. The Worker
  still supplies the raw transactions and the estimate, and can omit data or
  lie; the local sum is checked against the balance and the Cofre checks the
  PSBT before signing.
- The broadcast summary is computed in the browser: it checks wallet inputs,
  values, destinations and fee, but the network validates the signatures. The
  Cofre check before signing is the one that matters.
- All responses carry HSTS, CSP, `X-Frame-Options`, `X-Content-Type-Options`,
  `Referrer-Policy`, `Permissions-Policy`, COOP, COEP and CORP. The static
  `public/_headers` and `SECURITY_HEADERS` in `src/config.js` keep those nine
  values identical; a test enforces it.
- The `public/dist/app.min.js`, `wallet-local.min.js` and `style.min.css`
  bundles use SRI in `public/index.html`; `dist/fontes.min.css` is loaded by
  `app.js` after load and carries the hash injected at build time. Run
  `npm run build` after editing `app.js`, `style.css` or `fontes.css` (or after
  running `sync:browser-core`); `npm test` fails on a stale bundle or hash.
  Keep Cloudflare minification and Rocket Loader off for the same reason.

## Tests

```bash
npm test
```

The suite runs without network, using a fake Electrum server and the project's
own BTC core. The `worker`, `watcher`, `watch-mode`, `broadcast`, `cpfp`,
`psbt` and `hardening` tests use the old fixtures in `test/legacy/`;
production is covered by `proxy.test.mjs`, `proxy-watcher.test.mjs` and
`browser-core.test.mjs`.

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
| `watch-mode.test.mjs` | Local scanner, 50-address gap, raw transactions and PSBT; legacy routes under test. |
| `proxy.test.mjs` | Proxy: allowed batch, broadcast, fees and no wallet routes. |
| `proxy-watcher.test.mjs` | New Durable Object: scripthashes only, no wallet. |
| `browser-core.test.mjs` | `wallet-local.js` up to date and derivation/PSBT/CPFP parity with the server. |
| `assets-build.test.mjs` | `public/dist` and the `index.html` SRI up to date with the sources. |
| `hardening.test.mjs` | Input caps, abuse brake and WebSocket Origin. |
| `security-headers.test.mjs` | Header parity, CSP, bundle SRI and the Cofre hash in both READMEs. |
| `http-surface.test.mjs` | 404 status for unknown paths and the read-only asset surface. |
| `well-known-manifest.test.mjs` | ARD/ai-catalog manifests, `rel="ard"` and the `.well-known` route. |
| `cofre-core.test.mjs` / `cofre-core-parity.test.mjs` | The embedded Cofre core and its parity with `src/btc-core.js`. |

## Structure

```text
.github/assets/          support buttons used by this README
.github/workflows/       CI and Cofre release automation
public/
  app.js                 browser client (bundle source)
  wallet-local.js        generated browser derivation, UTXOs and PSBT (bundle source)
  apple-touch-icon.png   iOS home-screen icon
  cofre-btc.html         standalone offline key generator and PSBT signer
  fontes.css             embedded @font-face (loaded after load)
  index.html             published page
  llms.txt               guidance for language models
  manifest.webmanifest   installable PWA metadata
  icon.svg               icon source (round seal the PNGs are rendered from)
  icon-*.png             app icons
  LICENCAS-FONTES.txt    font license (Liberation Mono)
  og-image.png           link preview image
  robots.txt             crawler rules (the API is blocked)
  style.css              interface styles (bundle source)
  _headers               security headers for static assets
  dist/
    app.min.js           minified app.js (SRI)
    wallet-local.min.js  minified wallet-local.js (SRI)
    style.min.css        minified style.css (SRI)
    fontes.min.css       minified @font-face (loaded after load)
  .well-known/
    ard.json             ARD manifest (empty agent catalog)
    ai-catalog.json      previous name, same manifest
scripts/
  build-assets.mjs       minifies into public/dist and updates the index.html SRI
  build-icons.mjs        renders the PWA icons from icon.svg
  sync-cofre-core.mjs    extracts the Cofre core for parity tests
  sync-cofre-css.mjs     reinjects the skill's style.css into the Cofre
  sync-browser-core.mjs  generates public/wallet-local.js from the core
src/
  btc-core.js            BTC core (keys, addresses, tx, PSBT, signing helpers)
  derivation.js          CKDpub, xpub parsing and the four address types
  electrum.js            Electrum JSON-RPC client over cloudflare:sockets
  address-totals.js      UTXO accounting per script
  psbt.js                coin selection, fee, change and send PSBT (source of the local bundle)
  broadcast.js           signed PSBT checks and broadcast
  wallet-sync.js         local scanner: derivation, gap, balance, PSBT and CPFP
  worker-proxy.js        production: Electrum proxy + session + fees + assets
  proxy-watcher.js       production: scripthash-only Durable Object
  proxy-rpc.js           shared proxy batch validation and execution
  config.js              environment, security headers and helpers
test/
  *.test.mjs             automated tests
  legacy/                old worker/watcher fixtures, tests only
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
- **Subscriptions cover used scripthashes and the gap tail**, not the whole
  wallet. A payment beyond the tail only appears in a new scan.
- **No 24/7 watch.** Closing the page ends the session; there is no monitoring
  or notification with the screen closed.
- **Change reserved per downloaded PSBT.** An undownloaded preview returns
  the address; only the downloaded file keeps the reservation. Up to 50
  pending downloaded PSBTs use different addresses; on the 51st, the oldest
  is reused so the gap does not grow beyond the 50-address limit. The
  reservation lives only in memory: after reloading the page, a pending PSBT
  and a new one may reuse the address. This is a privacy limitation, not a
  balance one.
- **PSBT is a snapshot.** There is no coin reservation. If another wallet
  spends an input before signing/broadcasting, the network refuses the
  transaction and a new PSBT is needed.
- **Fallback polling.** Without a working WebSocket, the screen reloads every
  30 seconds; each reload starts a new full scan.
- **Fee estimator.** `estimatefee` is historical: it may be above or below the
  current queue. The screen uses the primary source and a short cache; there is
  no histogram or economic floor; only the relay floor is shown as a warning.
- **Abuse brake.** A per-IP token bucket refills at 120 requests per minute
  and 20,000 proxy items per minute. The bucket lives in the isolate's memory
  and is not a global quota: it contains bursts per instance. A batch is capped
  at 2,500 items, and a large scan batch may be refused with 429; the screen
  retries after `Retry-After`.
- **Electrum sees the queried scripthashes** (TLS hides them from the network
  path, not from the server). The Cofre remains the authoritative signer.
- **The Worker sees scripthashes, txids, raw transactions and the signed
  transaction at broadcast**; raw transactions contain their public scripts.
  It does not receive the xpub or the derived address/pubkey list. A
  compromised Worker can still lie about data, fee or censor; the
  Cofre check is the final defense before signing.
- **Data availability.** The browser checks UTXOs from the raw transactions
  returned by the Worker, but has no node of its own: a Worker that omits a
  transaction can make the local balance fail to reconcile; the screen then
  refuses the PSBT. A Worker that omits a spend and adjusts the balance can
  still induce an invalid PSBT, which the network rejects.
- **Mainnet only.** The project works with Bitcoin mainnet keys and addresses.
- **No RBF.** The browser uses final sequence values, so the summary reports
  `rbf: false`; the acceleration path is CPFP.

## Support

If this project helps you, you can support the work: https://raelales.com/apoiar
