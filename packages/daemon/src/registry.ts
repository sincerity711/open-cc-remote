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

  list(): SessionSnapshot[] {
    return [...this.sessions.values()];
  }

  onAdd(l: AddListener): void { this.adds.push(l); }
  onRemove(l: RemoveListener): void { this.removes.push(l); }
}
