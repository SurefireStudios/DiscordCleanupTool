import { BOT_USER_AGENT } from './meta.js';

const BASE = 'https://discord.com/api/v10';

export class DiscordError extends Error {
  constructor(status, code, message, path) {
    super(`[${status}${code ? '/' + code : ''}] ${message} (${path})`);
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal Discord REST client with proactive + reactive rate-limit handling.
 *
 * Discord returns X-RateLimit-Remaining / X-RateLimit-Reset-After on every
 * request. When Remaining hits 0 we pause for Reset-After *before* the next
 * call to that bucket, which avoids most 429s outright. A 429 that slips
 * through is honoured via its retry_after payload.
 */
export class DiscordAPI {
  constructor(token, { tokenType = 'user', userAgent } = {}) {
    if (!token) throw new Error('No token supplied.');
    // Bot tokens are prefixed; user tokens are sent raw.
    this.authorization = tokenType === 'bot' ? `Bot ${token}` : token;
    // Discord routes on User-Agent: the `DiscordBot (...)` form is the documented
    // value for bot clients, and some endpoints behave differently (or refuse)
    // when a user token arrives with it. Override via config if you like.
    this.userAgent =
      userAgent ||
      (tokenType === 'bot'
        ? BOT_USER_AGENT
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    // bucket key -> epoch ms until which we must not send
    this.buckets = new Map();
    this.globalUntil = 0;
  }

  async #waitFor(bucketKey) {
    const now = Date.now();
    const until = Math.max(this.globalUntil, this.buckets.get(bucketKey) ?? 0);
    if (until > now) await sleep(until - now);
  }

  #recordHeaders(bucketKey, res) {
    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    const resetAfter = Number(res.headers.get('x-ratelimit-reset-after'));
    if (Number.isFinite(remaining) && remaining <= 0 && Number.isFinite(resetAfter)) {
      this.buckets.set(bucketKey, Date.now() + resetAfter * 1000 + 100);
    }
  }

  /**
   * @param {string} method
   * @param {string} path            e.g. '/channels/123/messages'
   * @param {object} [opts]
   * @param {object} [opts.body]
   * @param {string} [opts.bucket]   override bucket key (defaults to major resource)
   * @param {number} [opts.attempt]
   */
  async request(method, path, opts = {}) {
    const { body, attempt = 0 } = opts;
    // Discord buckets by "major resource" — channel/guild/webhook id.
    const major = path.match(/^\/(channels|guilds|webhooks)\/(\d+)/);
    const bucket = opts.bucket ?? `${method}:${major ? major[0] : path}`;

    await this.#waitFor(bucket);

    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        headers: {
          Authorization: this.authorization,
          'User-Agent': this.userAgent,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // network hiccup — retry with backoff
      if (attempt < 5) {
        await sleep(2 ** attempt * 1000);
        return this.request(method, path, { ...opts, attempt: attempt + 1 });
      }
      throw err;
    }

    this.#recordHeaders(bucket, res);

    if (res.status === 429) {
      let retryAfter = 5;
      let global = res.headers.get('x-ratelimit-global') === 'true';
      try {
        const payload = await res.json();
        if (typeof payload.retry_after === 'number') retryAfter = payload.retry_after;
        if (payload.global) global = true;
      } catch {
        const hdr = Number(res.headers.get('retry-after'));
        if (Number.isFinite(hdr)) retryAfter = hdr;
      }
      const until = Date.now() + retryAfter * 1000 + 250;
      if (global) this.globalUntil = until;
      else this.buckets.set(bucket, until);

      if (attempt < 8) {
        return this.request(method, path, { ...opts, attempt: attempt + 1 });
      }
      throw new DiscordError(429, null, 'Rate limited too many times', path);
    }

    if (res.status >= 500) {
      if (attempt < 5) {
        await sleep(2 ** attempt * 1000);
        return this.request(method, path, { ...opts, attempt: attempt + 1 });
      }
      throw new DiscordError(res.status, null, 'Discord server error', path);
    }

    if (res.status === 204) return null;

    let payload = null;
    const text = await res.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!res.ok) {
      throw new DiscordError(
        res.status,
        payload?.code ?? null,
        payload?.message ?? String(payload ?? 'Request failed'),
        path
      );
    }
    return payload;
  }

  // --- endpoints -----------------------------------------------------------

  me() {
    return this.request('GET', '/users/@me');
  }

  /** Open DM + group-DM channels for the current account. */
  dmChannels() {
    return this.request('GET', '/users/@me/channels');
  }

  guilds() {
    return this.request('GET', '/users/@me/guilds');
  }

  guildChannels(guildId) {
    return this.request('GET', `/guilds/${guildId}/channels`);
  }

  channel(channelId) {
    return this.request('GET', `/channels/${channelId}`);
  }

  /** One page of history, newest first. limit max 100. */
  messages(channelId, { before, after, limit = 100 } = {}) {
    const qs = new URLSearchParams({ limit: String(Math.min(limit, 100)) });
    if (before) qs.set('before', before);
    if (after) qs.set('after', after);
    return this.request('GET', `/channels/${channelId}/messages?${qs}`);
  }

  deleteMessage(channelId, messageId) {
    // Deleting messages older than ~2 weeks uses a separate, much stricter
    // sub-bucket on Discord's side; keep it distinct so one doesn't stall the other.
    return this.request('DELETE', `/channels/${channelId}/messages/${messageId}`, {
      bucket: `DELETE:/channels/${channelId}/messages`,
    });
  }

  /** Guild-only, 2–100 messages, none older than 14 days. */
  bulkDelete(channelId, messageIds) {
    return this.request('POST', `/channels/${channelId}/messages/bulk-delete`, {
      body: { messages: messageIds },
    });
  }
}

/** Discord snowflake -> Date */
export function snowflakeToDate(id) {
  return new Date(Number((BigInt(id) >> 22n) + 1420070400000n));
}

/** Date -> synthetic snowflake, usable as a before/after cursor. */
export function dateToSnowflake(date) {
  return ((BigInt(date.getTime()) - 1420070400000n) << 22n).toString();
}

export { sleep };
