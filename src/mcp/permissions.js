const config = require("../config");
const logger = require("../logger");

function normaliseValue(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function matchesPattern(pattern, target) {
  if (!pattern) return false;
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return target.startsWith(prefix);
  }
  return pattern === target;
}

function evaluateSandboxRequest({ sessionId, command }) {
  const permissions = config.mcp?.permissions ?? {};
  const mode = typeof permissions.mode === "string" ? permissions.mode : "auto";
  const allowList = Array.isArray(permissions.allow)
    ? permissions.allow.map(normaliseValue)
    : [];
  const denyList = Array.isArray(permissions.deny)
    ? permissions.deny.map(normaliseValue)
    : [];
  const target = normaliseValue(command);

  if (denyList.some((pattern) => matchesPattern(pattern, target))) {
    const reason = `Command "${command}" denied by sandbox deny list.`;
    logger.warn({ sessionId, command }, reason);
    return { allowed: false, reason, source: "deny_list" };
  }

  if (mode === "deny") {
    const reason = "Sandbox execution disabled by configuration.";
    logger.warn({ sessionId, command }, reason);
    return { allowed: false, reason, source: "mode_deny" };
  }

  if (mode === "require") {
    if (allowList.length === 0) {
      const reason =
        "Sandbox permission mode 'require' is set but no allow list entries are configured.";
      logger.warn({ sessionId, command }, reason);
      return { allowed: false, reason, source: "mode_require" };
    }
    if (!allowList.some((pattern) => matchesPattern(pattern, target))) {
      const reason = `Command "${command}" is not permitted by sandbox allow list.`;
      logger.warn({ sessionId, command }, reason);
      return { allowed: false, reason, source: "mode_require" };
    }
    return { allowed: true, reason: "Allow list match", source: "allow_list" };
  }

  if (allowList.length > 0 && !allowList.some((pattern) => matchesPattern(pattern, target))) {
    logger.debug(
      { sessionId, command },
      "Sandbox command not in allow list; proceeding because mode is not 'require'.",
    );
  }

  return { allowed: true, source: mode === "auto" ? "auto" : "implicit_allow" };
}

module.exports = {
  evaluateSandboxRequest,
};
