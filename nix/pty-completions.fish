# Fish completion for pty
# Persistent terminal sessions with detach/attach support

function __pty_sessions
    set -l session_dir "$PTY_SESSION_DIR"
    if test -z "$session_dir"
        set session_dir "$HOME/.local/state/pty"
    end
    if test -d "$session_dir"
        for f in $session_dir/*.json
            if test -f "$f"
                basename $f .json
            end
        end
    end
end

function __pty_needs_command
    set -l cmd (commandline -opc)
    test (count $cmd) -eq 1
end

function __pty_using_command
    set -l cmd (commandline -opc)
    test (count $cmd) -ge 2; and test "$cmd[2]" = "$argv[1]"
end

# Disable file completions by default
complete -c pty -f

# Subcommands
complete -c pty -n __pty_needs_command -a run -d 'Create a session and attach'
complete -c pty -n __pty_needs_command -a attach -d 'Attach to an existing session'
complete -c pty -n __pty_needs_command -a peek -d 'Print current screen or follow output'
complete -c pty -n __pty_needs_command -a send -d 'Send text or keys to a session'
complete -c pty -n __pty_needs_command -a kill -d 'Kill or remove a session'
complete -c pty -n __pty_needs_command -a list -d 'List active sessions'
complete -c pty -n __pty_needs_command -a restart -d 'Restart a session'
complete -c pty -n __pty_needs_command -a test -d 'Run tests'
complete -c pty -n __pty_needs_command -a help -d 'Show usage information'

# run: flags and file completion for the command argument
complete -c pty -n '__pty_using_command run' -s d -l detach -d 'Create in background'
complete -c pty -n '__pty_using_command run' -s a -l attach -d 'Attach if already running'
complete -c pty -n '__pty_using_command run' -F

# attach: session names and flags
complete -c pty -n '__pty_using_command attach' -a '(__pty_sessions)' -d 'Session'
complete -c pty -n '__pty_using_command attach' -s r -l auto-restart -d 'Auto-restart if exited'

# peek: session names and flags
complete -c pty -n '__pty_using_command peek' -a '(__pty_sessions)' -d 'Session'
complete -c pty -n '__pty_using_command peek' -s f -l follow -d 'Follow output read-only'
complete -c pty -n '__pty_using_command peek' -l plain -d 'Output plain text without ANSI'

# send: session names and flags
complete -c pty -n '__pty_using_command send' -a '(__pty_sessions)' -d 'Session'
complete -c pty -n '__pty_using_command send' -l seq -d 'Send a sequence item' -r
complete -c pty -n '__pty_using_command send' -l with-delay -d 'Delay between --seq items (seconds)' -r

# kill: session names
complete -c pty -n '__pty_using_command kill' -a '(__pty_sessions)' -d 'Session'

# restart: session names and flags
complete -c pty -n '__pty_using_command restart' -a '(__pty_sessions)' -d 'Session'
complete -c pty -n '__pty_using_command restart' -s y -l yes -d 'Skip confirmation'

# list: flags
complete -c pty -n '__pty_using_command list' -l json -d 'Output as JSON'

# test: subcommands and flags
complete -c pty -n '__pty_using_command test' -a watch -d 'Watch mode'
complete -c pty -n '__pty_using_command test' -s t -d 'Run matching tests' -r
