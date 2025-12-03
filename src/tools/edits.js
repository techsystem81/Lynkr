const { getEditHistory, revertEdit } = require("../edits");
const { registerTool } = require(".");
const logger = require("../logger");

function registerEditHistoryTool() {
  registerTool(
    "workspace_edit_history",
    async ({ args = {} }) => {
      const limit =
        typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 100) : 20;
      const filePath =
        typeof args.path === "string"
          ? args.path
          : typeof args.file === "string"
          ? args.file
          : undefined;
      const sessionId =
        typeof args.session_id === "string"
          ? args.session_id
          : typeof args.sessionId === "string"
          ? args.sessionId
          : undefined;

      const history = getEditHistory({ filePath, sessionId, limit });
      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            edits: history,
            limit,
            filePath,
            sessionId,
          },
          null,
          2,
        ),
        metadata: {
          count: history.length,
        },
      };
    },
    { category: "workspace" },
  );
}

function registerEditRevertTool() {
  registerTool(
    "workspace_edit_revert",
    async ({ args = {} }, context = {}) => {
      const editId = args.id ?? args.edit_id ?? args.editId;
      if (typeof editId !== "number" && typeof editId !== "string") {
        throw new Error("workspace_edit_revert requires an edit id (numeric).");
      }
      const numericId = Number(editId);
      if (Number.isNaN(numericId)) {
        throw new Error("Edit id must be numeric.");
      }
      const sessionId = context.session?.id ?? context.sessionId ?? null;
      try {
        const result = await revertEdit({ editId: numericId, sessionId });
        return {
          ok: true,
          status: 200,
          content: JSON.stringify(
            {
              revertedEditId: result.revertedEditId,
              filePath: result.filePath,
            },
            null,
            2,
          ),
          metadata: {
            revertedEditId: result.revertedEditId,
            filePath: result.filePath,
          },
        };
      } catch (err) {
        logger.warn({ err, editId: numericId }, "Failed to revert edit");
        throw err;
      }
    },
    { category: "workspace" },
  );
}

function registerEditTools() {
  registerEditHistoryTool();
  registerEditRevertTool();
}

module.exports = {
  registerEditTools,
};
