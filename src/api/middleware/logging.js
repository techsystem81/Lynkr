const pinoHttp = require("pino-http");
const logger = require("../../logger");

function maskHeaders(headers = {}) {
  const clone = { ...headers };
  if (typeof clone["x-api-key"] === "string") {
    clone["x-api-key"] = "***redacted***";
  }
  if (typeof clone["x-anthropic-api-key"] === "string") {
    clone["x-anthropic-api-key"] = "***redacted***";
  }
  return clone;
}

const loggingMiddleware = pinoHttp({
  logger,
  customProps: (req) => ({
    sessionId: req.sessionId ?? null,
  }),
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  wrapSerializers: true,
  serializers: {
    req(req) {
      return {
        method: req.method,
        url: req.url,
        headers: maskHeaders(req.headers),
      };
    },
  },
});

module.exports = loggingMiddleware;
