# DiscordCleanupTool

A cleanup tool that deletes **your own** messages from Discord DMs, group DMs and server
channels, at a pace that stays under Discord's rate limits. Browser dashboard or CLI.

Runs entirely on your own machine. Zero dependencies — Node 18+ and the built-in `fetch`.
MIT licensed.

---

## Read this before you use it

**1. Deletion is permanent.** There is no undo, no trash, no export-first step. Always do a
dry run before a real one, especially when deleting everything. The dashboard defaults to
dry run; the CLI takes `--dry-run`.

**2. Which token you use matters a lot.**

| | Bot token | User token (your own account) |
|---|---|---|
| Source | Discord Developer Portal | your own account's session |
| Can delete | only messages the **bot** sent | messages **you** sent |
| Works in your private DMs | no — a bot can't read your DMs with other people | yes |
| Discord's rules | supported and intended | **against the Terms of Service** |

Automating a user account is what Discord calls a "self-bot", and it is a ToS violation that
can get the account terminated — Discord does not carve out an exception for cleanup tools.
If the goal is to wipe your own history from private chats, a user token is the only thing
that technically does it, and the account risk is real and is yours to accept. This tool
supports both and does not choose for you.

The zero-risk use of this tool is a **bot token**, cleaning up messages the bot itself posted
in channels it has access to. Anything involving your own DMs is user-token territory.

**3. There is no "Sign in with Discord", and that is not an oversight.** Discord's OAuth2
flow issues a bearer token limited to the scopes you approve — `identify`, `email`, `guilds`
and similar. None of them grant permission to read your message history or delete your
messages, and Discord publishes no scope that does. An OAuth button could show your name and
avatar and nothing else; you would still have to supply a token to delete anything. So it
would add a step and buy nothing.

> If you ever find a website offering to clean your Discord messages behind a "Login with
> Discord" button, treat that as a warning sign. Either it cannot do what it claims, or it is
> harvesting a real token from you under the appearance of an official login.

**4. Keep the token out of git.** `config.json` is already in `.gitignore`. Prefer the
`DISCORD_TOKEN` environment variable so it never lands on disk at all. A leaked token is
full control of the account — if one escapes, change the account password immediately
(that invalidates user tokens) or regenerate the bot token in the Developer Portal.

---

## Getting a user token

Do this in a **browser**, not the desktop app (the app ships with DevTools disabled).

1. Open <https://discord.com/app> and log in.
2. `F12` to open DevTools, go to the **Network** tab.
3. Type `api` in the filter box.
4. Click around — open a DM, switch channels — so requests appear.
5. Click any request to `discord.com/api/v10/...`.
6. Under **Request Headers**, find `authorization:`. That value is the token.

Then, without putting it in a file:

```powershell
$env:DISCORD_TOKEN = "paste-here"     # PowerShell
```

```bash
export DISCORD_TOKEN="paste-here"     # bash / git bash
```

```bash
node src/cli.js whoami
```

Leave `tokenType` as `"user"` in `config.json` — that's already the default.

### Handling it safely

- **Never paste this token into any website, bot, "token checker", or tool you didn't build.**
  Talking someone into pasting their token somewhere is *the* standard Discord account-theft
  scam — it's the reason Discord prints that giant warning in the browser console. The token
  is a live session: no password and no 2FA prompt stands between it and full account control.
- Use the environment variable rather than `config.json`, so it isn't sitting on disk.
- It's tied to your login session. Changing your account password invalidates it instantly —
  which is also your kill switch if you ever think it leaked.
- Don't commit it, don't paste it into a chat to ask for help, and scrub it from any log or
  screenshot you share.

---

## Two ways to use it

**Dashboard** (easier — click through it in your browser):

```bash
npm run dashboard
```

Opens `http://127.0.0.1:8787` with a three-step flow: connect, tick the chats you want, pick
how much to delete. Live progress, a stop button, and a confirmation step before anything
real happens.

**CLI** (scriptable): `node src/cli.js help`.

Both drive the same engine, so behaviour and pacing are identical.

---

## Setup

```bash
cd "discord deleter"
cp config.example.json config.json
```

Get a token (see [Getting a user token](#getting-a-user-token) for DM cleanup), set
`DISCORD_TOKEN` in your shell, set `tokenType` to `"user"` or `"bot"` to match, then:

```bash
node src/cli.js whoami
```

If that prints your account name, you're ready.

---

## The dashboard

```bash
npm run dashboard              # http://127.0.0.1:8787
npm run dashboard -- --port 9000 --no-open
```

1. **Connect** — paste a token, or click Connect if one is already in `DISCORD_TOKEN`.
   The token lives in the server process's memory only; it is never written to disk and never
   appears in any response the page receives. A built-in **How do I find my token?** panel
   walks through the DevTools steps, and switches to Developer Portal instructions when you
   set Type to Bot. Pasted tokens get an instant local format check — wrong shape, stray
   whitespace, a leftover `Bot ` prefix — before anything is sent anywhere.
2. **Choose chats** — your DMs and group DMs are listed with checkboxes, with a filter box and
   a Servers tab for guild channels. Tick as many as you like.
3. **How much** — Last 50 / 100 / 500 / Everything / a custom number, plus filters and pacing
   under *Filters & pacing*.

Dry run is **on by default**, and the button says "Preview" until you turn it off. Turning it
off changes the button to a red "Delete" and adds a confirmation dialog listing exactly what
is about to happen; choosing *Everything* additionally makes you type `DELETE`. During a run
you get live counters, a streaming log, and a Stop button that halts after the current
message.

### How the dashboard is secured

It holds a token equivalent to full account access, so loopback alone isn't treated as a
boundary — any page in your browser can send requests to `127.0.0.1`:

- Binds `127.0.0.1` explicitly, never `0.0.0.0`. Nothing on your network can reach it.
- Every `/api` call needs a random per-run key, delivered to the page inline and sent in a
  custom header. Custom headers can't be set by a plain cross-site form post, so this rules
  out CSRF as well; no cookie is ever set.
- Requests with a foreign `Origin` are rejected, and so are requests whose `Host` isn't
  loopback — that closes DNS rebinding, where an attacker's domain resolves to `127.0.0.1`
  to get same-origin treatment.
- The page runs under a strict CSP with no inline script, no remote origins, and no network
  access beyond itself.
- Streamed events carry only a message id and trimmed text — no author objects, no attachment
  URLs — and the UI renders all of it with `textContent`, so message content can never
  execute as markup.
- Ctrl+C on the server, or *Disconnect & clear token*, drops the token from memory.

The key is regenerated every launch, so old browser tabs stop working after a restart —
reload the page.

---

## CLI: choosing which chats to clean

Two ways, and they mix freely.

**By channel ID.** List what the account can see:

```bash
node src/cli.js list dms                 # open DMs and group DMs
node src/cli.js list guilds              # servers
node src/cli.js list channels <guildId>  # channels in one server
```

Each row prints the channel ID, which you can pass straight to `clean`.

> `list dms` only shows conversations that are currently **open** in your client. If a DM
> isn't listed, open it in Discord and run the command again.

**By alias.** Give the ones you clean regularly a name in `config.json`:

```json
{
  "tokenType": "user",
  "delayMs": 1200,
  "targets": {
    "alex-dm": "123456789012345678",
    "team-general": "987654321098765432"
  }
}
```

`node src/cli.js targets` lists them back. Now `clean alex-dm` works instead of pasting IDs.

---

## CLI: cleaning

```bash
# always start here
node src/cli.js clean alex-dm --limit 50 --dry-run

# the real thing
node src/cli.js clean alex-dm --limit 50
node src/cli.js clean alex-dm --limit 100
node src/cli.js clean alex-dm --limit all

# several channels in one go
node src/cli.js clean alex-dm team-general --limit 100

# narrower sweeps
node src/cli.js clean team-general --contains "wrong link" --limit all
node src/cli.js clean alex-dm --before 2025-06-01 --limit all
node src/cli.js clean alex-dm --after 2026-09-01 --limit 200
```

`--limit` counts **your** messages, not total messages scanned — `--limit 50` means "delete
50 of mine", however much history it has to read to find them.

Without `--yes`, a real run prints exactly what it is about to do (account, channels, limit,
filters, pacing) and waits for you to type `yes`.

Full option list: `node src/cli.js help`.

---

## Rate limiting

Discord's per-channel message-delete bucket is strict, and messages older than about two
weeks sit in a tighter sub-bucket still. Three things keep the tool under it:

1. **A fixed delay between deletes** — `delayMs`, default `1200`ms.
2. **A longer breather** every `pauseEvery` deletes (default 50) of `pauseMs` (default 5000).
3. **Header-driven backoff** — every response carries `X-RateLimit-Remaining` and
   `X-RateLimit-Reset-After`; when a bucket is exhausted the client waits out the reset
   *before* sending the next request, rather than firing and eating a 429.

A 429 that still gets through is honoured via its `retry_after` (including global limits),
and retried up to 8 times. 5xx errors get exponential backoff.

At the defaults expect roughly **45 deletes per minute** — about 18 minutes per thousand
messages. If you start seeing 429s in the output, raise `--delay`. Lowering it below ~1000ms
is where accounts start tripping limits hard.

`--bulk` uses Discord's bulk-delete endpoint (100 at a time, no per-message delay) but it is
**servers only, bot tokens only, and only for messages under 14 days old** — it does not work
in DMs and is not available to user accounts. The tool falls back to one-at-a-time deletes
automatically if a bulk call is rejected.

---

## Notes specific to DMs

- **Deletion is two-sided.** Removing your message in a DM removes it from the other person's
  client too — it's deleted server-side, not just hidden for you. Their own messages stay put;
  this tool will never touch them.
- **Interrupted runs just resume.** Each run walks history from the newest message down, and
  already-deleted messages simply aren't there any more. If a long `--limit all` run dies
  halfway, re-run the same command and it picks up where it left off.
- **Pace it.** The 1200ms default is fine, but for a multi-thousand-message wipe consider
  `--delay 2000` and running it in chunks (`--limit 500` at a time) rather than one long
  unattended session.
- **User-Agent.** In user mode the client sends a normal browser User-Agent, because the
  `DiscordBot (...)` form is the documented value for bot clients and some endpoints treat a
  user token carrying it differently. Override with `"userAgent"` in `config.json` if you
  want. Beyond that the tool makes no attempt to disguise itself — it identifies honestly and
  obeys every rate limit the API reports, which is both correct behaviour and the thing that
  actually keeps a run uneventful.

## What it will not delete

- Messages sent by anyone else (it filters on your own user ID — always).
- System messages: joins, calls, pin notices, boosts. Discord refuses these; they're skipped.
- Messages in channels the account can't see, or where it lacks permission. These are
  reported as failures with the reason, and the run continues.

---

## Layout

```
src/api.js          Discord REST client — auth, rate-limit handling, endpoints
src/cleaner.js      the engine: history pagination, filtering, delete loop
src/config.js       config + token loading, target alias resolution
src/cli.js          terminal interface
src/server.js       local dashboard server — HTTP API, event stream, guards
src/dashboard.js    dashboard launcher
public/             the dashboard page (no build step, no dependencies)
test/smoke.js       engine tests against a stubbed API
test/server.test.js dashboard tests, including the security guards
```

```bash
npm test
```

28 checks, no network and no real deletes. The engine suite covers limit accounting,
pagination across pages, the ownership filter, date and text filters, dry-run doing nothing,
404 handling, and the delay actually being applied. The server suite covers the key check,
CSRF and DNS-rebinding rejection, loopback binding, the token never appearing in a response,
path traversal, job streaming, and stopping a run mid-flight.

---

## Contributing

Issues and pull requests welcome at
<https://github.com/SurefireStudios/DiscordCleanupTool>.

Run `npm test` before opening a PR — 28 checks, no network calls and no real deletions. If you
touch `src/server.js`, keep the guards in `test/server.test.js` passing; they are the reason it
is safe to hold a token in a local web server.

## Disclaimer

Not affiliated with, endorsed by, or connected to Discord Inc. Provided as-is under the MIT
licence. Deleting messages is irreversible, and automating a user account violates Discord's
Terms of Service — you are responsible for how you use this.
