// Exercises the dashboard HTTP layer against a stubbed Discord API.
// Nothing here touches the network beyond loopback.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';

const EPOCH = 1420070400000n;
const snow = (ms) => ((BigInt(ms) - EPOCH) << 22n).toString();
const base = Date.now() - 100 * 3600_000;
const store = [];
for (let i = 0; i < 60; i++) {
  store.push({
    id: snow(base + i * 3600_000),
    type: 0,
    author: { id: '111' },
    content: i === 50 ? '<img src=x onerror=alert(1)>' : `msg ${i}`,
  });
}
store.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
const deletedIds = new Set();

const json = (b, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });

const realFetch = globalThis.fetch;

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  // Only stand in for Discord; the test's own loopback calls must go through.
  if (u.hostname !== 'discord.com') return realFetch(url, opts);
  const p = u.pathname.replace('/api/v10', '');
  if (p === '/users/@me') {
    if (!opts.headers?.Authorization || opts.headers.Authorization === 'bad')
      return json({ message: '401: Unauthorized' }, 401);
    return json({ id: '111', username: 'me', global_name: 'Me' });
  }
  if (p === '/users/@me/channels')
    return json([{ id: '900000000000000001', type: 1, recipients: [{ username: 'alex' }] }]);
  if (p === '/users/@me/guilds') return json([{ id: '800000000000000001', name: 'My Server' }]);
  if (p === '/guilds/800000000000000001/channels')
    return json([{ id: '700000000000000001', name: 'general', type: 0, position: 0 }]);
  if (/^\/channels\/\d+$/.test(p))
    return json({ id: p.split('/')[2], type: 1, recipients: [{ username: 'alex' }] });
  if (/^\/channels\/\d+\/messages$/.test(p)) {
    const before = u.searchParams.get('before');
    let pool = store.filter((m) => !deletedIds.has(m.id));
    if (before) pool = pool.filter((m) => BigInt(m.id) < BigInt(before));
    return json(pool.slice(0, Number(u.searchParams.get('limit') || 100)));
  }
  const del = p.match(/^\/channels\/\d+\/messages\/(\d+)$/);
  if (del && opts.method === 'DELETE') {
    deletedIds.add(del[1]);
    return new Response(null, { status: 204 });
  }
  return json({ message: 'not stubbed ' + p }, 404);
};

const { createDashboard } = await import('../src/server.js');

const PORT = 8899;
const { listen, key, server } = createDashboard({ port: PORT });
const origin = await listen();
const ORIGIN = origin.replace(/\/$/, '');

let passed = 0;
const ok = (n) => {
  console.log(`  ok  ${n}`);
  passed++;
};

const call = (path, { method = 'GET', body, headers = {} } = {}) =>
  fetch(ORIGIN + path, {
    method,
    headers: { 'x-dashboard-key': key, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

// --- security guards ---------------------------------------------------------
{
  const res = await call('/api/status', { headers: { 'x-dashboard-key': 'wrong' } });
  assert.equal(res.status, 401);
  ok('rejects a wrong dashboard key');
}
{
  const res = await fetch(ORIGIN + '/api/status');
  assert.equal(res.status, 401);
  ok('rejects a missing dashboard key');
}
{
  const res = await call('/api/status', { headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
  ok('rejects a cross-origin request (CSRF)');
}
{
  // fetch() forbids overriding Host, so go through the raw http client.
  const status = await new Promise((done, fail) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/api/status',
        headers: { Host: 'evil.example', 'x-dashboard-key': key },
      },
      (res) => {
        res.resume();
        done(res.statusCode);
      }
    );
    req.on('error', fail);
    req.end();
  });
  assert.equal(status, 403);
  ok('rejects a non-loopback Host header (DNS rebinding)');
}
{
  assert.equal(server.address().address, '127.0.0.1');
  ok('bound to loopback only, not 0.0.0.0');
}

// --- connect -----------------------------------------------------------------
{
  const res = await call('/api/connect', { method: 'POST', body: { token: 'bad' } });
  assert.equal(res.status, 401);
  ok('a rejected token surfaces as 401, not a crash');
}
{
  const res = await call('/api/connect', { method: 'POST', body: { token: 'good', tokenType: 'user' } });
  const data = await res.json();
  assert.equal(data.user.id, '111');
  assert.ok(!JSON.stringify(data).includes('good'), 'response must not echo the token');
  ok('connects and never echoes the token back');
}
{
  const res = await call('/api/status');
  const data = await res.json();
  assert.equal(data.connected, true);
  assert.ok(!JSON.stringify(data).includes('good'), 'status must not leak the token');
  ok('status reports connection without leaking the token');
}

// --- discovery ---------------------------------------------------------------
{
  const dms = await (await call('/api/dms')).json();
  assert.equal(dms.channels[0].name, 'alex');
  const guilds = await (await call('/api/guilds')).json();
  assert.equal(guilds.guilds[0].name, 'My Server');
  const chans = await (await call('/api/guilds/800000000000000001/channels')).json();
  assert.equal(chans.channels[0].name, '#general');
  ok('lists DMs, servers and channels');
}

// --- a dry run deletes nothing ----------------------------------------------
async function runJob(body) {
  const { jobId } = await (await call('/api/clean', { method: 'POST', body })).json();
  const res = await call(`/api/jobs/${jobId}/events`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data: '));
      if (line) events.push(JSON.parse(line.slice(6)));
    }
  }
  return { jobId, events };
}

{
  const before = deletedIds.size;
  const { events } = await runJob({
    channels: [{ id: '900000000000000001', name: 'alex' }],
    limit: 10,
    delayMs: 0,
    pauseEvery: 0,
    dryRun: true,
  });
  assert.equal(deletedIds.size, before, 'dry run must not delete');
  const done = events.find((e) => e.type === 'channel-done');
  assert.equal(done.stats.deleted, 10);
  ok('dry run streams 10 would-deletes and removes nothing');
}

// --- a real run --------------------------------------------------------------
{
  const { events } = await runJob({
    channels: [{ id: '900000000000000001', name: 'alex' }],
    limit: 5,
    delayMs: 0,
    pauseEvery: 0,
    dryRun: false,
  });
  assert.equal(deletedIds.size, 5);
  assert.ok(events.some((e) => e.type === 'done'));
  ok('real run deletes exactly the requested count');
}

// --- event payloads are minimal ---------------------------------------------
{
  const { events } = await runJob({
    channels: [{ id: '900000000000000001', name: 'alex' }],
    limit: 20,
    delayMs: 0,
    pauseEvery: 0,
    dryRun: true,
  });
  const withPreview = events.filter((e) => e.preview);
  assert.ok(withPreview.length > 0);
  for (const e of withPreview) {
    assert.deepEqual(Object.keys(e.preview).sort(), ['content', 'id']);
    assert.equal(e.author, undefined, 'author objects must not be forwarded to the browser');
  }
  const xss = withPreview.find((e) => e.preview.content.includes('onerror'));
  assert.ok(xss, 'raw content passes through as data (UI renders it via textContent)');
  ok('streamed events carry only id + trimmed content, no author or attachment data');
}

// --- stop --------------------------------------------------------------------
{
  const { jobId } = await (
    await call('/api/clean', {
      method: 'POST',
      body: {
        channels: [{ id: '900000000000000001', name: 'alex' }],
        limit: 'all',
        delayMs: 200,
        pauseEvery: 0,
        dryRun: true,
      },
    })
  ).json();
  await new Promise((r) => setTimeout(r, 250));
  await call(`/api/jobs/${jobId}/stop`, { method: 'POST' });
  const res = await call(`/api/jobs/${jobId}/events`);
  const text = await res.text();
  assert.ok(text.includes('"stopped"') || text.includes('"done"'));
  ok('a running job can be stopped mid-flight');
}

// --- disconnect --------------------------------------------------------------
{
  await call('/api/disconnect', { method: 'POST' });
  const res = await call('/api/dms');
  assert.equal(res.status, 401);
  ok('disconnect clears the session');
}

// --- static serving ----------------------------------------------------------
{
  const res = await fetch(`${ORIGIN}/`);
  const html = await res.text();
  assert.ok(html.includes(key), 'page receives the key inline');
  assert.ok(!html.includes('__DASHBOARD_KEY__'), 'placeholder was substituted');
  assert.ok(res.headers.get('content-security-policy').includes("default-src 'none'"));
  ok('serves the page with the key injected and a strict CSP');
}
{
  const html = await (await fetch(`${ORIGIN}/`)).text();
  assert.ok(html.includes('github.com/SurefireStudios/DiscordCleanupTool'), 'footer repo link');
  assert.ok(!html.includes('__REPO_URL__'), 'repo placeholder substituted');
  assert.ok(!html.includes('__VERSION__'), 'version placeholder substituted');
  assert.ok(!html.includes('__LICENSE__'), 'license placeholder substituted');
  ok('footer is populated from package.json metadata');
}
{
  const html = await (await fetch(`${ORIGIN}/`)).text();
  const { DISPLAY_NAME, VERSION } = await import('../src/meta.js');
  assert.ok(html.includes(`<title>${DISPLAY_NAME}</title>`), 'page title matches the project name');
  assert.ok(html.includes(`<h1>${DISPLAY_NAME}</h1>`), 'heading matches the project name');
  assert.ok(html.includes(`v${VERSION}`), 'footer shows the real version');
  assert.ok(!/__[A-Z_]+__/.test(html), 'no unsubstituted placeholders remain');
  ok('served page carries the project name and version, no placeholders left');
}
{
  const res = await fetch(`${ORIGIN}/../src/config.js`);
  assert.ok(res.status === 404 || res.status === 403, `expected block, got ${res.status}`);
  ok('path traversal out of public/ is blocked');
}

server.close();
console.log(`\n${passed}/18 checks passed\n`);
