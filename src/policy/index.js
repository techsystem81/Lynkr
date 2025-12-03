const config = require("../config");
const logger = require("../logger");

const SHELL_BLOCKLIST_PATTERNS = [
  new RegExp("rm\\s+-rf\\s+/(?:\\s|$)", "i"),
  /shutdown/i,
  /reboot/i,
  /systemctl\s+stop/i,
  /mkfs\w*/i,
  /dd\s+if=\/dev\//i,
  /:(){:|:&};:/, // fork bomb
  /chown\s+-R\s+root/i,
];

const PYTHON_BLOCKLIST_PATTERNS = [
  /os\.remove\s*\(\s*['"]\/['"]\s*\)/i,
  /subprocess\.(call|run)\s*\(\s*["']rm\s+-rf/i,
  /shutil\.rmtree\s*\(\s*['"]\/['"]\s*\)/i,
];

const SENSITIVE_CONTENT_PATTERNS = [
  {
    regex: /-----BEGIN [^-]+ PRIVATE KEY-----/i,
    replacement: "[REDACTED PRIVATE KEY]",
  },
  {
    regex: new RegExp("\\b[A-Za-z0-9+/]{32,}={0,2}\\b", "g"),
    maxLength: 64,
    replacement: "[POTENTIAL SECRET]",
  },
];

function parseArguments(call) {
  const raw = call?.function?.arguments;
  if (typeof raw !== "string") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function isToolAllowed(toolName) {
  if (!toolName) return true;
  const disallowed = config.policy.disallowedTools ?? [];
  return !disallowed.includes(toolName);
}

function matchesAny(patterns, value) {
  if (typeof value !== "string") return false;
  return patterns.some((regex) => regex.test(value));
}

function evaluateShellCall(args) {
  const command =
    typeof args.command === "string"
      ? args.command
      : typeof args.cmd === "string"
      ? args.cmd
      : typeof args.run === "string"
      ? args.run
      : Array.isArray(args.command)
      ? args.command.join(" ")
      : Array.isArray(args.args)
      ? args.args.join(" ")
      : "";
  if (!command) return { allowed: true };
  if (matchesAny(SHELL_BLOCKLIST_PATTERNS, command)) {
    return {
      allowed: false,
      reason: "Command matched restricted pattern",
    };
  }
  return { allowed: true };
}

function evaluatePythonCall(args) {
  const code =
    typeof args.code === "string"
      ? args.code
      : typeof args.script === "string"
      ? args.script
      : typeof args.input === "string"
      ? args.input
      : "";
  if (!code) return { allowed: true };
  if (matchesAny(PYTHON_BLOCKLIST_PATTERNS, code)) {
    return {
      allowed: false,
      reason: "Python code matched restricted pattern",
    };
  }
  return { allowed: true };
}

function evaluateToolCall({ call, toolCallsExecuted }) {
  const toolName = call?.function?.name ?? call?.name;
  if (!isToolAllowed(toolName)) {
    return {
      allowed: false,
      reason: `Tool ${toolName} is disallowed by policy`,
      status: 403,
      code: "tool_disallowed",
    };
  }

  const maxToolCalls = config.policy.maxToolCallsPerTurn;
  if (toolCallsExecuted >= maxToolCalls) {
    return {
      allowed: false,
      reason: `Exceeded max tool calls (${maxToolCalls})`,
      status: 429,
      code: "tool_limit_reached",
    };
  }

  const args = parseArguments(call);

  if (toolName && toolName.startsWith("workspace_git_")) {
    const gitPolicy = config.policy.git ?? {};
    if (
      toolName === "workspace_git_push" &&
      gitPolicy.allowPush !== true
    ) {
      return {
        allowed: false,
        reason: "Git push is disabled by policy.",
        status: 403,
        code: "git_push_disabled",
      };
    }
    if (
      toolName === "workspace_git_pull" &&
      gitPolicy.allowPull !== true
    ) {
      return {
        allowed: false,
        reason: "Git pull is disabled by policy.",
        status: 403,
        code: "git_pull_disabled",
      };
    }
    if (
      toolName === "workspace_git_commit" &&
      gitPolicy.allowCommit !== true
    ) {
      return {
        allowed: false,
        reason: "Git commit is disabled by policy.",
        status: 403,
        code: "git_commit_disabled",
      };
    }
  }

  if (toolName === "shell") {
    const decision = evaluateShellCall(args);
    if (!decision.allowed) {
      return {
        allowed: false,
        reason: decision.reason,
        status: 403,
        code: "unsafe_shell_command",
      };
    }
  }

  if (toolName === "python_exec") {
    const decision = evaluatePythonCall(args);
    if (!decision.allowed) {
      return {
        allowed: false,
        reason: decision.reason,
        status: 403,
        code: "unsafe_python_code",
      };
    }
  }

  return { allowed: true };
}

function sanitiseText(text) {
  if (typeof text !== "string") return text;
  let output = text;
  for (const pattern of SENSITIVE_CONTENT_PATTERNS) {
    if (pattern.maxLength && output.length < pattern.maxLength) continue;
    output = output.replace(pattern.regex, pattern.replacement);
  }
  return output;
}

function sanitiseContent(contentItems) {
  if (!Array.isArray(contentItems)) return contentItems;
  return contentItems.map((item) => {
    if (item?.type === "text" && typeof item.text === "string") {
      return { ...item, text: sanitiseText(item.text) };
    }
    return item;
  });
}

function logPolicyDecision(decision, context = {}) {
  if (decision.allowed) return;
  logger.warn({ decision, context }, "Policy blocked tool call");
}

module.exports = {
  evaluateToolCall,
  sanitiseContent,
  logPolicyDecision,
};
