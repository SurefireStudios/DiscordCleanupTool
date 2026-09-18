import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Single source of truth for the project's identity.
 *
 * Everything that displays a name, version or link — the CLI header, the
 * dashboard footer, the User-Agent sent to Discord — reads from here, so those
 * can never drift apart from package.json the way they did before.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pkg = {};
try {
  pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
} catch {
  /* running from somewhere odd; the fallbacks below keep things working */
}

/** npm-style package name, lowercase and hyphenated. */
export const NAME = pkg.name || 'discord-cleanup-tool';

/** Human-facing name, used in headings and help output. */
export const DISPLAY_NAME = 'Discord Cleanup Tool';

export const VERSION = pkg.version || '0.0.0';

export const LICENSE = pkg.license || 'MIT';

export const REPO_URL =
  pkg.homepage ||
  pkg.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '') ||
  'https://github.com/SurefireStudios/DiscordCleanupTool';

/**
 * User-Agent for bot-token requests. Discord asks bot clients to identify with
 * a contact URL and version, so this must be real — not a placeholder.
 */
export const BOT_USER_AGENT = `DiscordBot (${REPO_URL}, ${VERSION})`;

export { ROOT };
