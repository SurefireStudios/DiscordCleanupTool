# Contributing

Thanks for taking a look. Issues and pull requests are both welcome.

## Getting set up

```bash
git clone https://github.com/SurefireStudios/DiscordCleanupTool.git
cd DiscordCleanupTool
npm test
```

There's no install step and no build step — the project has no dependencies, and the dashboard is
plain HTML, CSS and JS served as-is. You need Node 18 or newer.

You do **not** need a Discord token to develop or test. The whole suite runs against a stubbed
API, makes no network calls, and deletes nothing.

## Running it

```bash
npm run dashboard          # http://127.0.0.1:8787
node src/cli.js help       # CLI
```

## Ground rules

**1. No runtime dependencies.** This is a feature, not an accident — the tool handles credentials
that are equivalent to full account access, and an empty dependency tree is a large part of why
it's reasonable to trust it. CI fails the build if `dependencies` is non-empty. Dev dependencies
are also better avoided; the tests use `node:assert`.

**2. Keep the security guards passing.** If you touch `src/server.js`, the tests in
`test/server.test.js` covering the dashboard key, CSRF, DNS rebinding, loopback binding, path
traversal and token non-disclosure must stay green. See [SECURITY.md](SECURITY.md) for why each
exists. A change that weakens one needs to say so explicitly in the PR.

**3. Never render Discord content as markup.** Message text and channel names come from other
people. The UI renders all of it with `textContent`, never `innerHTML`. There is a test with an
`<img onerror=...>` payload in the fixture to keep this honest.

**4. Don't make the tool harder to detect.** It identifies itself accurately and obeys every rate
limit Discord reports. PRs that add fingerprint spoofing, request jitter designed to look human,
proxy rotation, or anything else whose purpose is evading Discord's anti-automation systems will
be declined. Respecting rate limits is both the correct behaviour and the thing that actually
makes runs uneventful.

**5. Deletion stays deliberate.** Dry run remains the default in the dashboard. The confirmation
step, and the type-`DELETE` gate on *Everything*, stay. If you add a new way to delete things, it
needs an equivalent guard.

**6. Match the surrounding style.** Two-space indent, single quotes, semicolons, ES modules.
Comments explain *why*, not *what*. There's no linter — just read the neighbouring code.

## Before opening a PR

```bash
npm test
```

All 31 checks should pass. CI runs the same suite on Node 18, 20, 22 and 24, plus Windows and
macOS, and separately verifies that the dependency tree is still empty and the dashboard still
boots.

In the PR description, say what changed and why. If it's a behaviour change, mention how you
verified it — especially anything touching the delete path, where "I ran it against my own
account" is genuinely useful information.

## Reporting bugs

Open an issue with what you expected, what happened, your Node version and OS, and the exact
command or steps. **Redact any token** from logs and screenshots before posting — and if one
slipped out, change your Discord password immediately, which invalidates it.

For security vulnerabilities, don't open a public issue — see [SECURITY.md](SECURITY.md).
