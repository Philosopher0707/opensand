export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

/** What crosses IPC for one file: display fields only. */
export type FileDiffView =
  | { state: "ready"; file: string; hunks: DiffHunk[] }
  | { state: "binary"; file: string }
  | { state: "too-large"; file: string }
  | { state: "unavailable"; file: string };

/** Most bytes of `git diff` output read for one file; more shows "too large to show". */
export const DIFF_MAX_BYTES = 200_000;
/** Most lines kept per hunk list; guards the renderer, not the byte cap. */
export const DIFF_MAX_LINES = 4000;

/** Parses `git diff` output for one file into hunks. File header lines are dropped. */
export function parseUnifiedDiff(text: string): { hunks: DiffHunk[]; binary: boolean; tooManyLines: boolean } {
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  let binary = false;
  let total = 0;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("@@")) {
      cur = { header: raw.replace(/\s+/g, " ").trim(), lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) {
      if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) binary = true;
      continue;
    }
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    const c = raw[0];
    if (c !== "+" && c !== "-" && c !== " ") continue;
    if (++total > DIFF_MAX_LINES) return { hunks, binary, tooManyLines: true };
    cur.lines.push({ kind: c === "+" ? "add" : c === "-" ? "del" : "ctx", text: raw.slice(1) });
  }
  return { hunks, binary, tooManyLines: false };
}

export function diffNote(v: FileDiffView): string | null {
  switch (v.state) {
    case "binary": return "Binary file: no text changes to show.";
    case "too-large": return "This change is too large to show here.";
    case "unavailable": return "Changes are no longer available for this file.";
    case "ready": return v.hunks.length === 0 ? "No text changes in this file." : null;
  }
}
