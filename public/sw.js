/* Service worker mínimo: sem cache e sem storage. Ele existe só para o
   navegador reconhecer o Monitor BTC como aplicativo instalável, e a
   instalação abrir a tela numa janela própria. Não há listener de fetch:
   nenhuma navegação passa por aqui e nenhum dado da carteira (xpub, saldo,
   endereços, PSBT) é interceptado nem fica guardado. */
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});
