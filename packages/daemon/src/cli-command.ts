import type { HubToDaemonCliCommand } from "@cc-remote/proto";

export interface CliCommandDeps {
  lookupPane(session_id: string): { tmux_pane: string | null; tmux_session: string | null } | null;
  spawn(cmd: string, args: string[]): void;
  log(msg: string): void;
}

export function handleCliCommand(frame: HubToDaemonCliCommand, deps: CliCommandDeps): void {
  const target = deps.lookupPane(frame.session_id);
  if (!target) {
    deps.log(`cli_command: unknown session ${frame.session_id}`);
    return;
  }
  const t = target.tmux_pane ?? target.tmux_session;
  if (!t) {
    deps.log(`cli_command: no tmux target for session ${frame.session_id} (pane=null, session=null)`);
    return;
  }
  deps.spawn("tmux", ["send-keys", "-t", t, frame.text, "Enter"]);
  deps.log(`cli_command: sent "${frame.text}" to ${t} (user=${frame.user})`);
}
