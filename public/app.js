/* Monitor BTC — Worker + Durable Object, fonte única Electrum.
   O navegador deriva os endereços da chave estendida pública (xpub, zpub ou
   ypub) e manda ao Worker só o conjunto observado; a xpub não é enviada
   ao Worker.
   O servidor consulta saldo/histórico e monta o PSBT; não há senha e nada
   é gravado: nem no navegador (sem localStorage), nem no servidor. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* Lista do histórico: a quantidade de itens por página é medida na área
     visível a cada desenho, em vez de um número fixo (VG-LST-03). Só o ramo
     de troco ganha palavra, para o caminho não ficar só com número. */
  var PER_PAGE_FALLBACK = 5;
  var historyPerPage = 0; // itens que cabem na área visível (medido)

  /* Movimento (VG-FND-09): as durações e curvas saem dos mesmos tokens que o
     CSS usa, então o ritmo muda num lugar só. */
  function motionMs(name, fallback) {
    var value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!value) return fallback;
    if (/ms$/.test(value)) return parseFloat(value);
    if (/s$/.test(value)) return parseFloat(value) * 1000;
    return parseFloat(value) || fallback;
  }
  var reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  function prefersReducedMotion() { return reducedMotionQuery.matches; }

  /* Cliente do proxy: o scanner do navegador fala JSON-RPC com o Electrum
     através do Worker, em lotes. O Worker vê scripthashes, txids e
     transações cruas; não vê endereços, scripts nem pubkeys. */
  function ProxyClient(session) {
    this.queue = [];
    this.timer = 0;
    this.session = session || '';
    this.dead = null;
  }
  ProxyClient.prototype.request = function (method, params) {
    var self = this;
    return new Promise(function (resolve, reject) {
      self.queue.push({ method: method, params: params || [], resolve: resolve, reject: reject });
      if (!self.timer) {
        self.timer = setTimeout(function () { self.flush(); }, 0);
      }
    });
  };
  ProxyClient.prototype.requestMany = function (items, concurrency) {
    var self = this;
    return Promise.all((items || []).map(function (item) {
      return self.request(item.method, item.params);
    }));
  };
  ProxyClient.prototype.requestManySettled = function (items) {
    var self = this;
    return Promise.allSettled((items || []).map(function (item) {
      return self.request(item.method, item.params);
    }));
  };
  ProxyClient.prototype.flush = async function () {
    var items = this.queue;
    this.queue = [];
    this.timer = 0;
    if (!items.length) return;
    var body = { items: items.map(function (item) {
      return { method: item.method, params: item.params };
    }) };
    if (this.session) body.session = this.session;
    var res;
    try {
      res = await fetchJson('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (e) {
      items.forEach(function (item) { item.reject(e); });
      return;
    }
    var r = res.r;
    var j = res.j;
    if (!r.ok || j.error) {
      var err = apiFail(r, j);
      items.forEach(function (item) { item.reject(err); });
      return;
    }
    var results = j.results || [];
    var errors = j.errors || [];
    items.forEach(function (item, i) {
      if (errors[i]) item.reject(new Error(errors[i]));
      else item.resolve(results[i]);
    });
  };
  ProxyClient.prototype.close = function () {};

  var state = {
    xpub: '',
    account: null,      // xpub decodificada localmente
    scanner: null,      // WalletScanner: deriva, consulta, calcula e monta
    proxy: null,        // cliente JSON-RPC do Worker/Electrum
    data: null,
    timer: 0,
    busy: false,
    watch: null,        // WebSocket de notificações (só scripthashes)
    watchSession: '',   // id efêmero do Durable Object de notificações
    watchRetry: 0,
    watchTimer: 0,      // timeout do handshake do WebSocket
    autoTimer: 0,       // debounce da consulta automática
    scanning: false,    // varredura em passos em andamento
    page: 1,            // página da lista do histórico
    fees: null,         // estimativa ao vivo do Electrum
    feesError: '',      // estimativa indisponível (taxa não veio do servidor)
    feesRetryTimer: 0,  // reconsulta sob demanda quando a taxa falta
    feeQuotes: null,    // custo de cada nível para o valor atual
    feeTimer: 0,        // reconsulta periódica da taxa
    amountDigits: '',   // satoshis digitados (o ponto é só desenho)
    amountError: '',    // valor recusado (acima do teto de dígitos)
    limits: null,       // máximo enviável para o destino e a taxa
    limitsError: '',    // máximo indisponível (nota neutra, não erro de campo)
    addressError: null, // destino recusado pelo servidor: { address, text }
    limitsTimer: 0,
    limitsSeq: 0,
    sendBusy: false,
    psbt: null,         // PSBT montado (texto e resumo)
    psbtStale: false,   // o PSBT na tela é de um pedido anterior ao formulário
    psbtKey: '',        // destino|valor|taxa do PSBT na tela
    psbtTimer: 0,       // debounce da montagem automática
    psbtSeq: 0,         // descarta resposta de um PSBT que já saiu da tela
    psbtPending: false, // há uma montagem em voo (frase "montando")
    psbtFailKey: '',    // pedido que falhou: não repete sozinho em laço
    psbtPendingKey: '', // pedido da montagem em voo (evita pedido dobrado)
    broadcast: null,    // PSBT assinado conferido pelo servidor (nada transmitido)
    broadcastText: '',  // texto do arquivo importado, só na memória da tela
    broadcastName: '',  // nome do arquivo importado
    broadcastBusy: false,
    broadcastSent: false, // a transação já foi publicada
    broadcastSeq: 0,    // descarta resposta de um arquivo que já saiu da tela
    cpfpSeq: 0,         // descarta resposta de uma aceleração que já saiu da tela
    sendValidationError: null, // erro de campo no #send-status, separado do PSBT
    screen: 'carteira', // tela em vigor (carteira | historico)
    langOpen: false,    // a tela de idiomas está aberta
    lang: 'pt',         // idioma em vigor (resolvido no arranque)
    langAuto: true,     // idioma automático em vigor
    historyState: 'idle', // idle | loading | error | ready
    langScroll: 0       // ponto de leitura devolvido pelo voltar da tela de idiomas
  };

  /* ------------------------------------------------------------- idiomas */
  /* Traduções completas em nove idiomas (VG-IDI-01..06): pt, en, es, fr,
     it, de, nl, ca e gl. Cada linha é [chave em português, en, es, fr, it,
     de, nl, ca, gl]. A chave é o próprio texto português (ou o molde com
     {campos}); o automático segue o navegador e cai no português quando ele
     não fala nenhum dos idiomas abaixo. */
  var LOCALES = ['pt', 'en', 'es', 'fr', 'it', 'de', 'nl', 'ca', 'gl'];
  var LOCALE_TAGS = { pt: 'pt-BR', en: 'en', es: 'es', fr: 'fr', it: 'it', de: 'de', nl: 'nl', ca: 'ca', gl: 'gl' };
  var LOCALE_CODES = { pt: 'PT', en: 'EN', es: 'ES', fr: 'FR', it: 'IT', de: 'DE', nl: 'NL', ca: 'CA', gl: 'GL' };
  var LOCALE_META = { pt: 'pt_BR', en: 'en_US', es: 'es_ES', fr: 'fr_FR', it: 'it_IT', de: 'de_DE', nl: 'nl_NL', ca: 'ca_ES', gl: 'gl_ES' };
  var I18N_ROWS = [
    ["Monitor BTC — carteira watch-only","Monitor BTC — watch-only wallet","Monitor BTC — cartera de solo lectura","Monitor BTC — portefeuille en lecture seule","Monitor BTC — portafoglio di sola lettura","Monitor BTC — Nur-Lese-Wallet","Monitor BTC — alleen-lezen portemonnee","Monitor BTC — cartera de només lectura","Monitor BTC — carteira de só lectura"],
    ["pular para o conteúdo","skip to content","saltar al contenido","aller au contenu","salta al contenuto","zum Inhalt springen","naar de inhoud","salta al contingut","saltar ao contido"],
    ["Telas","Screens","Pantallas","Écrans","Schermate","Bildschirme","Schermen","Pantalles","Pantallas"],
    ["carteira","wallet","cartera","portefeuille","portafoglio","wallet","portemonnee","cartera","carteira"],
    ["histórico","history","historial","historique","cronologia","verlauf","geschiedenis","historial","historial"],
    ["sobre","about","acerca de","à propos","informazioni","über","over","sobre","sobre"],
    ["CARTEIRA","WALLET","CARTERA","PORTEFEUILLE","PORTAFOGLIO","WALLET","PORTEMONNEE","CARTERA","CARTEIRA"],
    ["HISTÓRICO","HISTORY","HISTORIAL","HISTORIQUE","CRONOLOGIA","VERLAUF","GESCHIEDENIS","HISTORIAL","HISTORIAL"],
    ["chave pública","public key","clave pública","clé publique","chiave pubblica","öffentlicher Schlüssel","openbare sleutel","clau pública","clave pública"],
    ["continuar busca","continue search","continuar búsqueda","continuer la recherche","continua la ricerca","suche fortsetzen","zoeken voortzetten","continua la cerca","continuar a busca"],
    ["receber","receive","recibir","recevoir","ricevere","empfangen","ontvangen","rebre","recibir"],
    ["enviar","send","enviar","envoyer","inviare","senden","verzenden","enviar","enviar"],
    ["destino","destination","destino","destination","destinazione","Ziel","bestemming","destinació","destino"],
    ["quantidade","amount","importe","montant","importo","Betrag","bedrag","import","importe"],
    ["saída","output","salida","sortie","uscita","Ausgabe","uitgang","sortida","saída"],
    ["troco","change","cambio","monnaie","resto","Wechselgeld","wisselgeld","canvi","troco"],
    ["endereço","address","dirección","adresse","indirizzo","Adresse","adres","adreça","enderezo"],
    ["taxa","fee","comisión","frais","commissione","Gebühr","kosten","comissió","comisión"],
    ["pó","dust","polvo","poussière","polvere","Staub","stof","pols","po"],
    ["txid","txid","txid","txid","txid","txid","txid","txid","txid"],
    ["vsize","vsize","vsize","vsize","vsize","vsize","vsize","vsize","vsize"],
    ["rbf","rbf","rbf","rbf","rbf","rbf","rbf","rbf","rbf"],
    ["agendado","scheduled","programado","programmé","programmato","geplant","gepland","programat","programado"],
    ["Exportar PSBT","Export PSBT","Exportar PSBT","Exporter le PSBT","Esporta PSBT","PSBT exportieren","PSBT exporteren","Exportar PSBT","Exportar PSBT"],
    ["baixar","download","descargar","télécharger","scarica","herunterladen","downloaden","descarregar","descargar"],
    ["importar psbt","import psbt","importar psbt","importer psbt","importa psbt","psbt importieren","psbt importeren","importar psbt","importar psbt"],
    ["transmitir","broadcast","transmitir","diffuser","trasmettere","senden","uitzenden","transmetre","transmitir"],
    ["resumo da transação assinada","signed transaction summary","resumen de la transacción firmada","récapitulatif de la transaction signée","riepilogo della transazione firmata","Übersicht der signierten Transaktion","overzicht van de ondertekende transactie","resum de la transacció signada","resumo da transacción asinada"],
    ["arquivo","file","archivo","fichier","file","Datei","bestand","fitxer","ficheiro"],
    ["Transmitir transação","Broadcast transaction","Transmitir transacción","Diffuser la transaction","Trasmetti transazione","Transaktion senden","Transactie uitzenden","Transmetre transacció","Transmitir transacción"],
    ["cancelar","cancel","cancelar","annuler","annulla","abbrechen","annuleren","cancel·lar","cancelar"],
    ["confirmar","confirm","confirmar","confirmer","conferma","bestätigen","bevestigen","confirmar","confirmar"],
    ["[ ... ] carregando transações...","[ ... ] loading transactions...","[ ... ] cargando transacciones...","[ ... ] chargement des transactions...","[ ... ] caricamento transazioni...","[ ... ] Transaktionen werden geladen...","[ ... ] transacties laden...","[ ... ] carregant transaccions...","[ ... ] cargando transaccións..."],
    ["[ erro ] não foi possível carregar o histórico.","[ error ] the history could not be loaded.","[ error ] no se pudo cargar el historial.","[ erreur ] impossible de charger l'historique.","[ errore ] non è stato possibile caricare la cronologia.","[ Fehler ] der Verlauf konnte nicht geladen werden.","[ fout ] de geschiedenis kon niet worden geladen.","[ error ] no s'ha pogut carregar l'historial.","[ erro ] non foi posible cargar o historial."],
    ["tentar de novo","try again","intentar de nuevo","réessayer","riprova","erneut versuchen","opnieuw proberen","tornar-ho a provar","tentar de novo"],
    ["[ vazio ] nenhuma transação ainda.","[ empty ] no transactions yet.","[ vacío ] todavía no hay transacciones.","[ vide ] aucune transaction pour l'instant.","[ vuoto ] nessuna transazione per ora.","[ leer ] noch keine Transaktionen.","[ leeg ] nog geen transacties.","[ buit ] encara no hi ha transaccions.","[ baleiro ] aínda non hai transaccións."],
    ["SOBRE","ABOUT","ACERCA DE","À PROPOS","INFORMAZIONI","ÜBER","OVER","SOBRE","SOBRE"],
    ["o que é esta ferramenta","what this tool is","qué es esta herramienta","ce qu'est cet outil","cos'è questo strumento","was dieses Werkzeug ist","wat deze tool is","què és aquesta eina","que é esta ferramenta"],
    ["O Monitor BTC é uma carteira de acompanhamento. Você cola a chave pública da sua carteira Bitcoin (<code>xpub</code>, <code>zpub</code> ou <code>ypub</code>) e ele mostra o saldo, os endereços para receber e o histórico de transações. Ele não pede senha, não guarda nada e não tem a chave privada: só lê o que já existe na rede.","Monitor BTC is a watch-only wallet. You paste your Bitcoin wallet's public key (<code>xpub</code>, <code>zpub</code> or <code>ypub</code>) and it shows the balance, the receiving addresses and the transaction history. It does not ask for a password, stores nothing and does not hold the private key: it only reads what already exists on the network.","Monitor BTC es una cartera de seguimiento. Pegas la clave pública de tu cartera Bitcoin (<code>xpub</code>, <code>zpub</code> o <code>ypub</code>) y muestra el saldo, las direcciones para recibir y el historial de transacciones. No pide contraseña, no guarda nada y no tiene la clave privada: solo lee lo que ya existe en la red.","Monitor BTC est un portefeuille de suivi. Vous collez la clé publique de votre portefeuille Bitcoin (<code>xpub</code>, <code>zpub</code> ou <code>ypub</code>) et il affiche le solde, les adresses de réception et l'historique des transactions. Il ne demande pas de mot de passe, ne conserve rien et ne détient pas la clé privée : il ne lit que ce qui existe déjà sur le réseau.","Monitor BTC è un portafoglio di sola osservazione. Incolli la chiave pubblica del tuo portafoglio Bitcoin (<code>xpub</code>, <code>zpub</code> o <code>ypub</code>) e mostra il saldo, gli indirizzi per ricevere e la cronologia delle transazioni. Non chiede una password, non salva nulla e non ha la chiave privata: legge solo ciò che esiste già nella rete.","Monitor BTC ist eine Nur-Lese-Wallet. Du fügst den öffentlichen Schlüssel deiner Bitcoin-Wallet ein (<code>xpub</code>, <code>zpub</code> oder <code>ypub</code>) und sie zeigt das Guthaben, die Empfangsadressen und den Transaktionsverlauf. Sie fragt nach keinem Passwort, speichert nichts und hat keinen privaten Schlüssel: Sie liest nur, was bereits im Netzwerk existiert.","Monitor BTC is een alleen-lezen portemonnee. Je plakt de openbare sleutel van je Bitcoin-portemonnee (<code>xpub</code>, <code>zpub</code> of <code>ypub</code>) en hij toont het saldo, de ontvangstadressen en de transactiegeschiedenis. Hij vraagt geen wachtwoord, bewaart niets en heeft de privésleutel niet: hij leest alleen wat al op het netwerk bestaat.","Monitor BTC és una cartera de seguiment. Enganxes la clau pública de la teva cartera Bitcoin (<code>xpub</code>, <code>zpub</code> o <code>ypub</code>) i mostra el saldo, les adreces per rebre i l'historial de transaccions. No demana contrasenya, no desa res i no té la clau privada: només llegeix el que ja existeix a la xarxa.","Monitor BTC é unha carteira de seguimento. Pegas a clave pública da túa carteira Bitcoin (<code>xpub</code>, <code>zpub</code> ou <code>ypub</code>) e mostra o saldo, os enderezos para recibir e o historial de transaccións. Non pide contrasinal, non garda nada e non ten a clave privada: só le o que xa existe na rede."],
    ["A derivação acontece no navegador: a xpub não é enviada ao servidor; ele recebe só scripthashes, txids e transações.", "Derivation happens in the browser: the xpub is not sent to the server; it receives only scripthashes, txids and transactions.", "La derivación ocurre en el navegador: la xpub no se envía al servidor; solo recibe scripthashes, txids y transacciones.", "La dérivation se fait dans le navigateur : la xpub n'est pas envoyée au serveur ; il ne reçoit que des scripthashes, txids et transactions.", "La derivazione avviene nel browser: la xpub non viene inviata al server; riceve solo scripthash, txid e transazioni.", "Die Ableitung erfolgt im Browser: Die xpub wird nicht an den Server gesendet; er erhält nur Scripthashes, Txids und Transaktionen.", "De afleiding gebeurt in de browser: de xpub wordt niet naar de server gestuurd; hij ontvangt alleen scripthashes, txids en transacties.", "La derivació es fa al navegador: la xpub no s'envia al servidor; només rep scripthashes, txids i transaccions.", "A derivación faise no navegador: a xpub non se envía ao servidor; só recibe scripthashes, txids e transaccións."],
    ["Ele também prepara o envio. Você informa o valor e o destino; a taxa é calculada ao vivo e a ferramenta monta um arquivo de transação (PSBT) para ser assinado em outro programa. Depois de assinado, o arquivo volta para cá e pode ser transmitido. Quem assina é você, no <a class=\"prose-link\" href=\"https://github.com/RaelAles/BTC/releases/latest/download/cofre-btc.html\" download=\"cofre-btc.html\" title=\"baixar o Cofre BTC (arquivo standalone)\" aria-label=\"baixar o Cofre BTC (arquivo standalone)\">Cofre BTC</a>, offline; a chave privada nunca passa por esta tela.","It also prepares the send. You enter the amount and the destination; the fee is calculated live and the tool builds a transaction file (PSBT) to be signed in another program. Once signed, the file comes back here and can be broadcast. You are the one who signs, in <a class=\"prose-link\" href=\"https://github.com/RaelAles/BTC/releases/latest/download/cofre-btc.html\" download=\"cofre-btc.html\" title=\"download Cofre BTC (standalone file)\" aria-label=\"download Cofre BTC (standalone file)\">Cofre BTC</a>, offline; the private key never passes through this screen.","También prepara el envío. Indicas el importe y el destino; la comisión se calcula en vivo y la herramienta arma un archivo de transacción (PSBT) para firmar en otro programa. Una vez firmado, el archivo vuelve aquí y se puede transmitir. Quien firma eres tú, en el <a class=\"prose-link\" href=\"https://github.com/RaelAles/BTC/releases/latest/download/cofre-btc.html\" download=\"cofre-btc.html\" title=\"descargar el Cofre BTC (archivo standalone)\" aria-label=\"descargar el Cofre BTC (archivo standalone)\">Cofre BTC</a>, sin conexión; la clave privada nunca pasa por esta pantalla.","Il prépare aussi l'envoi. Vous indiquez le montant et la destination ; les frais sont calculés en direct et l'outil assemble un fichier de transaction (PSBT) à signer dans un autre programme. Une fois signé, le fichier revient ici et peut être diffusé. C'est vous qui signez, dans le <a class=\"prose-link\" href=\"https://github.com/RaelAles/BTC/releases/latest/download/cofre-btc.html\" download=\"cofre-btc.html\" title=\"télécharger le Cofre BTC (fichier autonome)\" aria-label=\"télécharger le Cofre BTC (fichier autonome)\">Cofre BTC</a>, hors ligne ; la clé privée ne passe jamais par cet écran.","Prepara anche l'invio. Indichi l'importo e la destinazione; la commissione viene calcolata in tempo reale e lo strumento compone un file di transazione (PSBT) da firmare in un altro programma. Una volta firmato, il file torna qui e può essere trasmesso. A firmare sei tu, nel <a class=\"prose-link\" href=\"https://github.com/RaelAles/BTC/releases/latest/download/cofre-btc.html\" download=\"cofre-btc.html\" title=\"scarica il Cofre BTC (file standalone)\" aria-label=\"scarica il Cofre BTC (file standalone)\">Cofre BTC</a>, offline; la chiave privata non passa mai da questa schermata.","Sie bereitet auch das Senden vor. Du gibst Betrag und Ziel ein; die Gebühr wird live berechnet und das Werkzeug erstellt eine Transaktionsdatei (PSBT), die in einem anderen Programm signiert wird. Nach der Signatur kommt die Datei hierher zurück und kann gesendet werden. Du signierst im <a class=\"prose-link\" href=\"https://github.com/RaelAles/BTC/releases/latest/download/cofre-btc.html\" download=\"cofre-btc.html\" title=\"Cofre BTC herunterladen (Standalone-Datei)\" aria-label=\"Cofre BTC herunterladen (Standalone-Datei)\">Cofre BTC</a>, offline; der private Schlüssel läuft nie über diesen Bildschirm.","Hij bereidt ook het verzenden voor. Je voert het bedrag en de bestemming in; de kosten worden live berekend en de tool maakt een transactiebestand (PSBT) om in een ander programma te ondertekenen. Na ondertekening komt het bestand hier terug en kan het worden uitgezonden. Jij ondertekent, in de <a class=\"prose-link\" href=\"https://github.com/RaelAles/BTC/releases/latest/download/cofre-btc.html\" download=\"cofre-btc.html\" title=\"Cofre BTC downloaden (standalone bestand)\" aria-label=\"Cofre BTC downloaden (standalone bestand)\">Cofre BTC</a>, offline; de privésleutel komt nooit door dit scherm.","També prepara l'enviament. Indiques l'import i la destinació; la comissió es calcula en directe i l'eina munta un fitxer de transacció (PSBT) per signar en un altre programa. Un cop signat, el fitxer torna aquí i es pot transmetre. Qui signa ets tu, al <a class=\"prose-link\" href=\"https://github.com/RaelAles/BTC/releases/latest/download/cofre-btc.html\" download=\"cofre-btc.html\" title=\"descarregar el Cofre BTC (fitxer autònom)\" aria-label=\"descarregar el Cofre BTC (fitxer autònom)\">Cofre BTC</a>, sense connexió; la clau privada no passa mai per aquesta pantalla.","Tamén prepara o envío. Indicas o importe e o destino; a comisión calcúlase en vivo e a ferramenta monta un ficheiro de transacción (PSBT) para asinar noutro programa. Unha vez asinado, o ficheiro volve aquí e pódese transmitir. Quen asina es ti, no <a class=\"prose-link\" href=\"https://github.com/RaelAles/BTC/releases/latest/download/cofre-btc.html\" download=\"cofre-btc.html\" title=\"descargar o Cofre BTC (ficheiro autónomo)\" aria-label=\"descargar o Cofre BTC (ficheiro autónomo)\">Cofre BTC</a>, sen conexión; a clave privada nunca pasa por esta pantalla."],
    ["baixar o Cofre BTC (arquivo standalone)","download Cofre BTC (standalone file)","descargar el Cofre BTC (archivo standalone)","télécharger le Cofre BTC (fichier autonome)","scarica il Cofre BTC (file standalone)","Cofre BTC herunterladen (Standalone-Datei)","Cofre BTC downloaden (standalone bestand)","descarregar el Cofre BTC (fitxer autònom)","descargar o Cofre BTC (ficheiro autónomo)"],
    ["Nada fica guardado: a chave, o saldo, os endereços e os arquivos ficam só na memória da aba e somem ao fechar ou recarregar a página; o navegador não guarda nem o tema nem o idioma.","Nothing is kept: the key, the balance, the addresses and the files live only in the tab's memory and disappear when you close or reload the page; the browser stores neither the theme nor the language.","No se guarda nada: la clave, el saldo, las direcciones y los archivos quedan solo en la memoria de la pestaña y desaparecen al cerrar o recargar la página; el navegador no guarda ni el tema ni el idioma.","Rien n'est conservé : la clé, le solde, les adresses et les fichiers restent uniquement dans la mémoire de l'onglet et disparaissent à la fermeture ou au rechargement de la page ; le navigateur ne conserve ni le thème ni la langue.","Nulla viene salvato: la chiave, il saldo, gli indirizzi e i file restano solo nella memoria della scheda e spariscono alla chiusura o al ricaricamento della pagina; il browser non salva né il tema né la lingua.","Nichts wird gespeichert: Schlüssel, Guthaben, Adressen und Dateien liegen nur im Speicher des Tabs und verschwinden beim Schließen oder Neuladen der Seite; der Browser speichert weder Design noch Sprache.","Niets wordt bewaard: de sleutel, het saldo, de adressen en de bestanden staan alleen in het geheugen van het tabblad en verdwijnen bij het sluiten of herladen van de pagina; de browser bewaart noch het thema noch de taal.","No es desa res: la clau, el saldo, les adreces i els fitxers queden només a la memòria de la pestanya i desapareixen en tancar o recarregar la pàgina; el navegador no desa ni el tema ni l'idioma.","Non se garda nada: a clave, o saldo, os enderezos e os ficheiros quedan só na memoria da lapela e desaparecen ao pechar ou recargar a páxina; o navegador non garda nin o tema nin o idioma."],
    ["como usar","how to use","cómo usar","comment utiliser","come usare","so verwenden","hoe te gebruiken","com usar","como usar"],
    ["<b>Acompanhar.</b> Na tela “carteira”, cole a chave pública no campo indicado. O saldo e os endereços aparecem sozinhos. Em “receber”, copie o endereço do tipo que o pagador aceita. Em “histórico”, veja as transações agrupadas pelo txid, com o que entrou, o que saiu e a taxa.","<b>Watch.</b> On the “wallet” screen, paste the public key into the indicated field. The balance and the addresses appear on their own. Under “receive”, copy the address of the type the payer accepts. Under “history”, see the transactions grouped by txid, with what came in, what went out and the fee.","<b>Seguir.</b> En la pantalla “cartera”, pega la clave pública en el campo indicado. El saldo y las direcciones aparecen solos. En “recibir”, copia la dirección del tipo que acepte el pagador. En “historial”, mira las transacciones agrupadas por txid, con lo que entró, lo que salió y la comisión.","<b>Suivre.</b> Sur l'écran « portefeuille », collez la clé publique dans le champ indiqué. Le solde et les adresses apparaissent seuls. Dans « recevoir », copiez l'adresse du type que le payeur accepte. Dans « historique », consultez les transactions groupées par txid, avec ce qui est entré, ce qui est sorti et les frais.","<b>Osservare.</b> Nella schermata “portafoglio”, incolla la chiave pubblica nel campo indicato. Il saldo e gli indirizzi compaiono da soli. In “ricevere”, copia l'indirizzo del tipo che il pagatore accetta. In “cronologia”, guarda le transazioni raggruppate per txid, con ciò che è entrato, ciò che è uscito e la commissione.","<b>Beobachten.</b> Füge auf dem Bildschirm „Wallet“ den öffentlichen Schlüssel in das angegebene Feld ein. Guthaben und Adressen erscheinen von selbst. Unter „Empfangen“ kopierst du die Adresse des Typs, den der Zahler akzeptiert. Unter „Verlauf“ siehst du die Transaktionen nach txid gruppiert, mit dem, was eingegangen und ausgegangen ist, und der Gebühr.","<b>Volgen.</b> Plak op het scherm “portemonnee” de openbare sleutel in het aangegeven veld. Het saldo en de adressen verschijnen vanzelf. Onder “ontvangen” kopieer je het adres van het type dat de betaler accepteert. Onder “geschiedenis” zie je de transacties gegroepeerd per txid, met wat er binnenkwam, wat er uitging en de kosten.","<b>Seguir.</b> A la pantalla “cartera”, enganxa la clau pública al camp indicat. El saldo i les adreces apareixen sols. A “rebre”, copia l'adreça del tipus que accepti el pagador. A “historial”, mira les transaccions agrupades pel txid, amb el que va entrar, el que va sortir i la comissió.","<b>Seguir.</b> Na pantalla “carteira”, pega a clave pública no campo indicado. O saldo e os enderezos aparecen sós. En “recibir”, copia o enderezo do tipo que acepte o pagador. En “historial”, mira as transaccións agrupadas polo txid, co que entrou, o que saíu e a comisión."],
    ["<b>Enviar.</b> Ainda em “carteira”, desça até “enviar”. Digite o valor e o destino; a taxa aparece sozinha e o arquivo é montado na hora. Clique em “baixar”. Assine esse arquivo no Cofre BTC, offline. Depois volte, abra “transmitir”, escolha o arquivo assinado, confira o resumo e clique em “confirmar”.","<b>Send.</b> Still on “wallet”, scroll down to “send”. Type the amount and the destination; the fee appears on its own and the file is built on the spot. Click “download”. Sign that file in Cofre BTC, offline. Then come back, open “broadcast”, choose the signed file, check the summary and click “confirm”.","<b>Enviar.</b> Aún en “cartera”, baja hasta “enviar”. Escribe el importe y el destino; la comisión aparece sola y el archivo se arma al momento. Haz clic en “descargar”. Firma ese archivo en el Cofre BTC, sin conexión. Después vuelve, abre “transmitir”, elige el archivo firmado, revisa el resumen y haz clic en “confirmar”.","<b>Envoyer.</b> Toujours sur « portefeuille », descendez jusqu'à « envoyer ». Saisissez le montant et la destination ; les frais apparaissent seuls et le fichier est assemblé aussitôt. Cliquez sur « télécharger ». Signez ce fichier dans le Cofre BTC, hors ligne. Revenez ensuite, ouvrez « diffuser », choisissez le fichier signé, vérifiez le récapitulatif et cliquez sur « confirmer ».","<b>Inviare.</b> Sempre in “portafoglio”, scorri fino a “inviare”. Digita l'importo e la destinazione; la commissione appare da sola e il file viene composto subito. Fai clic su “scarica”. Firma quel file nel Cofre BTC, offline. Poi torna, apri “trasmettere”, scegli il file firmato, controlla il riepilogo e fai clic su “conferma”.","<b>Senden.</b> Scrolle weiterhin unter „Wallet“ bis „Senden“. Gib Betrag und Ziel ein; die Gebühr erscheint von selbst und die Datei wird sofort erstellt. Klicke auf „Herunterladen“. Signiere diese Datei im Cofre BTC, offline. Komm dann zurück, öffne „Senden“, wähle die signierte Datei, prüfe die Übersicht und klicke auf „Bestätigen“.","<b>Verzenden.</b> Nog steeds op “portemonnee”, scrol naar “verzenden”. Typ het bedrag en de bestemming; de kosten verschijnen vanzelf en het bestand wordt direct gemaakt. Klik op “downloaden”. Onderteken dat bestand in Cofre BTC, offline. Kom daarna terug, open “uitzenden”, kies het ondertekende bestand, controleer het overzicht en klik op “bevestigen”.","<b>Enviar.</b> Encara a “cartera”, baixa fins a “enviar”. Escriu l'import i la destinació; la comissió apareix sola i el fitxer es munta a l'instant. Fes clic a “descarregar”. Signa aquest fitxer al Cofre BTC, sense connexió. Després torna, obre “transmetre”, tria el fitxer signat, revisa el resum i fes clic a “confirmar”.","<b>Enviar.</b> Aínda en “carteira”, baixa até “enviar”. Escribe o importe e o destino; a comisión aparece soa e o ficheiro móntase na hora. Fai clic en “descargar”. Asina ese ficheiro no Cofre BTC, sen conexión. Despois volve, abre “transmitir”, escolle o ficheiro asinado, revisa o resumo e fai clic en “confirmar”."],
    ["<b>Cofre BTC.</b> O assinador é o <a class=\"prose-link\" href=\"https://github.com/RaelAles/BTC/releases/latest/download/cofre-btc.html\" download=\"cofre-btc.html\" title=\"baixar o Cofre BTC (arquivo standalone)\" aria-label=\"baixar o Cofre BTC (arquivo standalone)\">Cofre BTC</a>, um arquivo único que funciona offline, sem servidor e sem internet. Clique no nome para baixar o standalone e abra-o no computador que guarda a chave.","<b>Cofre BTC.</b> The signer is <a class=\"prose-link\" href=\"https://github.com/RaelAles/BTC/releases/latest/download/cofre-btc.html\" download=\"cofre-btc.html\" title=\"download Cofre BTC (standalone file)\" aria-label=\"download Cofre BTC (standalone file)\">Cofre BTC</a>, a single file that works offline, without a server and without internet. Click the name to download the standalone and open it on the computer that holds the key.","<b>Cofre BTC.</b> El firmador es el <a class=\"prose-link\" href=\"https://github.com/RaelAles/BTC/releases/latest/download/cofre-btc.html\" download=\"cofre-btc.html\" title=\"descargar el Cofre BTC (archivo standalone)\" aria-label=\"descargar el Cofre BTC (archivo standalone)\">Cofre BTC</a>, un archivo único que funciona sin conexión, sin servidor y sin internet. Haz clic en el nombre para descargar el standalone y ábrelo en el ordenador que guarda la clave.","<b>Cofre BTC.</b> Le signataire est le <a class=\"prose-link\" href=\"https://github.com/RaelAles/BTC/releases/latest/download/cofre-btc.html\" download=\"cofre-btc.html\" title=\"télécharger le Cofre BTC (fichier autonome)\" aria-label=\"télécharger le Cofre BTC (fichier autonome)\">Cofre BTC</a>, un fichier unique qui fonctionne hors ligne, sans serveur et sans internet. Cliquez sur le nom pour télécharger le standalone et ouvrez-le sur l'ordinateur qui garde la clé.","<b>Cofre BTC.</b> Il firmatario è il <a class=\"prose-link\" href=\"https://github.com/RaelAles/BTC/releases/latest/download/cofre-btc.html\" download=\"cofre-btc.html\" title=\"scarica il Cofre BTC (file standalone)\" aria-label=\"scarica il Cofre BTC (file standalone)\">Cofre BTC</a>, un file unico che funziona offline, senza server e senza internet. Fai clic sul nome per scaricare lo standalone e aprilo sul computer che custodisce la chiave.","<b>Cofre BTC.</b> Der Signierer ist der <a class=\"prose-link\" href=\"https://github.com/RaelAles/BTC/releases/latest/download/cofre-btc.html\" download=\"cofre-btc.html\" title=\"Cofre BTC herunterladen (Standalone-Datei)\" aria-label=\"Cofre BTC herunterladen (Standalone-Datei)\">Cofre BTC</a>, eine einzelne Datei, die offline funktioniert, ohne Server und ohne Internet. Klicke auf den Namen, um das Standalone herunterzuladen, und öffne es auf dem Computer, der den Schlüssel verwahrt.","<b>Cofre BTC.</b> De ondertekenaar is de <a class=\"prose-link\" href=\"https://github.com/RaelAles/BTC/releases/latest/download/cofre-btc.html\" download=\"cofre-btc.html\" title=\"Cofre BTC downloaden (standalone bestand)\" aria-label=\"Cofre BTC downloaden (standalone bestand)\">Cofre BTC</a>, één bestand dat offline werkt, zonder server en zonder internet. Klik op de naam om de standalone te downloaden en open hem op de computer die de sleutel bewaart.","<b>Cofre BTC.</b> El signador és el <a class=\"prose-link\" href=\"https://github.com/RaelAles/BTC/releases/latest/download/cofre-btc.html\" download=\"cofre-btc.html\" title=\"descarregar el Cofre BTC (fitxer autònom)\" aria-label=\"descarregar el Cofre BTC (fitxer autònom)\">Cofre BTC</a>, un fitxer únic que funciona sense connexió, sense servidor i sense internet. Fes clic al nom per descarregar el standalone i obre'l a l'ordinador que guarda la clau.","<b>Cofre BTC.</b> O asinador é o <a class=\"prose-link\" href=\"https://github.com/RaelAles/BTC/releases/latest/download/cofre-btc.html\" download=\"cofre-btc.html\" title=\"descargar o Cofre BTC (ficheiro autónomo)\" aria-label=\"descargar o Cofre BTC (ficheiro autónomo)\">Cofre BTC</a>, un ficheiro único que funciona sen conexión, sen servidor e sen internet. Fai clic no nome para descargar o standalone e ábreo no ordenador que garda a clave."],
    ["<b>Acelerar.</b> Se uma transação sua ficar presa no mempool, o histórico oferece o botão “acelerar”. Ele monta um PSBT filho (CPFP) que gasta o troco da transação presa e devolve o resto para a carteira; o pai não muda. Assine o filho no Cofre BTC e importe o arquivo em “carteira”, no bloco “transmitir”. Se o Cofre mostrar a saída como externa, não assine.","<b>Speed up.</b> If one of your transactions gets stuck in the mempool, the history offers the “speed up” button. It builds a child PSBT (CPFP) that spends the stuck transaction's change and returns the rest to the wallet; the parent does not change. Sign the child in Cofre BTC and import the file under “wallet”, in the “broadcast” block. If Cofre shows the output as external, do not sign.","<b>Acelerar.</b> Si una transacción tuya se queda atascada en el mempool, el historial ofrece el botón “acelerar”. Arma un PSBT hijo (CPFP) que gasta el cambio de la transacción atascada y devuelve el resto a la cartera; el padre no cambia. Firma el hijo en el Cofre BTC e importa el archivo en “cartera”, en el bloque “transmitir”. Si el Cofre muestra la salida como externa, no firmes.","<b>Accélérer.</b> Si une de vos transactions reste bloquée dans le mempool, l'historique propose le bouton « accélérer ». Il assemble un PSBT enfant (CPFP) qui dépense le reste de la transaction bloquée et renvoie le solde au portefeuille ; la transaction parente ne change pas. Signez l'enfant dans le Cofre BTC et importez le fichier dans « portefeuille », dans le bloc « diffuser ». Si le Cofre affiche la sortie comme externe, ne signez pas.","<b>Accelerare.</b> Se una tua transazione resta bloccata nel mempool, la cronologia offre il pulsante “accelera”. Compone un PSBT figlio (CPFP) che spende il resto della transazione bloccata e restituisce il rimanente al portafoglio; la transazione madre non cambia. Firma il figlio nel Cofre BTC e importa il file in “portafoglio”, nel blocco “trasmettere”. Se il Cofre mostra l'uscita come esterna, non firmare.","<b>Beschleunigen.</b> Bleibt eine deiner Transaktionen im Mempool stecken, bietet der Verlauf die Schaltfläche „Beschleunigen“. Sie erstellt eine Kind-PSBT (CPFP), die das Wechselgeld der steckenden Transaktion ausgibt und den Rest an die Wallet zurückgibt; die Eltern-Transaktion ändert sich nicht. Signiere das Kind im Cofre BTC und importiere die Datei unter „Wallet“ im Block „Senden“. Wenn der Cofre die Ausgabe als extern anzeigt, signiere nicht.","<b>Versnellen.</b> Als een van je transacties vastloopt in de mempool, biedt de geschiedenis de knop “versnellen”. Die maakt een kind-PSBT (CPFP) die het wisselgeld van de vastgelopen transactie uitgeeft en de rest terugstuurt naar de portemonnee; de ouder verandert niet. Onderteken het kind in Cofre BTC en importeer het bestand onder “portemonnee”, in het blok “uitzenden”. Als Cofre de uitgang als extern toont, onderteken dan niet.","<b>Accelerar.</b> Si una transacció teva queda encallada al mempool, l'historial ofereix el botó “accelerar”. Munta un PSBT fill (CPFP) que gasta el canvi de la transacció encallada i torna la resta a la cartera; el pare no canvia. Signa el fill al Cofre BTC i importa el fitxer a “cartera”, al bloc “transmetre”. Si el Cofre mostra la sortida com a externa, no signis.","<b>Acelerar.</b> Se unha transacción túa queda atascada no mempool, o historial ofrece o botón “acelerar”. Monta un PSBT fillo (CPFP) que gasta o troco da transacción atascada e devolve o resto á carteira; o pai non cambia. Asina o fillo no Cofre BTC e importa o ficheiro en “carteira”, no bloque “transmitir”. Se o Cofre mostra a saída como externa, non asines."],
    ["<b>Telas.</b> O menu no alto alterna entre “carteira”, “histórico” e “sobre”.","<b>Screens.</b> The menu at the top switches between “wallet”, “history” and “about”.","<b>Pantallas.</b> El menú de arriba alterna entre “cartera”, “historial” y “acerca de”.","<b>Écrans.</b> Le menu en haut alterne entre « portefeuille », « historique » et « à propos ».","<b>Schermate.</b> Il menu in alto alterna tra “portafoglio”, “cronologia” e “informazioni”.","<b>Bildschirme.</b> Das Menü oben wechselt zwischen „Wallet“, „Verlauf“ und „Über“.","<b>Schermen.</b> Het menu bovenaan wisselt tussen “portemonnee”, “geschiedenis” en “over”.","<b>Pantalles.</b> El menú de dalt alterna entre “cartera”, “historial” i “sobre”.","<b>Pantallas.</b> O menú de arriba alterna entre “carteira”, “historial” e “sobre”."],
    ["os BIPs usados","the BIPs used","los BIP usados","les BIP utilisés","i BIP usati","die verwendeten BIPs","de gebruikte BIP's","els BIP usats","os BIP usados"],
    ["Os BIPs são as regras públicas do Bitcoin que a ferramenta segue. Eles cobrem a chave, os endereços e o arquivo de transação.","BIPs are the public Bitcoin rules the tool follows. They cover the key, the addresses and the transaction file.","Los BIP son las reglas públicas de Bitcoin que sigue la herramienta. Cubren la clave, las direcciones y el archivo de transacción.","Les BIP sont les règles publiques de Bitcoin que suit l'outil. Ils couvrent la clé, les adresses et le fichier de transaction.","I BIP sono le regole pubbliche di Bitcoin che lo strumento segue. Coprono la chiave, gli indirizzi e il file di transazione.","BIPs sind die öffentlichen Bitcoin-Regeln, denen das Werkzeug folgt. Sie decken den Schlüssel, die Adressen und die Transaktionsdatei ab.","BIP's zijn de openbare Bitcoin-regels die de tool volgt. Ze dekken de sleutel, de adressen en het transactiebestand.","Els BIP són les regles públiques de Bitcoin que segueix l'eina. Cobreixen la clau, les adreces i el fitxer de transacció.","Os BIP son as regras públicas de Bitcoin que segue a ferramenta. Cobren a clave, os enderezos e o ficheiro de transacción."],
    ["<b>Chave e contas.</b>","<b>Key and accounts.</b>","<b>Clave y cuentas.</b>","<b>Clé et comptes.</b>","<b>Chiave e conti.</b>","<b>Schlüssel und Konten.</b>","<b>Sleutel en rekeningen.</b>","<b>Clau i comptes.</b>","<b>Clave e contas.</b>"],
    ["<b>BIP32</b> — chave pública estendida e derivação dos endereços.","<b>BIP32</b> — extended public key and address derivation.","<b>BIP32</b> — clave pública extendida y derivación de las direcciones.","<b>BIP32</b> — clé publique étendue et dérivation des adresses.","<b>BIP32</b> — chiave pubblica estesa e derivazione degli indirizzi.","<b>BIP32</b> — erweiterter öffentlicher Schlüssel und Adressableitung.","<b>BIP32</b> — uitgebreide openbare sleutel en afleiding van adressen.","<b>BIP32</b> — clau pública estesa i derivació de les adreces.","<b>BIP32</b> — clave pública estendida e derivación dos enderezos."],
    ["<b>BIP43</b> — tipo da conta no caminho da chave.","<b>BIP43</b> — account type in the key path.","<b>BIP43</b> — tipo de cuenta en la ruta de la clave.","<b>BIP43</b> — type de compte dans le chemin de la clé.","<b>BIP43</b> — tipo di conto nel percorso della chiave.","<b>BIP43</b> — Kontotyp im Schlüsselpfad.","<b>BIP43</b> — rekeningtype in het sleutelpad.","<b>BIP43</b> — tipus de compte al camí de la clau.","<b>BIP43</b> — tipo de conta no camiño da clave."],
    ["<b>BIP44</b> — conta antiga (endereços começando com <code>1</code>).","<b>BIP44</b> — legacy account (addresses starting with <code>1</code>).","<b>BIP44</b> — cuenta antigua (direcciones que empiezan por <code>1</code>).","<b>BIP44</b> — compte ancien (adresses commençant par <code>1</code>).","<b>BIP44</b> — conto legacy (indirizzi che iniziano con <code>1</code>).","<b>BIP44</b> — altes Konto (Adressen, die mit <code>1</code> beginnen).","<b>BIP44</b> — oude rekening (adressen die met <code>1</code> beginnen).","<b>BIP44</b> — compte antic (adreces que comencen per <code>1</code>).","<b>BIP44</b> — conta antiga (enderezos que comezan por <code>1</code>)."],
    ["<b>BIP49</b> — conta segwit aninhada (endereços começando com <code>3</code>).","<b>BIP49</b> — nested segwit account (addresses starting with <code>3</code>).","<b>BIP49</b> — cuenta segwit anidada (direcciones que empiezan por <code>3</code>).","<b>BIP49</b> — compte segwit imbriqué (adresses commençant par <code>3</code>).","<b>BIP49</b> — conto segwit annidato (indirizzi che iniziano con <code>3</code>).","<b>BIP49</b> — verschachteltes Segwit-Konto (Adressen, die mit <code>3</code> beginnen).","<b>BIP49</b> — geneste segwit-rekening (adressen die met <code>3</code> beginnen).","<b>BIP49</b> — compte segwit imbricat (adreces que comencen per <code>3</code>).","<b>BIP49</b> — conta segwit aniñada (enderezos que comezan por <code>3</code>)."],
    ["<b>BIP84</b> — conta segwit nativa (endereços começando com <code>bc1q</code>).","<b>BIP84</b> — native segwit account (addresses starting with <code>bc1q</code>).","<b>BIP84</b> — cuenta segwit nativa (direcciones que empiezan por <code>bc1q</code>).","<b>BIP84</b> — compte segwit natif (adresses commençant par <code>bc1q</code>).","<b>BIP84</b> — conto segwit nativo (indirizzi che iniziano con <code>bc1q</code>).","<b>BIP84</b> — natives Segwit-Konto (Adressen, die mit <code>bc1q</code> beginnen).","<b>BIP84</b> — native segwit-rekening (adressen die met <code>bc1q</code> beginnen).","<b>BIP84</b> — compte segwit natiu (adreces que comencen per <code>bc1q</code>).","<b>BIP84</b> — conta segwit nativa (enderezos que comezan por <code>bc1q</code>)."],
    ["<b>BIP86</b> — conta Taproot (endereços começando com <code>bc1p</code>).","<b>BIP86</b> — Taproot account (addresses starting with <code>bc1p</code>).","<b>BIP86</b> — cuenta Taproot (direcciones que empiezan por <code>bc1p</code>).","<b>BIP86</b> — compte Taproot (adresses commençant par <code>bc1p</code>).","<b>BIP86</b> — conto Taproot (indirizzi che iniziano con <code>bc1p</code>).","<b>BIP86</b> — Taproot-Konto (Adressen, die mit <code>bc1p</code> beginnen).","<b>BIP86</b> — Taproot-rekening (adressen die met <code>bc1p</code> beginnen).","<b>BIP86</b> — compte Taproot (adreces que comencen per <code>bc1p</code>).","<b>BIP86</b> — conta Taproot (enderezos que comezan por <code>bc1p</code>)."],
    ["<b>Endereços.</b>","<b>Addresses.</b>","<b>Direcciones.</b>","<b>Adresses.</b>","<b>Indirizzi.</b>","<b>Adressen.</b>","<b>Adressen.</b>","<b>Adreces.</b>","<b>Enderezos.</b>"],
    ["<b>BIP13</b> — formato do endereço que começa com <code>3</code>, usado no BIP49.","<b>BIP13</b> — format of the address starting with <code>3</code>, used in BIP49.","<b>BIP13</b> — formato de la dirección que empieza por <code>3</code>, usado en BIP49.","<b>BIP13</b> — format de l'adresse commençant par <code>3</code>, utilisé dans BIP49.","<b>BIP13</b> — formato dell'indirizzo che inizia con <code>3</code>, usato in BIP49.","<b>BIP13</b> — Format der Adresse, die mit <code>3</code> beginnt, verwendet in BIP49.","<b>BIP13</b> — formaat van het adres dat met <code>3</code> begint, gebruikt in BIP49.","<b>BIP13</b> — format de l'adreça que comença per <code>3</code>, usat a BIP49.","<b>BIP13</b> — formato do enderezo que comeza por <code>3</code>, usado no BIP49."],
    ["<b>BIP16</b> — regra do endereço que começa com <code>3</code>, usado no BIP49.","<b>BIP16</b> — rule of the address starting with <code>3</code>, used in BIP49.","<b>BIP16</b> — regla de la dirección que empieza por <code>3</code>, usada en BIP49.","<b>BIP16</b> — règle de l'adresse commençant par <code>3</code>, utilisée dans BIP49.","<b>BIP16</b> — regola dell'indirizzo che inizia con <code>3</code>, usato in BIP49.","<b>BIP16</b> — Regel der Adresse, die mit <code>3</code> beginnt, verwendet in BIP49.","<b>BIP16</b> — regel van het adres dat met <code>3</code> begint, gebruikt in BIP49.","<b>BIP16</b> — regla de l'adreça que comença per <code>3</code>, usada a BIP49.","<b>BIP16</b> — regra do enderezo que comeza por <code>3</code>, usado no BIP49."],
    ["<b>BIP141</b> — regra dos endereços segwit.","<b>BIP141</b> — rule for segwit addresses.","<b>BIP141</b> — regla de las direcciones segwit.","<b>BIP141</b> — règle des adresses segwit.","<b>BIP141</b> — regola degli indirizzi segwit.","<b>BIP141</b> — Regel für Segwit-Adressen.","<b>BIP141</b> — regel voor segwit-adressen.","<b>BIP141</b> — regla de les adreces segwit.","<b>BIP141</b> — regra dos enderezos segwit."],
    ["<b>BIP173</b> — escrita dos endereços <code>bc1q</code>.","<b>BIP173</b> — spelling of <code>bc1q</code> addresses.","<b>BIP173</b> — escritura de las direcciones <code>bc1q</code>.","<b>BIP173</b> — écriture des adresses <code>bc1q</code>.","<b>BIP173</b> — scrittura degli indirizzi <code>bc1q</code>.","<b>BIP173</b> — Schreibweise der <code>bc1q</code>-Adressen.","<b>BIP173</b> — schrijfwijze van <code>bc1q</code>-adressen.","<b>BIP173</b> — escriptura de les adreces <code>bc1q</code>.","<b>BIP173</b> — escrita dos enderezos <code>bc1q</code>."],
    ["<b>BIP341</b> — chave pública do endereço <code>bc1p</code> (Taproot).","<b>BIP341</b> — public key of the <code>bc1p</code> address (Taproot).","<b>BIP341</b> — clave pública de la dirección <code>bc1p</code> (Taproot).","<b>BIP341</b> — clé publique de l'adresse <code>bc1p</code> (Taproot).","<b>BIP341</b> — chiave pubblica dell'indirizzo <code>bc1p</code> (Taproot).","<b>BIP341</b> — öffentlicher Schlüssel der <code>bc1p</code>-Adresse (Taproot).","<b>BIP341</b> — openbare sleutel van het <code>bc1p</code>-adres (Taproot).","<b>BIP341</b> — clau pública de l'adreça <code>bc1p</code> (Taproot).","<b>BIP341</b> — clave pública do enderezo <code>bc1p</code> (Taproot)."],
    ["<b>BIP350</b> — escrita dos endereços <code>bc1p</code>.","<b>BIP350</b> — spelling of <code>bc1p</code> addresses.","<b>BIP350</b> — escritura de las direcciones <code>bc1p</code>.","<b>BIP350</b> — écriture des adresses <code>bc1p</code>.","<b>BIP350</b> — scrittura degli indirizzi <code>bc1p</code>.","<b>BIP350</b> — Schreibweise der <code>bc1p</code>-Adressen.","<b>BIP350</b> — schrijfwijze van <code>bc1p</code>-adressen.","<b>BIP350</b> — escriptura de les adreces <code>bc1p</code>.","<b>BIP350</b> — escrita dos enderezos <code>bc1p</code>."],
    ["<b>Transação.</b>","<b>Transaction.</b>","<b>Transacción.</b>","<b>Transaction.</b>","<b>Transazione.</b>","<b>Transaktion.</b>","<b>Transactie.</b>","<b>Transacció.</b>","<b>Transacción.</b>"],
    ["<b>BIP125</b> — sinalização de substituição (RBF). A ferramenta não sinaliza: o resumo mostra <code>rbf</code> como <code>não</code>.","<b>BIP125</b> — replacement signaling (RBF). The tool does not signal: the summary shows <code>rbf</code> as <code>no</code>.","<b>BIP125</b> — señalización de sustitución (RBF). La herramienta no señala: el resumen muestra <code>rbf</code> como <code>no</code>.","<b>BIP125</b> — signalement de remplacement (RBF). L'outil ne signale pas : le récapitulatif affiche <code>rbf</code> comme <code>non</code>.","<b>BIP125</b> — segnalazione di sostituzione (RBF). Lo strumento non segnala: il riepilogo mostra <code>rbf</code> come <code>no</code>.","<b>BIP125</b> — Ersetzungssignalisierung (RBF). Das Werkzeug signalisiert nicht: die Übersicht zeigt <code>rbf</code> als <code>nein</code>.","<b>BIP125</b> — signaal voor vervanging (RBF). De tool signaleert niet: het overzicht toont <code>rbf</code> als <code>nee</code>.","<b>BIP125</b> — senyalització de substitució (RBF). L'eina no senyalitza: el resum mostra <code>rbf</code> com a <code>no</code>.","<b>BIP125</b> — sinalización de substitución (RBF). A ferramenta non sinaliza: o resumo mostra <code>rbf</code> como <code>non</code>."],
    ["<b>BIP174</b> — formato do arquivo de transação (PSBT).","<b>BIP174</b> — transaction file format (PSBT).","<b>BIP174</b> — formato del archivo de transacción (PSBT).","<b>BIP174</b> — format du fichier de transaction (PSBT).","<b>BIP174</b> — formato del file di transazione (PSBT).","<b>BIP174</b> — Format der Transaktionsdatei (PSBT).","<b>BIP174</b> — formaat van het transactiebestand (PSBT).","<b>BIP174</b> — format del fitxer de transacció (PSBT).","<b>BIP174</b> — formato do ficheiro de transacción (PSBT)."],
    ["<b>BIP371</b> — dados do Taproot dentro do arquivo de transação.","<b>BIP371</b> — Taproot data inside the transaction file.","<b>BIP371</b> — datos de Taproot dentro del archivo de transacción.","<b>BIP371</b> — données Taproot dans le fichier de transaction.","<b>BIP371</b> — dati Taproot nel file di transazione.","<b>BIP371</b> — Taproot-Daten in der Transaktionsdatei.","<b>BIP371</b> — Taproot-gegevens in het transactiebestand.","<b>BIP371</b> — dades de Taproot dins del fitxer de transacció.","<b>BIP371</b> — datos de Taproot dentro do ficheiro de transacción."],
    ["A ferramenta trabalha só com a rede principal do Bitcoin.","The tool works only with the Bitcoin mainnet.","La herramienta trabaja solo con la red principal de Bitcoin.","L'outil ne travaille qu'avec le réseau principal de Bitcoin.","Lo strumento lavora solo con la rete principale di Bitcoin.","Das Werkzeug arbeitet nur mit dem Bitcoin-Hauptnetz.","De tool werkt alleen met het Bitcoin-hoofdnet.","L'eina treballa només amb la xarxa principal de Bitcoin.","A ferramenta traballa só coa rede principal de Bitcoin."],
    ["<b>Última atualização:</b> <time datetime=\"2026-11-17\">17 de novembro de 2026</time>.","<b>Last updated:</b> <time datetime=\"2026-11-17\">November 17, 2026</time>.","<b>Última actualización:</b> <time datetime=\"2026-11-17\">17 de noviembre de 2026</time>.","<b>Dernière mise à jour :</b> <time datetime=\"2026-11-17\">17 novembre 2026</time>.","<b>Ultimo aggiornamento:</b> <time datetime=\"2026-11-17\">17 novembre 2026</time>.","<b>Letzte Aktualisierung:</b> <time datetime=\"2026-11-17\">17. November 2026</time>.","<b>Laatst bijgewerkt:</b> <time datetime=\"2026-11-17\">17 november 2026</time>.","<b>Última actualització:</b> <time datetime=\"2026-11-17\">17 de novembre de 2026</time>.","<b>Última actualización:</b> <time datetime=\"2026-11-17\">17 de novembro de 2026</time>."],
    ["Página não encontrada. O endereço que você abriu não existe: pode ter mudado de lugar ou o link pode estar quebrado.","Page not found. The address you opened does not exist: it may have moved or the link may be broken.","Página no encontrada. La dirección que abriste no existe: puede haber cambiado de lugar o el enlace puede estar roto.","Page introuvable. L'adresse que vous avez ouverte n'existe pas : elle a peut-être changé de place ou le lien est peut-être cassé.","Pagina non trovata. L'indirizzo che hai aperto non esiste: può essersi spostato o il link può essere rotto.","Seite nicht gefunden. Die Adresse, die du geöffnet hast, existiert nicht: Sie könnte umgezogen sein oder der Link könnte defekt sein.","Pagina niet gevonden. Het adres dat je hebt geopend bestaat niet: het is misschien verplaatst of de link is misschien kapot.","Pàgina no trobada. L'adreça que has obert no existeix: pot haver canviat de lloc o l'enllaç pot estar trencat.","Páxina non atopada. O enderezo que abriches non existe: pode ter cambiado de lugar ou a ligazón pode estar rota."],
    ["IDIOMAS","LANGUAGES","IDIOMAS","LANGUES","LINGUE","SPRACHEN","TALEN","IDIOMES","IDIOMAS"],
    ["Idiomas","Languages","Idiomas","Langues","Lingue","Sprachen","Talen","Idiomes","Idiomas"],
    ["automático","automatic","automático","automatique","automatico","automatisch","automatisch","automàtic","automático"],
    ["voltar","back","volver","retour","indietro","zurück","terug","torna","volver"],
    ["Rolar para cima","Scroll up","Desplazar hacia arriba","Faire défiler vers le haut","Scorri verso l'alto","Nach oben scrollen","Naar boven scrollen","Desplaça cap amunt","Desprazar cara arriba"],
    ["Rolar para baixo","Scroll down","Desplazar hacia abajo","Faire défiler vers le bas","Scorri verso il basso","Nach unten scrollen","Naar beneden scrollen","Desplaça cap avall","Desprazar cara abaixo"],
    ["Páginas do histórico","History pages","Páginas del historial","Pages de l'historique","Pagine della cronologia","Seiten des Verlaufs","Pagina's van de geschiedenis","Pàgines de l'historial","Páxinas do historial"],
    ["Página anterior","Previous page","Página anterior","Page précédente","Pagina precedente","Vorherige Seite","Vorige pagina","Pàgina anterior","Páxina anterior"],
    ["de","of","de","sur","di","von","van","de","de"],
    ["Próxima página","Next page","Página siguiente","Page suivante","Pagina successiva","Nächste Seite","Volgende pagina","Pàgina següent","Páxina seguinte"],
    ["Idioma","Language","Idioma","Langue","Lingua","Sprache","Taal","Idioma","Idioma"],
    ["Ativar tema escuro","Enable dark theme","Activar tema oscuro","Activer le thème sombre","Attiva tema scuro","Dunkles Design aktivieren","Donker thema inschakelen","Activa el tema fosc","Activar o tema escuro"],
    ["Ativar tema claro","Enable light theme","Activar tema claro","Activer le thème clair","Attiva tema chiaro","Helles Design aktivieren","Licht thema inschakelen","Activa el tema clar","Activar o tema claro"],
    ["Monitor BTC — a chave pública da sua carteira como credencial, saldo e endereços derivados na hora, e envio de BTC em PSBT sem assinatura. Nada é guardado: nem a chave, nem os endereços. Sem chave privada.","Monitor BTC — your wallet's public key as the credential, balance and addresses derived on the spot, and BTC sent as an unsigned PSBT. Nothing is stored: not the key, not the addresses. No private key.","Monitor BTC — la clave pública de tu cartera como credencial, saldo y direcciones derivadas al momento, y envío de BTC en un PSBT sin firmar. No se guarda nada: ni la clave ni las direcciones. Sin clave privada.","Monitor BTC — la clé publique de votre portefeuille comme identifiant, solde et adresses dérivés à la volée, et envoi de BTC en PSBT non signé. Rien n'est conservé : ni la clé, ni les adresses. Sans clé privée.","Monitor BTC — la chiave pubblica del tuo portafoglio come credenziale, saldo e indirizzi derivati al momento, e invio di BTC in un PSBT non firmato. Nulla viene salvato: né la chiave né gli indirizzi. Senza chiave privata.","Monitor BTC — der öffentliche Schlüssel deiner Wallet als Zugang, Guthaben und Adressen sofort abgeleitet, und BTC-Versand als unsignierte PSBT. Nichts wird gespeichert: weder der Schlüssel noch die Adressen. Ohne privaten Schlüssel.","Monitor BTC — de openbare sleutel van je wallet als inloggegevens, saldo en adressen direct afgeleid, en BTC versturen als niet-ondertekende PSBT. Niets wordt bewaard: noch de sleutel, noch de adressen. Zonder privésleutel.","Monitor BTC — la clau pública de la teva cartera com a credencial, saldo i adreces derivades a l'instant, i enviament de BTC en un PSBT sense signar. No es desa res: ni la clau ni les adreces. Sense clau privada.","Monitor BTC — a clave pública da túa carteira como credencial, saldo e enderezos derivados na hora, e envío de BTC nun PSBT sen sinatura. Non se garda nada: nin a clave nin os enderezos. Sen clave privada."],
    ["Card escuro do Monitor BTC, com o ícone do Monitor BTC, o título e o idioma português.","Dark Monitor BTC card, with the Monitor BTC icon, the title and the Portuguese language.","Tarjeta oscura de Monitor BTC, con el icono de Monitor BTC, el título y el idioma portugués.","Carte sombre de Monitor BTC, avec l'icône de Monitor BTC, le titre et la langue portugaise.","Scheda scura di Monitor BTC, con l'icona di Monitor BTC, il titolo e la lingua portoghese.","Dunkle Karte von Monitor BTC, mit dem Monitor-BTC-Symbol, dem Titel und der portugiesischen Sprache.","Donkere kaart van Monitor BTC, met het Monitor BTC-pictogram, de titel en de Portugese taal.","Targeta fosca de Monitor BTC, amb la icona de Monitor BTC, el títol i l'idioma portuguès.","Tarxeta escura do Monitor BTC, coa icona do Monitor BTC, o título e o idioma portugués."],
    ["chave inválida: use a xpub, zpub ou ypub da conta.","invalid key: use the account's xpub, zpub or ypub.","clave no válida: usa la xpub, zpub o ypub de la cuenta.","clé invalide : utilisez la xpub, zpub ou ypub du compte.","chiave non valida: usa la xpub, zpub o ypub del conto.","ungültiger Schlüssel: Verwende die xpub, zpub oder ypub des Kontos.","ongeldige sleutel: gebruik de xpub, zpub of ypub van de rekening.","clau no vàlida: fes servir la xpub, zpub o ypub del compte.","clave non válida: usa a xpub, zpub ou ypub da conta."],
    ["chave inválida: isso é uma chave privada (xprv/yprv/zprv), nunca cole a privada aqui; use a xpub, zpub ou ypub da conta.","invalid key: this is a private key (xprv/yprv/zprv), never paste the private key here; use the account's xpub, zpub or ypub.","clave no válida: esto es una clave privada (xprv/yprv/zprv), nunca pegues la privada aquí; usa la xpub, zpub o ypub de la cuenta.","clé invalide : c'est une clé privée (xprv/yprv/zprv), ne collez jamais la privée ici ; utilisez la xpub, zpub ou ypub du compte.","chiave non valida: questa è una chiave privata (xprv/yprv/zprv), non incollare mai la privata qui; usa la xpub, zpub o ypub del conto.","ungültiger Schlüssel: Das ist ein privater Schlüssel (xprv/yprv/zprv); füge den privaten niemals hier ein. Verwende die xpub, zpub oder ypub des Kontos.","ongeldige sleutel: dit is een privésleutel (xprv/yprv/zprv); plak de privésleutel nooit hier. Gebruik de xpub, zpub of ypub van de rekening.","clau no vàlida: això és una clau privada (xprv/yprv/zprv); no enganxis mai la privada aquí. Fes servir la xpub, zpub o ypub del compte.","clave non válida: isto é unha clave privada (xprv/yprv/zprv); nunca peges a privada aquí. Usa a xpub, zpub ou ypub da conta."],
    ["chave inválida: isso é um endereço Bitcoin; use a xpub, zpub ou ypub da conta.","invalid key: this is a Bitcoin address; use the account's xpub, zpub or ypub.","clave no válida: esto es una dirección Bitcoin; usa la xpub, zpub o ypub de la cuenta.","clé invalide : c'est une adresse Bitcoin ; utilisez la xpub, zpub ou ypub du compte.","chiave non valida: questo è un indirizzo Bitcoin; usa la xpub, zpub o ypub del conto.","ungültiger Schlüssel: Das ist eine Bitcoin-Adresse; verwende die xpub, zpub oder ypub des Kontos.","ongeldige sleutel: dit is een Bitcoin-adres; gebruik de xpub, zpub of ypub van de rekening.","clau no vàlida: això és una adreça Bitcoin; fes servir la xpub, zpub o ypub del compte.","clave non válida: isto é un enderezo Bitcoin; usa a xpub, zpub ou ypub da conta."],
    ["chave inválida: use a xpub, zpub ou ypub da conta; endereço, chave privada e outro texto são recusados.","invalid key: use the account's xpub, zpub or ypub; addresses, private keys and other text are refused.","clave no válida: usa la xpub, zpub o ypub de la cuenta; se rechazan direcciones, claves privadas y otro texto.","clé invalide : utilisez la xpub, zpub ou ypub du compte ; les adresses, les clés privées et tout autre texte sont refusés.","chiave non valida: usa la xpub, zpub o ypub del conto; indirizzi, chiavi private e altro testo vengono rifiutati.","ungültiger Schlüssel: Verwende die xpub, zpub oder ypub des Kontos; Adressen, private Schlüssel und anderer Text werden abgelehnt.","ongeldige sleutel: gebruik de xpub, zpub of ypub van de rekening; adressen, privésleutels en andere tekst worden geweigerd.","clau no vàlida: fes servir la xpub, zpub o ypub del compte; s'hi refusen adreces, claus privades i altre text.","clave non válida: usa a xpub, zpub ou ypub da conta; rexéitanse enderezos, claves privadas e outro texto."],
    ["sim","yes","sí","oui","sì","ja","ja","sí","si"],
    ["não","no","no","non","no","nein","nee","no","non"],
    ["data estimada indisponível","estimated date unavailable","fecha estimada no disponible","date estimée indisponible","data stimata non disponibile","geschätztes Datum nicht verfügbar","geschatte datum niet beschikbaar","data estimada no disponible","data estimada non dispoñible"],
    ["{value} (aprox.)","{value} (approx.)","{value} (aprox.)","{value} (env.)","{value} (circa)","{value} (ca.)","{value} (ca.)","{value} (aprox.)","{value} (aprox.)"],
    ["[ ok ]","[ ok ]","[ ok ]","[ ok ]","[ ok ]","[ ok ]","[ ok ]","[ ok ]","[ ok ]"],
    ["[ erro ]","[ error ]","[ error ]","[ erreur ]","[ errore ]","[ Fehler ]","[ fout ]","[ error ]","[ erro ]"],
    ["[ atenção ]","[ warning ]","[ atención ]","[ attention ]","[ attenzione ]","[ Achtung ]","[ let op ]","[ atenció ]","[ atención ]"],
    ["[ ... ]","[ ... ]","[ ... ]","[ ... ]","[ ... ]","[ ... ]","[ ... ]","[ ... ]","[ ... ]"],
    ["o servidor demorou para responder; tente de novo.","the server took too long to respond; try again.","el servidor tardó demasiado en responder; inténtalo de nuevo.","le serveur a mis trop de temps à répondre ; réessayez.","il server ha impiegato troppo tempo a rispondere; riprova.","der Server hat zu lange gebraucht, um zu antworten; versuche es erneut.","de server deed er te lang over om te antwoorden; probeer het opnieuw.","el servidor ha trigat massa a respondre; torna-ho a provar.","o servidor tardou demasiado en responder; téntao de novo."],
    ["não foi possível falar com o servidor; tente de novo.","could not reach the server; try again.","no se pudo hablar con el servidor; inténtalo de nuevo.","impossible de joindre le serveur ; réessayez.","non è stato possibile parlare con il server; riprova.","der Server war nicht erreichbar; versuche es erneut.","kon niet met de server praten; probeer het opnieuw.","no s'ha pogut parlar amb el servidor; torna-ho a provar.","non foi posible falar co servidor; téntao de novo."],
    ["resposta inesperada do servidor (HTTP {status}); tente de novo.","unexpected server response (HTTP {status}); try again.","respuesta inesperada del servidor (HTTP {status}); inténtalo de nuevo.","réponse inattendue du serveur (HTTP {status}) ; réessayez.","risposta inattesa dal server (HTTP {status}); riprova.","unerwartete Antwort vom Server (HTTP {status}); versuche es erneut.","onverwacht antwoord van de server (HTTP {status}); probeer het opnieuw.","resposta inesperada del servidor (HTTP {status}); torna-ho a provar.","resposta inesperada do servidor (HTTP {status}); téntao de novo."],
    ["resposta inválida do servidor; tente de novo.","invalid server response; try again.","respuesta no válida del servidor; inténtalo de nuevo.","réponse invalide du serveur ; réessayez.","risposta non valida dal server; riprova.","ungültige Antwort vom Server; versuche es erneut.","ongeldig antwoord van de server; probeer het opnieuw.","resposta no vàlida del servidor; torna-ho a provar.","resposta non válida do servidor; téntao de novo."],
    ["cole a xpub, zpub ou ypub na carteira para ver o histórico.","paste the xpub, zpub or ypub in the wallet to see the history.","pega la xpub, zpub o ypub en la cartera para ver el historial.","collez la xpub, zpub ou ypub dans le portefeuille pour voir l'historique.","incolla la xpub, zpub o ypub nel portafoglio per vedere la cronologia.","füge die xpub, zpub oder ypub in der Wallet ein, um den Verlauf zu sehen.","plak de xpub, zpub of ypub in de portemonnee om de geschiedenis te zien.","enganxa la xpub, zpub o ypub a la cartera per veure l'historial.","pega a xpub, zpub ou ypub na carteira para ver o historial."],
    ["copiar","copy","copiar","copier","copia","kopieren","kopiëren","copia","copiar"],
    ["copiado","copied","copiado","copié","copiato","kopiert","gekopieerd","copiat","copiado"],
    ["copiar endereço {label}","copy address {label}","copiar dirección {label}","copier l'adresse {label}","copia l'indirizzo {label}","Adresse {label} kopieren","adres {label} kopiëren","copia l'adreça {label}","copiar o enderezo {label}"],
    ["endereço copiado","address copied","dirección copiada","adresse copiée","indirizzo copiato","Adresse kopiert","adres gekopieerd","adreça copiada","enderezo copiado"],
    ["não foi possível copiar.","could not copy.","no se pudo copiar.","impossible de copier.","non è stato possibile copiare.","kopieren nicht möglich.","kon niet kopiëren.","no s'ha pogut copiar.","non foi posible copiar."],
    ["valor grande demais: máximo de {n} dígitos.","amount too large: maximum of {n} digits.","importe demasiado grande: máximo de {n} dígitos.","montant trop grand : maximum de {n} chiffres.","importo troppo grande: massimo {n} cifre.","Betrag zu groß: höchstens {n} Ziffern.","bedrag te groot: maximaal {n} cijfers.","import massa gran: màxim de {n} dígits.","importe demasiado grande: máximo de {n} díxitos."],
    ["destino inválido: use um endereço bc1…, 1… ou 3….","invalid destination: use a bc1…, 1… or 3… address.","destino no válido: usa una dirección bc1…, 1… o 3….","destination invalide : utilisez une adresse bc1…, 1… ou 3….","destinazione non valida: usa un indirizzo bc1…, 1… o 3….","ungültiges Ziel: Verwende eine Adresse bc1…, 1… oder 3….","ongeldige bestemming: gebruik een adres bc1…, 1… of 3….","destinació no vàlida: fes servir una adreça bc1…, 1… o 3….","destino non válido: usa un enderezo bc1…, 1… ou 3…."],
    ["valor abaixo do mínimo: {value}","amount below the minimum: {value}","importe por debajo del mínimo: {value}","montant inférieur au minimum : {value}","importo sotto il minimo: {value}","Betrag unter dem Minimum: {value}","bedrag onder het minimum: {value}","import per sota del mínim: {value}","importe por baixo do mínimo: {value}"],
    ["máximo {value}","maximum {value}","máximo {value}","maximum {value}","massimo {value}","Maximum {value}","maximum {value}","màxim {value}","máximo {value}"],
    ["saldo insuficiente para enviar com essa taxa.","insufficient balance to send with this fee.","saldo insuficiente para enviar con esta comisión.","solde insuffisant pour envoyer avec ces frais.","saldo insufficiente per inviare con questa commissione.","Guthaben reicht nicht aus, um mit dieser Gebühr zu senden.","onvoldoende saldo om met deze kosten te verzenden.","saldo insuficient per enviar amb aquesta comissió.","saldo insuficiente para enviar con esta comisión."],
    ["valor acima do máximo enviável: {value}","amount above the sendable maximum: {value}","importe por encima del máximo enviable: {value}","montant au-dessus du maximum envoyable : {value}","importo sopra il massimo inviabile: {value}","Betrag über dem sendbaren Maximum: {value}","bedrag boven het maximaal verzendbare: {value}","import per sobre del màxim enviable: {value}","importe por riba do máximo enviable: {value}"],
    ["máximo indisponível: {text}","maximum unavailable: {text}","máximo no disponible: {text}","maximum indisponible : {text}","massimo non disponibile: {text}","Maximum nicht verfügbar: {text}","maximum niet beschikbaar: {text}","màxim no disponible: {text}","máximo non dispoñible: {text}"],
    ["calculando a taxa…","calculating the fee…","calculando la comisión…","calcul des frais…","calcolo della commissione…","Gebühr wird berechnet…","kosten worden berekend…","calculant la comissió…","calculando a comisión…"],
    ["taxa indisponível; tente de novo.","fee unavailable; try again.","comisión no disponible; inténtalo de nuevo.","frais indisponibles ; réessayez.","commissione non disponibile; riprova.","Gebühr nicht verfügbar; versuche es erneut.","kosten niet beschikbaar; probeer het opnieuw.","comissió no disponible; torna-ho a provar.","comisión non dispoñible; téntao de novo."],
    ["resposta sem limite de envio","response without a send limit","respuesta sin límite de envío","réponse sans limite d'envoi","risposta senza limite di invio","Antwort ohne Sendelimit","antwoord zonder verzendlimiet","resposta sense límit d'enviament","resposta sen límite de envío"],
    ["resposta sem níveis de taxa","response without fee levels","respuesta sin niveles de comisión","réponse sans niveaux de frais","risposta senza livelli di commissione","Antwort ohne Gebührenstufen","antwoord zonder kostenniveaus","resposta sense nivells de comissió","resposta sen niveis de comisión"],
    ["destino inválido: {text}.","invalid destination: {text}.","destino no válido: {text}.","destination invalide : {text}.","destinazione non valida: {text}.","ungültiges Ziel: {text}.","ongeldige bestemming: {text}.","destinació no vàlida: {text}.","destino non válido: {text}."],
    ["taxa de {rate} sat/vB, abaixo do piso de relay padrão ({relay}): a transação pode ser recusada pelos nós.","fee of {rate} sat/vB, below the default relay floor ({relay}): the transaction may be rejected by nodes.","comisión de {rate} sat/vB, por debajo del piso de relay predeterminado ({relay}): la transacción puede ser rechazada por los nodos.","frais de {rate} sat/vB, en dessous du plancher de relay par défaut ({relay}) : la transaction peut être refusée par les nœuds.","commissione di {rate} sat/vB, sotto il minimo di relay predefinito ({relay}): la transazione può essere rifiutata dai nodi.","Gebühr von {rate} sat/vB, unter dem Standard-Relay-Minimum ({relay}): Die Transaktion kann von Knoten abgelehnt werden.","kosten van {rate} sat/vB, onder de standaard relay-drempel ({relay}): de transactie kan door nodes worden geweigerd.","comissió de {rate} sat/vB, per sota del pis de relay predeterminat ({relay}): la transacció pot ser rebutjada pels nodes.","comisión de {rate} sat/vB, por baixo do piso de relay predeterminado ({relay}): a transacción pode ser rexeitada polos nodos."],
    ["o piso padrão","the default floor","el piso predeterminado","le plancher par défaut","il minimo predefinito","das Standardminimum","de standaarddrempel","el pis predeterminat","o piso predeterminado"],
    ["taxa {rate} sat/vB","fee {rate} sat/vB","comisión {rate} sat/vB","frais {rate} sat/vB","commissione {rate} sat/vB","Gebühr {rate} sat/vB","kosten {rate} sat/vB","comissió {rate} sat/vB","comisión {rate} sat/vB"],
    ["o destino no psbt difere do campo de destino","the destination in the psbt differs from the destination field","el destino del psbt difiere del campo de destino","la destination du psbt diffère du champ de destination","la destinazione nel psbt differisce dal campo destinazione","das Ziel in der psbt weicht vom Zielfeld ab","de bestemming in de psbt verschilt van het bestemmingsveld","la destinació del psbt difereix del camp de destinació","o destino no psbt difire do campo de destino"],
    ["o valor no psbt difere do campo de quantidade","the amount in the psbt differs from the amount field","el importe del psbt difiere del campo de importe","le montant du psbt diffère du champ de montant","l'importo nel psbt differisce dal campo importo","der Betrag in der psbt weicht vom Betragsfeld ab","het bedrag in de psbt verschilt van het bedragveld","l'import del psbt difereix del camp d'import","o importe no psbt difire do campo de importe"],
    ["o psbt tem {n} saídas externas","the psbt has {n} external outputs","el psbt tiene {n} salidas externas","le psbt a {n} sorties externes","il psbt ha {n} uscite esterne","die psbt hat {n} externe Ausgaben","de psbt heeft {n} externe uitgangen","el psbt té {n} sortides externes","o psbt ten {n} saídas externas"],
    ["o psbt gasta troco pendente de uma transação sua; ela confirma depois da anterior","the psbt spends pending change from one of your transactions; it confirms after the previous one","el psbt gasta cambio pendiente de una transacción tuya; esta confirma después de la anterior","le psbt dépense un reste en attente d'une de vos transactions ; celle-ci se confirme après la précédente","il psbt spende resto in attesa di una tua transazione; questa si conferma dopo la precedente","die psbt gibt ausstehendes Wechselgeld einer deiner Transaktionen aus; diese bestätigt nach der vorherigen","de psbt geeft wisselgeld uit dat nog in afwachting is van een van je transacties; die wordt na de vorige bevestigd","el psbt gasta canvi pendent d'una transacció teva; aquesta es confirma després de l'anterior","o psbt gasta troco pendente dunha transacción túa; esta confirma despois da anterior"],
    ["o psbt gasta {n} saídas pendentes de transações suas; elas confirmam depois das anteriores","the psbt spends {n} pending outputs from your transactions; they confirm after the previous ones","el psbt gasta {n} salidas pendientes de transacciones tuyas; estas confirman después de las anteriores","le psbt dépense {n} sorties en attente de vos transactions ; celles-ci se confirment après les précédentes","il psbt spende {n} uscite in attesa di tue transazioni; queste si confermano dopo le precedenti","die psbt gibt {n} ausstehende Ausgaben deiner Transaktionen aus; diese bestätigen nach den vorherigen","de psbt geeft {n} uitgangen uit die nog in afwachting zijn van je transacties; die worden na de vorige bevestigd","el psbt gasta {n} sortides pendents de transaccions teves; aquestes es confirmen després de les anteriors","o psbt gasta {n} saídas pendentes de transaccións túas; estas confirman despois das anteriores"],
    ["[ externo ]","[ external ]","[ externo ]","[ externe ]","[ esterno ]","[ extern ]","[ extern ]","[ extern ]","[ externo ]"],
    ["montando o psbt...","building the psbt...","montando el psbt...","assemblage du psbt...","composizione del psbt...","psbt wird erstellt...","psbt wordt gemaakt...","munting del psbt...","montando o psbt..."],
    ["conferindo o psbt...","checking the psbt...","comprobando el psbt...","vérification du psbt...","verifica del psbt...","psbt wird geprüft...","psbt wordt gecontroleerd...","comprovant el psbt...","comprobando o psbt..."],
    ["transmitindo...","broadcasting...","transmitiendo...","diffusion...","trasmissione...","wird gesendet...","wordt uitgezonden...","transmetent...","transmitindo..."],
    ["transmitida","broadcast","transmitida","diffusée","trasmessa","gesendet","uitgezonden","transmesa","transmitida"],
    ["transação transmitida: {txid}","transaction broadcast: {txid}","transacción transmitida: {txid}","transaction diffusée : {txid}","transazione trasmessa: {txid}","Transaktion gesendet: {txid}","transactie uitgezonden: {txid}","transacció transmesa: {txid}","transacción transmitida: {txid}"],
    ["arquivo grande demais para conferir","file too large to check","archivo demasiado grande para comprobar","fichier trop volumineux pour être vérifié","file troppo grande da verificare","Datei zu groß zum Prüfen","bestand te groot om te controleren","fitxer massa gran per comprovar","ficheiro demasiado grande para comprobar"],
    ["o arquivo está vazio","the file is empty","el archivo está vacío","le fichier est vide","il file è vuoto","die Datei ist leer","het bestand is leeg","el fitxer és buit","o ficheiro está baleiro"],
    ["carregue a carteira antes de escolher o arquivo","load the wallet before choosing the file","carga la cartera antes de elegir el archivo","chargez le portefeuille avant de choisir le fichier","carica il portafoglio prima di scegliere il file","lade die Wallet, bevor du die Datei wählst","laad de portemonnee voordat je het bestand kiest","carrega la cartera abans de triar el fitxer","carga a carteira antes de escoller o ficheiro"],
    ["a carteira mudou; tente de novo.","the wallet changed; try again.","la cartera cambió; inténtalo de nuevo.","le portefeuille a changé ; réessayez.","il portafoglio è cambiato; riprova.","die Wallet hat sich geändert; versuche es erneut.","de portemonnee is veranderd; probeer het opnieuw.","la cartera ha canviat; torna-ho a provar.","a carteira cambiou; téntao de novo."],
    ["sessão expirada; recarregue a carteira.","session expired; reload the wallet.","sesión caducada; recarga la cartera.","session expirée ; rechargez le portefeuille.","sessione scaduta; ricarica il portafoglio.","Sitzung abgelaufen; lade die Wallet neu.","sessie verlopen; herlaad de portemonnee.","sessió caducada; recarrega la cartera.","sesión caducada; recarga a carteira."],
    ["o servidor não devolveu o psbt.","the server did not return the psbt.","el servidor no devolvió el psbt.","le serveur n'a pas renvoyé le psbt.","il server non ha restituito il psbt.","der Server hat die psbt nicht zurückgegeben.","de server heeft de psbt niet teruggegeven.","el servidor no va retornar el psbt.","o servidor non devolveu o psbt."],
    ["[ pendente ]","[ pending ]","[ pendiente ]","[ en attente ]","[ in attesa ]","[ ausstehend ]","[ in afwachting ]","[ pendent ]","[ pendente ]"],
    ["pendente","pending","pendiente","en attente","in attesa","ausstehend","in afwachting","pendent","pendente"],
    ["recebido","received","recibido","reçu","ricevuto","eingegangen","ontvangen","rebut","recibido"],
    ["enviado","sent","enviado","envoyé","inviato","gesendet","verzonden","enviat","enviado"],
    ["auto","self","auto","auto","auto","selbst","zelf","auto","auto"],
    ["entradas","inputs","entradas","entrées","input","Eingänge","invoeren","entrades","entradas"],
    ["saídas","outputs","salidas","sorties","uscite","Ausgaben","uitgangen","sortides","saídas"],
    ["acelerar","speed up","acelerar","accélérer","accelera","beschleunigen","versnellen","accelerar","acelerar"],
    ["recebimento","receiving","recepción","réception","ricezione","Empfang","ontvangst","recepció","recepción"],
    ["transação","transaction","transacción","transaction","transazione","Transaktion","transactie","transacció","transacción"],
    ["transações","transactions","transacciones","transactions","transazioni","Transaktionen","transacties","transaccions","transaccións"],
    ["atualizado {value}","updated {value}","actualizado {value}","mis à jour {value}","aggiornato {value}","aktualisiert {value}","bijgewerkt {value}","actualitzat {value}","actualizado {value}"],
    ["totais do histórico","history totals","totales del historial","totaux de l'historique","totali della cronologia","Summen des Verlaufs","totalen van de geschiedenis","totals de l'historial","totais do historial"],
    ["verificando {n} endereço","checking {n} address","comprobando {n} dirección","vérification de {n} adresse","verifica di {n} indirizzo","prüfe {n} Adresse","{n} adres controleren","comprovant {n} adreça","comprobando {n} enderezo"],
    ["verificando {n} endereços","checking {n} addresses","comprobando {n} direcciones","vérification de {n} adresses","verifica di {n} indirizzi","prüfe {n} Adressen","{n} adressen controleren","comprovant {n} adreces","comprobando {n} enderezos"],
    ["busca incompleta: ainda podem existir valores não contabilizados.","incomplete search: there may still be uncounted funds.","búsqueda incompleta: aún puede haber fondos sin contabilizar.","recherche incomplète : des fonds non comptabilisés peuvent encore exister.","ricerca incompleta: potrebbero esserci ancora fondi non conteggiati.","Suche unvollständig: Es können noch nicht erfasste Beträge vorhanden sein.","zoektocht onvolledig: er kunnen nog niet-meegerekende bedragen zijn.","cerca incompleta: encara hi pot haver fons no comptabilitzats.","busca incompleta: aínda poden existir fondos non contabilizados."],
    ["busca interrompida: o saldo pode estar incompleto. {message}","search interrupted: the balance may be incomplete. {message}","búsqueda interrumpida: el saldo puede estar incompleto. {message}","recherche interrompue : le solde peut être incomplet. {message}","ricerca interrotta: il saldo può essere incompleto. {message}","Suche unterbrochen: Das Guthaben kann unvollständig sein. {message}","zoektocht onderbroken: het saldo kan onvolledig zijn. {message}","cerca interrompuda: el saldo pot estar incomplet. {message}","busca interrompida: o saldo pode estar incompleto. {message}"],
    ["tempo real: {message}","live: {message}","tiempo real: {message}","temps réel : {message}","tempo reale: {message}","Echtzeit: {message}","realtime: {message}","temps real: {message}","tempo real: {message}"],
    ["bip49 · segwit aninhado (p2sh-p2wpkh)","bip49 · nested segwit (p2sh-p2wpkh)","bip49 · segwit anidado (p2sh-p2wpkh)","bip49 · segwit imbriqué (p2sh-p2wpkh)","bip49 · segwit annidato (p2sh-p2wpkh)","bip49 · verschachteltes Segwit (p2sh-p2wpkh)","bip49 · geneste segwit (p2sh-p2wpkh)","bip49 · segwit imbricat (p2sh-p2wpkh)","bip49 · segwit aniñado (p2sh-p2wpkh)"],
    ["psbt assinado","signed psbt","psbt firmado","psbt signé","psbt firmato","signierte psbt","ondertekende psbt","psbt signat","psbt asinado"],
    ["entrada","input","entrada","entrée","input","Eingang","invoer","entrada","entrada"],
    ["taxas","fees","comisiones","frais","commissioni","Gebühren","kosten","comissions","comisións"],
    ["json inválido","invalid json","JSON no válido","JSON invalide","JSON non valido","ungültiges JSON","ongeldige JSON","JSON no vàlid","JSON non válido"],
    ["informe a xpub","enter the xpub","indica la xpub","indiquez la xpub","indica la xpub","gib die xpub an","geef de xpub op","indica la xpub","indica a xpub"],
    ["xpub grande demais","xpub too long","xpub demasiado grande","xpub trop longue","xpub troppo lunga","xpub zu lang","xpub te lang","xpub massa gran","xpub demasiado grande"],
    ["Electrum desligado (ELECTRUM_SERVERS=off); ele é a única fonte","Electrum disabled (ELECTRUM_SERVERS=off); it is the only source","Electrum desactivado (ELECTRUM_SERVERS=off); es la única fuente","Electrum désactivé (ELECTRUM_SERVERS=off) ; c'est la seule source","Electrum disattivato (ELECTRUM_SERVERS=off); è l'unica fonte","Electrum deaktiviert (ELECTRUM_SERVERS=off); es ist die einzige Quelle","Electrum uitgeschakeld (ELECTRUM_SERVERS=off); het is de enige bron","Electrum desactivat (ELECTRUM_SERVERS=off); és l'única font","Electrum desactivado (ELECTRUM_SERVERS=off); é a única fonte"],
    ["sessão inválida","invalid session","sesión no válida","session invalide","sessione non valida","ungültige Sitzung","ongeldige sessie","sessió no vàlida","sesión non válida"],
    ["tempo real não configurado (sem o Durable Object WATCH)","live mode not configured (no WATCH Durable Object)","tiempo real no configurado (sin el Durable Object WATCH)","temps réel non configuré (sans le Durable Object WATCH)","tempo reale non configurato (senza il Durable Object WATCH)","Echtzeit nicht konfiguriert (ohne WATCH Durable Object)","realtime niet geconfigureerd (zonder WATCH Durable Object)","temps real no configurat (sense el Durable Object WATCH)","tempo real non configurado (sen o Durable Object WATCH)"],
    ["informe o endereço de destino","enter the destination address","indica la dirección de destino","indiquez l'adresse de destination","indica l'indirizzo di destinazione","gib die Zieladresse an","geef het bestemmingsadres op","indica l'adreça de destinació","indica o enderezo de destino"],
    ["endereço de destino grande demais","destination address too long","dirección de destino demasiado grande","adresse de destination trop longue","indirizzo di destinazione troppo lungo","Zieladresse zu lang","bestemmingsadres te lang","adreça de destinació massa gran","enderezo de destino demasiado grande"],
    ["taxas de cotação inválidas","invalid quote rates","tasas de cotización no válidas","taux de conversion invalides","tassi di quotazione non validi","ungültige Kursangaben","ongeldige koersrentes","taxes de cotització no vàlides","taxas de cotización non válidas"],
    ["valor inválido","invalid amount","importe no válido","montant invalide","importo non valido","ungültiger Betrag","ongeldig bedrag","import no vàlid","importe non válido"],
    ["valor acima do limite do bitcoin","amount above the Bitcoin limit","importe por encima del límite de Bitcoin","montant au-dessus de la limite Bitcoin","importo sopra il limite di Bitcoin","Betrag über dem Bitcoin-Limit","bedrag boven de Bitcoin-limiet","import per sobre del límit de Bitcoin","importe por riba do límite de Bitcoin"],
    ["txid inválido","invalid txid","txid no válido","txid invalide","txid non valido","ungültige txid","ongeldige txid","txid no vàlid","txid non válido"],
    ["informe o psbt assinado","enter the signed psbt","indica el psbt firmado","indiquez le psbt signé","indica il psbt firmato","gib die signierte psbt an","geef de ondertekende psbt op","indica el psbt signat","indica o psbt asinado"],
    ["psbt grande demais para conferir","psbt too large to check","psbt demasiado grande para comprobar","psbt trop volumineux pour être vérifié","psbt troppo grande da verificare","psbt zu groß zum Prüfen","psbt te groot om te controleren","psbt massa gran per comprovar","psbt demasiado grande para comprobar"],
    ["use POST","use POST","usa POST","utilisez POST","usa POST","verwende POST","gebruik POST","fes servir POST","usa POST"],
    ["use GET","use GET","usa GET","utilisez GET","usa GET","verwende GET","gebruik GET","fes servir GET","usa GET"],
    ["rota não encontrada","route not found","ruta no encontrada","route introuvable","rotta non trovata","Route nicht gefunden","route niet gevonden","ruta no trobada","ruta non atopada"],
    ["sessão de outra xpub","session from another xpub","sesión de otra xpub","session d'une autre xpub","sessione di un'altra xpub","Sitzung einer anderen xpub","sessie van een andere xpub","sessió d'una altra xpub","sesión doutra xpub"],
    ["sessão expirada; envie a xpub de novo","session expired; send the xpub again","sesión caducada; envía la xpub de nuevo","session expirée ; envoyez la xpub à nouveau","sessione scaduta; invia di nuovo la xpub","Sitzung abgelaufen; sende die xpub erneut","sessie verlopen; stuur de xpub opnieuw","sessió caducada; envia la xpub de nou","sesión caducada; envía a xpub de novo"],
    ["sessão sem xpub; envie a xpub em /sync","session without xpub; send the xpub to /sync","sesión sin xpub; envía la xpub a /sync","session sans xpub ; envoyez la xpub à /sync","sessione senza xpub; invia la xpub a /sync","Sitzung ohne xpub; sende die xpub an /sync","sessie zonder xpub; stuur de xpub naar /sync","sessió sense xpub; envia la xpub a /sync","sesión sen xpub; envía a xpub a /sync"],
    ["Electrum desligado (ELECTRUM_SERVERS=off)","Electrum disabled (ELECTRUM_SERVERS=off)","Electrum desactivado (ELECTRUM_SERVERS=off)","Electrum désactivé (ELECTRUM_SERVERS=off)","Electrum disattivato (ELECTRUM_SERVERS=off)","Electrum deaktiviert (ELECTRUM_SERVERS=off)","Electrum uitgeschakeld (ELECTRUM_SERVERS=off)","Electrum desactivat (ELECTRUM_SERVERS=off)","Electrum desactivado (ELECTRUM_SERVERS=off)"],
    ["isso é uma chave privada (xprv/yprv/zprv). Nunca cole a privada aqui: o projeto é watch-only.","this is a private key (xprv/yprv/zprv). Never paste the private key here: the project is watch-only.","esto es una clave privada (xprv/yprv/zprv). Nunca pegues la privada aquí: el proyecto es watch-only.","c'est une clé privée (xprv/yprv/zprv). Ne collez jamais la privée ici : le projet est watch-only.","questa è una chiave privata (xprv/yprv/zprv). Non incollare mai la privata qui: il progetto è watch-only.","Das ist ein privater Schlüssel (xprv/yprv/zprv). Füge den privaten niemals hier ein: Das Projekt ist watch-only.","dit is een privésleutel (xprv/yprv/zprv). Plak de privésleutel nooit hier: het project is watch-only.","això és una clau privada (xprv/yprv/zprv). No enganxis mai la privada aquí: el projecte és watch-only.","isto é unha clave privada (xprv/yprv/zprv). Nunca peges a privada aquí: o proxecto é watch-only."],
    ["isso é um endereço Bitcoin, não uma xpub. Use a chave estendida pública da conta (xpub/zpub/ypub).","this is a Bitcoin address, not an xpub. Use the account's extended public key (xpub/zpub/ypub).","esto es una dirección Bitcoin, no una xpub. Usa la clave pública extendida de la cuenta (xpub/zpub/ypub).","c'est une adresse Bitcoin, pas une xpub. Utilisez la clé publique étendue du compte (xpub/zpub/ypub).","questo è un indirizzo Bitcoin, non una xpub. Usa la chiave pubblica estesa del conto (xpub/zpub/ypub).","Das ist eine Bitcoin-Adresse, keine xpub. Verwende den erweiterten öffentlichen Schlüssel des Kontos (xpub/zpub/ypub).","dit is een Bitcoin-adres, geen xpub. Gebruik de uitgebreide openbare sleutel van de rekening (xpub/zpub/ypub).","això és una adreça Bitcoin, no una xpub. Fes servir la clau pública estesa del compte (xpub/zpub/ypub).","isto é un enderezo Bitcoin, non unha xpub. Usa a clave pública estendida da conta (xpub/zpub/ypub)."],
    ["a chave precisa começar com xpub, zpub ou ypub (chave estendida pública da conta).","the key must start with xpub, zpub or ypub (the account's extended public key).","la clave debe empezar por xpub, zpub o ypub (clave pública extendida de la cuenta).","la clé doit commencer par xpub, zpub ou ypub (clé publique étendue du compte).","la chiave deve iniziare con xpub, zpub o ypub (chiave pubblica estesa del conto).","der Schlüssel muss mit xpub, zpub oder ypub beginnen (erweiterter öffentlicher Schlüssel des Kontos).","de sleutel moet beginnen met xpub, zpub of ypub (uitgebreide openbare sleutel van de rekening).","la clau ha de començar per xpub, zpub o ypub (clau pública estesa del compte).","a clave ten que comezar por xpub, zpub ou ypub (clave pública estendida da conta)."],
    ["texto base58 grande demais","base58 text too long","texto base58 demasiado grande","texte base58 trop long","testo base58 troppo lungo","Base58-Text zu lang","base58-tekst te lang","text base58 massa gran","texto base58 demasiado longo"],
    ["xpub com caractere inválido","xpub with an invalid character","xpub con carácter no válido","xpub avec un caractère invalide","xpub con carattere non valido","xpub mit ungültigem Zeichen","xpub met ongeldig teken","xpub amb caràcter no vàlid","xpub con carácter non válido"],
    ["xpub com tamanho inválido","xpub with an invalid size","xpub con tamaño no válido","xpub de taille invalide","xpub con dimensione non valida","xpub mit ungültiger Größe","xpub met ongeldige grootte","xpub amb mida no vàlida","xpub con tamaño non válido"],
    ["checksum da xpub inválido","invalid xpub checksum","checksum de la xpub no válido","checksum de la xpub invalide","checksum della xpub non valido","ungültige xpub-Prüfsumme","ongeldige xpub-controlesom","checksum de la xpub no vàlid","checksum da xpub non válido"],
    ["isso é uma xprv (chave privada), não uma xpub","this is an xprv (private key), not an xpub","esto es una xprv (clave privada), no una xpub","c'est une xprv (clé privée), pas une xpub","questa è una xprv (chiave privata), non una xpub","Das ist ein xprv (privater Schlüssel), keine xpub","dit is een xprv (privésleutel), geen xpub","això és una xprv (clau privada), no una xpub","isto é unha xprv (clave privada), non unha xpub"],
    ["versão de xpub não suportada (use xpub, zpub ou ypub mainnet)","unsupported xpub version (use mainnet xpub, zpub or ypub)","versión de xpub no compatible (usa xpub, zpub o ypub de mainnet)","version de xpub non prise en charge (utilisez xpub, zpub ou ypub mainnet)","versione xpub non supportata (usa xpub, zpub o ypub mainnet)","nicht unterstützte xpub-Version (verwende xpub, zpub oder ypub im Mainnet)","niet-ondersteunde xpub-versie (gebruik xpub, zpub of ypub mainnet)","versió de xpub no suportada (fes servir xpub, zpub o ypub mainnet)","versión de xpub non soportada (usa xpub, zpub ou ypub mainnet)"],
    ["use a xpub da conta (profundidade 3), não a raiz","use the account xpub (depth 3), not the root","usa la xpub de la cuenta (profundidad 3), no la raíz","utilisez la xpub du compte (profondeur 3), pas la racine","usa la xpub del conto (profondità 3), non la radice","verwende die xpub des Kontos (Tiefe 3), nicht die Wurzel","gebruik de xpub van de rekening (diepte 3), niet de root","fes servir la xpub del compte (profunditat 3), no l'arrel","usa a xpub da conta (profundidade 3), non a raíz"],
    ["chave pública da xpub inválida","invalid xpub public key","clave pública de la xpub no válida","clé publique de la xpub invalide","chiave pubblica della xpub non valida","ungültiger öffentlicher xpub-Schlüssel","ongeldige openbare xpub-sleutel","clau pública de la xpub no vàlida","clave pública da xpub non válida"],
    ["ponto inválido","invalid point","punto no válido","point invalide","punto non valido","ungültiger Punkt","ongeldig punt","punt no vàlid","punto non válido"],
    ["índice endurecido não é possível com xpub","hardened index is not possible with an xpub","índice endurecido no es posible con una xpub","index renforcé impossible avec une xpub","indice indurito non possibile con una xpub","gehärteter Index mit xpub nicht möglich","geharde index niet mogelijk met een xpub","índex endurit no és possible amb una xpub","índice endurecido non é posible cunha xpub"],
    ["derivação BIP32 inválida","invalid BIP32 derivation","derivación BIP32 no válida","dérivation BIP32 invalide","derivazione BIP32 non valida","ungültige BIP32-Ableitung","ongeldige BIP32-afleiding","derivació BIP32 no vàlida","derivación BIP32 non válida"],
    ["cadeia inválida","invalid chain","cadena no válida","chaîne invalide","catena non valida","ungültige Kette","ongeldige keten","cadena no vàlida","cadea non válida"],
    ["endereço vazio","empty address","dirección vacía","adresse vide","indirizzo vuoto","leere Adresse","leeg adres","adreça buida","enderezo baleiro"],
    ["endereço base58 grande demais","base58 address too long","dirección base58 demasiado grande","adresse base58 trop longue","indirizzo base58 troppo lungo","Base58-Adresse zu lang","base58-adres te lang","adreça base58 massa gran","enderezo base58 demasiado longo"],
    ["endereço com caractere inválido","address with an invalid character","dirección con carácter no válido","adresse avec un caractère invalide","indirizzo con carattere non valido","Adresse mit ungültigem Zeichen","adres met ongeldig teken","adreça amb caràcter no vàlid","enderezo con carácter non válido"],
    ["endereço base58 truncado","truncated base58 address","dirección base58 truncada","adresse base58 tronquée","indirizzo base58 troncato","abgeschnittene Base58-Adresse","afgekapt base58-adres","adreça base58 truncada","enderezo base58 truncado"],
    ["checksum do endereço inválido","invalid address checksum","checksum de la dirección no válido","checksum de l'adresse invalide","checksum dell'indirizzo non valido","ungültige Adressprüfsumme","ongeldige adrescontrolesom","checksum de l'adreça no vàlid","checksum do enderezo non válido"],
    ["endereço com maiúsculas e minúsculas misturadas","address with mixed upper and lower case","dirección con mayúsculas y minúsculas mezcladas","adresse avec majuscules et minuscules mélangées","indirizzo con maiuscole e minuscole miste","Adresse mit gemischter Groß- und Kleinschreibung","adres met gemengde hoofd- en kleine letters","adreça amb majúscules i minúscules barrejades","enderezo con maiúsculas e minúsculas mesturadas"],
    ["endereço bech32 inválido","invalid bech32 address","dirección bech32 no válida","adresse bech32 invalide","indirizzo bech32 non valido","ungültige Bech32-Adresse","ongeldig bech32-adres","adreça bech32 no vàlida","enderezo bech32 non válido"],
    ["endereço não é da mainnet (bc1)","address is not on mainnet (bc1)","la dirección no es de mainnet (bc1)","l'adresse n'est pas sur le mainnet (bc1)","l'indirizzo non è sulla mainnet (bc1)","Adresse ist nicht im Mainnet (bc1)","adres is niet op mainnet (bc1)","l'adreça no és de mainnet (bc1)","o enderezo non é de mainnet (bc1)"],
    ["endereço bech32 truncado","truncated bech32 address","dirección bech32 truncada","adresse bech32 tronquée","indirizzo bech32 troncato","abgeschnittene Bech32-Adresse","afgekapt bech32-adres","adreça bech32 truncada","enderezo bech32 truncado"],
    ["endereço bech32 com caractere inválido","bech32 address with an invalid character","dirección bech32 con carácter no válido","adresse bech32 avec un caractère invalide","indirizzo bech32 con carattere non valido","Bech32-Adresse mit ungültigem Zeichen","bech32-adres met ongeldig teken","adreça bech32 amb caràcter no vàlid","enderezo bech32 con carácter non válido"],
    ["tipo de endereço segwit não suportado","unsupported segwit address type","tipo de dirección segwit no compatible","type d'adresse segwit non pris en charge","tipo di indirizzo segwit non supportato","nicht unterstützter Segwit-Adresstyp","niet-ondersteund segwit-adrestype","tipus d'adreça segwit no suportat","tipo de enderezo segwit non soportado"],
    ["endereço base58 inválido","invalid base58 address","dirección base58 no válida","adresse base58 invalide","indirizzo base58 non valido","ungültige Base58-Adresse","ongeldig base58-adres","adreça base58 no vàlida","enderezo base58 non válido"],
    ["endereço não é da mainnet","address is not on mainnet","la dirección no es de mainnet","l'adresse n'est pas sur le mainnet","l'indirizzo non è sulla mainnet","Adresse ist nicht im Mainnet","adres is niet op mainnet","l'adreça no és de mainnet","o enderezo non é de mainnet"],
    ["script inválido para scripthash","invalid script for scripthash","script no válido para scripthash","script invalide pour scripthash","script non valido per scripthash","ungültiges Skript für scripthash","ongeldig script voor scripthash","script no vàlid per a scripthash","script non válido para scripthash"],
    ["servidor Electrum inválido: {item}","invalid Electrum server: {item}","servidor Electrum no válido: {item}","serveur Electrum invalide : {item}","server Electrum non valido: {item}","ungültiger Electrum-Server: {item}","ongeldige Electrum-server: {item}","servidor Electrum no vàlid: {item}","servidor Electrum non válido: {item}"],
    ["transporte inválido em {item} (use tls ou tcp)","invalid transport in {item} (use tls or tcp)","transporte no válido en {item} (usa tls o tcp)","transport invalide dans {item} (utilisez tls ou tcp)","trasporto non valido in {item} (usa tls o tcp)","ungültiger Transport in {item} (verwende tls oder tcp)","ongeldig transport in {item} (gebruik tls of tcp)","transport no vàlid a {item} (fes servir tls o tcp)","transporte non válido en {item} (usa tls ou tcp)"],
    ["lista de servidores Electrum vazia","empty Electrum server list","lista de servidores Electrum vacía","liste de serveurs Electrum vide","elenco di server Electrum vuoto","leere Electrum-Serverliste","lege Electrum-serverlijst","llista de servidors Electrum buida","lista de servidores Electrum baleira"],
    ["resposta não-JSON do Electrum","non-JSON response from Electrum","respuesta no JSON del Electrum","réponse non JSON d'Electrum","risposta non JSON da Electrum","Nicht-JSON-Antwort von Electrum","niet-JSON-antwoord van Electrum","resposta no JSON de l'Electrum","resposta non JSON do Electrum"],
    ["resposta grande demais do Electrum","Electrum response too large","respuesta del Electrum demasiado grande","réponse d'Electrum trop volumineuse","risposta di Electrum troppo grande","Electrum-Antwort zu groß","Electrum-antwoord te groot","resposta de l'Electrum massa gran","resposta do Electrum demasiado grande"],
    ["conexão Electrum encerrada pelo servidor","Electrum connection closed by the server","conexión Electrum cerrada por el servidor","connexion Electrum fermée par le serveur","connessione Electrum chiusa dal server","Electrum-Verbindung vom Server geschlossen","Electrum-verbinding door de server gesloten","connexió Electrum tancada pel servidor","conexión Electrum pechada polo servidor"],
    ["TCP indisponível neste runtime (cloudflare:sockets): {message}","TCP unavailable in this runtime (cloudflare:sockets): {message}","TCP no disponible en este entorno (cloudflare:sockets): {message}","TCP indisponible dans cet environnement (cloudflare:sockets) : {message}","TCP non disponibile in questo runtime (cloudflare:sockets): {message}","TCP in dieser Laufzeit nicht verfügbar (cloudflare:sockets): {message}","TCP niet beschikbaar in deze runtime (cloudflare:sockets): {message}","TCP no disponible en aquest entorn (cloudflare:sockets): {message}","TCP non dispoñible neste runtime (cloudflare:sockets): {message}"],
    ["connect() TCP indisponível neste runtime","connect() TCP unavailable in this runtime","connect() TCP no disponible en este entorno","connect() TCP indisponible dans cet environnement","connect() TCP non disponibile in questo runtime","connect() TCP in dieser Laufzeit nicht verfügbar","connect() TCP niet beschikbaar in deze runtime","connect() TCP no disponible en aquest entorn","connect() TCP non dispoñible neste runtime"],
    ["timeout de {ms} ms em {method}","timeout of {ms} ms in {method}","tiempo de espera de {ms} ms en {method}","délai de {ms} ms dépassé dans {method}","timeout di {ms} ms in {method}","Timeout von {ms} ms bei {method}","time-out van {ms} ms in {method}","temps d'espera de {ms} ms a {method}","tempo de espera de {ms} ms en {method}"],
    ["timeout de conexão com {host}:{port}","connection timeout with {host}:{port}","tiempo de conexión agotado con {host}:{port}","délai de connexion dépassé avec {host}:{port}","timeout di connessione con {host}:{port}","Verbindungszeitüberschreitung bei {host}:{port}","verbindingstime-out met {host}:{port}","temps de connexió esgotat amb {host}:{port}","tempo de conexión esgotado con {host}:{port}"],
    ["nenhum servidor Electrum respondeu: {details}","no Electrum server responded: {details}","ningún servidor Electrum respondió: {details}","aucun serveur Electrum n'a répondu : {details}","nessun server Electrum ha risposto: {details}","kein Electrum-Server hat geantwortet: {details}","geen enkele Electrum-server antwoordde: {details}","cap servidor Electrum ha respost: {details}","ningún servidor Electrum respondeu: {details}"],
    ["muitos pedidos; tente de novo em {n} s","too many requests; try again in {n} s","demasiadas solicitudes; inténtalo de nuevo en {n} s","trop de requêtes ; réessayez dans {n} s","troppe richieste; riprova tra {n} s","zu viele Anfragen; versuche es in {n} s erneut","te veel verzoeken; probeer het over {n} s opnieuw","massa sol·licituds; torna-ho a provar d'aquí a {n} s","demasiadas solicitudes; téntao de novo en {n} s"],
    ["configuração inválida de ELECTRUM_SERVERS: {message}","invalid ELECTRUM_SERVERS configuration: {message}","configuración no válida de ELECTRUM_SERVERS: {message}","configuration ELECTRUM_SERVERS invalide : {message}","configurazione ELECTRUM_SERVERS non valida: {message}","ungültige ELECTRUM_SERVERS-Konfiguration: {message}","ongeldige ELECTRUM_SERVERS-configuratie: {message}","configuració no vàlida d'ELECTRUM_SERVERS: {message}","configuración non válida de ELECTRUM_SERVERS: {message}"],
    ["configuração inválida de ELECTRUM_TIMEOUT_MS: use um número de milissegundos maior que zero","invalid ELECTRUM_TIMEOUT_MS configuration: use a millisecond number greater than zero","configuración no válida de ELECTRUM_TIMEOUT_MS: usa un número de milisegundos mayor que cero","configuration ELECTRUM_TIMEOUT_MS invalide : utilisez un nombre de millisecondes supérieur à zéro","configurazione ELECTRUM_TIMEOUT_MS non valida: usa un numero di millisecondi maggiore di zero","ungültige ELECTRUM_TIMEOUT_MS-Konfiguration: Verwende eine Millisekundenzahl größer als null","ongeldige ELECTRUM_TIMEOUT_MS-configuratie: gebruik een aantal milliseconden groter dan nul","configuració no vàlida d'ELECTRUM_TIMEOUT_MS: fes servir un nombre de mil·lisegons més gran que zero","configuración non válida de ELECTRUM_TIMEOUT_MS: usa un número de milisegundos maior que cero"],
    ["Electrum indisponível: {message}","Electrum unavailable: {message}","Electrum no disponible: {message}","Electrum indisponible : {message}","Electrum non disponibile: {message}","Electrum nicht verfügbar: {message}","Electrum niet beschikbaar: {message}","Electrum no disponible: {message}","Electrum non dispoñible: {message}"],
    ["endereço de destino: {message}","destination address: {message}","dirección de destino: {message}","adresse de destination : {message}","indirizzo di destinazione: {message}","Zieladresse: {message}","bestemmingsadres: {message}","adreça de destinació: {message}","enderezo de destino: {message}"],
    ["histórico incompleto (faltou transação do servidor); atualize a carteira e tente de novo","incomplete history (missing transaction from the server); refresh the wallet and try again","historial incompleto (faltó una transacción del servidor); actualiza la cartera e inténtalo de nuevo","historique incomplet (transaction manquante du serveur) ; actualisez le portefeuille et réessayez","cronologia incompleta (manca una transazione del server); aggiorna il portafoglio e riprova","Verlauf unvollständig (Transaktion vom Server fehlt); aktualisiere die Wallet und versuche es erneut","geschiedenis onvolledig (transactie van de server ontbreekt); ververs de portemonnee en probeer het opnieuw","historial incomplet (falta una transacció del servidor); actualitza la cartera i torna-ho a provar","historial incompleto (falta unha transacción do servidor); actualiza a carteira e téntao de novo"],
    ["carteira ainda não sincronizada","wallet not synchronized yet","cartera aún no sincronizada","portefeuille pas encore synchronisé","portafoglio non ancora sincronizzato","Wallet noch nicht synchronisiert","portemonnee nog niet gesynchroniseerd","cartera encara no sincronitzada","carteira aínda non sincronizada"],
    ["transação não encontrada nesta carteira","transaction not found in this wallet","transacción no encontrada en esta cartera","transaction introuvable dans ce portefeuille","transazione non trovata in questo portafoglio","Transaktion in dieser Wallet nicht gefunden","transactie niet gevonden in deze portemonnee","transacció no trobada en aquesta cartera","transacción non atopada nesta carteira"],
    ["a transação já foi confirmada; CPFP só vale para pendente","the transaction is already confirmed; CPFP only applies to pending","la transacción ya fue confirmada; CPFP solo vale para pendientes","la transaction est déjà confirmée ; CPFP ne vaut que pour une transaction en attente","la transazione è già confermata; CPFP vale solo per transazioni in attesa","die Transaktion ist bereits bestätigt; CPFP gilt nur für ausstehende","de transactie is al bevestigd; CPFP geldt alleen voor openstaande","la transacció ja s'ha confirmat; CPFP només val per a pendents","a transacción xa foi confirmada; CPFP só vale para pendente"],
    ["a transação não é um envio desta carteira","the transaction is not a send from this wallet","la transacción no es un envío de esta cartera","la transaction n'est pas un envoi de ce portefeuille","la transazione non è un invio di questo portafoglio","die Transaktion ist keine Ausgabe dieser Wallet","de transactie is geen verzending van deze portemonnee","la transacció no és un enviament d'aquesta cartera","a transacción non é un envío desta carteira"],
    ["nem todas as entradas da transação são desta carteira; não é possível assinar a filha","not all transaction inputs belong to this wallet; the child cannot be signed","no todas las entradas de la transacción son de esta cartera; no se puede firmar la hija","toutes les entrées de la transaction ne sont pas de ce portefeuille ; impossible de signer l'enfant","non tutte le entrate della transazione sono di questo portafoglio; non è possibile firmare la figlia","nicht alle Eingänge der Transaktion gehören zu dieser Wallet; das Kind kann nicht signiert werden","niet alle invoeren van de transactie zijn van deze portemonnee; het kind kan niet worden ondertekend","no totes les entrades de la transacció són d'aquesta cartera; no es pot signar la filla","non todas as entradas da transacción son desta carteira; non é posible asinar a filla"],
    ["taxa da transação pai indisponível","parent transaction fee unavailable","comisión de la transacción padre no disponible","frais de la transaction parente indisponibles","commissione della transazione madre non disponibile","Gebühr der Eltern-Transaktion nicht verfügbar","kosten van de oudertransactie niet beschikbaar","comissió de la transacció pare no disponible","comisión da transacción pai non dispoñible"],
    ["não há saída própria ainda não gasta para acelerar","there is no unspent own output to speed up","no hay salida propia sin gastar para acelerar","aucune sortie propre non dépensée à accélérer","non c'è un'uscita propria non spesa da accelerare","es gibt keine unverbrauchte eigene Ausgabe zum Beschleunigen","er is geen ongebruikte eigen uitgang om te versnellen","no hi ha cap sortida pròpia sense gastar per accelerar","non hai ningunha saída propia sen gastar para acelerar"],
    ["há ancestral pendente com taxa que não é desta carteira; não é possível calcular o pacote com segurança","there is a pending ancestor with a fee that is not from this wallet; the package cannot be calculated safely","hay un ancestro pendiente con una comisión que no es de esta cartera; no se puede calcular el paquete con seguridad","il y a un ancêtre en attente avec des frais qui ne sont pas de ce portefeuille ; impossible de calculer le paquet en sécurité","c'è un antenato in attesa con una commissione che non è di questo portafoglio; non è possibile calcolare il pacchetto con sicurezza","es gibt einen ausstehenden Vorfahren mit einer Gebühr, die nicht von dieser Wallet stammt; das Paket kann nicht sicher berechnet werden","er is een openstaande voorouder met kosten die niet van deze portemonnee zijn; het pakket kan niet veilig worden berekend","hi ha un ancestre pendent amb una comissió que no és d'aquesta cartera; no es pot calcular el paquet amb seguretat","hai un antepasado pendente cunha comisión que non é desta carteira; non é posible calcular o paquete con seguridade"],
    ["endereço de troco indisponível","change address unavailable","dirección de cambio no disponible","adresse de monnaie indisponible","indirizzo di resto non disponibile","Wechselgeldadresse nicht verfügbar","wisselgeldadres niet beschikbaar","adreça de canvi no disponible","enderezo de troco non dispoñible"],
    ["a transação já paga a taxa alvo; não há o que acelerar","the transaction already pays the target fee; there is nothing to speed up","la transacción ya paga la comisión objetivo; no hay nada que acelerar","la transaction paie déjà les frais cibles ; il n'y a rien à accélérer","la transazione paga già la commissione obiettivo; non c'è nulla da accelerare","die Transaktion zahlt bereits die Zielgebühr; es gibt nichts zu beschleunigen","de transactie betaalt de doelkosten al; er is niets te versnellen","la transacció ja paga la comissió objectiu; no hi ha res a accelerar","a transacción xa paga a comisión obxectivo; non hai nada que acelerar"],
    ["taxa inválida: use de 0,001 a 10 000 sat/vB","invalid fee: use 0.001 to 10,000 sat/vB","comisión no válida: usa de 0,001 a 10 000 sat/vB","frais invalides : utilisez de 0,001 à 10 000 sat/vB","commissione non valida: usa da 0,001 a 10 000 sat/vB","ungültige Gebühr: Verwende 0,001 bis 10 000 sat/vB","ongeldige kosten: gebruik 0,001 tot 10 000 sat/vB","comissió no vàlida: fes servir de 0,001 a 10 000 sat/vB","comisión non válida: usa de 0,001 a 10 000 sat/vB"],
    ["entrada sem acesso à transação anterior (non_witness_utxo)","input without access to the previous transaction (non_witness_utxo)","entrada sin acceso a la transacción anterior (non_witness_utxo)","entrée sans accès à la transaction précédente (non_witness_utxo)","input senza accesso alla transazione precedente (non_witness_utxo)","Eingang ohne Zugriff auf die vorherige Transaktion (non_witness_utxo)","invoer zonder toegang tot de vorige transactie (non_witness_utxo)","entrada sense accés a la transacció anterior (non_witness_utxo)","entrada sen acceso á transacción anterior (non_witness_utxo)"],
    ["transação anterior da entrada {txid} não encontrada","previous transaction for input {txid} not found","transacción anterior de la entrada {txid} no encontrada","transaction précédente de l'entrée {txid} introuvable","transazione precedente dell'input {txid} non trovata","vorherige Transaktion des Eingangs {txid} nicht gefunden","vorige transactie van invoer {txid} niet gevonden","transacció anterior de l'entrada {txid} no trobada","transacción anterior da entrada {txid} non atopada"],
    ["saída do pai indisponível","parent output unavailable","salida del padre no disponible","sortie de la parente indisponible","uscita della madre non disponibile","Ausgabe der Eltern-Transaktion nicht verfügbar","uitgang van de ouder niet beschikbaar","sortida del pare no disponible","saída do pai non dispoñible"],
    ["taxa do filho inválida","invalid child fee","comisión de la hija no válida","frais de l'enfant invalides","commissione della figlia non valida","ungültige Gebühr des Kindes","ongeldige kosten van het kind","comissió de la filla no vàlida","comisión da filla non válida"],
    ["a saída do pai não cobre a taxa necessária (o retorno ficaria abaixo do pó de {n} sats)","the parent output does not cover the required fee (the return would fall below the {n} sat dust threshold)","la salida del padre no cubre la comisión necesaria (el retorno quedaría por debajo del polvo de {n} sats)","la sortie de la parente ne couvre pas les frais nécessaires (le retour passerait sous le seuil de poussière de {n} sats)","l'uscita della madre non copre la commissione necessaria (il resto scenderebbe sotto la polvere di {n} sats)","die Ausgabe der Eltern-Transaktion deckt die nötige Gebühr nicht (der Rest läge unter dem Staub von {n} sats)","de uitgang van de ouder dekt de vereiste kosten niet (de rest zou onder de stofdrempel van {n} sats vallen)","la sortida del pare no cobreix la comissió necessària (el retorn quedaria per sota de la pols de {n} sats)","a saída do pai non cobre a comisión necesaria (o retorno quedaría por baixo do po de {n} sats)"],
    ["transação pai não encontrada para o non_witness_utxo","parent transaction not found for the non_witness_utxo","transacción padre no encontrada para el non_witness_utxo","transaction parente introuvable pour le non_witness_utxo","transazione madre non trovata per il non_witness_utxo","Eltern-Transaktion für das non_witness_utxo nicht gefunden","oudertransactie niet gevonden voor de non_witness_utxo","transacció pare no trobada per al non_witness_utxo","transacción pai non atopada para o non_witness_utxo"],
    ["valor abaixo do pó: o mínimo é {n} sats","amount below dust: the minimum is {n} sats","importe por debajo del polvo: el mínimo es {n} sats","montant sous le seuil de poussière : le minimum est {n} sats","importo sotto la polvere: il minimo è {n} sats","Betrag unter dem Staub: das Minimum ist {n} sats","bedrag onder de stofdrempel: het minimum is {n} sats","import per sota de la pols: el mínim és {n} sats","importe por baixo do po: o mínimo é {n} sats"],
    ["saldo disponível insuficiente: disponível {a} sats, precisa de {b} sats + taxa (entrada de terceiro no mempool só conta depois de confirmada)","insufficient available balance: available {a} sats, need {b} sats + fee (third-party mempool input only counts after confirmation)","saldo disponible insuficiente: disponible {a} sats, se necesitan {b} sats + comisión (una entrada de tercero en el mempool solo cuenta después de confirmarse)","solde disponible insuffisant : disponible {a} sats, besoin de {b} sats + frais (une entrée tierce dans le mempool ne compte qu'après confirmation)","saldo disponibile insufficiente: disponibili {a} sats, servono {b} sats + commissione (un input di terzi nel mempool conta solo dopo la conferma)","verfügbares Guthaben reicht nicht: {a} sats verfügbar, benötigt {b} sats + Gebühr (ein Fremdeingang im Mempool zählt erst nach Bestätigung)","onvoldoende beschikbaar saldo: {a} sats beschikbaar, {b} sats + kosten nodig (een invoer van derden in de mempool telt pas na bevestiging)","saldo disponible insuficient: {a} sats disponibles, calen {b} sats + comissió (una entrada de tercers al mempool només compta després de confirmar-se)","saldo dispoñible insuficiente: {a} sats dispoñibles, cómpre {b} sats + comisión (unha entrada de terceiros no mempool só conta despois de confirmarse)"],
    ["entrada {i} p2pkh não está finalizada como esperado","input {i} p2pkh is not finalized as expected","entrada {i} p2pkh no está finalizada como se esperaba","entrée {i} p2pkh n'est pas finalisée comme prévu","input {i} p2pkh non è finalizzato come previsto","Eingang {i} p2pkh ist nicht wie erwartet finalisiert","invoer {i} p2pkh is niet gefinaliseerd zoals verwacht","entrada {i} p2pkh no està finalitzada com s'esperava","entrada {i} p2pkh non está finalizada como se esperaba"],
    ["entrada {i} p2sh-p2wpkh não está finalizada como esperado","input {i} p2sh-p2wpkh is not finalized as expected","entrada {i} p2sh-p2wpkh no está finalizada como se esperaba","entrée {i} p2sh-p2wpkh n'est pas finalisée comme prévu","input {i} p2sh-p2wpkh non è finalizzato come previsto","Eingang {i} p2sh-p2wpkh ist nicht wie erwartet finalisiert","invoer {i} p2sh-p2wpkh is niet gefinaliseerd zoals verwacht","entrada {i} p2sh-p2wpkh no està finalitzada com s'esperava","entrada {i} p2sh-p2wpkh non está finalizada como se esperaba"],
    ["entrada {i} {kind} não está finalizada como esperado","input {i} {kind} is not finalized as expected","entrada {i} {kind} no está finalizada como se esperaba","entrée {i} {kind} n'est pas finalisée comme prévu","input {i} {kind} non è finalizzato come previsto","Eingang {i} {kind} ist nicht wie erwartet finalisiert","invoer {i} {kind} is niet gefinaliseerd zoals verwacht","entrada {i} {kind} no està finalitzada com s'esperava","entrada {i} {kind} non está finalizada como se esperaba"],
    ["a transação não tem entradas","the transaction has no inputs","la transacción no tiene entradas","la transaction n'a pas d'entrées","la transazione non ha input","die Transaktion hat keine Eingänge","de transactie heeft geen invoeren","la transacció no té entrades","a transacción non ten entradas"],
    ["a transação não tem saídas","the transaction has no outputs","la transacción no tiene salidas","la transaction n'a pas de sorties","la transazione non ha uscite","die Transaktion hat keine Ausgaben","de transactie heeft geen uitgangen","la transacció no té sortides","a transacción non ten saídas"],
    ["a entrada {outpoint} aparece duas vezes","input {outpoint} appears twice","la entrada {outpoint} aparece dos veces","l'entrée {outpoint} apparaît deux fois","l'input {outpoint} compare due volte","Eingang {outpoint} erscheint zweimal","invoer {outpoint} komt twee keer voor","l'entrada {outpoint} apareix dues vegades","a entrada {outpoint} aparece dúas veces"],
    ["o psbt não pertence a esta carteira","the psbt does not belong to this wallet","el psbt no pertenece a esta cartera","le psbt n'appartient pas à ce portefeuille","il psbt non appartiene a questo portafoglio","die psbt gehört nicht zu dieser Wallet","de psbt hoort niet bij deze portemonnee","el psbt no pertany a aquesta cartera","o psbt non pertence a esta carteira"],
    ["entrada {i} tem script não suportado ({kind})","input {i} has an unsupported script ({kind})","la entrada {i} tiene un script no compatible ({kind})","l'entrée {i} a un script non pris en charge ({kind})","l'input {i} ha uno script non supportato ({kind})","Eingang {i} hat ein nicht unterstütztes Skript ({kind})","invoer {i} heeft een niet-ondersteund script ({kind})","l'entrada {i} té un script no suportat ({kind})","a entrada {i} ten un script non soportado ({kind})"],
    ["entrada {i}: o script do psbt difere do da carteira","input {i}: the psbt script differs from the wallet's","entrada {i}: el script del psbt difiere del de la cartera","entrée {i} : le script du psbt diffère de celui du portefeuille","input {i}: lo script del psbt differisce da quello del portafoglio","Eingang {i}: Das Skript der psbt weicht von dem der Wallet ab","invoer {i}: het script van de psbt verschilt van dat van de portemonnee","entrada {i}: el script del psbt difereix del de la cartera","entrada {i}: o script do psbt difire do da carteira"],
    ["entrada {i}: o psbt declara {a} sats, mas a carteira tem {b} sats nessa saída","input {i}: the psbt declares {a} sats, but the wallet has {b} sats in that output","entrada {i}: el psbt declara {a} sats, pero la cartera tiene {b} sats en esa salida","entrée {i} : le psbt déclare {a} sats, mais le portefeuille en a {b} dans cette sortie","input {i}: il psbt dichiara {a} sats, ma il portafoglio ne ha {b} in quell'uscita","Eingang {i}: Die psbt gibt {a} sats an, die Wallet hat dort aber {b} sats","invoer {i}: de psbt vermeldt {a} sats, maar de portemonnee heeft {b} sats in die uitgang","entrada {i}: el psbt declara {a} sats, però la cartera en té {b} en aquesta sortida","entrada {i}: o psbt declara {a} sats, pero a carteira ten {b} sats nesa saída"],
    ["o psbt não está assinado","the psbt is not signed","el psbt no está firmado","le psbt n'est pas signé","il psbt non è firmato","die psbt ist nicht signiert","de psbt is niet ondertekend","el psbt no està signat","o psbt non está asinado"],
    ["transação com {vsize} vB; acima de {max} vB a rede recusa","transaction with {vsize} vB; above {max} vB the network rejects it","transacción con {vsize} vB; por encima de {max} vB la red la rechaza","transaction de {vsize} vB ; au-delà de {max} vB le réseau la refuse","transazione da {vsize} vB; sopra {max} vB la rete la rifiuta","Transaktion mit {vsize} vB; über {max} vB lehnt das Netzwerk sie ab","transactie van {vsize} vB; boven {max} vB weigert het netwerk haar","transacció de {vsize} vB; per sobre de {max} vB la xarxa la rebutja","transacción de {vsize} vB; por riba de {max} vB a rede rexéitaa"],
    ["saída {i} com valor inválido","output {i} with an invalid value","salida {i} con valor no válido","sortie {i} avec un montant invalide","uscita {i} con valore non valido","Ausgabe {i} mit ungültigem Betrag","uitgang {i} met ongeldige waarde","sortida {i} amb valor no vàlid","saída {i} con valor non válido"],
    ["as saídas somam mais que as entradas","the outputs add up to more than the inputs","las salidas suman más que las entradas","les sorties dépassent les entrées","le uscite superano gli input","die Ausgaben übersteigen die Eingänge","de uitgangen zijn groter dan de invoeren","les sortides sumen més que les entrades","as saídas suman máis que as entradas"],
    ["psbt grande demais ({n} caracteres; o teto é {max})","psbt too large ({n} characters; the limit is {max})","psbt demasiado grande ({n} caracteres; el límite es {max})","psbt trop volumineux ({n} caractères ; la limite est {max})","psbt troppo grande ({n} caratteri; il limite è {max})","psbt zu groß ({n} Zeichen; das Limit ist {max})","psbt te groot ({n} tekens; de limiet is {max})","psbt massa gran ({n} caràcters; el límit és {max})","psbt demasiado grande ({n} caracteres; o límite é {max})"],
    ["o servidor recusou a transação: {message}","the server rejected the transaction: {message}","el servidor rechazó la transacción: {message}","le serveur a refusé la transaction : {message}","il server ha rifiutato la transazione: {message}","der Server hat die Transaktion abgelehnt: {message}","de server weigerde de transactie: {message}","el servidor ha rebutjat la transacció: {message}","o servidor rexeitou a transacción: {message}"],
    ["psbt ilegível: {message}","unreadable psbt: {message}","psbt ilegible: {message}","psbt illisible : {message}","psbt illeggibile: {message}","psbt nicht lesbar: {message}","psbt onleesbaar: {message}","psbt il·legible: {message}","psbt ilexible: {message}"],
    ["entrada {i}: {message}","input {i}: {message}","entrada {i}: {message}","entrée {i} : {message}","input {i}: {message}","Eingang {i}: {message}","invoer {i}: {message}","entrada {i}: {message}","entrada {i}: {message}"],
    ["entrada não finalizada: {message}","input not finalized: {message}","entrada no finalizada: {message}","entrée non finalisée : {message}","input non finalizzato: {message}","Eingang nicht finalisiert: {message}","invoer niet gefinaliseerd: {message}","entrada no finalitzada: {message}","entrada non finalizada: {message}"],
    ["taxa zero: a rede pode recusar a transação","zero fee: the network may reject the transaction","comisión cero: la red puede rechazar la transacción","frais nuls : le réseau peut refuser la transaction","commissione zero: la rete può rifiutare la transazione","Gebühr null: Das Netzwerk kann die Transaktion ablehnen","kosten nul: het netwerk kan de transactie weigeren","comissió zero: la xarxa pot rebutjar la transacció","comisión cero: a rede pode rexeitar a transacción"],
    ["taxa de {rate} sat/vB, abaixo do piso de relay padrão (0,1 sat/vB): a transação pode ser recusada","fee of {rate} sat/vB, below the default relay floor (0.1 sat/vB): the transaction may be rejected","comisión de {rate} sat/vB, por debajo del piso de relay predeterminado (0,1 sat/vB): la transacción puede ser rechazada","frais de {rate} sat/vB, en dessous du plancher de relay par défaut (0,1 sat/vB) : la transaction peut être refusée","commissione di {rate} sat/vB, sotto il minimo di relay predefinito (0,1 sat/vB): la transazione può essere rifiutata","Gebühr von {rate} sat/vB, unter dem Standard-Relay-Minimum (0,1 sat/vB): Die Transaktion kann abgelehnt werden","kosten van {rate} sat/vB, onder de standaard relay-drempel (0,1 sat/vB): de transactie kan worden geweigerd","comissió de {rate} sat/vB, per sota del pis de relay predeterminat (0,1 sat/vB): la transacció pot ser rebutjada","comisión de {rate} sat/vB, por baixo do piso de relay predeterminado (0,1 sat/vB): a transacción pode ser rexeitada"],
    ["taxa de {n} sat/vB, acima de 500: confira o valor","fee of {n} sat/vB, above 500: check the amount","comisión de {n} sat/vB, por encima de 500: revisa el importe","frais de {n} sat/vB, au-dessus de 500 : vérifiez le montant","commissione di {n} sat/vB, sopra 500: controlla l'importo","Gebühr von {n} sat/vB, über 500: prüfe den Betrag","kosten van {n} sat/vB, boven 500: controleer het bedrag","comissió de {n} sat/vB, per sobre de 500: revisa l'import","comisión de {n} sat/vB, por riba de 500: revisa o importe"],
    ["a saída {i} ({address}) está abaixo do pó de {dust} sats e pode ser recusada","output {i} ({address}) is below the {dust} sat dust threshold and may be rejected","la salida {i} ({address}) está por debajo del polvo de {dust} sats y puede ser rechazada","la sortie {i} ({address}) est sous le seuil de poussière de {dust} sats et peut être refusée","l'uscita {i} ({address}) è sotto la polvere di {dust} sats e può essere rifiutata","Ausgabe {i} ({address}) liegt unter dem Staub von {dust} sats und kann abgelehnt werden","uitgang {i} ({address}) ligt onder de stofdrempel van {dust} sats en kan worden geweigerd","la sortida {i} ({address}) està per sota de la pols de {dust} sats i pot ser rebutjada","a saída {i} ({address}) está por baixo do po de {dust} sats e pode ser rexeitada"],
    ["{n} saídas pagam endereços externos: confira a lista","{n} outputs pay external addresses: check the list","{n} salidas pagan direcciones externas: revisa la lista","{n} sorties paient des adresses externes : vérifiez la liste","{n} uscite pagano indirizzi esterni: controlla l'elenco","{n} Ausgaben zahlen an externe Adressen: prüfe die Liste","{n} uitgangen betalen externe adressen: controleer de lijst","{n} sortides paguen adreces externes: revisa la llista","{n} saídas pagan enderezos externos: revisa a lista"],
    ["a entrada {outpoint} não está entre as saídas não gastas que esta sessão conhece","input {outpoint} is not among the unspent outputs this session knows","la entrada {outpoint} no está entre las salidas no gastadas que conoce esta sesión","l'entrée {outpoint} ne figure pas parmi les sorties non dépensées connues de cette session","l'input {outpoint} non è tra le uscite non spese che questa sessione conosce","Eingang {outpoint} ist nicht unter den unverbrauchten Ausgaben, die diese Sitzung kennt","invoer {outpoint} staat niet bij de ongebruikte uitgangen die deze sessie kent","l'entrada {outpoint} no és entre les sortides no gastades que coneix aquesta sessió","a entrada {outpoint} non está entre as saídas non gastadas que esta sesión coñece"],
    ["o servidor devolveu txid diferente do calculado ({txid})","the server returned a txid different from the calculated one ({txid})","el servidor devolvió un txid distinto del calculado ({txid})","le serveur a renvoyé un txid différent de celui calculé ({txid})","il server ha restituito un txid diverso da quello calcolato ({txid})","der Server hat eine andere txid als die berechnete zurückgegeben ({txid})","de server gaf een andere txid dan de berekende ({txid})","el servidor ha retornat un txid diferent del calculat ({txid})","o servidor devolveu un txid diferente do calculado ({txid})"],
    ["Transações não obtidas do servidor: {list}. Os endereços afetados mantêm o último valor calculado nesta sessão.","Transactions not obtained from the server: {list}. The affected addresses keep the last value calculated in this session.","Transacciones no obtenidas del servidor: {list}. Las direcciones afectadas mantienen el último valor calculado en esta sesión.","Transactions non obtenues du serveur : {list}. Les adresses concernées gardent la dernière valeur calculée dans cette session.","Transazioni non ottenute dal server: {list}. Gli indirizzi interessati mantengono l'ultimo valore calcolato in questa sessione.","Nicht vom Server erhaltene Transaktionen: {list}. Die betroffenen Adressen behalten den zuletzt in dieser Sitzung berechneten Wert.","Niet van de server verkregen transacties: {list}. De getroffen adressen behouden de laatst berekende waarde in deze sessie.","Transaccions no obtingudes del servidor: {list}. Les adreces afectades mantenen l'últim valor calculat en aquesta sessió.","Transaccións non obtidas do servidor: {list}. Os enderezos afectados manteñen o último valor calculado nesta sesión."],
    ["{n} endereço(s) com valor antigo por falta de transação.","{n} address(es) with an old value due to a missing transaction.","{n} dirección(es) con valor antiguo por falta de transacción.","{n} adresse(s) avec une valeur ancienne faute de transaction.","{n} indirizzo/i con valore vecchio per mancanza di transazione.","{n} Adresse(n) mit altem Wert wegen fehlender Transaktion.","{n} adres(sen) met een oude waarde door een ontbrekende transactie.","{n} adreça/des amb valor antic per falta de transacció.","{n} enderezo(s) con valor antigo por falta de transacción."],
    ["PSBT vazio","empty psbt","psbt vacío","psbt vide","psbt vuoto","leere psbt","lege psbt","psbt buit","psbt baleiro"],
    ["base64 inválido","invalid base64","base64 no válido","base64 invalide","base64 non valido","ungültiges Base64","ongeldige base64","base64 no vàlid","base64 non válido"],
    ["não começa com a marca psbt","does not start with the psbt marker","no empieza por la marca psbt","ne commence pas par la marque psbt","non inizia con il marcatore psbt","beginnt nicht mit der psbt-Marke","begint niet met de psbt-markering","no comença per la marca psbt","non comeza coa marca psbt"],
    ["PSBT v2 não é suportado; exporte em PSBT v0","PSBT v2 is not supported; export it as PSBT v0","PSBT v2 no es compatible; expórtalo como PSBT v0","PSBT v2 n'est pas pris en charge ; exportez-le en PSBT v0","PSBT v2 non è supportato; esportalo come PSBT v0","PSBT v2 wird nicht unterstützt; exportiere sie als PSBT v0","PSBT v2 wordt niet ondersteund; exporteer hem als PSBT v0","PSBT v2 no és compatible; exporta'l com a PSBT v0","PSBT v2 non está soportado; expórtao como PSBT v0"],
    ["PSBT sem transação não assinada (v0)","PSBT without the unsigned transaction (v0)","PSBT sin la transacción no firmada (v0)","PSBT sans la transaction non signée (v0)","PSBT senza la transazione non firmata (v0)","PSBT ohne die unsignierte Transaktion (v0)","PSBT zonder de niet-ondertekende transactie (v0)","PSBT sense la transacció no signada (v0)","PSBT sen a transacción non asinada (v0)"],
    ["a transação não assinada veio no formato witness; PSBT v0 exige o formato antigo","the unsigned transaction came in witness format; PSBT v0 requires the legacy format","la transacción no firmada vino en formato witness; PSBT v0 exige el formato antiguo","la transaction non signée est au format witness ; PSBT v0 exige l'ancien format","la transazione non firmata è arrivata in formato witness; PSBT v0 richiede il formato legacy","die unsignierte Transaktion kam im Witness-Format; PSBT v0 verlangt das alte Format","de niet-ondertekende transactie kwam in witness-formaat; PSBT v0 vereist het oude formaat","la transacció no signada ha arribat en format witness; PSBT v0 exigeix el format antic","a transacción non asinada veu en formato witness; PSBT v0 esixe o formato antigo"],
    ["a transação não assinada veio com scriptSig; PSBT v0 exige scriptSig vazio","the unsigned transaction came with a scriptSig; PSBT v0 requires an empty scriptSig","la transacción no firmada vino con scriptSig; PSBT v0 exige scriptSig vacío","la transaction non signée comporte un scriptSig ; PSBT v0 exige un scriptSig vide","la transazione non firmata è arrivata con scriptSig; PSBT v0 richiede scriptSig vuoto","die unsignierte Transaktion kam mit scriptSig; PSBT v0 verlangt ein leeres scriptSig","de niet-ondertekende transactie kwam met een scriptSig; PSBT v0 vereist een lege scriptSig","la transacció no signada ha arribat amb scriptSig; PSBT v0 exigeix scriptSig buit","a transacción non asinada veu con scriptSig; PSBT v0 esixe scriptSig baleiro"],
    ["bytes sobrando depois do PSBT","bytes left over after the PSBT","bytes sobrantes después del PSBT","octets en trop après le PSBT","byte in eccesso dopo il PSBT","übrige Bytes nach der PSBT","overgebleven bytes na de PSBT","bytes sobrants després del PSBT","bytes sobrantes despois do PSBT"],
    ["PSBT truncado","truncated PSBT","PSBT truncado","PSBT tronqué","PSBT troncato","abgeschnittene PSBT","afgekapte PSBT","PSBT truncat","PSBT truncado"],
    ["chave do PSBT truncada","truncated PSBT key","clave del PSBT truncada","clé du PSBT tronquée","chiave del PSBT troncata","abgeschnittener PSBT-Schlüssel","afgekapte PSBT-sleutel","clau del PSBT truncada","chave do PSBT truncada"],
    ["chave vazia no PSBT","empty key in the PSBT","clave vacía en el PSBT","clé vide dans le PSBT","chiave vuota nel PSBT","leerer Schlüssel in der PSBT","lege sleutel in de PSBT","clau buida al PSBT","chave baleira no PSBT"],
    ["chave repetida no PSBT","repeated key in the PSBT","clave repetida en el PSBT","clé répétée dans le PSBT","chiave ripetuta nel PSBT","doppelter Schlüssel in der PSBT","dubbele sleutel in de PSBT","clau repetida al PSBT","chave repetida no PSBT"],
    ["valor do PSBT truncado","truncated PSBT value","valor del PSBT truncado","valeur du PSBT tronquée","valore del PSBT troncato","abgeschnittener PSBT-Wert","afgekapte PSBT-waarde","valor del PSBT truncat","valor do PSBT truncado"],
    ["PSBT inválido: {name} com bytes extras na chave.","Invalid PSBT: {name} has extra bytes in the key.","PSBT no válido: {name} tiene bytes extra en la clave.","PSBT invalide : {name} comporte des octets en trop dans la clé.","PSBT non valido: {name} ha byte extra nella chiave.","Ungültige PSBT: {name} hat zusätzliche Bytes im Schlüssel.","Ongeldige PSBT: {name} heeft extra bytes in de sleutel.","PSBT no vàlid: {name} té bytes extra a la clau.","PSBT non válido: {name} ten bytes extra na clave."],
    ["PSBT inválido: {name} com tamanho incorreto.","Invalid PSBT: {name} has the wrong size.","PSBT no válido: {name} tiene un tamaño incorrecto.","PSBT invalide : {name} a une taille incorrecte.","PSBT non valido: {name} ha una dimensione errata.","Ungültige PSBT: {name} hat die falsche Größe.","Ongeldige PSBT: {name} heeft de verkeerde grootte.","PSBT no vàlid: {name} té una mida incorrecta.","PSBT non válido: {name} ten un tamaño incorrecto."],
    ["PSBT inválido: {name} com caminho de derivação malformado.","Invalid PSBT: {name} has a malformed derivation path.","PSBT no válido: {name} tiene una ruta de derivación malformada.","PSBT invalide : {name} a un chemin de dérivation malformé.","PSBT non valido: {name} ha un percorso di derivazione malformato.","Ungültige PSBT: {name} hat einen fehlerhaften Ableitungspfad.","Ongeldige PSBT: {name} heeft een onjuist afleidingspad.","PSBT no vàlid: {name} té un camí de derivació malformat.","PSBT non válido: {name} ten un camiño de derivación malformado."],
    ["PSBT inválido: tap_leaf_script com control block ou leaf version inválido.","Invalid PSBT: tap_leaf_script with an invalid control block or leaf version.","PSBT no válido: tap_leaf_script con control block o leaf version no válido.","PSBT invalide : tap_leaf_script avec control block ou leaf version invalide.","PSBT non valido: tap_leaf_script con control block o leaf version non valido.","Ungültige PSBT: tap_leaf_script mit ungültigem Control Block oder ungültiger Leaf Version.","Ongeldige PSBT: tap_leaf_script met ongeldig control block of leaf version.","PSBT no vàlid: tap_leaf_script amb control block o leaf version no vàlid.","PSBT non válido: tap_leaf_script con control block ou leaf version non válido."],
    ["PSBT inválido: tap_tree vazia ou truncada.","Invalid PSBT: empty or truncated tap_tree.","PSBT no válido: tap_tree vacía o truncada.","PSBT invalide : tap_tree vide ou tronqué.","PSBT non valido: tap_tree vuota o troncata.","Ungültige PSBT: leere oder abgeschnittene tap_tree.","Ongeldige PSBT: lege of afgekapte tap_tree.","PSBT no vàlid: tap_tree buida o truncada.","PSBT non válido: tap_tree baleira ou truncada."],
    ["PSBT inválido: {name} vazio.","Invalid PSBT: empty {name}.","PSBT no válido: {name} vacío.","PSBT invalide : {name} vide.","PSBT non valido: {name} vuoto.","Ungültige PSBT: {name} ist leer.","Ongeldige PSBT: {name} is leeg.","PSBT no vàlid: {name} buit.","PSBT non válido: {name} baleiro."],
    ["PSBT inválido: campo exclusivo de PSBT v2 dentro de um PSBT v0.","Invalid PSBT: PSBT v2-only field inside a PSBT v0.","PSBT no válido: campo exclusivo de PSBT v2 dentro de un PSBT v0.","PSBT invalide : champ réservé à PSBT v2 dans un PSBT v0.","PSBT non valido: campo esclusivo di PSBT v2 dentro un PSBT v0.","Ungültige PSBT: nur für PSBT v2 gültiges Feld in einer PSBT v0.","Ongeldige PSBT: veld dat alleen bij PSBT v2 hoort in een PSBT v0.","PSBT no vàlid: camp exclusiu de PSBT v2 dins d'un PSBT v0.","PSBT non válido: campo exclusivo de PSBT v2 dentro dun PSBT v0."],
    ["PSBT inválido: xpub com tamanho incorreto.","Invalid PSBT: xpub with the wrong size.","PSBT no válido: xpub con tamaño incorrecto.","PSBT invalide : xpub de taille incorrecte.","PSBT non valido: xpub con dimensione errata.","Ungültige PSBT: xpub mit falscher Größe.","Ongeldige PSBT: xpub met verkeerde grootte.","PSBT no vàlid: xpub amb mida incorrecta.","PSBT non válido: xpub con tamaño incorrecto."],
    ["PSBT inválido: xpub com caminho de derivação malformado.","Invalid PSBT: xpub with a malformed derivation path.","PSBT no válido: xpub con ruta de derivación malformada.","PSBT invalide : xpub avec chemin de dérivation malformé.","PSBT non valido: xpub con percorso di derivazione malformato.","Ungültige PSBT: xpub mit fehlerhaftem Ableitungspfad.","Ongeldige PSBT: xpub met onjuist afleidingspad.","PSBT no vàlid: xpub amb camí de derivació malformat.","PSBT non válido: xpub con camiño de derivación malformado."],
    ["PSBT inválido: witness_utxo com bytes extras.","Invalid PSBT: witness_utxo with extra bytes.","PSBT no válido: witness_utxo con bytes extra.","PSBT invalide : witness_utxo avec octets en trop.","PSBT non valido: witness_utxo con byte extra.","Ungültige PSBT: witness_utxo mit zusätzlichen Bytes.","Ongeldige PSBT: witness_utxo met extra bytes.","PSBT no vàlid: witness_utxo amb bytes extra.","PSBT non válido: witness_utxo con bytes extra."],
    ["PSBT inválido: partial_sig com pubkey inválida.","Invalid PSBT: partial_sig with an invalid pubkey.","PSBT no válido: partial_sig con pubkey no válida.","PSBT invalide : partial_sig avec pubkey invalide.","PSBT non valido: partial_sig con pubkey non valida.","Ungültige PSBT: partial_sig mit ungültigem Pubkey.","Ongeldige PSBT: partial_sig met ongeldige pubkey.","PSBT no vàlid: partial_sig amb pubkey no vàlida.","PSBT non válido: partial_sig con pubkey non válida."],
    ["PSBT inválido: partial_sig vazia.","Invalid PSBT: empty partial_sig.","PSBT no válido: partial_sig vacía.","PSBT invalide : partial_sig vide.","PSBT non valido: partial_sig vuota.","Ungültige PSBT: leere partial_sig.","Ongeldige PSBT: lege partial_sig.","PSBT no vàlid: partial_sig buida.","PSBT non válido: partial_sig baleira."],
    ["PSBT inválido: bip32_derivation com pubkey inválida.","Invalid PSBT: bip32_derivation with an invalid pubkey.","PSBT no válido: bip32_derivation con pubkey no válida.","PSBT invalide : bip32_derivation avec pubkey invalide.","PSBT non valido: bip32_derivation con pubkey non valida.","Ungültige PSBT: bip32_derivation mit ungültigem Pubkey.","Ongeldige PSBT: bip32_derivation met ongeldige pubkey.","PSBT no vàlid: bip32_derivation amb pubkey no vàlida.","PSBT non válido: bip32_derivation con pubkey non válida."],
    ["PSBT inválido: tap_key_sig com tamanho diferente de 64/65 bytes.","Invalid PSBT: tap_key_sig with a size other than 64/65 bytes.","PSBT no válido: tap_key_sig con tamaño distinto de 64/65 bytes.","PSBT invalide : tap_key_sig de taille différente de 64/65 octets.","PSBT non valido: tap_key_sig con dimensione diversa da 64/65 byte.","Ungültige PSBT: tap_key_sig mit einer Größe ungleich 64/65 Bytes.","Ongeldige PSBT: tap_key_sig met een grootte anders dan 64/65 bytes.","PSBT no vàlid: tap_key_sig amb mida diferent de 64/65 bytes.","PSBT non válido: tap_key_sig con tamaño diferente de 64/65 bytes."],
    ["PSBT inválido: tap_script_sig com chave ou tamanho inválido.","Invalid PSBT: tap_script_sig with an invalid key or size.","PSBT no válido: tap_script_sig con clave o tamaño no válido.","PSBT invalide : tap_script_sig avec clé ou taille invalide.","PSBT non valido: tap_script_sig con chiave o dimensione non valida.","Ungültige PSBT: tap_script_sig mit ungültigem Schlüssel oder ungültiger Größe.","Ongeldige PSBT: tap_script_sig met ongeldige sleutel of grootte.","PSBT no vàlid: tap_script_sig amb clau o mida no vàlida.","PSBT non válido: tap_script_sig con clave ou tamaño non válido."],
    ["transação truncada","truncated transaction","transacción truncada","transaction tronquée","transazione troncata","abgeschnittene Transaktion","afgekapte transactie","transacció truncada","transacción truncada"],
    ["saída truncada","truncated output","salida truncada","sortie tronquée","uscita troncata","abgeschnittene Ausgabe","afgekapte uitgang","sortida truncada","saída truncada"],
    ["script da saída truncado","truncated output script","script de la salida truncado","script de sortie tronqué","script dell'uscita troncato","abgeschnittenes Ausgabeskript","afgekapt script van de uitgang","script de la sortida truncat","script da saída truncado"],
    ["varint fora do buffer","varint outside the buffer","varint fuera del búfer","varint hors du tampon","varint fuori dal buffer","Varint außerhalb des Puffers","varint buiten de buffer","varint fora del búfer","varint fóra do búfer"],
    ["witness final truncado","truncated final witness","witness final truncado","witness final tronqué","witness finale troncato","abgeschnittener finaler Witness","afgekapte finale witness","witness final truncat","witness final truncado"],
    ["PSBT sem a transação não assinada","PSBT without the unsigned transaction","PSBT sin la transacción no firmada","PSBT sans la transaction non signée","PSBT senza la transazione non firmata","PSBT ohne die unsignierte Transaktion","PSBT zonder de niet-ondertekende transactie","PSBT sense la transacció no signada","PSBT sen a transacción non asinada"],
    ["entrada {i} já tem scriptSig na transação não assinada","input {i} already has a scriptSig in the unsigned transaction","la entrada {i} ya tiene scriptSig en la transacción no firmada","l'entrée {i} a déjà un scriptSig dans la transaction non signée","l'input {i} ha già uno scriptSig nella transazione non firmata","Eingang {i} hat bereits ein scriptSig in der unsignierten Transaktion","invoer {i} heeft al een scriptSig in de niet-ondertekende transactie","l'entrada {i} ja té scriptSig a la transacció no signada","a entrada {i} xa ten scriptSig na transacción non asinada"],
    ["uma entrada: não está finalizada; o PSBT precisa dos campos finais para gerar a transação.","an input: it is not finalized; the PSBT needs the final fields to generate the transaction.","una entrada: no está finalizada; el PSBT necesita los campos finales para generar la transacción.","une entrée : elle n'est pas finalisée ; le PSBT a besoin des champs finaux pour générer la transaction.","un input: non è finalizzato; il PSBT ha bisogno dei campi finali per generare la transazione.","ein Eingang: er ist nicht finalisiert; die PSBT braucht die finalen Felder, um die Transaktion zu erzeugen.","een invoer: is niet gefinaliseerd; de PSBT heeft de definitieve velden nodig om de transactie te maken.","una entrada: no està finalitzada; el PSBT necessita els camps finals per generar la transacció.","unha entrada: non está finalizada; o PSBT precisa os campos finais para xerar a transacción."],
    ["uma entrada: p2pkh não está finalizada como esperado.","an input: p2pkh is not finalized as expected.","una entrada: p2pkh no está finalizada como se esperaba.","une entrée : p2pkh n'est pas finalisée comme prévu.","un input: p2pkh non è finalizzato come previsto.","ein Eingang: p2pkh ist nicht wie erwartet finalisiert.","een invoer: p2pkh is niet gefinaliseerd zoals verwacht.","una entrada: p2pkh no està finalitzada com s'esperava.","unha entrada: p2pkh non está finalizada como se esperaba."],
    ["uma entrada: p2sh-p2wpkh não está finalizada como esperado.","an input: p2sh-p2wpkh is not finalized as expected.","una entrada: p2sh-p2wpkh no está finalizada como se esperaba.","une entrée : p2sh-p2wpkh n'est pas finalisée comme prévu.","un input: p2sh-p2wpkh non è finalizzato come previsto.","ein Eingang: p2sh-p2wpkh ist nicht wie erwartet finalisiert.","een invoer: p2sh-p2wpkh is niet gefinaliseerd zoals verwacht.","una entrada: p2sh-p2wpkh no està finalitzada com s'esperava.","unha entrada: p2sh-p2wpkh non está finalizada como se esperaba."],
    ["uma entrada: {kind} não está finalizada como esperado.","an input: {kind} is not finalized as expected.","una entrada: {kind} no está finalizada como se esperaba.","une entrée : {kind} n'est pas finalisée comme prévu.","un input: {kind} non è finalizzato come previsto.","ein Eingang: {kind} ist nicht wie erwartet finalisiert.","een invoer: {kind} is niet gefinaliseerd zoals verwacht.","una entrada: {kind} no està finalitzada com s'esperava.","unha entrada: {kind} non está finalizada como se esperaba."],
    ["uma entrada: script não suportado; use p2pkh, p2sh-p2wpkh, p2wpkh ou p2tr key path.","an input: unsupported script; use p2pkh, p2sh-p2wpkh, p2wpkh or p2tr key path.","una entrada: script no compatible; usa p2pkh, p2sh-p2wpkh, p2wpkh o p2tr key path.","une entrée : script non pris en charge ; utilisez p2pkh, p2sh-p2wpkh, p2wpkh ou p2tr key path.","un input: script non supportato; usa p2pkh, p2sh-p2wpkh, p2wpkh o p2tr key path.","ein Eingang: nicht unterstütztes Script; verwende p2pkh, p2sh-p2wpkh, p2wpkh oder p2tr key path.","een invoer: niet-ondersteund script; gebruik p2pkh, p2sh-p2wpkh, p2wpkh of p2tr key path.","una entrada: script no suportat; fes servir p2pkh, p2sh-p2wpkh, p2wpkh o p2tr key path.","unha entrada: script non soportado; usa p2pkh, p2sh-p2wpkh, p2wpkh ou p2tr key path."],
    ["witness_utxo com bytes sobrando","witness_utxo with extra bytes","witness_utxo con bytes sobrantes","witness_utxo avec octets en trop","witness_utxo con byte in eccesso","witness_utxo mit übrigen Bytes","witness_utxo met overgebleven bytes","witness_utxo amb bytes sobrants","witness_utxo con bytes sobrantes"],
    ["non_witness_utxo não corresponde ao txid da entrada","non_witness_utxo does not match the input txid","non_witness_utxo no corresponde al txid de la entrada","non_witness_utxo ne correspond pas au txid de l'entrée","non_witness_utxo non corrisponde al txid dell'input","non_witness_utxo passt nicht zur txid des Eingangs","non_witness_utxo hoort niet bij de txid van de invoer","non_witness_utxo no correspon al txid de l'entrada","non_witness_utxo non corresponde ao txid da entrada"],
    ["vout fora do non_witness_utxo","vout outside the non_witness_utxo","vout fuera del non_witness_utxo","vout hors du non_witness_utxo","vout fuori dal non_witness_utxo","vout außerhalb des non_witness_utxo","vout buiten de non_witness_utxo","vout fora del non_witness_utxo","vout fóra do non_witness_utxo"],
    ["witness_utxo contradiz o non_witness_utxo","witness_utxo contradicts the non_witness_utxo","witness_utxo contradice el non_witness_utxo","witness_utxo contredit le non_witness_utxo","witness_utxo contraddice il non_witness_utxo","witness_utxo widerspricht dem non_witness_utxo","witness_utxo spreekt de non_witness_utxo tegen","witness_utxo contradiu el non_witness_utxo","witness_utxo contradí o non_witness_utxo"],
    ["entrada sem witness_utxo nem non_witness_utxo","input without witness_utxo or non_witness_utxo","entrada sin witness_utxo ni non_witness_utxo","entrée sans witness_utxo ni non_witness_utxo","input senza witness_utxo né non_witness_utxo","Eingang ohne witness_utxo oder non_witness_utxo","invoer zonder witness_utxo of non_witness_utxo","entrada sense witness_utxo ni non_witness_utxo","entrada sen witness_utxo nin non_witness_utxo"],
    ["PSBT inválido ou não suportado.","invalid or unsupported PSBT.","PSBT no válido o no compatible.","PSBT invalide ou non pris en charge.","PSBT non valido o non supportato.","ungültige oder nicht unterstützte PSBT.","ongeldige of niet-ondersteunde PSBT.","PSBT no vàlid o no suportat.","PSBT non válido ou non soportado."],
    ["não foi possível conferir uma entrada.","one input could not be checked.","no se pudo comprobar una entrada.","une entrée n'a pas pu être vérifiée.","non è stato possibile controllare un input.","ein Eingang konnte nicht geprüft werden.","een invoer kon niet worden gecontroleerd.","no s'ha pogut comprovar una entrada.","non se puido comprobar unha entrada."],
    ["não foi possível conferir uma saída.","one output could not be checked.","no se pudo comprobar una salida.","une sortie n'a pas pu être vérifiée.","non è stato possibile controllare un'uscita.","eine Ausgabe konnte nicht geprüft werden.","een uitgang kon niet worden gecontroleerd.","no s'ha pogut comprovar una sortida.","non se puido comprobar unha saída."],
    ["não foi possível concluir a operação.","the operation could not be completed.","no se pudo completar la operación.","l'opération n'a pas pu être terminée.","non è stato possibile completare l'operazione.","der Vorgang konnte nicht abgeschlossen werden.","de bewerking kon niet worden voltooid.","no s'ha pogut completar l'operació.","non se puido completar a operación."],
    ["conta {id} indisponível","account {id} unavailable","cuenta {id} no disponible","compte {id} indisponible","conto {id} non disponibile","Konto {id} nicht verfügbar","rekening {id} niet beschikbaar","compte {id} no disponible","conta {id} non dispoñible"],
    ["conexão Electrum fechada pelo cliente","Electrum connection closed by the client","conexión Electrum cerrada por el cliente","connexion Electrum fermée par le client","connessione Electrum chiusa dal client","Electrum-Verbindung vom Client geschlossen","Electrum-verbinding door de client gesloten","connexió Electrum tancada pel client","conexión Electrum pechada polo cliente"],
    ["fechado","closed","cerrado","fermé","chiuso","geschlossen","gesloten","tancat","pechado"],
    ["programa witness inválido","invalid witness program","programa witness no válido","programme witness invalide","programma witness non valido","ungültiges Witness-Programm","ongeldig witness-programma","programa witness no vàlid","programa witness non válido"],
    ["programa witness v0 inválido","invalid v0 witness program","programa witness v0 no válido","programme witness v0 invalide","programma witness v0 non valido","ungültiges v0-Witness-Programm","ongeldig v0-witness-programma","programa witness v0 no vàlid","programa witness v0 non válido"],
    ["versão de witness inválida","invalid witness version","versión de witness no válida","version de witness invalide","versione witness non valida","ungültige Witness-Version","ongeldige witness-versie","versió de witness no vàlida","versión de witness non válida"],
    ["apoiar","support","apoyar","soutenir","sostenere","unterstützen","steunen","donar suport","apoiar"],
    ["O Monitor BTC é gratuito. Se ele ajuda você, considere <a class=\"prose-link\" href=\"https://raelales.com/apoiar\" target=\"_blank\" rel=\"noopener noreferrer\">apoiar o projeto</a>.","Monitor BTC is free. If it helps you, consider <a class=\"prose-link\" href=\"https://raelales.com/apoiar\" target=\"_blank\" rel=\"noopener noreferrer\">supporting the project</a>.","Monitor BTC es gratuito. Si te ayuda, considera <a class=\"prose-link\" href=\"https://raelales.com/apoiar\" target=\"_blank\" rel=\"noopener noreferrer\">apoyar el proyecto</a>.","Monitor BTC est gratuit. S'il vous aide, pensez à <a class=\"prose-link\" href=\"https://raelales.com/apoiar\" target=\"_blank\" rel=\"noopener noreferrer\">soutenir le projet</a>.","Monitor BTC è gratuito. Se ti è utile, valuta di <a class=\"prose-link\" href=\"https://raelales.com/apoiar\" target=\"_blank\" rel=\"noopener noreferrer\">sostenere il progetto</a>.","Monitor BTC ist kostenlos. Wenn es dir hilft, erwäge, das Projekt <a class=\"prose-link\" href=\"https://raelales.com/apoiar\" target=\"_blank\" rel=\"noopener noreferrer\">zu unterstützen</a>.","Monitor BTC is gratis. Als het je helpt, overweeg dan het project te <a class=\"prose-link\" href=\"https://raelales.com/apoiar\" target=\"_blank\" rel=\"noopener noreferrer\">steunen</a>.","Monitor BTC és gratuït. Si t'ajuda, considera <a class=\"prose-link\" href=\"https://raelales.com/apoiar\" target=\"_blank\" rel=\"noopener noreferrer\">donar suport al projecte</a>.","O Monitor BTC é gratuíto. Se che axuda, considera <a class=\"prose-link\" href=\"https://raelales.com/apoiar\" target=\"_blank\" rel=\"noopener noreferrer\">apoiar o proxecto</a>."]
  ];
  var I18N = {};
  var PT_KEYS = {};
  LOCALES.forEach(function (code, index) {
    I18N[code] = {};
    I18N_ROWS.forEach(function (row) {
      I18N[code][row[0]] = code === 'pt' ? row[0] : row[index];
    });
  });
  I18N_ROWS.forEach(function (row) { PT_KEYS[row[0]] = true; });

  function t(key, vars) {
    if (!key) return '';
    var table = I18N[state.lang] || I18N.pt;
    var text = table[key];
    if (text === undefined) text = I18N.pt[key];
    if (text === undefined) text = key;
    if (vars) {
      Object.keys(vars).forEach(function (name) {
        text = text.split('{' + name + '}').join(String(vars[name]));
      });
    }
    return text;
  }

  /* Mensagem da tela: a chave e os campos, não o texto já montado; a troca de
     idioma redesenha o mesmo estado no idioma novo (VG-IDI-02). O `raw` é o
     texto que vem do servidor como dado e não tem tradução aqui. */
  function msg(key, vars) { return key ? { key: key, vars: vars || null } : null; }

  function rawMsg(value) { return value == null || value === '' ? null : { raw: String(value) }; }
  function specText(spec) {
    if (!spec) return '';
    if (spec.raw !== undefined) return String(spec.raw);
    if (!spec.key) return '';
    var vars = spec.vars;
    if (vars) {
      var resolved = {};
      Object.keys(vars).forEach(function (name) {
        var value = vars[name];
        resolved[name] = value && typeof value === 'object' ? specText(value) : String(value);
      });
      vars = resolved;
    }
    return t(spec.key, vars);
  }

  /* Mensagens do núcleo PSBT (src/btc-core.js) que chegam embrulhadas em
     "psbt ilegível", "entrada N" e "entrada não finalizada". O molde fica
     aqui e o detalhe do campo continua como veio. */
  function coreSpec(text) {
    if (!text) return null;
    if (PT_KEYS[text]) return msg(text);
    var m;
    m = /^PSBT inválido: (.+) com bytes extras na chave\.$/.exec(text);
    if (m) return msg('PSBT inválido: {name} com bytes extras na chave.', { name: m[1] });
    m = /^PSBT inválido: (.+) com tamanho incorreto\.$/.exec(text);
    if (m) return msg('PSBT inválido: {name} com tamanho incorreto.', { name: m[1] });
    m = /^PSBT inválido: (.+) com caminho de derivação malformado\.$/.exec(text);
    if (m) return msg('PSBT inválido: {name} com caminho de derivação malformado.', { name: m[1] });
    m = /^PSBT inválido: (.+) vazio\.$/.exec(text);
    if (m) return msg('PSBT inválido: {name} vazio.', { name: m[1] });
    m = /^entrada (\d+) já tem scriptSig na transação não assinada$/.exec(text);
    if (m) return msg('entrada {i} já tem scriptSig na transação não assinada', { i: m[1] });
    m = /^uma entrada: (\S+) não está finalizada como esperado\.$/.exec(text);
    if (m) return msg('uma entrada: {kind} não está finalizada como esperado.', { kind: m[1] });
    if (/^(uma entrada|entrada sem )/.test(text)) return msg('não foi possível conferir uma entrada.');
    if (/^(a saída|saída |as saídas)/.test(text)) return msg('não foi possível conferir uma saída.');
    if (/^(PSBT|não começa com a marca psbt|base64 inválido|a transação não assinada|bytes sobrando|chave |valor do PSBT|transação truncada|varint |witness)/.test(text)) {
      return msg('PSBT inválido ou não suportado.');
    }
    return null;
  }

  /* Texto que o servidor devolve como dado: a mensagem conhecida ganha a
     chave da tradução; o detalhe de servidor/Electrum (normalmente em inglês)
     segue como está dentro do molde do idioma. */
  function serverSpec(text) {
    if (!text) return null;
    var value = String(text);
    if (PT_KEYS[value]) return msg(value);
    var m;
    m = /^entrada (\d+): o script do psbt difere do da carteira$/.exec(value);
    if (m) return msg('entrada {i}: o script do psbt difere do da carteira', { i: m[1] });
    m = /^entrada (\d+): o psbt declara (\d+) sats, mas a carteira tem (\d+) sats nessa saída$/.exec(value);
    if (m) return msg('entrada {i}: o psbt declara {a} sats, mas a carteira tem {b} sats nessa saída', { i: m[1], a: m[2], b: m[3] });
    m = /^entrada (\d+): ([\s\S]+)$/.exec(value);
    if (m) return msg('entrada {i}: {message}', { i: m[1], message: coreSpec(m[2]) || rawMsg(m[2]) });
    m = /^psbt ilegível: ([\s\S]+)$/.exec(value);
    if (m) return msg('psbt ilegível: {message}', { message: coreSpec(m[1]) || rawMsg(m[1]) });
    m = /^entrada não finalizada: ([\s\S]+)$/.exec(value);
    if (m) return msg('entrada não finalizada: {message}', { message: coreSpec(m[1]) || rawMsg(m[1]) });
    m = /^o servidor recusou a transação: ([\s\S]+)$/.exec(value);
    if (m) return msg('o servidor recusou a transação: {message}', { message: rawMsg(m[1]) });
    m = /^endereço de destino: ([\s\S]+)$/.exec(value);
    if (m) return msg('endereço de destino: {message}', { message: serverSpec(m[1]) || rawMsg(m[1]) });
    m = /^Electrum indisponível: ([\s\S]+)$/.exec(value);
    if (m) return msg('Electrum indisponível: {message}', { message: serverSpec(m[1]) || rawMsg(m[1]) });
    m = /^nenhum servidor Electrum respondeu: ([\s\S]+)$/.exec(value);
    if (m) return msg('nenhum servidor Electrum respondeu: {details}', { details: rawMsg(m[1]) });
    m = /^configuração inválida de ELECTRUM_SERVERS: ([\s\S]+)$/.exec(value);
    if (m) return msg('configuração inválida de ELECTRUM_SERVERS: {message}', { message: rawMsg(m[1]) });
    m = /^TCP indisponível neste runtime \(cloudflare:sockets\): ([\s\S]+)$/.exec(value);
    if (m) return msg('TCP indisponível neste runtime (cloudflare:sockets): {message}', { message: rawMsg(m[1]) });
    m = /^timeout de conexão com (.+):(\d+)$/.exec(value);
    if (m) return msg('timeout de conexão com {host}:{port}', { host: m[1], port: m[2] });
    m = /^timeout de (\d+) ms em ([a-z0-9_.]+)$/i.exec(value);
    if (m) return msg('timeout de {ms} ms em {method}', { ms: m[1], method: m[2] });
    m = /^servidor Electrum inválido: ([\s\S]+)$/.exec(value);
    if (m) return msg('servidor Electrum inválido: {item}', { item: m[1] });
    m = /^transporte inválido em ([\s\S]+) \(use tls ou tcp\)$/.exec(value);
    if (m) return msg('transporte inválido em {item} (use tls ou tcp)', { item: m[1] });
    m = /^muitos pedidos; tente de novo em (\d+) s$/.exec(value);
    if (m) return msg('muitos pedidos; tente de novo em {n} s', { n: m[1] });
    m = /^entrada (\d+) p2pkh não está finalizada como esperado$/.exec(value);
    if (m) return msg('entrada {i} p2pkh não está finalizada como esperado', { i: m[1] });
    m = /^entrada (\d+) p2sh-p2wpkh não está finalizada como esperado$/.exec(value);
    if (m) return msg('entrada {i} p2sh-p2wpkh não está finalizada como esperado', { i: m[1] });
    m = /^entrada (\d+) ([a-z0-9-]+) não está finalizada como esperado$/.exec(value);
    if (m) return msg('entrada {i} {kind} não está finalizada como esperado', { i: m[1], kind: m[2] });
    m = /^entrada (\d+) tem script não suportado \(([^)]+)\)$/.exec(value);
    if (m) return msg('entrada {i} tem script não suportado ({kind})', { i: m[1], kind: m[2] });
    m = /^a entrada ([0-9a-f]+:\d+) aparece duas vezes$/.exec(value);
    if (m) return msg('a entrada {outpoint} aparece duas vezes', { outpoint: m[1] });
    m = /^transação anterior da entrada ([0-9a-f]+) não encontrada$/.exec(value);
    if (m) return msg('transação anterior da entrada {txid} não encontrada', { txid: m[1] });
    m = /^saldo disponível insuficiente: disponível (\d+) sats, precisa de (\d+) sats \+ taxa/.exec(value);
    if (m) return msg('saldo disponível insuficiente: disponível {a} sats, precisa de {b} sats + taxa (entrada de terceiro no mempool só conta depois de confirmada)', { a: m[1], b: m[2] });
    m = /^valor abaixo do pó: o mínimo é (\d+) sats$/.exec(value);
    if (m) return msg('valor abaixo do pó: o mínimo é {n} sats', { n: m[1] });
    m = /^a saída do pai não cobre a taxa necessária \(o retorno ficaria abaixo do pó de (\d+) sats\)$/.exec(value);
    if (m) return msg('a saída do pai não cobre a taxa necessária (o retorno ficaria abaixo do pó de {n} sats)', { n: m[1] });
    m = /^psbt grande demais \((\d+) caracteres; o teto é (\d+)\)$/.exec(value);
    if (m) return msg('psbt grande demais ({n} caracteres; o teto é {max})', { n: m[1], max: m[2] });
    m = /^transação com (\d+) vB; acima de (\d+) vB a rede recusa$/.exec(value);
    if (m) return msg('transação com {vsize} vB; acima de {max} vB a rede recusa', { vsize: m[1], max: m[2] });
    m = /^saída (\d+) com valor inválido$/.exec(value);
    if (m) return msg('saída {i} com valor inválido', { i: m[1] });
    m = /^taxa de ([\d.]+) sat\/vB, abaixo do piso de relay padrão \(0,1 sat\/vB\): a transação pode ser recusada$/.exec(value);
    if (m) return msg('taxa de {rate} sat/vB, abaixo do piso de relay padrão (0,1 sat/vB): a transação pode ser recusada', { rate: dec(m[1]) });
    m = /^taxa de (\d+) sat\/vB, acima de 500: confira o valor$/.exec(value);
    if (m) return msg('taxa de {n} sat/vB, acima de 500: confira o valor', { n: m[1] });
    m = /^a saída (\d+) \(([^)]+)\) está abaixo do pó de (\d+) sats e pode ser recusada$/.exec(value);
    if (m) return msg('a saída {i} ({address}) está abaixo do pó de {dust} sats e pode ser recusada', { i: m[1], address: m[2], dust: m[3] });
    m = /^(\d+) saídas pagam endereços externos: confira a lista$/.exec(value);
    if (m) return msg('{n} saídas pagam endereços externos: confira a lista', { n: m[1] });
    m = /^a entrada ([0-9a-f]+:\d+) não está entre as saídas não gastas que esta sessão conhece$/.exec(value);
    if (m) return msg('a entrada {outpoint} não está entre as saídas não gastas que esta sessão conhece', { outpoint: m[1] });
    m = /^o servidor devolveu txid diferente do calculado \(([0-9a-f]+)\)$/.exec(value);
    if (m) return msg('o servidor devolveu txid diferente do calculado ({txid})', { txid: m[1] });
    m = /^Transações não obtidas do servidor: ([\s\S]+)\. Os endereços afetados mantêm o último valor calculado nesta sessão\.$/.exec(value);
    if (m) return msg('Transações não obtidas do servidor: {list}. Os endereços afetados mantêm o último valor calculado nesta sessão.', { list: m[1] });
    m = /^conta ([\s\S]+) indisponível$/.exec(value);
    if (m) return msg('conta {id} indisponível', { id: m[1] });
    m = /^(\d+) endereço\(s\) com valor antigo por falta de transação\.$/.exec(value);
    if (m) return msg('{n} endereço(s) com valor antigo por falta de transação.', { n: m[1] });
    return coreSpec(value);
  }

  function fail(key, vars) {
    var e = new Error(t(key, vars));
    e.spec = msg(key, vars);
    return e;
  }
  function errSpec(e) {
    if (e && e.spec) return e.spec;
    var text = e && e.message ? e.message : String(e);
    return serverSpec(text) || rawMsg(text);
  }
  /* Erro do servidor chega como dado (texto em português); a mensagem
     conhecida é traduzida e o que a própria tela gera (HTTP sem JSON) sai
     pelo molde do idioma. */
  function apiFail(r, j) {
    if (j && j.error) {
      var e = new Error(j.error);
      e.spec = serverSpec(j.error) || rawMsg(j.error);
      return e;
    }
    return fail('resposta inesperada do servidor (HTTP {status}); tente de novo.', {
      status: r && r.status ? r.status : '—'
    });
  }
  function decimalSeparator() { return state.lang === 'en' ? '.' : ','; }
  function dec(value) { return String(value).replace('.', decimalSeparator()); }

  function normalizeLang(value) {
    var tag = String(value || '').toLowerCase().replace(/_/g, '-');
    for (var i = 0; i < LOCALES.length; i++) {
      if (tag === LOCALES[i] || tag.indexOf(LOCALES[i] + '-') === 0) return LOCALES[i];
    }
    return '';
  }
  function browserLang() {
    var list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
    for (var i = 0; i < list.length; i++) {
      var lang = normalizeLang(list[i]);
      if (lang) return lang;
    }
    return 'pt';
  }

  /* Texto e HTML com <b>/<code> e atributos são guardados uma vez, no texto
     português que serve de chave; a troca de idioma relê essa origem, então
     voltar para PT não depende de desfazer a tradução anterior. */
  var I18N_INLINE = { CODE: 1, B: 1, I: 1, EM: 1, STRONG: 1, SPAN: 1, TIME: 1, A: 1, BR: 1 };
  var I18N_TEXT_TAGS = { P: 1, LI: 1, H1: 1, H2: 1, H3: 1, BUTTON: 1, A: 1, SPAN: 1, TH: 1, TD: 1, LABEL: 1, TIME: 1, B: 1, CODE: 1 };
  var I18N_ATTRS = ['aria-label', 'placeholder', 'title', 'alt'];
  function i18nOnlyInline(el) {
    for (var i = 0; i < el.children.length; i++) {
      if (!I18N_INLINE[el.children[i].tagName]) return false;
    }
    return true;
  }
  function i18nHasPrompt(el) {
    for (var i = 0; i < el.children.length; i++) {
      if (el.children[i].classList && el.children[i].classList.contains('prompt')) return true;
    }
    return false;
  }
  function i18nPromptText(el) {
    var text = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3 && el.childNodes[i].nodeValue.trim()) {
        text += el.childNodes[i].nodeValue;
      }
    }
    return text.trim();
  }
  function prepareI18n() {
    $$('body *').forEach(function (el) {
      if (el.closest('script, style, svg, .edge, .rule, .watermark')) return;
      I18N_ATTRS.forEach(function (attr) {
        var value = el.getAttribute(attr);
        if (value && PT_KEYS[value]) {
          el._i18nAttr = el._i18nAttr || {};
          el._i18nAttr[attr] = value;
        }
      });
      if (el.tagName === 'H3' && i18nHasPrompt(el)) {
        var promptKey = i18nPromptText(el);
        if (promptKey && PT_KEYS[promptKey]) {
          var promptNode = null;
          for (var n = el.childNodes.length - 1; n >= 0; n--) {
            if (el.childNodes[n].nodeType === 3 && el.childNodes[n].nodeValue.trim()) {
              promptNode = el.childNodes[n];
              break;
            }
          }
          if (promptNode) {
            var promptRaw = promptNode.nodeValue;
            var promptAt = promptRaw.indexOf(promptKey);
            el._i18nKind = 'prompt';
            el._i18nKey = promptKey;
            el._i18nPrefix = promptAt >= 0 ? promptRaw.slice(0, promptAt) : (promptRaw.match(/^\s*/) || [''])[0];
            el._i18nSuffix = promptAt >= 0 ? promptRaw.slice(promptAt + promptKey.length) : '';
          }
        }
        return;
      }
      if (!I18N_TEXT_TAGS[el.tagName]) return;
      if (!el.children.length) {
        var text = el.textContent.trim();
        if (text && PT_KEYS[text]) {
          el._i18nKind = 'text';
          el._i18nKey = text;
          el._i18nRaw = el.textContent;
        }
      } else if (i18nOnlyInline(el) && !el.querySelector('input, textarea, select')) {
        var html = el.innerHTML.trim();
        if (html && PT_KEYS[html]) {
          el._i18nKind = 'html';
          el._i18nKey = html;
        }
      }
    });
  }
  function applyI18n() {
    $$('body *').forEach(function (el) {
      if (el._i18nAttr) {
        Object.keys(el._i18nAttr).forEach(function (attr) {
          el.setAttribute(attr, t(el._i18nAttr[attr]));
        });
      }
      if (el._i18nKind === 'text') {
        el.textContent = (el._i18nRaw || '').replace(el._i18nKey, t(el._i18nKey));
      } else if (el._i18nKind === 'html') {
        el.innerHTML = t(el._i18nKey);
      } else if (el._i18nKind === 'prompt') {
        for (var i = el.childNodes.length - 1; i >= 0; i--) {
          var node = el.childNodes[i];
          if (node.nodeType === 3 && node.nodeValue.trim()) {
            /* O espaço entre o ## e o texto é do nó original, não da
               tradução: sem ele, o ## cola no título na segunda troca. */
            node.nodeValue = el._i18nPrefix + t(el._i18nKey) + el._i18nSuffix;
            break;
          }
        }
      }
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtInt(v) {
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }
  /* Percentual da taxa sobre o valor enviado, com casas suficientes para
     taxas pequenas não virarem 0. */
  function fmtPercent(part, whole) {
    var pct = Number(part) / Number(whole) * 100;
    if (!isFinite(pct) || pct <= 0) return '0';
    var digits = pct >= 10 ? 0 : pct >= 1 ? 1 : pct >= 0.1 ? 2 : 3;
    return pct.toFixed(digits);
  }
  /* Só chave estendida pública de conta: xpub, zpub ou ypub. O campo nem
     aceita outra coisa: o filtro abaixo bloqueia a digitação/colagem que não
     case com um dos três prefixos e só deixa passar caracteres do alfabeto
     base58. Endereço, chave privada, seed ou lixo não chegam a formar valor. */
  var EXT_PUBLIC = ['xpub', 'zpub', 'ypub'];
  var EXT_PREFIX_LEN = EXT_PUBLIC[0].length;
  var EXT_PUBLIC_RE = /^(xpub|zpub|ypub)[1-9A-HJ-NP-Za-km-z]+$/;
  var B58_CHARS = /[1-9A-HJ-NP-Za-km-z]/;
  var XPUB_TOTAL = 111;
  var EXT_PRIVATE = /^(xprv|yprv|zprv)/;

  /* Maior trecho do começo do texto que já casa com algum dos prefixos;
     é o que permite digitar "x", "zp", "ypu" pela metade. */
  function matchExtPrefix(s) {
    var best = 0;
    for (var i = 0; i < EXT_PUBLIC.length; i++) {
      var p = EXT_PUBLIC[i];
      var keep = 0;
      while (keep < s.length && keep < p.length && s[keep] === p[keep]) keep++;
      if (keep > best) best = keep;
    }
    return best;
  }

  function filterXpub(raw) {
    var s = String(raw == null ? '' : raw).replace(/\s+/g, '');
    var keep = matchExtPrefix(s);
    if (keep < EXT_PREFIX_LEN) {
      // enquanto o texto é prefixo de xpub/zpub/ypub (x, zp, ypu…) deixa
      // digitar; se já passou disso e não casou (xprv, bc1, 1Efg…), limpa
      var partial = s.length <= EXT_PREFIX_LEN;
      return { value: partial ? s.slice(0, keep) : '', blocked: !partial };
    }
    var rest = '';
    var dropped = false;
    for (var i = EXT_PREFIX_LEN; i < s.length; i++) {
      if (B58_CHARS.test(s[i])) rest += s[i];
      else dropped = true;
    }
    var value = s.slice(0, EXT_PREFIX_LEN) + rest.slice(0, XPUB_TOTAL - EXT_PREFIX_LEN);
    return { value: value, blocked: dropped || rest.length > XPUB_TOTAL - EXT_PREFIX_LEN };
  }

  /* Mesmo formato do recado do destino ("destino inválido: use …"):
     "chave inválida: use …", com o motivo na frente do que é aceito. */
  function xpubProblem(value) {
    var s = String(value || '').trim();
    if (!s) {
      return msg('chave inválida: use a xpub, zpub ou ypub da conta.');
    }
    if (EXT_PRIVATE.test(s)) {
      return msg('chave inválida: isso é uma chave privada (xprv/yprv/zprv), nunca cole a privada aqui; use a xpub, zpub ou ypub da conta.');
    }
    if (/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{20,}$/.test(s)) {
      return msg('chave inválida: isso é um endereço Bitcoin; use a xpub, zpub ou ypub da conta.');
    }
    if (s.length !== XPUB_TOTAL || !EXT_PUBLIC_RE.test(s)) {
      return msg('chave inválida: use a xpub, zpub ou ypub da conta.');
    }
    try {
      if (window.LocalWallet) window.LocalWallet.parseXpub(s);
    } catch (e) {
      return serverSpec(e && e.message ? e.message : String(e)) ||
        msg('chave inválida: use a xpub, zpub ou ypub da conta.');
    }
    return null;
  }

  function localWallet() {
    if (!window.LocalWallet) throw fail('não foi possível carregar a derivação local; recarregue a página.');
    return window.LocalWallet;
  }

  function fmtBtc(sats) {
    var n = Number(sats) || 0;
    var neg = n < 0;
    var s = String(Math.abs(n));
    while (s.length < 9) s = '0' + s;
    return (neg ? '-' : '') + s.slice(0, -8) + '.' + s.slice(-8);
  }
  /* Locktime → data estimada; 0 = não. Igual ao cofre: locktime em bloco
     vira data aproximada (10 min por bloco desde o genesis) e o bloco não
     aparece, só a data. */
  function scheduledText(locktime) {
    var value = Number(locktime) >>> 0;
    if (!value) return t('não');
    var date = value >= 500000000
      ? new Date(value * 1000)
      : new Date((1231006505 + value * 600) * 1000);
    if (isNaN(date.getTime())) return t('data estimada indisponível');
    var stamp = date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    return value < 500000000 ? t('{value} (aprox.)', { value: stamp }) : stamp;
  }
  function rbfText(rbf) { return t(rbf ? 'sim' : 'não'); }
  /* Valor digitado em BTC → sats inteiros. Aceita vírgula ou ponto e até 8
     casas; qualquer outra coisa (ou zero) devolve null. */
  function parseBtcSats(text) {
    var s = String(text == null ? '' : text).trim().replace(/\s+/g, '').replace(',', '.');
    if (!/^\d+(\.\d{0,8})?$/.test(s)) return null;
    var parts = s.split('.');
    var whole = BigInt(parts[0] || '0');
    var frac = (parts[1] || '').padEnd(8, '0');
    var sats = whole * 100000000n + BigInt(frac || '0');
    if (sats <= 0n || sats > 2100000000000000n) return null;
    return Number(sats);
  }
  /* Marcador do recado (VG-FRM-06): o estado vem antes do texto, em caixa
     baixa e entre colchetes, como no gerador. O neutro é o mesmo sinal do
     carregamento e some quando a consulta termina. */
  var PREFIX = { ok: '[ ok ]', error: '[ erro ]', '': '[ ... ]' };
  /* Aviso temporário (VG-ABS-07): o recado final do formulário e da ação
     secundária some sozinho em 8 s, pausa com o ponteiro sobre ele ou o foco
     no formulário e recomeça de onde parou. O neutro de carregamento fica
     fora: ele é substituído pelo recado final. */
  var notices = new WeakMap();
  function noticeClear(el) {
    el._statusSpec = null;
    el.textContent = '';
    el.classList.remove('ok', 'error');
  }
  function noticeStop(el) {
    var n = notices.get(el);
    if (n && n.timer) { clearTimeout(n.timer); n.timer = 0; }
  }
  function noticeResume(el) {
    var n = notices.get(el);
    if (!n || n.timer || n.remaining <= 0) return;
    n.startedAt = Date.now();
    n.timer = setTimeout(function () {
      n.timer = 0;
      noticeClear(el);
    }, n.remaining);
  }
  function noticePause(el) {
    var n = notices.get(el);
    if (!n || !n.timer) return;
    clearTimeout(n.timer);
    n.timer = 0;
    n.remaining = Math.max(0, n.remaining - (Date.now() - n.startedAt));
  }
  function noticeSchedule(el) {
    var n = notices.get(el);
    if (!n) { n = { timer: 0, remaining: 0, startedAt: 0 }; notices.set(el, n); }
    noticeStop(el);
    n.remaining = motionMs('--motion-notice', 8000);
    n.startedAt = Date.now();
    n.timer = setTimeout(function () {
      n.timer = 0;
      noticeClear(el);
    }, n.remaining);
  }
  function noticeWire(el) {
    if (!el) return;
    var form = el.closest ? el.closest('form') : null;
    el.addEventListener('pointerenter', function () { noticePause(el); });
    el.addEventListener('pointerleave', function () { noticeResume(el); });
    if (!form) return;
    form.addEventListener('focusin', function () { noticePause(el); });
    form.addEventListener('focusout', function () {
      setTimeout(function () {
        if (!form.contains(document.activeElement)) noticeResume(el);
      }, 0);
    });
  }
  /* O recado guarda a chave e os campos, não o texto já montado: a troca de
     idioma redesenha o mesmo estado sem perder a mensagem (VG-IDI-02). */
  function paintStatusTo(el) {
    if (!el) return;
    var spec = el._statusSpec;
    var body = specText(spec);
    var prefix = spec && PREFIX[spec.kind] ? t(PREFIX[spec.kind]) : '';
    el.textContent = body ? (prefix ? prefix + ' ' + body : body) : '';
    el.classList.remove('ok', 'error');
    if (spec && (spec.kind === 'ok' || spec.kind === 'error')) el.classList.add(spec.kind);
  }
  function paintStatuses() {
    ['#status', '#send-status', '#broadcast-status', '#cpfp-status'].forEach(function (sel) {
      paintStatusTo($(sel));
    });
  }
  function setStatusTo(el, kind, spec) {
    if (!el) return;
    el._statusSpec = spec ? { kind: kind, key: spec.key, vars: spec.vars, raw: spec.raw } : null;
    paintStatusTo(el);
    if (kind === 'ok' || kind === 'error') noticeSchedule(el);
    else noticeStop(el);
  }
  function setStatus(kind, spec) {
    setStatusTo($('#status'), kind, spec);
  }
  function setSendStatus(kind, spec) {
    setStatusTo($('#send-status'), kind, spec);
  }
  /* Toda consulta da tela passa por aqui: sem Content-Type JSON a resposta é
     um erro do proxy/Cloudflare, não um objeto nosso; e sem timeout uma
     requisição pendurada deixaria `state.busy` preso para sempre. */
  var REQUEST_TIMEOUT_MS = 30000;
  async function fetchJson(url, options, timeoutMs) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var opts = options || {};
    var timer = 0;
    if (controller) {
      opts = Object.assign({}, opts, { signal: controller.signal });
      timer = setTimeout(function () { controller.abort(); }, timeoutMs || REQUEST_TIMEOUT_MS);
    }
    try {
      var r;
      try {
        r = await fetch(url, opts);
      } catch (e) {
        if (e && e.name === 'AbortError') throw fail('o servidor demorou para responder; tente de novo.');
        throw fail('não foi possível falar com o servidor; tente de novo.');
      }
      var type = String(r.headers.get('Content-Type') || '').toLowerCase();
      if (type.indexOf('application/json') < 0) {
        throw fail('resposta inesperada do servidor (HTTP {status}); tente de novo.', { status: r.status });
      }
      var j;
      try {
        j = await r.json();
      } catch (e) {
        if (e && e.name === 'AbortError') throw fail('o servidor demorou para responder; tente de novo.');
        throw fail('resposta inválida do servidor; tente de novo.');
      }
      return { r: r, j: j };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* O freio de abuso responde 429 com Retry-After. A varredura em passos
     espera esse tempo e repete o mesmo passo em vez de perder a busca; o
     limite do servidor continua valendo, só o ritmo é respeitado. */
  var RETRY_MAX_WAIT_MS = 120000;
  function retryAfterMs(r) {
    var secs = Number(r && r.headers ? r.headers.get('Retry-After') : 0);
    if (!isFinite(secs) || secs <= 0) secs = 5;
    return Math.min(RETRY_MAX_WAIT_MS, Math.max(1000, secs * 1000));
  }
  function waitMs(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }
  /* O erro de campo usa o recado geral (VG-FRM-07): o texto fica no
     #send-status, e o campo só leva o fio/rótulo em --error e aria-invalid.
     O sinal separado evita que a atualização automática do formulário apague
     um erro do PSBT que não é de validação. */
  function setSendValidation(spec) {
    if (spec) {
      state.sendValidationError = spec;
      setSendStatus('error', spec);
    } else if (state.sendValidationError) {
      state.sendValidationError = null;
      setSendStatus('', null);
    }
  }
  function setFieldInvalid(input, invalid) {
    if (!input) return;
    var box = input.closest ? input.closest('.field-box') : null;
    var label = input.id ? document.querySelector('label[for="' + input.id + '"]') : null;
    if (box) box.classList.toggle('is-invalid', !!invalid);
    if (label) label.classList.toggle('is-invalid', !!invalid);
    if (invalid) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
  function focusFirstInvalid(root) {
    var field = root ? root.querySelector('[aria-invalid="true"]') : null;
    if (field) { field.focus(); return true; }
    return false;
  }
  var SCREEN_IDS = ['carteira', 'historico', 'sobre', 'notfound', 'language'];

  /* URL e histórico (VG-MET-10): a tela e a página da lista vão para o
     endereço; a tela inicial e a primeira página ficam sem parâmetro, para o
     endereço continuar curto. A tela de idiomas fica fora do endereço. */
  function readUrl() {
    var params = new URLSearchParams(location.search);
    var raw = params.get('screen');
    var screen = raw == null || raw === 'carteira' ? 'carteira'
      : raw === 'historico' ? 'historico'
      : raw === 'sobre' ? 'sobre'
      : 'notfound';
    // Caminho que o asset layer não conhece chega aqui pela SPA fallback
    // (wrangler.jsonc): é 404, não a carteira.
    if (location.pathname !== '/' && location.pathname !== '/index.html') screen = 'notfound';
    // O link de salto usa #content; qualquer outro hash desconhecido é 404.
    if (location.hash && location.hash !== '#content') screen = 'notfound';
    var page = parseInt(params.get('page'), 10);
    if (!isFinite(page) || page < 1) page = 1;
    return { screen: screen, page: page };
  }
  function urlFor() {
    // A 404 preserva o endereço que falhou (VG-ABS-09); as demais telas
    // escrevem o endereço curto normal.
    if (state.screen === 'notfound') return location.pathname + location.search + location.hash;
    var params = new URLSearchParams();
    if (state.screen !== 'carteira') params.set('screen', state.screen);
    if (state.screen === 'historico' && state.page > 1) params.set('page', String(state.page));
    var query = params.toString();
    return location.pathname + (query ? '?' + query : '');
  }
  function pushScreenUrl() {
    var url = urlFor();
    if (url === location.pathname + location.search) return;
    history.pushState({ screen: state.screen, page: state.page }, '', url);
  }

  /* Entrada em foco (VG-EFE-02): o título assenta, a régua se desenha da
     esquerda para a direita e cada bloco sobe 12 px enquanto o desfoque se
     resolve, escalonado. Não repete na troca de tema; com menos movimento, o
     conteúdo aparece direto. */
  // Os blocos entram deslocados 12 px para baixo, e a transformação entra na
  // conta do scrollHeight: enquanto a entrada roda, updateScroll() desconta
  // esse deslocamento para não acender a seta de baixo numa tela que cabe
  // inteira. No fim da entrada a medida volta ao normal e é reavaliada.
  var REVEAL_RISE = 12;
  var revealLift = 0;
  var revealRun = 0;
  function runReveal(screen) {
    if (!screen || prefersReducedMotion() || !Element.prototype.animate) {
      revealLift = 0;
      return;
    }
    var title = screen.querySelector('h2');
    var rule = screen.querySelector('.rule:not(.rule-dots)');
    if (!title || !rule) {
      revealLift = 0;
      return;
    }
    var blocks = Array.prototype.filter.call(screen.children, function (el) {
      return el !== title && el !== rule && !el.hidden && el.getClientRects().length;
    });
    var ease = 'cubic-bezier(.16,1,.3,1)';
    var easeDraw = 'cubic-bezier(.65,0,.35,1)';
    [title, rule].concat(blocks).forEach(function (el) {
      if (el.getAnimations) el.getAnimations().forEach(function (a) { a.cancel(); });
    });
    title.animate([
      { opacity: 0, transform: 'translateY(-6px)' },
      { opacity: 1, transform: 'translateY(0)' }
    ], { duration: motionMs('--motion-reveal-head', 250), easing: ease, fill: 'both' });
    rule.animate([
      { opacity: 0, clipPath: 'inset(0 100% 0 0)' },
      { opacity: 1, clipPath: 'inset(0 0 0 0)' }
    ], {
      duration: motionMs('--motion-reveal', 250),
      delay: motionMs('--motion-rule-delay', 75),
      easing: easeDraw,
      fill: 'both'
    });
    blocks.forEach(function (el, i) {
      el.animate([
        { opacity: 0, transform: 'translateY(' + REVEAL_RISE + 'px)', filter: 'blur(3px)' },
        { opacity: 1, transform: 'translateY(0)', filter: 'blur(0px)' }
      ], {
        duration: motionMs('--motion-reveal', 250),
        delay: motionMs('--motion-reveal-delay', 50) + i * motionMs('--motion-reveal-step', 25),
        easing: ease,
        fill: 'both'
      });
    });
    var runId = ++revealRun;
    revealLift = REVEAL_RISE;
    screen.setAttribute('aria-busy', 'true');
    if (screen._revealTimer) clearTimeout(screen._revealTimer);
    screen._revealTimer = setTimeout(function () {
      screen._revealTimer = 0;
      screen.removeAttribute('aria-busy');
      if (revealRun !== runId) return;
      revealLift = 0;
      updateScroll();
    }, motionMs('--motion-reveal-total', 1000));
  }

  function markCurrent(name) {
    $$('.menu button[data-screen]').forEach(function (b) {
      if (b.getAttribute('data-screen') === name) {
        b.setAttribute('aria-current', 'page');
        b.setAttribute('tabindex', '-1');
      } else {
        b.removeAttribute('aria-current');
        b.removeAttribute('tabindex');
      }
    });
    var lang = $('#lang-btn');
    if (lang) {
      if (name === 'language') {
        lang.setAttribute('aria-current', 'page');
        lang.setAttribute('tabindex', '-1');
      } else {
        lang.removeAttribute('aria-current');
        lang.removeAttribute('tabindex');
      }
    }
  }

  function setScreenVisible(name) {
    SCREEN_IDS.forEach(function (n) {
      var sec = $('#screen-' + n);
      if (sec) sec.hidden = n !== name;
    });
  }

  function showScreen(name, opts) {
    opts = opts || {};
    if (SCREEN_IDS.indexOf(name) < 0 || name === 'language') name = 'carteira';
    state.screen = name;
    state.langOpen = false;
    setScreenVisible(name);
    markCurrent(name);
    if (name === 'historico') {
      // abrir a lista pelo menu recomeça na primeira página (VG-LST-03); a
      // abertura pelo endereço e o popstate devolvem a página pedida.
      state.page = opts.page == null ? 1 : opts.page;
      syncHistoryState();
      renderHistory();
    }
    document.title = '';
    syncMeta();
    if (!opts.keepScroll) {
      var sc = $('#content-scroll');
      if (sc) sc.scrollTop = 0;
    }
    updateScroll();
    if (!opts.noReveal) runReveal($('#screen-' + name));
    if (!opts.noUrl) pushScreenUrl();
  }

  /* Ponto de leitura (VG-LAY-12): na rolagem única quem rola é a página, e a
     posição é a da janela; na janela normal, é a do .content-scroll. Guardar e
     devolver pelo mesmo lugar mantém o voltar da tela de idiomas coerente nos
     dois modos. */
  function readingTop() {
    var page = $('.page');
    if (page && page.classList.contains('is-page-scroll')) {
      return window.pageYOffset || document.documentElement.scrollTop || 0;
    }
    var sc = $('#content-scroll');
    return sc ? sc.scrollTop : 0;
  }
  function setReadingTop(top) {
    var page = $('.page');
    if (page && page.classList.contains('is-page-scroll')) {
      window.scrollTo(window.pageXOffset || 0, top);
      return;
    }
    var sc = $('#content-scroll');
    if (sc) sc.scrollTop = top;
  }

  /* A tela de idiomas é uma tela, não um modal (VG-ABS-06): o menu perde a
     marca, o botão PT fica em vigor e o voltar/Esc devolve a tela de origem
     no mesmo ponto de leitura. Ela não entra no endereço (VG-MET-10). */
  function showLanguage() {
    // O botão em vigor não age (VG-IDI-01): a tela já está aberta e se fecha
    // pelo voltar, pelo Esc ou pela escolha de um item. O guarda também evita
    // que a rolagem da própria tela sobrescreva o ponto de leitura guardado.
    if (state.langOpen) return;
    state.langScroll = readingTop();
    state.langOpen = true;
    setScreenVisible('language');
    markCurrent('language');
    syncMeta();
    // A tela de idiomas começa no alto, qualquer que seja a rolagem da tela
    // de origem (VG-IDI-01); o voltar devolve a origem ao ponto guardado.
    setReadingTop(0);
    updateScroll();
    runReveal($('#screen-language'));
  }
  function closeLanguage() {
    state.langOpen = false;
    showScreen(state.screen, {
      page: state.page,
      keepScroll: true,
      noUrl: true
    });
    setReadingTop(state.langScroll);
    updateScroll();
    // preventScroll mantém o ponto de leitura: o foco não arrasta a página
    // até o rodapé na rolagem única (VG-LAY-12).
    var b = $('#lang-btn');
    if (b) b.focus({ preventScroll: true });
  }
  /* Idioma em vigor (VG-IDI-02/03): o automático fica marcado quando está em
     vigor e, como ele resolve para o idioma atual, esse idioma também aparece
     marcado — a tela mostra a escolha e o resultado ao mesmo tempo. Escolher
     um idioma manual desmarca o automático. Os marcados saem do clique e da
     ordem do Tab; os demais voltam a responder. */
  function markLanguage() {
    $$('.lang-list .lang-item[data-lang]').forEach(function (item) {
      if (item.disabled) return;
      var code = item.getAttribute('data-lang');
      var current = code === 'auto' ? state.langAuto : code === state.lang;
      item.setAttribute('aria-pressed', current ? 'true' : 'false');
      if (current) item.setAttribute('tabindex', '-1');
      else item.removeAttribute('tabindex');
    });
  }
  /* A escolha aplica a marca (VG-IDI-02/03) e fecha a tela, devolvendo à
     origem (VG-IDI-05). O automático resolve para o idioma do navegador. */
  function selectLanguage(button) {
    if (!button || button.disabled) return;
    var code = button.getAttribute('data-lang');
    if (code === 'auto') {
      state.langAuto = true;
      state.lang = browserLang();
    } else {
      state.langAuto = false;
      state.lang = code;
    }
    applyLanguage();
    closeLanguage();
  }

  /* Título do documento, descrição, compartilhamento e o botão do rodapé
     acompanham o idioma e a tela (VG-MET-02, VG-MET-04). */
  var META_TITLE = 'Monitor BTC — carteira watch-only';
  var META_DESCRIPTION = 'Monitor BTC — a chave pública da sua carteira como credencial, saldo e endereços derivados na hora, e envio de BTC em PSBT sem assinatura. Nada é guardado: nem a chave, nem os endereços. Sem chave privada.';
  var META_IMAGE_ALT = 'Card escuro do Monitor BTC, com o ícone do Monitor BTC, o título e o idioma português.';
  function setMeta(selector, attr, key) {
    var el = $(selector);
    if (el) el.setAttribute(attr, t(key));
  }
  function syncMeta() {
    var head = state.langOpen ? $('#head-language') : $('#screen-' + state.screen + ' h2');
    var name = head ? head.textContent.trim().toLocaleLowerCase(LOCALE_TAGS[state.lang] || 'pt-BR') : '';
    document.title = name ? 'Monitor BTC - ' + name : 'Monitor BTC';
    setMeta('meta[name="description"]', 'content', META_DESCRIPTION);
    setMeta('meta[property="og:title"]', 'content', META_TITLE);
    setMeta('meta[property="og:description"]', 'content', META_DESCRIPTION);
    setMeta('meta[name="twitter:title"]', 'content', META_TITLE);
    setMeta('meta[name="twitter:description"]', 'content', META_DESCRIPTION);
    setMeta('meta[property="og:image:alt"]', 'content', META_IMAGE_ALT);
    setMeta('meta[name="twitter:image:alt"]', 'content', META_IMAGE_ALT);
    var locale = $('meta[property="og:locale"]');
    if (locale) locale.setAttribute('content', LOCALE_META[state.lang] || 'pt_BR');
  }
  function syncLangButton() {
    var button = $('#lang-btn');
    if (!button) return;
    var code = LOCALE_CODES[state.lang] || 'PT';
    button.textContent = code;
    button.setAttribute('aria-label', t('Idioma') + ': ' + code);
  }
  function updateThemeButton() {
    var b = $('#theme-toggle');
    if (!b) return;
    var light = document.documentElement.dataset.theme === 'light';
    b.innerHTML = '<span class="glyph">' +
      (light ? '●' : '<span class="glyph-ring">○</span>') + '</span>';
    b.setAttribute('aria-label', t(light ? 'Ativar tema escuro' : 'Ativar tema claro'));
  }
  /* Troca de idioma (VG-IDI-02): relê a origem portuguesa de cada texto
     estático e redesenha o que veio do servidor ou de um recado, sem recarregar
     a tela nem perder o estado. */
  function applyLanguage() {
    document.documentElement.lang = LOCALE_TAGS[state.lang] || 'pt-BR';
    applyI18n();
    syncMeta();
    syncLangButton();
    updateThemeButton();
    paintStatuses();
    /* sem dados, o resumo do histórico é texto de estado (idle, carregando ou
       erro): volta ao idioma novo em vez de ficar com o texto de origem. */
    if (!state.data) syncHistoryState();
    if (state.data && !state.scanning) {
      /* só o texto do retrato, sem repetir o pedido de máximo nem mexer no
         PSBT que já está na tela */
      renderBalance(state.data);
      renderHistoryTotals(state.data);
      syncHistoryState();
      renderHistory();
    }
    if (state.psbt) renderSendMeta(state.psbt);
    if (state.broadcast) renderBroadcast(state.broadcast);
    renderFees();
    updateSendAvailability();
    updateBroadcastActions();
    markLanguage();
    updateScroll();
  }
  function fillFrames() {
    $$('.edge').forEach(function (el) {
      el.innerHTML = '<span>+</span><span class="fill">' + '-'.repeat(240) + '</span><span>+</span>';
    });
    $$('.rule:not(.rule-dots)').forEach(function (el) {
      el.textContent = '='.repeat(240);
    });
  }
  // O ícone da aba é a letra B sozinha, sem fundo, no --accent do tema em
  // vigor: o desenho sai do mesmo #favicon-marca do href estático, em
  // currentColor, e o tom sai do token — o favicon não é uma segunda cópia do
  // desenho nem um hex repetido. O arquivo estático do <link> só conhece o
  // tema do sistema; aqui ele é reescrito no arranque e a cada troca de tema.
  function syncFavicon() {
    var link = document.getElementById('favicon');
    var symbol = document.getElementById('favicon-marca');
    if (!link || !symbol) return;
    var accent = getComputedStyle(document.documentElement)
      .getPropertyValue('--accent').trim();
    if (!accent) return;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' +
      symbol.getAttribute('viewBox') + '" color="' + accent + '">' +
      symbol.innerHTML + '</svg>';
    link.setAttribute('href', 'data:image/svg+xml,' + encodeURIComponent(svg));
  }
  function themeFromUrl() {
    var t = new URLSearchParams(location.search).get('theme');
    return t === 'light' || t === 'dark' ? t : '';
  }
  var themeSwapTimer = 0;
  var themeMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  var themeAuto = true;
  function systemTheme() {
    return themeMedia && themeMedia.matches ? 'light' : 'dark';
  }
  function setTheme(theme, opts) {
    var t = theme === 'light' ? 'light' : 'dark';
    var root = document.documentElement;
    var changed = root.dataset.theme !== t;
    /* Crossfade de tema (VG-EFE-07): a classe theme-fx existe só durante
       --motion-theme e faz fundo, card, moldura, texto e controles passarem
       juntos; o grão acompanha pelo filtro de brilho, no compositor. Com
       menos movimento, a troca é direta. */
    var animate = changed && !(opts && opts.immediate) && !prefersReducedMotion();
    /* O `color-scheme` nativo precisa ser trocado num recálculo separado,
       antes do crossfade: trocado no mesmo quadro que as cores, ele reinicia
       a transição de `color` de cada elemento e o texto termina de mudar
       depois do fundo — a piscada do conteúdo no meio da troca. A leitura de
       layout força o recálculo antes de a classe theme-fx entrar. */
    if (root.style.colorScheme !== t) {
      root.style.colorScheme = t;
      if (animate) void root.offsetWidth;
    }
    if (animate) {
      root.classList.add('theme-fx');
      if (themeSwapTimer) clearTimeout(themeSwapTimer);
      themeSwapTimer = setTimeout(function () {
        themeSwapTimer = 0;
        root.classList.remove('theme-fx');
      }, motionMs('--motion-theme', 150) + 50);
    }
    root.dataset.theme = t;
    updateThemeButton();
    var meta = document.querySelector('meta[name="theme-color"]');
    var bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (meta && bg) meta.setAttribute('content', bg);
    syncFavicon();
    syncGrainTheme();
  }
  if (themeMedia) {
    var onSystemTheme = function () {
      if (themeAuto) setTheme(systemTheme());
    };
    if (themeMedia.addEventListener) themeMedia.addEventListener('change', onSystemTheme);
    else if (themeMedia.addListener) themeMedia.addListener(onSystemTheme);
  }
  /* Foca agora se o controle já aceita foco; se a visibilidade ainda está
     no fim da transição, tenta de novo depois dela. Só insiste se o foco
     continuar no controle antigo ou no body, para não roubar um Tab do
     leitor nesse intervalo. */
  function focusWhenReady(el, previous) {
    if (!el) return false;
    el.focus();
    if (document.activeElement === el) return true;
    setTimeout(function () {
      if (document.activeElement === previous || document.activeElement === document.body ||
          document.activeElement === document.documentElement) {
        el.focus();
      }
    }, motionMs('--motion-fast', 150) + 30);
    return true;
  }
  /* Passagem de foco do rodapé (VG-ACR-09): o ▼ e o paginador ocupam o mesmo
     lugar. Quando o controle que tem o foco sai de cena, o foco vai para o
     que assumiu o lugar; sem nenhum dos dois, volta ao título da tela. */
  function handOffBottomFocus() {
    var down = $('.scroll-arrow-down');
    var pager = $('#history-pager');
    var content = $('#content');
    var active = document.activeElement;
    var inDown = !!down && down.contains(active);
    var inPager = !!pager && pager.contains(active);
    if (!inDown && !inPager) return;
    var downTarget = !!content && content.classList.contains('can-scroll-down') &&
      !content.classList.contains('show-pager');
    var pagerTarget = !!pager && !pager.hidden && !!content &&
      content.classList.contains('show-pager');
    var heading = document.querySelector('.screen:not([hidden]) h2');
    if (inDown && !downTarget) {
      if (pagerTarget) {
        var next = $('#history-next');
        var prev = $('#history-prev');
        var target = next && next.getAttribute('aria-disabled') !== 'true' ? next : prev;
        focusWhenReady(target, active);
      } else if (heading) heading.focus();
    } else if (inPager && !pagerTarget) {
      if (downTarget) focusWhenReady(down, active);
      else if (heading) heading.focus();
    }
  }
  function updateScroll() {
    var el = $('#content-scroll');
    var c = $('#content');
    if (!el || !c) return;
    var max = el.scrollHeight - el.clientHeight;
    // Durante a entrada em foco os blocos ficam REVEAL_RISE abaixo e isso entra
    // no scrollHeight; descontar o deslocamento evita acender a seta de baixo
    // numa tela que cabe inteira. O paginador usa a mesma medida: com o
    // deslocamento da animação ele entenderia que ainda há conteúdo para rolar
    // e sumiria até o fim da entrada em foco, um segundo depois da troca de
    // página.
    var scrollable = max - revealLift;
    c.classList.toggle('can-scroll-up', max > 2 && el.scrollTop > 2);
    c.classList.toggle('can-scroll-down', scrollable > 2 && el.scrollTop < scrollable - 2);
    updatePager(scrollable);
    handOffBottomFocus();
  }

  /* Altura do conteúdo fora do gesto de rolagem: a taxa, o PSBT e os demais
     blocos entram e saem conforme o formulário, e isso não dispara 'scroll'.
     Sem reavaliar, o degradê e a seta de baixo continuam anunciando uma
     rolagem que já não existe. O observador cobre o que está dentro do
     .content-scroll (blocos que aparecem ou somem, texto que muda de tamanho)
     e reavalia uma vez por quadro. */
  function watchContentHeight() {
    var el = $('#content-scroll');
    if (!el || typeof MutationObserver !== 'function') return;
    var frame = 0;
    var schedule = function () {
      if (frame) return;
      frame = requestAnimationFrame(function () {
        frame = 0;
        updateScroll();
      });
    };
    new MutationObserver(schedule).observe(el, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['hidden', 'class', 'style']
    });
  }

  /* Altura real da janela (VG-LAY-12): o Chrome do Android pode publicar
     100dvh maior que a área visível logo depois de recarregar, contando a
     barra do navegador; o card passa da tela e o rodapé só aparece quando a
     página rola. window.innerHeight já desconta essa barra, então a medida
     vai para --app-h e o CSS a usa no lugar da unidade de viewport. Reavaliar
     em resize/orientação cobre a barra que aparece e some; o visualViewport
     cobre o WebKit do iOS, que muda a área visível sem disparar resize. */
  function syncViewportHeight() {
    var h = window.innerHeight;
    if (h > 0) document.documentElement.style.setProperty('--app-h', h + 'px');
  }

  /* Reavalia a altura medida em toda mudança de viewport que não passa pelo
     resize da janela: a barra do iOS, a volta do bfcache, a retomada do PWA.
     O quadro único evita medir e reflowar mais de uma vez por mudança. */
  var viewportFrame = 0;
  function syncViewportSoon() {
    if (viewportFrame) return;
    viewportFrame = requestAnimationFrame(function () {
      viewportFrame = 0;
      syncViewportHeight();
      syncPageMode();
      relayoutHistory();
    });
  }

  /* Rolagem única (VG-LAY-12): quando a janela fica abaixo do piso do card
     mais os respiros, a página é a única a rolar e o card cresce. O piso e os
     respiros são lidos já em px, e a altura vem do .vh-probe, que mede o
     mesmo --app-h do card. */
  function syncPageMode() {
    var probe = $('.vh-probe');
    var win = $('.window');
    var page = $('.page');
    if (!probe || !win || !page) return;
    var vh = probe.getBoundingClientRect().height;
    var pageStyle = getComputedStyle(page);
    var pad = parseFloat(pageStyle.paddingTop) + parseFloat(pageStyle.paddingBottom);
    var floor = parseFloat(getComputedStyle(win).minHeight) || 0;
    page.classList.toggle('is-page-scroll', vh > 0 && (vh - pad) < floor);
    updateScroll();
  }

  /* Barras de altura igual (VG-LAY-05): menu e rodapé recebem a mesma altura
     mínima, então o menu que quebra em duas linhas no celular não deixa o
     rodapé menor. */
  function syncBars() {
    var menu = $('.menu');
    var status = $('.status');
    if (!menu || !status) return;
    menu.style.minHeight = '';
    status.style.minHeight = '';
    var h = Math.max(
      menu.getBoundingClientRect().height,
      status.getBoundingClientRect().height
    );
    if (!h) return;
    menu.style.minHeight = h + 'px';
    status.style.minHeight = h + 'px';
  }

  /* Estados da lista (VG-LST-04/05, VG-ABS-10): vazio, carregando e erro de
     dados ocupam a mesma área, sem deixar o histórico em branco nem reusar a
     lista vazia, que é um estado válido. */
  function historySkeleton() {
    var box = $('#history-skeleton');
    if (!box || box.childElementCount) return;
    var html = '';
    var count = historyPerPage > 0 ? historyPerPage : PER_PAGE_FALLBACK;
    for (var i = 0; i < count; i++) {
      if (i) html += '<div class="rule rule-dots" aria-hidden="true"></div>';
      html += '<div class="item-skeleton">' +
        '<span class="item-skeleton-line is-title"></span>' +
        '<span class="item-skeleton-line is-long"></span>' +
        '<span class="item-skeleton-line is-mid"></span>' +
        '<span class="item-skeleton-line is-tags"></span>' +
        '</div>';
    }
    box.innerHTML = html;
  }
  function syncHistoryState() {
    var region = $('#history-region');
    var loading = $('#history-loading');
    var skel = $('#history-skeleton');
    var err = $('#history-error');
    var list = $('#history-list');
    var empty = $('#addresses-empty');
    var ready = state.historyState === 'ready';
    var rows = historyRows();
    if (region) {
      if (state.historyState === 'loading') region.setAttribute('aria-busy', 'true');
      else region.removeAttribute('aria-busy');
    }
    if (loading) loading.hidden = state.historyState !== 'loading';
    if (skel) {
      skel.hidden = state.historyState !== 'loading';
      if (state.historyState === 'loading') historySkeleton();
    }
    if (err) err.hidden = state.historyState !== 'error';
    var summary = $('#history-summary');
    if (summary) {
      /* sem endereço usado a lista mostra o estado vazio; o resumo de
         endereços, recebido e enviado não tem o que dizer e sai de cena. */
      summary.hidden = ready && rows.length === 0;
      if (state.historyState === 'loading') {
        summary.textContent = '';
      } else if (state.historyState === 'error') {
        summary.textContent = '';
      } else if (state.historyState === 'idle') {
        summary.textContent = t('cole a xpub, zpub ou ypub na carteira para ver o histórico.');
      }
    }
    if (list) list.hidden = !(ready && rows.length > 0);
    if (empty) empty.hidden = !(ready && rows.length === 0);
    updateScroll();
  }

  /* --------------------------------------------------------------- grão */
  /* Grão de fundo (VG-FND-05 / VG-EFE-01): células de 14 px, glifos de
     13 px, seis caracteres e exatamente 50% das células ocupadas. A tinta
     não é --line: a cobertura média dos glifos e o alpha do --panel sobre o
     --bg geram um tom cujo glifo renderizado cai no tom do card. A textura é
     desenhada com a tinta do tema claro; o escuro é o mesmo desenho escurecido
     por um filtro de brilho, animado pelo compositor junto com as cores. */
  var GRAIN_GLYPHS = ['.', ':', '-', '=', '+', '*'];
  var grain = {
    canvas: null, ctx: null, font: '', ink: '',
    ratio: 1, cols: 0, rows: 0, cell: 14, occ: null, map: null,
    timer: 0
  };

  function colorParts(value) {
    var s = String(value || '').trim();
    var hex = s.match(/^#([0-9a-f]{3,8})$/i);
    if (hex) {
      var h = hex[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      var a = 1;
      if (h.length === 8) { a = parseInt(h.slice(6, 8), 16) / 255; h = h.slice(0, 6); }
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: a
      };
    }
    var parts = s.match(/[\d.]+/g);
    if (!parts || parts.length < 3) return null;
    var unit = /^color\(/i.test(s) ? 255 : 1;
    return {
      r: parseFloat(parts[0]) * unit,
      g: parseFloat(parts[1]) * unit,
      b: parseFloat(parts[2]) * unit,
      a: parts.length > 3 ? parseFloat(parts[3]) : 1
    };
  }
  /* Cobertura média dos glifos, medida no canvas com a mesma fonte e DPR. */
  function grainCoverage(font, dpr) {
    var probe = document.createElement('canvas');
    probe.width = Math.ceil(GRAIN_GLYPHS.length * 16 * dpr);
    probe.height = Math.ceil(20 * dpr);
    var ctx = probe.getContext('2d');
    if (!ctx) return 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = font;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#fff';
    for (var i = 0; i < GRAIN_GLYPHS.length; i++) ctx.fillText(GRAIN_GLYPHS[i], i * 16, 0);
    var data = ctx.getImageData(0, 0, probe.width, probe.height).data;
    var sum = 0, count = 0;
    for (var p = 3; p < data.length; p += 4) {
      var a = data[p] / 255;
      if (a <= 0) continue;
      sum += a;
      count++;
    }
    return count ? Math.min(1, sum / count) : 1;
  }
  function grainInkFor(panel, bg, coverage) {
    var alpha = panel.a;
    function ink(card, base) {
      return Math.max(0, Math.min(255, Math.round(base + (card - base) / coverage)));
    }
    return {
      r: ink(panel.r * alpha + bg.r * (1 - alpha), bg.r),
      g: ink(panel.g * alpha + bg.g * (1 - alpha), bg.g),
      b: ink(panel.b * alpha + bg.b * (1 - alpha), bg.b)
    };
  }
  /* Lê os tokens de um tema num elemento isolado, sem pintar nada na tela. */
  function themeColorTokens(theme) {
    var probe = document.createElement('div');
    probe.setAttribute('data-theme', theme);
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);
    var cs = getComputedStyle(probe);
    var tokens = {
      panel: colorParts(cs.getPropertyValue('--panel')),
      bg: colorParts(cs.getPropertyValue('--bg'))
    };
    probe.remove();
    return tokens;
  }
  function grainLuma(c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }

  function resizeGrain() {
    var canvas = grain.canvas;
    if (!canvas) return;
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    grain.ctx = ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = grain.font;
    ctx.textBaseline = 'top';
    ctx.fillStyle = grain.ink;
    var cell = grain.cell;
    var cols = Math.ceil(w / cell);
    var rows = Math.ceil(h / cell);
    var total = cols * rows;
    var occ = new Uint8Array(total);
    var order = new Int32Array(total);
    for (var i = 0; i < total; i++) order[i] = i;
    for (var j = total - 1; j > 0; j--) {
      var k = (Math.random() * (j + 1)) | 0;
      var t = order[j];
      order[j] = order[k];
      order[k] = t;
    }
    for (var n = 0; n < Math.floor(total / 2); n++) occ[order[n]] = 1;
    var map = new Array(total);
    for (var q = 0; q < total; q++) map[q] = (Math.random() * GRAIN_GLYPHS.length) | 0;
    grain.cols = cols;
    grain.rows = rows;
    grain.occ = occ;
    grain.map = map;
    ctx.clearRect(0, 0, w, h);
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var idx = r * cols + c;
        if (occ[idx]) ctx.fillText(GRAIN_GLYPHS[map[idx]], c * cell, r * cell);
      }
    }
  }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = (Math.random() * (i + 1)) | 0;
      var t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
  }
  /* A cada --motion-grain, 0,35% dos glifos (mínimo 4) sai de uma célula
     ocupada e ocupa uma vazia: o total de células ocupadas não muda. */
  function tickGrain() {
    if (!grain.ctx || document.hidden) return;
    var occ = grain.occ;
    var cell = grain.cell;
    var ctx = grain.ctx;
    var cols = grain.cols;
    var total = cols * grain.rows;
    var n = Math.max(4, Math.round(total * 0.0035));
    n = Math.min(n, Math.floor(total / 2));
    var occupied = [];
    var empty = [];
    for (var i = 0; i < total; i++) (occ[i] ? occupied : empty).push(i);
    if (occupied.length < n || empty.length < n) return;
    shuffle(occupied);
    shuffle(empty);
    for (var k = 0; k < n; k++) {
      var from = occupied[k];
      var to = empty[k];
      occ[from] = 0;
      occ[to] = 1;
      ctx.clearRect((from % cols) * cell, ((from / cols) | 0) * cell, cell, cell);
      grain.map[to] = (Math.random() * GRAIN_GLYPHS.length) | 0;
      ctx.fillText(GRAIN_GLYPHS[grain.map[to]], (to % cols) * cell, ((to / cols) | 0) * cell);
    }
  }
  function startGrain() {
    if (!grain.ctx || grain.timer) return;
    grain.timer = setInterval(tickGrain, motionMs('--motion-grain', 75));
  }
  function stopGrain() {
    if (!grain.timer) return;
    clearInterval(grain.timer);
    grain.timer = 0;
  }
  /* O filtro do tema é o único ajuste do grão que anima (VG-EFE-07). No
     arranque, porém, ele precisa entrar sem transição e antes do primeiro
     desenho: senão a tinta clara aparece por um quadro e escurece animando,
     que é a piscada branca/preto na abertura. */
  function syncGrainTheme(immediate) {
    if (!grain.canvas) return;
    var light = document.documentElement.dataset.theme === 'light';
    var value = light ? 'brightness(1)' : 'brightness(' + grain.ratio.toFixed(4) + ')';
    var canvas = grain.canvas;
    if (!immediate) {
      canvas.style.filter = value;
      return;
    }
    canvas.style.transition = 'none';
    canvas.style.filter = value;
    // aplica o valor antes de religar a transição, para o primeiro quadro já
    // sair na tinta do tema
    void canvas.offsetWidth;
    canvas.style.transition = '';
  }
  function initGrain() {
    var canvas = $('#grain');
    if (!canvas || grain.canvas) return;
    if (window.matchMedia('(forced-colors: active)').matches) return;
    var mono = getComputedStyle(document.documentElement)
      .getPropertyValue('--mono').replace(/\s+/g, ' ').trim() || 'monospace';
    var font = '13px ' + mono;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var coverage = grainCoverage(font, dpr);
    var light = themeColorTokens('light');
    var dark = themeColorTokens('dark');
    if (!light.panel || !light.bg || !dark.panel || !dark.bg) return;
    var lightInk = grainInkFor(light.panel, light.bg, coverage);
    var darkInk = grainInkFor(dark.panel, dark.bg, coverage);
    var lightLuma = grainLuma(lightInk);
    var darkLuma = grainLuma(darkInk);
    grain.ratio = lightLuma > 0 ? Math.max(0.05, Math.min(5, darkLuma / lightLuma)) : 1;
    grain.font = font;
    grain.ink = 'rgb(' + [lightInk.r, lightInk.g, lightInk.b].join(', ') + ')';
    grain.canvas = canvas;
    syncGrainTheme(true);
    resizeGrain();
    if (!prefersReducedMotion()) startGrain();
  }

  /* Um endereço de recebimento por tipo — sempre o primeiro índice sem uso
     daquele ramo (`último usado + 1`) —, inclusive os tipos sem saldo, para
     o usuário escolher o que o pagador aceita. O rótulo é o tipo da conta e
     o botão de copiar fica ao lado do endereço. */
  function renderReceive(d) {
    var body = $('#receive-table tbody');
    if (!body) return;
    body.innerHTML = '';
    var types = d.types || [];
    types.forEach(function (item) {
      var tr = document.createElement('tr');
      var addr = item.address || '';
      var rawLabel = item.type || item.label || '';
      var label = PT_KEYS[rawLabel] ? t(rawLabel) : rawLabel;
      tr.innerHTML = '<th scope="row">' + esc(label) + '</th>' +
        '<td><span class="receive-line"><code>' + esc(addr || '—') + '</code>' +
        (addr ? '<button type="button" class="key-action" data-copy="' + esc(addr) +
          '" aria-label="' + esc(t('copiar endereço {label}', { label: label })) + '">' +
          esc(t('copiar')) + '</button>' : '') +
        '</span></td>';
      body.appendChild(tr);
    });
    $('#receive-table').hidden = types.length === 0;
    $('#receive-heading').hidden = types.length === 0;
  }

  /* ---------------------------------------------------------- enviar */
  /* Não há escolha de taxa: um número só, o `estimatefee(2)` do Bitcoin
     Core (ver ESTIMATE_TARGETS em src/electrum.js). O valor vem do
     /api/fees e o percentual sobre o valor enviado, do preview do valor e do
     destino digitados. */
  var FEE_MAX = 10000;

  /* A taxa vem do servidor em sat/vB e PODE ter casas (0,12; 1,075; 1,926):
     o valor exato é sat/kvB. */
  function feeRateNow() {
    var levels = (state.fees && state.fees.levels) || {};
    return Number(levels.next) || 0;
  }

  /* O que não pode é faltar, ser zero ou passar do teto — a faixa fina
     (mínimo representável, teto de 10 000) é conferida no servidor, em
     psbt.js. Comparar com inteiro aqui deixaria a tela sem preview e o botão
     bloqueado sempre que a estimativa não fosse redonda. */
  function feeRateOk(rate) {
    var n = Number(rate);
    return isFinite(n) && n >= 0.001 && n <= FEE_MAX;
  }

  /* Valor em BTC com máscara de 8 casas: o usuário digita só dígitos e o
     ponto entra sozinho, da direita para a esquerda (1 → 0.00000001). O
     valor guardado é o inteiro de satoshis, sem zeros à esquerda, então o
     backspace remove o último dígito de verdade. */
  var AMOUNT_DIGITS_MAX = 15;
  var DUST_SATS = 546;

  function amountSats() {
    return state.amountDigits ? Number(BigInt(state.amountDigits)) : 0;
  }

  function amountDisplay(digits) {
    if (!digits) return '';
    var padded = String(digits).padStart(9, '0');
    return padded.slice(0, -8) + '.' + padded.slice(-8);
  }

  function renderAmountInput() {
    var input = $('#send-amount');
    if (input) input.value = amountDisplay(state.amountDigits);
    updateSendAvailability();
  }

  function setAmountDigits(digits) {
    var clean = String(digits == null ? '' : digits).replace(/\D/g, '');
    clean = clean.replace(/^0+(?=\d)/, '');
    /* Colagem acima do teto é recusada, não truncada: cortar em silêncio
       mudaria o valor sem o usuário ver. O campo volta ao valor anterior. */
    if (clean.length > AMOUNT_DIGITS_MAX) {
      state.amountError = msg('valor grande demais: máximo de {n} dígitos.', { n: AMOUNT_DIGITS_MAX });
      renderAmountInput();
      return;
    }
    state.amountError = null;
    state.amountDigits = clean;
    renderAmountInput();
    scheduleLimits(true);
  }

  function syncAmountFromValue() {
    var input = $('#send-amount');
    if (!input) return;
    var v = input.value.trim();
    if (!v) { setAmountDigits(''); return; }
    var sats = null;
    if (/[.,]/.test(v)) sats = parseBtcSats(v);
    else {
      var d = v.replace(/\D/g, '');
      sats = d ? Number(BigInt(d)) : 0;
    }
    if (sats == null) { renderAmountInput(); return; }
    setAmountDigits(String(sats));
  }

  function addressLooksValid(address) {
    var s = String(address || '').trim();
    if (/^bc1[02-9ac-hj-np-z]{11,87}$/i.test(s)) return true;
    return /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(s);
  }

  function updateSendAvailability() {
    var amount = amountSats();
    var addressInput = $('#send-address');
    var amountInput = $('#send-amount');
    var address = addressInput ? addressInput.value.trim() : '';
    var rate = feeRateNow();
    var hint = $('#send-amount-hint');
    var max = state.limits ? Number(state.limits.max_send_sats) || 0 : 0;
    var amountProblem = state.amountError || null;
    var addressProblem = null;
    var hintSpec = null;

    if (address && !addressLooksValid(address)) {
      addressProblem = msg('destino inválido: use um endereço bc1…, 1… ou 3….');
    } else if (address && state.addressError && state.addressError.address === address) {
      /* o regex deixa passar endereço com checksum errado: quem recusa é o
         servidor, e a recusa é erro do campo, não nota do máximo */
      addressProblem = state.addressError.text;
    }
    if (state.amountError) {
      /* o recado já está em amountProblem */
    } else if (amount > 0 && amount < DUST_SATS) {
      amountProblem = msg('valor abaixo do mínimo: {value}', { value: fmtBtc(DUST_SATS) });
    } else if (state.feesError && !feeRateOk(rate) && (amount > 0 || address)) {
      hintSpec = state.feesError;
    } else if (state.limits) {
      hintSpec = msg('máximo {value}', { value: fmtBtc(max) });
      if (amount > 0 && max < DUST_SATS) {
        amountProblem = msg('saldo insuficiente para enviar com essa taxa.');
      } else if (amount > max) {
        amountProblem = msg('valor acima do máximo enviável: {value}', { value: fmtBtc(max) });
      }
    } else if (state.limitsError) {
      hintSpec = msg('máximo indisponível: {text}', { text: specText(state.limitsError) });
    } else if (amount > 0 && !addressProblem && addressLooksValid(address)) {
      hintSpec = msg('calculando a taxa…');
    }

    /* O erro fica no recado geral (VG-FRM-07), não sob o campo: o hint
       continua só com o dado neutro, e o campo recebe o fio e o aria-invalid.
       Destino inválido também tira o PSBT da tela: o retrato é do pedido que
       o gerou, e não há o que baixar com um destino que o servidor recusa. */
    if (addressProblem && state.psbt) dropPsbt();
    setFieldInvalid(addressInput, !!addressProblem);
    setFieldInvalid(amountInput, !!amountProblem);
    if (addressInput) addressInput.setAttribute('aria-describedby', 'send-status');
    if (amountInput) {
      amountInput.setAttribute('aria-describedby', amountProblem ? 'send-status' : 'send-amount-hint');
    }
    if (hint) hint.textContent = specText(hintSpec);
    setSendValidation(addressProblem || amountProblem);

    if (!feeRateOk(rate) && state.feesError && state.xpub) {
      /* taxa não veio: uma reconsulta sob demanda tira a tela do
         "calculando a taxa…" sem depender do ciclo de 60 s */
      if (!state.feesRetryTimer) {
        state.feesRetryTimer = setTimeout(function () {
          state.feesRetryTimer = 0;
          loadFees();
        }, 5000);
      }
    } else if (state.feesRetryTimer) {
      clearTimeout(state.feesRetryTimer);
      state.feesRetryTimer = 0;
    }
    syncDownloadButton();
    updateFeeVisibility(addressProblem);
    /* o custo de cada nível depende do valor, do destino e do preview que
       acabou de mudar; é o único lugar em que todos os três se encontram */
    renderFeeLine();
    /* formulário completo: o PSBT se monta sozinho, com o respiro da
       digitação (é aqui que destino, valor, taxa e máximo se encontram) */
    schedulePsbt();
  }

  /* A seção de taxa só aparece quando há valor e destino válidos: é quando
     o preview consegue cotar a taxa em BTC. Sem os dois, não haveria custo
     para mostrar; destino recusado também esconde o grupo. */
  function updateFeeVisibility(addressProblem) {
    var section = $('#fee-section');
    if (!section) return;
    var amount = amountSats();
    var address = $('#send-address') ? $('#send-address').value.trim() : '';
    section.hidden = !!addressProblem || !(amount > 0 && addressLooksValid(address));
  }

  /* O máximo depende do destino (tamanho do script) e da taxa. A conta roda
     no navegador com as transações cruas; o resultado vira o limite que
     bloqueia o botão antes de qualquer tentativa. */
  /* `keep` mantém o limite já carregado enquanto só o valor mudou: o máximo
     continua bloqueando o botão e a legenda troca para "calculando a taxa…". */
  function scheduleLimits(keep) {
    if (state.limitsTimer) clearTimeout(state.limitsTimer);
    state.limitsTimer = 0;
    state.limitsSeq++;
    if (!keep) {
      state.limits = null;
      state.limitsError = null;
    }
    updateSendAvailability();
    var address = $('#send-address') ? $('#send-address').value.trim() : '';
    var rate = feeRateNow();
    var amount = amountSats();
    if (!state.xpub || !addressLooksValid(address) || !feeRateOk(rate)) return;
    if (keep && !amount) return;
    state.limitsTimer = setTimeout(function () {
      state.limitsTimer = 0;
      loadLimits(address, rate, amount);
    }, 350);
  }

  async function loadLimits(address, rate, amount) {
    var seq = ++state.limitsSeq;
    var xpub = state.xpub;
    try {
      if (!state.scanner) throw fail('carteira não carregada');
      var j = state.scanner.limits({
        address: address,
        feeRate: rate,
        amountSats: amount > 0 ? amount : null,
        quoteRates: [rate]
      });
      if (seq !== state.limitsSeq || state.xpub !== xpub) return;
      if (!Number.isInteger(j.max_send_sats)) throw fail('resposta sem limite de envio');
      state.limits = j;
      state.limitsError = null;
      state.addressError = null; // destino aceito
      /* as cotas dos níveis dependem só do valor e do destino: guardadas à
         parte, as opções não piscam para `—` quando só a taxa muda */
      if (Array.isArray(j.quotes)) {
        var byRate = {};
        j.quotes.forEach(function (q) { byRate[q.fee_rate] = q.fee_sats; });
        state.feeQuotes = { amount: j.amount_sats, address: j.recipient, byRate: byRate };
      }
    } catch (e) {
      if (seq !== state.limitsSeq) return;
      state.limits = null;
      state.feeQuotes = null; // sem conta local fechada, as opções ficam em —
      var message = e && e.message ? e.message : String(e);
      /* Destino recusado na validação do servidor (checksum, rede, tipo) é
         erro de campo: vai para o recado, com o fio no campo, e não para a
         nota do máximo, que continua só com o dado neutro. */
      var rejected = /^endereço de destino:\s*(.+)$/.exec(message);
      if (rejected) {
        var detail = rejected[1].replace(/\.$/, '');
        state.addressError = {
          address: address,
          text: msg('destino inválido: {text}.', {
            text: serverSpec(detail) || rawMsg(detail)
          })
        };
        state.limitsError = null;
      } else {
        state.addressError = null;
        state.limitsError = errSpec(e);
      }
    }
    updateSendAvailability();
  }

  /* Não há opção para desenhar: a seção só precisa refletir a taxa única do
     momento — a linha de custo e o aviso de piso de relay. */
  function renderFees() {
    renderFeeLine();
    renderFeeNote();
  }

  /* Aviso do piso de relay: `/api/fees` marca em `floored.next` a taxa que
     está abaixo do piso padrão do Bitcoin Core (`relay_min_kvb`, 0,1 sat/vB
     desde a v30). A taxa continua sendo a estimada — quem decide é o
     servidor —, mas o recado é o que faltava: abaixo do piso a transação
     pode não ser aceita pelos nós, e o pior caso é propagar para alguns e
     ficar parada indefinidamente. */
  function renderFeeNote() {
    var note = $('#fee-note');
    if (!note) return;
    var fees = state.fees || {};
    var rate = feeRateNow();
    if (!(fees.floored || {}).next || !(rate > 0)) {
      note.textContent = '';
      return;
    }
    var relay = Number(fees.relay_min_kvb);
    var relayText = relay > 0 ? dec(relay / 1000) + ' sat/vB' : t('o piso padrão');
    note.textContent = t('[ atenção ]') + ' ' +
      t('taxa de {rate} sat/vB, abaixo do piso de relay padrão ({relay}): a transação pode ser recusada pelos nós.', {
        rate: dec((rate).toFixed(2)),
        relay: relayText
      });
  }

  /* Custo da taxa única para o valor que está no formulário. Só vale quando
     o preview respondeu para o mesmo valor e o mesmo destino; fora disso a
     linha fica só com a taxa, sem o percentual. */
  function feeQuotes() {
    var cached = state.feeQuotes;
    var amount = amountSats();
    var address = $('#send-address') ? $('#send-address').value.trim() : '';
    if (!cached || !(amount > 0) || cached.amount !== amount ||
      cached.address !== address) return {};
    return cached.byRate;
  }

  function renderFeeLine() {
    var line = $('#fee-line');
    if (!line) return;
    var rate = feeRateNow();
    if (!(rate > 0)) { line.textContent = ''; return; }
    var fee = feeQuotes()[rate];
    var amount = amountSats();
    line.textContent = t('taxa {rate} sat/vB', { rate: dec(rate) }) +
      (fee > 0 && amount > 0 ? ' · ' + dec(fmtPercent(fee, amount)) + '%' : '');
  }

  /* Taxa ao vivo: a rota usa a conexão da sessão quando ela existe e o
     Worker abre uma consulta avulsa quando não existe (dev/testes). */
  async function loadFees() {
    if (!state.xpub) return;
    var xpub = state.xpub;
    var url = '/api/fees' + (state.watchSession ? '?session=' + encodeURIComponent(state.watchSession) : '');
    try {
      var res = await fetchJson(url);
      var r = res.r;
      var j = res.j;
      if (!r.ok || j.error) throw apiFail(r, j);
      if (!j.levels) throw fail('resposta sem níveis de taxa');
      if (state.xpub !== xpub) return;
      var before = feeRateNow();
      state.fees = j;
      state.feesError = feeRateOk(feeRateNow()) ? null : msg('taxa indisponível; tente de novo.');
      renderFees(); // atualiza a linha de custo e o aviso de piso
      /* taxa escolhida mudou: o máximo é recalculado sem manter o antigo.
         Só a taxa mudou: mantém o máximo e refaz a cota. */
      if (!state.limits || feeRateNow() !== before) scheduleLimits();
      else scheduleLimits(true);
    } catch (e) {
      state.feesError = msg('taxa indisponível; tente de novo.');
      renderFees();
      updateSendAvailability();
    }
  }

  function stopFeeTimer() {
    if (state.feeTimer) clearInterval(state.feeTimer);
    state.feeTimer = 0;
    if (state.feesRetryTimer) clearTimeout(state.feesRetryTimer);
    state.feesRetryTimer = 0;
  }

  function startFeeTimer() {
    stopFeeTimer();
    state.feeTimer = setInterval(function () {
      if (!document.hidden) loadFees();
    }, 60000);
  }

  /* Qualquer mudança no formulário vence o pedido em voo: a resposta que
     chegar de um retrato antigo é descartada pela sequência. O retrato já
     desenhado NÃO sai da tela quando só valor ou taxa mudam: o bloco do
     PSBT é alto, e removê-lo a cada tecla encolhia a página e mexia no topo
     e no rodapé. Ele fica visível, marcado como antigo (`psbtStale`, download
     bloqueado), até a resposta do formulário novo o substituir. O destino é a
     exceção: `dropPsbt` tira o retrato, porque o endereço mostrado não pode
     ficar na tela depois de o campo mudar. A montagem agendada não é
     cancelada aqui: quando ela disparar, a chave e o `psbtReady` já são os do
     formulário novo (e fora do intervalo válido ela não monta nada). */
  function invalidatePsbt() {
    state.psbtSeq++;
    state.sendBusy = false;
    if (state.psbtPending) {
      state.psbtPending = false;
      state.psbtPendingKey = '';
      setSendStatus('', null); // a frase de "montando" não sobrevive à edição
    }
    state.psbtKey = '';
    state.psbtFailKey = ''; // edição é o gatilho para tentar de novo
    if (!state.psbt) return;
    state.psbtStale = true;
    var out = $('#send-out');
    if (out) {
      out.removeAttribute('aria-busy');
      out.setAttribute('data-stale', 'true');
    }
    /* A edição pode ter chegado antes de o formulário ficar inválido (o
       `updateSendAvailability` roda antes daqui e ainda via o retrato como
       atual): o download precisa cair já, sem esperar a próxima rodada — que
       pode não vir, porque um valor apagado não monta PSBT nenhum. */
    syncDownloadButton();
  }

  /* O retrato antigo continua na tela, mas não pode ser baixado enquanto o
     formulário já não é o que o gerou (`aria-disabled` é o que o CSS desenha
     como inativo). */
  function syncDownloadButton() {
    var btn = $('#send-download');
    if (!btn) return;
    if (state.psbt && !state.psbtStale) btn.removeAttribute('aria-disabled');
    else btn.setAttribute('aria-disabled', 'true');
  }

  /* O retrato sai da tela quando o destino muda: o PSBT é do pedido que o
     gerou, e o valor/taxa antigos continuam visíveis de propósito. */
  function dropPsbt() {
    invalidatePsbt();
    state.psbt = null;
    state.psbtStale = false;
    var out = $('#send-out');
    if (out) {
      out.hidden = true;
      out.removeAttribute('aria-busy');
      out.removeAttribute('data-stale');
    }
  }

  function resetSend() {
    dropPsbt();
    state.sendBusy = false;
    state.fees = null;
    state.feeQuotes = null;
    state.amountDigits = '';
    state.amountError = null;
    state.limits = null;
    state.limitsError = null;
    state.addressError = null;
    state.limitsSeq++;
    if (state.limitsTimer) clearTimeout(state.limitsTimer);
    state.limitsTimer = 0;
    stopFeeTimer();
    ['#send-address'].forEach(function (sel) {
      var el = $(sel);
      if (el) el.value = '';
    });
    var amount = $('#send-amount');
    if (amount) amount.value = '';
    state.sendValidationError = null;
    setFieldInvalid($('#send-address'), false);
    setFieldInvalid($('#send-amount'), false);
    setSendStatus('', null);
    renderFees();
    renderAmountInput();
  }

  /* Os detalhes do PSBT usam o mesmo desenho de leitura do "receber":
     uma tabela de rótulo e valor. O resumo é o que o SERVIDOR diz ter
     montado: o navegador não lê o base64, então esta tabela é conveniência,
     não prova. O pagamento e o troco aparecem em par — valor e endereço —,
     para comparar com o formulário agora e com a revisão do Cofre BTC
     antes de assinar; uma divergência entre o que foi montado e o que está
     digitado vira aviso (o caso clássico é o coordenador trocar o endereço
     de destino). */
  function renderSendMeta(j) {
    var values = {
      '#send-meta-txid': j.txid,
      '#send-meta-vsize': '~' + fmtInt(j.vsize) + ' vB',
      '#send-meta-rbf': rbfText(j.rbf),
      '#send-meta-scheduled': scheduledText(j.locktime)
    };
    Object.keys(values).forEach(function (sel) {
      var el = $(sel);
      if (el) el.textContent = values[sel];
    });
    /* A marcação de valor do sistema (VG-COR-16) fica só nas linhas de valor,
       com o sinal no texto e a cor reforçando: o que sai leva `-`, o que volta
       leva `+`. Cada valor leva também, depois do separador `|`, a fatia que
       representa do saldo da conta (`sharePct`), em --dim: a mesma base para
       as três linhas, para a tabela ler como um recorte do saldo. A taxa
       sobre o valor enviado é outra pergunta e fica só na linha de taxa.
       A taxa aparece sem o pó, que vem logo abaixo com `-`: a soma das duas é
       o que o PSBT paga (`fee_sats`). */
    var outValue = $('#send-meta-out-value');
    if (outValue) outValue.innerHTML = j.recipient ? signedBtcShare(j.recipient.value, 'out') : '';
    /* O destino externo leva o marcador no próprio endereço, no mesmo tom do
       "[ atenção ]" do Cofre BTC; o destino da própria carteira
       (`recebimento`) e o troco seguem como texto puro. */
    var outAddress = $('#send-meta-out-address');
    if (outAddress) {
      var external = !!j.recipient && (j.outputs || []).some(function (out) {
        return out.address === j.recipient.address && out.own === 'externo';
      });
      outAddress.textContent = j.recipient ? j.recipient.address : '';
      if (external) {
        outAddress.appendChild(document.createTextNode(' '));
        var externalMark = document.createElement('span');
        externalMark.className = 'review-external';
        externalMark.textContent = t('[ externo ]');
        outAddress.appendChild(externalMark);
      }
    }
    var changeValue = $('#send-meta-change-value');
    if (changeValue) changeValue.innerHTML = j.change ? signedBtcShare(j.change.value, 'in') : '';
    var changeAddress = $('#send-meta-change-address');
    if (changeAddress) changeAddress.textContent = j.change ? j.change.address : '';
    [$('#send-meta-change-value-row'), $('#send-meta-change-address-row')]
      .forEach(function (row) { if (row) row.hidden = !j.change; });
    /* O pó é a parte do resto que não virou troco e a transação soma à taxa:
       a linha `taxa` mostra a tarifa sem ele e a linha seguinte o desconta. */
    var dust = Number(j.dust_sats) || 0;
    var fee = $('#send-meta-fee');
    if (fee) fee.innerHTML = signedBtcShare((Number(j.fee_sats) || 0) - dust, 'out');
    var dustRow = $('#send-meta-dust-row');
    if (dustRow) dustRow.hidden = !(dust > 0);
    var dustCell = $('#send-meta-dust');
    if (dustCell) dustCell.innerHTML = dust > 0 ? signedBtcShare(dust, 'out') : '';

    /* Divergência entre o PSBT e o formulário. Não é prova de nada (o
       servidor pode mentir igual nos dois), mas pega troca acidental, bug e
       coordenador que não devolve o que recebeu. */
    var warn = [];
    var typedAddress = $('#send-address') ? $('#send-address').value.trim() : '';
    if (j.recipient && j.recipient.address !== typedAddress) {
      warn.push(t('o destino no psbt difere do campo de destino'));
    }
    if (j.recipient && Number(j.recipient.value) !== amountSats()) {
      warn.push(t('o valor no psbt difere do campo de quantidade'));
    }
    var externos = (j.outputs || []).filter(function (out) { return out.own === 'externo'; });
    if (externos.length > 1) warn.push(t('o psbt tem {n} saídas externas', { n: externos.length }));
    /* Gasto encadeado: a entrada é o troco de uma transação nossa que ainda
       não confirmou. É permitido e é o que evita o saldo zerado, mas a nova
       transação só confirma depois (e junto) da anterior. */
    var pendentes = (j.inputs || []).filter(function (inp) { return inp.pending; });
    if (pendentes.length) {
      warn.push(pendentes.length === 1
        ? t('o psbt gasta troco pendente de uma transação sua; ela confirma depois da anterior')
        : t('o psbt gasta {n} saídas pendentes de transações suas; elas confirmam depois das anteriores', { n: pendentes.length }));
    }
    var warnEl = $('#send-meta-warn');
    if (warnEl) {
      warnEl.textContent = warn.length
        ? t('[ atenção ]') + ' ' + warn.join('; ') + '.'
        : '';
    }
  }

  /* O PSBT é um retrato do formulário: assim que destino, valor e taxa
     formam um pedido válido, ele é montado sozinho e remontado a cada
     mudança. A chave identifica o pedido (destino, valor e taxa) para não
     refazer o mesmo PSBT quando só o máximo ou as cotas foram recalculados;
     a sequência descarta a resposta de um retrato que já não está na tela.
     Fora do intervalo válido nada é montado: o aviso fica na nota do valor. */
  function psbtKey() {
    var address = $('#send-address') ? $('#send-address').value.trim() : '';
    return address + '|' + amountSats() + '|' + feeRateNow();
  }

  function psbtReady() {
    var amount = amountSats();
    var address = $('#send-address') ? $('#send-address').value.trim() : '';
    return amount >= DUST_SATS && addressLooksValid(address) &&
      feeRateOk(feeRateNow()) &&
      !!state.limits && Number(state.limits.max_send_sats) >= DUST_SATS &&
      amount <= Number(state.limits.max_send_sats);
  }

  function schedulePsbt() {
    if (state.psbtTimer) clearTimeout(state.psbtTimer);
    state.psbtTimer = 0;
    if (!psbtReady()) return;
    var key = psbtKey();
    if (state.psbt && state.psbtKey === key) return;
    /* um pedido que já falhou não se repete sozinho: sem esta marca, o
       `updateSendAvailability` do fim da tentativa agendaria outra, e o
       erro do servidor viraria uma consulta a cada 300 ms. A próxima
       edição (ou taxa nova) muda a chave e libera a tentativa. */
    if (state.psbtFailKey && state.psbtFailKey === key) return;
    state.psbtTimer = setTimeout(function () {
      state.psbtTimer = 0;
      buildPsbt();
    }, 300);
  }

  async function buildPsbt() {
    if (!psbtReady()) return;
    var key = psbtKey();
    if (state.psbt && state.psbtKey === key) return;
    if (state.psbtPending && state.psbtPendingKey === key) return;
    var seq = ++state.psbtSeq;
    var amount = amountSats();
    var address = $('#send-address').value.trim();
    var rate = feeRateNow();
    // No primeiro retrato a frase de "montando" ocupa a linha reservada; numa
    // remontagem o retrato anterior fica na tela, então a linha não muda de
    // altura (era ela que empurrava o rodapé a cada mudança).
    var hasOld = !!state.psbt && !!$('#send-out') && !$('#send-out').hidden;
    // o retrato na tela já não é o deste pedido (a taxa pode ter mudado
    // sozinha): ele fica visível, mas sem download até a resposta nova
    if (hasOld && state.psbtKey !== key) {
      state.psbtStale = true;
      $('#send-out').setAttribute('data-stale', 'true');
      syncDownloadButton();
    }
    state.sendBusy = true;
    state.psbtPending = true;
    state.psbtPendingKey = key;
    if (hasOld) $('#send-out').setAttribute('aria-busy', 'true');
    if (!hasOld) setSendStatus('', msg('montando o psbt...'));
    try {
      /* O PSBT nasce no navegador: UTXOs, escolha de moedas, troco e taxa
         são calculados aqui; o servidor só confere a transação assinada no
         fim. */
      if (!state.scanner) throw fail('carteira não carregada');
      var j = await state.scanner.prepare({ address: address, amountSats: amount, feeRate: rate });
      // o formulário mudou enquanto o PSBT era montado: este retrato venceu
      if (seq !== state.psbtSeq || key !== psbtKey()) return;
      state.psbt = j;
      state.psbtKey = key;
      state.psbtStale = false;
      state.psbtFailKey = '';
      renderSendMeta(j);
      var out = $('#send-out');
      out.hidden = false;
      out.removeAttribute('aria-busy');
      out.removeAttribute('data-stale');
      // sem recado de sucesso: o download e os detalhes na tela confirmam
      // (a frase de "montando" não pode ficar parada embaixo do resultado)
      setSendStatus('', null);
      updateScroll();
    } catch (e) {
      if (seq !== state.psbtSeq) return;
      state.psbtFailKey = key;
      setSendStatus('error', errSpec(e));
    } finally {
      if (seq === state.psbtSeq) {
        state.psbtPending = false;
        state.psbtPendingKey = '';
        state.sendBusy = false;
        var panel = $('#send-out');
        if (panel) panel.removeAttribute('aria-busy');
        updateSendAvailability();
      }
    }
  }

  function downloadPsbtText(text, name) {
    if (!text) return;
    var blob = new Blob([text], { type: 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  function downloadPsbt() {
    if (!state.psbt || state.psbtStale) return;
    downloadPsbtText(state.psbt.psbt,
      'psbt-' + String(state.psbt.txid || 'psbt').slice(0, 8) + '.psbt');
  }

  /* ------------------------------ transmitir o psbt assinado (Cofre BTC) */
  /* O arquivo volta assinado do Cofre BTC. Escolher o arquivo NÃO
     transmite: o navegador confere o PSBT contra esta carteira (entrada que
     não é sua, valor inventado, entrada não finalizada, taxa fora do padrão)
     e mostra o resumo; publicar é o clique em confirmar, porque a
     transmissão não tem volta. O texto do arquivo fica só na memória da
     tela, como o PSBT do envio. A tela recusa pelo file.size antes de ler;
     o teto do texto é o mesmo de broadcast.js. */

  function setBroadcastStatus(kind, spec) {
    setStatusTo($('#broadcast-status'), kind, spec);
  }

  function updateBroadcastActions() {
    var send = $('#broadcast-send');
    var clear = $('#broadcast-clear');
    var sep = $('#broadcast-sep');
    var pick = $('#broadcast-import');
    var hasFile = !!state.broadcastName;
    var loaded = !!state.broadcast;
    var sent = !!state.broadcastSent;
    /* Escolhido o arquivo, o seletor some e quem age é o cancelar (ou o
       confirmar, com o resumo na tela); o cancelar traz o seletor de volta.
       O separador só existe entre o cancelar e o confirmar. */
    if (pick) pick.hidden = hasFile;
    if (send) {
      send.hidden = !loaded;
      if (loaded && !sent && !state.broadcastBusy) send.removeAttribute('aria-disabled');
      else send.setAttribute('aria-disabled', 'true');
      send.textContent = sent ? t('transmitida') : t('confirmar');
    }
    var showClear = hasFile && !sent;
    if (clear) clear.hidden = !showClear;
    if (sep) sep.hidden = !(showClear && loaded);
    /* Sem nenhum controle à vista, o grupo sai do fluxo: um .chips vazio
       ainda somaria o app-gap e deixaria uma faixa em branco abaixo do
       seletor, que a seta de rolagem anunciava como conteúdo. */
    var actions = $('#broadcast-actions');
    if (actions) actions.hidden = !(showClear || loaded);
  }

  function resetBroadcast() {
    state.broadcastSeq++;
    state.broadcast = null;
    state.broadcastText = '';
    state.broadcastName = '';
    state.broadcastBusy = false;
    state.broadcastSent = false;
    var out = $('#broadcast-out');
    if (out) {
      out.hidden = true;
      out.removeAttribute('aria-busy');
    }
    var block = $('#broadcast-import-block');
    if (block) block.removeAttribute('aria-busy');
    var file = $('#broadcast-file');
    if (file) file.value = '';
    setBroadcastStatus('', null);
    updateBroadcastActions();
  }

  function broadcastCell(sel, text) {
    var el = $(sel);
    if (el) el.textContent = text == null ? '—' : text;
  }

  /* Linha do resumo do transmitir, no desenho do resumo do PSBT: rótulo na
     coluna e valor na outra. `groupEnd` fecha o par, abrindo o vão do
     próximo. */
  function broadcastMetaRow(label, groupEnd) {
    var tr = document.createElement('tr');
    if (groupEnd) tr.className = 'group-end';
    var th = document.createElement('th');
    th.setAttribute('scope', 'row');
    th.textContent = label;
    var td = document.createElement('td');
    tr.appendChild(th);
    tr.appendChild(td);
    return { tr: tr, td: td };
  }

  /* O resumo é do servidor: cada saída classificada a partir dos scripts da
     carteira, e a taxa da transação FINAL (vsize real, não a estimada do
     envio). Cada saída vira um par saída/destino ou troco/endereço, na ordem
     da transação — o mesmo desenho do resumo do PSBT, sem somar valores nem
     juntar endereços. */
  function renderBroadcast(j) {
    broadcastCell('#broadcast-meta-file', state.broadcastName || '—');
    broadcastCell('#broadcast-meta-txid', j.txid);
    broadcastCell('#broadcast-meta-vsize', fmtInt(j.vsize) + ' vB');
    broadcastCell('#broadcast-meta-rbf', rbfText(j.rbf));
    broadcastCell('#broadcast-meta-scheduled', scheduledText(j.locktime));
    var fee = $('#broadcast-meta-fee');
    if (fee) fee.innerHTML = signedBtcShare(j.fee_sats, 'out');

    var metaBody = $('#broadcast-meta tbody');
    var feeRow = $('#broadcast-meta-fee-row');
    if (metaBody && feeRow) {
      Array.prototype.forEach.call(
        metaBody.querySelectorAll('tr[data-broadcast-output]'),
        function (tr) { metaBody.removeChild(tr); }
      );
      (j.outputs || []).forEach(function (out) {
        var change = out.own === 'troco';
        var value = broadcastMetaRow(t(change ? 'troco' : 'saída'));
        value.td.innerHTML = signedBtcShare(out.value, change ? 'in' : 'out');
        value.tr.setAttribute('data-broadcast-output', '');
        metaBody.insertBefore(value.tr, feeRow);
        /* O destino externo leva o marcador no próprio endereço, no tom do
           "[ atenção ]"; as saídas da carteira seguem como texto puro. */
        var address = broadcastMetaRow(t(change ? 'endereço' : 'destino'), true);
        if (out.own === 'externo') {
          address.td.innerHTML = esc(out.address || '—') +
            ' <span class="review-external">' + t('[ externo ]') + '</span>';
        } else {
          address.td.textContent = out.address || '—';
        }
        address.tr.setAttribute('data-broadcast-output', '');
        metaBody.insertBefore(address.tr, feeRow);
      });
    }
    var warn = $('#broadcast-warn');
    var warnings = (j.warnings || []).map(function (w) {
      return specText(serverSpec(w) || rawMsg(w));
    });
    if (warn) warn.textContent = warnings.length ? t('[ atenção ]') + ' ' + warnings.join('; ') : '';
    var out = $('#broadcast-out');
    if (out) {
      out.hidden = false;
      out.removeAttribute('aria-busy');
    }
    updateScroll();
  }

  async function importSignedPsbt(file) {
    if (!file) return;
    var seq = ++state.broadcastSeq;
    state.broadcast = null;
    state.broadcastText = '';
    state.broadcastSent = false;
    state.broadcastName = file.name || t('psbt assinado');
    state.broadcastBusy = true;
    var out = $('#broadcast-out');
    if (out) out.hidden = true;
    var block = $('#broadcast-import-block');
    if (block) block.setAttribute('aria-busy', 'true');
    updateBroadcastActions();
    setBroadcastStatus('', msg('conferindo o psbt...'));
    /* O arquivo é lido só depois do teto: escolher um vídeo ou um .psbt
       inflado não pode congelar a aba. O teto é o mesmo de broadcast.js. */
    var MAX_PSBT_FILE_BYTES = 400000;
    try {
      if (file.size > MAX_PSBT_FILE_BYTES) throw fail('arquivo grande demais para conferir');
      var text = await file.text();
      if (seq !== state.broadcastSeq) return;
      if (!text.trim()) throw fail('o arquivo está vazio');
      if (!state.scanner) throw fail('carregue a carteira antes de escolher o arquivo');
      state.broadcastText = text;
      /* A conferência é local: entradas da carteira, valores, finalização e
         taxa do PSBT assinado. O Worker só verá a transação final no
         broadcast. */
      var j = localWallet().previewSignedPsbt({
        scanner: state.scanner,
        psbtText: text
      });
      if (seq !== state.broadcastSeq) return;
      state.broadcast = j;
      renderBroadcast(j);
      /* O resumo na tela já diz que o arquivo conferiu: sem legenda de
         sucesso, só a falha ganha recado. */
      setBroadcastStatus('', null);
    } catch (e) {
      if (seq !== state.broadcastSeq) return;
      state.broadcast = null;
      state.broadcastText = '';
      /* Arquivo recusado é descartado: sem o "cancelar" pendurado, o
         seletor volta na hora e a próxima escolha é um clique só. */
      state.broadcastName = '';
      var panel = $('#broadcast-out');
      if (panel) panel.hidden = true;
      setBroadcastStatus('error', errSpec(e));
    } finally {
      if (seq === state.broadcastSeq) {
        state.broadcastBusy = false;
        var blk = $('#broadcast-import-block');
        if (blk) blk.removeAttribute('aria-busy');
        updateBroadcastActions();
        updateScroll();
      }
    }
  }

  async function transmitSignedPsbt() {
    if (!state.broadcast || !state.broadcastText || state.broadcastBusy || state.broadcastSent) return;
    var seq = ++state.broadcastSeq;
    state.broadcastBusy = true;
    updateBroadcastActions();
    setBroadcastStatus('', msg('transmitindo...'));
    if (!state.scanner) {
      setBroadcastStatus('error', errSpec(fail('carteira não carregada')));
      state.broadcastBusy = false;
      updateBroadcastActions();
      return;
    }
    try {
      /* A transação final é conferida localmente e só o hex assinado vai ao
         proxy. O Worker não conhece a carteira. */
      var j = await localWallet().broadcastSignedPsbt({
        client: state.proxy,
        scanner: state.scanner,
        psbtText: state.broadcastText
      });
      if (seq !== state.broadcastSeq) return;
      state.broadcast = j;
      state.broadcastSent = true;
      state.broadcastText = '';
      renderBroadcast(j);
      // o seletor volta para o próximo PSBT sem derrubar a sessão/varredura
      state.broadcastName = '';
      setBroadcastStatus('ok', msg('transação transmitida: {txid}', { txid: j.txid || '' }));
    } catch (e) {
      if (seq !== state.broadcastSeq) return;
      setBroadcastStatus('error', errSpec(e));
    } finally {
      if (seq === state.broadcastSeq) {
        state.broadcastBusy = false;
        updateBroadcastActions();
      }
    }
  }

  /* Linha de valor com sinal (VG-COR-16): o sinal vai no texto e a cor só
     reforça; o zero não tem direção e fica no --dim da linha. */
  function signedBtc(sats, dir) {
    var n = Number(sats) || 0;
    if (!n) return '<span class="value-none">' + fmtBtc(0) + '</span>';
    return '<span class="value-' + dir + '">' + (dir === 'in' ? '+' : '-') + fmtBtc(n) + '</span>';
  }

  /* Linha "pendente" da carteira: mostra só o que ainda não está no saldo
     disponível — entrada de terceiro que só conta depois de confirmar e o que
     já saiu de fato numa transação pendente (o troco que volta já está no
     total, por isso não aparece aqui). A direção fica no sinal e na cor
     (VG-COR-16), com `/` entre os valores; sem pendência, a linha não existe. */
  function pendingValues(pin, pout) {
    var parts = [];
    if (Number(pin) > 0) {
      parts.push(signedBtc(pin, 'in'));
    }
    if (Number(pout) > 0) {
      parts.push(signedBtc(pout, 'out'));
    }
    if (!parts.length) return '';
    return '<span class="value-label">' + t('pendente') + '</span> ' +
      parts.join('<span class="value-sep">/</span>');
  }

  /* Percentual de uma linha de valor sobre o saldo total da conta — o mesmo
     número da tela da carteira, que é do que o envio é uma fatia —, precedido
     do separador `|` (o mesmo divisor das linhas de dados do extrato). Uma
     base só para todas as linhas da tabela: a taxa sobre o valor enviado é
     outra pergunta e tem lugar próprio, a linha de taxa. As casas seguem o
     tamanho: uma casa no valor grande (25.4%), duas no médio e três no
     pequeno; abaixo de 0.001% o piso `<0.001%` diz que é pequeno sem fingir
     precisão. Sem saldo conhecido, nenhuma linha ganha percentual. */
  function sharePct(sats) {
    var b = state.data && state.data.balance;
    var total = b ? Number(b.total) || 0 : 0;
    if (!(total > 0)) return '';
    var pct = (Number(sats) || 0) / total * 100;
    if (!isFinite(pct) || pct <= 0) {
      return ' <span class="value-sep" aria-hidden="true">|</span> <span class="value-pct">0%</span>';
    }
    var text = pct >= 10 ? pct.toFixed(1)
      : pct >= 1 ? pct.toFixed(2)
      : pct.toFixed(3);
    if (text === '0.000') text = '<0.001';
    return ' <span class="value-sep" aria-hidden="true">|</span> <span class="value-pct">' + dec(text) + '%</span>';
  }

  /* Valor com sinal seguido da fatia sobre o saldo (resumo do PSBT): o
     percentual completa a legenda, não compete com o valor. */
  function signedBtcShare(sats, dir) {
    return signedBtc(sats, dir) + sharePct(sats);
  }

  /* Extrato (VG-LST-01): um item por transação, agrupado pelo txid, na
     ordem que o servidor manda — mempool primeiro e depois o bloco mais
     recente. O txid é o título, as entradas/saídas viram contagem e os
     endereços da carteira que participam da transação ficam na linha de
     apoio. A transação pendente que tem saída própria não gasta ganha a
     ação "acelerar" (CPFP). */
  function historyRows() {
    return (state.data && state.data.transactions) || [];
  }

  function historyPerPageCount() {
    return historyPerPage > 0 ? historyPerPage : PER_PAGE_FALLBACK;
  }

  function historyPages() {
    return Math.max(1, Math.ceil(historyRows().length / historyPerPageCount()));
  }

  function historySeparatorNode() {
    var sep = document.createElement('li');
    sep.className = 'rule-dots';
    sep.setAttribute('aria-hidden', 'true');
    return sep;
  }

  /* Mede quantos itens cabem entre o topo da lista e o fim da área que rola.
     As posições são relativas à própria lista, então a rolagem e a entrada
     em foco não mudam o resultado. Abaixo do piso do card a página inteira
     rola (VG-LAY-12) e a referência passa a ser a altura da janela. */
  function fitHistoryItems(rows) {
    var list = $('#history-list');
    var sc = $('#content-scroll');
    var page = $('.page');
    if (!list || !sc || list.hidden) return 0;
    var pageScroll = !!page && page.classList.contains('is-page-scroll');
    var listRect = list.getBoundingClientRect();
    /* na rolagem única a página inteira rola, então a página da lista vale
       uma tela de itens; prender a sobra abaixo do cabeçalho deixaria uma ou
       duas linhas por página em telas baixas. */
    var limit = pageScroll
      ? window.innerHeight
      : sc.clientHeight - (listRect.top - sc.getBoundingClientRect().top + sc.scrollTop);
    // pelo menos um item por página, mesmo quando o cabeçalho ocupa tudo
    if (!(limit > 1)) return 1;
    list.innerHTML = '';
    var count = 0;
    for (var i = 0; i < rows.length; i++) {
      if (i) list.appendChild(historySeparatorNode());
      var li = historyItemNode(rows[i]);
      list.appendChild(li);
      /* o respiro do último parágrafo do item escapa da caixa do <li> (não há
         borda nem padding que o segure) e entra na sobra da rolagem: contá-lo
         evita que a página preencha até o último pixel e o paginador só
         apareça depois de rolar alguns pixels. */
      var tail = li.lastElementChild;
      var tailGap = tail ? parseFloat(getComputedStyle(tail).marginBottom) || 0 : 0;
      if (li.getBoundingClientRect().bottom - listRect.top + tailGap > limit) {
        list.removeChild(li);
        if (i) list.removeChild(list.lastChild);
        break;
      }
      count = i + 1;
    }
    return count || 1;
  }

  function renderHistory() {
    var list = $('#history-list');
    if (!list) return;
    var rows = historyRows();
    var screen = $('#screen-historico');
    /* a medida só vale com a tela e a lista à vista: dados chegando enquanto
       a carteira está aberta não podem trocar o número de itens. */
    if (state.data && rows.length && state.historyState === 'ready' &&
        screen && !screen.hidden && !list.hidden) {
      var fits = fitHistoryItems(rows);
      if (fits > 0) historyPerPage = fits;
    }
    // sem dados, a página pedida pelo endereço espera a resposta; com dados,
    // um número fora do intervalo cai na última sem reescrever o endereço
    // (VG-MET-10).
    if (state.data) {
      var pages = historyPages();
      if (state.page > pages) state.page = pages;
      if (state.page < 1) state.page = 1;
    }
    var perPage = historyPerPageCount();
    var start = (state.page - 1) * perPage;
    list.innerHTML = '';
    rows.slice(start, start + perPage).forEach(function (a, i) {
      if (i) list.appendChild(historySeparatorNode());
      list.appendChild(historyItemNode(a));
    });
  }

  function historyItemNode(tx) {
    var sep = ' <span class="tag-sep" aria-hidden="true">·</span> ';
    var status = tx.pending
      ? '<span class="tag tag-pending">' + esc(t('[ pendente ]')) + '</span>'
      : '';
    var values = [];
    if (tx.direction === 'in' && Number(tx.received_sats) > 0) {
      values.push('<span class="value-label">' + esc(t('recebido')) + '</span> ' + signedBtc(tx.received_sats, 'in'));
    }
    if (tx.direction === 'out' && Number(tx.sent_sats) > 0) {
      values.push('<span class="value-label">' + esc(t('enviado')) + '</span> ' + signedBtc(tx.sent_sats, 'out'));
    }
    if (tx.direction === 'self' && Number(tx.received_sats) > 0) {
      values.push('<span class="value-label">' + esc(t('auto')) + '</span> ' + fmtBtc(tx.received_sats));
    }
    if (Number(tx.fee_sats) > 0) {
      values.push('<span class="value-label">' + esc(t('taxa')) + '</span> ' + signedBtc(tx.fee_sats, 'out'));
    }
    /* As contagens vêm do servidor; passam por esc como os demais campos,
       mesmo sendo hoje só números. */
    var meta = esc(fmtInt(tx.input_count)) + ' ' +
      t(tx.input_count === 1 ? 'entrada' : 'entradas') + sep +
      esc(fmtInt(tx.output_count)) + ' ' + t(tx.output_count === 1 ? 'saída' : 'saídas');
    var eligible = !!(tx.cpfp && tx.cpfp.eligible);
    var valueText = values.join(' <span class="value-sep" aria-hidden="true">|</span> ');
    /* O estado e o acelerar formam uma coluna à direita das duas linhas de
       metadados: o começo das contagens não muda de um item pendente para
       um confirmado, e o botão cai no eixo do [ pendente ]. */
    var html =
      '<h3><span class="item-title is-static history-txid">' + esc(tx.txid) + '</span></h3>' +
      '<div class="history-body">' +
      '<p class="item-meta history-counts">' + meta + '</p>' +
      (status ? '<p class="item-meta history-status">' + status + '</p>' : '') +
      (valueText ? '<p class="item-meta history-values">' + valueText + '</p>' : '') +
      (eligible
        ? '<button type="button" class="history-actions" data-cpfp="' + esc(tx.txid) +
          '">' + esc(t('acelerar')) + '</button>'
        : '') +
      '</div>';
    var addrs = tx.addresses || [];
    if (addrs.length) {
      var labels = { entrada: 'entrada', troco: 'troco', recebimento: 'recebimento' };
      var shown = addrs.slice(0, 1).map(function (a) {
        var role = labels[a.role] || a.role;
        return '<span class="history-address">' + esc(a.address) + '</span>' + sep +
          '<span class="tag">' + esc(PT_KEYS[role] ? t(role) : role) + '</span>';
      });
      if (addrs.length > 1) shown.push('<span class="tag">+' + (addrs.length - 1) + '</span>');
      html += '<p class="item-meta history-addresses">' + shown.join(sep) + '</p>';
    }
    var li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = html;
    return li;
  }

  /* Paginador mínimo (VG-LST-08): uma página por vez, com a seta fora de
     alcance em --dim e aria-disabled. Ele aparece no lugar da seta de
     rolagem quando a lista tem mais de uma página e a rolagem chega ao fim. */
  function setPagerEdge(btn, enabled) {
    if (!btn) return;
    btn.classList.toggle('is-off', !enabled);
    if (enabled) btn.removeAttribute('aria-disabled');
    else btn.setAttribute('aria-disabled', 'true');
  }

  function updatePager(reach) {
    var pager = $('#history-pager');
    var content = $('#content');
    var screen = $('#screen-historico');
    if (!pager || !content || !screen) return;
    var pages = historyPages();
    var visible = state.historyState === 'ready' && !screen.hidden && pages > 1;
    pager.hidden = !visible;
    var el = $('#content-scroll');
    var atEnd = !el || reach <= 2 || el.scrollTop >= reach - 2;
    content.classList.toggle('show-pager', visible && atEnd);
    if (!visible) return;
    var current = $('#history-page');
    var total = $('#history-pages');
    if (current) current.textContent = String(state.page);
    if (total) total.textContent = String(pages);
    setPagerEdge($('#history-prev'), state.page > 1);
    setPagerEdge($('#history-next'), state.page < pages);
  }

  function goPage(delta) {
    var next = state.page + delta;
    if (next < 1 || next > historyPages()) return;
    state.page = next;
    renderHistory();
    syncHistoryState();
    pushScreenUrl();
    // a troca de página repete a revelação (VG-EFE-05)
    runReveal($('#screen-historico'));
    var sc = $('#content-scroll');
    if (sc) sc.scrollTop = 0;
    updateScroll();
  }

  /* A tela mudou de tamanho: mede de novo a área útil e redesenha a lista na
     mesma página, devolvendo o ponto de leitura. */
  function relayoutHistory() {
    if (state.screen !== 'historico' || state.historyState !== 'ready') return;
    var list = $('#history-list');
    var screen = $('#screen-historico');
    if (!list || !screen || screen.hidden || !historyRows().length) return;
    var sc = $('#content-scroll');
    var top = sc ? sc.scrollTop : 0;
    renderHistory();
    if (sc && top) sc.scrollTop = top;
    updateScroll();
  }

  /* ------------------------------ acelerar (CPFP) */
  /* O clique em "acelerar" monta a filha e baixa o PSBT na hora: não há
     resumo nem segundo clique. Só a falha vira recado na tela. */
  function setCpfpStatus(kind, spec) {
    setStatusTo($('#cpfp-status'), kind, spec);
    updateScroll();
  }

  function resetCpfp() {
    state.cpfpSeq++;
    setCpfpStatus('', null);
  }

  async function startCpfp(txid) {
    if (!state.xpub) return;
    var seq = ++state.cpfpSeq;
    var xpub = state.xpub;
    setCpfpStatus('', null);
    try {
      var rate = feeRateNow();
      if (!feeRateOk(rate)) {
        await loadFees();
        rate = feeRateNow();
      }
      if (!feeRateOk(rate)) throw fail('taxa indisponível; tente de novo.');
      if (!state.scanner) throw fail('carteira não carregada');
      var j = await state.scanner.prepareCpfp({ txid: txid, feeRate: rate });
      if (seq !== state.cpfpSeq || state.xpub !== xpub) return;
      if (!j.psbt) throw fail('não foi possível montar o psbt.');
      downloadPsbtText(j.psbt, 'cpfp-' + String(j.txid || txid).slice(0, 8) + '.psbt');
    } catch (e) {
      if (seq !== state.cpfpSeq) return;
      setCpfpStatus('error', errSpec(e));
    }
  }

  /* A parte do retrato que é só leitura do servidor: saldo, endereços,
     avisos e horário. Separada do resto para a troca de idioma redesenhar o
     texto sem repetir o pedido de máximo e o redesenho da lista. */
  function renderBalance(d) {
    var b = d.balance || {};
    var total = $('#v-total');
    total.textContent = fmtBtc(b.total);
    total.hidden = false;
    var pending = $('#v-pending');
    if (pending) {
      var pendingHtml = pendingValues(b.pending_in, b.pending_out);
      pending.innerHTML = pendingHtml;
      pending.hidden = !pendingHtml;
    }
    var updated = $('#v-updated');
    updated.textContent = d.updated_at
      ? t('atualizado {value}', {
        value: new Date(d.updated_at).toLocaleString(LOCALE_TAGS[state.lang] || 'pt-BR')
      })
      : '';
    updated.hidden = !d.updated_at;
    renderReceive(d);
    $('#v-warnings').innerHTML = (d.warnings || []).map(function (w) {
      return esc(specText(serverSpec(w) || rawMsg(w)));
    }).join('<br>');
  }

  /* O resumo do extrato: quatro pares legenda/valor com o plural do rótulo
     pela contagem e a marcação de valor do sistema. */
  function renderHistoryTotals(d) {
    var txs = d.transactions || [];
    var sum = { received: 0, sent: 0, fee: 0 };
    txs.forEach(function (tx) {
      if (tx.direction === 'in') sum.received += Number(tx.received_sats) || 0;
      if (tx.direction === 'out') sum.sent += Number(tx.sent_sats) || 0;
      sum.fee += Number(tx.fee_sats) || 0;
    });
    var countLabel = t(txs.length === 1 ? 'transação' : 'transações');
    /* O resumo é a leitura curta do extrato (VG-ABS-04): quatro pares
       legenda/valor — a legenda em cima e o valor embaixo, na mesma coluna —,
       com o plural do rótulo pela contagem. Os valores repetem a marcação das
       linhas do item — legenda em --dim, valor com o sinal e a cor da direção
       (VG-COR-16), e o zero em --dim. */
    var totals = [
      [countLabel, fmtInt(txs.length)],
      [t('recebido'), signedBtc(sum.received, 'in')],
      [t('saídas'), signedBtc(sum.sent, 'out')],
      [t('taxas'), signedBtc(sum.fee, 'out')]
    ];
    $('#history-summary').innerHTML =
      '<dl class="history-totals" aria-label="' + esc(t('totais do histórico')) + '">' +
        totals.map(function (c) {
          return '<div><dt>' + esc(c[0]) + '</dt><dd>' + c[1] + '</dd></div>';
        }).join('') +
      '</dl>';
  }

  function render(d) {
    stopScan();
    state.data = d;
    renderBalance(d);
    renderHistoryTotals(d);
    state.historyState = 'ready';
    syncHistoryState();
    renderHistory();
    $('#out').hidden = false;
    // saldo novo pode mudar o máximo enviável
    scheduleLimits();
    updateScroll();
  }

  /* Some com o que está na tela quando a xpub do campo deixa de ser a que
     gerou os dados: edição, apagão ou outra chave/endereço digitado. */
  function clearView() {
    if (state.timer) { clearInterval(state.timer); state.timer = 0; }
    closeWatch();
    state.xpub = '';
    state.data = null;
    var out = $('#out');
    if (out) out.hidden = true;
    // o saldo e o horário ficam fora do #out (abaixo do campo): saem da tela
    // e voltam ao travessão até a próxima consulta
    ['#v-total', '#v-pending', '#v-updated'].forEach(function (sel) {
      var el = $(sel);
      if (!el) return;
      el.textContent = sel === '#v-total' ? '—' : '';
      el.hidden = true;
    });
    var warnings = $('#v-warnings');
    if (warnings) warnings.textContent = '';
    var receiveBody = $('#receive-table tbody');
    if (receiveBody) receiveBody.innerHTML = '';
    var receiveTable = $('#receive-table');
    if (receiveTable) receiveTable.hidden = true;
    var receiveHeading = $('#receive-heading');
    if (receiveHeading) receiveHeading.hidden = true;
    var body = $('#history-list');
    if (body) { body.innerHTML = ''; body.hidden = true; }
    state.page = 1;
    state.historyState = 'idle';
    stopScan();
    var summary = $('#history-summary');
    if (summary) summary.textContent = t('cole a xpub, zpub ou ypub na carteira para ver o histórico.');
    resetSend();
    resetBroadcast();
    resetCpfp();
    setStatus('', null);
    syncHistoryState();
    updateScroll();
  }

  /* A tela só mostra dados da xpub que está no campo. */
  function syncViewToInput() {
    if (!state.data && !state.xpub) return;
    if ($('#xpub').value.trim() !== state.xpub) clearView();
  }

  /* A varredura longa é feita em passos: a tela mostra o progresso e pede
     o próximo passo, em vez de esperar tudo numa resposta só. */
  function scanText(progress) {
    var p = progress || {};
    var scanned = p.scanned || 0;
    return msg(scanned === 1 ? 'verificando {n} endereço' : 'verificando {n} endereços', {
      n: fmtInt(scanned)
    });
  }

  /* `keepView` é a atualização da MESMA xpub que já está na tela (polling,
     reabertura do tempo real, sessão expirada): o retrato anterior continua
     visível e só é substituído quando a varredura termina. Sem isso, cada
     passo da busca escondia saldo, endereços e histórico, e a tela piscava
     vazia mesmo sem a chave ter mudado. */
  function showScan(progress, keepView, quiet) {
    state.scanning = true;
    // o progresso ocupa a mesma linha que anunciava a consulta; numa
    // atualização silenciosa a linha atual fica como está
    if (!keepView || !quiet) setStatus('', scanText(progress));
    var btn = $('#scan-continue');
    if (btn) btn.hidden = true;
    if (keepView) return;
    // durante a primeira busca o saldo anterior não é apresentado como final
    var total = $('#v-total');
    if (total) total.hidden = true;
    var pending = $('#v-pending');
    if (pending) pending.hidden = true;
    var updated = $('#v-updated');
    if (updated) updated.hidden = true;
    var out = $('#out');
    if (out) out.hidden = true;
    var summary = $('#history-summary');
    if (summary) summary.textContent = '';
  }

  function stopScan() {
    state.scanning = false;
    var btn = $('#scan-continue');
    if (btn) btn.hidden = true;
  }

  function scanIncomplete(spec) {
    state.scanning = false;
    setStatus('error', spec);
    var btn = $('#scan-continue');
    if (btn) btn.hidden = false;
    var summary = $('#history-summary');
    if (summary) summary.textContent = t('busca incompleta: ainda podem existir valores não contabilizados.');
    if (!state.data) {
      state.historyState = 'error';
      syncHistoryState();
    }
  }

  async function load(quiet) {
    var xpub = $('#xpub').value.trim();
    // nunca mostra o estado de uma xpub que não está mais no campo
    syncViewToInput();
    var keepView = !!(state.data && state.xpub === xpub);
    var problem = xpubProblem(xpub);
    if (problem) {
      setFieldInvalid($('#xpub'), true);
      setStatus('error', problem);
      return;
    }
    setFieldInvalid($('#xpub'), false);
    if (state.busy) return;
    var account;
    var scanner = state.scanner;
    var proxy = state.proxy;
    var sameWallet = !!(scanner && state.xpub === xpub);
    if (!sameWallet) {
      try { account = localWallet().parseXpub(xpub); }
      catch (e) { setStatus('error', errSpec(e)); return; }
      try { await watchSession(); } catch (e) { state.watchSession = ''; }
      proxy = new ProxyClient(state.watchSession);
      scanner = new (localWallet().WalletScanner)({
        env: {},
        xpub: xpub,
        account: account,
        client: proxy
      });
    }
    state.busy = true;
    stopScan();
    closeWatch();
    if (!state.data) {
      state.historyState = 'loading';
      syncHistoryState();
    }
    /* A contagem de endereços vive no scanner local: sem consultá-lo, a
       legenda ficaria parada em zero até o fim da varredura. */
    var progressTimer = 0;
    if (!quiet) {
      var shown = -1;
      var paintProgress = function () {
        var p = null;
        try { p = scanner.progress ? scanner.progress() : null; } catch (e) { return; }
        var n = (p && p.scanned) || 0;
        if (n === shown) return;
        shown = n;
        setStatus('', scanText(p));
      };
      paintProgress();
      progressTimer = setInterval(paintProgress, 250);
    }
    try {
      /* A derivação, a margem de 50, o histórico e a conta de UTXOs rodam
         aqui. O Worker recebe só scripthashes/txids pelo proxy. */
      await scanner.init();
      await scanner.fullSync();
      if ($('#xpub').value.trim() !== xpub) return;
      state.xpub = xpub;
      state.account = account || state.account;
      state.scanner = scanner;
      state.proxy = proxy;
      var payload = await scanner.payload();
      stopScan();
      render(payload);
      // a tela já mostra o resultado: o recado de "verificando" sai de cena
      setStatus('', null);
      loadFees();
      startFeeTimer();
      schedule();
      openWatch();
    } catch (e) {
      if (state.scanning && state.scanner) {
        scanIncomplete(msg('busca interrompida: o saldo pode estar incompleto. {message}', {
          message: errSpec(e)
        }));
      } else {
        setStatus('error', errSpec(e));
        if (!state.data) {
          state.historyState = 'error';
          syncHistoryState();
        }
      }
    } finally {
      if (progressTimer) clearInterval(progressTimer);
      state.busy = false;
    }
  }

  /* A consulta começa sozinha quando a digitação/colagem deixa a xpub
     completa e válida. O debounce curto evita
     disparar no meio de uma correção e a comparação com state.xpub evita
     reconsultar a carteira que já está na tela. */
  var AUTO_DELAY = 350;
  function scheduleAutoLoad() {
    if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = 0; }
    var xpub = $('#xpub').value.trim();
    if (xpubProblem(xpub)) return;
    if (xpub === state.xpub && state.data) return;
    state.autoTimer = setTimeout(function () {
      state.autoTimer = 0;
      var current = $('#xpub').value.trim();
      if (current !== xpub || xpubProblem(current)) return;
      if (current === state.xpub && state.data) return;
      // uma consulta em andamento pode ser de outra xpub: espera terminar
      if (state.busy) { scheduleAutoLoad(); return; }
      closeWatch();
      load(false);
    }, AUTO_DELAY);
  }

  function schedule() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () {
      if (!state.xpub) return;
      // com o tempo real aberto quem avisa é o Durable Object; o polling
      // fica só como rede de segurança, bem mais espaçado.
      if (state.watch && state.watch.readyState === 1) return;
      load(true);
    }, 30000);
  }

  /* Tempo real: o Durable Object segura a conexão Electrum e as assinaturas
     de scripthash; quando algo muda ele manda o estado novo por aqui. */
  function closeWatch() {
    if (state.watch) {
      try { state.watch.close(); } catch (e) {}
      state.watch = null;
    }
    clearWatchTimer();
  }

  function clearWatchTimer() {
    if (state.watchTimer) clearTimeout(state.watchTimer);
    state.watchTimer = 0;
  }

  /* WebSocket de notificações: o cliente manda só scripthashes. O objeto
     não guarda carteira; um aviso manda o scripthash e o scanner local
     reconsulta pelo proxy. */
  function retryWatch(ws) {
    if (state.watch !== ws) return;
    state.watch = null;
    clearWatchTimer();
    if (!state.scanner || document.hidden) return;
    var wait = Math.min(30000, 2000 * Math.pow(2, state.watchRetry++));
    setTimeout(function () {
      if (!state.scanner || document.hidden) return;
      openWatch();
    }, wait);
  }

  function subscribeWatch(ws) {
    if (!state.scanner || !ws || ws.readyState !== 1) return;
    var shs = state.scanner.scriptsForWatch();
    if (!shs.length) return;
    try {
      ws.send(JSON.stringify({ type: 'subscribe', scripthashes: shs }));
    } catch (e) {}
  }

  async function watchSession() {
    if (state.watchSession) return state.watchSession;
    var res = await fetchJson('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    if (!res.r.ok || res.j.error) throw apiFail(res.r, res.j);
    state.watchSession = res.j.session || '';
    return state.watchSession;
  }

  async function openWatch() {
    if (!state.scanner || !window.WebSocket) return;
    if (state.watch && (state.watch.readyState === 0 || state.watch.readyState === 1)) return;
    closeWatch();
    var session;
    try { session = await watchSession(); } catch (e) { return; }
    if (!session) return;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws;
    try { ws = new WebSocket(proto + '//' + location.host + '/api/events?session=' + encodeURIComponent(session)); }
    catch (e) { return; }
    state.watch = ws;
    ws.onopen = function () {
      state.watchRetry = 0;
      clearWatchTimer();
      subscribeWatch(ws);
    };
    ws.onmessage = function (ev) {
      var frame;
      try { frame = JSON.parse(ev.data); } catch (e) { return; }
      if (frame.type === 'scripthash' && frame.scripthash) {
        if (state.busy || !state.scanner) return;
        state.busy = true;
        state.scanner.refreshServices(new Set([frame.scripthash])).then(function (result) {
          if (!state.scanner) return;
          render(result.payload);
          subscribeWatch(ws);
          scheduleLimits(true);
        }).catch(function (e) {
          setStatus('error', msg('tempo real: {message}', {
            message: errSpec(e)
          }));
        }).finally(function () {
          state.busy = false;
        });
      } else if (frame.type === 'error') {
        setStatus('error', msg('tempo real: {message}', {
          message: serverSpec(frame.error) || rawMsg(frame.error)
        }));
        try { ws.close(); } catch (e) {}
      }
    };
    ws.onerror = function () {
      try { ws.close(); } catch (e) {}
      retryWatch(ws);
    };
    ws.onclose = function () { retryWatch(ws); };
    state.watchTimer = setTimeout(function () {
      state.watchTimer = 0;
      if (state.watch === ws && ws.readyState === 0) {
        try { ws.close(); } catch (e) {}
        retryWatch(ws);
      }
    }, 8000);
  }

  function wire() {
    fillFrames();
    /* O texto português que chega no HTML é a chave da tradução; guardar a
       origem antes de qualquer troca permite voltar para PT sem recarregar.
       O automático segue o navegador no arranque (VG-IDI-04). */
    prepareI18n();
    state.lang = browserLang();
    applyLanguage();
    var themeParam = themeFromUrl();
    themeAuto = !themeParam;
    setTheme(themeParam || systemTheme(), { immediate: true });

    noticeWire($('#status'));
    noticeWire($('#send-status'));

    $$('.menu button[data-screen]').forEach(function (b) {
      b.addEventListener('click', function () {
        showScreen(b.getAttribute('data-screen'));
      });
    });

    /* Link de salto (VG-ACR-07): leva o foco ao título da tela aberta, sem
       escrever no endereço. */
    var skip = $('#skip-link');
    if (skip) skip.addEventListener('click', function (ev) {
      ev.preventDefault();
      var target = $('#head-' + (state.langOpen ? 'language' : state.screen));
      if (target) target.focus();
    });

    /* Tela de idiomas (VG-IDI-01/05): abre no lugar da tela atual e volta com
       o voltar, o Esc ou o botão que a abriu. */
    var langBtn = $('#lang-btn');
    if (langBtn) langBtn.addEventListener('click', showLanguage);
    var langList = $('.lang-list');
    if (langList) langList.addEventListener('click', function (ev) {
      var item = ev.target.closest ? ev.target.closest('.lang-item[data-lang]') : null;
      if (item) selectLanguage(item);
    });
    var langBack = $('#lang-back');
    if (langBack) langBack.addEventListener('click', function () { closeLanguage(); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && state.langOpen) {
        ev.preventDefault();
        closeLanguage();
      }
    });

    /* Com o automático em vigor, a troca de idioma do navegador é seguida
       sem recarregar a página; a escolha manual não é tocada (VG-IDI-04). */
    window.addEventListener('languagechange', function () {
      if (!state.langAuto) return;
      state.lang = browserLang();
      applyLanguage();
    });

    /* Erro de dados do histórico (VG-ABS-10): a nova tentativa é um link de
       prosa, não um botão novo; o endereço não muda. */
    var historyRetry = $('#history-retry');
    if (historyRetry) historyRetry.addEventListener('click', function (ev) {
      ev.preventDefault();
      if (!state.busy) load(false);
    });

    /* Volta da 404 (VG-ABS-09): link de prosa leva à carteira, com o foco
       no item de menu da tela de destino. */
    var notfoundBack = $('#notfound-back');
    if (notfoundBack) notfoundBack.addEventListener('click', function (ev) {
      ev.preventDefault();
      showScreen('carteira');
      var b = $('.menu button[data-screen="carteira"]');
      if (b) b.focus();
    });

    /* Voltar e Avançar devolvem a tela e a página anteriores (VG-MET-10). */
    window.addEventListener('popstate', function () {
      var u = readUrl();
      showScreen(u.screen, { page: u.page, noUrl: true });
    });

    $('#wallet-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      // reaproveita a sessão: se a xpub mudou, o DO reinicia sozinho
      load(false);
      if (xpubProblem($('#xpub').value.trim())) $('#xpub').focus();
    });
    var xpubInput = $('#xpub');
    function applyXpubFilter(ev) {
      syncViewToInput();
      var raw = xpubInput.value;
      var out = filterXpub(raw);
      if (out.value !== raw) {
        var caret = xpubInput.selectionStart;
        var removed = raw.length - out.value.length;
        xpubInput.value = out.value;
        try {
          var pos = Math.max(0, Math.min(out.value.length, caret - removed));
          xpubInput.setSelectionRange(pos, pos);
        } catch (e) {}
      }
      if (out.blocked) {
        setFieldInvalid(xpubInput, true);
        if (ev && ev.type === 'input') {
          setStatus('error', msg('chave inválida: use a xpub, zpub ou ypub da conta; endereço, chave privada e outro texto são recusados.'));
        }
      } else if (out.value && !xpubProblem(out.value)) {
        setFieldInvalid(xpubInput, false);
      }
      scheduleAutoLoad();
    }
    if (xpubInput) {
      xpubInput.addEventListener('input', applyXpubFilter);
      xpubInput.addEventListener('paste', function (ev) {
        var data = '';
        try { data = (ev.clipboardData || window.clipboardData).getData('text') || ''; } catch (e) {}
        if (!data) return;
        /* A colagem inteira é nossa: se deixar o paste padrão agir, o
           maxlength corta o texto cru antes do filtro de espaços e a chave
           fica truncada. */
        ev.preventDefault();
        var out = filterXpub(data);
        var missing = xpubProblem(out.value);
        if (out.value) {
          xpubInput.value = out.value;
          syncViewToInput();
          scheduleAutoLoad();
        }
        if (missing) {
          setFieldInvalid(xpubInput, true);
          setStatus('error', xpubProblem(data) || missing);
        } else {
          setFieldInvalid(xpubInput, false);
        }
      });
      xpubInput.addEventListener('blur', function () {
        applyXpubFilter(null);
        var value = xpubInput.value.trim();
        var problem = value ? xpubProblem(value) : null;
        if (problem) {
          setFieldInvalid(xpubInput, true);
          setStatus('error', problem);
        } else if (value) {
          setFieldInvalid(xpubInput, false);
        }
      });
    }

    document.addEventListener('visibilitychange', function () {
      /* Pausa do grão (VG-EFE-09): com a aba oculta o intervalo é cancelado;
         ao voltar, ele retoma (com menos movimento, fica parado). */
      if (document.hidden) stopGrain();
      else if (grain.ctx && !prefersReducedMotion()) startGrain();
      // aba em segundo plano continua aberta: a sessão e o tempo real
      // seguem; só sair da página (pagehide) encerra tudo
      if (!document.hidden) syncViewportSoon();
      if (!document.hidden && state.xpub && state.data &&
          (!state.watch || state.watch.readyState > 1)) load(true);
      if (!document.hidden && state.xpub) loadFees();
    });
    window.addEventListener('pagehide', closeWatch);
    $('#theme-toggle').addEventListener('click', function () {
      themeAuto = false;
      setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
    });
    // copiar o endereço no bloco receber: pelo botão ao lado ou pelo clique
    // no próprio código
    async function copyAddress(ev, statusEl) {
      var action = ev.target.closest ? ev.target.closest('.key-action') : null;
      /* Enquanto mostra "copiado" o botão só informa: não copia de novo nem
         responde ao clique. Não usa disabled para não devolver o foco ao
         body; o aria-disabled tira a cor de ação e o JavaScript segura o
         clique repetido. */
      if (action && action.getAttribute('aria-disabled') === 'true') return;
      var code = ev.target.closest ? ev.target.closest('code') : null;
      var value = action ? action.getAttribute('data-copy') : (code ? code.textContent.trim() : '');
      if (!value || value === '—') return;
      try {
        await navigator.clipboard.writeText(value);
        if (action) {
          action.textContent = t('copiado');
          action.setAttribute('aria-disabled', 'true');
          if (!action._copyLabel) action._copyLabel = action.getAttribute('aria-label');
          action.setAttribute('aria-label', t('endereço copiado'));
          if (action._copyTimer) clearTimeout(action._copyTimer);
          action._copyTimer = setTimeout(function () {
            action.textContent = t('copiar');
            action.removeAttribute('aria-disabled');
            if (action._copyLabel) action.setAttribute('aria-label', action._copyLabel);
            action._copyTimer = 0;
          }, 1400);
        }
      } catch (e) {
        setStatusTo(statusEl, 'error', msg('não foi possível copiar.'));
      }
    }
    var receiveTable = $('#receive-table');
    if (receiveTable) receiveTable.addEventListener('click', function (ev) { copyAddress(ev, $('#status')); });
    var pager = $('#history-pager');
    if (pager) pager.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('.pager-arrow') : null;
      if (!btn || btn.getAttribute('aria-disabled') === 'true') return;
      goPage(btn.id === 'history-next' ? 1 : -1);
    });
    var historyList = $('#history-list');
    if (historyList) historyList.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('[data-cpfp]') : null;
      if (!btn) return;
      startCpfp(btn.getAttribute('data-cpfp'));
    });

    var scanContinue = $('#scan-continue');
    if (scanContinue) scanContinue.addEventListener('click', function () {
      if (!state.busy) load(false);
    });

    /* ---------------------------------------------------------- enviar */
    /* Sem botão de envio: o PSBT se monta sozinho. O Enter no formulário
       só antecipa a montagem; a página não navega nem recarrega. */
    var sendForm = $('#send-form');
    if (sendForm) sendForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      updateSendAvailability();
      focusFirstInvalid(sendForm);
    });
    /* Máscara de satoshis: dígitos entram da direita, o ponto é automático,
       backspace apaga o último dígito e colar aceita BTC com ponto/vírgula. */
    var amountInput = $('#send-amount');
    if (amountInput) {
      amountInput.addEventListener('keydown', function (ev) {
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
        if (/^[0-9]$/.test(ev.key)) {
          ev.preventDefault();
          var all = amountInput.selectionStart === 0 &&
            amountInput.selectionEnd === amountInput.value.length;
          setAmountDigits((all ? '' : state.amountDigits) + ev.key);
          invalidatePsbt();
          return;
        }
        if (ev.key === 'Backspace' || ev.key === 'Delete') {
          ev.preventDefault();
          var whole = amountInput.selectionStart === 0 &&
            amountInput.selectionEnd === amountInput.value.length;
          setAmountDigits(whole ? '' : state.amountDigits.slice(0, -1));
          invalidatePsbt();
          return;
        }
        if (ev.key === '.' || ev.key === ',') ev.preventDefault();
      });
      amountInput.addEventListener('input', function (ev) {
        if (amountInput.value === amountDisplay(state.amountDigits)) {
          updateSendAvailability();
          return;
        }
        if (ev.inputType === 'deleteContentBackward' || ev.inputType === 'deleteContentForward') {
          setAmountDigits(state.amountDigits.slice(0, -1));
        } else {
          syncAmountFromValue();
        }
        invalidatePsbt();
      });
      amountInput.addEventListener('paste', function (ev) {
        var text = '';
        try { text = (ev.clipboardData || window.clipboardData).getData('text') || ''; } catch (e) {}
        if (!text.trim()) return;
        ev.preventDefault();
        var sats = /[.,]/.test(text) ? parseBtcSats(text) : (function () {
          var d = text.replace(/\D/g, '');
          return d ? Number(BigInt(d)) : 0;
        })();
        if (sats == null) return;
        setAmountDigits(String(sats));
        invalidatePsbt();
      });
    }
    var addressInput = $('#send-address');
    if (addressInput) addressInput.addEventListener('input', function () {
      dropPsbt(); // destino novo: o retrato anterior não fica na tela
      scheduleLimits();
    });
    var sendDownload = $('#send-download');
    if (sendDownload) sendDownload.addEventListener('click', downloadPsbt);

    /* ------------------------------------------ transmitir (psbt assinado) */
    var broadcastFile = $('#broadcast-file');
    if (broadcastFile) broadcastFile.addEventListener('change', function () {
      var file = broadcastFile.files && broadcastFile.files[0];
      // esvazia o input para o mesmo arquivo poder ser escolhido de novo
      broadcastFile.value = '';
      if (file) importSignedPsbt(file);
    });
    var broadcastSend = $('#broadcast-send');
    if (broadcastSend) broadcastSend.addEventListener('click', transmitSignedPsbt);
    var broadcastClear = $('#broadcast-clear');
    if (broadcastClear) broadcastClear.addEventListener('click', resetBroadcast);
    renderFees();
    renderAmountInput();

    var sc = $('#content-scroll');
    if (sc) sc.addEventListener('scroll', updateScroll);
    watchContentHeight();

    /* Reavalia a altura medida em toda mudança de viewport que não passa
       pelo resize da janela (a barra do iOS, a volta do bfcache). */
    window.addEventListener('orientationchange', syncViewportSoon);
    window.addEventListener('pageshow', syncViewportSoon);
    window.addEventListener('load', syncViewportSoon);
    if (window.visualViewport && window.visualViewport.addEventListener) {
      window.visualViewport.addEventListener('resize', syncViewportSoon);
    }

    var resizeTimer = 0;
    window.addEventListener('resize', function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        resizeTimer = 0;
        syncViewportHeight();
        syncBars();
        syncPageMode();
        resizeGrain();
        relayoutHistory();
      }, 150);
    });

    $$('.scroll-arrow').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!sc) return;
        var up = b.classList.contains('scroll-arrow-up');
        sc.scrollBy({
          top: (up ? -1 : 1) * sc.clientHeight * 0.8,
          /* Menos movimento (VG-EFE-04): a seta salta direto. */
          behavior: prefersReducedMotion() ? 'auto' : 'smooth'
        });
      });
    });

    if (reducedMotionQuery.addEventListener) {
      reducedMotionQuery.addEventListener('change', function () {
        if (prefersReducedMotion()) stopGrain();
        else if (grain.ctx) startGrain();
      });
    } else if (reducedMotionQuery.addListener) {
      reducedMotionQuery.addListener(function () {
        if (prefersReducedMotion()) stopGrain();
        else if (grain.ctx) startGrain();
      });
    }

    /* A abertura direta pelo endereço já desenha a tela e a página pedidas
       (VG-MET-10); sem parâmetro, começa na carteira. A primeira pintura não
       repete a entrada em foco (VG-EFE-02): o HTML já chega na posição final e
       a animação só marcaria telas trocadas depois, sem fazer o conteúdo
       tremer na abertura. */
    var initial = readUrl();
    showScreen(initial.screen, { page: initial.page, noUrl: true, noReveal: true });
    syncViewportHeight();
    syncBars();
    syncPageMode();

    /* A tinta do grão depende da cobertura dos glifos reais: espera a fonte
       carregar para medir, e o desenho entra estático nesse intervalo. */
    var startVisuals = function () {
      initGrain();
      syncViewportHeight();
      syncBars();
      syncPageMode();
      relayoutHistory();
    };
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(startVisuals).catch(startVisuals);
    } else {
      startVisuals();
    }

    // A tela abre sempre limpa: a xpub nunca foi salva (nem aqui, nem no
    // servidor), então não há nada para restaurar.
  }

  /* ------------------------------------------------------------- instalar */
  /* Não há mais service worker: a instalação é definida pelo manifest e
     nenhuma navegação precisa passar por um worker. Desregistra o que tiver
     ficado de versões anteriores. */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function (registros) {
      registros.forEach(function (registro) { registro.unregister(); });
    }).catch(function () {});
  }

  document.addEventListener('DOMContentLoaded', wire);
})();
