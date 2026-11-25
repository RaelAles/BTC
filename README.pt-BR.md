<p align="left"><sub><b>PT</b> · <a href="README.md">EN</a></sub></p>

<p align="right"><a href="https://raelales.com/apoiar" title="Apoie Rael Ales e seus projetos"><img src=".github/assets/support-pt.svg" alt="Apoie-me — ajude a manter o Monitor BTC atualizado"></a></p>

# Monitor BTC

<!-- Português (Brasil) · [English](README.md) -->

Carteira Bitcoin **watch-only** em Cloudflare Workers. O navegador lê a
**xpub** da conta (ou `zpub`/`ypub`), deriva os endereços localmente e envia ao
Worker só o conjunto de endereços/scripthashes; o Worker consulta o saldo, os
endereços de recebimento e o histórico de transações de um servidor
**Electrum**. O navegador monta o PSBT sem assinatura; o Worker só transmite a
transação assinada que volta do **Cofre BTC**, o assinador offline.

Nada fica guardado: nem dados da carteira no navegador, nem banco de dados na
Cloudflare, e a xpub não é enviada ao Worker.

## O que é

- Uma carteira **watch-only**: nunca vê chave privada e não gasta sozinha.
- Uma **interface de página única** com três telas: carteira, histórico e
  sobre. A interface está traduzida em português, inglês, espanhol, francês,
  italiano, alemão, neerlandês, catalão e galego. O automático segue o
  navegador; a escolha manual vale só para a sessão.
- Um **montador de PSBT no navegador**: valor, destino e a taxa estimada ao
  vivo bastam para produzir um PSBT v0 sem assinatura, com troco, sem o
  servidor escolher moedas.
- Um **visualizador de histórico**: transações agrupadas pelo `txid`, do
  mempool para o bloco mais recente, com direção, valores, taxa e os
  endereços da carteira que participam. Uma transação pendente pode ser
  acelerada por CPFP.
- Um **portão de transmissão**: o PSBT assinado é conferido contra a carteira
  antes de qualquer coisa ir para a rede. A publicação só acontece depois do
  clique explícito em **confirmar**.

Ele não é nó completo, não é carteira de custódia e não mantém vigilância
em segundo plano com a tela fechada.

## O que a tela mostra

1. **Saldo disponível** abaixo do campo da xpub, em BTC, com o horário da
   última atualização. Entram a saída confirmada ainda não gasta e o **troco
   de uma transação sua ainda no mempool**, porque esse troco pode ser gasto
   antes de confirmar. Pagamento de terceiro no mempool não entra até
   confirmar. A linha `pendente +…/-…` mostra o que está fora desse número.
2. **Um endereço de recebimento por tipo**, os quatro, inclusive os zerados:
   sempre o primeiro índice sem uso daquele ramo (`último usado + 1`), para o
   pagador escolher o formato. O rótulo é só o BIP (`bip86`, `bip84`,
   `bip49`, `bip44`), e cada endereço tem um botão de copiar.
3. **Histórico por transação**, do mais recente para o mais antigo, com
   `[ pendente ]` ou `[ confirmada ]`, a direção (enviado, recebido ou auto),
   o número de entradas e saídas, os valores, a taxa e os endereços da
   carteira que participam. A lista é paginada, com o tamanho da página
   ajustado à área visível. A transação pendente que ainda tem uma saída
   própria não gasta ganha o botão **acelerar**, que monta um PSBT filho de
   CPFP sem assinatura.
4. **Enviar BTC**: quantidade, destino e a taxa calculada ao vivo pelo
   `estimatefee` do Bitcoin Core (alvo de 2 blocos), reconsultada a cada 60
   segundos. Não há escolha de taxa. A quantidade usa máscara de BTC: só
   dígitos, com o ponto entrando da direita para a esquerda. A nota abaixo do
   campo mostra o máximo enviável para aquele destino e aquela taxa. Um
   pedido válido monta o PSBT sozinho; abaixo do pó (0,00000546 BTC) ou acima
   do máximo, a nota explica o motivo.
5. **Transmitir**: importar o PSBT assinado não publica nada. O servidor
   confere que cada entrada é desta carteira, que os valores batem e que todas
   as entradas estão finalizadas. Só então aparecem o resumo e o botão
   **confirmar**. Apenas esse clique entrega a transação final ao Electrum.

## Como funciona

### Descoberta de endereços

- A chave aceita é uma **chave pública estendida de conta** (`xpub`, `zpub`
  ou `ypub`, profundidade 3). Endereços, chaves privadas
  (`xprv`/`yprv`/`zprv`) e texto solto são recusados antes de qualquer
  consulta.
- `zpub` corresponde ao BIP84 e `ypub` ao BIP49. Uma `xpub` comum varre os
  quatro tipos e marca o primeiro com histórico, na ordem BIP44, BIP86, BIP84,
  BIP49.
- A varredura percorre as duas cadeias (`/0/i` recebimento, `/1/i` troco) dos
  quatro tipos, **no navegador**. Cada ramo para depois de **50 endereços
  consecutivos sem uso**. O próximo endereço é sempre `último usado + 1`.
- A tela deriva a cauda de 50 de cada ramo e manda o conjunto ao Worker; a
  resposta diz quantos endereços faltam para fechar a margem. A tela deriva
  essa cauda e repete, sem que o Worker veja a xpub. Se o freio de abuso
  responder **429**, a tela espera o `Retry-After` e repete o mesmo passo.

### Saldo

- O Worker baixa as transações cruas dos endereços usados, faz o parse local
  e soma as saídas que pagam a carteira menos as saídas já gastas.
- `total` é o saldo **disponível**: saída confirmada ainda não gasta mais o
  troco de uma transação sua ainda pendente. Pagamento de terceiro no mempool
  aparece como `pending_in` e só conta depois de confirmar. `pending_out` é o
  que já saiu de fato numa transação pendente (destino mais taxa), líquido do
  troco que volta.

### Electrum como fonte única

`src/electrum.js` fala o protocolo JSON-RPC do Electrum sobre
`cloudflare:sockets`. A derivação acontece no navegador; o Worker recebe os
endereços já derivados e consulta por `scripthash`
(`blockchain.scripthash.get_history`, `blockchain.scripthash.get_mempool`,
`blockchain.transaction.get`), fazendo a conta de UTXO aqui. Não há Esplora,
nem blockchain.info, nem chave privada em lugar nenhum.

Uma consulta avulsa abre a conexão e fecha ao terminar. Durante uma sessão
viva a conexão é reaproveitada, com pipelining e timeout por pedido. Se o
servidor cair no meio, a resposta é um 502 explícito; não existe fallback para
outra fonte. `GET /api/health` mostra a configuração efetiva.

### Tempo real (Durable Object)

- Um Durable Object por sessão de tela, não por xpub. O Worker cria um id de
  sessão aleatório de 256 bits e o devolve no `POST /api/wallet`.
- O objeto segura a conexão com o Electrum e as assinaturas
  `blockchain.scripthash.subscribe` dos endereços usados mais a cauda de 50 de
  cada ramo. Quando o servidor avisa de uma mudança, ele reconsulta só aquele
  scripthash e empurra o payload novo por WebSocket.
- Quando a última tela fecha, o objeto descarta tudo: socket, assinaturas,
  endereços, cache de transações, último payload e o conjunto observado. Não
  há xpub no objeto, alarme nem storage para restaurar.
- Sessão perdida responde **409**; a tela refaz a derivação local e reabre o
  canal. Se o objeto for despejado ou o Worker for republicado, a próxima
  requisição refaz a consulta.

### Taxa e PSBT

- A única fonte de taxa é o `blockchain.estimatefee` com alvo de **2 blocos**
  (o Bitcoin Core se recusa a estimar 1 bloco). O valor vem em BTC/kvB e é
  convertido para sat/kvB exato; só a taxa final, em satoshis, é arredondada
  para cima.
- O navegador escolhe primeiro as saídas confirmadas e depois o seu próprio
  troco pendente. Ele tenta a menor entrada que cobre sozinha, depois o menor
  par e, por fim, as maiores entradas. O resultado prefere menos entradas, sem
  troco quando a sobra seria pó, a menor sobra, o tipo de entrada mais barato,
  mais confirmações e uma ordem de derivação estável.
- O pó é **546 sats**. Quando a sobra seria pó, nenhuma saída de troco é
  criada e a sobra vai para a taxa; a resposta separa `fee_sats_at_rate` de
  `dust_sats`.
- Toda entrada leva `witness_utxo`, a origem BIP32 e a transação anterior
  inteira (`non_witness_utxo`) para o assinador offline conferir o valor.
  Entradas taproot usam `tap_bip32_derivation`; entradas p2sh-p2wpkh levam o
  `redeem_script`. A impressão digital é a da conta, que é o máximo que uma
  xpub watch-only conhece.
- A vsize estimada é um limite superior da transação assinada, então a taxa
  paga nunca fica abaixo da pedida. O preço disso é uma folga de no máximo
  cerca de 1 vB de taxa.

### CPFP

Para uma transação pendente cujas entradas são todas desta carteira e que
ainda tem uma saída própria não gasta, o navegador monta o PSBT filho. Ele soma
a taxa e a vsize do pai e dos ancestrais ainda no mempool, calcula a taxa do
filho para o pacote atingir a taxa pedida e manda o resto para o próximo
endereço de troco. O pai não muda. Assine o filho no Cofre BTC e importe em
**carteira → transmitir**, como um envio normal.

### Transmissão

`POST /api/broadcast` recebe o PSBT assinado (base64 ou hex) e confere:

- cada entrada gasta um script do conjunto observado;
- quando a saída está entre os UTXOs conhecidos, o valor declarado bate com o
  da carteira;
- toda entrada está finalizada no formato exigido pelo tipo de script;
- as saídas são classificadas em troco, recebimento próprio ou externo, e a
  taxa e a vsize vêm da transação final, não da estimativa.

Com `preview: true` ele só confere e devolve o resumo. Sem preview, o hex
final vai para o `blockchain.transaction.broadcast`. Os avisos cobrem taxa
zero ou muito baixa, taxa muito alta, saída abaixo do pó, mais de uma saída
externa e entrada que a sessão não conhece. Transmitir não tem volta.

## O Cofre BTC

O Cofre é um arquivo HTML único, `public/cofre-btc.html`, servido como
download em `/cofre-btc` (ou `/cofre-btc.html`). Ele funciona offline, no
navegador, sem servidor. A tela **gerar** registra 256 bits de entropia pelo
método que você escolher; jogar uma moeda é só uma sugestão (cara = 1,
coroa = 0). Os bits viram uma frase de 24 palavras e derivam as quatro contas;
a tela **chave** também aceita as 24 palavras digitadas à mão. Ao importar um
PSBT, ele confere a conta, a derivação, a chave pública, o script, as saídas e
a taxa antes de assinar. A chave privada nunca passa pelo Monitor.

Antes de abrir, confira o hash publicado: sha256 do arquivo publicado é
`0557763a22376e72f629648c40a1a4ec3481e69c2c9823a87d7d6059aee5f6aa` — rode
`sha256sum cofre-btc.html` no arquivo baixado; o asset do release tem sempre
esse nome fixo. A tela “sobre” do Cofre
pede a mesma conferência. Qualquer edição no Cofre exige atualizar este
valor; o `npm test` acusa hash vencido.

A tela “chave” tem um campo opcional **frase secreta**: ele entra no PBKDF2
do BIP39 depois das 24 palavras, não muda a frase e muda a seed, as contas e
os endereços. Editar ou apagar o campo refaz a derivação; vazio, vale a
passphrase vazia. Quem perder a frase secreta perde a carteira que ela
define.

## Requisitos

- Node.js **22 ou mais novo** e npm.
- Uma conta Cloudflare para o Worker, os assets e o Durable Object.
- Acesso a servidores Electrum por TLS. A lista padrão é
  `electrum.blockstream.info:50002`, `blockstream.info:700` e
  `electrum.diynodes.com:50022`.
- Um navegador moderno para a interface e o Cofre. O Cofre funciona offline.

## Desenvolvimento

```bash
npm install
npm run dev             # wrangler dev, com a configuração real do Electrum
npm test                # todos os *.test.mjs, sem rede
npm run icons           # gera os ícones da PWA a partir do icon.svg (precisa do Chromium)
npm run sync:cofre-css  # reinjeta o estilo embutido no Cofre (mantenedor)
npm run sync:browser-core # gera a derivação local usada pela tela (SRI)
```

O `sync:cofre-css` lê por padrão o `estilo.css` da skill ascii-ui; passe um
caminho para usar outro arquivo. Ele regrava só o bloco marcado e o hash em
`public/cofre-btc.html`, e o `npm test` acusa a cópia fora de sincronia.
O `sync:browser-core` gera `public/wallet-local.js` a partir de
`src/btc-core.js` e `src/derivation.js`; qualquer mudança nessas fontes exige
rodar o script e recalcular o SRI em `public/index.html`.

Para uma interface totalmente offline, com Electrum falso e cenário fixo:

```bash
node test/dev-server.mjs
# http://127.0.0.1:8787/
```

O opcional `test/cdp-ui.mjs` aciona um Chromium headless (espera o Chromium
instalado e o servidor de desenvolvimento rodando) e grava um screenshot em
`/tmp/cloud-ui.png`.

## Publicação

```bash
npx wrangler login
npm run deploy
```

A raiz do repositório é o projeto do Worker: `wrangler.jsonc`, `src/`,
`public/`, `test/`. Não há banco nem schema; a única migration é a declaração
da classe Durable Object `v1` em `wrangler.jsonc`.

Para o **Workers Builds**, deixe o diretório raiz vazio (a raiz do
repositório), use `npm ci` como build e `npx wrangler deploy` como deploy.
O `routes` declara o domínio personalizado do projeto, e
`workers_dev` e `preview_urls` estão desligados, então o Worker responde só
nesse domínio. A observabilidade fica desligada para não guardar logs de
invocação na Cloudflare.

### Configuração

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `ELECTRUM_SERVERS` | `electrum.blockstream.info:50002:tls, blockstream.info:700:tls, electrum.diynodes.com:50022:tls` | Lista `host:porta[:tls\|:tcp]`. `off` desliga o Electrum e a API responde 503. |
| `ELECTRUM_TIMEOUT_MS` | `8000` | Timeout por pedido, em milissegundos. Valor inválido ou não positivo responde 503. |

O binding `WATCH` aponta para `WalletWatcher`; a migration `v1` declara a
classe como Durable Object com backend SQLite, o único disponível no plano
free. O objeto não chama `storage`.

## API

As rotas da API respondem JSON (a rota de eventos faz upgrade para WebSocket).
Erros usam `{ "error": "..." }`; os status comuns são 400 (requisição
inválida), 404/405 (rota ou método desconhecido), 409 (sessão perdida), 429
(limite de pedidos), 500 (falha inesperada), 502 (falha do Electrum) e 503
(Electrum desligado/mal configurado).

| Rota | Função |
| --- | --- |
| `POST /api/wallet` | Estado da carteira: saldo, os quatro tipos, endereços usados e transações. |
| `POST /api/raw` | Devolve as transações cruas do conjunto; o navegador usa para conferir UTXOs e montar o PSBT. |
| `POST /api/psbt` | **Legado:** monta o PSBT no servidor; a tela não usa. |
| `POST /api/cpfp` | **Legado:** monta o CPFP no servidor; a tela não usa. |
| `POST /api/broadcast` | Confere um PSBT assinado; com `preview`, não publica. |
| `GET /api/fees` | Taxa estimada ao vivo para 2 blocos. |
| `GET /api/events?session=…` | Upgrade de WebSocket para atualizações ao vivo. |
| `GET /api/health` | Configuração efetiva do Electrum e flags do serviço. |

### `POST /api/wallet`

```json
{ "watch": [{ "account_type": "bip84", "chain": 0, "idx": 0,
  "address": "bc1...", "path": "m/84'/0'/0'/0/0",
  "script": "0014...", "pub": "02..." }],
  "wallet_id": "64 caracteres hex", "fingerprint": "8 caracteres hex",
  "version_type": "xpub", "session": "opcional" }
```

O corpo leva os endereços já derivados pelo navegador; a xpub não entra na
requisição. `wallet_id` é a identidade aleatória da carteira naquela sessão e
`fingerprint` é a da conta, usada na origem BIP32 do PSBT. O Worker consulta
os scripthashes, fecha a margem de **50 endereços vazios por ramo** e devolve
`watch_status`:

- `watch_status.gap`: sempre 50;
- `watch_status.complete`: a margem já está fechada;
- `watch_status.branches["bip84:0"]`: `last_used`, `max_idx`, `next` e `need`.
  Se `need > 0`, a tela deriva `next .. next + need - 1` e repete.

Depois do primeiro passo, a tela pode mandar só `session` nas rotas de envio;
o Durable Object guarda o conjunto enquanto a sessão existir. Se a sessão
cair (**409**), a tela refaz a derivação e o `POST /api/wallet`.

O payload final contém `detected_type`, `balance`, `types`, `addresses`,
`transactions`, `warnings`, `updated_at` e `watch_status`. `types` sempre tem
os quatro itens na ordem BIP86, BIP84, BIP49, BIP44; `addresses` traz só os
usados; `transactions` tem uma entrada por `txid`, com taxa, direção, endereços
e elegibilidade de CPFP; `session` é o id aleatório do Durable Object.

A rota ainda aceita o corpo antigo com `xpub` por compatibilidade, mas a tela
não o envia. O fluxo documentado e testado é o `watch`.

### `POST /api/raw`

```json
{ "session": "opcional" }
```

Sem sessão, mande o mesmo `watch` do `/api/wallet`. Devolve
`{ "raw": { "<txid>": "<hex>", ... } }`; o navegador confere os UTXOs e monta
o PSBT localmente. O servidor não escolhe moedas nem troco.

### `POST /api/psbt`

Rota legada, mantida para compatibilidade: a tela monta o PSBT no navegador e
não chama este endpoint.

```json
{ "session": "opcional", "address": "bc1...",
  "amount_sats": 50000, "fee_rate": 6 }
```

Sem sessão (dev sem Durable Object), mande `watch`, `wallet_id`,
`fingerprint` e `version_type` no lugar de `session`. `amount_sats` é inteiro;
`fee_rate` é em sat/vB e aceita as casas do estimador (de 0,001 a 10 000).
Valor abaixo de 546 sats é recusado como pó. A resposta traz o `psbt` em
base64, `txid`, `vsize`, `fee_sats`, `fee_sats_at_rate`, `dust_sats`,
`fee_rate`, `total_in`, `total_out`, `amount_sats`, `recipient`, `change` e
`inputs`/`outputs` com os caminhos BIP32 e a classificação `own`.

Com `preview: true` e sem `amount_sats`, devolve o limite de envio:
`available_sats`, `min_sats`, `max_send_sats`, `fee_sats_at_max` e
`vsize_at_max`. Com `amount_sats`, devolve também a taxa e o troco daquele
valor. `quote_rates` acrescenta `quotes` com o custo de cada taxa pedida.

### `POST /api/cpfp`

Rota legada, mantida para compatibilidade: a tela monta o filho de CPFP no
navegador e não chama este endpoint.

```json
{ "session": "opcional", "txid": "...", "fee_rate": 11 }
```

O txid precisa ser de uma transação pendente, com todas as entradas desta
carteira e taxa do pai conferível. O corpo aceita o mesmo `watch` do
`/api/wallet` quando não há sessão. A resposta inclui o `psbt` do filho,
`txid`, `vsize`, `fee_sats`, `parent`, `package`, `input` e `output`. O filho
não tem destino externo; o resto volta para o próximo endereço de troco.

### `POST /api/broadcast`

```json
{ "session": "opcional", "psbt": "cHNidP8...", "preview": true }
```

O PSBT precisa ser v0 e estar assinado pelo Cofre. Sem sessão, mande o mesmo
`watch`. A resposta resume a transação final (`txid`, `vsize` real, `fee_sats`,
`fee_rate`, `total_in`, `total_out`, `inputs`, `outputs`, `warnings`, `rbf`,
`locktime`). Sem `preview`, devolve também `broadcast: true` e `server_txid`;
o hex final nunca volta para o navegador.

### `GET /api/fees?session=…`

Devolve a estimativa ao vivo com `levels.next`, `targets.next`, `sat_per_kvb`,
`sat_per_vb`, `floored`, `relay_min_kvb`, `unit`, `source` e `updated_at`.
Servidor sem estimativa devolve `null` naquele nível. O piso de relay
(`0,1 sat/vB` desde o Bitcoin Core v30) é só um aviso; o valor estimado é
usado como veio.

### `GET /api/events?session=…`

Upgrade de WebSocket. As mensagens são `{ "type": "payload", ... }`,
`{ "type": "progress", ... }` enquanto a varredura roda, ou
`{ "type": "error", ... }` quando o Electrum falha. Sessão sem carteira responde
409.

### `GET /api/health`

Devolve `{ "ok": true, "service": "monitor-btc-electrum", "source":
"electrum", "storage": "nenhum", "realtime": true, "electrum": [...],
"time": "..." }`.

## Segurança

- A xpub é watch-only. **Nunca cole uma `xprv`/`yprv`/`zprv`.** Um vazamento
  da xpub custa privacidade, não fundos.
- A xpub vive só na memória da aba. O Worker recebe o conjunto de endereços
  derivados (usados mais a cauda de 50), nunca a chave estendida; não registra
  o conjunto em log, não o coloca em URL e não tem banco. Um Worker
  comprometido ainda vê esses endereços, os UTXOs e o histórico consultado,
  mas não consegue derivar endereços futuros fora da margem enviada.
- **O código da tela também vem do Worker.** Um Worker comprometido pode
  servir `index.html`/`app.js` alterados e capturar a xpub antes de qualquer
  derivação local; SRI e CSP não ajudam quando a própria página é trocada. A
  derivação local protege contra o servidor que recebe as requisições, não
  contra o servidor que controla o código entregue. Para essa garantia seria
  preciso um cliente baixado e verificado fora do Worker.
- O id da sessão é uma capacidade temporária. Quem tiver o id enquanto a tela
  estiver aberta consegue ler o estado daquela carteira; ele é aleatório e
  deixa de existir quando a última tela fecha.
- O Monitor nunca vê chave privada. O PSBT sai sem assinatura e o Cofre BTC
  faz a conferência que vale antes de assinar.
- O PSBT de envio e o filho de CPFP são montados no navegador com as transações
  cruas; o Worker não escolhe moedas nem troco. O Worker ainda fornece as
  transações cruas e a estimativa, e pode omitir dados ou mentir; a soma local
  é conferida contra o saldo e o Cofre confere o PSBT antes de assinar.
- O resumo da transmissão é estrutural: confere propriedade, valores e
  destinos, mas quem valida as assinaturas é a rede. A conferência do Cofre
  antes de assinar é a que importa.
- Toda resposta leva HSTS, CSP, `X-Frame-Options`, `X-Content-Type-Options`,
  `Referrer-Policy`, `Permissions-Policy`, COOP, COEP e CORP. O
  `public/_headers` dos estáticos e o `SECURITY_HEADERS` de `src/config.js`
  mantêm esses nove valores iguais; um teste confere.
- `wallet-local.js`, `app.js`, `fontes.css` e `style.css` usam SRI. Qualquer edição exige
  recalcular o hash em `public/index.html`, e o `npm test` acusa hash vencido.
  Mantenha a minificação e o Rocket Loader da Cloudflare desligados pelo mesmo
  motivo.

## Testes

```bash
npm test
```

A suíte roda sem rede, com servidor Electrum falso e o núcleo BTC do próprio
projeto:

| Arquivo | Cobre |
| --- | --- |
| `electrum.test.mjs` | Protocolo, pipelining, timeouts e erros. |
| `worker.test.mjs` | Carteira ponta a ponta: saldo, margem, varredura em passos, validação e freio de abuso. |
| `address-totals.test.mjs` | Confirmado, troco próprio pendente e pagamento de terceiro no mempool. |
| `psbt.test.mjs` | Taxa, escolha de entradas, troco, pó, origens BIP32 e assinatura do PSBT. |
| `coin-selection.test.mjs` | Regra de escolha em carteiras aleatórias. |
| `cpfp.test.mjs` | Histórico por txid, PSBT filho e taxa do pacote. |
| `cofre-ui.test.mjs` | Telas do Cofre, as nove colunas de i18n e o hash do CSS embutido. |
| `broadcast.test.mjs` | Conferência e transmissão do PSBT assinado, inclusive pelo Durable Object. |
| `watcher.test.mjs` | Assinaturas, avisos, reconexão, despejo e descarte total. |
| `watch-mode.test.mjs` | Derivação local, margem de 50, transações cruas, PSBT e Durable Object sem xpub. |
| `browser-core.test.mjs` | `wallet-local.js` em dia e paridade de derivação/PSBT/CPFP com o servidor. |
| `hardening.test.mjs` | Tetos de entrada, freio de abuso e Origin do WebSocket. |
| `security-headers.test.mjs` | Cabeçalhos iguais, CSP, SRI e o hash do Cofre neste README. |
| `http-surface.test.mjs` | Status 404 em caminho desconhecido e a superfície somente leitura dos estáticos. |
| `well-known-manifest.test.mjs` | Manifestos ARD/ai-catalog, `rel="ard"` e a rota `.well-known`. |
| `cofre-core.test.mjs` / `cofre-core-parity.test.mjs` | Núcleo embutido do Cofre e paridade com `src/btc-core.js`. |

## Estrutura

```text
.github/assets/          botões de apoio usados por este README
.github/workflows/       CI e publicação de releases do Cofre
public/
  app.js                 cliente do navegador (derivação local, render, WebSocket)
  wallet-local.js        derivação, UTXOs e PSBT locais gerados para o navegador (SRI)
  apple-touch-icon.png   ícone da tela inicial do iOS
  cofre-btc.html         gerador de chave e assinador PSBT standalone e offline
  fontes.css             fonte embutida
  index.html             página publicada
  llms.txt               orientação para modelos de linguagem
  manifest.webmanifest   metadados da PWA instalável
  icon.svg               fonte do ícone (selo redondo de onde saem os PNGs)
  icon-*.png             ícones do app
  LICENCAS-FONTES.txt    licença da fonte (Liberation Mono)
  og-image.png           imagem de prévia do link
  robots.txt             regras para rastreadores (a API fica bloqueada)
  style.css              estilos da interface
  _headers               cabeçalhos de segurança dos estáticos
  .well-known/
    ard.json             manifesto ARD (catálogo de agentes vazio)
    ai-catalog.json      nome anterior, mesmo manifesto
scripts/
  build-icons.mjs        gera os ícones da PWA a partir do icon.svg
  sync-cofre-core.mjs    extrai o núcleo do Cofre para os testes de paridade
  sync-cofre-css.mjs     reinjeta o estilo da skill no Cofre
  sync-browser-core.mjs  gera public/wallet-local.js a partir do núcleo
src/
  btc-core.js            núcleo BTC (chaves, endereços, tx, PSBT, assinatura)
  derivation.js          CKDpub, parse da xpub e os quatro tipos de endereço
  electrum.js            cliente Electrum JSON-RPC sobre cloudflare:sockets
  address-totals.js      conta de UTXO por script
  psbt.js                escolha de entradas, taxa, troco e PSBT (fonte do bundle local)
  broadcast.js           conferência do PSBT assinado e transmissão
  wallet-sync.js         consulta do conjunto local, margem e payload
  watch-set.js           validação dos endereços derivados pelo cliente
  watcher.js             Durable Object: socket, assinaturas, WebSocket
  config.js              ambiente, cabeçalhos de segurança e helpers
  worker.js              rotas
test/
  *.test.mjs             testes automatizados
  fake-electrum.mjs      servidor Electrum falso com notificações
  tx-fixture.mjs         transações cruas montadas com o núcleo BTC
  dev-server.mjs         servidor offline da UI com cenário fixo
  cdp-ui.mjs             conferência opcional em Chromium headless
wrangler.jsonc
package.json
```

## Limites conhecidos

- **Varredura completa a cada abertura.** Sem armazenamento durável, cada
  sessão nova refaz a margem de 50 e baixa de novo as transações usadas.
  Enquanto a sessão está viva, as consultas e os avisos seguintes
  reaproveitam a memória.
- **CPU no navegador.** Abrir a tela deriva cerca de 400 endereços (8 ramos ×
  50) localmente e pesa na CPU da aba; o Worker só consulta os scripthashes.
  O Durable Object só fica acordado enquanto uma tela está aberta.
- **Limite da margem.** Endereços depois de 50 vazios seguidos ficam
  invisíveis; uma varredura interrompida mostra “busca incompleta” em vez de
  apresentar o saldo como final.
- **As assinaturas cobrem os endereços usados e a cauda da margem**, não a
  carteira inteira. Um pagamento além da cauda só aparece numa nova varredura.
- **Sem vigilância 24/7.** Fechar a página encerra a sessão; não há
  monitoramento nem aviso com a tela fechada.
- **Troco reutilizado.** O próximo endereço de troco só avança quando a
  transação é vista no mempool, então dois PSBTs montados antes da primeira
  transmissão usam o mesmo endereço de troco. É um limite de privacidade, não
  de saldo.
- **O PSBT é um retrato.** Não há reserva de moeda. Se outra carteira gastar
  uma entrada antes da assinatura/transmissão, a rede recusa a transação e é
  preciso criar outro PSBT.
- **Polling de segurança.** Sem WebSocket em funcionamento, a tela recarrega
  a cada 30 segundos; cada recarga começa uma varredura completa nova.
- **Estimador de taxa.** O `estimatefee` é histórico: pode ficar acima ou
  abaixo da fila atual. Não há histograma, mediana nem piso econômico; só o
  piso de relay aparece como aviso.
- **Freio de abuso.** 120 pedidos por minuto por IP fora da varredura e 600
  passos de varredura por minuto por IP, com no máximo 6 varreduras
  simultâneas. A varredura tem orçamento próprio; quando ele responde 429, a
  tela espera o `Retry-After` e retoma o mesmo passo, então mesmo uma
  carteira muito grande termina com o ritmo sustentado limitado. O contador
  vive na memória do isolate e não é uma cota global: ele contém rajadas por
  instância do Worker.
- **O Electrum vê os scripthashes consultados** (o TLS esconde do caminho da
  rede, não do servidor). O Cofre continua sendo o assinador que vale.
- **O Worker vê o conjunto enviado**: endereços usados mais a cauda de 50 de
  cada ramo, os UTXOs, os txids e o PSBT assinado no broadcast. A xpub fica
  no navegador, mas um
  Worker comprometido ainda pode mentir sobre saldo, taxa ou censurar; a
  conferência no Cofre é a defesa final antes de assinar.
- **Disponibilidade dos dados.** O navegador confere os UTXOs a partir das
  transações cruas que o Worker devolve, mas não tem nó próprio: um Worker que
  omita uma transação pode fazer o saldo local não fechar; a tela recusa o
  PSBT nesse caso. Um Worker que omita um gasto e ajuste o saldo ainda pode
  induzir um PSBT inválido, que a rede recusa.
- **Só rede principal.** O projeto trabalha com chaves e endereços da mainnet
  do Bitcoin.
- **Sem RBF.** O navegador usa sequence final, então o resumo mostra
  `rbf: false`; o caminho de aceleração é o CPFP.

## Apoie

Se este projeto te ajuda, você pode apoiar o trabalho: https://raelales.com/apoiar
