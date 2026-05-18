import { useEffect, useState } from "react";
import {
  listDevices, renameDevice, revokeDevice,
  getPushPreferences, setPushPreferences,
  type DeviceItem, type PushPreferences,
} from "./api.ts";

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
  const [prefs, setPrefs] = useState<PushPreferences | null>(null);

  const refresh = () => {
    listDevices(hubUrl, bearer).then(setDevices).catch((e) => setError(e.message));
  };

  useEffect(refresh, [hubUrl, bearer]);

  useEffect(() => {
    getPushPreferences(hubUrl, bearer).then(setPrefs).catch((e) => setError(e.message));
  }, [hubUrl, bearer]);

  const togglePermissionPush = async () => {
    if (!prefs) return;
    const next: PushPreferences = { ...prefs, permission: !(prefs.permission !== false) };
    setPrefs(next);
    try {
      await setPushPreferences(hubUrl, bearer, next);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggleOfflinePush = async () => {
    if (!prefs) return;
    const next: PushPreferences = { ...prefs, offline: !(prefs.offline === true) };
    setPrefs(next);
    try {
      await setPushPreferences(hubUrl, bearer, next);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggleCompletedPush = async () => {
    if (!prefs) return;
    const next: PushPreferences = { ...prefs, completed: !(prefs.completed === true) };
    setPrefs(next);
    try {
      await setPushPreferences(hubUrl, bearer, next);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggleIdlePush = async () => {
    if (!prefs) return;
    const next: PushPreferences = { ...prefs, idle: !(prefs.idle === true) };
    setPrefs(next);
    try {
      await setPushPreferences(hubUrl, bearer, next);
    } catch (e) {
      setError((e as Error).message);
    }
  };

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
        <section style={{ marginBottom: 24 }}>
          <h3 style={{ margin: "0 0 8px", fontSize: 14, color: "#666", textTransform: "uppercase", letterSpacing: 0.5 }}>
            Notifications
          </h3>
          {prefs === null ? (
            <p style={{ color: "#888" }}>Loading…</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, padding: 12, background: "#fafafa", border: "1px solid #eee", borderRadius: 4, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={prefs.permission !== false}
                  onChange={togglePermissionPush}
                />
                <span>Notify me about permission requests</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, padding: 12, background: "#fafafa", border: "1px solid #eee", borderRadius: 4, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={prefs.offline === true}
                  onChange={toggleOfflinePush}
                />
                <span>Notify me when a daemon goes offline (≥ 30s)</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, padding: 12, background: "#fafafa", border: "1px solid #eee", borderRadius: 4, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={prefs.completed === true}
                  onChange={toggleCompletedPush}
                />
                <span>Notify me when Claude finishes a turn</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, padding: 12, background: "#fafafa", border: "1px solid #eee", borderRadius: 4, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={prefs.idle === true}
                  onChange={toggleIdlePush}
                />
                <span>Notify me when Claude is idle (waiting for input)</span>
              </label>
            </div>
          )}
        </section>

        <h3 style={{ margin: "0 0 8px", fontSize: 14, color: "#666", textTransform: "uppercase", letterSpacing: 0.5 }}>
          Devices
        </h3>
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
