import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiscordAPI, DiscordError } from './api.js';
import { cleanChannel } from './cleaner.js';
import { DEFAULTS } from './config.js';
import { DISPLAY_NAME, VERSION, LICENSE, REPO_URL } from './meta.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * Local-only dashboard server.
 *
 * Threat model: this process holds a Discord token that is equivalent to full
 * account access. It listens on loopback, but loopback alone is not a boundary —
 * any page in the user's browser can send requests to 127.0.0.1, and a hostile
 * page could otherwise drive deletions or read the token back. So:
 *
 *   - bind 127.0.0.1 explicitly (never 0.0.0.0)
 *   - require a random per-run key in a custom header on every /api call.
 *     Custom headers can't be set by a plain form post, so this also rules out
 *     classic CSRF, and no cookie is ever set.
 *   - reject any request whose Origin isn't our own, and any whose Host header
 *     isn't loopback — that closes DNS-rebinding, where an attacker's domain
 *     resolves to 127.0.0.1 to get same-origin treatment.
 *   - never include the token in any response body.
 */
export function createDashboard({ port = 8787, token, tokenType, userAgent } = {}) {
  const key = randomBytes(32).toString('hex');
  const origin = `http://127.0.0.1:${port}`;

  /** @type {{api: DiscordAPI, user: object, tokenType: string} | null} */
  let session = token ? null : null;
  let pending = token ? { token, tokenType: tokenType || 'user', userAgent } : null;

  /** @type {Map<string, object>} */
  const jobs = new Map();

  const safeEqual = (a, b) => {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  };

  const json = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(payload);
  };

  const readBody = (req) =>
    new Promise((resolveBody, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 1e6) {
          reject(new Error('Body too large'));
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          resolveBody(data ? JSON.parse(data) : {});
        } catch {
          reject(new Error('Body is not valid JSON'));
        }
      });
      req.on('error', reject);
    });

  async function handleApi(req, res, url) {
    // --- guards ---
    const host = (req.headers.host || '').split(':')[0];
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
      return json(res, 403, { error: 'Refused: unexpected Host header.' });
    }
    const reqOrigin = req.headers.origin;
    if (reqOrigin && reqOrigin !== origin && reqOrigin !== `http://localhost:${port}`) {
      return json(res, 403, { error: 'Refused: cross-origin request.' });
    }
    if (!safeEqual(req.headers['x-dashboard-key'] || '', key)) {
      return json(res, 401, { error: 'Bad or missing dashboard key. Reload the page.' });
    }

    const path = url.pathname;

    // --- connect / status ---
    if (path === '/api/status' && req.method === 'GET') {
      return json(res, 200, {
        connected: Boolean(session),
        user: session?.user ?? null,
        tokenType: session?.tokenType ?? null,
        autoToken: Boolean(pending),
        defaults: {
          delayMs: DEFAULTS.delayMs,
          pauseEvery: DEFAULTS.pauseEvery,
          pauseMs: DEFAULTS.pauseMs,
        },
      });
    }

    if (path === '/api/connect' && req.method === 'POST') {
      const body = await readBody(req);
      const useToken = body.token || pending?.token;
      const useType = body.tokenType || pending?.tokenType || 'user';
      if (!useToken) return json(res, 400, { error: 'No token supplied.' });
      const api = new DiscordAPI(useToken, {
        tokenType: useType,
        userAgent: pending?.userAgent,
      });
      const user = await api.me();
      session = { api, user, tokenType: useType };
      pending = null; // consumed
      return json(res, 200, { user, tokenType: useType });
    }

    if (path === '/api/disconnect' && req.method === 'POST') {
      for (const job of jobs.values()) job.stop = true;
      session = null;
      pending = null;
      return json(res, 200, { ok: true });
    }

    if (!session) return json(res, 401, { error: 'Not connected. Enter a token first.' });
    const { api } = session;

    // --- discovery ---
    if (path === '/api/dms' && req.method === 'GET') {
      const channels = await api.dmChannels();
      return json(res, 200, {
        channels: (channels || []).map((ch) => ({
          id: ch.id,
          type: ch.type,
          name:
            ch.name ||
            (ch.recipients || []).map((r) => r.global_name || r.username).join(', ') ||
            'Unnamed',
          isGroup: ch.type === 3,
        })),
      });
    }

    if (path === '/api/guilds' && req.method === 'GET') {
      const guilds = await api.guilds();
      return json(res, 200, { guilds: guilds.map((g) => ({ id: g.id, name: g.name })) });
    }

    const guildChannels = path.match(/^\/api\/guilds\/(\d+)\/channels$/);
    if (guildChannels && req.method === 'GET') {
      const channels = await api.guildChannels(guildChannels[1]);
      return json(res, 200, {
        channels: channels
          .filter((ch) => [0, 5, 11, 12].includes(ch.type))
          .map((ch) => ({ id: ch.id, name: `#${ch.name}`, type: ch.type, position: ch.position }))
          .sort((a, b) => a.position - b.position),
      });
    }

    // --- jobs ---
    if (path === '/api/clean' && req.method === 'POST') {
      const body = await readBody(req);
      const channels = Array.isArray(body.channels) ? body.channels : [];
      if (channels.length === 0) return json(res, 400, { error: 'No channels selected.' });

      const jobId = randomBytes(8).toString('hex');
      const job = {
        id: jobId,
        stop: false,
        done: false,
        events: [],
        listeners: new Set(),
        dryRun: Boolean(body.dryRun),
      };
      jobs.set(jobId, job);

      const emit = (event) => {
        job.events.push(event);
        for (const send of job.listeners) send(event);
      };

      // Run detached; the client follows along over the event stream.
      (async () => {
        try {
          for (const ch of channels) {
            if (job.stop) break;
            emit({ type: 'channel-start', channelId: ch.id, name: ch.name });
            const result = await cleanChannel(api, {
              channelId: ch.id,
              userId: session.user.id,
              limit: body.limit === 'all' ? Infinity : Number(body.limit) || 50,
              scanLimit: body.scanLimit ? Number(body.scanLimit) : Infinity,
              delayMs: Number.isFinite(Number(body.delayMs))
                ? Number(body.delayMs)
                : DEFAULTS.delayMs,
              pauseEvery: Number.isFinite(Number(body.pauseEvery))
                ? Number(body.pauseEvery)
                : DEFAULTS.pauseEvery,
              pauseMs: Number.isFinite(Number(body.pauseMs))
                ? Number(body.pauseMs)
                : DEFAULTS.pauseMs,
              dryRun: Boolean(body.dryRun),
              contains: body.contains || undefined,
              before: body.before ? new Date(body.before) : undefined,
              after: body.after ? new Date(body.after) : undefined,
              shouldStop: () => job.stop,
              onEvent: (e) => {
                // Strip everything but what the UI renders — no author objects,
                // no attachment URLs, nothing that isn't needed on screen.
                emit({
                  type: e.type,
                  channelId: ch.id,
                  stats: e.stats ? { ...e.stats } : undefined,
                  count: e.count,
                  ms: e.ms,
                  error: e.error ? String(e.error.message || e.error) : undefined,
                  preview: e.message
                    ? {
                        id: e.message.id,
                        content: (e.message.content || '').replace(/\s+/g, ' ').slice(0, 120),
                      }
                    : undefined,
                });
              },
            });
            emit({
              type: 'channel-done',
              channelId: ch.id,
              name: ch.name,
              stats: result.stats,
              failures: result.failures.length,
            });
          }
          emit({ type: 'done', stopped: job.stop });
        } catch (err) {
          emit({ type: 'fatal', error: String(err.message || err) });
        } finally {
          job.done = true;
          for (const send of job.listeners) send({ type: '__end__' });
          job.listeners.clear();
          setTimeout(() => jobs.delete(jobId), 5 * 60_000).unref?.();
        }
      })();

      return json(res, 200, { jobId });
    }

    const jobStop = path.match(/^\/api\/jobs\/([a-f0-9]+)\/stop$/);
    if (jobStop && req.method === 'POST') {
      const job = jobs.get(jobStop[1]);
      if (!job) return json(res, 404, { error: 'No such job.' });
      job.stop = true;
      return json(res, 200, { ok: true });
    }

    const jobEvents = path.match(/^\/api\/jobs\/([a-f0-9]+)\/events$/);
    if (jobEvents && req.method === 'GET') {
      const job = jobs.get(jobEvents[1]);
      if (!job) return json(res, 404, { error: 'No such job.' });

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      const send = (event) => {
        if (res.writableEnded) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === '__end__') res.end();
      };

      for (const event of job.events) send(event); // replay anything already emitted
      if (job.done) {
        send({ type: '__end__' });
      } else {
        job.listeners.add(send);
        req.on('close', () => job.listeners.delete(send));
      }
      return undefined;
    }

    return json(res, 404, { error: `Unknown endpoint: ${path}` });
  }

  async function serveStatic(req, res, url) {
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    // Resolve then confirm containment, so ../ can't escape public/.
    const filePath = join(PUBLIC, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!filePath.startsWith(PUBLIC)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try {
      let content = await readFile(filePath);
      if (rel === '/index.html') {
        // Hand the page its API key inline, so it never sits in the URL,
        // in history, or in a referrer header.
        content = content
          .toString('utf8')
          .replace('__DASHBOARD_KEY__', key)
          .replace('__PORT__', String(port))
          .replaceAll('__REPO_URL__', REPO_URL)
          .replaceAll('__DISPLAY_NAME__', DISPLAY_NAME)
          .replace('__VERSION__', VERSION)
          .replace('__LICENSE__', LICENSE);
      }
      res.writeHead(200, {
        'content-type': MIME[extname(filePath)] || 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy':
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
      });
      res.end(content);
    } catch {
      res.writeHead(404).end('Not found');
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else {
        await serveStatic(req, res, url);
      }
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = err instanceof DiscordError ? err.status : 500;
      json(res, status >= 400 && status < 600 ? status : 500, {
        error: String(err.message || err),
      });
    }
  });

  return {
    server,
    key,
    listen: () =>
      new Promise((done) => {
        // 127.0.0.1, never 0.0.0.0 — nothing on the network should reach this.
        server.listen(port, '127.0.0.1', () => done(`${origin}/`));
      }),
  };
}
