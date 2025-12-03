const config = require("../config");
const logger = require("../logger");
const { workspaceRoot } = require("../workspace");
const { runProcess, MAX_TIMEOUT_MS } = require("../tools/process");
const { collectCoverageSummary } = require("./coverage");
const { createTestRun, listTestRuns, getTestSummary } = require("./store");

function resolveProfile(name) {
  if (!name || typeof name !== "string") return null;
  const profiles = config.tests?.profiles;
  if (!Array.isArray(profiles) || profiles.length === 0) return null;
  const normalized = name.trim().toLowerCase();
  return (
    profiles.find(
      (profile) =>
        typeof profile?.name === "string" && profile.name.trim().toLowerCase() === normalized,
    ) ?? null
  );
}

function deriveCommand({ profile, args }) {
  if (profile && typeof profile.command === "string" && profile.command.trim().length > 0) {
    const command = profile.command.trim();
    const commandArgs = Array.isArray(profile.args) ? profile.args.map(String) : [];
    const cwd =
      typeof profile.cwd === "string" && profile.cwd.trim().length > 0
        ? profile.cwd.trim()
        : ".";
    const sandbox = typeof profile.sandbox === "string" ? profile.sandbox.toLowerCase() : null;
    return { command, args: commandArgs, cwd, sandbox };
  }

  const defaultCommand = config.tests?.defaultCommand;
  if (typeof defaultCommand === "string" && defaultCommand.trim().length > 0) {
    return {
      command: defaultCommand.trim(),
      args: Array.isArray(args) && args.length ? args.map(String) : config.tests?.defaultArgs ?? [],
      cwd: ".",
      sandbox: config.tests?.sandbox ?? "auto",
    };
  }

  throw new Error(
    "No default test command configured. Set WORKSPACE_TEST_COMMAND or define profiles.",
  );
}

async function executeTestCommand({
  profile,
  command,
  args = [],
  cwd = ".",
  env = {},
  timeoutMs,
  sandbox,
  sessionId,
}) {
  const timeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, MAX_TIMEOUT_MS)
      : config.tests?.timeoutMs ?? 600000;

  const runEnv = {
    ...env,
    WORKSPACE_TEST_PROFILE: profile ?? "",
  };

  return runProcess({
    command,
    args,
    cwd,
    env: runEnv,
    timeoutMs: timeout,
    sandbox: sandbox ?? config.tests?.sandbox ?? "auto",
    sessionId,
  });
}

async function runWorkspaceTests({
  profileName,
  args,
  cwd,
  env,
  timeoutMs,
  sandbox,
  sessionId,
  collectCoverage = true,
}) {
  const profile = resolveProfile(profileName);
  const derived = deriveCommand({ profile, args });

  const command = typeof derived.command === "string" ? derived.command : null;
  const commandArgs = Array.isArray(args) && args.length ? args.map(String) : derived.args ?? [];
  const effectiveCwd = typeof cwd === "string" ? cwd : derived.cwd ?? ".";
  const effectiveSandbox = sandbox ?? derived.sandbox ?? config.tests?.sandbox ?? "auto";

  const start = Date.now();
  const result = await executeTestCommand({
    profile: profile?.name ?? profileName ?? null,
    command,
    args: commandArgs,
    cwd: effectiveCwd,
    env,
    timeoutMs,
    sandbox: effectiveSandbox,
    sessionId,
  });

  const durationMs = Date.now() - start;
  const status =
    result.exitCode === 0 && !result.timedOut
      ? "passed"
      : result.timedOut
      ? "timed_out"
      : "failed";

  let coverage = null;
  if (collectCoverage) {
    try {
      const patterns =
        Array.isArray(config.tests?.coverage?.files) && config.tests.coverage.files.length > 0
          ? config.tests.coverage.files
          : [];
      if (patterns.length > 0) {
        const summary = await collectCoverageSummary(patterns);
        coverage = summary;
      }
    } catch (err) {
      logger.warn({ err }, "Failed to collect coverage summary");
    }
  }

  const record = createTestRun({
    profile: profile?.name ?? profileName ?? null,
    status,
    command,
    args: commandArgs,
    cwd: effectiveCwd === "." ? workspaceRoot : effectiveCwd,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs,
    sandbox: effectiveSandbox,
    stdout: result.stdout,
    stderr: result.stderr,
    coverage,
    createdAt: Date.now(),
  });

  return {
    run: {
      id: record.id,
      status,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs,
      sandbox: effectiveSandbox,
      profile: record.profile,
      stdout: record.stdout,
      stdoutTruncated: record.stdoutTruncated,
      stderr: record.stderr,
      stderrTruncated: record.stderrTruncated,
    },
    coverage,
  };
}

module.exports = {
  runWorkspaceTests,
  listTestRuns,
  getTestSummary,
};
