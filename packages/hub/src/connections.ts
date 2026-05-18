import type { HubToDaemon, HubToPwa } from "@cc-remote/proto";

type Sender<T> = (frame: T) => void;

interface Entry<W, T> {
  ws: W;
  send: Sender<T>;
  onEvict?: () => void;
}

export class DaemonRegistry<W> {
  private entries = new Map<string, Entry<W, HubToDaemon>>();

  add(daemon_id: string, ws: W, send: Sender<HubToDaemon>, onEvict?: () => void): void {
    const existing = this.entries.get(daemon_id);
    if (existing) existing.onEvict?.();
    this.entries.set(daemon_id, { ws, send, onEvict });
  }

  remove(daemon_id: string): void {
    this.entries.delete(daemon_id);
  }

  has(daemon_id: string): boolean {
    return this.entries.has(daemon_id);
  }

  list(): string[] {
    return [...this.entries.keys()];
  }

  send(daemon_id: string, frame: HubToDaemon): boolean {
    const e = this.entries.get(daemon_id);
    if (!e) return false;
    e.send(frame);
    return true;
  }
}

export class PwaRegistry<W> {
  private next = 1;
  private entries = new Map<string, Entry<W, HubToPwa>>();

  add(ws: W, send: Sender<HubToPwa>): string {
    const id = `pwa-${this.next++}`;
    this.entries.set(id, { ws, send });
    return id;
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  send(id: string, frame: HubToPwa): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    e.send(frame);
    return true;
  }

  broadcast(frame: HubToPwa): void {
    for (const e of this.entries.values()) e.send(frame);
  }
}
