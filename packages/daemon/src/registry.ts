import type { SessionSnapshot } from "@cc-remote/proto";

type AddListener = (s: SessionSnapshot) => void;
type RemoveListener = (session_id: string) => void;

export class LiveSessions {
  private sessions = new Map<string, SessionSnapshot>();
  private adds: AddListener[] = [];
  private removes: RemoveListener[] = [];

  add(s: SessionSnapshot): void {
    if (this.sessions.has(s.session_id)) return;
    this.sessions.set(s.session_id, s);
    for (const l of this.adds) l(s);
  }

  update(session_id: string, patch: Partial<SessionSnapshot>): void {
    const cur = this.sessions.get(session_id);
    if (!cur) return;
    this.sessions.set(session_id, { ...cur, ...patch });
  }

  remove(session_id: string): void {
    if (!this.sessions.has(session_id)) return;
    this.sessions.delete(session_id);
    for (const l of this.removes) l(session_id);
  }

  get(session_id: string): SessionSnapshot | undefined {
    return this.sessions.get(session_id);
  }

  /** Reverse lookup by claude_session_id (the JSONL filename UUID). Returns
   * the first match, since claude_session_id is unique per running session.
   * Used by the AskUserQuestion hook flow — hooks only know CC's session_id
   * (== claude_session_id), not the plugin-issued daemon session_id. */
  getByClaudeSessionId(claude_session_id: string): SessionSnapshot | undefined {
    for (const s of this.sessions.values()) {
      if (s.claude_session_id === claude_session_id) return s;
    }
    return undefined;
  }

  list(): SessionSnapshot[] {
    return [...this.sessions.values()];
  }

  onAdd(l: AddListener): void { this.adds.push(l); }
  onRemove(l: RemoveListener): void { this.removes.push(l); }
}
