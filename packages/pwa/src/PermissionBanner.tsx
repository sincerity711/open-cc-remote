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
      position: "sticky", top: 0, zIndex: 50,
      background: "#fff8e1",
      borderBottom: "2px solid #ffb300",
      padding: 12,
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
