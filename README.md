# Projeto 2 — xpub, saldo e endereços usados (Worker + Durable Object + Electrum)

Carteira watch-only e **sem armazenamento**: você entrega a **xpub**, o Worker
deriva os endereços públicos na hora e consulta um servidor **Electrum**. A
tela mostra:

1. **saldo total** da carteira (soma das UTXOs de todos os tipos de conta);
2. **lista de endereços de recebimento já usados**, com **recebido**,
   **enviado** e **saldo** de cada um — mais o próximo endereço livre para
   receber.

Nada fica guardado: nem a xpub no navegador, nem endereços, transações ou
saldo no Cloudflare. Enquanto a tela está aberta o saldo é acompanhado em
**tempo real** (`scripthash.subscribe` + WebSocket); quando a última tela
fecha, a conexão, as assinaturas, os endereços derivados, o cache de
transações e a xpub são descartados. A próxima abertura começa do zero.

A fonte de saldo e histórico é **apenas um servidor Electrum**, consultado do
mesmo jeito que o Electrum e o Sparrow fazem: por `scripthash`,
`blockchain.scripthash.get_history` + `get_mempool` + `blockchain.transaction.get`,
com o parse da transação e a conta de UTXO feitos aqui. Não há Esplora, nem
blockchain.info, nem chave privada em lugar nenhum.

> **Layout do repositório.** A raiz é o projeto do Worker (é ela que o
> Cloudflare publica): `wrangler.jsonc`, `src/`, `public/`, `test/`. Os
> arquivos soltos na mesma raiz não entram no deploy: `chave-btc.html` é o
> projeto 1 (offline, assina PSBT), `projeto-2.html` é a UI standalone antiga
> (consulta fontes públicas direto no navegador) e `teste-*.psbt` são
> fixtures de teste. A página publicada é `public/index.html`.

## O que o Worker faz

- `POST /api/wallet` com `{ "xpub": "xpub..." }` (e, opcionalmente,
  `"session"`). **O campo da tela só aceita chave estendida pública de
  conta (`xpub`, `zpub` ou `ypub`)**: o filtro bloqueia a digitação/colagem
  que não case com um dos três prefixos e descarta caractere fora do
  alfabeto base58, então endereço, chave privada (`xprv`/`yprv`/`zprv`) e
  texto solto nem chegam a formar valor (com mensagem explicando o motivo).
  O Worker também recusa essas entradas antes de consultar. A consulta começa
  sozinha assim que o campo fica com a chave completa e válida (debounce
  curto), e o tempo real abre junto. `zpub`/`ypub` continuam aceitos pela API
  e pela tela.
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
- **Sem cache durável**: cada consulta deriva e consulta de novo. Enquanto a
  sessão do Durable Object estiver viva (tela aberta) a conexão, os endereços
  já derivados e o cache de transações ficam em memória; na consulta seguinte
  só o que mudou é baixado.
- **Tempo real**: um Durable Object por sessão de tela segura a conexão com o
  servidor, assina os scripthashes e empurra o estado novo por WebSocket
  quando algo muda (detalhes em “Tempo real”).
- Sem senha: a xpub é a credencial. Ela só existe no campo da tela e na
  memória do Durable Object durante a sessão. O navegador **não** guarda a
  xpub (nada de `localStorage`); a única coisa salva ali é o tema claro/escuro.

## Electrum (fonte única)

`src/electrum.js` fala o protocolo Electrum (JSON-RPC 1.4, uma linha por
mensagem) sobre `connect()` de `cloudflare:sockets`, com `secureTransport:
"on"`. O transporte é injetável (`setConnectOverride`) para os testes
rodarem em Node.

- `scripthash` = sha256 do scriptPubKey com os bytes invertidos; o Worker já
  deriva o script de cada endereço, então não precisa decodificar endereço.
- Uma consulta avulsa abre a conexão e fecha ao terminar; no tempo real a
  conexão é reaproveitada enquanto a tela estiver aberta, com pipelining
  (janela de até 100 pedidos de histórico e 20 de transação) e timeout por
  pedido.
- Se o servidor cair no meio, a resposta é erro explícito (502) — não existe
  fallback para outra fonte. Endereços cuja transação não veio do servidor
  mantêm o último valor calculado nesta sessão e aparece aviso em `warnings`.

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
- endereço já derivado nesta sessão não é derivado de novo;
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

### Como está montado (sem storage)

- **Uma sessão por tela**, não por xpub: o Worker cria um id aleatório com
  `newUniqueId()` e devolve em `session` na resposta do `POST /api/wallet`. O
  id não é derivado da xpub e o nome do objeto não é gravado.
- `POST /api/wallet` é encaminhado para o objeto (`/sync`), que faz a
  varredura com gap e mantém tudo em memória. O `xpub` chega no corpo do POST
  e só existe na memória do objeto; não é parâmetro de URL.
- `GET /api/events?session=…` faz o upgrade de WebSocket. Ao abrir, o objeto
  manda o estado atual; a cada aviso do servidor ele reconsulta **só aquele
  scripthash** (`get_history` + `get_mempool` + as transações novas), refaz a
  conta e empurra o payload novo para as telas daquela sessão.
- Se o endereço avisado era da cauda de gap e passou a ter histórico, o
  objeto estende a varredura e assina os endereços novos.
- **Timers em memória**, sem alarme: debounce de 1 s para juntar avisos do
  mesmo bloco, `server.ping` a cada 30 s enquanto houver tela aberta e
  descarte por inatividade em 60 s quando o `/sync` não virou WebSocket.
- Se a sessão chegar sem xpub (objeto despejado), `/api/events` responde
  **409**; a tela reage a `error`/`close` do WebSocket, reenvia a xpub no
  próximo `POST /api/wallet` e reabre o canal. Um handshake que não abre nem
  fecha tem timeout de 8 s na tela, para não ficar presa.

### O que acontece quando a tela fecha?

A última conexão WebSocket cai e o objeto descarta tudo na hora: fecha o
socket do Electrum, limpa as assinaturas, os endereços derivados, o cache de
transações, o último payload e a xpub. Depois disso o objeto não tem socket,
timer nem storage; o runtime pode despejá-lo, e a próxima tela cria uma sessão
nova. O ciclo é:

1. tela abre → `POST` com a xpub → objeto conecta, varre com gap, assina e
   monitora;
2. tela fecha → objeto fecha a conexão e **esquece tudo**;
3. se o objeto for despejado antes (eviction, deploy, inatividade) o socket e
   as assinaturas morrem; a tela reenvia a xpub e refaz a varredura.

Não existe monitoramento 24/7 nem aviso com a tela fechada — e é justamente
por isso que nada precisa ser guardado.

### Custo

Duração de Durable Object é cobrada com base nos 128 MB de alocação,
independentemente do uso. No plano free são 13.000 GB-s por dia, o que dá
~28 horas de **um** objeto acordado (13.000 ÷ 0,128 GB ÷ 3600). Manter um
objeto 24/7 consome ~85% dessa cota diária; por isso o desenho só acorda com
tela aberta — e continua acordado enquanto a aba estiver aberta, mesmo em
segundo plano. Fechar a página encerra na hora. WebSocket, requisições e
timers contam como requisições (free: 100.000/dia). **Storage não é usado**:
não há `put`, `get` nem `setAlarm`.

Configuração no `wrangler.jsonc`: binding `WATCH` para a classe
`WalletWatcher` e a migration `v1` com `new_sqlite_classes` (SQLite é o único
backend de Durable Object disponível no plano free).

## Limites conhecidos

- **Varredura completa a cada abertura de tela**: sem cache durável, cada
  abertura refaz a varredura com gap e baixa de novo as transações dos
  endereços usados. É o preço de não guardar nada. Enquanto a sessão está
  viva, as consultas seguintes e os avisos reaproveitam o que já está em
  memória.
- **Custo medido** (xpub de teste, 29 endereços usados, 34 transações,
  `wrangler dev` + Electrum real, `SCAN_GAP=50`): **7,0 s** para a primeira
  consulta de uma sessão nova; com a sessão viva, `POST` seguinte na mesma
  sessão fica em **2,2 s**, e o aviso de mudança custa 2 pedidos + as
  transações novas.
- **CPU**: cada abertura de tela deriva algumas centenas de endereços. Cabe
  nos 30 s de CPU do plano pago (US$ 5/mês); no free (10 ms) não cabe.
- `SCAN_MAX` é teto de segurança: uma carteira com uso além disso para a
  varredura e avisa em `warnings` (não estoura erro).
- Sem heartbeat da tela: quando a aba fecha, o `close` do WebSocket encerra a
  sessão na hora. Se a rede cair sem `close`, quem percebe é o runtime
  (socket morto); até lá o objeto continua com o keepalive do Electrum.
- Endereços usados além da faixa de gap não aparecem: a varredura procura do
  índice 0 até `SCAN_GAP` endereços seguidos sem uso em cada ramo.
- O servidor Electrum vê os scripthashes consultados (com TLS o caminho da
  rede não vê). Privacidade, não custódia: a xpub não gasta nada.
- Um vazamento da xpub é perda de privacidade, não de fundos.
- O id da sessão é uma capacidade temporária: quem tiver o id enquanto a
  tela estiver aberta consegue ler o estado daquela carteira (o id é
  aleatório de 256 bits, não a xpub). Ao fechar, ele deixa de existir.

## Estrutura

```
wrangler.jsonc
package.json
src/
  btc-core.js         núcleo BTC (sem DOM): chaves, endereços, tx, PSBT
  derivation.js       CKDpub, xpub, endereços dos 4 tipos
  electrum.js         cliente Electrum (JSON-RPC 1.4) sobre cloudflare:sockets
  address-totals.js   conta de UTXO: recebido/enviado/saldo por script
  wallet-sync.js      varredura com gap e payload da carteira (só memória)
  watcher.js          Durable Object: socket + assinaturas + WebSocket, sem storage
  config.js           env (servidores, timeout, SCAN_MAX) e helpers
  worker.js           rotas: /api/wallet, /api/events, /api/health
public/
  index.html          UI ASCII (página publicada)
  app.js              cliente (xpub, carga automática, render, update a cada 30 s)
  style.css           CSS/fonte do projeto 2
test/
  electrum.test.mjs   cliente Electrum contra servidor falso
  worker.test.mjs     ponta a ponta: saldo/recebido/enviado, gap, erros
  watcher.test.mjs    Durable Object: assinatura, aviso → push, descarte total
  fake-electrum.mjs   servidor Electrum falso (TCP em 127.0.0.1, com notify)
  tx-fixture.mjs      transações cruas montadas com o btc-core
```

## Armazenamento (nenhum)

Não há binding de D1/KV/R2 e o Durable Object não chama `storage`: os testes
passam um `storage` que lança em qualquer acesso, então uma regressão que
volte a gravar quebra o `npm test`. Também não há `localStorage` com a xpub no
navegador.

Se você veio de uma versão anterior com D1, os restos ficam na sua conta e no
disco local. Para remover:

```bash
# banco remoto antigo (não é mais usado por este worker)
npx wrangler d1 delete btc-xpub

# estado local do dev (D1 e Durable Objects antigos)
rm -rf .wrangler/state
```

O que ainda existe fora do nosso controle: metadados operacionais da própria
Cloudflare (contadores e roteamento do painel) e o id aleatório da sessão
enquanto ela está viva. Nenhum dado de carteira: nem xpub, nem endereço, nem
saldo.

## Subir no Cloudflare

```bash
npm install
npx wrangler login

# roda local
npm run dev

# publica (sem passo de banco: não há banco)
npm run deploy
```

Se o `wrangler` reclamar do `compatibility_date`, ajuste para uma data
válida da sua conta.

### Deploy pelo GitHub (Workers Builds)

Não há `database_id` nem schema para aplicar. No painel do Workers Builds:
**Root directory** vazio/`/` (a raiz do repo é o projeto), build command
`npm ci`, deploy command `npx wrangler deploy`.

O `wrangler.jsonc` desliga a observabilidade (`"observability": { "enabled":
false }`) para não guardar log de invocação no Cloudflare. Ligue
temporariamente se precisar depurar.

## API

### `POST /api/wallet`

```json
{ "xpub": "xpub...", "session": "opcional, devolvido pelo próprio endpoint" }
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
  "watch": true,
  "session": "0740457f05938f9406827187257194d692dcf571a130eaec3c737dd3392ce31c"
}
```

`addresses` traz **só endereços usados** (todos os tipos), cada um com
recebido, enviado, saldo e número de transações. `receive`/`change` são os
próximos endereços livres do tipo detectado.

`watch: true` avisa a UI para abrir o WebSocket de tempo real. `session` é o
id aleatório do Durable Object: mande de volta no próximo `POST` para
reaproveitar a sessão enquanto a tela estiver aberta. Se ele não existir mais
(objeto despejado), o `/sync` refaz a varredura com a xpub enviada.

### `GET /api/events?session=<id da sessão>`

Upgrade para WebSocket no Durable Object. Mensagens: `{ "type": "payload",
"payload": { ...mesma resposta do POST } }` a cada mudança, e
`{ "type": "error", "error": "..." }` quando a conexão com o Electrum cai.
Sessão sem xpub responde 409 (a tela reenvia a xpub em `/api/wallet`).

### `GET /api/health`

`{ "ok": true, "service": "projeto-2-electrum", "source": "electrum", "storage": "nenhum", "realtime": true, "electrum": [...] }`.

## Segurança

- A xpub é watch-only. **Não coloque xprv aqui.** O projeto 1 permanece
  offline assinando o PSBT.
- Use 2FA na conta Cloudflare; não logue a xpub. O Worker não grava a xpub,
  não a coloca em URL e não tem banco; mesmo assim, um comprometimento do
  Worker poderia mentir no display ou exfiltrar a chave que passou por ele
  enquanto a tela estava aberta.
- O HTML/JS é servido pelo Cloudflare. O projeto 1 confere entradas, saídas e
  taxa antes de assinar.
- Para valor alto, hardware wallet + nó/Electrum próprio.

## Testes

```bash
npm test                        # electrum + worker + watcher, sem rede
node test/electrum.test.mjs     # protocolo contra servidor falso
node test/worker.test.mjs       # ponta a ponta, sem D1 no env
node test/watcher.test.mjs      # Durable Object, timers e descarte total
node test/dev-server.mjs        # UI local em http://127.0.0.1:8787/ (sem DO)
node test/cdp-ui.mjs            # opcional: Chromium headless + screenshot
```

A validação do campo foi conferida em Chromium headless (CDP `Input.insertText`):
endereço, `xprv` e texto solto deixam o campo vazio com aviso; `xpub`, `zpub`
e `ypub` de 111 caracteres entram, disparam a consulta sozinha e carregam a
carteira. A página abre sempre com o campo vazio, inclusive depois de
recarregar.

O `watcher.test.mjs` usa um par de WebSocket mínimo e um `storage` que lança
em qualquer acesso para exercitar o Durable Object sem Cloudflare: assinatura
de todos os scripthashes, aviso → reconsulta só do endereço → push, extensão
da cauda de gap com novas assinaturas, cache de transações em memória, queda
do Electrum com reconexão e reassinatura, o descarte de
conexão/endereços/xpub quando a última tela fecha e a recarga (fechar e
re-sincronizar no mesmo instante) sem apagar a sessão nova.

O `worker.test.mjs` monta transações com o próprio `btc-core` e cobre:
endereço que recebeu e gastou (`recebido 10000 / enviado 10000 / saldo 0`),
endereço que só recebeu, próximo índice, mempool no saldo, união dos tipos,
ausência de cache entre consultas (o Electrum é consultado de novo),
ausência de fallback quando o Electrum não responde, recusa de
endereço/xprv/texto solto antes de consultar e a faixa de gap vinda de
`SCAN_GAP` (padrão 20; 40 consultas com gap 5 numa carteira vazia).

## Verificado no runtime de verdade

`wrangler dev` (workerd + Durable Object, **sem D1**) com o servidor real e a
UI em Chromium headless:

```
POST /api/wallet          200  7,0 s   watch=true  session=0740457f…  total 12 862 176 sats  29 endereços
GET  /api/health          200            storage=nenhum  realtime=true
GET  /api/events?session=…  101          WebSocket: { type: "payload", total: 12862176 }
fechar a tela             —              mesmo session → 409 (objeto esqueceu a xpub)
abrir a página            —              campo vazio, nenhum xpub no localStorage
```

Localmente o miniflare cria um arquivo SQLite vazio para a instância do
objeto (nenhuma tabela); o `storage` nunca é acessado. O Durable Object sem
storage e sem alarme não tem dado de carteira para persistir.

## Verificado contra o servidor real

`electrum.blockstream.info:50002` (electrs-esplora 0.4.1), xpub de teste
`xpub6CUGR...`: 29 endereços usados, saldo total `12 862 176` sats,
`bip44 /0/0` com `recebido 110 665`, `enviado 100 000`, `saldo 10 665` — o
mesmo valor que a versão anterior (blockchain.info/Esplora) mostrava como
saldo daquele endereço, agora com o enviado explícito.

## Próxima fase

- SPV (`blockchain.transaction.get_merkle` + cadeia de cabeçalhos) se quiser
  prova de inclusão em vez de confiar no servidor.
- Aviso com a tela fechada (Web Push/e-mail) exigiria guardar a xpub e
  manter o Durable Object acordado 24/7 — é decisão de custo e de privacidade,
  o oposto do desenho atual.
- Cache opcional (D1/KV) para abrir mais rápido, se o tempo de varredura
  incomodar; seria opt-in e voltaria a guardar endereços derivados.
- Envio: o projeto 2 só exibe; o projeto 1 assina o PSBT.
