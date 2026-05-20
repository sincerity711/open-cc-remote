import type { PwaPermissionRequest } from "@cc-remote/proto";

interface Props {
  pending: Record<string, PwaPermissionRequest>;
  onReply: (req: PwaPermissionRequest, decision: "allow" | "deny") => void;
}

export function PermissionBanner({ pending, onReply }: Props) {
  const list = Object.values(pending);
  if (list.length === 0) return null;
  return (
    <div style={{
      // Fixed across the entire viewport (left:0 right:0) at z-index above
      // SessionPane (which is position:fixed; right:0; width:min(720px,90vw))
      // — without this, the SessionPane overlays the banner's Allow/Deny
      // buttons and they become unclickable when a session is selected.
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 1000,
      background: "#fff8e1",
      borderBottom: "2px solid #ffb300",
      padding: 12,
      boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
    }}>
      {list.map((req) => (
        <div key={req.request_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0" }}>
          <div>
            <strong>{req.daemon_id}</strong>{" / "}
            <code>{req.session_id}</code>{" wants to run "}
            <code style={{ background: "#fff", padding: "2px 6px", borderRadius: 3 }}>{req.tool}</code>{" "}
            <small style={{ color: "#666" }}>{req.args_summary}</small>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => onReply(req, "allow")}
              style={{ padding: "6px 14px", background: "#0a0", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}
            >
              ✓ Allow
            </button>
            <button
              onClick={() => onReply(req, "deny")}
              style={{ padding: "6px 14px", background: "#a00", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}
            >
              ✗ Deny
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
