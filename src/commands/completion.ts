export const completionShells = ["bash", "zsh", "fish"] as const;
export type CompletionShell = (typeof completionShells)[number];

const COMMANDS = [
  "adapters",
  "apply",
  "audit",
  "completion",
  "config",
  "doctor",
  "history",
  "lock",
  "plan",
  "show",
] as const;

const SUBCOMMANDS = {
  completion: [...completionShells],
  config: ["init", "path", "show", "validate"],
  lock: ["recover", "status"],
  show: ["plan", "resource", "run"],
} as const;

function bashCompletion(): string {
  return `# bash completion for AgentRinse
_agentrinse_completion() {
  local current command
  current="\${COMP_WORDS[COMP_CWORD]}"
  command="\${COMP_WORDS[1]}"

  if [[ "\${COMP_CWORD}" -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${COMMANDS.join(" ")}" -- "\${current}") )
    return
  fi

  case "\${command}" in
    completion) COMPREPLY=( $(compgen -W "${SUBCOMMANDS.completion.join(" ")}" -- "\${current}") ) ;;
    config) COMPREPLY=( $(compgen -W "${SUBCOMMANDS.config.join(" ")}" -- "\${current}") ) ;;
    lock) COMPREPLY=( $(compgen -W "${SUBCOMMANDS.lock.join(" ")}" -- "\${current}") ) ;;
    show) COMPREPLY=( $(compgen -W "${SUBCOMMANDS.show.join(" ")}" -- "\${current}") ) ;;
    *) COMPREPLY=( $(compgen -W "--help --version --home --config --state-dir --json --ndjson --redact --yes --output --audit --plan --since" -- "\${current}") ) ;;
  esac
}
complete -F _agentrinse_completion agentrinse
`;
}

function zshCompletion(): string {
  return `#compdef agentrinse

_agentrinse() {
  local -a commands
  commands=(
${COMMANDS.map((command) => `    '${command}:${command}'`).join("\n")}
  )

  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi

  case "\${words[2]}" in
    completion) _values 'shell' ${SUBCOMMANDS.completion.join(" ")} ;;
    config) _values 'config command' ${SUBCOMMANDS.config.join(" ")} ;;
    lock) _values 'lock command' ${SUBCOMMANDS.lock.join(" ")} ;;
    show) _values 'show command' ${SUBCOMMANDS.show.join(" ")} ;;
    *) _arguments '*:argument:_files' ;;
  esac
}

compdef _agentrinse agentrinse
`;
}

function fishCompletion(): string {
  const lines = [
    "# fish completion for AgentRinse",
    "complete -c agentrinse -f",
    ...COMMANDS.map(
      (command) =>
        `complete -c agentrinse -n '__fish_use_subcommand' -a '${command}' -d '${command}'`,
    ),
  ];
  for (const [command, subcommands] of Object.entries(SUBCOMMANDS)) {
    for (const subcommand of subcommands) {
      lines.push(
        `complete -c agentrinse -n '__fish_seen_subcommand_from ${command}' -a '${subcommand}'`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderCompletion(shell: string): string {
  if (shell === "bash") {
    return bashCompletion();
  }
  if (shell === "zsh") {
    return zshCompletion();
  }
  if (shell === "fish") {
    return fishCompletion();
  }
  throw new Error(`unsupported completion shell ${shell}; expected bash, zsh, or fish`);
}
