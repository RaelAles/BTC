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

Com o Durable Object ligado, a tela também recebe **tempo real**: o servidor
avisa quando um endereço muda (`scripthash.subscribe`) e o estado novo chega
por WebSocket, sem polling.

> **Layout do repositório.** A raiz é o projeto do Worker (é ela que o
> Cloudflare publica): `wrangler.jsonc`, `src/`, `public/`, `test/`,
> `schema.sql`. Os arquivos soltos na mesma raiz não entram no deploy:
> `chave-btc.html` é o projeto 1 (offline, assina PSBT), `projeto-2.html` é a
> UI standalone antiga (consulta fontes públicas direto no navegador) e
> `teste-*.psbt` são fixtures de teste. A página publicada é
> `public/index.html`.

## O que o Worker faz

- `POST /api/wallet` com `{ "xpub": "xpub..." }`. **O campo da tela só
  aceita `xpub`**: o filtro bloqueia a digitação/colagem que não comece com
  `xpub` e descarta caractere fora do alfabeto base58, então endereço, chave
  privada (`xprv`), `zpub`/`ypub` e texto solto nem chegam a formar valor
  (com mensagem explicando o motivo). O Worker também recusa essas entradas
  antes de consultar. A consulta começa sozinha assim que o campo fica com a
  xpub completa e válida (debounce curto), e o tempo real abre junto; os
  botões `carregar` e `atualizar` servem para forçar uma nova consulta. A API
  em si continua entendendo `zpub`/`ypub` (para
  outros clientes e para a detecção de bip84/bip49); para reabrir isso na
  tela é só incluir as três no `EXT_PUBLIC`/`filterXpub` de `public/app.js`.
- Detecta o tipo da conta sem depender de outra fonte: `zpub` → bip84,
  `ypub` → bip49; `xpub` → varre os quatro tipos e escolhe o primeiro com
  histórico (bip44, bip86, bip84, bip49, nessa ordem).
- **Varredura com gap** (`SCAN_GAP`, padrão 20): deriva `/0/i` e `/1/i`,
  consulta o histórico de cada endereço e só para depois de N endereços
  seguidos sem uso (teto por ramo em `SCAN_MAX`). O próximo endereço é
  `último usado + 1`.
- **Saldo por UTXO**: baixa as transações cruas dos endereços usados, faz o
  parse local e soma saídas que pagam a carteira menos as saídas já gastas.
  `recebido` é a soma das saídas, `enviado` a soma das gastas; mempool entra
  no saldo como não confirmado.
- **Todos os endereços usados** dos quatro tipos vão para a resposta; os
  outros tipos também entram no saldo total (união), não só o detectado.
- **Cache no D1**: endereços derivados (com o scriptPubKey) e transações
  cruas ficam gravados. Transação confirmada nunca muda, então só as novas
  são baixadas; endereço já derivado não é derivado de novo.
- **Tempo real**: um Durable Object por xpub segura a conexão com o servidor,
  assina os scripthashes e empurra o estado novo por WebSocket quando algo
  muda (detalhes em “Tempo real”).
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
| `SCAN_GAP` | `20` | **faixa de gap**: endereços seguidos sem uso que encerram a varredura de um ramo (1..500) |
| `SCAN_MAX` | `400` | teto de endereços por ramo; ao bater, a varredura para e avisa |

Os três servidores do padrão foram testados com `server.version`,
`scripthash.get_history`, `scripthash.get_mempool` e `transaction.get` (hex):
Blockstream (electrs 0.4.1) e DIYnodes (Fulcrum 2.1.2). Servidores com
certificado auto-assinado (bitcoin.lu.ke, electrum.emzy.de, …) não servem via
TLS aqui.

`GET /api/health` mostra a configuração efetiva.

## Faixa de gap

Vale **por ramo** (tipo de conta × cadeia: 4 tipos × recebimento/troco = 8
ramos). Em cada ramo a varredura começa no índice 0 e só para depois de
`SCAN_GAP` endereços consecutivos sem uso — "usado" é ter alguma entrada em
`get_history`/`get_mempool`, então um endereço que recebeu e gastou tudo
continua contando.

- os 8 ramos são estendidos na mesma rodada, em um lote de requisições;
- endereço já derivado não é derivado de novo: a extensão cria só os índices
  novos (a cauda de gap e os usados ficam gravados no D1);
- o próximo endereço de cada ramo é `último usado + 1`;
- ao encostar em `SCAN_MAX`, o ramo para e devolve aviso em `warnings`.

Custo por varredura completa (8 ramos × gap × 2 pedidos: `get_history` +
`get_mempool`):

| `SCAN_GAP` | endereços consultados | pedidos | tempo medido/típico |
| --- | --- | --- | --- |
| 20 | ~160 | ~320 | 2–4 s |
| 50 | ~400 | ~800 | 5–8 s |
| 100 | ~800 | ~1.600 | 10–15 s |

A faixa maior serve para um caso específico: a mesma xpub já foi usada em
outro aplicativo que distribuiu endereços além da faixa conhecida. O preço é
linear no tempo de varredura e no número de assinaturas em tempo real. O
padrão desta implantação está em `SCAN_GAP` no `wrangler.jsonc` (hoje 50);
o padrão do código, se a variável não existir, é 20 (convenção BIP/Electrum).
Aviso: endereço **fora** da faixa continua invisível — com `SCAN_GAP` menor
isso acontece mais cedo (um pagamento no índice 7 de um ramo com gap 5 e
nenhum uso anterior não aparece).

## Tempo real (Durable Object)

### Precisa de Durable Object?

Para **push**, sim. O navegador não abre TCP para o Electrum e o Worker só
existe durante a requisição; sem um processo persistente do lado do servidor,
sobra polling. O Durable Object é esse processo: ele mantém a conexão TCP/TLS
com o servidor Electrum e as assinaturas `blockchain.scripthash.subscribe`
abertas. É a peça que dá ao projeto o mesmo comportamento de Electrum e
Sparrow (aviso empurrado pelo servidor).

### Como está montado

- Um objeto por xpub: o id é o `sha256` da xpub.
- `POST /api/wallet` é encaminhado para o objeto (`/sync`); ele reaproveita a
  conexão e faz a varredura com gap, gravando no D1 como antes.
- `GET /api/events?hash=…` faz o upgrade de WebSocket. Ao abrir, o objeto manda
  o estado atual; a cada aviso do servidor ele reconsulta **só aquele
  scripthash** (`get_history` + `get_mempool` + as transações novas), refaz a
  conta, grava no D1 e empurra o payload novo para todas as telas abertas.
- Se o endereço avisado era da cauda de gap e passou a ter histórico, o
  objeto estende a varredura e assina os endereços novos.
- Alarme curto (1 s) junta avisos do mesmo bloco; alarme de keepalive (30 s)
  dá `server.ping` enquanto houver tela aberta.

### O endereço “fica monitorado” no Durable Object?

Só enquanto o objeto estiver vivo **e com a assinatura aberta**. Nada de
endereço fica guardado no objeto de forma durável: o D1 é a fonte de verdade.
O ciclo é:

1. tela abre → objeto conecta, assina todos os scripthashes conhecidos
   (usados + cauda de gap) e monitora de verdade;
2. última tela fecha → fecha a conexão, descarta as assinaturas e **remove o
   alarme**, para o objeto poder hibernar (sem custo de duração);
3. se o objeto for despejado (eviction, deploy, inatividade) o socket e as
   assinaturas morrem; no próximo acesso ele reconecta, reassina e se
   atualiza — nada se perde, porque endereços e transações estão no D1.

Ou seja: monitoramento em tempo real é **por sessão de tela aberta**, não um
vigia 24/7. Para vigia 24/7 seria preciso manter o objeto acordado com alarme
periódico — o que é possível, mas é exatamente o custo que o desenho atual
evita.

### Custo

Duração de Durable Object é cobrada com base nos 128 MB de alocação,
independentemente do uso. No plano free são 13.000 GB-s por dia, o que dá
~28 horas de **um** objeto acordado (13.000 ÷ 0,128 GB ÷ 3600). Manter um
objeto 24/7 consome ~85% dessa cota diária; por isso o desenho só acorda com
tela aberta. WebSocket e alarmes contam como requisições (free: 100.000/dia).

Configuração no `wrangler.jsonc`: binding `WATCH` para a classe
`WalletWatcher` e a migration `v1` com `new_sqlite_classes` (SQLite é o único
backend de Durable Object disponível no plano free).

## Limites conhecidos

- **Varredura completa é o custo**: cada `/api/wallet` reconsulta o histórico
  de todos os endereços conhecidos (usados + cauda de gap). Com tempo real, a
  atualização por aviso consulta só o endereço avisado; a varredura completa
  acontece ao abrir a tela ou ao pedir atualizar.
- **Custo medido** (xpub de teste, 29 endereços usados, 34 transações,
  `wrangler dev` + Electrum real): com `SCAN_GAP=20`, 3,9 s na primeira
  consulta e ~1,5–2,3 s nas seguintes; com `SCAN_GAP=50` (o valor deployado),
  5,8 s para estender a faixa e 2,3 s nas seguintes — 561 endereços gravados,
  cauda de 50 em todos os ramos. O aviso de mudança custa 2 pedidos + as
  transações novas.
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
  wallet-sync.js      varredura com gap, cache no D1 e payload da carteira
  watcher.js          Durable Object: socket + assinaturas + WebSocket
  config.js           env (servidores, timeout, SCAN_MAX) e helpers
  worker.js           rotas: /api/wallet, /api/events, /api/health
public/
  index.html          UI ASCII (página publicada)
  app.js              cliente (xpub, carga automática, render, update a cada 30 s)
  style.css           CSS/fonte do projeto 2
test/
  electrum.test.mjs   cliente Electrum contra servidor falso
  worker.test.mjs     ponta a ponta: saldo/recebido/enviado, cache, erros
  watcher.test.mjs    Durable Object: assinatura, aviso → push, repouso
  fake-electrum.mjs   servidor Electrum falso (TCP em 127.0.0.1, com notify)
  memory-db.mjs       D1 em memória
  tx-fixture.mjs      transações cruas montadas com o btc-core
```

## Banco (D1)

```sql
addresses (xpub_hash, account_type, chain, idx, address, script, used,
           balance, received, spent, tx_count, updated_at)
transactions (xpub_hash, txid, raw)
```

`schema.sql` usa `IF NOT EXISTS`, então **não altera tabela que já existe**.
Se o banco foi criado com a versão anterior do schema (sem `script`/`spent`),
rodar o `schema.sql` de novo não resolve — o INSERT falha com
`table addresses has no column named script`. Nesse caso:

```bash
npm run db:migrate          # migração (remoto)
npm run db:migrate:local    # dev
```

`migrate.sql` só faz o `ALTER TABLE addresses ADD COLUMN script/spent` e cria
`transactions` se faltar. Linhas antigas ficam com `script` vazio: elas são
ignoradas e derivadas de novo no próximo `/api/wallet`, com os valores
recalculados (verificado: linha com saldo errado volta ao valor certo e o
`script` é preenchido).

Se preferir começar limpo, dá para apagar tudo — o conteúdo de `addresses` e
`transactions` é derivado da xpub + Electrum, não é dado do usuário:

```sql
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS addresses;
DROP TABLE IF EXISTS wallets;
```

…e rodar o `schema.sql` em seguida.

## Subir no Cloudflare

```bash
npm install
npx wrangler login

# 1. crie o D1 e copie o database_id para wrangler.jsonc
npx wrangler d1 create btc-xpub

# 2. crie as tabelas
npm run db:schema          # remoto
npm run db:schema:local    # para o dev local

# 2b. banco criado antes da versão com `script`/`spent`:
npm run db:migrate

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
  "warnings": [ "..." ],
  "watch": true
}
```

`addresses` traz **só endereços usados** (todos os tipos), cada um com
recebido, enviado, saldo e número de transações. `receive`/`change` são os
próximos endereços livres do tipo detectado.

`watch: true` avisa a UI para abrir o WebSocket de tempo real.

### `GET /api/events?hash=<sha256 da xpub>`

Upgrade para WebSocket no Durable Object. Mensagens: `{ "type": "payload",
"payload": { ...mesma resposta do POST } }` a cada mudança, e
`{ "type": "error", "error": "..." }` quando a conexão com o Electrum cai.

### `GET /api/health`

`{ "ok": true, "service": "projeto-2-electrum", "source": "electrum", "realtime": true, "electrum": [...] }`.

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
npm test                        # electrum + worker + watcher, sem rede
node test/electrum.test.mjs     # protocolo contra servidor falso
node test/worker.test.mjs       # ponta a ponta com D1 em memória
node test/watcher.test.mjs      # Durable Object com WebSocket e alarme
node test/dev-server.mjs        # UI local em http://127.0.0.1:8787/ (sem DO)
node test/cdp-ui.mjs            # opcional: Chromium headless + screenshot
```

A validação do campo foi conferida em Chromium headless (CDP `Input.insertText`):
endereço, `xprv`, `zpub` e texto solto deixam o campo vazio com aviso; a xpub
de 111 caracteres entra e carrega a carteira.

O `watcher.test.mjs` usa um par de WebSocket mínimo e um `storage` de alarme
em memória para exercitar o Durable Object sem Cloudflare: assinatura de
todos os scripthashes, aviso → reconsulta só do endereço → push, extensão da
cauda de gap com novas assinaturas, e o encerramento quando a última tela
fecha.

O `worker.test.mjs` monta transações com o próprio `btc-core` e cobre:
endereço que recebeu e gastou (`recebido 10000 / enviado 10000 / saldo 0`),
endereço que só recebeu, próximo índice, mempool no saldo, união dos tipos,
reuso do cache de transações (nenhum `transaction.get` repetido), ausência
de fallback quando o Electrum não responde, recusa de endereço/xprv/texto
solto antes de consultar e a faixa de gap vinda de `SCAN_GAP` (padrão 20,
40 linhas com gap 5 numa carteira vazia).

## Verificado no runtime de verdade

`wrangler dev` (workerd + D1 local + Durable Object) com o servidor real:

```
POST /api/wallet          200  3,9 s   watch=true   total 12 862 176 sats   29 endereços
GET  /api/health          200           realtime=true
GET  /api/events          101  Switching Protocols
WebSocket                 msg { type: "payload", total: 12862176,
                              source: "electrum (scripthash) · electrum.blockstream.info:50002" }
```

## Verificado contra o servidor real

`electrum.blockstream.info:50002` (electrs-esplora 0.4.1), xpub de teste
`xpub6CUGR...`: 29 endereços usados, saldo total `12 862 176` sats,
`bip44 /0/0` com `recebido 110 665`, `enviado 100 000`, `saldo 10 665` — o
mesmo valor que a versão anterior (blockchain.info/Esplora) mostrava como
saldo daquele endereço, agora com o enviado explícito.

## Próxima fase

- SPV (`blockchain.transaction.get_merkle` + cadeia de cabeçalhos) se quiser
  prova de inclusão em vez de confiar no servidor.
- Aviso com a tela fechada (Web Push/e-mail) manteria o Durable Object
  acordado 24/7 — é decisão de custo, não de código.
- Envio: o projeto 2 só exibe; o projeto 1 assina o PSBT.
