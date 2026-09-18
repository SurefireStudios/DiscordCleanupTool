#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createDashboard } from './server.js';
import { loadConfig } from './config.js';

const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port'));
const port = portArg ? Number(portArg.split('=')[1] ?? args[args.indexOf(portArg) + 1]) : 8787;
const noOpen = args.includes('--no-open');

// A token in config/env is a convenience, not a requirement — the UI can take one.
let cfg = {};
try {
  cfg = loadConfig();
} catch {
  cfg = {};
}

const { listen } = createDashboard({
  port,
  token: cfg.token,
  tokenType: cfg.tokenType,
  userAgent: cfg.userAgent,
});

const url = await listen();

console.log(`
  Discord cleanup dashboard

  ${url}

  ${cfg.token ? 'Token loaded from config/env — just click Connect.' : 'No token configured; the page will ask for one.'}
  Listening on loopback only. Nothing on your network can reach it.
  Press Ctrl+C to stop the server (that also clears the token from memory).
`);

if (!noOpen) {
  const cmd =
    process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(cmd, [url], { shell: process.platform === 'win32', stdio: 'ignore', detached: true }).unref();
  } catch {
    /* opening a browser is best-effort; the URL is printed above */
  }
}
