const fsp = require("fs/promises");
const { runProcess } = require("../tools/process");
const { registerTool } = require(".");
const { workspaceRoot, resolveWorkspacePath } = require("../workspace");
const { invokeModel } = require("../clients/databricks");
const logger = require("../logger");
const config = require("../config");
const { addDiffComment, listDiffComments, deleteDiffComment } = require("../diff/comments");

async function execGit(args, { timeoutMs = 10000, allowNonZero = false } = {}) {
  const result = await runProcess({
    command: "git",
    args,
    cwd: workspaceRoot,
    env: {},
    timeoutMs,
  });
  if (!allowNonZero && result.exitCode !== 0) {
    const error = new Error(`git ${args.join(" ")} failed with code ${result.exitCode}`);
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result;
}

async function execGitText(args, options) {
  const result = await execGit(args, options);
  return result.stdout ?? "";
}

function parseShortStatus(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const indexStatus = line[0] ?? "";
      const worktreeStatus = line[1] ?? "";
      const file = line.slice(3).trim();
      return { indexStatus, worktreeStatus, file };
    });
}

async function getGitStatus({ pathspec } = {}) {
  const args = ["status", "--branch", "--short"];
  if (pathspec) args.push(pathspec);
  const stdout = await execGitText(args, { allowNonZero: true });
  const lines = stdout.split("\n").filter(Boolean);
  const branchLine = lines.shift() ?? "";
  const match = branchLine.match(/^##\s+([^.\s]+)(?:\.\.\.(\S+))?(.*)$/);
  const branch = match?.[1] ?? null;
  const remote = match?.[2] ?? null;
  const statusTail = match?.[3] ?? "";
  const aheadMatch = statusTail.match(/ahead (\d+)/);
  const behindMatch = statusTail.match(/behind (\d+)/);
  const ahead = aheadMatch ? Number.parseInt(aheadMatch[1], 10) : 0;
  const behind = behindMatch ? Number.parseInt(behindMatch[1], 10) : 0;
  const entries = parseShortStatus(lines.join("\n"));
  const staged = entries.filter((item) => item.indexStatus && item.indexStatus !== " " && item.indexStatus !== "?");
  const unstaged = entries.filter((item) => item.worktreeStatus && item.worktreeStatus !== " " && item.indexStatus !== "?");
  const untracked = entries.filter((item) => item.indexStatus === "?" && item.worktreeStatus === "?");
  return {
    branch,
    remote,
    ahead,
    behind,
    staged: staged.map((item) => ({ status: item.indexStatus, file: item.file })),
    unstaged: unstaged.map((item) => ({ status: item.worktreeStatus, file: item.file })),
    untracked: untracked.map((item) => ({ file: item.file })),
    raw: stdout.trim(),
  };
}

function validateCommitMessage(message) {
  const pattern = config.policy?.git?.commitMessageRegex;
  if (!pattern) return;
  try {
    const regex = new RegExp(pattern);
    if (!regex.test(message)) {
      throw new Error(
        `Commit message "${message}" does not satisfy POLICY_GIT_COMMIT_REGEX (${pattern}).`,
      );
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      logger.warn({ err, pattern }, "Invalid commit message regex");
      return;
    }
    throw err;
  }
}

async function runPreCommitChecks({ skipTests, source } = {}) {
  const testCommand = config.policy?.git?.testCommand?.trim();
  const requireTests = config.policy?.git?.requireTests === true;
  if (!testCommand) {
    return {
      ran: false,
      skipped: false,
    };
  }
  if (skipTests === true && !requireTests) {
    logger.info("Skipping pre-commit test command on user request.");
    return {
      ran: false,
      skipped: true,
    };
  }
  const result = await runProcess({
    command: "bash",
    args: ["-lc", testCommand],
    cwd: workspaceRoot,
    timeoutMs: 300000,
    env: {
      PRECOMMIT_SOURCE: source ?? "workspace_git_commit",
    },
  });
  if (result.exitCode !== 0) {
    const error = new Error(
      `Pre-commit test command failed (exit ${result.exitCode}). See stderr for details.`,
    );
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return {
    ran: true,
    skipped: false,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function summarizeWithModel({ prompt, model, system, responseFormat }) {
  try {
    const body = {
      model,
      messages: [
        {
          role: "system",
          content:
            system ??
            "You are an expert developer providing concise, actionable summaries of git changes.",
        },
        { role: "user", content: prompt },
      ],
      stream: false,
    };
    if (responseFormat) {
      body.response_format = responseFormat;
    }
    const response = await invokeModel(body);
    if (!response.ok || !response.json) {
      throw new Error(
        `Model call failed with status ${response.status}: ${response.text ?? "Unknown error"}`,
      );
    }
    let content = response.json.choices?.[0]?.message?.content ?? "";
    if (Array.isArray(content)) {
      content = content
        .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
        .join("");
    }
    return typeof content === "string" ? content.trim() : "";
  } catch (err) {
    logger.warn({ err }, "Model summarization failed");
    throw err;
  }
}

function registerGitTools() {
  registerTool(
    "workspace_diff",
    async ({ args = {} }) => {
      const pathspec =
        typeof args.path === "string"
          ? args.path
          : typeof args.file === "string"
          ? args.file
          : undefined;
      const staged = args.staged === true;
      const unified =
        typeof args.unified === "number" && args.unified >= 0 ? args.unified : 3;

      const statusArgs = ["status", "--short"];
      const diffArgs = ["diff", `--unified=${unified}`];
      if (staged) {
        diffArgs.splice(1, 0, "--cached");
      }
      if (pathspec) {
        diffArgs.push(pathspec);
        statusArgs.push(pathspec);
      }

      const statusOutput = await execGitText(statusArgs, { allowNonZero: true });
      let diffOutput = "";
      try {
        diffOutput = await execGitText(diffArgs, { allowNonZero: true });
      } catch (err) {
        diffOutput = err.stdout ?? err.stderr ?? "";
      }

      const statusEntries = parseShortStatus(statusOutput).map((item) => ({
        status: `${item.indexStatus}${item.worktreeStatus}`.trim(),
        file: item.file,
      }));

      const numstatArgs = ["diff", "--numstat"];
      if (staged) numstatArgs.splice(1, 0, "--cached");
      if (pathspec) numstatArgs.push(pathspec);
      let numstatOutput = "";
      try {
        numstatOutput = await execGitText(numstatArgs, { allowNonZero: true });
      } catch (err) {
        numstatOutput = err.stdout ?? err.stderr ?? "";
      }

      const files = numstatOutput
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [additionsRaw, deletionsRaw, file] = line.split("\t");
          const additions = additionsRaw === "-" ? null : Number.parseInt(additionsRaw, 10);
          const deletions = deletionsRaw === "-" ? null : Number.parseInt(deletionsRaw, 10);
          return {
            file,
            additions: Number.isNaN(additions) ? 0 : additions,
            deletions: Number.isNaN(deletions) ? 0 : deletions,
          };
        });

      const totals = files.reduce(
        (acc, item) => {
          acc.additions += item.additions ?? 0;
          acc.deletions += item.deletions ?? 0;
          return acc;
        },
        { additions: 0, deletions: 0 },
      );

      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            staged,
            path: pathspec ?? null,
            status: statusEntries,
            totals,
            files,
            diff: diffOutput.trim(),
          },
          null,
          2,
        ),
        metadata: {
          staged,
          path: pathspec ?? null,
          filesChanged: files.length,
          additions: totals.additions,
          deletions: totals.deletions,
        },
      };
    },
    { category: "git" },
  );

  registerTool(
    "workspace_diff_comments",
    async ({ args = {} }, context = {}) => {
      const action = args.action ?? "list";
      if (action === "list") {
        const filePath =
          typeof args.file === "string"
            ? args.file
            : typeof args.path === "string"
            ? args.path
            : undefined;
        const threadId = typeof args.thread === "string" ? args.thread : undefined;
        const comments = listDiffComments({ filePath, threadId });
        return {
          ok: true,
          status: 200,
          content: JSON.stringify({ comments }, null, 2),
          metadata: {
            count: comments.length,
          },
        };
      }

      if (action === "add") {
        const filePath =
          typeof args.file === "string"
            ? args.file
            : typeof args.path === "string"
            ? args.path
            : (() => {
                throw new Error("diff comment requires a file path.");
              })();
        const comment = args.comment ?? args.text ?? args.body;
        if (typeof comment !== "string" || comment.trim().length === 0) {
          throw new Error("diff comment requires comment text.");
        }
        const line =
          typeof args.line === "number"
            ? args.line
            : typeof args.row === "number"
            ? args.row
            : undefined;
        const hunk = typeof args.hunk === "string" ? args.hunk : undefined;
        const threadId = typeof args.thread === "string" ? args.thread : undefined;
        const author =
          typeof args.author === "string"
            ? args.author
            : context.session?.id ?? context.sessionId ?? null;

        const record = addDiffComment({
          threadId,
          sessionId: context.session?.id ?? context.sessionId ?? null,
          filePath,
          line,
          hunk,
          comment,
          author,
        });
        return {
          ok: true,
          status: 201,
          content: JSON.stringify(record, null, 2),
          metadata: {
            id: record.id,
            threadId: record.threadId,
          },
        };
      }

      if (action === "delete") {
        const id = args.id ?? args.comment_id ?? args.commentId;
        if (!id) {
          throw new Error("diff comment delete requires an id.");
        }
        const success = deleteDiffComment({ id });
        return {
          ok: success,
          status: success ? 200 : 404,
          content: JSON.stringify(
            {
              id,
              deleted: success,
            },
            null,
            2,
          ),
        };
      }

      throw new Error(`Unsupported diff comment action: ${action}`);
    },
    { category: "git" },
  );

  registerTool(
    "workspace_diff_summary",
    async ({ args = {} }) => {
      const pathspec =
        typeof args.path === "string"
          ? args.path
          : typeof args.file === "string"
          ? args.file
          : undefined;
      const staged = args.staged === true;
      const unified =
        typeof args.unified === "number" && args.unified >= 0 ? args.unified : 3;
      const model = typeof args.model === "string" ? args.model : "databricks-claude-sonnet-4-5";
      const maxChars =
        typeof args.max_chars === "number" && args.max_chars > 0 ? args.max_chars : 6000;

      const diffResult = await execGitText(
        staged
          ? ["diff", "--cached", `--unified=${unified}`, ...(pathspec ? [pathspec] : [])]
          : ["diff", `--unified=${unified}`, ...(pathspec ? [pathspec] : [])],
        { allowNonZero: true },
      );

      const diffText = diffResult || "";
      if (diffText.trim().length === 0) {
        return {
          ok: true,
          status: 200,
          content: JSON.stringify(
            {
              staged,
              path: pathspec ?? null,
              summary: "No changes detected.",
              diffPreview: "",
            },
            null,
            2,
          ),
          metadata: {
            staged,
            path: pathspec ?? null,
            summary: "No changes detected.",
          },
        };
      }

      const preview =
        diffText.length > maxChars
          ? `${diffText.slice(0, maxChars)}\n... (truncated)`
          : diffText;

      const prompt = `You are an expert developer. Analyze the diff and respond with JSON:
{
  "summary": "<plain text overview>",
  "per_file": [{"file": "...", "changes": "..."}],
  "risks": ["risk item", ...],
  "tests": ["test to run", ...],
  "followups": ["follow-up task", ...]
}

Git diff:
\`\`\`
${preview}
\`\`\``;

      let summaryText = "";
      let risks = [];
      let tests = [];
      let followups = [];
      let perFile = [];
      try {
        summaryText = await summarizeWithModel({
          prompt,
          model,
          system:
            "You are a senior engineer providing structured review feedback. Return valid JSON exactly matching the requested schema.",
          responseFormat: { type: "json_object" },
        });
        const parsed = JSON.parse(summaryText);
        summaryText = parsed.summary ?? "";
        risks = Array.isArray(parsed.risks) ? parsed.risks : [];
        tests = Array.isArray(parsed.tests) ? parsed.tests : [];
        followups = Array.isArray(parsed.followups) ? parsed.followups : [];
        perFile = Array.isArray(parsed.per_file) ? parsed.per_file : [];
      } catch (err) {
        logger.warn({ err }, "Diff summary generation failed");
        summaryText = `Automated summary unavailable: ${err.message}`;
      }

      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            staged,
            path: pathspec ?? null,
            summary: summaryText,
            perFile,
            risks,
            tests,
            followups,
            diffPreview: preview,
          },
          null,
          2,
        ),
        metadata: {
          staged,
          path: pathspec ?? null,
        },
      };
    },
    { category: "git" },
  );

  registerTool(
    "workspace_git_status",
    async ({ args = {} }) => {
      const pathspec =
        typeof args.path === "string"
          ? args.path
          : typeof args.file === "string"
          ? args.file
          : undefined;
      const status = await getGitStatus({ pathspec });
      return {
        ok: true,
        status: 200,
        content: JSON.stringify(status, null, 2),
        metadata: {
          branch: status.branch,
          ahead: status.ahead,
          behind: status.behind,
          staged: status.staged.length,
          unstaged: status.unstaged.length,
          untracked: status.untracked.length,
        },
      };
    },
    { category: "git" },
  );

  registerTool(
    "workspace_git_stage",
    async ({ args = {} }) => {
      const paths =
        Array.isArray(args.paths) && args.paths.length
          ? args.paths.map(String)
          : typeof args.path === "string"
          ? [args.path]
          : typeof args.file === "string"
          ? [args.file]
          : [];
      if (args.all === true || paths.length === 0) {
        await execGit(["add", "--all"]);
      } else {
        await execGit(["add", ...paths]);
      }
      const status = await getGitStatus({});
      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            staged: status.staged,
            unstaged: status.unstaged,
            untracked: status.untracked,
          },
          null,
          2,
        ),
      };
    },
    { category: "git" },
  );

  registerTool(
    "workspace_git_unstage",
    async ({ args = {} }) => {
      const paths =
        Array.isArray(args.paths) && args.paths.length
          ? args.paths.map(String)
          : typeof args.path === "string"
          ? [args.path]
          : typeof args.file === "string"
          ? [args.file]
          : [];
      if (args.all === true || paths.length === 0) {
        await execGit(["restore", "--staged", "."], { allowNonZero: true });
      } else {
        await execGit(["restore", "--staged", ...paths], { allowNonZero: true });
      }
      const status = await getGitStatus({});
      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            staged: status.staged,
            unstaged: status.unstaged,
            untracked: status.untracked,
          },
          null,
          2,
        ),
      };
    },
    { category: "git" },
  );

  registerTool(
    "workspace_git_commit",
    async ({ args = {} }) => {
      const message = args.message ?? args.msg;
      if (typeof message !== "string" || message.trim().length === 0) {
        throw new Error("Commit message is required.");
      }
      validateCommitMessage(message);

      const tests = await runPreCommitChecks({
        skipTests: args.skip_tests === true || args.skipTests === true,
        source: "workspace_git_commit",
      });

      const commitArgs = ["commit", "-m", message];
      if (args.amend === true) {
        commitArgs.push("--amend");
        if (args.no_edit !== false) {
          commitArgs.push("--no-edit");
        }
      }
      const result = await execGit(commitArgs, { timeoutMs: 20000, allowNonZero: true });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.stdout || "git commit failed");
      }
      const status = await getGitStatus({});
      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            message,
            output: result.stdout.trim(),
            branch: status.branch,
            preCommit: tests,
          },
          null,
          2,
        ),
        metadata: {
          branch: status.branch,
        },
      };
    },
    { category: "git" },
  );

  registerTool(
    "workspace_git_push",
    async ({ args = {} }) => {
      const remote = args.remote ?? "origin";
      const branch = args.branch ?? args.ref ?? "HEAD";
      const pushArgs = ["push", remote, branch];
      if (config.policy?.git?.autoStash === true && args.autostash !== false) {
        await execGit(["stash", "push", "--include-untracked", "-m", "auto-stash-before-push"], {
          allowNonZero: true,
          timeoutMs: 10000,
        });
      }
      if (args.force === true) pushArgs.splice(1, 0, "--force-with-lease");
      const result = await execGit(pushArgs, { timeoutMs: 20000, allowNonZero: true });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.stdout || "git push failed");
      }
      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            remote,
            branch,
            output: result.stdout.trim(),
          },
          null,
          2,
        ),
      };
    },
    { category: "git" },
  );

  registerTool(
    "workspace_git_pull",
    async ({ args = {} }) => {
      const remote = args.remote ?? "origin";
      const branch = args.branch ?? args.ref ?? "";
      const pullArgs = branch ? ["pull", remote, branch] : ["pull", remote];
      const result = await execGit(pullArgs, { timeoutMs: 20000, allowNonZero: true });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.stdout || "git pull failed");
      }
      const status = await getGitStatus({});
      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            remote,
            branch: branch || null,
            output: result.stdout.trim(),
            branchStatus: status,
          },
          null,
          2,
        ),
      };
    },
    { category: "git" },
  );

  registerTool(
    "workspace_git_merge",
    async ({ args = {} }) => {
      const source =
        typeof args.source === "string"
          ? args.source
          : typeof args.branch === "string"
          ? args.branch
          : (() => {
              throw new Error("workspace_git_merge requires a source branch.");
            })();
      const noCommit = args.no_commit === true || args.noCommit === true;
      const squash = args.squash === true;
      const fastForwardOnly = args.ff_only === true || args.ffOnly === true;
      const mergeArgs = ["merge"];
      if (noCommit) mergeArgs.push("--no-commit");
      if (squash) mergeArgs.push("--squash");
      if (fastForwardOnly) mergeArgs.push("--ff-only");
      mergeArgs.push(source);
      const result = await execGit(mergeArgs, { timeoutMs: 20000, allowNonZero: true });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.stdout || "git merge failed");
      }
      const status = await getGitStatus({});
      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            source,
            output: result.stdout.trim(),
            status,
          },
          null,
          2,
        ),
      };
    },
    { category: "git" },
  );

  registerTool(
    "workspace_git_rebase",
    async ({ args = {} }) => {
      const onto =
        typeof args.onto === "string"
          ? args.onto
          : typeof args.upstream === "string"
          ? args.upstream
          : typeof args.branch === "string"
          ? args.branch
          : (() => {
              throw new Error("workspace_git_rebase requires an upstream branch.");
            })();
      const interactive = args.interactive === true || args.i === true;
      const autostash = config.policy?.git?.autoStash === true;
      if (autostash && args.autostash !== false) {
        await execGit(["stash", "push", "--include-untracked", "-m", "auto-stash-before-rebase"], {
          allowNonZero: true,
          timeoutMs: 10000,
        });
      }
      const rebaseArgs = ["rebase"];
      if (interactive) rebaseArgs.push("-i");
      if (args.keep_empty === true) rebaseArgs.push("--keep-empty");
      if (args.autostash === true || (autostash && args.autostash !== false)) {
        rebaseArgs.push("--autostash");
      }
      rebaseArgs.push(onto);
      const result = await execGit(rebaseArgs, { timeoutMs: 30000, allowNonZero: true });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.stdout || "git rebase failed");
      }
      const status = await getGitStatus({});
      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            onto,
            interactive,
            output: result.stdout.trim(),
            status,
          },
          null,
          2,
        ),
      };
    },
    { category: "git" },
  );

  registerTool(
    "workspace_git_conflicts",
    async () => {
      const result = await execGit(["diff", "--name-only", "--diff-filter=U"], {
        allowNonZero: true,
      });
      const files = result
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const details = [];
      for (const file of files) {
        try {
          const absolute = resolveWorkspacePath(file);
          const content = await fsp.readFile(absolute, "utf8");
          const conflictCount = (content.match(/<<<<<<< /g) || []).length;
          details.push({
            file,
            conflicts: conflictCount,
          });
        } catch (err) {
          details.push({
            file,
            conflicts: null,
            error: err.message,
          });
        }
      }
      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            files,
            details,
          },
          null,
          2,
        ),
        metadata: {
          count: files.length,
        },
      };
    },
    { category: "git" },
  );

  registerTool(
    "workspace_git_branches",
    async ({ args = {} }) => {
      const includeRemote = args.remote === true;
      const branchArgs = includeRemote ? ["branch", "--all"] : ["branch"];
      const stdout = await execGitText(branchArgs, { allowNonZero: true });
      const branches = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => ({
          current: line.startsWith("*"),
          name: line.replace(/^\*/, "").trim(),
        }));
      return {
        ok: true,
        status: 200,
        content: JSON.stringify({ branches }, null, 2),
        metadata: {
          total: branches.length,
        },
      };
    },
    { category: "git" },
  );

  registerTool(
    "workspace_git_checkout",
    async ({ args = {} }) => {
      const branch = args.branch ?? args.name;
      if (!branch) {
        throw new Error("Provide a branch name.");
      }
      const create = args.create === true;
      const checkoutArgs = create ? ["checkout", "-b", branch] : ["checkout", branch];
      const result = await execGit(checkoutArgs, { timeoutMs: 15000, allowNonZero: true });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.stdout || "git checkout failed");
      }
      const status = await getGitStatus({});
      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            branch,
            created: create,
            output: result.stdout.trim(),
            currentBranch: status.branch,
          },
          null,
          2,
        ),
      };
    },
    { category: "git" },
  );

  registerTool(
    "workspace_git_stash",
    async ({ args = {} }) => {
      const action = (args.action ?? "push").toLowerCase();
      if (["push", "save"].includes(action)) {
        const message = args.message ?? args.msg ?? "WIP";
        const stashArgs = ["stash", "push", "-m", message];
        if (args.include_untracked === true) stashArgs.push("--include-untracked");
        const result = await execGit(stashArgs, { timeoutMs: 10000, allowNonZero: true });
        if (result.exitCode !== 0) {
          throw new Error(result.stderr || result.stdout || "git stash push failed");
        }
        return {
          ok: true,
          status: 200,
          content: JSON.stringify(
            {
              action: "push",
              message,
              output: result.stdout.trim(),
            },
            null,
            2,
          ),
        };
      }
      if (action === "pop") {
        const result = await execGit(["stash", "pop"], { timeoutMs: 10000, allowNonZero: true });
        if (result.exitCode !== 0) {
          throw new Error(result.stderr || result.stdout || "git stash pop failed");
        }
        return {
          ok: true,
          status: 200,
          content: JSON.stringify(
            {
              action: "pop",
              output: result.stdout.trim(),
            },
            null,
            2,
          ),
        };
      }
      if (action === "list") {
        const stdout = await execGitText(["stash", "list"], { allowNonZero: true });
        return {
          ok: true,
          status: 200,
          content: JSON.stringify(
            {
              action: "list",
              stashes: stdout
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
            },
            null,
            2,
          ),
        };
      }
      throw new Error(`Unsupported stash action: ${action}`);
    },
    { category: "git" },
  );

  registerTool(
    "workspace_git_patch_plan",
    async ({ args = {} }) => {
      const staged = args.staged === true;
      const files =
        Array.isArray(args.files) && args.files.length
          ? args.files.map(String)
          : typeof args.file === "string"
          ? [args.file]
          : [];

      const diffArgs = staged ? ["diff", "--cached"] : ["diff"];
      if (files.length) diffArgs.push("--", ...files);
      const diffOutput = await execGitText(diffArgs, { allowNonZero: true });
      if (!diffOutput.trim()) {
        return {
          ok: true,
          status: 200,
          content: JSON.stringify(
            {
              staged,
              files,
              plan: [],
              diff: "",
              message: "No changes to plan.",
            },
            null,
            2,
          ),
        };
      }

      const prompt = `You are helping plan how to apply this diff. Produce JSON describing discrete patch steps and verification notes. Output format:
{
  "steps": [
    {"file": "...", "summary": "...", "intent": "...", "risk": "low|medium|high"}
  ],
  "tests": ["command or check", ...],
  "notes": ["additional considerations"]
}

Diff:
\`\`\`
${diffOutput.slice(0, 12000)}
\`\`\``;

      let planText;
      try {
        planText = await summarizeWithModel({
          prompt,
          model: args.model ?? "databricks-claude-sonnet-4-5",
          system:
            "You are a senior engineer decomposing diffs into actionable patch steps. Respond with valid JSON.",
          responseFormat: { type: "json_object" },
        });
      } catch (err) {
        logger.warn({ err }, "Patch planning failed");
        planText = JSON.stringify(
          {
            steps: [],
            tests: [],
            notes: [`Automated plan unavailable: ${err.message}`],
          },
          null,
          2,
        );
      }

      return {
        ok: true,
        status: 200,
        content: planText,
      };
    },
    { category: "git" },
  );

  registerTool(
    "workspace_diff_review",
    async ({ args = {} }) => {
      const staged = args.staged === true;
      const pathspec =
        typeof args.path === "string"
          ? args.path
          : typeof args.file === "string"
          ? args.file
          : undefined;
      const unified =
        typeof args.unified === "number" && args.unified >= 0 ? args.unified : 5;
      const reviewerModel =
        typeof args.model === "string" ? args.model : "databricks-claude-sonnet-4-5";
      const diffText =
        (await execGitText(
          staged
            ? ["diff", "--cached", `--unified=${unified}`, ...(pathspec ? [pathspec] : [])]
            : ["diff", `--unified=${unified}`, ...(pathspec ? [pathspec] : [])],
          { allowNonZero: true },
        )) || "";
      if (diffText.trim().length === 0) {
        return {
          ok: true,
          status: 200,
          content: JSON.stringify(
            {
              summary: "No changes to review.",
              checklist: [],
              comments: [],
            },
            null,
            2,
          ),
        };
      }

      let review = {
        summary: "",
        checklist: [],
        comments: [],
      };
      const prompt = `You are reviewing code changes. Provide JSON with:
{
  "summary": "<overview>",
  "checklist": ["item1", "item2"],
  "comments": [{"file": "...", "line": <number|null>, "comment": "..."}]
}

Git diff:
\`\`\`
${diffText}
\`\`\``;

      try {
        const content = await summarizeWithModel({
          prompt,
          model: reviewerModel,
          system:
            "You are a senior engineer performing a thorough code review. Respond with valid JSON matching the requested shape.",
          responseFormat: { type: "json_object" },
        });
        review = JSON.parse(content);
      } catch (err) {
        logger.warn({ err }, "Diff review generation failed");
        review.summary = `Automated review unavailable: ${err.message}`;
      }

      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            staged,
            path: pathspec ?? null,
            summary: review.summary ?? "",
            checklist: Array.isArray(review.checklist) ? review.checklist : [],
            comments: Array.isArray(review.comments) ? review.comments : [],
          },
          null,
          2,
        ),
      };
    },
    { category: "git" },
  );

  registerTool(
    "workspace_release_notes",
    async ({ args = {} }) => {
      const commitLimit =
        typeof args.limit === "number" && args.limit > 0 ? args.limit : 20;
      const since = args.since ?? args.from;
      const until = args.until ?? args.to;
      const model =
        typeof args.model === "string" ? args.model : "databricks-claude-sonnet-4-5";

      const logArgs = ["log", `-n${commitLimit}`, "--pretty=format:%H%x09%an%x09%ad%x09%s"];
      if (since && until) {
        logArgs.splice(2, 0, `${since}..${until}`);
      } else if (since) {
        logArgs.splice(2, 0, `${since}..HEAD`);
      }

      const stdout = await execGitText(logArgs, { allowNonZero: true });
      if (!stdout.trim()) {
        return {
          ok: true,
          status: 200,
          content: JSON.stringify(
            {
              notes: "No commits found for the specified range.",
              commits: [],
            },
            null,
            2,
          ),
        };
      }

      const commits = stdout.split("\n").map((line) => {
        const [hash, author, date, subject] = line.split("\t");
        return {
          hash,
          shortHash: hash.slice(0, 8),
          author,
          date,
          subject,
        };
      });

      const prompt = `Generate release notes for the following commits. Group related changes, highlight key features, bug fixes, breaking changes, and list follow-up tasks if relevant.

Commits:
${commits
  .map((c) => `- ${c.shortHash} ${c.subject} (${c.author} on ${c.date})`)
  .join("\n")}
`;

      let notes;
      try {
        notes = await summarizeWithModel({
          prompt,
          model,
          system:
            "You are a release manager summarizing recent changes. Produce Markdown release notes with sections such as Highlights, Fixes, Improvements, and Breaking Changes when appropriate.",
        });
      } catch (err) {
        notes = `Automated release notes unavailable: ${err.message}`;
      }

      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            notes,
            commits,
          },
          null,
          2,
        ),
      };
    },
    { category: "git" },
  );

  registerTool(
    "workspace_diff_by_commit",
    async ({ args = {} }) => {
      const since = args.since ?? args.from;
      const until = args.until ?? args.to;
      const limit =
        typeof args.limit === "number" && args.limit > 0 ? args.limit : 10;

      const range = since && until ? `${since}..${until}` : since ? `${since}..HEAD` : null;
      const commitsArgs = ["log", `-n${limit}`, "--pretty=format:%H"];
      if (range) commitsArgs.splice(2, 0, range);
      const stdout = await execGitText(commitsArgs, { allowNonZero: true });
      const commitHashes = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const results = [];
      for (const hash of commitHashes) {
        const showArgs = ["show", "--stat", "--pretty=format:%H%x09%an%x09%ad%x09%s", hash];
        const showOutput = await execGitText(showArgs, { allowNonZero: true });
        const [header, ...statLines] = showOutput.split("\n").filter(Boolean);
        const [commitHash, author, date, subject] = header.split("\t");
        const files = statLines.map((line) => line.trim());
        results.push({
          commit: commitHash,
          shortHash: commitHash.slice(0, 8),
          author,
          date,
          subject,
          files,
        });
      }
      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            range: range ?? "latest",
            commits: results,
          },
          null,
          2,
        ),
      };
    },
    { category: "git" },
  );

  registerTool(
    "workspace_changelog_generate",
    async ({ args = {} }) => {
      const since = args.since ?? args.from;
      const until = args.until ?? args.to ?? "HEAD";
      const limit = typeof args.limit === "number" ? Math.min(Math.max(args.limit, 1), 200) : 50;
      const range = since ? `${since}..${until}` : `HEAD~${limit}..${until}`;
      const logArgs = ["log", range, "--pretty=format:%H%x09%ad%x09%an%x09%s"];
      const stdout = await execGitText(logArgs, { allowNonZero: true });
      const rows = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [hash, date, author, subject] = line.split("\t");
          return { hash, shortHash: hash.slice(0, 8), date, author, subject };
        });

      const prompt = `Produce a chronological changelog in Markdown for these commits.
Each entry should include commit short hash, title, author, and highlight notable impact.

Commits:
${rows
  .map((row) => `${row.shortHash} | ${row.subject} | ${row.author} | ${row.date}`)
  .join("\n")}
`;
      let changelog;
      try {
        changelog = await summarizeWithModel({
          prompt,
          model: args.model ?? "databricks-claude-sonnet-4-5",
          system:
            "You are a release manager writing concise Markdown changelog entries grouped by theme when possible.",
        });
      } catch (err) {
        changelog = `Automated changelog unavailable: ${err.message}`;
      }

      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            range,
            commits: rows,
            changelog,
          },
          null,
          2,
        ),
      };
    },
    { category: "git" },
  );

  registerTool(
    "workspace_pr_template_generate",
    async ({ args = {} }) => {
      const stagedOnly = args.staged === true;
      const diffArgs = stagedOnly ? ["diff", "--cached"] : ["diff"];
      const diff = await execGitText(diffArgs, { allowNonZero: true });
      const status = await getGitStatus({});
      const prompt = `Generate a pull request description template based on this diff and git status.
Include sections: Summary, Testing, Risk, Rollback Plan, Related Tickets.

Git Status:
${status.raw}

Diff:
\`\`\`
${diff.slice(0, 15000)}
\`\`\``;

      let template;
      try {
        template = await summarizeWithModel({
          prompt,
          model: args.model ?? "databricks-claude-sonnet-4-5",
          system:
            "You are preparing a high-quality pull request description. Output Markdown with clear section headers and actionable content.",
        });
      } catch (err) {
        template = `Automated PR template unavailable: ${err.message}`;
      }

      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            stagedOnly,
            template,
          },
          null,
          2,
        ),
      };
    },
    { category: "git" },
  );
}

module.exports = {
  registerGitTools,
};
