const fsp = require("fs/promises");
const path = require("path");
const fg = require("fast-glob");
const logger = require("../logger");
const { workspaceRoot } = require("../workspace");

const COVERAGE_METRICS = ["lines", "statements", "branches", "functions"];
const OUTPUT_LIMIT = 256;

function hasWildcard(pattern) {
  return /[*?[\]{}]/.test(pattern);
}

function ensureWorkspaceAbsolute(targetPath) {
  const absolute = path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(workspaceRoot, targetPath);
  if (!absolute.startsWith(workspaceRoot)) {
    logger.debug(
      { targetPath },
      "Ignoring coverage path outside workspace",
    );
    return null;
  }
  return absolute;
}

function expandCoveragePatterns(patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return [];
  const results = new Set();
  for (const rawPattern of patterns) {
    if (typeof rawPattern !== "string") continue;
    const pattern = rawPattern.trim();
    if (!pattern) continue;
    if (hasWildcard(pattern)) {
      const matches = fg.sync(pattern, {
        cwd: workspaceRoot,
        dot: true,
        absolute: true,
        onlyFiles: true,
        unique: true,
      });
      matches.forEach((match) => {
        const absolute = ensureWorkspaceAbsolute(match);
        if (absolute) results.add(absolute);
      });
    } else {
      const absolute = ensureWorkspaceAbsolute(pattern);
      if (absolute) results.add(absolute);
    }
  }
  return Array.from(results);
}

function normaliseMetric(rawMetric) {
  if (!rawMetric || typeof rawMetric !== "object") return null;
  const total = Number(rawMetric.total ?? rawMetric.statements ?? rawMetric.lines ?? rawMetric.functions ?? 0);
  const covered = Number(rawMetric.covered ?? rawMetric.hit ?? 0);
  const skipped = Number(rawMetric.skipped ?? 0);
  let pct = rawMetric.pct;
  if (!Number.isFinite(pct)) {
    pct = total > 0 ? (covered / total) * 100 : 0;
  }
  return {
    total: Number.isFinite(total) ? total : null,
    covered: Number.isFinite(covered) ? covered : null,
    skipped: Number.isFinite(skipped) ? skipped : null,
    pct: Number.isFinite(pct) ? Number(pct.toFixed(2)) : null,
  };
}

async function parseIstanbulCoverage(filePath) {
  try {
    const stats = await fsp.stat(filePath);
    if (!stats.isFile()) return null;
    const raw = await fsp.readFile(filePath, "utf8");
    const data = JSON.parse(raw);
    const totals = data.total ?? data.totals ?? null;
    if (!totals) return null;
    const summary = {};
    let hasMetric = false;
    for (const metric of COVERAGE_METRICS) {
      const value = normaliseMetric(totals[metric]);
      if (value) {
        summary[metric] = value;
        hasMetric = true;
      }
    }
    if (!hasMetric) return null;
    return {
      path: path.relative(workspaceRoot, filePath) || path.basename(filePath),
      absolutePath: filePath,
      type: "istanbul",
      totals: summary,
      generatedAt: new Date(stats.mtimeMs).toISOString(),
    };
  } catch (err) {
    const sample =
      typeof err?.message === "string" && err.message.length > OUTPUT_LIMIT
        ? `${err.message.slice(0, OUTPUT_LIMIT)}…`
        : err?.message ?? String(err);
    logger.debug({ err: sample, filePath }, "Failed to parse coverage file");
    return null;
  }
}

async function parseCoverageFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".json") {
    return parseIstanbulCoverage(filePath);
  }
  return null;
}

function aggregateMetric(values) {
  if (!values.length) return null;
  let total = 0;
  let covered = 0;
  let skipped = 0;
  for (const value of values) {
    total += Number(value.total ?? 0);
    covered += Number(value.covered ?? 0);
    skipped += Number(value.skipped ?? 0);
  }
  const pct = total > 0 ? Number(((covered / total) * 100).toFixed(2)) : null;
  return {
    total: total || null,
    covered,
    skipped,
    pct,
  };
}

function synthesiseSummary(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const summary = {};
  let hasMetric = false;
  for (const metric of COVERAGE_METRICS) {
    const values = entries
      .map((entry) => entry?.totals?.[metric])
      .filter(Boolean);
    if (values.length === 0) continue;
    const aggregated = aggregateMetric(values);
    if (aggregated) {
      summary[metric] = aggregated;
      hasMetric = true;
    }
  }
  return hasMetric ? summary : null;
}

async function collectCoverageSummary(patterns = []) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return { sources: [], summary: null };
  }
  const files = expandCoveragePatterns(patterns);
  if (files.length === 0) {
    return { sources: [], summary: null };
  }
  const sources = [];
  for (const filePath of files) {
    const parsed = await parseCoverageFile(filePath);
    if (parsed) {
      sources.push(parsed);
    }
  }
  const summary = synthesiseSummary(sources);
  return { sources, summary };
}

module.exports = {
  collectCoverageSummary,
};
