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

The browser derives the addresses from the xpub; the Worker receives only the
derived address set (used addresses plus the 50-address gap tail), never the
extended public key. The send PSBT and the CPFP child are built in the browser
from the raw transactions; the Worker does not choose coins or change. A
compromised Worker or hosting layer can still see those addresses, the UTXOs
and the queried history, and can omit data or lie about balance, fee or
censorship. The local balance check and the Cofre BTC check before signing are
the defenses.

The screen code itself is served by the Worker. A compromised Worker can
serve altered JavaScript and capture the xpub before local derivation; SRI
and CSP do not protect against a page replaced by its own server. Local
derivation protects against a server that receives requests, not against a
server that controls the delivered code.

No independent security audit report is included in this repository. A
checksum published in this repository proves integrity against a known file;
it does not by itself prove who produced the file.
