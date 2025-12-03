const {
  loadConfiguredServers,
  listServers,
  getServer,
  ensureClient,
  getClient,
  listClients,
} = require("./registry");
const {
  isSandboxEnabled,
  runSandboxProcess,
  ensureSession,
  listSessions,
  releaseSession,
} = require("./sandbox");

function initialiseMcp() {
  loadConfiguredServers();
}

module.exports = {
  initialiseMcp,
  loadConfiguredServers,
  listServers,
  getServer,
  ensureClient,
  getClient,
  listClients,
  isSandboxEnabled,
  runSandboxProcess,
  ensureSession,
  listSessions,
  releaseSession,
};
