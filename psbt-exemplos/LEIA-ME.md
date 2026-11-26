# PSBTs de exemplo para o Cofre

Use a mnemônica pública de teste abaixo **somente para conferir a tela**. Não use para fundos.

`length abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon awesome`

A frase secreta fica vazia.

Todos gastam entradas de teste de 100 000 sats (o `11` gasta 100 000 + 50 000). O valor que não vai para as saídas fica como taxa. Os arquivos são gerados por `scripts/build-psbt-exemplos.mjs`; `01`–`04` são os exemplos originais e ficaram como estavam.

A recusa acontece **na importação**: o arquivo é descartado e o motivo fica no aviso, sem revisão. PSBT que o Cofre não assinaria não chega a ser carregado. A exceção são os já assinados (`16` e `17`), que só podem ser exibidos.

## Revisão normal: o Cofre assina

| Arquivo | Cenário | O que o Cofre mostra |
|---|---|---|
| `01-normal-1-externo-1-troco.psbt` | 1 destino externo + 1 troco | Revisão normal, sem aviso. |
| `03-dois-trocos.psbt` | 1 externo + 2 trocos | Revisão normal, sem aviso. |
| `04-sem-troco.psbt` | 1 externo, sem troco | Revisão normal, sem aviso. |
| `07-recebimento-proprio.psbt` | 1 externo + 1 saída própria da cadeia 0 | Saída própria aparece como “saída”, sem o marcador `[ externo ]`. Assina. |
| `08-entrada-p2pkh.psbt` | entrada P2PKH + troco | Revisão normal. Assina. |
| `09-entrada-p2sh-p2wpkh.psbt` | entrada P2SH-P2WPKH + troco | Revisão normal. Assina. |
| `10-entrada-p2tr.psbt` | entrada P2TR (key path) + troco | Revisão normal. Assina. |
| `11-duas-entradas.psbt` | 2 entradas (P2WPKH + P2TR) + troco | Revisão normal. Assina. |

## Recusados na importação

| Arquivo | Cenário | Mensagem |
|---|---|---|
| `02-dois-externos.psbt` | 2 destinos externos, os dois com origem declarada | “mais de um destino externo”. |
| `12-taxa-alta.psbt` | 1 externo, taxa de 636 sat/vB | “taxa acima de 500 sat/vB”. |
| `13-taxa-zero.psbt` | 1 externo + 1 troco, taxa 0 | “taxa zero”. |
| `14-saida-nao-padronizada.psbt` | saída P2PK + troco | “script não padronizado”. |
| `15-troco-sem-origem.psbt` | 1 externo + 1 troco sem origem BIP32 | “há saída própria sem origem BIP32; o troco não pode ser identificado”. |

Taxa abaixo de 0,1 sat/vB não é recusada: ela não aparece no Cofre e continua só como aviso no núcleo de `src/btc-core.js`.

## Só exibição: o botão assinar fica escondido

| Arquivo | Cenário | O que o Cofre mostra |
|---|---|---|
| `16-assinado.psbt` | todas as entradas assinadas e finalizadas | “este PSBT já tem assinatura; ele só pode ser exibido”. |
| `17-assinatura-parcial.psbt` | 2 entradas, uma com `partial_sig` | Revisão normal, sem aviso na lista, e o botão assinar escondido (qualquer assinatura conta como “já assinado”). |

Se um PSBT já assinado trouxer um problema que seria bloqueante (dois destinos externos, script não padronizado, taxa zero ou acima de 500 sat/vB), ele é **exibido com o aviso** em vez de recusado: não há assinatura a fazer, e a conferência continua valendo.

## Erros de importação: o arquivo é descartado

| Arquivo | Cenário | Mensagem |
|---|---|---|
| `30-entrada-de-terceiro.psbt` | entrada de chave que não é do Cofre | “sem origem BIP32 de uma chave do cofre”. |
| `31-entrada-p2wsh.psbt` | entrada P2WSH | “P2WSH não suportado”. |
| `32-entrada-witness-desconhecida.psbt` | entrada com witness v2 | “script não suportado”. |
| `33-entrada-com-time-lock.psbt` | entrada com `required_height_locktime` | “time lock exigido pelo PSBT não suportado”. |
| `34-entrada-sem-non-witness-utxo.psbt` | entrada sem `non_witness_utxo` | “sem non_witness_utxo”. |
| `35-saidas-maiores-que-entradas.psbt` | saídas somam 120 000 com entrada de 100 000 | “saídas somam mais que as entradas”. |
| `36-psbt-v2.psbt` | campo de versão PSBT v2 | “este PSBT é v2; o cofre só lê e assina PSBT v0”. |
| `37-psbt-sem-transacao.psbt` | marca psbt sem a transação não assinada | “PSBT sem a transação não assinada”. |
| `38-arquivo-invalido.psbt` | texto que não é PSBT | “o arquivo não começa com a marca PSBT”. |
| `39-entrada-com-witness-script.psbt` | entrada com campo `witness_script` | “witness_script (P2WSH/multisig) não suportado”. |
| `40-entrada-taproot-script-path.psbt` | entrada com `tap_script_sig` (0x14) | “Taproot com script path não suportado”. |
| `41-entrada-taproot-merkle-root.psbt` | entrada P2TR com `tap_merkle_root` | “Taproot com script path não suportado”. |

## Notas

- Os arquivos `05` e `06` (OP_RETURN) foram removidos: `OP_RETURN` é script não padronizado e agora é recusado, como o `14`. O Monitor nunca monta uma saída dessas.
- Os endereços externos são sintéticos e os UTXOs não existem: os arquivos servem para a revisão, não para transmitir.
