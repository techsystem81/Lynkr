const crypto = require("crypto");
const db = require("../db");
const logger = require("../logger");

const insertCommentStmt = db.prepare(
  `INSERT INTO diff_comments (
     thread_id,
     session_id,
     file_path,
     hunk,
     line,
     comment,
     author,
     created_at,
     metadata
   ) VALUES (
     @thread_id,
     @session_id,
     @file_path,
     @hunk,
     @line,
     @comment,
     @author,
     @created_at,
     @metadata
   )`,
);

const deleteCommentStmt = db.prepare("DELETE FROM diff_comments WHERE id = ?");

function buildSelectCommentsQuery({ filePath, threadId }) {
  let sql = `SELECT id,
                    thread_id,
                    session_id,
                    file_path,
                    hunk,
                    line,
                    comment,
                    author,
                    created_at,
                    metadata
             FROM diff_comments`;
  const conditions = [];
  const params = [];
  if (filePath) {
    conditions.push("file_path = ?");
    params.push(filePath);
  }
  if (threadId) {
    conditions.push("thread_id = ?");
    params.push(threadId);
  }
  if (conditions.length) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
  }
  sql += " ORDER BY created_at ASC, id ASC";
  return { sql, params };
}

function normaliseCommentRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id ?? null,
    sessionId: row.session_id ?? null,
    filePath: row.file_path,
    hunk: row.hunk ?? null,
    line: typeof row.line === "number" ? row.line : null,
    comment: row.comment,
    author: row.author ?? null,
    createdAt: row.created_at,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

function addDiffComment({
  threadId,
  sessionId,
  filePath,
  line,
  hunk,
  comment,
  author,
  metadata,
}) {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new Error("Diff comment requires a file path.");
  }
  if (typeof comment !== "string" || comment.trim().length === 0) {
    throw new Error("Diff comment requires non-empty comment text.");
  }

  const createdAt = Date.now();
  const thread = threadId ?? crypto.randomUUID();

  const params = {
    thread_id: thread,
    session_id: sessionId ?? null,
    file_path: filePath,
    hunk: hunk ?? null,
    line: typeof line === "number" ? line : null,
    comment,
    author: author ?? null,
    created_at: createdAt,
    metadata: metadata ? JSON.stringify(metadata) : null,
  };

  const result = insertCommentStmt.run(params);

  logger.debug(
    {
      id: result.lastInsertRowid,
      thread,
      filePath,
      line,
    },
    "Recorded diff comment",
  );

  return normaliseCommentRow({
    id: result.lastInsertRowid,
    thread_id: thread,
    session_id: sessionId ?? null,
    file_path: filePath,
    hunk: hunk ?? null,
    line: typeof line === "number" ? line : null,
    comment,
    author: author ?? null,
    created_at: createdAt,
    metadata: metadata ? JSON.stringify(metadata) : null,
  });
}

function listDiffComments({ filePath, threadId } = {}) {
  const { sql, params } = buildSelectCommentsQuery({ filePath, threadId });
  return db
    .prepare(sql)
    .all(...params)
    .map(normaliseCommentRow);
}

function deleteDiffComment({ id }) {
  if (!id) {
    throw new Error("diff_comment_delete requires an id.");
  }
  const result = deleteCommentStmt.run(id);
  return result.changes > 0;
}

module.exports = {
  addDiffComment,
  listDiffComments,
  deleteDiffComment,
};
