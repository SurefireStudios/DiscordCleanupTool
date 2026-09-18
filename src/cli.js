#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { DiscordAPI, snowflakeToDate, DiscordError } from './api.js';
import { loadConfig, resolveTarget } from './config.js';
import { cleanChannel } from './cleaner.js';
import { DISPLAY_NAME, VERSION } from './meta.js';

// --- tiny arg parser ---------------------------------------------------------

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const HELP = `
${c.bold(DISPLAY_NAME)} ${c.dim('v' + VERSION)} — bulk-remove your own messages from chosen DMs and channels.

${c.bold('Usage')}
  ddel whoami                        Verify the token and show the account it belongs to
  ddel list dms                      List open DMs / group DMs with their channel IDs
  ddel list guilds                   List servers the account is in
  ddel list channels <guildId>       List text channels in a server
  ddel targets                       Show the aliases defined in config.json
  ddel clean <target...> [options]   Delete your messages in one or more channels

${c.bold('Targets')}
  A target is a channel ID (17-20 digits) or an alias from "targets" in config.json.
  Pass several to clean them in sequence.

${c.bold('Clean options')}
  --limit <n|all>     How many of your messages to delete per channel. Default: 50
  --scan-limit <n>    Stop after reading this many messages while searching. Default: unlimited
  --contains <text>   Only delete messages containing this text (case-insensitive)
  --before <date>     Only delete messages older than this (e.g. 2026-01-01)
  --after <date>      Only delete messages newer than this
  --delay <ms>        Pause between deletes. Default: from config (1200)
  --pause-every <n>   Take a longer breather every n deletes. Default: 50
  --pause <ms>        Length of that breather. Default: 5000
  --bulk              Use bulk-delete for messages under 14 days old (bot tokens, servers only)
  --dry-run           Report what would be deleted without deleting anything
  --yes               Skip the confirmation prompt
  --json              Emit a machine-readable summary at the end

${c.bold('Examples')}
  ddel list dms
  ddel clean 123456789012345678 --limit 50 --dry-run
  ddel clean work-dm --limit all --delay 1500
  ddel clean general --contains "oops" --limit all --yes
`;

// --- helpers -----------------------------------------------------------------

function parseLimit(v, fallback) {
  if (v === undefined) return fallback;
  if (v === 'all' || v === true) return Infinity;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid limit: ${v}`);
  return n;
}

function parseDate(v, label) {
  if (v === undefined) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid ${label} date: ${v}`);
  return d;
}

function channelLabel(ch) {
  if (ch.name) return `#${ch.name}`;
  const names = (ch.recipients ?? []).map((r) => r.global_name || r.username).join(', ');
  if (ch.type === 3) return `group DM: ${names || '(unnamed)'}`;
  return names ? `DM with ${names}` : `channel ${ch.id}`;
}

async function confirm(question) {
  if (!stdin.isTTY) {
    throw new Error('Not a TTY — pass --yes to run non-interactively.');
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
}

// --- commands ----------------------------------------------------------------

async function cmdWhoami(api, cfg) {
  const me = await api.me();
  console.log(
    `${c.green('OK')} authenticated as ${c.bold(me.global_name || me.username)} ` +
      c.dim(`(${me.username}, id ${me.id})`)
  );
  console.log(c.dim(`   token type: ${cfg.tokenType}`));
}

async function cmdListDms(api) {
  const channels = await api.dmChannels();
  if (!channels || channels.length === 0) {
    console.log(c.dim('No open DM channels. Open the conversation in Discord first, then retry.'));
    return;
  }
  console.log(c.bold(`\n${channels.length} DM channel(s):\n`));
  for (const ch of channels) {
    console.log(`  ${c.cyan(ch.id.padEnd(20))} ${channelLabel(ch)}`);
  }
  console.log(c.dim('\nAdd the ones you want to clean to "targets" in config.json to give them names.\n'));
}

async function cmdListGuilds(api) {
  const guilds = await api.guilds();
  console.log(c.bold(`\n${guilds.length} server(s):\n`));
  for (const g of guilds) {
    console.log(`  ${c.cyan(g.id.padEnd(20))} ${g.name}`);
  }
  console.log(c.dim('\nUse "ddel list channels <guildId>" to see its channels.\n'));
}

async function cmdListChannels(api, guildId) {
  if (!guildId) throw new Error('Usage: ddel list channels <guildId>');
  const channels = await api.guildChannels(guildId);
  const text = channels.filter((ch) => [0, 5, 11, 12].includes(ch.type));
  console.log(c.bold(`\n${text.length} text channel(s):\n`));
  for (const ch of text) {
    console.log(`  ${c.cyan(ch.id.padEnd(20))} #${ch.name}`);
  }
  console.log('');
}

function cmdTargets(cfg) {
  const entries = Object.entries(cfg.targets || {});
  if (entries.length === 0) {
    console.log(c.dim('No aliases defined. Add a "targets" object to config.json.'));
    return;
  }
  console.log(c.bold('\nConfigured targets:\n'));
  for (const [name, id] of entries) {
    console.log(`  ${name.padEnd(24)} ${c.cyan(id)}`);
  }
  console.log('');
}

async function cmdClean(api, cfg, positional, flags) {
  if (positional.length === 0) {
    throw new Error('No target given. Try "ddel list dms" to find one.');
  }

  const ids = positional.map((t) => resolveTarget(cfg, t));
  const limit = parseLimit(flags.limit, 50);
  const scanLimit = parseLimit(flags['scan-limit'], Infinity);
  const delayMs = flags.delay !== undefined ? Number(flags.delay) : cfg.delayMs;
  const pauseEvery =
    flags['pause-every'] !== undefined ? Number(flags['pause-every']) : cfg.pauseEvery;
  const pauseMs = flags.pause !== undefined ? Number(flags.pause) : cfg.pauseMs;
  const dryRun = Boolean(flags['dry-run']);
  const bulk = Boolean(flags.bulk);
  const contains = typeof flags.contains === 'string' ? flags.contains : undefined;
  const before = parseDate(flags.before, '--before');
  const after = parseDate(flags.after, '--after');

  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error(`Invalid --delay: ${flags.delay}`);
  if (bulk && cfg.tokenType !== 'bot') {
    throw new Error(
      '--bulk needs a bot token with Manage Messages; it is not available to user accounts.'
    );
  }

  const me = await api.me();
  const who = me.global_name || me.username;

  // Resolve channel names up front so the confirmation is unambiguous.
  const channels = [];
  for (const id of ids) {
    try {
      channels.push(await api.channel(id));
    } catch (err) {
      throw new Error(`Cannot access channel ${id}: ${err.message}`);
    }
  }

  console.log('');
  console.log(c.bold(dryRun ? 'DRY RUN - nothing will be deleted' : 'About to delete messages'));
  console.log(`  account   ${who} ${c.dim(`(${me.id})`)}`);
  console.log(`  channels  ${channels.map(channelLabel).join(', ')}`);
  console.log(`  limit     ${limit === Infinity ? 'ALL your messages' : `${limit} per channel`}`);
  if (contains) console.log(`  contains  "${contains}"`);
  if (before) console.log(`  before    ${before.toISOString()}`);
  if (after) console.log(`  after     ${after.toISOString()}`);
  console.log(`  delay     ${delayMs}ms between deletes, ${pauseMs}ms every ${pauseEvery}`);
  console.log('');

  if (!dryRun && !flags.yes) {
    console.log(
      c.red('  Deleting Discord messages is permanent - there is no undo and no recycle bin.')
    );
    if (limit === Infinity) {
      console.log(c.red('  --limit all means every message you ever sent in these channels.'));
    }
    const ok = await confirm(c.yellow('\n  Type "yes" to proceed: '));
    if (!ok) {
      console.log(c.dim('  Aborted, nothing was deleted.'));
      return;
    }
    console.log('');
  }

  const results = [];
  for (const ch of channels) {
    const label = channelLabel(ch);
    console.log(c.bold(`\n> ${label}`) + c.dim(` (${ch.id})`));

    const started = Date.now();
    const { stats, failures } = await cleanChannel(api, {
      channelId: ch.id,
      userId: me.id,
      limit,
      scanLimit,
      delayMs,
      pauseEvery,
      pauseMs,
      dryRun,
      bulk,
      contains,
      before,
      after,
      onEvent: (e) => {
        switch (e.type) {
          case 'deleted': {
            const preview = (e.message.content || '').replace(/\s+/g, ' ').slice(0, 60);
            const when = snowflakeToDate(e.message.id).toISOString().slice(0, 10);
            console.log(
              `  ${dryRun ? c.yellow('would delete') : c.green('deleted')} ` +
                c.dim(`${when} `) +
                (preview || c.dim('(no text - attachment or embed)'))
            );
            break;
          }
          case 'bulk':
            console.log(`  ${c.green(`bulk-deleted ${e.count}`)}`);
            break;
          case 'bulk-failed':
            console.log(
              c.yellow(
                `  bulk delete unavailable (${e.error.message}) - falling back to one at a time`
              )
            );
            break;
          case 'gone':
            console.log(c.dim('  already gone'));
            break;
          case 'failed':
            console.log(c.red(`  failed ${e.message.id}: ${e.error.message}`));
            break;
          case 'pause':
            console.log(c.dim(`  ... pausing ${e.ms}ms to stay under the rate limit`));
            break;
          case 'limit':
            console.log(c.dim('  reached --limit'));
            break;
          case 'scan-limit':
            console.log(c.dim('  reached --scan-limit'));
            break;
          case 'after-boundary':
            console.log(c.dim('  reached --after boundary'));
            break;
        }
      },
    });

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      `  ${c.bold('summary')} scanned ${stats.scanned}, matched ${stats.matched}, ` +
        `${dryRun ? 'would delete' : 'deleted'} ${c.green(stats.deleted)}, ` +
        `skipped ${stats.skipped}, failed ${stats.failed ? c.red(stats.failed) : 0} ` +
        c.dim(`in ${secs}s`)
    );
    results.push({ channelId: ch.id, label, stats, failures });
  }

  if (flags.json) {
    console.log('\n' + JSON.stringify({ dryRun, results }, null, 2));
  }
  console.log('');
}

// --- entry -------------------------------------------------------------------

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional.shift();

  if (!command || flags.help || command === 'help') {
    console.log(HELP);
    return;
  }

  const cfg = loadConfig();
  const api = new DiscordAPI(cfg.token, {
    tokenType: cfg.tokenType,
    userAgent: cfg.userAgent,
  });

  switch (command) {
    case 'whoami':
      return cmdWhoami(api, cfg);
    case 'targets':
      return cmdTargets(cfg);
    case 'list': {
      const what = positional.shift();
      if (what === 'dms') return cmdListDms(api);
      if (what === 'guilds') return cmdListGuilds(api);
      if (what === 'channels') return cmdListChannels(api, positional.shift());
      throw new Error('Usage: ddel list <dms|guilds|channels <guildId>>');
    }
    case 'clean':
      return cmdClean(api, cfg, positional, flags);
    default:
      throw new Error(`Unknown command "${command}". Run "ddel help".`);
  }
}

main().catch((err) => {
  if (err instanceof DiscordError && err.status === 401) {
    console.error(
      c.red('\nToken rejected (401). It is wrong, expired, or was invalidated by a password change.\n')
    );
  } else {
    console.error(c.red(`\n${err.message}\n`));
  }
  process.exitCode = 1;
});
