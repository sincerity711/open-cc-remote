import { useEffect, useRef, useState } from "react";
import type { EventFrameForPwa, PwaChatBroadcast } from "@cc-remote/proto";

interface SessionPaneProps {
  daemon_id: string;
  session_id: string;
  events: EventFrameForPwa[];
  chatMessages: PwaChatBroadcast[];
  chatError?: string;
  sessionOnline: boolean;
  onClose: () => void;
  onLoadHistory: (before_offset: number) => void;
  onSendChat: (content: string) => void;
}

export function SessionPane({
  daemon_id, session_id, events, chatMessages, chatError, sessionOnline,
  onClose, onLoadHistory, onSendChat,
}: SessionPaneProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const lastLoadAt = useRef(0);
  const [draft, setDraft] = useState("");
  const chatLogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [events, autoScroll]);

  useEffect(() => {
    if (chatLogRef.current) {
      chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight;
    }
  }, [chatMessages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    setAutoScroll(atBottom);
    // Trigger history load when near top
    const now = Date.now();
    const oldest = events[0];
    if (el.scrollTop < 80 && oldest !== undefined && now - lastLoadAt.current > 500) {
      lastLoadAt.current = now;
      onLoadHistory(oldest.jsonl_offset);
    }
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    const t = draft.trim();
    if (!t) return;
    onSendChat(t);
    setDraft("");
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
          <>
            <p style={{ color: "#aaa", textAlign: "center", fontSize: 11, margin: "0 0 12px" }}>
              ↑ scroll up to load older events
            </p>
            {events.map((ev, i) => (
              <div key={`${ev.jsonl_offset}-${i}`} style={{ marginBottom: 12, padding: 8, background: "#f7f7f7", borderRadius: 4 }}>
                <div style={{ color: "#666", fontSize: 10, marginBottom: 4 }}>
                  {ev.ts > 0 ? new Date(ev.ts).toLocaleTimeString() : "(history)"} · offset {ev.jsonl_offset}
                </div>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {JSON.stringify(ev.payload, null, 2)}
                </pre>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Chat composer + log */}
      <div style={{ borderTop: "1px solid #eee", display: "flex", flexDirection: "column", maxHeight: "40%" }}>
        <div
          ref={chatLogRef}
          data-testid="chat-log"
          style={{ overflowY: "auto", padding: 8, fontSize: 12, background: "#fafbfc" }}
        >
          {chatMessages.length === 0 ? (
            <p style={{ color: "#aaa", margin: 0, padding: 4, fontStyle: "italic" }}>
              No chat messages yet.
            </p>
          ) : (
            chatMessages.map((m) => (
              <div
                key={m.message_id}
                className={`chat-msg from-${m.from}`}
                style={{
                  margin: "4px 0",
                  padding: "4px 8px",
                  background: m.from === "pwa" ? "#e8f0ff" : "#f0fff0",
                  borderRadius: 4,
                  display: "flex",
                  gap: 8,
                  alignItems: "baseline",
                }}
              >
                <strong style={{ color: m.from === "pwa" ? "#06c" : "#080", fontSize: 11 }}>
                  {m.from === "pwa" ? (m.user ?? "you") : "claude"}
                </strong>
                <span style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {m.content}
                </span>
                <small style={{ color: "#888", fontSize: 10 }}>
                  {new Date(m.ts * 1000).toLocaleTimeString()}
                </small>
              </div>
            ))
          )}
          {chatError && (
            <div style={{ margin: "4px 0", padding: "4px 8px", background: "#fee", color: "#a00", borderRadius: 4, fontSize: 11 }}>
              chat error: {chatError}
            </div>
          )}
        </div>
        <form
          onSubmit={handleSend}
          style={{ display: "flex", gap: 6, padding: 8, borderTop: "1px solid #eee", background: "#fff" }}
        >
          <input
            type="text"
            placeholder={sessionOnline ? "Send a message to Claude…" : "session offline"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={!sessionOnline}
            data-testid="chat-input"
            style={{ flex: 1, padding: "6px 10px", fontSize: 13, border: "1px solid #ccc", borderRadius: 3 }}
          />
          <button
            type="submit"
            disabled={!draft.trim() || !sessionOnline}
            style={{ padding: "6px 14px", background: "#08c", color: "#fff", border: "none", borderRadius: 3, cursor: "pointer" }}
          >
            Send
          </button>
        </form>
      </div>
    </aside>
  );
}
