<p align="left"><sub><b>PT</b> · <a href="README.md">EN</a></sub></p>

<p align="right"><a href="https://raelales.com/apoiar" title="Apoie Rael Ales e seus projetos"><img src=".github/assets/support-pt.svg" alt="Apoie-me — ajude a manter o Monitor BTC atualizado"></a></p>

# Monitor BTC

<!-- Português (Brasil) · [English](README.md) -->

Carteira Bitcoin **watch-only** em Cloudflare Workers. O navegador lê a
**xpub** da conta (ou `zpub`/`ypub`), deriva os endereços e **scripthashes**
localmente e consulta históricos/transações pelo Worker, que só faz proxy do
**Electrum**. O navegador calcula saldo, histórico, UTXOs, PSBT e CPFP; o
Worker só transmite a transação assinada que volta do **Cofre BTC**, o
assinador offline.

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
4. **Enviar BTC**: quantidade, destino e a taxa calculada ao vivo pela fonte
   principal (alvo de 2 blocos), reconsultada a cada 60 segundos. A tela não exibe o host da fonte. Não há escolha de taxa. A quantidade usa máscara de BTC: só
   dígitos, com o ponto entrando da direita para a esquerda. A nota abaixo do
   campo mostra o máximo enviável para aquele destino e aquela taxa. Um
   pedido válido monta o PSBT sozinho; abaixo do pó (0,00000546 BTC) ou acima
   do máximo, a nota explica o motivo.
5. **Transmitir**: importar o PSBT assinado não publica nada. O navegador
   confere que cada entrada é desta carteira, que os valores batem e que todas
   as entradas estão finalizadas. Só então aparecem o resumo e o botão
   **confirmar**. Apenas esse clique entrega a transação final ao proxy.

## Como funciona

### Scanner no navegador

- A **xpub** é lida e derivada só no navegador. O scanner percorre os quatro
  tipos e as duas cadeias (`/0` recebimento, `/1` troco), com a mesma regra de
  **50 endereços vazios por ramo** e próximo endereço `último usado + 1`.
- O navegador calcula os **scripthashes**, manda só eles ao proxy e recebe
  históricos e transações cruas. Com esses dados ele calcula saldo, histórico,
  UTXOs, taxa, troco, PSBT e CPFP localmente.
- O Worker não recebe a xpub nem a lista derivada de endereços/scripts/pubkeys;
  não mantém estado de carteira e não participa da escolha de moedas. As
  transações cruas que ele devolve contêm os scripts públicos das transações.

### Proxy do Electrum

`POST /api/proxy` aceita um lote pequeno de chamadas JSON-RPC do Electrum, com
uma lista fechada de métodos: `blockchain.scripthash.get_history`,
`blockchain.scripthash.get_mempool`, `blockchain.transaction.get`,
`blockchain.estimatefee` e `blockchain.transaction.broadcast`. Os parâmetros
são validados (scripthash/txid de 64 hex, hex de transação com teto). O Worker
abre a conexão, repassa as chamadas e fecha; não grava nada.

O Electrum vê os scripthashes, txids, IP e horário. O Worker vê a mesma coisa
mais as transações cruas e a transação assinada no broadcast; as transações
cruas incluem os scripts públicos delas. Não há Esplora, banco, D1/KV/R2 nem
chave privada.

### Tempo real

O Durable Object `ProxyWatcher` segura a conexão Electrum reaproveitada pelo
proxy e guarda apenas o conjunto de **scripthashes** assinado pela tela. Quando o Electrum avisa uma mudança, ele envia
`{ "type": "scripthash", "scripthash": "..." }`; o navegador reconsulta o
histórico no proxy e recalcula tudo. Sem tela aberta, a conexão e as
assinaturas são descartadas. Não há xpub, endereços ou scanner no objeto.

### Taxa

`GET /api/fees` usa a conexão Electrum principal, devolve os níveis, o piso de
relay e `sources` no JSON (sem exibir host na tela), com cache curto para não
reabrir conexão a cada minuto. A taxa final e o PSBT continuam sendo calculados
no navegador. O Worker ainda é uma fonte de dados e pode mentir.

### PSBT e CPFP

- O navegador escolhe UTXOs confirmados e o próprio troco pendente, calcula a
  vsize, a taxa, o troco e o pó, e escreve o PSBT v0.
- Toda entrada leva `witness_utxo`, origem BIP32 e a transação anterior inteira
  (`non_witness_utxo`); o Cofre confere valor, script, destino e taxa antes de
  assinar.
- O CPFP também é montado no navegador: ele soma pai e ancestrais pendentes,
  calcula a taxa do filho e manda o resto para o próximo troco.
- O arquivo assinado volta para a tela; a conferência de entradas, valores,
  finalização e taxa é feita localmente. Só então o hex final é enviado ao
  proxy para `blockchain.transaction.broadcast`.

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
`public/`, `test/`. Não há banco nem schema. A entrada de produção é
`src/worker-proxy.js`; o `wrangler.jsonc` declara a classe `WalletWatcher`
(implementada por `ProxyWatcher`) na migration `v1`.

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

O binding `WATCH` aponta para `WalletWatcher` (o `ProxyWatcher` exportado com
esse nome); a migration `v1` declara a classe como Durable Object com backend
SQLite, o único disponível no plano free. O objeto não chama `storage`; guarda
só scripthashes em memória.

## API

As rotas respondem JSON. Erros usam `{ "error": "..." }`; os status comuns são
400 (requisição inválida), 404/405 (rota ou método desconhecido), 429 (limite de
pedidos), 500 (falha inesperada), 502 (falha do Electrum) e 503 (serviço
desligado ou mal configurado).

| Rota | Função |
| --- | --- |
| `POST /api/proxy` | Lote JSON-RPC permitido do Electrum (scripthash/txid/taxa/broadcast). |
| `GET /api/fees` | Estimativa da fonte principal, com níveis e cache curto. |
| `POST /api/session` | Cria o id do proxy/notificações (Durable Object). |
| `GET /api/events?session=…` | WebSocket que devolve só scripthashes alterados. |
| `GET /api/health` | Configuração efetiva e flags do proxy. |

### `POST /api/proxy`

```json
{ "items": [
  { "method": "blockchain.scripthash.get_history", "params": ["<64 hex>"] },
  { "method": "blockchain.transaction.get", "params": ["<txid>"] }
] }
```

Também aceita um item só, sem `items`. A resposta é
`{ "results": [...], "errors": [null|"..."], ... }`, na ordem pedida. Métodos
permitidos: `blockchain.scripthash.get_history`,
`blockchain.scripthash.get_mempool`, `blockchain.transaction.get`,
`blockchain.estimatefee` e `blockchain.transaction.broadcast`. Broadcast vai
sozinho no lote e exige hex válido com teto de tamanho.

O proxy não aceita xpub, endereços, scripts, pubkeys nem rotas de carteira.

### `GET /api/fees`

Devolve `levels`, `sat_per_vb`, `floored`, `relay_min_kvb`, `sources[]` e
`updated_at`, com cache curto. A tela usa `levels.next` e não mostra o host da
fonte; sem estimativa, responde 502.

### `POST /api/session`

Devolve `{ "session": "<64 hex>" }`; é o id do Durable Object que segura a
conexão reaproveitada do proxy e as notificações. Não contém carteira.

### `GET /api/events?session=…`

Upgrade de WebSocket. O cliente envia
`{ "type": "subscribe", "scripthashes": ["<64 hex>", ...] }`; o objeto assina
no Electrum e devolve `{ "type": "scripthash", "scripthash": "..." }` a cada
mudança. Não há payload de carteira, xpub, endereços ou valores.

### `GET /api/health`

Devolve `{ "ok": true, "service": "monitor-btc-proxy", "source": "electrum",
"storage": "nenhum", "realtime": true, "electrum": [...], "time": "..." }`.

## Segurança

- A xpub é watch-only. **Nunca cole uma `xprv`/`yprv`/`zprv`.** Um vazamento
  da xpub custa privacidade, não fundos.
- A xpub vive só na memória da aba. O Worker recebe **scripthashes**, txids,
  transações cruas e a transação assinada no broadcast; nunca a chave
  estendida nem a lista derivada. As transações cruas contêm scripts públicos.
  Não registra esses dados em log,
  não os coloca em URL e não tem banco.
- **O código da tela também vem do Worker.** Um Worker comprometido pode
  servir `index.html`/`app.js` alterados e capturar a xpub antes de qualquer
  derivação local; SRI e CSP não ajudam quando a própria página é trocada. A
  derivação local protege contra o servidor que recebe as requisições, não
  contra o servidor que controla o código entregue. Para essa garantia seria
  preciso um cliente baixado e verificado fora do Worker.
- O id da sessão é uma capacidade temporária do proxy/notificações: quem tiver
  o id enquanto a tela estiver aberta consegue consultar scripthashes/txids e
  assinar/ver notificações, não ler saldo, endereços ou PSBT. Ele é aleatório e
  deixa de existir quando a última tela fecha.
- O Monitor nunca vê chave privada. O PSBT sai sem assinatura e o Cofre BTC
  faz a conferência que vale antes de assinar.
- O PSBT de envio e o filho de CPFP são montados no navegador com as transações
  cruas; o Worker não escolhe moedas nem troco. O Worker ainda fornece as
  transações cruas e a estimativa, e pode omitir dados ou mentir; a soma local
  é conferida contra o saldo e o Cofre confere o PSBT antes de assinar.
- O resumo da transmissão é calculado no navegador: confere entradas da
  carteira, valores, destinos e taxa, mas quem valida as assinaturas é a rede.
  A conferência do Cofre antes de assinar é a que importa.
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
projeto. Os testes de `worker`, `watcher`, `watch-mode`, `broadcast`, `cpfp` e
`hardening` usam os fixtures antigos de `test/legacy/`; a produção é coberta
por `proxy.test.mjs`, `proxy-watcher.test.mjs` e `browser-core.test.mjs`.

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
| `watch-mode.test.mjs` | Scanner local, margem de 50, transações cruas e PSBT; rotas legadas em teste. |
| `proxy.test.mjs` | Proxy: lote permitido, broadcast, taxas e ausência de rotas de carteira. |
| `proxy-watcher.test.mjs` | Durable Object novo: só scripthashes, sem carteira. |
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
  wallet-sync.js         scanner local: derivação, margem, saldo, PSBT e CPFP
  worker-proxy.js        produção: proxy Electrum + sessão + fees + assets
  proxy-watcher.js       produção: Durable Object só de scripthashes
  config.js              ambiente, cabeçalhos de segurança e helpers
test/
  *.test.mjs             testes automatizados
  legacy/                fixtures do worker/watcher antigos, só para testes
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
- **As assinaturas cobrem os scripthashes usados e a cauda da margem**, não a
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
  abaixo da fila atual. A tela usa a fonte principal e um cache curto; não há
  histograma nem piso econômico; só o piso de relay aparece como aviso.
- **Freio de abuso.** 120 pedidos por minuto por IP e 20 000 itens de proxy por
  minuto por IP. O contador vive na memória do isolate e não é uma cota
  global: ele contém rajadas por instância. Um lote de varredura grande pode
  ser recusado com 429; a tela tenta de novo depois do `Retry-After`.
- **O Electrum vê os scripthashes consultados** (o TLS esconde do caminho da
  rede, não do servidor). O Cofre continua sendo o assinador que vale.
- **O Worker vê scripthashes, txids, transações cruas e a transação assinada
  no broadcast**; as transações cruas contêm scripts públicos. Não recebe xpub
  nem a lista derivada de endereços/pubkeys. Um Worker
  comprometido ainda pode mentir sobre dados, taxa ou censurar; a conferência
  no Cofre é a defesa final antes de assinar.
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
