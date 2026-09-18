import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULTS = {
  tokenType: 'user',
  // ms between individual deletes. Discord's per-channel delete bucket is
  // strict (~5 requests / 5s, tighter for old messages); 1200ms is a safe idle.
  delayMs: 1200,
  // extra pause every N deletes, to stay clear of longer-window limits
  pauseEvery: 50,
  pauseMs: 5000,
  // optional override for the User-Agent header; defaults per tokenType
  userAgent: undefined,
  targets: {},
};

export function loadConfig() {
  const path = resolve(ROOT, 'config.json');
  let file = {};
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`config.json is not valid JSON: ${err.message}`);
    }
  }

  const cfg = { ...DEFAULTS, ...file };
  // env wins, so the token never has to touch disk
  if (process.env.DISCORD_TOKEN) cfg.token = process.env.DISCORD_TOKEN;
  if (process.env.DISCORD_TOKEN_TYPE) cfg.tokenType = process.env.DISCORD_TOKEN_TYPE;

  if (!cfg.token) {
    throw new Error(
      'No token found. Set DISCORD_TOKEN in the environment, or add "token" to config.json.'
    );
  }
  if (!['user', 'bot'].includes(cfg.tokenType)) {
    throw new Error(`tokenType must be "user" or "bot", got "${cfg.tokenType}".`);
  }
  return cfg;
}

/** Resolve a CLI target: a raw channel id, or an alias from config.targets. */
export function resolveTarget(cfg, target) {
  if (!target) return null;
  if (/^\d{17,20}$/.test(target)) return target;
  const mapped = cfg.targets?.[target];
  if (!mapped) {
    const known = Object.keys(cfg.targets ?? {});
    throw new Error(
      `Unknown target "${target}". Use a channel ID, or one of these aliases from config.json: ${
        known.length ? known.join(', ') : '(none defined)'
      }`
    );
  }
  return mapped;
}

export { ROOT };
