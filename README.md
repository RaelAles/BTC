# Monitor BTC — xpub, saldo e endereços usados (Worker + Durable Object + Electrum)

Carteira watch-only e **sem armazenamento**: você entrega a **xpub**, o Worker
deriva os endereços públicos na hora e consulta um servidor **Electrum**. A
tela mostra:

1. **saldo disponível** da carteira (o que dá para gastar agora, somando
   todos os tipos de conta) logo abaixo do campo da xpub, centralizado em
   verde de sucesso, em BTC, com o horário da última atualização em nota.
   Entra a saída confirmada ainda não gasta e o **troco de uma transação sua
   ainda no mempool** — ele é uma saída da mesma transação do envio, confirma
   junto com ela e pode ser gasto antes. Pagamento de terceiro no mempool não
   entra: só conta depois de confirmar. A linha abaixo mostra o que está fora
   do número: `pendente entrada +…` para terceiro a caminho e `pendente saída
   -…` para o que já deixou a conta (destino + taxa) numa transação pendente;
2. **um endereço de recebimento por tipo**, os quatro, inclusive os zerados:
   sempre o primeiro índice sem uso daquele ramo (`último usado + 1`), para
   escolher o que o pagador aceita. O rótulo de cada linha é só o BIP
   (`bip86`, `bip84`, `bip49`, `bip44`), com o botão de copiar ao lado do
   endereço — o clique no próprio endereço também copia;
3. **lista de endereços já usados** (recebimento e troco), do uso mais
   recente para o mais antigo, com **recebido** (com sinal `+`, no verde do
   sucesso), **enviado** (com sinal `-`, no tom do erro) e **saldo** de cada
   um, cinco por página, na tela **histórico**. **recebido** e **enviado**
   somam o confirmado e o mempool do endereço, sem marca entre parênteses; a
   pendência é dita só pela etiqueta `[ pendente ]`, no tom de aviso
   (`--warning`), que o endereço com atividade no mempool leva ao lado do
   ramo. O **saldo** é o disponível do endereço (inclui o troco pendente
   dele);
4. **enviar BTC** abaixo dos endereços: quantidade, destino e taxa em um
   **grupo de níveis** rotulado pelo **prazo médio de confirmação** —
   `~10m`, `~30m`, `~1h` e `~1d` —, na mesma linha do recado do máximo (o
   recado à esquerda e a taxa à direita; em tela estreita a taxa desce e
   continua à direita), desenhado como os botões **copiar** dos endereços:
   caixa alta, `--accent` em repouso, `--fg` no hover e `--support` no
   escolhido, sem moldura. Cada nível traz o **percentual da taxa sobre o valor
   enviado** à direita do prazo, em `--dim`, e um `|` em `--sep` separa dois
   níveis. Quando dois níveis caem na mesma taxa (o
   servidor devolve a mesma estimativa para alvos vizinhos), a tela mostra só
   o mais rápido: a taxa é idêntica, então o nível mais lento não acrescenta
   escolha. A taxa de cada nível vem **ao vivo** pelo `/api/fees` e é ela que
   o PSBT usa, exatamente como o servidor devolveu — inclusive abaixo de
   1 sat/vB, sem piso de relay.
   O seletor só aparece quando há valor e destino válidos; sem os dois, ou
   com o destino recusado, o custo não teria o que cotar. Os níveis são
   rádios nativos: clique ou setas escolhem, e o PSBT usa a taxa do nível
   escolhido. A escolha começa
   no nível de menor taxa (`~1d`) e, quando ele perde a estimativa, passa
   para o de menor taxa entre os disponíveis; a escolha feita à mão continua
   valendo enquanto aquele nível existir. A quantidade usa
   máscara de BTC: o usuário digita só dígitos e o ponto entra sozinho, da
   direita para a esquerda (`1` → `0.00000001`, `12345678` → `0.12345678`).
   A nota abaixo do campo mostra o máximo enviável para o destino e a taxa
   escolhidos. O PSBT é montado sozinho assim que destino, valor e taxa
   formam um pedido válido, e é remontado a cada mudança (com um respiro de
   digitação); fora do intervalo válido não há o que montar: abaixo do pó
   (0.00000546 BTC) ou acima do máximo enviável (saldo disponível − taxa), a
   nota do valor explica o motivo. O destino que passa no formato mas o
   servidor recusa (checksum, rede) não vira "máximo indisponível": é erro do
   campo
   destino, no recado geral, com o campo em `aria-invalid`, e esconde o
   seletor de taxa e o PSBT. Trocar o destino também tira o PSBT da tela;
   valor e taxa mantêm o retrato anterior, marcado como antigo e sem
   download, até a resposta do pedido novo. O PSBT sai sem assinatura, com
   troco, em base64, e aparece só quando a montagem termina, disponível como
   arquivo no botão
   **baixar**, ao fim do bloco; a tela mostra os detalhes (saída,
   destino, troco, endereço, pó, taxa, txid, vsize, rbf e agendado) na mesma tabela de
   leitura do "receber", sem o base64 como campo. O destino que não pertence
   à carteira leva `[ externo ]` no fim do endereço, no tom do `[ atenção ]`;
   o destino de um endereço da própria carteira e o troco ficam sem marcador.
   A linha **pó** só aparece
   quando o troco não foi criado: ela mostra quanto do valor ficou na taxa
   por isso, para a taxa (que já inclui esse resto) não parecer erro, e fica
   sem sinal porque é uma parte da taxa, não uma segunda saída. Os outros
   valores usam a marcação de valor do sistema (VG-COR-16): o que sai (saída
   e taxa) leva `-` em `--error` e o que volta (troco) leva `+`
   em `--success`, com o sinal no texto para a cor ser reforço, não o único
   sinal. Cada valor leva também, depois de um divisor `|`, em `--dim`, a
   fatia que representa do saldo disponível da conta (o mesmo número de
   `v-total`): a saída, o troco, a taxa e o pó usam todos essa mesma base,
   para a tabela ler como um recorte do saldo, e aparecem como
   `-0.00050000 | 25.4%` e
   `-0.00005000 | 2.54%`, com as casas pelo tamanho (uma acima de 10%, duas
   acima de 1% e três abaixo; o que arredondaria para zero fica `<0.001%`).
   A taxa sobre o valor **enviado** é outra pergunta e fica no seletor de taxa,
   não aqui. A soma das linhas não fecha 100%: o que não foi escolhido para a
   transação continua na conta. O destino e o troco são
   o que o servidor diz ter montado — o
   navegador não lê o base64 —, então a tabela serve para comparar: se o
   destino ou o valor montados diferirem do formulário, ou se aparecer mais
   de uma saída externa, surge um aviso apontando para a revisão do
   `cofre-btc.html`, que é a conferência que vale. Se a transação gastar
   troco pendente (gasto encadeado), o aviso lembra que ela confirma depois —
   e junto — da transação anterior.
   Quem assina é o `cofre-btc.html` (Cofre BTC), offline; o Monitor BTC nunca
   vê chave privada.
5. **transmitir** abaixo do envio: o botão **importar psbt** abre o seletor
   do PSBT assinado que volta do `cofre-btc.html`. Escolher o arquivo **não**
   publica: o servidor confere o arquivo contra a carteira (cada entrada tem
   de ser sua, o valor tem de bater, todas as entradas têm de estar
   finalizadas) e só então aparecem o subtítulo **transmitir**, com o resumo
   no mesmo desenho do PSBT (um par saída/destino por pagamento — o destino
   externo leva `[ externo ]` — e um par troco/endereço por troco, taxa,
   txid, vsize, rbf, agendado e, por último, o arquivo), e o botão
   **confirmar**; o botão do seletor some assim que o
   arquivo é escolhido e, se a conferência falhar, o arquivo é descartado
   com o motivo no lugar, e o seletor volta de imediato para a próxima
   tentativa (o **cancelar** só existe com o arquivo aprovado, ao lado do
   **confirmar**). Só o clique em **confirmar** publica a transação
   final no
   Electrum; depois disso o botão vira **transmitida** e o resumo fica na
   tela. O arquivo e o resumo vivem só na memória da tela, como o resto.

Nada fica guardado: nem a xpub no navegador, nem endereços, transações ou
saldo no Cloudflare. O PSBT assinado importado também não é gravado. Enquanto
a tela está aberta o saldo é acompanhado em **tempo real**
(`scripthash.subscribe` + WebSocket); quando a última tela
fecha, a conexão, as assinaturas, os endereços derivados, o cache de
transações e a xpub são descartados. A próxima abertura começa do zero.

A fonte de saldo e histórico é **apenas um servidor Electrum**, consultado do
mesmo jeito que o Electrum e o Sparrow fazem: por `scripthash`,
`blockchain.scripthash.get_history` + `get_mempool` + `blockchain.transaction.get`,
com o parse da transação e a conta de UTXO feitos aqui. Não há Esplora, nem
blockchain.info, nem chave privada em lugar nenhum.

> **Layout do repositório.** A raiz é o projeto do Worker (é ela que o
> Cloudflare publica): `wrangler.jsonc`, `src/`, `public/`, `test/`. Os
> arquivos soltos na mesma raiz não entram no deploy: `cofre-btc.html` é o
> Cofre BTC (offline, assina PSBT), `projeto-2.html` é a UI standalone antiga
> (consulta fontes públicas direto no navegador) e `teste-*.psbt` são
> fixtures de teste. A página publicada é `public/index.html`.

## O que o Worker faz

- `POST /api/wallet` com `{ "xpub": "xpub..." }` (e, opcionalmente,
  `"session"` e `"scan": "step"`). **O campo da tela só aceita chave estendida pública de
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
- **Varredura com margem fixa de 50**: deriva `/0/i` e `/1/i`, consulta o
  histórico de cada endereço e só para depois de 50 endereços seguidos sem
  uso em cada ramo. Não há teto de endereços: a varredura segue enquanto
  houver atividade. O próximo endereço é `último usado + 1`.
- **Varredura em passos**: cada requisição deriva no máximo 200 endereços
  novos e devolve o progresso; a tela pede o próximo passo. Só o último
  passo devolve o saldo final.
- **Saldo por UTXO**: baixa as transações cruas dos endereços usados, faz o
  parse local e soma saídas que pagam a carteira menos as saídas já gastas.
  `recebido` e `enviado` são o confirmado. O saldo exibido é o **disponível**:
  saída confirmada ainda não gasta mais o troco de uma transação nossa ainda
  pendente (a saída que volta na mesma transação do envio, gastável antes de
  confirmar). Entrada de terceiro no mempool fica fora e aparece como
  `pending_in`; o que já saiu de fato (destino + taxa) aparece como
  `pending_out` líquido.
- **UTXOs e PSBT**: a mesma conta guarda as saídas ainda não gastas. Com
  elas, `POST /api/psbt` escolhe entradas entre as **confirmadas e o troco
  pendente de uma transação sua** (gasto encadeado; pagamento de terceiro no
  mempool não entra), as confirmadas primeiro e as maiores dentro de cada
  grupo, calcula a taxa pela vsize estimada (um limite superior do
  tamanho real, ver “a vsize é um limite superior” abaixo), deriva o próximo
  endereço de troco e monta um **PSBT v0** sem assinatura. Cada entrada leva
  `witness_utxo` e a origem BIP32; a saída de troco e o destino da própria
  carteira também levam a origem na saída, para o assinador reconhecê-los sem
  varrer as contas. Toda entrada leva também o `non_witness_utxo` (a
  transação anterior inteira), obrigatório no p2pkh, para o assinador
  conferir o valor; p2sh-p2wpkh leva o `redeem_script`. O pó (abaixo de
  0.00000546 BTC) não vira
  saída de troco: é somado à taxa, e a resposta separa esse resto
  (`dust_sats`) da tarifa (`fee_sats_at_rate`) para a tela explicar a
  diferença.
- **Transmissão**: `POST /api/broadcast` recebe o PSBT assinado e confere
  cada entrada contra os scripts/UTXOs da carteira, exige as entradas
  finalizadas, classifica as saídas (destino, troco, externo) e calcula a
  taxa da transação final. Sem `preview`, publica com
  `blockchain.transaction.broadcast`; com sessão, pela conexão já aberta, e o
  `scripthash.subscribe` atualiza o saldo em seguida. É o único ponto que
  entrega a transação a um servidor, e só no clique em **confirmar**.
- **Taxa ao vivo**: `GET /api/fees` pergunta `blockchain.estimatefee` para
  144, 6, 3 e 1 bloco, que a tela mostra como prazo médio (`~1d`, `~1h`,
  `~30m` e `~10m`, a 10 min por bloco), e converte BTC/kvB em sat/kvB
  inteiro — o valor exato que o servidor devolve, sem arredondar. A tela
  reconsulta a cada 60 s enquanto está aberta e mostra o percentual de cada
  nível para o valor e o destino digitados.
- **Todos os endereços usados** dos quatro tipos vão para a resposta; os
  outros tipos também entram no saldo disponível (união), não só o detectado.
- **Sem cache durável**: cada consulta deriva e consulta de novo. Enquanto a
  sessão do Durable Object estiver viva (tela aberta) a conexão, os endereços
  já derivados e o cache de transações ficam em memória; na consulta seguinte
  só o que mudou é baixado.
- **Tempo real**: um Durable Object por sessão de tela segura a conexão com o
  servidor, assina os endereços usados e a cauda de 50 de cada ramo e
  empurra o estado novo por WebSocket quando algo muda (detalhes em “Tempo
  real”).
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

A margem de 50 endereços vazios e o lote de 200 endereços por passo são
fixos no código (`src/wallet-sync.js`); não vêm do ambiente.

Os três servidores do padrão foram testados com `server.version`,
`scripthash.get_history`, `scripthash.get_mempool` e `transaction.get` (hex):
Blockstream (electrs 0.4.1) e DIYnodes (Fulcrum 2.1.2). Servidores com
certificado auto-assinado (bitcoin.lu.ke, electrum.emzy.de, …) não servem via
TLS aqui.

`GET /api/health` mostra a configuração efetiva.

## Margem de vazios (fixa em 50)

Vale **por ramo** (tipo de conta × cadeia: 4 tipos × recebimento/troco = 8
ramos). Em cada ramo a varredura começa no índice 0 e só para depois de 50
endereços consecutivos sem uso — "usado" é ter alguma entrada em
`get_history`/`get_mempool`, então um endereço que recebeu e gastou tudo
continua contando.

- os 8 ramos são estendidos na mesma rodada, em um lote de requisições;
- endereço já derivado nesta sessão não é derivado de novo;
- o próximo endereço de cada ramo é `último usado + 1`;
- **não há teto de carteira**: o ramo só termina quando tem 50 vazios
  seguidos;
- cada passo deriva no máximo 200 endereços novos e devolve `scanning`,
  `has_more` e `progress`; a tela continua até o último passo.

Custo de uma varredura completa (8 ramos × 50 × 2 pedidos: `get_history` +
`get_mempool`): ~400 endereços consultados, ~800 pedidos, 5–8 s medidos. A
primeira consulta é dividida em passos de 200 endereços (uma carteira vazia
usa dois; com atividade, mais); o tempo total é o mesmo, mas a tela mostra
progresso e não fica parada numa resposta só.

50 é o dobro e meio do padrão do Electrum/Sparrow (20) e cobre buracos
usuais. Aumentar para 100 dobra os pedidos (~1.600) e o tempo (10–15 s), sem
garantia extra para a maioria das carteiras; por isso a margem fica fixa.
Aviso: um endereço isolado depois de 50 vazios continua invisível; se a
varredura for interrompida, a tela mostra "busca incompleta" em vez de
apresentar o saldo como final.

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
  varredura em passos com margem fixa de 50 e mantém tudo em memória. O
  `xpub` chega no corpo do POST e só existe na memória do objeto; não é
  parâmetro de URL.
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
  abertura refaz a varredura com a margem fixa de 50 e baixa de novo as
  transações dos endereços usados. É o preço de não guardar nada. Enquanto a
  sessão está viva, as consultas seguintes e os avisos reaproveitam o que já
  está em memória.
- **Custo medido** (xpub de teste, 29 endereços usados, 34 transações,
  `wrangler dev` + Electrum real, margem 50): **7,0 s** para a primeira
  consulta de uma sessão nova, dividida em passos de 200 endereços; com a
  sessão viva, `POST` seguinte na mesma sessão fica em **2,2 s**, e o aviso
  de mudança custa 2 pedidos + as transações novas.
- **CPU**: cada abertura de tela deriva cerca de 400 endereços (8 ramos ×
  50). Cabe nos 30 s de CPU do plano pago (US$ 5/mês); no free (10 ms) não
  cabe.
- **Assinaturas**: só os endereços usados e a cauda de 50 de cada ramo são
  observados; endereços vazios fora da cauda não são assinados. Com o tempo
  real aberto, um pagamento para um endereço além da cauda só aparece numa
  nova varredura (é o mesmo limite da margem).
- **Sem teto de quantidade**: uma carteira com uso a cada 50 endereços ou
  menos não para por número; a busca segue até o último uso e pode ficar
  longa. A tela mostra o progresso e continua até o fim.
- Sem heartbeat da tela: quando a aba fecha, o `close` do WebSocket encerra a
  sessão na hora. Se a rede cair sem `close`, quem percebe é o runtime
  (socket morto); até lá o objeto continua com o keepalive do Electrum.
- Endereços usados depois de 50 vazios seguidos não aparecem: a varredura
  procura do índice 0 até a margem de 50 em cada ramo. Se a busca for
  interrompida (erro de rede/Electrum), a tela avisa que o saldo pode estar
  incompleto e oferece continuar.
- **PSBT é um retrato do último estado**: a escolha de UTXO usa o que a
  sessão já sincronizou. Não há reserva de moeda nem reconsulta forçada no
  momento de montar; se outra carteira gastar uma dessas saídas antes da
  assinatura/transmissão, a rede recusa a transação e é preciso criar outro
  PSBT. Se a sessão estiver em modo avulso, a varredura completa é refeita
  antes de montar.
- **Taxa é estimativa do servidor**: `blockchain.estimatefee` é um palpite do
  Electrum, não a mempool local. Servidor sem estimativa deixa o nível em
  `null` e a tela desabilita aquele nível; sem nenhum nível, o envio fica
  bloqueado e a leitura avisa que a estimativa está indisponível.
- **A taxa usada é a estimada, sem piso**: `levels` leva o valor do servidor
  exatamente como veio, inclusive abaixo de 1 sat/vB. O relay padrão do
  Bitcoin Core é `-minrelaytxfee` = 100 sat/kvB (0,1 sat/vB) desde a v30
  (era 1000 sat/kvB nas versões anteriores), e `floored` só marca o nível
  abaixo desse piso — não troca a taxa. Num mempool quase vazio vários alvos
  caem abaixo de 1 sat/vB: elas propagam para nós com piso menor e podem ser
  mineradas, mas nós antigos (até a v29) recusam, então a confirmação pode
  demorar.
- **A vsize é um limite superior**: `estimateVsize` (btc-core.js) conta o
  pior caso de assinatura (72 bytes no ECDSA, 65 no taproot), os 2 wu do
  marcador/flag do witness e o varint real das contagens. Com isso a
  estimativa nunca fica menor que a transação assinada, e a taxa paga é
  `ceil(preço × vsize) ≥ preço × vsize real` — a taxa paga nunca fica abaixo
  da pedida. O preço disso é uma folga de no máximo 1 vB por transação:
  assinaturas de 71 bytes e taproot com `SIGHASH_DEFAULT` gastam menos que o
  pior caso, e a diferença fica na taxa.
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
  psbt.js             escolha de UTXOs, taxa, troco e PSBT de envio
  broadcast.js        conferência do PSBT assinado e transmissão no Electrum
  wallet-sync.js      varredura por margem de 50, em passos, e payload (só memória)
  watcher.js          Durable Object: socket + assinaturas + WebSocket, sem storage
  config.js           env (servidores, timeout) e helpers
  worker.js           rotas: /api/wallet, /api/psbt, /api/broadcast, /api/fees,
                      /api/events, /api/health
public/
  index.html          UI ASCII (página publicada)
  app.js              cliente (xpub, carga automática, render, update a cada 30 s)
  style.css           CSS do Monitor BTC
  fontes.css          fonte embutida (Liberation Mono)
  manifest.webmanifest / icon-*.png / apple-touch-icon.png / og-image.png
                      instalação, ícone de atalho e cartão de compartilhamento
test/
  electrum.test.mjs   cliente Electrum contra servidor falso
  address-totals.test.mjs  conta de UTXO: confirmado, troco pendente, terceiro
  worker.test.mjs     ponta a ponta: saldo/recebido/enviado, gap, erros
  watcher.test.mjs    Durable Object: assinatura, aviso → push, descarte total
  psbt.test.mjs       taxa, escolha de UTXO, PSBT e assinatura no btc-core
  broadcast.test.mjs  conferência do PSBT assinado e transmissão (Worker e DO)
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
{ "xpub": "xpub...", "session": "opcional, devolvido pelo próprio endpoint",
  "scan": "step" }
```

`scan: "step"` faz um passo da varredura (até 200 endereços novos) e devolve
progresso; a tela repete a chamada até receber o payload final. Sem `scan`, a
resposta é a varredura completa, como antes. Enquanto a varredura não termina,
a resposta é resumida:

```json
{ "scanning": true, "has_more": true,
  "progress": { "scanned": 200, "used": 3, "gap": 50 },
  "watch": true, "session": "0740457f..." }
```

O payload final acrescenta `"scanning": false, "has_more": false`.

Resposta (resumida):

```json
{
  "detected_type": "bip44",
  "balance": { "detected": 12835640, "total": 12862176,
               "pending_in": 0, "pending_out": 0 },
  "types": [
    { "type": "bip86", "label": "bip86 · taproot (p2tr)", "address": "bc1p...",
      "path": "m/86'/0'/0'/0/1", "balance": 11100, "tx_count": 1,
      "detected": false },
    { "type": "bip84", "label": "bip84 · segwit (p2wpkh)", "address": "bc1q...",
      "path": "m/84'/0'/0'/0/26", "balance": 15436, "tx_count": 5,
      "detected": false },
    { "type": "bip49", "label": "bip49 · segwit aninhado (p2sh-p2wpkh)",
      "address": "3Jnu...", "path": "m/49'/0'/0'/0/0", "balance": 0,
      "tx_count": 0, "detected": false },
    { "type": "bip44", "label": "bip44 · legacy (p2pkh)", "address": "15tKN...",
      "path": "m/44'/0'/0'/0/132", "balance": 12835640, "tx_count": 29,
      "detected": true }
  ],
  "addresses": [
    { "account_type": "bip44", "chain": 0, "idx": 0, "address": "1Efg...",
      "used": 1, "received": 110665, "spent": 100000, "balance": 10665,
      "tx_count": 3, "last_height": 700200, "pending": false,
      "pending_in": 0, "pending_out": 0 }
  ],
  "warnings": [ "..." ],
  "watch": true,
  "session": "0740457f05938f9406827187257194d692dcf571a130eaec3c737dd3392ce31c"
}
```

`addresses` traz **só endereços usados** (todos os tipos), cada um com
recebido, enviado, saldo e número de transações, na ordem do **uso mais
recente para o mais antigo**. `received` e `spent` são o confirmado e
`balance` é o disponível do endereço (confirmado ainda não gasto mais o troco
pendente dele). `pending_in` e `pending_out` são os totais brutos do mempool
daquele endereço (de entrada e de saída), que a tela soma a recebido e
enviado. A data é a
altura do bloco em que o endereço apareceu pela última vez (`last_height`),
que a varredura já tem, sem pedir cabeçalho ao servidor; o que está no
mempool (`pending: true`) vem antes de
qualquer bloco confirmado e leva a etiqueta `[ pendente ]`, no tom de aviso,
na tela. Mesma
altura desempata pelo índice maior, para a ordem não mudar entre consultas
iguais.

`types` traz **os quatro tipos**, na ordem bip86 → bip84 → bip49 → bip44 (o
BIP mais alto, tecnologia mais recente, primeiro) e com o detectado marcado
por `detected`: cada um com o saldo disponível do tipo (soma dos endereços
usados dele) e o próximo endereço livre do ramo de recebimento
(`último usado + 1`, ou o índice 0 se o tipo nunca foi usado).
A soma de `types[].balance` é o `balance.total`. A tela usa `types` inteiro
(os quatro) no bloco **receber**, que exibe o próximo endereço livre de cada
tipo. O `change_address` (o `último usado + 1` do ramo `/1`) continua na
resposta, mas não aparece na tela.

`balance.total` é o saldo **disponível** — a soma dos `types[].balance` —,
e `balance.detected` é a fatia do tipo detectado: confirmado não gasto mais o
troco pendente, a mesma base que o envio usa. `balance.pending_in` é a entrada
de terceiro que ainda não conta e `balance.pending_out` é o que já saiu de
fato numa transação pendente (destino + taxa), líquido do troco que volta.
Eles não são a soma dos `pending_in`/`pending_out` dos endereços, que são
brutos para o extrato. Quando tudo confirmar, o saldo é `total + pending_in`
(o que sai já está fora de `total`).

`watch: true` avisa a UI para abrir o WebSocket de tempo real. `session` é o
id aleatório do Durable Object: mande de volta no próximo `POST` para
reaproveitar a sessão enquanto a tela estiver aberta. Se ele não existir mais
(objeto despejado), o `/sync` refaz a varredura com a xpub enviada.

### `POST /api/psbt`

```json
{ "xpub": "xpub...", "session": "opcional",
  "address": "bc1...", "amount_sats": 50000, "fee_rate": 6 }
```

Monta o PSBT v0 **sem assinatura** com os UTXOs da carteira, a taxa pedida
em sat/vB e o troco no próximo endereço livre do ramo `/1` do tipo detectado.
Com o binding `WATCH`, quem monta é o Durable Object da sessão, reaproveitando
a conexão, os endereços e o cache; sem ele (ou com a sessão perdida), o Worker
faz a varredura avulsa. O valor é inteiro em sats (`amount_sats`); a taxa vai
de 0,001 a 10 000 sat/vB e aceita as casas decimais do estimador (1,926;
0,12), porque a conta é feita em sat/kvB
(`Math.ceil(sat/kvB × vsize ÷ 1000)`) sobre a vsize estimada — que é um
limite superior do tamanho real, então a taxa efetiva nunca fica abaixo da
pedida; valor abaixo
de 546 sats é recusado como pó. Entram no envio as entradas confirmadas e o
troco pendente de uma transação sua (gasto encadeado); pagamento de terceiro
no mempool não entra. As confirmadas são escolhidas antes e, em cada grupo, as
maiores primeiro.

Com `"preview": true` e sem `amount_sats`, a rota não monta nada: devolve o
limite que a tela usa para bloquear o envio antes da tentativa.

```json
{ "recipient": "bc1...", "available_sats": 15000, "min_sats": 546,
  "max_send_sats": 13656, "fee_sats_at_max": 1344,
  "vsize_at_max": 224, "fee_rate": 6, "fee_rate_kvb": 6000 }
```

O mesmo `preview` aceita `amount_sats`: a resposta ganha a taxa (e o troco)
que aquele valor pagaria, pela mesma seleção de entradas do PSBT, para a tela
mostrar a taxa ao lado do valor antes de qualquer montagem.

```json
{ "max_send_sats": 13656, "amount_sats": 5000, "fee_sats": 852,
  "change_sats": 7148, "vsize": 142, "inputs_used": 2 }
```

O mesmo preview aceita `quote_rates` (até as quatro taxas dos níveis): a
resposta ganha `quotes`, com a taxa de cada nível para o **mesmo valor**, na
mesma seleção de entradas. É o que o seletor mostra em BTC; nível em que o
valor não cabe volta com `fee_sats: null`.

```json
{ "quotes": [ { "fee_rate": 2, "fee_sats": 284, "vsize": 142 },
              { "fee_rate": 6, "fee_sats": 852, "vsize": 142 },
              { "fee_rate": 9, "fee_sats": 1278, "vsize": 142 },
              { "fee_rate": 12, "fee_sats": 1704, "vsize": 142 } ] }
```

Valor acima do máximo volta com `fee_sats: null` (a tela já mostra o erro de
limite).

`max_send_sats` é o total disponível menos a taxa da transação
que gasta todas as entradas e manda todo o resto ao destino (sem troco). É
exatamente o maior valor que `selectCoins` aceita; abaixo dele sempre existe
uma seleção válida, e acima o envio é recusado. No máximo não há saída de
troco.

A taxa vem separada em duas partes: `fee_sats_at_rate` é o que a tarifa
pedida cobraria sozinha na transação montada e `dust_sats` é o que sobrou e
não virou troco (o troco ficaria abaixo do pó de 546 sats, ou criar a saída de
troco custaria mais que esse resto). `fee_sats` é a soma das duas — é o valor
que o PSBT paga de fato. A tela mostra `fee_sats_at_rate` na linha `taxa` e,
logo abaixo, o pó com sinal `-`: a soma das duas linhas volta a ser `fee_sats`.
Com troco, `dust_sats` é 0, a linha do pó some e a taxa é a única mostrada.

Resposta (resumida):

```json
{
  "psbt": "cHNidP8BAH0CAAAA...",
  "txid": "2fbb9a49...",
  "vsize": 142,
  "locktime": 0,
  "rbf": false,
  "fee_sats": 852,
  "fee_sats_at_rate": 852,
  "dust_sats": 0,
  "fee_rate": 6,
  "fee_rate_requested": 6,
  "fee_rate_kvb": 6000,
  "total_in": 8000,
  "total_out": 7148,
  "amount_sats": 5000,
  "change": { "address": "bc1p...", "value": 2148, "path": "m/86'/0'/0'/1/0" },
  "recipient": { "address": "bc1q...", "value": 5000, "own": "externo" },
  "inputs": [
    { "txid": "7e964b27...", "vout": 1, "value": 8000,
      "address": "bc1p...", "path": "m/86'/0'/0'/0/1",
      "type": "bip86", "pending": false }
  ],
  "outputs": [
    { "address": "bc1q...", "value": 5000, "own": "externo" },
    { "address": "bc1p...", "value": 2148, "own": "troco", "path": "m/86'/0'/0'/1/0" }
  ]
}
```

O `own` de cada saída é `externo` quando o script não foi derivado da xpub,
`recebimento` quando o destino é um endereço da própria carteira e `troco` no
ramo `/1`; `recipient.own` repete a classificação do destino. Quando o destino
é da própria carteira, a saída de destino leva
`PSBT_OUT_BIP32_DERIVATION`/`PSBT_OUT_TAP_BIP32_DERIVATION`, para o assinador
reconhecê-lo pela origem sem varrer as contas. Na revisão do `cofre-btc.html`,
entradas e saídas usam só a origem BIP32 declarada, conferida contra o script
real; não há varredura de contas. Entrada sem origem válida é recusada (não há
chave para assinar); saída sem origem válida é externa.
Cada entrada traz `pending: true` quando é troco de uma transação ainda no
mempool (gasto encadeado): a transação nova confirma depois — e junto — da
anterior. O PSBT carrega `witness_utxo` e a origem BIP32 (`bip32_derivation` ou
`tap_bip32_derivation`) em cada entrada; toda entrada carrega
`non_witness_utxo` (a transação anterior inteira; obrigatório no p2pkh) e
p2sh-p2wpkh carrega o `redeem_script`. A
origem usa a **impressão digital da conta**, e não a da raiz: com só a xpub,
é o máximo que o lado watch-only conhece. O caminho é completo
(`m/84'/0'/0'/0/120`) e o `cofre-btc.html` confere a conta, deriva o caminho,
confere a chave pública e o script antes de assinar. Nenhuma chave privada
entra no Worker nem na resposta.

### `POST /api/broadcast`

```json
{ "xpub": "xpub...", "session": "opcional",
  "psbt": "cHNidP8...", "preview": true }
```

Fecha o ciclo: recebe o PSBT v0 **assinado** pelo `cofre-btc.html` (base64 ou
hex), confere contra a carteira e, sem `preview`, publica a transação final
com o `blockchain.transaction.broadcast` do Electrum. A transmissão só sai
depois do clique em **confirmar**; `preview: true` faz só a conferência.

A conferência, antes de qualquer coisa ir para a rede:

- cada entrada tem de gastar um script derivado da xpub — o PSBT de outra
  carteira é recusado;
- quando a saída está entre os UTXOs conhecidos da sessão, o valor declarado
  no PSBT (`witness_utxo` ou `non_witness_utxo`) tem de bater com o da
  carteira. O p2pkh não assina o valor, então sem essa comparação um valor
  inventado viraria taxa falsa na tela;
- todas as entradas têm de estar finalizadas, com `final_scriptSig` e
  `final_scriptWitness` no formato do tipo de script. A transação final é
  escrita a partir dos campos finais (BIP174), não dos campos de assinatura;
- as saídas são classificadas em `troco` (ramo `/1`), `recebimento` (ramo
  `/0`) ou `externo`, e a taxa é a diferença real entre entradas e saídas da
  transação final, com o vsize **real**, não o estimado do envio. O resumo
  traz `rbf` e `agendado` do locktime/sequence da transação final: `rbf` é
  `sim` quando há sequence abaixo de `0xffffffff` (versão 2), e `agendado`
  mostra a data a partir da qual a transação pode entrar (0 = `não`; locktime
  em bloco vira data aproximada).

Resposta (resumida):

```json
{
  "preview": true,
  "txid": "03a8b4b8...",
  "vsize": 141,
  "locktime": 0,
  "rbf": false,
  "fee_sats": 423,
  "fee_rate": 3,
  "total_in": 100000,
  "total_out": 99577,
  "psbt_bytes": 168,
  "inputs": [
    { "outpoint": "3a15a109...:0", "value": 100000, "kind": "p2wpkh",
      "address": "bc1q...", "path": "m/84'/0'/0'/0/0",
      "type": "bip84", "known": true }
  ],
  "outputs": [
    { "index": 0, "address": "bc1q...", "value": 50000, "own": "externo" },
    { "index": 1, "address": "bc1q...", "value": 49577, "own": "troco",
      "path": "m/84'/0'/0'/1/0" }
  ],
  "warnings": []
}
```

Sem `preview`, a mesma resposta ganha `"broadcast": true` e `server_txid`, e
o hex da transação final vai ao Electrum — o hex não volta para o navegador.
O depósito que a sessão ainda não viu vira aviso (`não está entre as saídas
não gastas`), não recusa: a rede é quem decide, e a assinatura já foi feita.
Taxa zero ou abaixo de 1 sat/vB, taxa acima de 500 sat/vB, saída abaixo do pó
e mais de uma saída externa também são avisos, para a revisão da tela.

Com sessão, o Durable Object usa a conexão e as assinaturas já abertas; a
transação entra no mempool e o `scripthash.subscribe` empurra o saldo novo
para a tela. Sem sessão (ou com a sessão perdida), o Worker faz a varredura
avulsa. Erro de conferência e recusa do servidor voltam em 400 com a
mensagem, sem publicar nada.

### `GET /api/fees?session=<id opcional>`

Taxa ao vivo pelo `blockchain.estimatefee` do Electrum, em quatro alvos:
144 blocos (`minimum`, prazo médio de 1 dia), 6 (`standard`, 1 h), 3 (`high`,
30 min) e 1 (`urgent`, 10 min; o Bitcoin Core trata o alvo 1 como 2, o menor
que ele estima). O prazo que a tela mostra é `alvo × 10 min`, a média do
intervalo entre blocos: o `estimatefee` devolve só a taxa, sem prazo nem
probabilidade, então o número é ordem de grandeza, não previsão.

Nada é arredondado: `BTC/kvB × 1e8` dá o **sat/kvB inteiro exato** que o
servidor respondeu, e `sat_per_vb` é só a leitura ÷1000. Arredondar a taxa
antes de multiplicar pela vsize erra sempre para cima: 1,926 sat/vB em 141 vB
custa 272 sats, e 2 sat/vB custaria 282. O PSBT recebe a taxa com as casas que
o servidor deu e arredonda **apenas a taxa final, em satoshis**
(`Math.ceil(sat/kvB × vsize ÷ 1000)`). Nada é somado para separar níveis:
alvos que respondem a mesma taxa aparecem com a mesma taxa, porque o dado é do
servidor, não do nome do nível — e a tela esconde o nível mais lento de cada
taxa repetida, deixando só o mais rápido.

Se o servidor não estimar um nível, ele vem `null` e a tela desabilita aquele
nível. `levels` (o que a tela escolhe e o PSBT usa) leva a estimativa exata,
sem piso de relay: 0,113 sat/vB é usado como 0,113. `sat_per_vb` e
`sat_per_kvb` são a mesma leitura em unidades diferentes, e `floored` só
marca o nível abaixo do piso padrão do Bitcoin Core (`relay_min_kvb`, 100
sat/kvB = 0,1 sat/vB desde a v30) — a taxa usada não muda.

```json
{
  "levels": { "minimum": 0.112, "standard": 0.97, "high": 1.926, "urgent": 1.926 },
  "targets": { "minimum": 144, "standard": 6, "high": 3, "urgent": 1 },
  "sat_per_kvb": { "minimum": 112, "standard": 970, "high": 1926, "urgent": 1926 },
  "sat_per_vb": { "minimum": 0.112, "standard": 0.97, "high": 1.926, "urgent": 1.926 },
  "floored": { "minimum": false, "standard": false, "high": false, "urgent": false },
  "relay_min_kvb": 100,
  "unit": "sat/vB",
  "source": "electrum",
  "updated_at": "2026-11-09T21:27:52.346Z"
}
```

Com `session`, a consulta usa a conexão já aberta do Durable Object; sem ela,
o Worker abre uma conexão avulsa e fecha ao terminar.

### `GET /api/events?session=<id da sessão>`

Upgrade para WebSocket no Durable Object. Mensagens: `{ "type": "payload",
"payload": { ...mesma resposta do POST } }` a cada mudança,
`{ "type": "progress", "progress": { ... } }` se a varredura ainda estiver
em andamento, e `{ "type": "error", "error": "..." }` quando a conexão com
o Electrum cai. Sessão sem xpub responde 409 (a tela reenvia a xpub em
`/api/wallet`).

### `GET /api/health`

`{ "ok": true, "service": "monitor-btc-electrum", "source": "electrum", "storage": "nenhum", "realtime": true, "electrum": [...] }`.

## Segurança

- A xpub é watch-only. **Não coloque xprv aqui.** O Cofre BTC permanece
  offline assinando o PSBT.
- Use 2FA na conta Cloudflare; não logue a xpub. O Worker não grava a xpub,
  não a coloca em URL e não tem banco; mesmo assim, um comprometimento do
  Worker poderia mentir no display ou exfiltrar a chave que passou por ele
  enquanto a tela estava aberta.
- O HTML/JS é servido pelo Cloudflare. O Cofre BTC confere entradas, saídas e
  taxa antes de assinar.
- O PSBT de envio sai **sem assinatura**: o Monitor BTC só monta a transação. O
  arquivo leva a origem BIP32 com a impressão digital da conta, o caminho
  completo, os UTXOs, o troco e, quando o destino é da própria carteira, o
  próprio destino; o `cofre-btc.html` confere conta, chave, script, saídas e
  taxa antes de assinar.
- **A transmissão é a única saída para a rede**, e é explícita: o PSBT
  assinado é conferido no Worker/DO (nunca no navegador) e só vai ao Electrum
  no clique em **confirmar**. Publicar não tem volta. A transação fica
  pública de qualquer forma, mas o servidor escolhido a vê primeiro; a
  conferência recusa entrada que não seja desta carteira.
- O resumo da transmissão não é prova de validade das assinaturas: o servidor
  confere estrutura, valores e destinos; quem valida as assinaturas é a rede.
  A conferência que vale continua sendo a do `cofre-btc.html`, antes de assinar.
- O resumo do PSBT na tela não é prova: o arquivo é montado no Worker/DO e o
  navegador só baixa o base64. A tabela mostra o destino e todas as saídas para
  comparar com o formulário, e avisa quando divergem; a conferência que vale é
  a do `cofre-btc.html`, que recalcula a taxa e classifica cada saída.
- Para valor alto, hardware wallet + nó/Electrum próprio.

### Cabeçalhos de segurança

Toda resposta leva `Strict-Transport-Security`, `Content-Security-Policy`,
`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy`, `Cross-Origin-Opener-Policy` (`same-origin`),
`Cross-Origin-Embedder-Policy` (`require-corp`) e `Cross-Origin-Resource-Policy`
(`same-origin`). São dois pontos de aplicação, com os mesmos valores:

- `public/_headers` — arquivos estáticos, aplicado pelo Cloudflare antes do
  Worker (e o próprio `_headers` não é servido como arquivo);
- `SECURITY_HEADERS` em `src/config.js` — respostas do Worker (`/api/*` e o
  fallback do `ASSETS`).

O teste `test/security-headers.test.mjs` compara os dois lados e recalcula o
hash do script inline do tema em `public/index.html`: mexeu no script, o
teste falha até o `sha256-…` novo entrar nos dois arquivos. A CSP não usa
`unsafe-inline` em `style-src` — os esqueletos usam classe, não atributo
`style=` —, então um `style="…"` novo no HTML também aparece no teste.
`clipboard-write=(self)` fica liberado porque a tela tem botões de copiar.

### SRI (Subresource Integrity)

`/app.js`, `/fontes.css` e `/style.css` são carregados com `integrity`
sha384 (`<script src>` e `<link rel="stylesheet">`). O navegador descarta o
arquivo cujo conteúdo não bate com o hash — inclusive se algo no caminho
(proxy, CDN, extensão) trocar os bytes. Como os três são same-origin, o
`integrity` basta: não é preciso `crossorigin`.

Qualquer edição em `app.js`, `fontes.css` ou `style.css` **exige** recalcular
o hash e atualizar `public/index.html`, senão o arquivo é bloqueado. O mesmo
teste confere isso:

```bash
openssl dgst -sha384 -binary public/app.js | base64   # valor do integrity
npm test                                              # acusa hash vencido
```

Por isso os minificadores da Cloudflare precisam continuar desligados
(minify, Rocket Loader e afins): o hash vale para os bytes exatos do arquivo.

O HSTS usa `max-age=31536000; includeSubDomains` e não inclui `preload`. Se
algum subdomínio deste host ainda responder em HTTP, tire o
`includeSubDomains`: o navegador guarda a decisão por um ano.

## Testes

```bash
npm test                        # electrum + worker + psbt + watcher, sem rede
node test/electrum.test.mjs     # protocolo contra servidor falso
node test/worker.test.mjs       # ponta a ponta, sem D1 no env
node test/psbt.test.mjs         # taxas, escolha de UTXO, PSBT e assinatura
node test/broadcast.test.mjs    # conferência e transmissão do PSBT assinado
node test/watcher.test.mjs      # Durable Object, timers e descarte total
node test/dev-server.mjs        # UI local em http://127.0.0.1:8787/ (sem DO)
node test/security-headers.test.mjs  # cópias iguais, hash do tema, 101 intacto
node test/cdp-ui.mjs            # opcional: Chromium headless + screenshot
```

A validação do campo foi conferida em Chromium headless (CDP `Input.insertText`):
endereço, `xprv` e texto solto deixam o campo vazio com aviso; `xpub`, `zpub`
e `ypub` de 111 caracteres entram, disparam a consulta sozinha e carregam a
carteira. A página abre sempre com o campo vazio, inclusive depois de
recarregar. O bloco **enviar** também foi conferido no Chromium: o seletor
de taxa só aparece depois de valor e destino válidos, os quatro níveis
mostram o percentual do Electrum falso, a
escolha por rádio muda a taxa do PSBT, os detalhes do PSBT aparecem na tabela
de leitura (sem o base64 na tela) e somem ao editar o formulário, voltando
sozinhos quando a nova montagem termina (o bloco não tem botão de envio: o
PSBT acompanha o formulário). Com taxa
fracionária (1,076 sat/vB, que é o caso normal) o preview responde e os quatro
níveis ganham percentual: a tela não pode tratar sat/vB como inteiro, senão
o preview nunca dispara e o PSBT nunca é montado.
Um PSBT gerado pelo montador (bip84 e troco) foi analisado e assinado pelo
próprio código do `cofre-btc.html` em Chromium headless, com o troco
reconhecido como interno. O bloco **transmitir** foi conferido no mesmo
Chromium com um arquivo assinado de verdade: escolher o arquivo mostrou a
revisão (txid, taxa, saídas) sem transmitir, e o clique em **confirmar**
publicou o mesmo hex/txid no Electrum falso, deixando o botão em
**transmitida**.

O `watcher.test.mjs` usa um par de WebSocket mínimo e um `storage` que lança
em qualquer acesso para exercitar o Durable Object sem Cloudflare: assinatura
de todos os scripthashes, aviso → reconsulta só do endereço → push, extensão
da cauda de gap com novas assinaturas, cache de transações em memória, queda
do Electrum com reconexão e reassinatura, o descarte de
conexão/endereços/xpub quando a última tela fecha e a recarga (fechar e
re-sincronizar no mesmo instante) sem apagar a sessão nova.

O `psbt.test.mjs` deriva uma carteira dos 256 bits (a mesma do Cofre BTC),
serve UTXOs por um Electrum falso e verifica: taxa ao vivo nos quatro níveis
(`sat/kvB` exato, `sat_per_vb` com casas, `levels` sem piso e `floored`
abaixo do piso padrão de 0,1 sat/vB),
escolha de entradas para cobrir o valor, troco no próximo índice `/1`, o
limite `max_send_sats` (incluindo o envio no máximo, sem troco) e o preview
com valor (taxa e troco iguais aos do PSBT, e as cotas dos níveis para o
seletor), PSBT v0 com
origem da conta, `non_witness_utxo` em todas as entradas (obrigatório no
p2pkh), `tap_bip32_derivation` no
taproot, o destino próprio no índice 30 reconhecido pela origem da saída, sem
varredura, a saída sem origem — mesmo no índice 1 — tratada como externa e a
entrada sem origem recusada; recusa de endereço/taxa/saldo inválidos, e a
**assinatura do PSBT no próprio `btc-core`** com um índice 120, reconhecido
pela origem da entrada, sem varredura, provando a compatibilidade com o
`cofre-btc.html`. A taxa também é conferida depois da
assinatura, nos quatro tipos de entrada (p2wpkh, p2sh-p2wpkh, p2pkh e p2tr) e
em duas taxas (1 e 1,926 sat/vB): a vsize estimada tem de cobrir o tamanho
real da transação assinada e a taxa paga tem de cobrir a taxa pedida. O
`watcher.test.mjs` também cobre o
`preview` do máximo e o `preview` com `amount_sats` (taxa igual à do PSBT)
pela mesma sessão/conexão do envio.

O `broadcast.test.mjs` leva o PSBT gerado pelo `/api/psbt` ao assinante do
`btc-core` (o mesmo caminho do `cofre-btc.html`), confere que a transação
final extraída dos campos finais do PSBT é **byte a byte** o hex que o
assinante escreveu, e verifica: `preview` devolve txid, vsize real, taxa e as
saídas classificadas (destino externo e troco) sem transmitir; `transmitir`
publica uma única vez, com o mesmo hex e o txid do assinante; PSBT sem
assinatura, de outra carteira, com `witness_utxo` adulterado, sem xpub ou
recusado pelo servidor não transmite nada e volta com mensagem clara; um
depósito fora do retrato da sessão vira aviso e não recusa; e a sessão do
Durable Object confere e transmite pela conexão já aberta, sem nova varredura.

O `address-totals.test.mjs` cobre a classificação das saídas: confirmado,
troco próprio pendente (inclusive troco do troco, encadeado) e pagamento de
terceiro pendente — só os dois primeiros entram no disponível.

O `worker.test.mjs` monta transações com o próprio `btc-core` e cobre:
endereço que recebeu e gastou (`recebido 10000 / enviado 10000 / saldo 0`),
endereço que só recebeu, próximo índice, entrada de terceiro pendente fora do
saldo e troco pendente dentro do disponível (e gastável), união dos tipos,
ausência de cache entre consultas (o Electrum é consultado de novo),
ausência de fallback quando o Electrum não responde, recusa de
endereço/xprv/texto solto antes de consultar, a margem fixa de 50 (400
consultas numa carteira vazia, 403 quando há uso no índice 2), a varredura
em passos e a assinatura só de usados + cauda.

## Verificado no runtime de verdade

`wrangler dev` (workerd + Durable Object, **sem D1**) com o servidor real e a
UI em Chromium headless:

```
POST /api/wallet          200  7,0 s   watch=true  session=0740457f…  total 0.12862176 BTC  29 endereços
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
`xpub6CUGR...`: 29 endereços usados, saldo total `0.12862176` BTC,
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
- Política de taxa mais fina (RBF, CPFP) e escolha de moedas por privacidade,
  se a maior-primeiro incomodar.
