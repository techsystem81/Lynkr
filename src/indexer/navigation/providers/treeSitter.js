const { parseFile } = require("../../parser");

function analyzeWithTreeSitter({ relativePath, content, language }) {
  if (typeof content !== "string") {
    return null;
  }
  const analysis = parseFile(relativePath, content, language);
  if (!analysis) {
    return null;
  }
  const engine = "tree_sitter";
  const withEngine = (items) =>
    Array.isArray(items)
      ? items.map((item) => ({
          ...item,
          engine,
        }))
      : [];
  return {
    engine,
    language: analysis.language ?? language,
    symbols: analysis.symbols ?? [],
    definitions: analysis.definitions ?? analysis.symbols ?? [],
    references: withEngine(analysis.references),
    dependencies: analysis.dependencies ?? [],
    exports: withEngine(analysis.exports),
    imports: withEngine(analysis.imports),
    metadata: {
      relativePath,
    },
  };
}

module.exports = {
  analyzeWithTreeSitter,
};
