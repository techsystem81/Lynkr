const BROWSING_FALLBACK_PATTERNS = [
  /i (do|don't|cannot) have (browser|browsing|internet) (capability|access)/i,
  /cannot look up information/i,
  /no web browsing capability/i,
  /can'?t (access|reach) the internet/i,
  /(do not|don't) have access to .*web (?:browsing|browser|internet)/i,
  /(do not|don't) have .*browser/i,
  /web(fetch|_fetch| search).*(not available|disabled|unavailable)/i,
  /tool.*(not available|disabled|unavailable)/i,
  /don't have access to real-time/i,
];

function needsWebFallback(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  // If the response already includes concrete financial data, skip fallback.
  if (
    /\bclosed at \$\d[\d.,]*/i.test(trimmed) ||
    /\bprevious close\b/i.test(trimmed) ||
    /\bday'?s range\b/i.test(trimmed) ||
    /\btrading volume\b/i.test(trimmed)
  ) {
    return false;
  }

  return BROWSING_FALLBACK_PATTERNS.some((regex) => regex.test(trimmed));
}

module.exports = {
  needsWebFallback,
};
