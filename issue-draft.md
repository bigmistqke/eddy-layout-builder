# Title
Visual companion server exits immediately on macOS when started via Claude Code's `run_in_background` Bash tool

# Body

## Environment
- **OS**: macOS
- **superpowers version**: 5.0.7
- **Claude Code Bash tool**: `run_in_background: true`

## What happens

When the brainstorm server is started without `--foreground`, it exits within seconds with `"reason":"owner process exited"`.

## Root cause

`start-server.sh` resolves `OWNER_PID` as the grandparent of the script's shell:

```bash
OWNER_PID="$(ps -o ppid= -p "$PPID" 2>/dev/null | tr -d ' ')"
```

When Claude Code runs the script via its `run_in_background` Bash tool, the process tree looks like this:

```
Claude harness
  └── Bash background task (PID X)       ← OWNER_PID resolves here
        └── shell (PPID in script)
              └── start-server.sh
```

The Bash background task (PID X) exits as soon as the script returns output. The server detects the owner died and shuts itself down — often before the browser can even connect.

This is distinct from the Windows issues (#770, #767, #737): on macOS `ps -o ppid=` resolves correctly, but it resolves to the *wrong* process — the ephemeral background task rather than the persistent Claude harness.

## Workaround

Use `--foreground` with `run_in_background: true` on the Bash tool call. The node process runs in the foreground of the background task, keeping it alive for the session duration:

```bash
# Bash tool call with run_in_background: true
start-server.sh --project-dir /path/to/project --foreground
```

## Suggested fix

Same approach as the v5.0.6 Windows fix: at startup, validate whether `OWNER_PID` is still alive. If it's already dead, disable owner-PID monitoring and fall back to the 30-minute idle timeout. This would make the default (non-`--foreground`) mode resilient to the background task timing out.

Alternatively, document `--foreground` as the recommended mode for Claude Code specifically.
