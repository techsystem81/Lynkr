const db = require("../db");
const logger = require("../logger");

const OUTPUT_SNIPPET_LIMIT = 2000;

const insertTestRunStmt = db.prepare(
  `INSERT INTO test_runs (
     profile,
     status,
     command,
     args,
     cwd,
     exit_code,
     timed_out,
     duration_ms,
     sandbox,
     stdout,
     stderr,
     coverage,
     created_at
   ) VALUES (
     @profile,
     @status,
     @command,
     @args,
     @cwd,
     @exit_code,
     @timed_out,
     @duration_ms,
     @sandbox,
     @stdout,
     @stderr,
     @coverage,
     @created_at
   )`,
);

const listRecentTestRunsStmt = db.prepare(
  `SELECT
     id,
     profile,
     status,
     command,
     args,
     cwd,
     exit_code,
     timed_out,
     duration_ms,
     sandbox,
     stdout,
     stderr,
     coverage,
     created_at
   FROM test_runs
   ORDER BY created_at DESC
   LIMIT ?`,
);

const countAllTestRunsStmt = db.prepare(`SELECT COUNT(1) AS total FROM test_runs`);
const countPassedTestRunsStmt = db.prepare(
  `SELECT COUNT(1) AS total FROM test_runs WHERE status = 'passed'`,
);
const selectLatestTestRunStmt = db.prepare(
  `SELECT
     id,
     profile,
     status,
     command,
     args,
     cwd,
     exit_code,
     timed_out,
     duration_ms,
     sandbox,
     stdout,
     stderr,
     coverage,
     created_at
   FROM test_runs
   ORDER BY created_at DESC
   LIMIT 1`,
);

function truncateOutput(output, limit = OUTPUT_SNIPPET_LIMIT) {
  if (typeof output !== "string" || output.length === 0) {
    return { text: output ?? "", truncated: false };
  }
  if (output.length <= limit) {
    return { text: output, truncated: false };
  }
  return {
    text: output.slice(output.length - limit),
    truncated: true,
  };
}

function parseJson(value, fallback = null) {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch (err) {
    logger.debug({ err }, "Failed to parse JSON payload in test_runs");
    return fallback;
  }
}

function normaliseArgs(value) {
  const parsed = parseJson(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => String(item));
}

function normaliseCoverage(value) {
  const parsed = parseJson(value, null);
  if (!parsed || typeof parsed !== "object") return null;
  return parsed;
}

function normaliseTestRunRow(row, { includeLogs = false } = {}) {
  if (!row) return null;
  const stdoutResult = includeLogs ? { text: row.stdout ?? "", truncated: false } : truncateOutput(row.stdout);
  const stderrResult = includeLogs ? { text: row.stderr ?? "", truncated: false } : truncateOutput(row.stderr);
  return {
    id: row.id,
    profile: row.profile ?? null,
    status: row.status ?? null,
    command: row.command ?? null,
    args: normaliseArgs(row.args),
    cwd: row.cwd ?? null,
    exitCode: typeof row.exit_code === "number" ? row.exit_code : null,
    timedOut: row.timed_out === 1,
    durationMs: typeof row.duration_ms === "number" ? row.duration_ms : null,
    sandbox: row.sandbox ?? null,
    stdout: stdoutResult.text ?? "",
    stdoutTruncated: stdoutResult.truncated,
    stderr: stderrResult.text ?? "",
    stderrTruncated: stderrResult.truncated,
    coverage: normaliseCoverage(row.coverage),
    createdAt: new Date(Number(row.created_at ?? Date.now())).toISOString(),
  };
}

function createTestRun({
  profile,
  status,
  command,
  args,
  cwd,
  exitCode,
  timedOut,
  durationMs,
  sandbox,
  stdout,
  stderr,
  coverage,
  createdAt,
}) {
  const payload = {
    profile: profile ?? null,
    status: status ?? null,
    command: command ?? "",
    args: Array.isArray(args) && args.length ? JSON.stringify(args.map(String)) : null,
    cwd: cwd ?? null,
    exit_code: typeof exitCode === "number" ? exitCode : null,
    timed_out: timedOut ? 1 : 0,
    duration_ms: typeof durationMs === "number" ? durationMs : null,
    sandbox: sandbox ?? null,
    stdout: typeof stdout === "string" ? stdout : stdout ?? "",
    stderr: typeof stderr === "string" ? stderr : stderr ?? "",
    coverage: coverage ? JSON.stringify(coverage) : null,
    created_at: Number.isFinite(createdAt) ? Math.trunc(createdAt) : Date.now(),
  };
  const info = insertTestRunStmt.run(payload);
  return normaliseTestRunRow(
    {
      id: info.lastInsertRowid,
      ...payload,
    },
    { includeLogs: true },
  );
}

function listTestRuns({ limit = 5, includeLogs = false } = {}) {
  const clamped = Math.min(Math.max(Number(limit) || 5, 1), 50);
  const rows = listRecentTestRunsStmt.all(clamped);
  return rows.map((row) => normaliseTestRunRow(row, { includeLogs }));
}

function getTestSummary({ includeRecent = false, recentLimit = 5 } = {}) {
  const totals = countAllTestRunsStmt.get();
  const passed = countPassedTestRunsStmt.get();
  const latest = selectLatestTestRunStmt.get();
  const totalRuns = Number(totals?.total ?? 0);
  const passedRuns = Number(passed?.total ?? 0);
  const summary = {
    totalRuns,
    passRate: totalRuns > 0 ? Number(((passedRuns / totalRuns) * 100).toFixed(2)) : null,
    lastRun: latest ? normaliseTestRunRow(latest, { includeLogs: false }) : null,
  };
  if (includeRecent) {
    summary.recentRuns = listTestRuns({
      limit: recentLimit,
      includeLogs: false,
    });
  }
  return summary;
}

module.exports = {
  createTestRun,
  listTestRuns,
  getTestSummary,
};
