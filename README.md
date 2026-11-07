# Projeto 2 — xpub, saldo e endereços usados (Worker + D1 + Electrum)

Carteira watch-only: você entrega a **xpub**, o Worker deriva os endereços
públicos, guarda o estado no **D1** e responde duas coisas:

1. **saldo total** da carteira (soma das UTXOs de todos os tipos de conta);
2. **lista de endereços de recebimento já usados**, com **recebido**,
   **enviado** e **saldo** de cada um — mais o próximo endereço livre para
   receber.

A fonte de saldo e histórico é **apenas um servidor Electrum**, consultado do
mesmo jeito que o Electrum e o Sparrow fazem: por `scripthash`,
`blockchain.scripthash.get_history` + `get_mempool` + `blockchain.transaction.get`,
com o parse da transação e a conta de UTXO feitos aqui. Não há Esplora, nem
blockchain.info, nem chave privada em lugar nenhum.

> **Layout do repositório.** A raiz é o projeto do Worker (é ela que o
> Cloudflare publica): `wrangler.jsonc`, `src/`, `public/`, `test/`,
> `schema.sql`. Os arquivos soltos na mesma raiz não entram no deploy:
> `chave-btc.html` é o projeto 1 (offline, assina PSBT), `projeto-2.html` é a
> UI standalone antiga (consulta fontes públicas direto no navegador) e
> `teste-*.psbt` são fixtures de teste. A página publicada é
> `public/index.html`.

## O que o Worker faz

- `POST /api/wallet` com `{ "xpub": "xpub..." }`.
- Detecta o tipo da conta sem depender de outra fonte: `zpub` → bip84,
  `ypub` → bip49; `xpub` → varre os quatro tipos e escolhe o primeiro com
  histórico (bip44, bip86, bip84, bip49, nessa ordem).
- **Varredura com gap de 20**: deriva `/0/i` e `/1/i`, consulta o histórico
  de cada endereço e só para depois de 20 endereços seguidos sem uso (teto
  configurável em `SCAN_MAX`). O próximo endereço é `último usado + 1`.
- **Saldo por UTXO**: baixa as transações cruas dos endereços usados, faz o
  parse local e soma saídas que pagam a carteira menos as saídas já gastas.
  `recebido` é a soma das saídas, `enviado` a soma das gastas; mempool entra
  no saldo como não confirmado.
- **Todos os endereços usados** dos quatro tipos vão para a resposta; os
  outros tipos também entram no saldo total (união), não só o detectado.
- **Cache no D1**: endereços derivados (com o scriptPubKey) e transações
  cruas ficam gravados. Transação confirmada nunca muda, então só as novas
  são baixadas; endereço já derivado não é derivado de novo.
- Sem senha: a xpub é a credencial. O app guarda a xpub no `localStorage`
  por conveniência; o estado real fica no D1.

## Electrum (fonte única)

`src/electrum.js` fala o protocolo Electrum (JSON-RPC 1.4, uma linha por
mensagem) sobre `connect()` de `cloudflare:sockets`, com `secureTransport:
"on"`. O transporte é injetável (`setConnectOverride`) para os testes
rodarem em Node.

- `scripthash` = sha256 do scriptPubKey com os bytes invertidos; o Worker já
  deriva o script de cada endereço, então não precisa decodificar endereço.
- Uma conexão por requisição, com pipelining (janela de até 100 pedidos de
  histórico e 20 de transação) e timeout por pedido.
- Se o servidor cair no meio, a resposta é erro explícito (502) — não existe
  fallback para outra fonte. Endereços cuja transação não veio do servidor
  mantêm o último valor gravado e aparece aviso em `warnings`.

Variáveis (`wrangler.jsonc` → `vars`, ou pelo dashboard):

| variável | padrão | efeito |
| --- | --- | --- |
| `ELECTRUM_SERVERS` | `electrum.blockstream.info:50002:tls, blockstream.info:700:tls, electrum.diynodes.com:50022:tls` | lista `host:porta[:tls\|:tcp]`; `off` desliga (a API responde 503) |
| `ELECTRUM_TIMEOUT_MS` | `8000` | timeout por pedido |
| `SCAN_MAX` | `400` | teto de endereços por ramo; ao bater, a varredura para e avisa |

Os três servidores do padrão foram testados com `server.version`,
`scripthash.get_history`, `scripthash.get_mempool` e `transaction.get` (hex):
Blockstream (electrs 0.4.1) e DIYnodes (Fulcrum 2.1.2). Servidores com
certificado auto-assinado (bitcoin.lu.ke, electrum.emzy.de, …) não servem via
TLS aqui.

`GET /api/health` mostra a configuração efetiva.

## Limites conhecidos

- **Sem tempo real ainda**: cada requisição refaz a consulta de histórico de
  todos os endereços conhecidos (usados + cauda de gap). O Electrum e o
  Sparrow usam `scripthash.subscribe` numa conexão persistente para receber
  aviso; isso pede um Durable Object (próxima fase). Enquanto isso a UI
  atualiza a cada 30 s.
- **Custo medido** (xpub de teste, 29 endereços usados, 34 transações):
  3,8 s na primeira consulta e 2,3 s nas seguintes no `wrangler dev`, já com
  o cache do D1 (nessa xpub a varredura chega ao índice 131 do bip44).
- **CPU**: a primeira varredura deriva algumas centenas de endereços. Cabe
  nos 30 s de CPU do plano pago (US$ 5/mês); no free (10 ms) não cabe.
  Depois do primeiro scan, as atualizações praticamente não derivam.
- `SCAN_MAX` é teto de segurança: uma carteira com uso além disso para a
  varredura e avisa em `warnings` (não estoura erro).
- O servidor Electrum vê os scripthashes consultados (com TLS o caminho da
  rede não vê). Privacidade, não custódia: a xpub não gasta nada.
- Um vazamento da xpub é perda de privacidade, não de fundos.

## Estrutura

```
wrangler.jsonc
package.json
schema.sql            wallets, addresses (com script e spent), transactions
src/
  btc-core.js         núcleo BTC (sem DOM): chaves, endereços, tx, PSBT
  derivation.js       CKDpub, xpub, endereços dos 4 tipos
  electrum.js         cliente Electrum (JSON-RPC 1.4) sobre cloudflare:sockets
  address-totals.js   conta de UTXO: recebido/enviado/saldo por script
  worker.js           API, D1, varredura com gap, cache
public/
  index.html          UI ASCII (página publicada)
  app.js              cliente (xpub, render, update a cada 30 s)
  style.css           CSS/fonte do projeto 2
test/
  electrum.test.mjs   cliente Electrum contra servidor falso
  worker.test.mjs     ponta a ponta: saldo/recebido/enviado, cache, erros
  fake-electrum.mjs   servidor Electrum falso (TCP em 127.0.0.1)
  memory-db.mjs       D1 em memória
  tx-fixture.mjs      transações cruas montadas com o btc-core
```

## Banco (D1)

```sql
addresses (xpub_hash, account_type, chain, idx, address, script, used,
           balance, received, spent, tx_count, updated_at)
transactions (xpub_hash, txid, raw)
```

`schema.sql` usa `IF NOT EXISTS`. Se você já tinha criado as tabelas com a
versão anterior do projeto (sem `script`/`spent`/`transactions`), recrie o
banco ou rode:

```sql
ALTER TABLE addresses ADD COLUMN script TEXT NOT NULL DEFAULT '';
ALTER TABLE addresses ADD COLUMN spent INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS transactions (
  xpub_hash TEXT NOT NULL, txid TEXT NOT NULL, raw TEXT NOT NULL,
  PRIMARY KEY (xpub_hash, txid)
);
```

Sem `script` gravado, a varredura antiga é refeita e as linhas são
preenchidas de novo.

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

# 4. publique
npm run deploy
```

Se o `wrangler` reclamar do `compatibility_date`, ajuste para uma data
válida da sua conta.

### Deploy pelo GitHub (Workers Builds)

1. **`database_id` precisa ser o real** no `wrangler.jsonc` (hoje
   `btc-xpub` → `7c26213e-28f3-41d8-946c-742ec63b4c2f`). Um id que não
   existe faz o deploy falhar com `binding DB of type d1 must have a valid
   database_id` (código 10021).
2. **Aplique o schema uma vez** contra o D1 remoto (`npm run db:schema`) — o
   build não roda migração sozinho. Dá para pôr
   `npx wrangler d1 execute btc-xpub --file=./schema.sql --remote` no deploy
   command (o `IF NOT EXISTS` torna seguro reexecutar).

No painel do Workers Builds: **Root directory** vazio/`/` (a raiz do repo é o
projeto), build command `npm ci`, deploy command `npx wrangler deploy`.

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
  "addresses": [
    { "account_type": "bip44", "chain": 0, "idx": 0, "address": "1Efg...",
      "used": 1, "received": 110665, "spent": 100000, "balance": 10665,
      "tx_count": 3 }
  ],
  "source": "electrum (scripthash) · electrum.blockstream.info:50002",
  "warnings": [ "..." ]
}
```

`addresses` traz **só endereços usados** (todos os tipos), cada um com
recebido, enviado, saldo e número de transações. `receive`/`change` são os
próximos endereços livres do tipo detectado.

### `GET /api/health`

`{ "ok": true, "service": "projeto-2-electrum", "source": "electrum", "electrum": [...] }`.

## Segurança

- A xpub é watch-only. **Não coloque xprv aqui.** O projeto 1 permanece
  offline assinando o PSBT.
- Use 2FA na conta Cloudflare; não logue a xpub; mantenha Worker e D1
  privados (o endpoint é público por natureza; a xpub é a credencial).
- O HTML/JS é servido pelo Cloudflare; um comprometimento do Worker poderia
  mentir no display. O projeto 1 confere entradas, saídas e taxa antes de
  assinar.
- Para valor alto, hardware wallet + nó/Electrum próprio.

## Testes

```bash
npm test                        # electrum + worker, sem rede
node test/electrum.test.mjs     # protocolo contra servidor falso
node test/worker.test.mjs       # ponta a ponta com D1 em memória
node test/dev-server.mjs        # UI local em http://127.0.0.1:8787/
node test/cdp-ui.mjs            # opcional: Chromium headless + screenshot
```

O `worker.test.mjs` monta transações com o próprio `btc-core` e cobre:
endereço que recebeu e gastou (`recebido 10000 / enviado 10000 / saldo 0`),
endereço que só recebeu, próximo índice, mempool no saldo, união dos tipos,
reuso do cache de transações (nenhum `transaction.get` repetido) e ausência
de fallback quando o Electrum não responde.

## Verificado contra o servidor real

`electrum.blockstream.info:50002` (electrs-esplora 0.4.1), xpub de teste
`xpub6CUGR...`: 29 endereços usados, saldo total `12 862 176` sats,
`bip44 /0/0` com `recebido 110 665`, `enviado 100 000`, `saldo 10 665` — o
mesmo valor que a versão anterior (blockchain.info/Esplora) mostrava como
saldo daquele endereço, agora com o enviado explícito.

## Próxima fase

- **Tempo real** com `scripthash.subscribe` num Durable Object: conexão
  persistente, aviso de mudança e push para a UI — é o que falta para a
  atualização ser instantânea como no Electrum/Sparrow.
- SPV (`blockchain.transaction.get_merkle` + cadeia de cabeçalhos) se quiser
  prova de inclusão em vez de confiar no servidor.
- Envio: o projeto 2 só exibe; o projeto 1 assina o PSBT.
