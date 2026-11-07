# Projeto 2 — Cloudflare Worker + D1 + Electrum

Carteira watch-only que recebe uma **xpub como credencial**, deriva os
endereços públicos, guarda o estado no **D1** e consulta saldo/histórico em
fontes públicas: **Electrum** (TCP/TLS, por scripthash) quando disponível e
**blockchain.info/Esplora** como fallback. **Não existe chave privada aqui**;
o projeto 1 continua offline assinando.

> **Layout do repositório.** A raiz é o projeto do Worker (é ela que o
> Cloudflare publica): `wrangler.jsonc`, `src/`, `public/`, `test/`,
> `schema.sql`. Os arquivos soltos na mesma raiz não entram no deploy:
> `chave-btc.html` é o projeto 1 (offline, assina PSBT), `projeto-2.html` é a
> UI standalone (consulta blockchain.info/Esplora direto no navegador, sem
> Worker/D1/Electrum) e `teste-*.psbt` são fixtures de teste. A página
> publicada é `public/index.html`.

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
  - com Electrum: **uma conexão TCP/TLS**, consulta por scripthash
    (`get_balance` + `get_history`) em lote, sem limite de subrequests;
  - tipo detectado: blockchain.info (pkh) ou Blockstream/mempool (os
    outros);
  - sem Electrum, “outros tipos”: só o primeiro endereço (`/0/0`) de cada
    um, para não estourar o limite de subrequests do Worker; com Electrum,
    a **união dos quatro tipos é completa** (varredura com gap nos dois
    ramos de cada tipo), controlada por `EXTRAS_UNION`;
  - o total exibido é `detectado + extras`.
- Nenhuma senha: a xpub é a credencial. O app guarda a xpub no
  `localStorage` por conveniência; o estado real fica no D1.

## Limites conhecidos

- O **bitcoin.com não tem API pública de saldo** (verificado: `api.bitcoin.com`
  não resolve; o explorer é interno). Por isso as fontes são Electrum,
  blockchain.info (pkh) e Blockstream/mempool (demais).
- O Cloudflare Workers free tem **10 ms de CPU** e **50 subrequests** por
  invocação. O Electrum resolve os subrequests (uma conexão só), mas não a
  CPU: a união dos quatro tipos deriva ~200 endereços por consulta, o que
  **não cabe nos 10 ms**. Na prática: plano pago (US$ 5/mês, 30 s de CPU) ou
  `EXTRAS_UNION=off`. Medido no `wrangler dev`: ~4,5 s de parede e ~360
  consultas Electrum para a xpub de teste (o tempo é rede, não CPU).
- `received` (total recebido por endereço) vem do Esplora; no caminho
  Electrum ele é preenchido com o saldo atual, porque o protocolo não
  devolve o total recebido sem baixar cada transação.
- O estado do D1 é por xpub. Quem tem a xpub acessa; não gasta. Um vazamento
  da xpub é perda de privacidade, não de fundos.
- O servidor/Cloudflare veem a xpub, os endereços e os saldos; o servidor
  Electrum público vê os scripthashes consultados. Com TLS (50002) o
  caminho da rede não vê; com texto puro (50001, último recurso) vê. Sem
  nó/VPS, é o trade-off de hot wallet.

## Estrutura

```
wrangler.jsonc
package.json
schema.sql
src/
  btc-core.js      núcleo BTC (sem DOM), extraído do projeto 2
  derivation.js    CKDpub, xpub, endereços dos 4 tipos
  electrum.js      cliente Electrum (JSON-RPC 1.4) sobre cloudflare:sockets
  worker.js        API, D1, Electrum + blockchain.info/Esplora
public/
  index.html       UI ASCII (página publicada)
  app.js           cliente (xpub, render, refresh 30 s)
  style.css        CSS/fonte do projeto 2
test/
  electrum.test.mjs     cliente Electrum contra um servidor falso
  worker.test.mjs       API com D1/fetch simulados + cenário Electrum
  fake-electrum.mjs     servidor Electrum falso (TCP em 127.0.0.1)
```

## Electrum

`src/electrum.js` fala o protocolo Electrum (JSON-RPC 1.4, uma linha por
mensagem) usando `connect()` de `cloudflare:sockets`, com `secureTransport:
"on"` no 50002. O transporte é injetável (`setConnectOverride`) para os
testes rodarem em Node.

- A consulta é por **scripthash** = sha256 do scriptPubKey com os bytes
  invertidos; o Worker já deriva o script de cada endereço, então não precisa
  de decodificador de endereço.
- Uma conexão só, com pipelining (janela de 20 requisições) e timeout por
  requisição.
- Se o Electrum cair no meio da consulta, o Worker marca a falha, avisa no
  campo `warnings` e continua pelo Esplora; a resposta não quebra.

Variáveis (`wrangler.jsonc` → `vars`, ou pelo dashboard):

| variável | padrão | efeito |
| --- | --- | --- |
| `ELECTRUM_SERVERS` | `electrum.blockstream.info:50002:tls,electrum.blockstream.info:50001:tcp` | lista `host:porta[:tls\|:tcp]`; `off` desliga o Electrum |
| `ELECTRUM_TIMEOUT_MS` | `8000` | timeout por requisição |
| `EXTRAS_UNION` | `on` | `off` volta a consultar só o `/0/0` dos outros tipos |

`GET /api/health` mostra a configuração efetiva de Electrum.

## Subir no Cloudflare

```bash
npm install
npx wrangler login

# 1. crie o D1 e copie o database_id para wrangler.jsonc
npx wrangler d1 create btc-xpub

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

### Deploy pelo GitHub (Workers Builds)

O `wrangler.jsonc` é a fonte da configuração, então dois pontos importam:

1. **`database_id` precisa ser o real.** Crie o D1 (`npx wrangler d1 create
   btc-xpub`), copie o UUID e ponha em `database_id` no `wrangler.jsonc`;
   com o placeholder o deploy falha com `must have a valid database_id`.
2. **Aplique o schema uma vez** contra o D1 remoto (`npm run db:schema`); o
   build do GitHub não roda migração sozinho (dá para acrescentar
   `npx wrangler d1 execute btc-xpub --file=./schema.sql --remote` no
   comando de deploy, mas isso re-executa em todo build — o `schema.sql` usa
   `IF NOT EXISTS`, então é seguro).

No painel do Workers Builds: conecte o repositório, deixe **Root directory**
na raiz (vazio ou `/`), build command `npm ci` e deploy command
`npx wrangler deploy`. As variáveis do `vars` do `wrangler.jsonc` já vão no
bundle; para segredos, use o dashboard.

#### Erros de build já resolvidos pelo layout atual

Antes, o Worker vivia em `projeto-2-cloudflare/` e o build rodava na raiz do
repo: o `wrangler deploy` não achava o `wrangler.jsonc` e falhava com
`Could not detect a directory containing static files (e.g. html, css and js)`;
com Root directory apontando para a raiz, o `npm ci` também falhava (não há
`package.json` na raiz). Hoje o `wrangler.jsonc` e o `package-lock.json` estão
na raiz, então os dois erros somem — a única configuração necessária é não
apontar Root directory para uma subpasta.

O deploy do Worker exige o `database_id` real do D1 no `wrangler.jsonc`
(hoje `btc-xpub` → `7c26213e-28f3-41d8-946c-742ec63b4c2f`). Um id que não
existe faz o deploy falhar com `binding DB of type d1 must have a valid
database_id` (código 10021).

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
  "balance": { "detected": 12835640, "extras": 26536, "total": 12862176 },
  "extras": [ { "type": "bip86", "balance": 11100, "address": "bc1p..." } ],
  "addresses": [ { "account_type": "bip44", "chain": 0, "idx": 0, "address": "1Efg...", "used": 1, "balance": 10665 } ],
  "source": "electrum (scripthash) + blockchain.info (bip44)",
  "warnings": [ "..." ]
}
```

`source` diz quais fontes responderam nesta consulta; `warnings` avisa quando
o Electrum falhou e o saldo veio do Esplora.

### `GET /api/health`

`{ "ok": true, "service": "projeto-2-fase-2", "electrum": [...], "union": true }`
— útil para o deploy.

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
npm test                          # electrum + worker (sem rede)
node test/electrum.test.mjs      # cliente Electrum contra servidor falso
node test/worker.test.mjs        # API com D1/fetch simulados + cenário Electrum
```

O fixture `test/fixtures/bci.json` é o histórico BIP44 da xpub de teste; os
testes não precisam de rede. `test/fake-electrum.mjs` é um servidor Electrum
falso em 127.0.0.1 que fala o mesmo JSON-RPC, injetado no lugar de
`cloudflare:sockets`.

## Testes feitos

- Derivação em Node conferida contra endereços conhecidos:
  - xpub `xpub6CUGR...`: `bip44 /0/0 = 1Efg...`, `/0/132 = 15tKN...`,
    `/1/2 = 15LE...`; `bip86 /0/0 = bc1pq08...`; `bip84 = bc1qjh4...`;
    `bip49 = 3Jnu...`.
  - xpub `xpub6Btt...`: p2tr `/0/0 = bc1pg98...`, p2wpkh `bc1qe38...`.
- UI com o CSS do projeto 2; o cliente só fala com o Worker.
- Electrum verificado contra o servidor real
  (`electrum.blockstream.info:50002`, TLS, `electrs-esplora 0.4.1`):
  `bip44 /0/0 = 10665 sats (3 txs)`, `bip86 /0/0 = 11100`,
  `bip84 /0/0 = 1000` — os mesmos valores que o fixture/Esplora devolvem.
- `wrangler dev` local com D1 e Electrum real: `POST /api/wallet` respondeu
  `source: electrum (scripthash) + blockchain.info (bip44)`, com a união dos
  quatro tipos (33 endereços gravados, extras subiram de 12.100 para 26.536
  sats). Electrum fora do ar → `source` volta para Esplora e a resposta é 200.

## Próxima fase

- Envio: o projeto 2 ainda só exibe; o projeto 1 assina o PSBT.
- Cache no D1 por scripthash para reduzir CPU (a varredura completa é o
  gargalo no plano free, não a rede).
- Trocar/estender a lista de servidores Electrum (próprio, via nó) sem mexer
  no resto; hoje o padrão é a Blockstream com fallback em texto puro.
