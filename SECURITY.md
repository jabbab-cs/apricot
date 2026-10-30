# Security

Apricot runs arbitrary APKs on an emulator on your computer and exposes a control API on your network.

- Every request needs a random token (generated on first run, stored in `server/data/token`). Only the pairing QR code
  carries it, so treat the QR code like a password. Requests from the computer itself (the dashboard on `localhost`)
  don't need it.
- Remote access goes through a Cloudflare quick tunnel: HTTPS to Cloudflare, no open ports on your router. Anyone who
  learns the tunnel address still needs the token. Set `APRICOT_REMOTE=0` to turn the tunnel off.
- To revoke every paired phone, delete `server/data/token` and restart.
- Don't port-forward Apricot directly: plain HTTP on your router would expose the token.
- APKs run inside the Android emulator's sandbox, not on macOS directly. Only run apps you trust.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Security → Report a vulnerability** on this repository,
not in a public issue. We aim to respond within a week.
