# Projeto 2 — Fase 1 (Cloudflare Worker + D1)

Carteira watch-only que recebe uma **xpub como credencial**, deriva os
endereços públicos, guarda o estado no **D1** e consulta saldo/histórico em
fontes públicas. **Não existe chave privada aqui**; o projeto 1 continua
offline assinando.

## O que esta fase faz

- `POST /api/wallet` com `{ "xpub": "xpub..." }`.
- Detecta o tipo da conta:
  - `zpub` → bip84/p2wpkh;
  - `ypub` → bip49/p2sh-p2wpkh;
  - `xpub` → consulta o `blockchain.info/xpub`; se houver histórico BIP44,
    usa bip44/p2pkh; se não, testa o `/0/0` de p2tr/p2wpkh/p2sh e escolhe;
    se nada tiver histórico, assume bip86/p2tr.
- Deriva os endereços no Worker (`src/derivation.js`) e guarda no D1:
  `xpub_hash`, tipo, cadeia, índice, endereço, usado, saldo, recebido, txs.
- **Próximo endereço**: convenção BIP (`/0/i` e `/1/i`), sempre o
  `último usado + 1`. Para bip44 o histórico BIP44 completo vem em uma
  consulta ao blockchain.info; para os demais, o Worker varre `/0/*` e
  `/1/*` no Blockstream/mempool até 20 endereços seguidos sem uso.
- Quando o endereço atual recebe, o próximo `POST /api/wallet` (o app
  atualiza sozinho a cada 30 s) avança o índice e devolve o novo endereço.
- Saldo:
  - tipo detectado: blockchain.info (pkh) ou Blockstream/mempool (os
    outros);
  - “outros tipos”: só o primeiro endereço (`/0/0`) de cada um, para não
    estourar o limite de subrequests do Worker;
  - o total exibido é `detectado + extras`; a **união completa dos quatro
    tipos** é a fase 2 (Electrum/nó).
- Nenhuma senha: a xpub é a credencial. O app guarda a xpub no
  `localStorage` por conveniência; o estado real fica no D1.

## Limites conhecidos (fase 1)

- O **bitcoin.com não tem API pública de saldo** (verificado: `api.bitcoin.com`
  não resolve; o explorer é interno). Por isso as fontes são
  blockchain.info (pkh) e Blockstream/mempool (demais).
- O Cloudflare Workers free tem **10 ms de CPU** e **50 subrequests** por
  invocação. Derivar/varrear muitos endereços pode exigir o plano pago
  (US$ 5/mês, 30 s de CPU e 1.000 subrequests). Para uma conta pkh (uma
  consulta ao blockchain.info + 3 extras) o free costuma bastar; para
  bip86/84/49 com muitos endereços usados, não.
- A “união independente do BIP” é **parcial**: o tipo detectado tem saldo
  completo; os outros tipos mostram só o primeiro endereço. Para a união
  completa, use um servidor Electrum via TCP no Worker (fase 2) ou um nó.
- O estado do D1 é por xpub. Quem tem a xpub acessa; não gasta. Um vazamento
  da xpub é perda de privacidade, não de fundos.
- O servidor/Cloudflare veem a xpub, os endereços e os saldos; as APIs
  públicas também. Sem nó/VPS, é o trade-off de hot wallet.

## Estrutura

```
projeto-2-cloudflare/
  wrangler.jsonc
  package.json
  schema.sql
  src/
    btc-core.js      núcleo BTC (sem DOM), extraído do projeto 2
    derivation.js    CKDpub, xpub, endereços dos 4 tipos
    worker.js        API, D1, blockchain.info/Esplora
  public/
    index.html       UI ASCII
    app.js           cliente (xpub, render, refresh 30 s)
    style.css        CSS/fonte do projeto 2
```

## Subir no Cloudflare

```bash
cd projeto-2-cloudflare
npm install
npx wrangler login

# 1. crie o D1 e copie o database_id para wrangler.jsonc
npx wrangler d1 create btc-projeto-2

# 2. crie as tabelas
npm run db:schema          # remoto
npm run db:schema:local    # para o dev local

# 3. rode local
npm run dev
# abra a URL que o wrangler mostrar

# 4. publique
npm run deploy
```

Se o `wrangler` reclamar do `compatibility_date`, ajuste para uma data
válida da sua conta (o código não usa nada recente).

## API

### `POST /api/wallet`

```json
{ "xpub": "xpub..." }
```

Resposta (resumida):

```json
{
  "detected_type": "bip44",
  "detected_label": "bip44 · legacy (p2pkh)",
  "version_type": "xpub",
  "receive": { "address": "15tKN...", "path": "m/44'/0'/0'/0/132" },
  "change":  { "address": "15LE...", "path": "m/44'/0'/0'/1/2" },
  "balance": { "detected": 12835640, "extras": 12100, "total": 12847740 },
  "extras": [ { "type": "bip86", "balance": 11100, "address": "bc1p..." } ],
  "addresses": [ { "account_type": "bip44", "chain": 0, "idx": 0, "address": "1Efg...", "used": 1, "balance": 10665 } ]
}
```

### `GET /api/health`

`{ "ok": true, ... }` — útil para o deploy.

## Segurança

- A xpub é watch-only. **Não coloque xprv aqui.** O projeto 1 permanece
  offline; o Worker e o D1 só veem endereços públicos.
- Use 2FA na conta Cloudflare; não logue a xpub; mantenha o Worker e o D1
  privados (o endpoint é público por natureza; a xpub é a credencial).
- O HTML/JS é servido pelo Cloudflare; um comprometimento do Worker poderia
  mentir no display ou trocar o PSBT. O projeto 1 confere entradas, saídas e
  taxa antes de assinar.
- Para valor alto, hardware wallet + nó/Electrum próprio; esta fase é o
  modelo de hot wallet com indexador público.

## Teste local sem Cloudflare

O Worker e a UI podem ser exercitados sem publicar:

```bash
node test/dev-server.mjs          # http://127.0.0.1:8787/
node test/cdp-ui.mjs              # opcional: Chromium headless + screenshot
node test/worker.test.mjs         # API com D1/fetch simulados
```

O fixture `test/fixtures/bci.json` é o histórico BIP44 da xpub de teste; os
testes não precisam de rede.

## Testes feitos

- Derivação em Node conferida contra endereços conhecidos:
  - xpub `xpub6CUGR...`: `bip44 /0/0 = 1Efg...`, `/0/132 = 15tKN...`,
    `/1/2 = 15LE...`; `bip86 /0/0 = bc1pq08...`; `bip84 = bc1qjh4...`;
    `bip49 = 3Jnu...`.
  - xpub `xpub6Btt...`: p2tr `/0/0 = bc1pg98...`, p2wpkh `bc1qe38...`.
- UI com o CSS do projeto 2; o cliente só fala com o Worker.

## Próxima fase

- Worker com **Electrum TCP** (Blockstream/Electrum público) para consultar
  os quatro tipos em uma conexão, sem o limite de subrequests e com SPV
  opcional; ou um nó/descritor para a união “verdadeira”.
- Trocar o adaptador de saldo sem mudar a UI/D1.
- Envio: o projeto 2 ainda só exibe; o projeto 1 assina o PSBT.
