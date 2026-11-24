// Pure SGR-to-span parser for tool card <pre> blocks. Preact escapes text, so escape codes
// become styled spans instead of markup: nothing in a tool result can inject HTML.

export interface AnsiSpan {
  text: string;
  color?: string;
  background?: string;
  bold?: boolean;
}

type Style = Omit<AnsiSpan, "text">;

// Readable on the shell's dark surface; the bright variants are 90-97 / 100-107.
const FOREGROUND = [
  "#8b949e", "#ff7b72", "#3fb950", "#d29922",
  "#58a6ff", "#bc8cff", "#39c5cf", "#e6edf3",
  "#c9d1d9", "#ffa198", "#56d364", "#e3b341",
  "#79c0ff", "#d2a8ff", "#56d4dd", "#f0f6fc",
];
const BACKGROUND = [
  "#21262d", "#3d1a1a", "#12321e", "#3a2c0f",
  "#13294a", "#2b1e42", "#0e3538", "#484f58",
  "#30363d", "#5a2626", "#1b4429", "#4d3a14",
  "#1d3f6b", "#3d2a5c", "#16454a", "#6e7681",
];

// Groups 1 and 2 are the SGR parameters of the real and literal `\x1b` spellings.
const ESCAPE = new RegExp(
  [
    "\\u001b\\[([0-9;]*)m",
    "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)",
    "\\u001b\\[[0-?]*[ -/]*[@-~]",
    "\\u001b\\[[0-9;]*",
    "\\u001b[@-_]",
    "\\\\x1b\\[([0-9;]*)m",
    "\\\\x1b\\[[0-?]*[ -/]*[@-~]",
    "\\\\x1b\\[[0-9;]*",
  ].join("|"),
  "gi",
);

function applySgr(params: string, current: Style): Style {
  let next: Style = { ...current };
  for (const raw of params.split(";")) {
    if (raw === "") continue;
    const code = Number(raw);
    if (!Number.isFinite(code)) continue;
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 22) delete next.bold;
    else if (code >= 30 && code <= 37) next.color = FOREGROUND[code - 30];
    else if (code >= 90 && code <= 97) next.color = FOREGROUND[code - 90 + 8];
    else if (code === 39) delete next.color;
    else if (code >= 40 && code <= 47) next.background = BACKGROUND[code - 40];
    else if (code >= 100 && code <= 107) next.background = BACKGROUND[code - 100 + 8];
    else if (code === 49) delete next.background;
  }
  return next;
}

/** Turns ANSI escape codes into styled plain-text spans; unknown sequences are dropped. */
export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let style: Style = {};
  let last = 0;

  const append = (text: string) => {
    if (!text) return;
    const previous = spans[spans.length - 1];
    const same =
      previous &&
      previous.color === style.color &&
      previous.background === style.background &&
      previous.bold === style.bold;
    if (same) previous.text += text;
    else spans.push({ ...style, text });
  };

  for (const match of input.matchAll(ESCAPE)) {
    append(input.slice(last, match.index));
    const params = match[1] ?? match[2];
    if (params !== undefined) style = applySgr(params, style);
    last = (match.index ?? 0) + match[0].length;
  }
  append(input.slice(last));
  return spans;
}
