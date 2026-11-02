/**
 * OpenSand Shell Completion & REPL Autocompletion Generator
 * Zero-dependency native Node.js completion generator for ZSH, Bash, and REPL readline.
 */

export const CLI_SUBCOMMANDS = [
  { name: "doctor", description: "Run system diagnostic probes across host, models, and tools" },
  { name: "status", description: "Show complete agent fleet status and resource counts" },
  { name: "completion", description: "Generate shell completion script (bash or zsh)" },
];

export const CLI_FLAGS = [
  { flag: "--endpoint", description: "LLM API base URL (e.g. http://127.0.0.1:11434/v1)" },
  { flag: "--model", description: "Model identifier (e.g. qwen2.5-coder:32b, gpt-4o)" },
  { flag: "--api-key", description: "API key (defaults to $OPENAI_API_KEY)" },
  { flag: "--bot", description: "Activate a registered bot persona from Agent Store" },
  { flag: "--system-prompt", description: "Path to custom instructions file" },
  { flag: "--worktree", description: "Run in an isolated Git worktree sandbox" },
  { flag: "--list-tools", description: "List all active OS, orchestrator, and MCP tools" },
  { flag: "--list-bots", description: "List all registered bot personas in Agent Store" },
  { flag: "--list-tasks", description: "List all agent tasks and milestones" },
  { flag: "--auto-approve", description: "Auto-approve tool execution (non-interactive mode)" },
  { flag: "-y", description: "Auto-approve tool execution shorthand" },
  { flag: "--help", description: "Show command line help message" },
  { flag: "-h", description: "Show command line help shorthand" },
  { flag: "--version", description: "Show current OpenSand version" },
  { flag: "-v", description: "Show current OpenSand version shorthand" },
  { flag: "--completion", description: "Generate shell completion script (bash or zsh)" },
];

export const REPL_SLASH_COMMANDS = [
  "/help",
  "/tools",
  "/bots",
  "/agents",
  "/bot",
  "/btw",
  "/rollback",
  "/compact",
  "/doctor",
  "/status",
  "/attach",
  "/attachments",
  "/template",
  "/rooms",
  "/room",
  "/routines",
  "/routine",
  "/skills",
  "/skill",
  "/vault",
  "/git",
  "/review",
  "/tasks",
  "/rules",
  "/tokens",
  "/clear",
  "/exit",
  "quit",
  "exit",
];

/**
 * Generate standard Zsh autocompletion function (#compdef opensand).
 */
export function generateZshCompletion(): string {
  const flagDescriptions = CLI_FLAGS.map((f) => {
    const escapedDesc = f.description.replace(/'/g, "''");
    return `    '${f.flag}[${escapedDesc}]'`;
  }).join("\n");

  const subcommandDescriptions = CLI_SUBCOMMANDS.map((s) => {
    const escapedDesc = s.description.replace(/'/g, "''");
    return `    '${s.name}:${escapedDesc}'`;
  }).join("\n");

  return `#compdef opensand

_opensand() {
  local curcontext="$curcontext" state line
  typeset -A opt_args

  local -a subcommands
  subcommands=(
${subcommandDescriptions}
  )

  local -a flags
  flags=(
${flagDescriptions}
    '*: :->args'
  )

  _arguments -C \\
    "1: :->cmd" \\
    "*:: :->args" && return 0

  case "$state" in
    cmd)
      _describe -t commands 'opensand subcommands' subcommands
      _values 'opensand options' \\
${CLI_FLAGS.map((f) => `        '${f.flag}'`).join(" \\\n")}
      ;;
    args)
      case "$words[1]" in
        doctor|status)
          _arguments '(-v --verbose)'{-v,--verbose}'[Verbose probe output]'
          ;;
        completion)
          _values 'shell' 'bash' 'zsh'
          ;;
        *)
          _arguments \\
${flagDescriptions}
          ;;
      esac
      ;;
  esac
}

_opensand "$@"
`;
}

/**
 * Generate standard Bash autocompletion function.
 */
export function generateBashCompletion(): string {
  const flagsList = CLI_FLAGS.map((f) => f.flag).join(" ");
  const subcommandsList = CLI_SUBCOMMANDS.map((s) => s.name).join(" ");

  return `# bash completion for opensand
_opensand_completions() {
  local cur prev opts subcommands
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  subcommands="${subcommandsList}"
  opts="${flagsList} \${subcommands}"

  # Subcommand specific completions
  if [[ "\${prev}" == "completion" ]]; then
    COMPREPLY=( $(compgen -W "bash zsh" -- "\${cur}") )
    return 0
  fi

  if [[ "\${prev}" == "--bot" ]]; then
    # Return nothing or let user type
    return 0
  fi

  if [[ "\${prev}" == "--endpoint" || "\${prev}" == "--model" || "\${prev}" == "--api-key" ]]; then
    return 0
  fi

  if [[ "\${prev}" == "--system-prompt" ]]; then
    COMPREPLY=( $(compgen -f -- "\${cur}") )
    return 0
  fi

  if [[ \${cur} == -* ]] || [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${opts}" -- "\${cur}") )
    return 0
  fi
}

complete -F _opensand_completions opensand
`;
}

/**
 * REPL Readline Tab Completer.
 * Completes slash commands and registered bot names dynamically.
 */
export function getReplCompletions(
  line: string,
  botNames: string[] = []
): [string[], string] {
  const trimmed = line.trimStart();

  // If completing bot switch: /bot <name>
  if (trimmed.startsWith("/bot ")) {
    const query = trimmed.slice(5).toLowerCase();
    const candidateBots = ["default", ...botNames];
    const hits = candidateBots
      .filter((name) => name.toLowerCase().startsWith(query))
      .map((name) => `/bot ${name}`);
    return [hits.length > 0 ? hits : candidateBots.map((n) => `/bot ${n}`), line];
  }

  // If line starts with /, complete slash commands
  if (trimmed.startsWith("/")) {
    const hits = REPL_SLASH_COMMANDS.filter((cmd) => cmd.startsWith(trimmed));
    return [hits.length > 0 ? hits : REPL_SLASH_COMMANDS, line];
  }

  // If line is empty or starts with e/q, suggest exit/quit
  if (trimmed === "e" || trimmed === "ex" || trimmed === "exi") {
    return [["exit"], line];
  }
  if (trimmed === "q" || trimmed === "qu" || trimmed === "qui") {
    return [["quit"], line];
  }

  return [[], line];
}
