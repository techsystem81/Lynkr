const config = require("../config");

if (typeof fetch !== "function") {
  throw new Error("Node 18+ is required for the built-in fetch API.");
}

async function performJsonRequest(url, { headers = {}, body }, providerLabel) {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  console.log(`=== ${providerLabel} response ===`);
  console.log("Status:", response.status);
  console.log(text);
  console.log("===========================");

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    json,
    text,
    contentType: response.headers.get("content-type"),
  };
}

async function invokeDatabricks(body) {
  if (!config.databricks?.url) {
    throw new Error("Databricks configuration is missing required URL.");
  }
  const headers = {
    Authorization: `Bearer ${config.databricks.apiKey}`,
    "Content-Type": "application/json",
  };
  return performJsonRequest(config.databricks.url, { headers, body }, "Databricks");
}

async function invokeAzureAnthropic(body) {
  if (!config.azureAnthropic?.endpoint) {
    throw new Error("Azure Anthropic endpoint is not configured.");
  }
  const headers = {
    "Content-Type": "application/json",
    "x-api-key": config.azureAnthropic.apiKey,
    "anthropic-version": config.azureAnthropic.version ?? "2023-06-01",
  };
  return performJsonRequest(
    config.azureAnthropic.endpoint,
    { headers, body },
    "Azure Anthropic",
  );
}

async function invokeModel(body) {
  const provider = config.modelProvider?.type ?? "databricks";
  if (provider === "azure-anthropic") {
    return invokeAzureAnthropic(body);
  }
  return invokeDatabricks(body);
}

module.exports = {
  invokeModel,
};
