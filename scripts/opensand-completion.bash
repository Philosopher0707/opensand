# bash completion for opensand
_opensand_completions() {
  local cur prev opts subcommands
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  subcommands="doctor status completion"
  opts="--endpoint --model --api-key --bot --system-prompt --worktree --list-tools --list-bots --list-tasks --auto-approve -y --help -h --version -v --completion ${subcommands}"

  # Subcommand specific completions
  if [[ "${prev}" == "completion" ]]; then
    COMPREPLY=( $(compgen -W "bash zsh" -- "${cur}") )
    return 0
  fi

  if [[ "${prev}" == "--bot" ]]; then
    # Return nothing or let user type
    return 0
  fi

  if [[ "${prev}" == "--endpoint" || "${prev}" == "--model" || "${prev}" == "--api-key" ]]; then
    return 0
  fi

  if [[ "${prev}" == "--system-prompt" ]]; then
    COMPREPLY=( $(compgen -f -- "${cur}") )
    return 0
  fi

  if [[ ${cur} == -* ]] || [[ ${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
    return 0
  fi
}

complete -F _opensand_completions opensand
