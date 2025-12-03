const express = require("express");
const config = require("./config");
const loggingMiddleware = require("./api/middleware/logging");
const router = require("./api/router");
const { sessionMiddleware } = require("./api/middleware/session");
const metrics = require("./metrics");
const logger = require("./logger");
const { initialiseMcp } = require("./mcp");
const { registerStubTools } = require("./tools/stubs");
const { registerWorkspaceTools } = require("./tools/workspace");
const { registerExecutionTools } = require("./tools/execution");
const { registerWebTools } = require("./tools/web");
const { registerIndexerTools } = require("./tools/indexer");
const { registerEditTools } = require("./tools/edits");
const { registerGitTools } = require("./tools/git");
const { registerTaskTools } = require("./tools/tasks");
const { registerTestTools } = require("./tools/tests");
const { registerMcpTools } = require("./tools/mcp");

initialiseMcp();
registerStubTools();
registerWorkspaceTools();
registerExecutionTools();
registerWebTools();
registerIndexerTools();
registerEditTools();
registerGitTools();
registerTaskTools();
registerTestTools();
registerMcpTools();

function createApp() {
  const app = express();

  app.use(express.json({ limit: config.server.jsonLimit }));
  app.use(sessionMiddleware);
  app.use(loggingMiddleware);

  app.get("/metrics", (req, res) => {
    res.json(metrics.snapshot());
  });

  app.use(router);

  // Basic error handler to surface issues cleanly.
  app.use((err, req, res, next) => {
    logger.error({ err }, "Request error");
    if (res.headersSent) {
      return next(err);
    }
    const status = err.status ?? 500;
    metrics.recordResponse(status);
    res.status(status).json({
      error: err.code ?? "internal_error",
      message: err.message ?? "Unexpected error",
    });
  });

  return app;
}

function start() {
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`Claude→Databricks proxy listening on http://localhost:${config.port}`);
  });
  return app;
}

module.exports = {
  createApp,
  start,
};
