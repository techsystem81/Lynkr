const { registerTool } = require(".");
const { runWorkspaceTests, listTestRuns, getTestSummary } = require("../tests");

function formatJson(payload) {
  return JSON.stringify(payload, null, 2);
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalised = value.trim().toLowerCase();
    if (normalised === "true" || normalised === "1" || normalised === "yes") return true;
    if (normalised === "false" || normalised === "0" || normalised === "no") return false;
  }
  return undefined;
}

function parseNumber(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgs(args) {
  if (!args) return [];
  if (Array.isArray(args)) return args.map(String);
  if (typeof args === "string" && args.trim().length > 0) {
    return args
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function registerTestRunTool() {
  registerTool(
    "workspace_test_run",
    async ({ args = {} }) => {
      const profile = args.profile ?? args.name ?? null;
      const collectCoverage = parseBoolean(args.collect_coverage ?? args.collectCoverage);
      const sandbox = typeof args.sandbox === "string" ? args.sandbox : undefined;
      const sessionId = args.session_id ?? args.sessionId ?? null;

      const result = await runWorkspaceTests({
        profileName: profile,
        args: parseArgs(args.args ?? args.extra_args),
        cwd: typeof args.cwd === "string" ? args.cwd : undefined,
        env: typeof args.env === "object" && args.env !== null ? args.env : undefined,
        timeoutMs: parseNumber(args.timeout_ms ?? args.timeout, undefined),
        sandbox,
        sessionId,
        collectCoverage: collectCoverage !== undefined ? collectCoverage : true,
      });

      return {
        ok: true,
        status: 200,
        content: formatJson({
          run: result.run,
          coverage: result.coverage,
        }),
        metadata: {
          status: result.run.status,
          profile: result.run.profile,
          durationMs: result.run.durationMs,
        },
      };
    },
    { category: "tests" },
  );
}

function registerTestHistoryTool() {
  registerTool(
    "workspace_test_history",
    async ({ args = {} }) => {
      const includeLogs = parseBoolean(args.include_logs ?? args.includeLogs);
      const limit = parseNumber(args.limit, 5);
      const runs = listTestRuns({
        limit,
        includeLogs: includeLogs === true,
      });
      return {
        ok: true,
        status: 200,
        content: formatJson({
          runs,
          count: runs.length,
        }),
        metadata: {
          count: runs.length,
        },
      };
    },
    { category: "tests" },
  );
}

function registerTestSummaryTool() {
  registerTool(
    "workspace_test_summary",
    async ({ args = {} }) => {
      const includeRecent = parseBoolean(args.include_recent ?? args.includeRecent);
      const recentLimit = parseNumber(args.recent_limit ?? args.recentLimit, 5);
      const summary = getTestSummary({
        includeRecent,
        recentLimit,
      });
      return {
        ok: true,
        status: 200,
        content: formatJson(summary),
        metadata: {
          totalRuns: summary.totalRuns,
          passRate: summary.passRate,
        },
      };
    },
    { category: "tests" },
  );
}

function registerTestTools() {
  registerTestRunTool();
  registerTestHistoryTool();
  registerTestSummaryTool();
}

module.exports = {
  registerTestTools,
};
