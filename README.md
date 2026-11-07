# Junie Credits for OpenChamber

An [OpenChamber](https://github.com/openchamber/openchamber) extension that
shows your JetBrains Junie credit balance and license in the **Work Status**
panel.

It only reads. It holds no token and calls no JetBrains endpoint: it asks the
[`opencode-jetbrains-junie-oauth`](https://github.com/leandromqrs/opencode-jetbrains-junie-oauth)
OpenCode plugin, which holds the login, through
`opencode api post /api/rpc/jetbrains-junie/quota`.

JetBrains reports only the balance left, not the plan total or a renewal date,
so the section shows an amount, never a percentage.

## Install

In OpenChamber, open **Settings → Extensions**, add this Git address, and
approve the service it asks for:

```
https://github.com/eduardo-alecrim/openchamber-junie-usage.git
```

OpenChamber offers **Update** when a newer `version` reaches the default branch.

Requirements:

- OpenChamber 2.6.0 or later.
- `opencode` on the PATH OpenChamber runs with.
- The `opencode-jetbrains-junie-oauth` plugin installed in OpenCode and signed in.

## How it works

The extension declares a host service (`contributes.service`) and a Work Status
section that OpenChamber draws itself from the service's `GET /status`
(`contributes.statusSection.source`), with no frame of its own. OpenChamber asks
for the section every 60 s while it is on screen. The service keeps the balance
for 2 minutes, and the section's **Refresh** button reads again at once.

## Develop

```sh
bun install
bun run check   # tsc
bun run build   # bundles service/main.ts into service/main.js
```

`service/main.js` is committed, because OpenChamber runs it as is. Rebuild it
before each commit that changes `src/` or `service/main.ts`, and bump `version`
to ship an update.

## License

[Apache-2.0](LICENSE)
