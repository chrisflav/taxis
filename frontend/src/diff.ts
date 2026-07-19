export interface DiffPart {
  type: "equal" | "add" | "remove";
  text: string;
}

// Tokenize into words plus the whitespace runs between them, so the diff aligns on word
// boundaries instead of individual characters.
function tokenize(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? [];
}

// Above this token count the O(n*m) LCS table gets too large; fall back to a plain remove+add
// pair instead of hanging on pathologically long text.
const MAX_TOKENS = 2000;

// Word-level diff via a classic LCS dynamic-programming table, used to highlight only the parts of
// a title/description/comment that actually changed between two edit-history revisions.
export function diffWords(oldText: string, newText: string): DiffPart[] {
  const a = tokenize(oldText);
  const b = tokenize(newText);

  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    const parts: DiffPart[] = [];
    if (oldText) parts.push({ type: "remove", text: oldText });
    if (newText) parts.push({ type: "add", text: newText });
    return parts;
  }

  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const parts: DiffPart[] = [];
  const push = (type: DiffPart["type"], text: string) => {
    const last = parts[parts.length - 1];
    if (last && last.type === type) last.text += text;
    else parts.push({ type, text });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push("equal", a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push("remove", a[i]); i++; }
    else { push("add", b[j]); j++; }
  }
  while (i < n) { push("remove", a[i]); i++; }
  while (j < m) { push("add", b[j]); j++; }
  return parts;
}
