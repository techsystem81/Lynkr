const { appendSessionTurn } = require("./store");

function ensureSessionShape(session) {
  if (!session) return null;
  if (!Array.isArray(session.history)) {
    session.history = [];
  }
  if (!session.createdAt) {
    session.createdAt = Date.now();
  }
  return session;
}

function appendTurnToSession(session, entry) {
  const target = ensureSessionShape(session);
  if (!target) return null;

  const turn = { ...entry, timestamp: Date.now() };
  target.history.push(turn);
  target.updatedAt = turn.timestamp;

  if (target.id) {
    appendSessionTurn(target.id, turn, target.metadata ?? {});
  }

  return turn;
}

module.exports = {
  appendTurnToSession,
};
