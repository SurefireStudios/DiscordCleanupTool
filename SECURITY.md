# Security Policy

This tool handles Discord tokens, which are equivalent to full account access. Security issues
here are worth reporting, and worth reporting privately.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Use GitHub's private reporting instead:
[**Report a vulnerability**](https://github.com/SurefireStudios/DiscordCleanupTool/security/advisories/new).

Please include:

- what an attacker can do, and what they need in order to do it
- the steps to reproduce it
- the affected file or endpoint, if you know it
- the version or commit you tested

You can expect an initial response within about a week. This is a small project maintained in
spare time, so please be patient — but a real vulnerability will be taken seriously.

**Never include a real Discord token in a report.** If you need to demonstrate something with a
token, redact it, and rotate it (change your Discord password) afterwards.

## Supported versions

The latest release on `main` is the only supported version. Fixes go forward, not into old tags.

## Threat model

The dashboard runs a local HTTP server that holds a live Discord token in memory. Loopback alone
is **not** treated as a security boundary, because any page in the user's browser can send
requests to `127.0.0.1`. The following are therefore treated as security properties, each covered
by a test in [`test/server.test.js`](test/server.test.js):

| Property | Defence |
| --- | --- |
| Nothing on the network can reach the server | binds `127.0.0.1` explicitly, never `0.0.0.0` |
| No other site can drive the API | random per-launch key required in a custom request header |
| No CSRF | a custom header can't be set by a cross-site form post; no cookie is ever set |
| No DNS rebinding | requests with a foreign `Origin`, or a non-loopback `Host`, are rejected |
| No script injection from message content | strict CSP, no inline script, and all content rendered via `textContent` |
| Token never leaks to the page | it appears in no response body; only a message id and trimmed text are streamed |
| Token never persists | held in memory only; dropped on `Ctrl+C` or *Disconnect & clear token* |

A regression in any of those is a vulnerability, not a bug. Please report it privately.

### Out of scope

- **The user token approach itself.** Automating a user account violates Discord's Terms of
  Service. That is documented prominently in the README; it's a known and deliberate trade-off,
  not a vulnerability.
- **Anyone with local access to your machine.** A process running as you can read the token from
  memory. This tool does not defend against a compromised local account.
- **Discord's own rate limits or API behaviour.** Report those to Discord.

## If you think your token has leaked

Change your Discord password. That invalidates every existing user token immediately, including
any that escaped. For a bot token, regenerate it in the
[Developer Portal](https://discord.com/developers/applications).
