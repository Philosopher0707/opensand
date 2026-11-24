/**
 * Pre-flight bash syntax and safety validator.
 * Validates command line completeness before dispatching to the shell,
 * catching syntax errors, unclosed delimiters, and destructive root patterns.
 */

export interface ValidationResult {
  valid: boolean;
  isDangerous: boolean;
  error?: string;
  dangerReason?: string;
}

// Destructive flags in every spelling an attacker can use: combined -rf/-fr,
// split -r -f, and long --recursive --force (either order).
const RM_FLAGS = String.raw`(?:-(?:[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)(?![a-zA-Z])|-(?:r|f)(?:\s+--?[a-zA-Z0-9-]+)*\s+-(?:f|r)(?![a-zA-Z])|--recursive(?:\s+--?[a-zA-Z0-9-]+)*\s+--force|--force(?:\s+--?[a-zA-Z0-9-]+)*\s+--recursive)`;
// A wrapped command ends the path with a quote, paren, backtick or shell operator
// instead of whitespace/end, so the old (?:\s|$) terminator let it through.
const CMD_EDGE = '[\\s;&|)"`]|$';
const RM_PREFIX = String.raw`\brm\b(?:\s+--?[a-zA-Z0-9-]+)*?\s+` + RM_FLAGS + String.raw`(?:\s+--?[a-zA-Z0-9-]+)*\s+`;

const DANGEROUS_PATTERNS = [
  {
    pattern: new RegExp(RM_PREFIX + String.raw`(?:\/\*?|~\/?|\$\([^)]*\/[^)]*\))` + `(?:${CMD_EDGE})`),
    reason: "Destructive root/home recursive deletion",
  },
  {
    // A bare variable (X=/; rm -rf $X) hides the root/home target from the pattern above.
    pattern: new RegExp(RM_PREFIX + String.raw`\$\{?[A-Za-z_][A-Za-z0-9_]*\}?` + `(?:${CMD_EDGE})`),
    reason: "Destructive recursive deletion via variable",
  },
  { pattern: /\bmkfs(?:\.[a-zA-Z0-9]+)?\s+/, reason: "Filesystem formatting command" },
  { pattern: />\s*\/dev\/[srh]d[a-z0-9]/, reason: "Raw device overwrite" },
  { pattern: /\b(?:dd\s+if=.*of=\/dev\/)/, reason: "Raw device write via dd" },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "Fork bomb detected" },
];

// A nested shell or runtime evaluation can assemble any command after this point,
// so a regex denylist cannot see through it. Force a human prompt in every mode.
export const NESTED_SHELL_RE = /\b(?:sh|bash|zsh|dash)\b[^\n]*\s-[a-zA-Z]*c\b|\beval\b|\$\(|`|\|\s*(?:sh|bash|zsh|dash)\b|\bbase64\b[^\n]*\s-[a-zA-Z]*d\b[^\n]*\||\bsource\b|(?:^|[\s;&|])\.\s+\S+/;

export function validateBashCommand(command: string): ValidationResult {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { valid: false, isDangerous: false, error: "Empty command string" };
  }

  // 1. Quotes must not hide a destructive target: r""m -rf /, rm -rf ""/, rm -rf "$HOME"
  // and sh -c "rm -rf /" all reduce to the bare form for matching. Syntax checks
  // below still use the original text.
  const forMatching = trimmed.replace(/["']/g, "");
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(forMatching)) {
      return { valid: true, isDangerous: true, dangerReason: reason };
    }
  }

  // 2. Syntax check: Unbalanced quotes
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let isEscaped = false;

  const parenStack: string[] = [];

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (isEscaped) {
      isEscaped = false;
      continue;
    }

    if (char === "\\" && !inSingleQuote) {
      isEscaped = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote && !inBacktick) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote && !inBacktick) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === "`" && !inSingleQuote) {
      inBacktick = !inBacktick;
      continue;
    }

    // Only check parenthesis/braces when outside quotes
    if (!inSingleQuote && !inDoubleQuote && !inBacktick) {
      if (char === "(" || char === "{" || char === "[") {
        parenStack.push(char);
      } else if (char === ")") {
        const last = parenStack.pop();
        if (last !== "(") {
          return { valid: false, isDangerous: false, error: "Unmatched closing parenthesis ')'" };
        }
      } else if (char === "}") {
        const last = parenStack.pop();
        if (last !== "{") {
          return { valid: false, isDangerous: false, error: "Unmatched closing brace '}'" };
        }
      } else if (char === "]") {
        const last = parenStack.pop();
        if (last !== "[") {
          return { valid: false, isDangerous: false, error: "Unmatched closing bracket ']'" };
        }
      }
    }
  }

  if (isEscaped) {
    return { valid: false, isDangerous: false, error: "Incomplete command ending with trailing escape character '\\'" };
  }

  if (inSingleQuote) {
    return { valid: false, isDangerous: false, error: "Unclosed single quote in command" };
  }

  if (inDoubleQuote) {
    return { valid: false, isDangerous: false, error: "Unclosed double quote in command" };
  }

  if (inBacktick) {
    return { valid: false, isDangerous: false, error: "Unclosed backtick in command" };
  }

  if (parenStack.length > 0) {
    const unclosed = parenStack.pop();
    const nameMap: Record<string, string> = {
      "(": "parenthesis",
      "{": "curly brace",
      "[": "bracket",
    };
    const desc = nameMap[unclosed!] || "delimiter";
    return { valid: false, isDangerous: false, error: `Unclosed ${desc} '${unclosed}' in command` };
  }

  return { valid: true, isDangerous: false };
}
