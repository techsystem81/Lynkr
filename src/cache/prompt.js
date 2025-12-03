const crypto = require("crypto");
const config = require("../config");
const logger = require("../logger");

function cloneValue(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function normaliseObject(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => normaliseObject(item));
  }
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    sorted[key] = normaliseObject(candidate);
  }
  return sorted;
}

function stableStringify(value) {
  return JSON.stringify(normaliseObject(value));
}

class PromptCache {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.maxEntries =
      Number.isInteger(options.maxEntries) && options.maxEntries > 0
        ? options.maxEntries
        : 64;
    this.ttlMs =
      Number.isInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 300000;
    this.store = new Map();
  }

  isEnabled() {
    return this.enabled;
  }

  buildKey(payload) {
    if (!this.enabled) return null;
    if (!payload || typeof payload !== "object") return null;
    try {
      const canonical = {
        model: payload.model ?? null,
        input: payload.input ?? null,
        messages: payload.messages ? normaliseObject(payload.messages) : null,
        tools: payload.tools ? normaliseObject(payload.tools) : null,
        tool_choice: payload.tool_choice ? normaliseObject(payload.tool_choice) : null,
        temperature: payload.temperature ?? null,
        top_p: payload.top_p ?? null,
        max_tokens: payload.max_tokens ?? null,
      };
      const serialised = stableStringify(canonical);
      return crypto.createHash("sha256").update(serialised).digest("hex");
    } catch (error) {
      logger.warn(
        {
          err: error,
        },
        "Failed to build prompt cache key",
      );
      return null;
    }
  }

  pruneExpired() {
    if (!this.enabled) return;
    if (this.ttlMs <= 0) return;
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt && entry.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }

  lookup(payloadOrKey) {
    if (!this.enabled) {
      return { key: null, entry: null };
    }
    const key =
      typeof payloadOrKey === "string" ? payloadOrKey : this.buildKey(payloadOrKey);
    if (!key) {
      return { key: null, entry: null };
    }

    this.pruneExpired();
    const entry = this.store.get(key);
    if (!entry) {
      return { key, entry: null };
    }
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return { key, entry: null };
    }

    this.store.delete(key);
    this.store.set(key, entry);
    return { key, entry };
  }

  fetch(payload) {
    const { key, entry } = this.lookup(payload);
    if (!entry) return null;
    return {
      key,
      response: cloneValue(entry.value),
    };
  }

  shouldCacheResponse(response) {
    if (!response) return false;
    if (response.ok !== true) return false;
    if (!response.json) return false;
    if (typeof response.status === "number" && response.status !== 200) return false;

    const choice = response.json?.choices?.[0];
    if (!choice) return false;
    if (choice?.finish_reason === "tool_calls") return false;

    const message = choice.message ?? {};
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      return false;
    }
    return true;
  }

  storeResponse(payloadOrKey, response) {
    if (!this.enabled) return null;
    if (!this.shouldCacheResponse(response)) return null;
    const key =
      typeof payloadOrKey === "string" ? payloadOrKey : this.buildKey(payloadOrKey);
    if (!key) return null;

    this.pruneExpired();
    const entry = {
      value: cloneValue(response),
      createdAt: Date.now(),
      expiresAt: this.ttlMs > 0 ? Date.now() + this.ttlMs : null,
    };

    if (this.store.has(key)) {
      this.store.delete(key);
    }

    this.store.set(key, entry);

    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      this.store.delete(oldestKey);
    }

    logger.debug(
      {
        cacheKey: key,
        size: this.store.size,
      },
      "Stored response in prompt cache",
    );

    return key;
  }

  stats() {
    return {
      enabled: this.enabled,
      size: this.store.size,
      ttlMs: this.ttlMs,
      maxEntries: this.maxEntries,
    };
  }
}

const promptCache = new PromptCache(config.promptCache ?? {});

module.exports = promptCache;
