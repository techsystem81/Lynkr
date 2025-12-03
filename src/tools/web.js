const { URL } = require("url");
const config = require("../config");
const logger = require("../logger");
const { registerTool } = require(".");

const DEFAULT_MAX_RESULTS = 5;
function normaliseQuery(args = {}) {
  const query = args.query ?? args.q ?? args.prompt ?? args.search ?? args.input;
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("web_search requires a non-empty query string.");
  }
  return query.trim();
}

function resolveLimit(args = {}) {
  const raw = args.limit ?? args.top_k ?? args.max_results;
  if (raw === undefined) return DEFAULT_MAX_RESULTS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_MAX_RESULTS;
  return Math.min(parsed, 20);
}

function buildAllowedHosts() {
  if (config.webSearch.allowAllHosts) {
    return null;
  }
  const configured = config.webSearch.allowedHosts ?? [];
  const hosts = new Set();
  if (config.webSearch.endpoint) {
    try {
      const endpointHost = new URL(config.webSearch.endpoint).hostname.toLowerCase();
      hosts.add(endpointHost);
    } catch {
      // ignore parse errors; config already validated
    }
  }
  configured.forEach((host) => hosts.add(host));
  return hosts;
}

function buildSearchUrl({ query, limit }) {
  const endpoint = new URL(config.webSearch.endpoint);
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("per_page", String(limit));
  return endpoint;
}

async function performSearch({ query, limit, timeoutMs }) {
  const url = buildSearchUrl({ query, limit });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!response.ok) {
      const error = new Error("Web search provider returned an error.");
      error.status = response.status;
      error.body = text;
      throw error;
    }

    return json ?? { results: [], raw: text };
  } finally {
    clearTimeout(timeout);
  }
}

function summariseResult(item) {
  if (!item) return null;
  return {
    title: item.title ?? item.name ?? null,
    url: item.url ?? item.link ?? null,
    snippet: item.snippet ?? item.summary ?? item.excerpt ?? null,
    score: item.score ?? item.rank ?? null,
    source: item.source ?? null,
    metadata: item.metadata ?? null,
  };
}

function formatSearchResponse(payload, { query, limit }) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const payloadCount =
    typeof payload?.number_of_results === "number" && payload.number_of_results > 0
      ? payload.number_of_results
      : null;
  const effectiveCount = payloadCount ?? results.length;
  const numberOfResults = effectiveCount > 0 ? effectiveCount : undefined;
  const metadata = {
    ...(payload?.metadata ?? {}),
    raw_number_of_results: payloadCount,
    engines: payload?.engines ?? null,
    categories: payload?.categories ?? null,
  };
  if (numberOfResults !== undefined) {
    metadata.number_of_results = numberOfResults;
  }
  return {
    query,
    limit,
    number_of_results: numberOfResults,
    results: results.map(summariseResult).filter(Boolean),
    metadata,
  };
}

function buildAllowedFetchHosts() {
  return config.webSearch.allowAllHosts ? null : buildAllowedHosts();
}

function parseUrl(rawUrl) {
  try {
    return new URL(rawUrl);
  } catch (err) {
    err.code = "invalid_url";
    throw err;
  }
}

function ensureHostAllowed(url, allowedHosts) {
  if (allowedHosts === null) {
    return;
  }
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.has(host)) {
    const error = new Error(`Host ${host} is not in the allowlist.`);
    error.code = "host_not_allowed";
    throw error;
  }
}

async function fetchDocument(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url.toString(), { signal: controller.signal });
    const text = await response.text();
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: text,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function registerWebSearchTool() {
  registerTool(
    "web_search",
    async ({ args = {} }) => {
      const query = normaliseQuery(args);
      const limit = resolveLimit(args);
      const timeoutMs = config.webSearch.timeoutMs;

      try {
        const payload = await performSearch({ query, limit, timeoutMs });
        const formatted = formatSearchResponse(payload, { query, limit });
        const resultCount = formatted.results.length;
        logger.debug(
          {
            query,
            limit,
            result_count: resultCount,
            number_of_results: formatted.number_of_results,
            engines: payload?.engines ?? null,
            categories: payload?.categories ?? null,
            sample_result: formatted.results[0] ?? null,
          },
          "Web search results summarised",
        );
        return {
          ok: true,
          status: 200,
          content: JSON.stringify(formatted, null, 2),
          metadata: {
            query,
            limit,
            result_count: resultCount,
            ...(formatted.number_of_results !== undefined
              ? { number_of_results: formatted.number_of_results }
              : {}),
          },
        };
      } catch (err) {
        logger.error({ err }, "Web search request failed");
        return {
          ok: false,
          status: err.status ?? 500,
          content: JSON.stringify(
            {
              error: err.code ?? "web_search_failed",
              message: err.message,
              status: err.status ?? 500,
            },
            null,
            2,
          ),
          metadata: {
            query,
            limit,
          },
        };
      }
    },
    { category: "web" },
  );
}

function registerWebFetchTool() {
  registerTool(
    "web_fetch",
    async ({ args = {} }) => {
      const rawUrl = args.url ?? args.uri ?? args.href;
      if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
        throw new Error("web_fetch requires a url string.");
      }
      const url = parseUrl(rawUrl.trim());
      const allowedHosts = buildAllowedFetchHosts();
      ensureHostAllowed(url, allowedHosts);

      const timeoutMs = config.webSearch.timeoutMs;
      try {
        const document = await fetchDocument(url, timeoutMs);
        return {
          ok: document.status >= 200 && document.status < 400,
          status: document.status,
          content: JSON.stringify(
            {
              url: url.toString(),
              status: document.status,
              headers: document.headers,
              body_preview: document.body.slice(0, 4000),
            },
            null,
            2,
          ),
          metadata: {
            url: url.toString(),
            status: document.status,
          },
        };
      } catch (err) {
        logger.error({ err, url: url.toString() }, "web_fetch failed");
        return {
          ok: false,
          status: err.status ?? 500,
          content: JSON.stringify(
            {
              error: err.code ?? "web_fetch_failed",
              message: err.message,
            },
            null,
            2,
          ),
          metadata: {
            url: url.toString(),
          },
        };
      }
    },
    { category: "web" },
  );
}

function registerWebTools() {
  registerWebSearchTool();
  registerWebFetchTool();
}

module.exports = {
  registerWebTools,
};
