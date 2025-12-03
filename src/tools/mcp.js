const { registerTool } = require(".");
const { listServers, loadConfiguredServers, ensureClient } = require("../mcp");
const { listSessions, releaseSession, isSandboxEnabled } = require("../mcp/sandbox");
const { registerRemoteTools } = require("./mcp-remote");
const logger = require("../logger");

function formatJson(payload) {
  return JSON.stringify(payload, null, 2);
}

function registerMcpTools() {
  registerTool(
    "workspace_mcp_servers",
    async () => {
      loadConfiguredServers();
      registerRemoteTools().catch((err) => {
        logger.warn({ err }, "Failed to refresh MCP remote tools");
      });
      const servers = listServers().map((server) => ({
        id: server.id,
        name: server.name,
        description: server.description,
        command: server.command,
        args: server.args,
        transport: server.transport,
        metadata: server.metadata,
      }));
      return {
        ok: true,
        status: 200,
        content: formatJson({
          sandboxEnabled: isSandboxEnabled(),
          servers,
        }),
      };
    },
    { category: "mcp" },
  );

  registerTool("workspace_sandbox_sessions", async ({ args = {} }) => {
    const sessions = listSessions();
    if (args.release === true) {
      const target = typeof args.session_id === "string" ? args.session_id : null;
      if (target) {
        releaseSession(target);
      } else {
        sessions.forEach((session) => releaseSession(session.id));
      }
      return {
        ok: true,
        status: 200,
        content: formatJson({
          released: true,
          target: target ?? "all",
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      content: formatJson({
        sandboxEnabled: isSandboxEnabled(),
        sessions,
      }),
    };
  }, { category: "mcp" });

  registerTool(
    "workspace_mcp_call",
    async ({ args = {} }) => {
      const serverId = args.server ?? args.server_id ?? args.serverId;
      const method = args.method ?? args.call;
      const params =
        typeof args.params === "object" && args.params !== null
          ? args.params
          : {};
      if (typeof serverId !== "string" || !serverId.trim()) {
        throw new Error("workspace_mcp_call requires a server id.");
      }
      if (typeof method !== "string" || !method.trim()) {
        throw new Error("workspace_mcp_call requires a method name.");
      }
      const client = await ensureClient(serverId.trim());
      if (!client) {
        throw new Error(`MCP server "${serverId}" is not available.`);
      }
      const result = await client.request(method.trim(), params);
      return {
        ok: true,
        status: 200,
        content: formatJson({
          server: serverId,
          method: method.trim(),
          result,
        }),
        metadata: {
          server: serverId,
          method: method.trim(),
        },
      };
    },
    { category: "mcp" },
  );

  registerRemoteTools()
    .then(() => {
      logger.info("Registered MCP remote tools");
    })
    .catch((err) => {
      logger.warn({ err }, "Failed to register MCP remote tools");
    });
}

module.exports = {
  registerMcpTools,
};
