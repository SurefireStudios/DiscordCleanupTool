'use strict';

const KEY = document.querySelector('meta[name="dashboard-key"]').content;
const $ = (id) => document.getElementById(id);

/** Selected channels: id -> {id, name} */
const selection = new Map();
let currentTab = 'dms';
let cache = { dms: [], guilds: [], channels: new Map() };
let activeJob = null;

// --- transport ---------------------------------------------------------------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'x-dashboard-key': KEY,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// --- rendering ---------------------------------------------------------------

function setConnected(user, tokenType) {
  const connected = Boolean(user);
  $('status-dot').classList.toggle('on', connected);
  $('whoami').textContent = '';
  if (connected) {
    const name = document.createElement('strong');
    name.textContent = user.global_name || user.username;
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = `  ${tokenType} token`;
    $('whoami').append(name, meta);
  } else {
    const span = document.createElement('span');
    span.className = 'muted';
    span.textContent = 'not connected';
    $('whoami').append(span);
  }
  $('panel-pick').classList.toggle('disabled', !connected);
  $('panel-options').classList.toggle('disabled', !connected);
  $('connected-actions').classList.toggle('hidden', !connected);
  $('token').disabled = connected;
  $('token-type').disabled = connected;
  $('btn-connect').disabled = connected;
  $('btn-connect').textContent = connected ? 'Connected' : 'Connect';
  if (connected) {
    $('token').value = '';
    $('token-hint').classList.add('hidden');
    $('token-help').open = false;
  }
}

function renderList(items) {
  const list = $('channel-list');
  const needle = $('filter').value.trim().toLowerCase();
  const shown = needle ? items.filter((i) => i.name.toLowerCase().includes(needle)) : items;

  list.textContent = '';
  if (shown.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted pad';
    p.textContent = items.length
      ? 'Nothing matches that filter.'
      : currentTab === 'dms'
        ? 'No open DMs. Open the conversation in Discord, then hit Refresh.'
        : 'No channels here.';
    list.append(p);
    return;
  }

  for (const item of shown) {
    const row = document.createElement('label');
    row.className = 'item';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = selection.has(item.id);
    box.addEventListener('change', () => {
      if (box.checked) selection.set(item.id, { id: item.id, name: item.name });
      else selection.delete(item.id);
      updateSelectionSummary();
    });

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name; // textContent: names come from Discord, never trust as markup

    row.append(box, name);

    if (item.isGroup || item.type === 3) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'group';
      row.append(tag);
    }
    list.append(row);
  }
}

function updateSelectionSummary() {
  const n = selection.size;
  const el = $('selected-summary');
  if (n === 0) {
    el.textContent = 'Nothing selected.';
  } else {
    const names = [...selection.values()].map((s) => s.name);
    const head = names.slice(0, 3).join(', ');
    el.textContent = `${n} selected: ${head}${names.length > 3 ? `, +${names.length - 3} more` : ''}`;
  }
  $('btn-run').disabled = n === 0;
}

function updateRunButton() {
  const dry = $('dry-run').checked;
  $('btn-run').textContent = dry ? 'Preview' : 'Delete';
  $('btn-run').classList.toggle('primary', dry);
  $('btn-run').classList.toggle('danger-btn', !dry);
}

function chosenLimit() {
  const picked = document.querySelector('input[name="limit"]:checked').value;
  if (picked === 'custom') return Number($('limit-custom').value) || 50;
  return picked === 'all' ? 'all' : Number(picked);
}

// --- loading -----------------------------------------------------------------

async function loadDms() {
  $('guild-picker').classList.add('hidden');
  const { channels } = await api('/api/dms');
  cache.dms = channels;
  renderList(channels);
}

async function loadGuilds() {
  $('guild-picker').classList.remove('hidden');
  if (cache.guilds.length === 0) {
    const { guilds } = await api('/api/guilds');
    cache.guilds = guilds;
    const sel = $('guild-select');
    sel.textContent = '';
    for (const g of guilds) {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = g.name;
      sel.append(opt);
    }
  }
  if (cache.guilds.length === 0) {
    renderList([]);
    return;
  }
  await loadGuildChannels($('guild-select').value || cache.guilds[0].id);
}

async function loadGuildChannels(guildId) {
  if (!cache.channels.has(guildId)) {
    const { channels } = await api(`/api/guilds/${guildId}/channels`);
    cache.channels.set(guildId, channels);
  }
  renderList(cache.channels.get(guildId));
}

async function refresh() {
  try {
    $('channel-list').textContent = '';
    const p = document.createElement('p');
    p.className = 'muted pad';
    p.textContent = 'Loading…';
    $('channel-list').append(p);
    if (currentTab === 'dms') await loadDms();
    else await loadGuilds();
  } catch (err) {
    logLine(`Could not load: ${err.message}`, 'l-failed');
    $('channel-list').textContent = '';
    const p = document.createElement('p');
    p.className = 'muted pad';
    p.textContent = err.message;
    $('channel-list').append(p);
  }
}

// --- log ---------------------------------------------------------------------

function logLine(text, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text; // never innerHTML — message content is untrusted
  const log = $('log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.append(line);
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function setStats(s) {
  if (!s) return;
  $('s-scanned').textContent = s.scanned;
  $('s-matched').textContent = s.matched;
  $('s-deleted').textContent = s.deleted;
  $('s-skipped').textContent = s.skipped;
  $('s-failed').textContent = s.failed;
}

// --- running -----------------------------------------------------------------

function buildPayload() {
  const before = $('before').value;
  const after = $('after').value;
  return {
    channels: [...selection.values()],
    limit: chosenLimit(),
    delayMs: Number($('delay').value),
    pauseEvery: Number($('pause-every').value),
    pauseMs: Number($('pause-ms').value),
    dryRun: $('dry-run').checked,
    contains: $('contains').value.trim() || undefined,
    before: before || undefined,
    after: after || undefined,
  };
}

async function startRun(payload) {
  $('panel-run').classList.remove('hidden');
  $('log').textContent = '';
  setStats({ scanned: 0, matched: 0, deleted: 0, skipped: 0, failed: 0 });
  $('s-deleted-label').textContent = payload.dryRun ? 'would delete' : 'deleted';
  $('run-title').textContent = payload.dryRun ? 'Dry run — nothing is being deleted' : 'Deleting';
  $('btn-stop').disabled = false;
  $('btn-run').disabled = true;
  $('panel-run').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const { jobId } = await api('/api/clean', { method: 'POST', body: payload });
  activeJob = jobId;

  // Stream progress. fetch + reader rather than EventSource so the key travels
  // in a header instead of the URL.
  const res = await fetch(`/api/jobs/${jobId}/events`, { headers: { 'x-dashboard-key': KEY } });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop();
    for (const chunk of chunks) {
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      handleEvent(JSON.parse(line.slice(6)), payload.dryRun);
    }
  }
  finishRun();
}

function handleEvent(e, dryRun) {
  setStats(e.stats);
  switch (e.type) {
    case 'channel-start':
      logLine(`\n▸ ${e.name}`, 'l-head');
      break;
    case 'deleted':
      logLine(
        `${dryRun ? 'would delete' : 'deleted'}  ${e.preview?.content || '(no text — attachment or embed)'}`,
        dryRun ? 'l-dry' : 'l-deleted'
      );
      break;
    case 'bulk':
      logLine(`bulk-deleted ${e.count}`, 'l-deleted');
      break;
    case 'gone':
      logLine('already gone', 'l-sys');
      break;
    case 'failed':
      logLine(`failed: ${e.error}`, 'l-failed');
      break;
    case 'pause':
      logLine(`… pausing ${e.ms}ms to stay under the rate limit`, 'l-sys');
      break;
    case 'limit':
      logLine('reached the limit for this chat', 'l-sys');
      break;
    case 'scan-limit':
      logLine('reached the scan limit', 'l-sys');
      break;
    case 'after-boundary':
      logLine('reached the date boundary', 'l-sys');
      break;
    case 'stopped':
      logLine('stopped by you', 'l-sys');
      break;
    case 'channel-done':
      logLine(
        `summary: scanned ${e.stats.scanned}, matched ${e.stats.matched}, ` +
          `${dryRun ? 'would delete' : 'deleted'} ${e.stats.deleted}, ` +
          `skipped ${e.stats.skipped}, failed ${e.stats.failed}`
      );
      break;
    case 'fatal':
      logLine(`stopped on error: ${e.error}`, 'l-failed');
      break;
    case 'done':
      logLine(e.stopped ? '\nRun stopped.' : '\nRun complete.', 'l-head');
      break;
  }
}

function finishRun() {
  activeJob = null;
  $('btn-stop').disabled = true;
  $('btn-run').disabled = selection.size === 0;
  $('run-title').textContent = 'Finished';
}

// --- confirmation ------------------------------------------------------------

function confirmRun(payload) {
  return new Promise((done) => {
    const isAll = payload.limit === 'all';
    const body = $('modal-body');
    body.textContent = '';

    const list = document.createElement('ul');
    const add = (label, value) => {
      const li = document.createElement('li');
      li.textContent = `${label}: ${value}`;
      list.append(li);
    };
    add('Chats', [...selection.values()].map((s) => s.name).join(', '));
    add('Limit', isAll ? 'every message you ever sent' : `${payload.limit} of your messages each`);
    if (payload.contains) add('Only containing', `"${payload.contains}"`);
    if (payload.before) add('Older than', payload.before);
    if (payload.after) add('Newer than', payload.after);
    add('Pacing', `${payload.delayMs}ms between deletes`);
    body.append(list);

    const note = document.createElement('p');
    note.className = 'danger-note';
    note.textContent = isAll
      ? 'This cannot be undone. There is no trash and no export. In a DM it also removes the messages from the other person’s client.'
      : 'This cannot be undone. There is no trash and no export.';
    body.append(note);

    $('modal-typeit-wrap').classList.toggle('hidden', !isAll);
    $('modal-typeit').value = '';
    $('modal-go').disabled = isAll;
    $('modal').classList.remove('hidden');

    const cleanup = (result) => {
      $('modal').classList.add('hidden');
      $('modal-go').onclick = null;
      $('modal-cancel').onclick = null;
      $('modal-typeit').oninput = null;
      done(result);
    };
    $('modal-typeit').oninput = () => {
      $('modal-go').disabled = $('modal-typeit').value.trim().toUpperCase() !== 'DELETE';
    };
    $('modal-go').onclick = () => cleanup(true);
    $('modal-cancel').onclick = () => cleanup(false);
    if (isAll) $('modal-typeit').focus();
  });
}

// --- token help --------------------------------------------------------------

/**
 * Sanity-check a pasted token locally. Nothing is sent anywhere — this only
 * looks at the shape, so the user catches a bad copy-paste before connecting.
 * Discord tokens are three base64url segments; the first decodes to the
 * account's snowflake id.
 */
function inspectToken(raw) {
  const token = raw.trim();
  if (!token) return { state: 'empty' };
  // Check the "Bot " prefix before the whitespace rule, or it gets swallowed by it.
  if (token.toLowerCase().startsWith('bot ')) {
    return { state: 'bad', message: 'Drop the "Bot " prefix — paste only the token and set Type to Bot.' };
  }
  if (/\s/.test(token)) return { state: 'bad', message: 'That contains spaces or line breaks — copy just the token.' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    return { state: 'warn', message: "That doesn't look like a Discord token (expected three dot-separated parts). You can still try it." };
  }
  let accountId = null;
  try {
    const pad = parts[0].replace(/-/g, '+').replace(/_/g, '/');
    accountId = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  } catch {
    /* not decodable — not fatal, formats change */
  }
  if (accountId && /^\d{17,20}$/.test(accountId)) {
    return { state: 'ok', message: `Looks like a valid token for account ID ${accountId}.` };
  }
  return { state: 'warn', message: 'Shape looks right, but the account ID could not be read. You can still try it.' };
}

function updateTokenHint() {
  const el = $('token-hint');
  const result = inspectToken($('token').value);
  el.classList.toggle('hidden', result.state === 'empty');
  el.classList.toggle('bad', result.state === 'bad');
  el.classList.toggle('ok', result.state === 'ok');
  el.textContent = result.message || '';
}

function updateHelpVariant() {
  const isBot = $('token-type').value === 'bot';
  $('help-user').classList.toggle('hidden', isBot);
  $('help-bot').classList.toggle('hidden', !isBot);
}

// --- wiring ------------------------------------------------------------------

$('token').addEventListener('input', updateTokenHint);
$('token-type').addEventListener('change', () => {
  updateHelpVariant();
  updateTokenHint();
});
$('token').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-connect').click();
});

$('btn-connect').addEventListener('click', async () => {
  $('btn-connect').disabled = true;
  try {
    const { user, tokenType } = await api('/api/connect', {
      method: 'POST',
      body: { token: $('token').value.trim() || undefined, tokenType: $('token-type').value },
    });
    setConnected(user, tokenType);
    await refresh();
  } catch (err) {
    $('btn-connect').disabled = false;
    $('connect-note').textContent = err.message;
    $('connect-note').classList.add('warn');
  }
});

$('btn-disconnect').addEventListener('click', async () => {
  await api('/api/disconnect', { method: 'POST' });
  selection.clear();
  cache = { dms: [], guilds: [], channels: new Map() };
  updateSelectionSummary();
  setConnected(null, null);
  $('channel-list').textContent = '';
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', async () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.remove('active');
    tab.classList.add('active');
    currentTab = tab.dataset.tab;
    $('filter').value = '';
    await refresh();
  });
}

$('guild-select').addEventListener('change', (e) => loadGuildChannels(e.target.value));
$('btn-refresh').addEventListener('click', () => {
  cache.channels.clear();
  cache.guilds = [];
  refresh();
});
$('btn-clear-sel').addEventListener('click', () => {
  selection.clear();
  updateSelectionSummary();
  refresh();
});
$('filter').addEventListener('input', () => {
  if (currentTab === 'dms') renderList(cache.dms);
  else loadGuildChannels($('guild-select').value);
});

for (const radio of document.querySelectorAll('input[name="limit"]')) {
  radio.addEventListener('change', () => {
    $('limit-custom').disabled = document.querySelector('input[name="limit"]:checked').value !== 'custom';
  });
}

$('dry-run').addEventListener('change', updateRunButton);

$('btn-run').addEventListener('click', async () => {
  const payload = buildPayload();
  if (!payload.dryRun) {
    const ok = await confirmRun(payload);
    if (!ok) return;
  }
  try {
    await startRun(payload);
  } catch (err) {
    logLine(`Could not start: ${err.message}`, 'l-failed');
    finishRun();
  }
});

$('btn-stop').addEventListener('click', async () => {
  if (!activeJob) return;
  $('btn-stop').disabled = true;
  logLine('stopping after the current message…', 'l-sys');
  await api(`/api/jobs/${activeJob}/stop`, { method: 'POST' });
});

// --- boot --------------------------------------------------------------------

(async () => {
  updateRunButton();
  updateSelectionSummary();
  updateHelpVariant();
  try {
    const status = await api('/api/status');
    if (status.autoToken) {
      $('connect-note').textContent =
        'A token was found in your config or environment. Click Connect to use it — you do not need to paste anything.';
      $('token').placeholder = 'using token from config/env';
    } else {
      // Nothing configured — the first thing they need is the instructions.
      $('token-help').open = true;
    }
    if (status.connected) {
      setConnected(status.user, status.tokenType);
      await refresh();
    }
  } catch (err) {
    $('connect-note').textContent = `Could not reach the local server: ${err.message}`;
  }
})();
