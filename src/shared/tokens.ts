/**
 * Deterministic, tokenizer-free token estimate.
 *
 * Exact counts depend on each model's tokenizer, which the UI and planner do
 * not have. This heuristic tracks BPE behaviour better than `chars / 4` for
 * the material the harness actually sends: prose, JSON schemas (punctuation
 * heavy), identifiers, and numbers. Values are always labelled as estimates;
 * provider-reported usage is recorded separately when a server returns it.
 */
const tokenPattern = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  let total = 0;
  for (const match of text.matchAll(tokenPattern)) {
    const piece = match[0];
    const first = piece.charCodeAt(0);
    const isLetter = (first >= 65 && first <= 90) || (first >= 97 && first <= 122);
    const isDigit = first >= 48 && first <= 57;
    if (isLetter) total += piece.length <= 6 ? 1 : Math.ceil(piece.length / 5);
    else if (isDigit) total += Math.ceil(piece.length / 3);
    else total += 1;
  }
  // Newline-heavy text costs a little extra in most chat templates.
  const newlines = text.length - text.replaceAll("\n", "").length;
  return total + Math.ceil(newlines / 4);
}

/** Per-message framing overhead used by common chat templates. */
export const MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateJsonTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value));
}

export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${Math.round(tokens / 1_000)}k`;
}

/**
 * Trim text to an approximate token budget on a line or word boundary.
 * Returns the original text when it already fits.
 */
export const TRIM_NOTE = "\n[…trimmed to fit the context budget]";

export function truncateToTokens(text: string, maxTokens: number): { text: string; trimmed: boolean } {
  if (estimateTokens(text) <= maxTokens) return { text, trimmed: false };
  // The note counts against the budget so the result never exceeds maxTokens.
  const budget = maxTokens - estimateTokens(TRIM_NOTE) - 1;
  if (budget <= 0) return { text: "", trimmed: true };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  let cut = text.slice(0, low);
  const boundary = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
  if (boundary > cut.length * 0.6) cut = cut.slice(0, boundary);
  return { text: `${cut.trimEnd()}${TRIM_NOTE}`, trimmed: true };
}
