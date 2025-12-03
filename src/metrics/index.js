const metrics = {
  requestsTotal: 0,
  responses: {
    success: 0,
    error: 0,
  },
  streamingSessions: 0,
};

function recordRequest() {
  metrics.requestsTotal += 1;
}

function recordStreamingStart() {
  metrics.streamingSessions += 1;
}

function recordResponse(status) {
  if (status >= 200 && status < 400) {
    metrics.responses.success += 1;
  } else {
    metrics.responses.error += 1;
  }
}

function snapshot() {
  return {
    ...metrics,
    timestamp: Date.now(),
  };
}

module.exports = {
  recordRequest,
  recordResponse,
  recordStreamingStart,
  snapshot,
};
