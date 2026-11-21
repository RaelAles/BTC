/* Service worker mínimo: sem cache e sem storage. Ele existe só para o
   navegador reconhecer o Monitor BTC como aplicativo instalável, e a
   instalação abrir a tela numa janela própria. O fetch segue para a rede
   como se não houvesse service worker: nenhum dado da carteira (xpub,
   saldo, endereços, PSBT) passa por aqui nem fica guardado. */
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function () {
  /* Sem respondWith: a requisição normal do navegador continua valendo. */
});
