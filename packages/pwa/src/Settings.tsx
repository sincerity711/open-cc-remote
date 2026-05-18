import { useEffect, useState } from "react";
import { listDevices, renameDevice, revokeDevice, type DeviceItem } from "./api.ts";

interface Props {
  hubUrl: string;
  bearer: string;
  onClose: () => void;
}

export function Settings({ hubUrl, bearer, onClose }: Props) {
  const [devices, setDevices] = useState<DeviceItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const refresh = () => {
    listDevices(hubUrl, bearer).then(setDevices).catch((e) => setError(e.message));
  };

  useEffect(refresh, [hubUrl, bearer]);

  const startEdit = (d: DeviceItem) => {
    setEditing(d.device_id);
    setEditValue(d.display_name ?? "");
  };
  const commitEdit = async (device_id: string) => {
    try {
      await renameDevice(hubUrl, bearer, device_id, editValue);
      setEditing(null);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const doRevoke = async (device_id: string) => {
    if (!confirm(`Revoke this device? It will be signed out everywhere.`)) return;
    try {
      await revokeDevice(hubUrl, bearer, device_id);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <aside style={{
      position: "fixed", left: 0, top: 0, bottom: 0,
      width: "min(560px, 90vw)", background: "#fff",
      borderRight: "1px solid #ccc", boxShadow: "4px 0 12px rgba(0,0,0,0.1)",
      display: "flex", flexDirection: "column", zIndex: 200,
    }}>
      <header style={{ padding: 16, borderBottom: "1px solid #eee", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Settings · My devices</h2>
        <button onClick={onClose}>Close</button>
      </header>
      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {error && <p style={{ color: "#a00" }}>Error: {error}</p>}
        {devices === null ? (
          <p>Loading…</p>
        ) : devices.length === 0 ? (
          <p>No devices.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0 }}>
            {devices.map((d) => (
              <li key={d.device_id} style={{ padding: 12, marginBottom: 8, background: "#fafafa", border: "1px solid #eee", borderRadius: 4 }}>
                {editing === d.device_id ? (
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      style={{ flex: 1, padding: 4 }}
                      autoFocus
                    />
                    <button onClick={() => commitEdit(d.device_id)}>Save</button>
                    <button onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                ) : (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <strong>{d.display_name ?? "(unnamed)"}</strong>
                      <div style={{ fontSize: 11, color: "#888" }}>
                        <code>{d.device_id}</code><br />
                        paired {new Date(d.paired_at).toLocaleString()}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => startEdit(d)} style={{ fontSize: 12, padding: "4px 8px" }}>Rename</button>
                      <button onClick={() => doRevoke(d.device_id)} style={{ fontSize: 12, padding: "4px 8px", background: "#a00", color: "#fff", border: "none", borderRadius: 4 }}>Revoke</button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
