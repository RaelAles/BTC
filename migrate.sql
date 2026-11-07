-- Migração para um D1 criado com a versão anterior do schema (antes do
-- saldo por UTXO): a tabela addresses não tinha `script` nem `spent`.
--
-- Rodar UMA vez:
--   npm run db:migrate            (remoto)
--   npm run db:migrate:local      (dev)
--
-- Tudo o que está em addresses/transactions é derivado da xpub + Electrum,
-- então também é seguro apagar e recriar (ver reset.sql) se preferir.
-- Linhas antigas (sem script) são ignoradas e derivadas de novo no próximo
-- /api/wallet.

ALTER TABLE addresses ADD COLUMN script TEXT NOT NULL DEFAULT '';
ALTER TABLE addresses ADD COLUMN spent INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS transactions (
  xpub_hash       TEXT NOT NULL,
  txid            TEXT NOT NULL,
  raw             TEXT NOT NULL,
  PRIMARY KEY (xpub_hash, txid)
);
