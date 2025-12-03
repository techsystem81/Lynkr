const fs = require("fs/promises");
const path = require("path");
const { createTwoFilesPatch } = require("diff");
const db = require("../db");
const { resolveWorkspacePath } = require("../workspace");
const logger = require("../logger");

const insertEditStmt = db.prepare(
  `INSERT INTO edits (
    session_id,
    file_path,
    created_at,
    source,
    before_content,
    after_content,
    diff,
    metadata
  ) VALUES (
    @session_id,
    @file_path,
    @created_at,
    @source,
    @before_content,
    @after_content,
    @diff,
    @metadata
  )`,
);

const selectEditByIdStmt = db.prepare(
  `SELECT id, session_id, file_path, created_at, source,
          before_content, after_content, diff, metadata
   FROM edits WHERE id = ?`,
);

function buildHistoryQuery({ filePath, sessionId, limit }) {
  let query = `SELECT id, session_id, file_path, created_at, source,
                      before_content, after_content, diff, metadata
               FROM edits`;
  const conditions = [];
  const params = [];
  if (filePath) {
    conditions.push("file_path = ?");
    params.push(filePath);
  }
  if (sessionId) {
    conditions.push("session_id = ?");
    params.push(sessionId);
  }
  if (conditions.length) {
    query += ` WHERE ${conditions.join(" AND ")}`;
  }
  query += " ORDER BY created_at DESC";
  if (limit) {
    query += ` LIMIT ${limit}`;
  }
  return { query, params };
}

function computeDiff(filePath, beforeContent, afterContent) {
  const before = beforeContent ?? "";
  const after = afterContent ?? "";
  if (before === after) return null;
  return createTwoFilesPatch(
    path.join("before", filePath),
    path.join("after", filePath),
    before,
    after,
    undefined,
    undefined,
    { context: 3 },
  );
}

function recordEdit({
  sessionId,
  filePath,
  source = "tool",
  beforeContent,
  afterContent,
  metadata,
}) {
  if ((beforeContent ?? "") === (afterContent ?? "")) {
    return null;
  }
  const diff = computeDiff(filePath, beforeContent, afterContent);
  const createdAt = Date.now();
  insertEditStmt.run({
    session_id: sessionId ?? null,
    file_path: filePath,
    created_at: createdAt,
    source,
    before_content: beforeContent ?? null,
    after_content: afterContent ?? null,
    diff,
    metadata: metadata ? JSON.stringify(metadata) : null,
  });
  logger.info(
    {
      sessionId,
      filePath,
      source,
    },
    "Recorded workspace edit",
  );
  return {
    sessionId,
    filePath,
    createdAt,
    diff,
  };
}

function getEditHistory({ filePath, sessionId, limit }) {
  const { query, params } = buildHistoryQuery({
    filePath,
    sessionId,
    limit,
  });
  const rows = db.prepare(query).all(...params);
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    filePath: row.file_path,
    createdAt: row.created_at,
    source: row.source,
    diff: row.diff,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  }));
}

async function revertEdit({ editId, sessionId }) {
  const row = selectEditByIdStmt.get(editId);
  if (!row) {
    throw new Error(`Edit ${editId} not found.`);
  }

  const absolute = resolveWorkspacePath(row.file_path);
  if (row.before_content === null || row.before_content === undefined) {
    // Original file did not exist; delete if present.
    try {
      await fs.unlink(absolute);
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }
  } else {
    await fs.writeFile(absolute, row.before_content, "utf8");
  }

  recordEdit({
    sessionId,
    filePath: row.file_path,
    source: "revert_edit",
    beforeContent: row.after_content,
    afterContent: row.before_content,
    metadata: { revertedEditId: row.id },
  });

  return {
    revertedEditId: row.id,
    filePath: row.file_path,
  };
}

module.exports = {
  recordEdit,
  getEditHistory,
  revertEdit,
};
