#compdef opensand

_opensand() {
  local curcontext="$curcontext" state line
  typeset -A opt_args

  local -a subcommands
  subcommands=(
    'doctor:Run system diagnostic probes across host, models, and tools'
    'status:Show complete agent fleet status and resource counts'
    'completion:Generate shell completion script (bash or zsh)'
  )

  local -a flags
  flags=(
    '--endpoint[LLM API base URL (e.g. http://127.0.0.1:11434/v1)]'
    '--model[Model identifier (e.g. qwen2.5-coder:32b, gpt-4o)]'
    '--api-key[API key (defaults to $OPENAI_API_KEY)]'
    '--bot[Activate a registered bot persona from Agent Store]'
    '--system-prompt[Path to custom instructions file]'
    '--worktree[Run in an isolated Git worktree sandbox]'
    '--list-tools[List all active OS, orchestrator, and MCP tools]'
    '--list-bots[List all registered bot personas in Agent Store]'
    '--list-tasks[List all agent tasks and milestones]'
    '--auto-approve[Auto-approve tool execution (non-interactive mode)]'
    '-y[Auto-approve tool execution shorthand]'
    '--help[Show command line help message]'
    '-h[Show command line help shorthand]'
    '--version[Show current OpenSand version]'
    '-v[Show current OpenSand version shorthand]'
    '--completion[Generate shell completion script (bash or zsh)]'
    '*: :->args'
  )

  _arguments -C \
    "1: :->cmd" \
    "*:: :->args" && return 0

  case "$state" in
    cmd)
      _describe -t commands 'opensand subcommands' subcommands
      _values 'opensand options' \
        '--endpoint' \
        '--model' \
        '--api-key' \
        '--bot' \
        '--system-prompt' \
        '--worktree' \
        '--list-tools' \
        '--list-bots' \
        '--list-tasks' \
        '--auto-approve' \
        '-y' \
        '--help' \
        '-h' \
        '--version' \
        '-v' \
        '--completion'
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
          _arguments \
    '--endpoint[LLM API base URL (e.g. http://127.0.0.1:11434/v1)]'
    '--model[Model identifier (e.g. qwen2.5-coder:32b, gpt-4o)]'
    '--api-key[API key (defaults to $OPENAI_API_KEY)]'
    '--bot[Activate a registered bot persona from Agent Store]'
    '--system-prompt[Path to custom instructions file]'
    '--worktree[Run in an isolated Git worktree sandbox]'
    '--list-tools[List all active OS, orchestrator, and MCP tools]'
    '--list-bots[List all registered bot personas in Agent Store]'
    '--list-tasks[List all agent tasks and milestones]'
    '--auto-approve[Auto-approve tool execution (non-interactive mode)]'
    '-y[Auto-approve tool execution shorthand]'
    '--help[Show command line help message]'
    '-h[Show command line help shorthand]'
    '--version[Show current OpenSand version]'
    '-v[Show current OpenSand version shorthand]'
    '--completion[Generate shell completion script (bash or zsh)]'
          ;;
      esac
      ;;
  esac
}

_opensand "$@"
