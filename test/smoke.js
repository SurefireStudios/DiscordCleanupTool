// Offline checks for the deletion engine. Uses a fake in-memory channel so the
// pagination, filtering and limit logic can be exercised without touching Discord.
import assert from 'node:assert/strict';
import { cleanChannel, matches } from '../src/cleaner.js';
import { dateToSnowflake, snowflakeToDate } from '../src/api.js';

const ME = '111';
const THEM = '222';

/** Build `count` alternating messages, newest last, spread one hour apart. */
function buildHistory(count, { start = new Date('2026-01-01T00:00:00Z') } = {}) {
  const msgs = [];
  for (let i = 0; i < count; i++) {
    const at = new Date(start.getTime() + i * 3600_000);
    msgs.push({
      id: dateToSnowflake(at),
      type: 0,
      author: { id: i % 2 === 0 ? ME : THEM },
      content: `message ${i}`,
    });
  }
  return msgs;
}

/** Minimal stand-in for DiscordAPI backed by an array. */
function fakeApi(messages) {
  const store = [...messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1)); // newest first
  const deleted = [];
  return {
    deleted,
    calls: { messages: 0, delete: 0 },
    async messages(_ch, { before, limit = 100 } = {}) {
      this.calls.messages++;
      let pool = store;
      if (before) pool = pool.filter((m) => BigInt(m.id) < BigInt(before));
      return pool.slice(0, limit);
    },
    async deleteMessage(_ch, id) {
      this.calls.delete++;
      const idx = store.findIndex((m) => m.id === id);
      if (idx === -1) {
        const err = new Error('Unknown Message');
        err.status = 404;
        throw err;
      }
      deleted.push(store[idx]);
      store.splice(idx, 1);
    },
    async bulkDelete(_ch, ids) {
      for (const id of ids) await this.deleteMessage(_ch, id);
    },
  };
}

const base = { userId: ME, delayMs: 0, pauseEvery: 0, pauseMs: 0, channelId: 'c1' };
let passed = 0;
function ok(name) {
  console.log(`  ok  ${name}`);
  passed++;
}

// 1. snowflake round-trip
{
  const d = new Date('2026-03-04T05:06:07.000Z');
  assert.equal(snowflakeToDate(dateToSnowflake(d)).getTime(), d.getTime());
  ok('snowflake <-> date round-trips');
}

// 2. only my own messages match
{
  const m = { id: dateToSnowflake(new Date()), type: 0, author: { id: THEM }, content: 'hi' };
  assert.equal(matches(m, { userId: ME }), false);
  assert.equal(matches({ ...m, author: { id: ME } }, { userId: ME }), true);
  ok("other people's messages are never matched");
}

// 3. system messages are skipped
{
  const m = { id: dateToSnowflake(new Date()), type: 7, author: { id: ME }, content: '' };
  assert.equal(matches(m, { userId: ME }), false);
  ok('system messages (joins, calls, pins) are skipped');
}

// 4. --limit 50 deletes exactly 50 of mine, none of theirs
{
  const api = fakeApi(buildHistory(400));
  const { stats } = await cleanChannel(api, { ...base, limit: 50 });
  assert.equal(stats.deleted, 50);
  assert.equal(api.deleted.length, 50);
  assert.ok(api.deleted.every((m) => m.author.id === ME));
  ok('--limit 50 deletes exactly 50, all mine');
}

// 5. --limit all clears every one of mine across pages, and leaves theirs alone
{
  const history = buildHistory(350);
  const mine = history.filter((m) => m.author.id === ME).length;
  const api = fakeApi(history);
  const { stats } = await cleanChannel(api, { ...base, limit: Infinity });
  assert.equal(stats.deleted, mine);
  assert.ok(api.calls.messages > 1, 'should have paginated');
  ok(`--limit all removed all ${mine} of mine across ${api.calls.messages} pages`);
}

// 6. dry run touches nothing
{
  const api = fakeApi(buildHistory(200));
  const { stats } = await cleanChannel(api, { ...base, limit: Infinity, dryRun: true });
  assert.ok(stats.deleted > 0);
  assert.equal(api.calls.delete, 0, 'dry run must not call DELETE');
  ok('--dry-run reports matches without issuing a single DELETE');
}

// 7. --contains filter
{
  const api = fakeApi(buildHistory(100));
  const { stats } = await cleanChannel(api, { ...base, limit: Infinity, contains: 'message 4' });
  // "message 4", "message 40".."message 49" -> the even-numbered (mine) ones
  assert.ok(api.deleted.every((m) => m.content.includes('message 4')));
  assert.ok(stats.deleted > 0);
  ok('--contains only removes matching text');
}

// 8. --before / --after windowing
{
  const start = new Date('2026-01-01T00:00:00Z');
  const api = fakeApi(buildHistory(200, { start }));
  const cutoff = new Date(start.getTime() + 100 * 3600_000);
  await cleanChannel(api, { ...base, limit: Infinity, before: cutoff });
  assert.ok(
    api.deleted.every((m) => snowflakeToDate(m.id) < cutoff),
    'nothing newer than --before should be deleted'
  );
  ok('--before only removes older messages');
}

// 9. --scan-limit caps how much history is read
{
  const api = fakeApi(buildHistory(1000));
  const { stats } = await cleanChannel(api, { ...base, limit: Infinity, scanLimit: 100 });
  assert.ok(stats.scanned <= 101);
  assert.ok(stats.deleted <= 51);
  ok('--scan-limit stops the walk early');
}

// 10. already-deleted messages are counted as skipped, not failed
{
  const api = fakeApi(buildHistory(20));
  api.deleteMessage = async function () {
    const err = new Error('Unknown Message');
    err.status = 404;
    err.code = 10008;
    Object.setPrototypeOf(err, (await import('../src/api.js')).DiscordError.prototype);
    throw err;
  };
  const { stats } = await cleanChannel(api, { ...base, limit: 5 });
  assert.equal(stats.skipped, 5);
  assert.equal(stats.failed, 0);
  ok('messages that vanished mid-run count as skipped, not failed');
}

// 11. the delay is actually applied between deletes
{
  const api = fakeApi(buildHistory(20));
  const t0 = Date.now();
  await cleanChannel(api, { ...base, limit: 5, delayMs: 60, pauseEvery: 0 });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 5 * 60 - 20, `expected >=280ms of throttling, got ${elapsed}ms`);
  ok(`--delay throttles between deletes (${elapsed}ms for 5 @ 60ms)`);
}

console.log(`\n${passed}/11 checks passed\n`);
