<p align="left"><sub><b>PT</b> · <a href="README.md">EN</a></sub></p>

<p align="right"><a href="https://raelales.com/apoiar" title="Apoie Rael Ales e seus projetos"><img src=".github/assets/support-pt.svg" alt="Apoie-me — ajude a manter o Monitor BTC atualizado"></a></p>

# Monitor BTC

<!-- Português (Brasil) · [English](README.md) -->

Carteira Bitcoin **watch-only** em Cloudflare Workers. Você entrega a **xpub**
da conta (ou `zpub`/`ypub`), o Worker deriva os endereços públicos e lê o
saldo, os endereços de recebimento e o histórico de transações de um servidor
**Electrum**. Ele também monta um PSBT sem assinatura e transmite a transação
assinada que volta do **Cofre BTC**, o assinador offline.

Nada fica guardado: nem dados da carteira no navegador, nem banco de dados na
Cloudflare.

## O que é

- Uma carteira **watch-only**: nunca vê chave privada e não gasta sozinha.
- Uma **interface de página única** com três telas: carteira, histórico e
  sobre. A interface está traduzida em português, inglês, espanhol, francês,
  italiano, alemão, neerlandês, catalão e galego. O automático segue o
  navegador; a escolha manual vale só para a sessão.
- Um **montador de PSBT**: valor, destino e a taxa estimada ao vivo bastam
  para produzir um PSBT v0 sem assinatura, com troco.
- Um **visualizador de histórico**: transações agrupadas pelo `txid`, do
  mempool para o bloco mais recente, com direção, valores, taxa e os
  endereços da carteira que participam. Uma transação pendente pode ser
  acelerada por CPFP.
- Um **portão de transmissão**: o PSBT assinado é conferido contra a carteira
  antes de qualquer coisa ir para a rede. A publicação só acontece depois do
  clique explícito em **confirmar**.

Ele não é nó completo, não é carteira de custódia, não substitui uma hardware
wallet e não mantém vigilância em segundo plano com a tela fechada.

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
   carteira que participam. A transação pendente que ainda tem uma saída
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
  quatro tipos. Cada ramo para depois de **50 endereços consecutivos sem
  uso**. O próximo endereço é sempre `último usado + 1`.
- A varredura acontece em passos: cada requisição deriva no máximo **200
  endereços novos** e devolve o progresso; a tela pede o próximo passo. Só o
  último passo devolve o payload final.

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
`cloudflare:sockets`. O Worker deriva cada script localmente, então consulta
por `scripthash` (`blockchain.scripthash.get_history`,
`blockchain.scripthash.get_mempool`, `blockchain.transaction.get`) e faz a
conta de UTXO aqui. Não há Esplora, nem blockchain.info, nem chave privada em
lugar nenhum.

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
  endereços derivados, cache de transações, último payload e a xpub. Não há
  alarme nem storage para restaurar.
- Sessão perdida responde **409**; a tela reenvia a xpub e reabre o canal. Se o
  objeto for despejado ou o Worker for republicado, a próxima requisição
  refaz a varredura.

### Taxa e PSBT

- A única fonte de taxa é o `blockchain.estimatefee` com alvo de **2 blocos**
  (o Bitcoin Core se recusa a estimar 1 bloco). O valor vem em BTC/kvB e é
  convertido para sat/kvB exato; só a taxa final, em satoshis, é arredondada
  para cima.
- O montador escolhe primeiro as saídas confirmadas e depois o seu próprio
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
ainda tem uma saída própria não gasta, `POST /api/cpfp` monta o PSBT filho. O
servidor soma a taxa e a vsize do pai e dos ancestrais ainda no mempool,
calcula a taxa do filho para o pacote atingir a taxa pedida e manda o resto
para o próximo endereço de troco. O pai não muda. Assine o filho no Cofre BTC
e importe em **carteira → transmitir**, como um envio normal.

### Transmissão

`POST /api/broadcast` recebe o PSBT assinado (base64 ou hex) e confere:

- cada entrada gasta um script derivado desta xpub;
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

O assinador é um arquivo HTML único, `public/cofre-btc.html`, servido como
download em `/cofre-btc` (ou `/cofre-btc.html`). Ele funciona offline, no
navegador, sem servidor. Confere a conta, a derivação, a chave pública, o
script, as saídas e a taxa antes de assinar. A chave privada nunca passa pelo
Monitor.

Antes de abrir, confira o hash publicado: sha256 do arquivo publicado é
`77e7901a7be44a7fe2a8d4d340607accba88165705b3fc894ec1a62953876264` — rode
`sha256sum cofre-btc.html` no arquivo baixado. A tela “sobre” do Cofre pede a
mesma conferência. Qualquer edição no Cofre exige atualizar este valor; o
`npm test` acusa hash vencido.

A tela “chave” tem um campo opcional **frase secreta**: ele entra no PBKDF2
do BIP39 depois das 24 palavras, não muda a frase e muda a seed, as contas e
os endereços. Editar ou apagar o campo refaz a derivação; vazio, vale a
passphrase vazia. Quem perder a frase secreta perde a carteira que ela
define.

Versões anteriores do Cofre também gravavam as jogadas como coordenadas
(`a0`–`z5`) e mandavam anotar essa lista. Essa entrada foi removida em favor
da frase de 24 palavras. Uma lista de coordenadas guardada ainda recupera a
chave, desde que a frase secreta esteja vazia (como nas versões daquela
época): cada `letra × 10 + dígito` (com `a` = 0, …, `z` = 25) marca `1` naquela
posição dos 256 bits e todas as outras posições valem `0`; informe os 256
dígitos em qualquer ferramenta BIP39 com a lista em inglês para chegar às
mesmas 24 palavras.

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
npm run dev          # wrangler dev, com a configuração real do Electrum
npm test             # todos os *.test.mjs, sem rede
```

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
`public/`, `test/`. Não há banco, schema nem migration para aplicar.

Para o **Workers Builds**, deixe o diretório raiz vazio (a raiz do
repositório), use `npm ci` como build e `npx wrangler deploy` como deploy.
`workers_dev` e `preview_urls` estão desligados, então o Worker responde só no
domínio personalizado. A observabilidade está desligada para não guardar log
de invocação na Cloudflare.

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
| `POST /api/psbt` | Monta o PSBT de envio sem assinatura; com `preview`, devolve só limites/cotação. |
| `POST /api/cpfp` | Monta o PSBT filho de CPFP para uma transação pendente. |
| `POST /api/broadcast` | Confere um PSBT assinado; com `preview`, não publica. |
| `GET /api/fees` | Taxa estimada ao vivo para 2 blocos. |
| `GET /api/events?session=…` | Upgrade de WebSocket para atualizações ao vivo. |
| `GET /api/health` | Configuração efetiva do Electrum e flags do serviço. |

### `POST /api/wallet`

```json
{ "xpub": "xpub...", "session": "opcional", "scan": "step" }
```

Sem `scan`, varre tudo e devolve o payload final. Com `scan: "step"`, deriva no
máximo 200 endereços novos e devolve o progresso (`scanning`, `has_more`,
`progress`, `watch`, `session`); a tela repete a chamada até `has_more` ser
falso.

O payload final contém:

- `detected_type`, `balance` (`detected`, `total`, `pending_in`,
  `pending_out`), `types`, `addresses`, `transactions`, `warnings` e
  `updated_at`;
- `types` sempre tem os quatro itens na ordem BIP86, BIP84, BIP49, BIP44,
  cada um com o próximo endereço de recebimento, o próximo de troco, o saldo
  do tipo e `detected`;
- `addresses` traz só endereços usados, da atividade mais recente para a mais
  antiga;
- `transactions` tem uma entrada por `txid`, com `pending`, `height`,
  `direction`, valores recebidos/enviados/taxa, contagem de entradas e saídas,
  `addresses` da carteira e a elegibilidade/saída do CPFP;
- `session` é o id aleatório do Durable Object usado nas próximas
  requisições.

### `POST /api/psbt`

```json
{ "xpub": "xpub...", "session": "opcional", "address": "bc1...",
  "amount_sats": 50000, "fee_rate": 6 }
```

`amount_sats` é inteiro; `fee_rate` é em sat/vB e aceita as casas do estimador
(de 0,001 a 10 000). Valor abaixo de 546 sats é recusado como pó. A resposta
traz o `psbt` em base64, `txid`, `vsize`, `fee_sats`, `fee_sats_at_rate`,
`dust_sats`, `fee_rate`, `total_in`, `total_out`, `amount_sats`, `recipient`,
`change` e `inputs`/`outputs` com os caminhos BIP32 e a classificação `own`
(`externo`, `recebimento` ou `troco`).

Com `preview: true` e sem `amount_sats`, devolve o limite de envio:
`available_sats`, `min_sats`, `max_send_sats`, `fee_sats_at_max` e
`vsize_at_max`. Com `amount_sats`, devolve também a taxa e o troco daquele
valor. `quote_rates` acrescenta um array `quotes` com o custo de cada taxa
pedida para o mesmo valor.

### `POST /api/cpfp`

```json
{ "xpub": "xpub...", "session": "opcional",
  "txid": "...", "fee_rate": 11 }
```

O txid precisa ser de uma transação pendente, com todas as entradas desta
carteira e taxa do pai conferível. A resposta inclui o `psbt` do filho,
`txid`, `vsize`, `fee_sats`, `parent`, `package`, `input` e `output`. O filho
não tem destino externo; o resto volta para o próximo endereço de troco.

### `POST /api/broadcast`

```json
{ "xpub": "xpub...", "session": "opcional",
  "psbt": "cHNidP8...", "preview": true }
```

O PSBT precisa ser v0 e estar assinado pelo Cofre. A resposta resume a
transação final (`txid`, `vsize` real, `fee_sats`, `fee_rate`, `total_in`,
`total_out`, `inputs`, `outputs`, `warnings`, `rbf`, `locktime`). Sem
`preview`, devolve também `broadcast: true` e `server_txid`; o hex final nunca
volta para o navegador.

### `GET /api/fees?session=…`

Devolve a estimativa ao vivo com `levels.next`, `targets.next`, `sat_per_kvb`,
`sat_per_vb`, `floored`, `relay_min_kvb`, `unit`, `source` e `updated_at`.
Servidor sem estimativa devolve `null` naquele nível. O piso de relay
(`0,1 sat/vB` desde o Bitcoin Core v30) é só um aviso; o valor estimado é
usado como veio.

### `GET /api/events?session=…`

Upgrade de WebSocket. As mensagens são `{ "type": "payload", ... }`,
`{ "type": "progress", ... }` enquanto a varredura roda, ou
`{ "type": "error", ... }` quando o Electrum falha. Sessão sem a xpub responde
409.

### `GET /api/health`

Devolve `{ "ok": true, "service": "monitor-btc-electrum", "source":
"electrum", "storage": "nenhum", "realtime": true, "electrum": [...] }`.

## Segurança

- A xpub é watch-only. **Nunca cole uma `xprv`/`yprv`/`zprv`.** Um vazamento
  da xpub custa privacidade, não fundos.
- A xpub é a credencial. Ela vive só na memória da aba e no Durable Object
  enquanto a sessão está aberta. O Worker não a registra em log, não a coloca
  em URL e não tem banco.
- O id da sessão é uma capacidade temporária. Quem tiver o id enquanto a tela
  estiver aberta consegue ler o estado daquela carteira; ele é aleatório e
  deixa de existir quando a última tela fecha.
- O Monitor nunca vê chave privada. O PSBT sai sem assinatura e o Cofre BTC
  faz a conferência que vale antes de assinar.
- O resumo da transmissão é estrutural: confere propriedade, valores e
  destinos, mas quem valida as assinaturas é a rede. A conferência do Cofre
  antes de assinar é a que importa.
- Toda resposta leva HSTS, CSP, `X-Frame-Options`, `X-Content-Type-Options`,
  `Referrer-Policy`, `Permissions-Policy`, COOP, COEP e CORP. O
  `public/_headers` dos estáticos e o `SECURITY_HEADERS` de `src/config.js`
  precisam continuar iguais; um teste confere.
- `app.js`, `fontes.css` e `style.css` usam SRI. Qualquer edição exige
  recalcular o hash em `public/index.html`, e o `npm test` acusa hash vencido.
  Mantenha a minificação e o Rocket Loader da Cloudflare desligados pelo mesmo
  motivo.
- Para valores altos, use hardware wallet e um nó/Electrum próprio.

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
| `broadcast.test.mjs` | Conferência e transmissão do PSBT assinado, inclusive pelo Durable Object. |
| `watcher.test.mjs` | Assinaturas, avisos, reconexão, despejo e descarte total. |
| `hardening.test.mjs` | Tetos de entrada, freio de abuso e Origin do WebSocket. |
| `security-headers.test.mjs` | Cabeçalhos iguais, CSP, SRI e o hash do Cofre neste README. |
| `cofre-core.test.mjs` / `cofre-core-parity.test.mjs` | Núcleo embutido do Cofre e paridade com `src/btc-core.js`. |

## Estrutura

```text
.github/assets/          botões de apoio usados por este README
public/
  app.js                 cliente do navegador (xpub, varredura, render, WebSocket)
  cofre-btc.html         assinador PSBT standalone e offline
  fontes.css             fonte embutida
  index.html             página publicada
  manifest.webmanifest   metadados da PWA instalável
  sw.js                  service worker mínimo (sem cache), para a instalação
  icon.svg               fonte do ícone (selo redondo de onde saem os PNGs)
  icon-*.png             ícones do app
  og-image.png           imagem de prévia do link
  style.css              estilos da interface
  _headers               cabeçalhos de segurança dos estáticos
scripts/
  build-icons.mjs        gera os ícones da PWA a partir do icon.svg
  sync-cofre-core.mjs    extrai o núcleo do Cofre para os testes de paridade
src/
  btc-core.js            núcleo BTC (chaves, endereços, tx, PSBT, assinatura)
  derivation.js          CKDpub, parse da xpub e os quatro tipos de endereço
  electrum.js            cliente Electrum JSON-RPC sobre cloudflare:sockets
  address-totals.js      conta de UTXO por script
  psbt.js                escolha de entradas, taxa, troco e PSBT de envio
  broadcast.js           conferência do PSBT assinado e transmissão
  wallet-sync.js         varredura por margem, em passos, e payload da carteira
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
- **CPU e custo.** Abrir uma tela deriva cerca de 400 endereços (8 ramos ×
  50) e pesa na CPU; use um plano de Workers cujo limite de CPU cubra a
  varredura. O Durable Object só fica acordado enquanto uma tela está aberta.
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
- **Freio de abuso.** 120 pedidos por minuto por IP e no máximo 6 varreduras
  simultâneas. Cada passo da varredura conta como um pedido, então carteiras
  muito grandes podem atingir o limite mesmo sem abuso.
- **O Electrum vê os scripthashes consultados** (o TLS esconde do caminho da
  rede, não do servidor). O Cofre continua sendo o assinador que vale.
- **Só rede principal.** O projeto trabalha com chaves e endereços da mainnet
  do Bitcoin.
- **Sem RBF.** O montador usa sequence final, então o resumo mostra
  `rbf: false`; o caminho de aceleração é o CPFP.

## Apoie

Se este projeto te ajuda, você pode apoiar o trabalho: https://raelales.com/apoiar
