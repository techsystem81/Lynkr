const logger = require("../../logger");
const { analyzeWithTreeSitter } = require("./providers/treeSitter");

const PROVIDERS = [analyzeWithTreeSitter];

function analyzeFile({ relativePath, content, language }) {
  for (const provider of PROVIDERS) {
    try {
      const result = provider({ relativePath, content, language });
      if (result && result.definitions && result.definitions.length) {
        return result;
      }
      if (result) {
        return result;
      }
    } catch (err) {
      logger.debug(
        {
          err,
          provider: provider.name,
          file: relativePath,
        },
        "Navigation provider failed",
      );
    }
  }
  return null;
}

module.exports = {
  analyzeFile,
};
