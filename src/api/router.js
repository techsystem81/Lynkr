const express = require("express");
const { processMessage } = require("../orchestrator");
const { getSession } = require("../sessions");
const metrics = require("../metrics");

const router = express.Router();

router.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

router.get("/debug/session", (req, res) => {
  if (!req.sessionId) {
    return res.status(400).json({ error: "missing_session_id", message: "Provide x-session-id header" });
  }
  const session = getSession(req.sessionId);
  if (!session) {
    return res.status(404).json({ error: "session_not_found", message: "Session not found" });
  }
  res.json({ session });
});

router.post("/v1/messages", async (req, res, next) => {
  try {
    metrics.recordRequest();
    const wantsStream = Boolean(req.body?.stream);
    const result = await processMessage({
      payload: req.body,
      headers: req.headers,
      session: req.session,
      options: {
        maxSteps: req.body?.max_steps,
        maxDurationMs: req.body?.max_duration_ms,
      },
    });

    if (wantsStream) {
      metrics.recordStreamingStart();
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
      }

      const eventPayload = {
        type: "message",
        message: result.body,
      };
      res.write(`event: message\n`);
      res.write(`data: ${JSON.stringify(eventPayload)}\n\n`);

      res.write(`event: end\n`);
      res.write(
        `data: ${JSON.stringify({ termination: result.terminationReason ?? "completion" })}\n\n`,
      );

      metrics.recordResponse(result.status);
      res.end();
      return;
    }

    if (result.headers) {
      Object.entries(result.headers).forEach(([key, value]) => {
        if (value !== undefined) {
          res.setHeader(key, value);
        }
      });
    }

    metrics.recordResponse(result.status);
    res.status(result.status).send(result.body);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
