-- Fase 1: estado por xpub (credencial = hash da xpub).
-- Não existe chave privada aqui; só endereços públicos derivados.
CREATE TABLE IF NOT EXISTS wallets (
  xpub_hash       TEXT PRIMARY KEY,
  xpub            TEXT NOT NULL,
  version_type    TEXT NOT NULL,
  account_type    TEXT NOT NULL,
  next_receive    INTEGER NOT NULL DEFAULT 0,
  next_change     INTEGER NOT NULL DEFAULT 0,
  balance         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS addresses (
  xpub_hash       TEXT NOT NULL,
  account_type    TEXT NOT NULL,
  chain           INTEGER NOT NULL,
  idx             INTEGER NOT NULL,
  address         TEXT NOT NULL,
  used            INTEGER NOT NULL DEFAULT 0,
  balance         INTEGER NOT NULL DEFAULT 0,
  received        INTEGER NOT NULL DEFAULT 0,
  tx_count        INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (xpub_hash, account_type, chain, idx)
);

CREATE INDEX IF NOT EXISTS addresses_wallet
  ON addresses (xpub_hash, account_type, chain, idx);
