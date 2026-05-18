import { useEffect, useRef, useState } from "react";
import type { EventFrameForPwa } from "@cc-remote/proto";

interface SessionPaneProps {
  daemon_id: string;
  session_id: string;
  events: EventFrameForPwa[];
  onClose: () => void;
}

export function SessionPane({ daemon_id, session_id, events, onClose }: SessionPaneProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [events, autoScroll]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    setAutoScroll(atBottom);
  };

  return (
    <aside style={{
      position: "fixed",
      right: 0, top: 0, bottom: 0,
      width: "min(720px, 90vw)",
      background: "#fff",
      borderLeft: "1px solid #ccc",
      boxShadow: "-4px 0 12px rgba(0,0,0,0.1)",
      display: "flex", flexDirection: "column",
      zIndex: 100,
    }}>
      <header style={{ padding: 16, borderBottom: "1px solid #eee", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>{daemon_id} / <code>{session_id}</code></h2>
          <small style={{ color: "#666" }}>{events.length} event{events.length === 1 ? "" : "s"}{!autoScroll && " · paused auto-scroll"}</small>
        </div>
        <button onClick={onClose} style={{ padding: "4px 12px" }}>Close</button>
      </header>
      <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflowY: "auto", padding: 16, fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
        {events.length === 0 ? (
          <p style={{ color: "#888" }}>Waiting for events…</p>
        ) : (
          events.map((ev, i) => (
            <div key={`${ev.jsonl_offset}-${i}`} style={{ marginBottom: 12, padding: 8, background: "#f7f7f7", borderRadius: 4 }}>
              <div style={{ color: "#666", fontSize: 10, marginBottom: 4 }}>
                {new Date(ev.ts).toLocaleTimeString()} · offset {ev.jsonl_offset}
              </div>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {JSON.stringify(ev.payload, null, 2)}
              </pre>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
