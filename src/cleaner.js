import { sleep, snowflakeToDate, dateToSnowflake, DiscordError } from './api.js';

/** Message types a user is actually allowed to delete. Everything else is a
 *  system event (joins, calls, pin notices) that Discord refuses to remove. */
const DELETABLE_TYPES = new Set([0, 19, 20, 23]);

const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;

/**
 * Walk a channel's history newest-first, yielding pages of 100.
 */
export async function* iterateHistory(api, channelId, { before, after } = {}) {
  let cursor = before;
  for (;;) {
    const page = await api.messages(channelId, { before: cursor, limit: 100 });
    if (!page || page.length === 0) return;
    yield page;
    cursor = page[page.length - 1].id;
    if (after && BigInt(cursor) <= BigInt(after)) return;
    if (page.length < 100) return;
  }
}

/**
 * Decide whether a message is in scope for deletion.
 */
export function matches(msg, { userId, contains, before, after }) {
  if (msg.author?.id !== userId) return false;
  if (!DELETABLE_TYPES.has(msg.type)) return false;
  if (contains) {
    const needle = contains.toLowerCase();
    if (!(msg.content ?? '').toLowerCase().includes(needle)) return false;
  }
  const ts = snowflakeToDate(msg.id).getTime();
  if (before && ts >= before.getTime()) return false;
  if (after && ts <= after.getTime()) return false;
  return true;
}

/**
 * Delete the current account's messages in one channel.
 *
 * @param {import('./api.js').DiscordAPI} api
 * @param {object} opts
 * @param {string} opts.channelId
 * @param {string} opts.userId      whose messages to remove
 * @param {number} opts.limit       max messages to DELETE (Infinity for all)
 * @param {number} opts.scanLimit   max messages to READ while searching
 * @param {number} opts.delayMs
 * @param {number} opts.pauseEvery
 * @param {number} opts.pauseMs
 * @param {boolean} opts.dryRun
 * @param {boolean} opts.bulk       try bulk-delete for recent messages (bot + guild only)
 * @param {string} [opts.contains]
 * @param {Date}   [opts.before]
 * @param {Date}   [opts.after]
 * @param {() => boolean} [opts.shouldStop] polled between deletes; true aborts the run
 * @param {(e: object) => void} [opts.onEvent]
 */
export async function cleanChannel(api, opts) {
  const {
    channelId,
    userId,
    limit = Infinity,
    scanLimit = Infinity,
    delayMs = 1200,
    pauseEvery = 50,
    pauseMs = 5000,
    dryRun = false,
    bulk = false,
    shouldStop = () => false,
    onEvent = () => {},
  } = opts;

  const stats = { scanned: 0, matched: 0, deleted: 0, failed: 0, skipped: 0 };
  let stopped = false;
  const failures = [];
  let bulkBuffer = [];

  const flushBulk = async () => {
    if (bulkBuffer.length < 2) {
      // bulk-delete needs 2+; fall through to single deletes
      for (const m of bulkBuffer) await deleteOne(m);
      bulkBuffer = [];
      return;
    }
    const batch = bulkBuffer.splice(0, 100);
    try {
      if (!dryRun) await api.bulkDelete(channelId, batch.map((m) => m.id));
      stats.deleted += batch.length;
      onEvent({ type: 'bulk', count: batch.length, stats });
    } catch (err) {
      onEvent({ type: 'bulk-failed', error: err, stats });
      for (const m of batch) await deleteOne(m);
    }
  };

  const deleteOne = async (msg) => {
    try {
      if (!dryRun) await api.deleteMessage(channelId, msg.id);
      stats.deleted += 1;
      onEvent({ type: 'deleted', message: msg, stats });
    } catch (err) {
      if (err instanceof DiscordError && (err.status === 404 || err.code === 10008)) {
        stats.skipped += 1; // already gone
        onEvent({ type: 'gone', message: msg, stats });
        return;
      }
      stats.failed += 1;
      failures.push({ id: msg.id, error: err.message });
      onEvent({ type: 'failed', message: msg, error: err, stats });
    }
    if (!dryRun) {
      await sleep(delayMs);
      if (pauseEvery > 0 && stats.deleted > 0 && stats.deleted % pauseEvery === 0) {
        onEvent({ type: 'pause', ms: pauseMs, stats });
        await sleep(pauseMs);
      }
    }
  };

  // If a --before date was given, start paging from there instead of from the
  // newest message: everything newer is out of scope anyway.
  const startCursor = opts.before ? dateToSnowflake(opts.before) : undefined;

  outer: for await (const page of iterateHistory(api, channelId, { before: startCursor })) {
    for (const msg of page) {
      stats.scanned += 1;
      if (stats.scanned > scanLimit) {
        onEvent({ type: 'scan-limit', stats });
        break outer;
      }
      if (shouldStop()) {
        stopped = true;
        onEvent({ type: 'stopped', stats });
        break outer;
      }
      if (!matches(msg, opts)) continue;
      stats.matched += 1;

      const recent = Date.now() - snowflakeToDate(msg.id).getTime() < FOURTEEN_DAYS;
      if (bulk && recent) {
        bulkBuffer.push(msg);
        if (bulkBuffer.length >= 100) await flushBulk();
      } else {
        await deleteOne(msg);
      }

      if (stats.matched >= limit) {
        onEvent({ type: 'limit', stats });
        break outer;
      }
    }
    onEvent({ type: 'page', stats });

    // Pages come newest-first; once the oldest message on this page predates
    // --after, nothing further back can qualify.
    const oldest = page[page.length - 1];
    if (opts.after && snowflakeToDate(oldest.id) < opts.after) {
      onEvent({ type: 'after-boundary', stats });
      break;
    }
  }

  if (bulkBuffer.length) await flushBulk();

  return { stats, failures, stopped };
}
