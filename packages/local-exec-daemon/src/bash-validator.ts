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

const DANGEROUS_PATTERNS = [
  {
    pattern: /\brm\b(?:\s+--?[a-zA-Z0-9-]+)*\s+-(?:[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)\b(?:\s+--?[a-zA-Z0-9-]+)*\s+(?:\/|\/\*|~)(?:\s|$)/,
    reason: "Destructive root/home recursive deletion",
  },
  { pattern: /\bmkfs(?:\.[a-zA-Z0-9]+)?\s+/, reason: "Filesystem formatting command" },
  { pattern: />\s*\/dev\/[srh]d[a-z0-9]/, reason: "Raw device overwrite" },
  { pattern: /\b(?:dd\s+if=.*of=\/dev\/)/, reason: "Raw device write via dd" },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "Fork bomb detected" },
];

export function validateBashCommand(command: string): ValidationResult {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { valid: false, isDangerous: false, error: "Empty command string" };
  }

  // 1. Check for dangerous destructive patterns
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
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
