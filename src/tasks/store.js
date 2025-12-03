const db = require("../db");
const logger = require("../logger");

const ORDER_FIELDS = {
  default: "status ASC, priority DESC, updated_at DESC",
  status: "status ASC, priority DESC, updated_at DESC",
  priority: "priority DESC, updated_at DESC",
  updated: "updated_at DESC",
  created: "created_at DESC",
};

const insertTaskStmt = db.prepare(
  `INSERT INTO tasks (
     title,
     status,
     priority,
     tags,
     linked_file,
     created_at,
     updated_at,
     created_by,
     updated_by,
     metadata
   ) VALUES (
     @title,
     @status,
     @priority,
     @tags,
     @linked_file,
     @created_at,
     @updated_at,
     @created_by,
     @updated_by,
     @metadata
   )`,
);

const selectTaskByIdStmt = db.prepare(
  `SELECT
     id,
     title,
     status,
     priority,
     tags,
     linked_file,
     created_at,
     updated_at,
     created_by,
     updated_by,
     metadata
   FROM tasks
   WHERE id = ?`,
);

const deleteTaskStmt = db.prepare("DELETE FROM tasks WHERE id = ?");
const countTasksByStatusStmt = db.prepare(
  `SELECT status, COUNT(1) AS total
   FROM tasks
   GROUP BY status`,
);
const listRecentTasksStmt = db.prepare(
  `SELECT
     id,
     title,
     status,
     priority,
     tags,
     linked_file,
     created_at,
     updated_at,
     created_by,
     updated_by,
     metadata
   FROM tasks
   ORDER BY updated_at DESC
   LIMIT ?`,
);

function resolveOrder(orderBy) {
  if (typeof orderBy === "string") {
    const key = orderBy.toLowerCase().trim();
    if (ORDER_FIELDS[key]) {
      return ORDER_FIELDS[key];
    }
  }
  return ORDER_FIELDS.default;
}

function buildListQuery({ status, linkedFile, search, limit, orderBy }) {
  let sql = `SELECT
               id,
               title,
               status,
               priority,
               tags,
               linked_file,
               created_at,
               updated_at,
               created_by,
               updated_by,
               metadata
             FROM tasks`;
  const conditions = [];
  const params = [];

  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }
  if (linkedFile) {
    conditions.push("linked_file = ?");
    params.push(linkedFile);
  }
  if (search) {
    conditions.push("LOWER(title) LIKE ?");
    params.push(`%${search.toLowerCase()}%`);
  }
  if (conditions.length) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
  }

  sql += ` ORDER BY ${resolveOrder(orderBy)}`;

  if (Number.isInteger(limit) && limit > 0) {
    sql += " LIMIT ?";
    params.push(limit);
  }

  return { sql, params };
}

function normaliseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (err) {
      logger.debug({ err }, "Failed to parse JSON column");
      return fallback;
    }
  }
  return value;
}

function normaliseTaskRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: typeof row.priority === "number" ? row.priority : Number(row.priority ?? 0),
    tags: normaliseJson(row.tags, []),
    linkedFile: row.linked_file ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
    metadata: normaliseJson(row.metadata, null),
  };
}

function serializeTags(tags) {
  if (!tags) return null;
  if (Array.isArray(tags) && tags.length === 0) return "[]";
  try {
    return JSON.stringify(tags);
  } catch (err) {
    logger.debug({ err }, "Failed to serialise tags");
    return null;
  }
}

function serializeMetadata(metadata) {
  if (!metadata) return null;
  try {
    return JSON.stringify(metadata);
  } catch (err) {
    logger.debug({ err }, "Failed to serialise metadata");
    return null;
  }
}

function getTaskById(id) {
  const row = selectTaskByIdStmt.get(id);
  return normaliseTaskRow(row);
}

function createTask({
  title,
  status = "todo",
  priority = 0,
  tags = [],
  linkedFile = null,
  createdBy = null,
  metadata = null,
}) {
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new Error("Task title is required.");
  }

  const now = Date.now();
  const params = {
    title: title.trim(),
    status: typeof status === "string" && status.trim().length ? status.trim() : "todo",
    priority: Number.isFinite(priority) ? Math.trunc(priority) : 0,
    tags: serializeTags(tags),
    linked_file: linkedFile ?? null,
    created_at: now,
    updated_at: now,
    created_by: createdBy ?? null,
    updated_by: createdBy ?? null,
    metadata: serializeMetadata(metadata),
  };
  const result = insertTaskStmt.run(params);
  return getTaskById(result.lastInsertRowid);
}

function listTasks(options = {}) {
  const { sql, params } = buildListQuery({
    status: options.status,
    linkedFile: options.linkedFile ?? options.path ?? options.file,
    search: options.search ?? options.query ?? null,
    limit: options.limit,
    orderBy: options.orderBy,
  });
  return db
    .prepare(sql)
    .all(...params)
    .map(normaliseTaskRow);
}

function updateTask(id, updates = {}) {
  if (!id) {
    throw new Error("Task id is required for update.");
  }
  const fields = [];
  const params = {};

  if (updates.title !== undefined) {
    if (typeof updates.title !== "string" || !updates.title.trim()) {
      throw new Error("Task title must be a non-empty string.");
    }
    fields.push("title = @title");
    params.title = updates.title.trim();
  }
  if (updates.status !== undefined) {
    if (typeof updates.status !== "string" || !updates.status.trim()) {
      throw new Error("Task status must be a non-empty string.");
    }
    fields.push("status = @status");
    params.status = updates.status.trim();
  }
  if (updates.priority !== undefined) {
    fields.push("priority = @priority");
    params.priority = Number.isFinite(updates.priority)
      ? Math.trunc(updates.priority)
      : 0;
  }
  if (updates.tags !== undefined) {
    fields.push("tags = @tags");
    params.tags = serializeTags(updates.tags);
  }
  if (updates.linkedFile !== undefined) {
    fields.push("linked_file = @linked_file");
    params.linked_file =
      updates.linkedFile === null || updates.linkedFile === undefined
        ? null
        : String(updates.linkedFile);
  }
  if (updates.metadata !== undefined) {
    fields.push("metadata = @metadata");
    params.metadata = serializeMetadata(updates.metadata);
  }
  if (updates.updatedBy !== undefined) {
    fields.push("updated_by = @updated_by");
    params.updated_by =
      updates.updatedBy === null || updates.updatedBy === undefined
        ? null
        : String(updates.updatedBy);
  }

  if (!fields.length) {
    return getTaskById(id);
  }

  params.updated_at = Date.now();
  params.id = id;
  fields.push("updated_at = @updated_at");

  const sql = `UPDATE tasks SET ${fields.join(", ")} WHERE id = @id`;
  const stmt = db.prepare(sql);
  const result = stmt.run(params);
  if (result.changes === 0) {
    throw new Error(`Task ${id} not found.`);
  }
  return getTaskById(id);
}

function setTaskStatus(id, status, updatedBy) {
  return updateTask(id, { status, updatedBy });
}

function deleteTask(id) {
  if (!id) {
    throw new Error("Task id is required for deletion.");
  }
  const result = deleteTaskStmt.run(id);
  return result.changes > 0;
}

function normaliseLimit(limit, fallback = 5) {
  if (limit === undefined || limit === null) return fallback;
  const num = Number(limit);
  if (!Number.isFinite(num)) return fallback;
  const clamped = Math.trunc(num);
  if (clamped <= 0) return 0;
  return Math.min(clamped, 50);
}

function getTaskSummary(options = {}) {
  const counts = countTasksByStatusStmt.all();
  const byStatus = counts.map((row) => ({
    status: row.status,
    total: row.total,
  }));
  const total = byStatus.reduce((acc, item) => acc + item.total, 0);
  const limit = normaliseLimit(options.limit, 5);
  let recent = [];
  if (limit > 0) {
    recent = listRecentTasksStmt
      .all(limit)
      .map(normaliseTaskRow);
  }
  return {
    total,
    byStatus,
    recent,
  };
}

module.exports = {
  createTask,
  listTasks,
  getTaskById,
  updateTask,
  setTaskStatus,
  deleteTask,
  getTaskSummary,
};
