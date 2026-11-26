# PSBTs de exemplo para o Cofre

Use a mnemônica pública de teste abaixo **somente para conferir a tela**. Não use para fundos.

`length abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon awesome`

A frase secreta fica vazia.

| Arquivo | Cenário | O que o Cofre deve mostrar |
|---|---|---|
| `01-normal-1-externo-1-troco.psbt` | 1 destino externo + 1 troco | Revisão normal, sem aviso estrutural. |
| `02-dois-externos.psbt` | 2 destinos externos | Recusa: “mais de um destino externo”. |
| `03-dois-trocos.psbt` | 1 externo + 2 trocos | Revisão normal, sem aviso estrutural. |
| `04-sem-troco.psbt` | 1 externo, sem troco | Revisão normal, sem aviso estrutural. |

Todos gastam a mesma entrada de teste (100 000 sats). O valor que não vai para as saídas fica como taxa.
