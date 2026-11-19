#!/usr/bin/env node
/* Extrator do núcleo criptográfico embutido em public/cofre-btc.html.
   Usado pelos testes de paridade para carregar a cópia do Cofre (que é
   standalone) e comparar as validações com src/btc-core.js.

   Este script NÃO sincroniza mais: as duas cópias divergem de propósito no
   que é próprio de cada consumidor (avisos com marcação HTML no Cofre,
   menos funções de assinatura no Worker) e a régua entre elas é o teste
   test/cofre-core-parity.test.mjs. Regenerar o bloco a partir de
   src/btc-core.js afrouxaria a política do assinador. */
export const START = 'var BTC = (function () {';
export const MARKER = "if (typeof module !== 'undefined' && module.exports) module.exports = BTC;";

export function embeddedCore(html) {
  const start = html.indexOf(START);
  const end = html.indexOf(MARKER, start);
  if (start < 0 || end < start) throw new Error('núcleo embutido não encontrado em public/cofre-btc.html');
  return html.slice(start, end + MARKER.length) + '\n';
}
