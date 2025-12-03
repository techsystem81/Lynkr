const {
  createTask,
  listTasks,
  getTaskById,
  updateTask,
  deleteTask,
  setTaskStatus,
} = require("../tasks/store");
const { registerTool } = require(".");

function normaliseTagsInput(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : null))
      .filter((item) => item && item.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return undefined;
}

function normaliseMetadataInput(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return { note: value };
    }
  }
  return undefined;
}

function parseLimit(limit) {
  if (limit === undefined || limit === null) return undefined;
  const num = Number(limit);
  if (!Number.isFinite(num)) return undefined;
  const int = Math.trunc(num);
  if (int <= 0) return undefined;
  return Math.min(int, 500);
}

function registerTaskTools() {
  registerTool(
    "workspace_tasks_list",
    async ({ args = {} }) => {
      const tasks = listTasks({
        status: typeof args.status === "string" ? args.status.trim() : undefined,
        linkedFile:
          typeof args.file === "string"
            ? args.file
            : typeof args.path === "string"
            ? args.path
            : undefined,
        search: typeof args.search === "string" ? args.search : undefined,
        limit: parseLimit(args.limit),
        orderBy: typeof args.order === "string" ? args.order : undefined,
      });

      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            tasks,
            total: tasks.length,
          },
          null,
          2,
        ),
        metadata: {
          count: tasks.length,
        },
      };
    },
    { category: "tasks" },
  );

  registerTool(
    "workspace_task_get",
    async ({ args = {} }) => {
      const id = Number.parseInt(args.id ?? args.task_id ?? args.taskId, 10);
      if (!Number.isFinite(id)) {
        throw new Error("workspace_task_get requires a numeric id.");
      }
      const task = getTaskById(id);
      if (!task) {
        return {
          ok: false,
          status: 404,
          content: JSON.stringify(
            {
              error: "task_not_found",
              id,
            },
            null,
            2,
          ),
          metadata: {
            id,
            found: false,
          },
        };
      }
      return {
        ok: true,
        status: 200,
        content: JSON.stringify(task, null, 2),
        metadata: {
          id,
        },
      };
    },
    { category: "tasks" },
  );

  registerTool(
    "workspace_task_create",
    async ({ args = {} }, context = {}) => {
      const title = args.title ?? args.name ?? args.summary;
      if (typeof title !== "string" || !title.trim()) {
        throw new Error("workspace_task_create requires a title.");
      }

      const tags = normaliseTagsInput(args.tags);
      const metadata = normaliseMetadataInput(args.metadata);
      const task = createTask({
        title,
        status: typeof args.status === "string" ? args.status.trim() : "todo",
        priority:
          Number.isFinite(args.priority) || Number.isFinite(Number(args.priority))
            ? Number(args.priority)
            : 0,
        tags,
        linkedFile:
          typeof args.file === "string"
            ? args.file
            : typeof args.path === "string"
            ? args.path
            : null,
        createdBy: context.session?.id ?? context.sessionId ?? null,
        metadata,
      });

      return {
        ok: true,
        status: 201,
        content: JSON.stringify(task, null, 2),
        metadata: {
          id: task.id,
        },
      };
    },
    { category: "tasks" },
  );

  registerTool(
    "workspace_task_update",
    async ({ args = {} }, context = {}) => {
      const id = Number.parseInt(args.id ?? args.task_id ?? args.taskId, 10);
      if (!Number.isFinite(id)) {
        throw new Error("workspace_task_update requires a numeric id.");
      }

      const updates = {};
      if (args.title !== undefined) updates.title = args.title;
      if (args.status !== undefined) updates.status = args.status;
      if (args.priority !== undefined) updates.priority = Number(args.priority);
      const tags = normaliseTagsInput(args.tags);
      if (tags !== undefined) updates.tags = tags;
      if (args.file !== undefined || args.path !== undefined) {
        updates.linkedFile =
          typeof args.file === "string"
            ? args.file
            : typeof args.path === "string"
            ? args.path
            : null;
      }
      const metadata = normaliseMetadataInput(args.metadata);
      if (metadata !== undefined) updates.metadata = metadata;

      updates.updatedBy = context.session?.id ?? context.sessionId ?? null;

      const task = updateTask(id, updates);
      return {
        ok: true,
        status: 200,
        content: JSON.stringify(task, null, 2),
        metadata: {
          id: task.id,
        },
      };
    },
    { category: "tasks" },
  );

  registerTool(
    "workspace_task_set_status",
    async ({ args = {} }, context = {}) => {
      const id = Number.parseInt(args.id ?? args.task_id ?? args.taskId, 10);
      if (!Number.isFinite(id)) {
        throw new Error("workspace_task_set_status requires a numeric id.");
      }
      const status = args.status ?? args.state;
      if (typeof status !== "string" || !status.trim()) {
        throw new Error("workspace_task_set_status requires a non-empty status.");
      }
      const task = setTaskStatus(id, status.trim(), context.session?.id ?? context.sessionId ?? null);
      return {
        ok: true,
        status: 200,
        content: JSON.stringify(task, null, 2),
        metadata: {
          id: task.id,
          status: task.status,
        },
      };
    },
    { category: "tasks" },
  );

  registerTool(
    "workspace_task_delete",
    async ({ args = {} }) => {
      const id = Number.parseInt(args.id ?? args.task_id ?? args.taskId, 10);
      if (!Number.isFinite(id)) {
        throw new Error("workspace_task_delete requires a numeric id.");
      }
      const deleted = deleteTask(id);
      return {
        ok: deleted,
        status: deleted ? 200 : 404,
        content: JSON.stringify(
          {
            id,
            deleted,
          },
          null,
          2,
        ),
        metadata: {
          id,
          deleted,
        },
      };
    },
    { category: "tasks" },
  );
}

module.exports = {
  registerTaskTools,
};
