# Security

Apricot runs arbitrary APKs on an emulator on your computer and exposes a control API on your network.

- By default the server listens on all interfaces **without authentication**, which suits a trusted home network.
  Set `APRICOT_TOKEN` whenever other people share the network, and always before exposing it in any other way.
- Never port-forward Apricot to the public internet. Use [Tailscale](https://tailscale.com) or another VPN.
- APKs run inside the Android emulator's sandbox, not on macOS directly. Only run apps you trust.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Security → Report a vulnerability** on this repository,
not in a public issue. We aim to respond within a week.
