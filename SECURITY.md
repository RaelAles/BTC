# Security Policy

## Supported Versions

Security fixes are applied to the most recent released version.

## Reporting a Vulnerability

Please do not open a public issue. Report privately:

- Use this repository's **Security → Report a vulnerability** area, when
  available.
- Otherwise, contact the maintainers directly.

Include, if possible: a description of the problem, steps to reproduce, the
affected version, and the estimated impact.

## What to Expect

We confirm receipt within 3 business days and keep you informed of the progress.
Please do not disclose the issue publicly before a fix is available.

## Trust Model

The browser derives addresses and scripthashes from the xpub and runs the
wallet scanner (gap, balance, history, UTXOs, send PSBT and CPFP). The Worker
is an Electrum proxy: it receives scripthashes, txids, raw transactions and the
signed transaction at broadcast; it never receives the xpub or the derived
address/pubkey list. Raw transactions contain their public scripts. A compromised Worker or hosting layer can still see the
queried scripthashes/txids/transactions and can omit data or lie about balance,
fee or censorship. The local reconciliation and the Cofre BTC check before
signing are the defenses.

The screen code itself is served by the Worker. A compromised Worker can
serve altered JavaScript and capture the xpub before local derivation; SRI
and CSP do not protect against a page replaced by its own server. Local
derivation protects against a server that receives requests, not against a
server that controls the delivered code.

No independent security audit report is included in this repository. A
checksum published in this repository proves integrity against a known file;
it does not by itself prove who produced the file.
