import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

type VpnStatus = "disconnected" | "connecting" | "connected" | "failed";
type ControllerStatus = "disconnected" | "connecting" | "connected" | "failed";

const VPN_LABELS: Record<VpnStatus, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  connected: "Connected",
  failed: "Failed",
};

const CTRL_LABELS: Record<ControllerStatus, string> = {
  disconnected: "Not connected",
  connecting: "Connecting…",
  connected: "Connected",
  failed: "Failed",
};

const BUNDLE_FILES = [
  "ovpn.conf",
  "ovpn.crt",
  "ovpn-fwds-client.crt",
  "ovpn-fwds-client.key",
  "station",
  "connect.bin",
  "connect-local.bin",
];

interface Props {
  onControllerConnected: () => void;
}

export default function SessionTab({ onControllerConnected }: Props) {
  const [bundlePath, setBundlePath] = useState("");
  const [validation, setValidation] = useState<Record<string, boolean> | null>(null);

  const [vpnStatus, setVpnStatus] = useState<VpnStatus>("disconnected");
  const [vpnDetail, setVpnDetail] = useState("");

  const [vpnIp, setVpnIp] = useState("");
  const [lastOctet, setLastOctet] = useState("");
  const [ctrlStatus, setCtrlStatus] = useState<ControllerStatus>("disconnected");
  const [ctrlDetail, setCtrlDetail] = useState("");

  const vpnPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ctrlPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevCtrlPhaseRef = useRef<string>("disconnected");

  // Restore last-used bundle folder on mount
  useEffect(() => {
    const saved = localStorage.getItem("vpn_bundle_path");
    if (saved) loadFolder(saved);
  }, []);

  // VPN polling
  useEffect(() => {
    const active = vpnStatus === "connecting" || vpnStatus === "connected";
    if (active && !vpnPollRef.current) {
      vpnPollRef.current = setInterval(pollVpn, 1000);
    } else if (!active && vpnPollRef.current) {
      clearInterval(vpnPollRef.current);
      vpnPollRef.current = null;
    }
    return () => {
      if (vpnPollRef.current) { clearInterval(vpnPollRef.current); vpnPollRef.current = null; }
    };
  }, [vpnStatus]);

  // Controller status polling — uses get_controller_status (no cursor side-effect)
  useEffect(() => {
    const active = ctrlStatus === "connecting" || ctrlStatus === "connected";
    if (active && !ctrlPollRef.current) {
      ctrlPollRef.current = setInterval(pollController, 800);
    } else if (!active && ctrlPollRef.current) {
      clearInterval(ctrlPollRef.current);
      ctrlPollRef.current = null;
    }
    return () => {
      if (ctrlPollRef.current) { clearInterval(ctrlPollRef.current); ctrlPollRef.current = null; }
    };
  }, [ctrlStatus]);

  async function pollVpn() {
    try {
      const r = await invoke<{ phase: string; detail: string; lines: string[] }>("poll_vpn");
      setVpnStatus(r.phase as VpnStatus);
      setVpnDetail(r.detail);
    } catch { /* ignore */ }
  }

  async function pollController() {
    try {
      const r = await invoke<{ phase: string; detail: string }>("get_controller_status");
      const prev = prevCtrlPhaseRef.current;
      prevCtrlPhaseRef.current = r.phase;
      setCtrlStatus(r.phase as ControllerStatus);
      setCtrlDetail(r.detail);
      // Auto-switch to Console the moment we become connected
      if (prev !== "connected" && r.phase === "connected") {
        onControllerConnected();
      }
    } catch { /* ignore */ }
  }

  async function loadFolder(path: string) {
    setBundlePath(path);
    setValidation(null);
    try {
      const results = await invoke<Record<string, boolean>>("validate_bundle", { folder: path });
      setValidation(results);
    } catch { /* folder may no longer exist */ }
  }

  async function selectFolder() {
    try {
      const path = await invoke<string>("select_vpn_folder");
      localStorage.setItem("vpn_bundle_path", path);
      await loadFolder(path);
    } catch { /* cancelled */ }
  }

  function handleVpnIpChange(val: string) {
    setVpnIp(val);
    const parts = val.trim().split(".");
    if (parts.length === 4) {
      const octet = parts[3];
      setLastOctet(octet && !isNaN(Number(octet)) ? octet : "");
    } else {
      setLastOctet("");
    }
  }

  async function startVpn() {
    setVpnStatus("connecting");
    setVpnDetail("Requesting administrator privileges…");
    try {
      await invoke("start_vpn", { folder: bundlePath });
    } catch (e) {
      setVpnStatus("failed");
      setVpnDetail(String(e));
    }
  }

  async function stopVpn() {
    try { await invoke("stop_vpn"); } catch { /* best effort */ }
    setVpnStatus("disconnected");
    setVpnDetail("");
  }

  async function connectToController() {
    if (!vpnIp) return;
    setCtrlStatus("connecting");
    setCtrlDetail(`Connecting to ${vpnIp}…`);
    prevCtrlPhaseRef.current = "connecting";
    try {
      await invoke("connect_controller", { ip: vpnIp });
    } catch (e) {
      setCtrlStatus("failed");
      setCtrlDetail(String(e));
    }
  }

  async function disconnectController() {
    try { await invoke("disconnect_controller"); } catch { /* best effort */ }
    setCtrlStatus("disconnected");
    setCtrlDetail("");
    prevCtrlPhaseRef.current = "disconnected";
  }

  const allFilesOk = validation !== null && BUNDLE_FILES.every((f) => validation[f] === true);
  const bundleValid = allFilesOk;
  const canConnect = !!vpnIp && vpnStatus === "connected";

  return (
    <div className="tab-content" style={{ alignItems: "center", overflowY: "auto" }}>
      <div style={{ width: "100%", maxWidth: 480, display: "flex", flexDirection: "column", gap: 12 }}>

        {/* VPN Bundle */}
        <div className="card">
          <div className="card-title">VPN Bundle</div>
          {bundlePath ? (
            <div className="folder-selected">
              <span className="file-check-icon ok">✓</span>
              <span className="bundle-path" title={bundlePath} style={{ flex: 1 }}>{bundlePath}</span>
              <button className="btn-link" onClick={selectFolder}>Change</button>
            </div>
          ) : (
            <button className="btn btn-secondary" style={{ width: "100%", marginBottom: 8 }} onClick={selectFolder}>
              Select VPN Bundle Folder
            </button>
          )}
          {validation !== null && (
            <div className="file-checklist">
              {BUNDLE_FILES.map((f) => {
                const ok = validation[f] === true;
                return (
                  <div key={f} className="file-check-row">
                    <span className={`file-check-icon ${ok ? "ok" : "missing"}`}>{ok ? "✓" : "✗"}</span>
                    <span className="file-name" style={{ color: ok ? undefined : "var(--danger)" }}>{f}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* OpenVPN */}
        <div className="card">
          <div className="card-title">OpenVPN</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: vpnDetail ? 6 : 0 }}>
            <span className={`badge badge-${vpnStatus}`}>{VPN_LABELS[vpnStatus]}</span>
            <div className="btn-group" style={{ marginLeft: "auto" }}>
              <button
                className="btn btn-primary"
                disabled={!bundleValid || vpnStatus === "connected" || vpnStatus === "connecting"}
                onClick={startVpn}
              >
                Start VPN
              </button>
              <button
                className="btn btn-danger"
                disabled={vpnStatus === "disconnected" || vpnStatus === "failed"}
                onClick={stopVpn}
              >
                Stop
              </button>
            </div>
          </div>
          {vpnDetail && <div className="hint">{vpnDetail}</div>}
        </div>

        {/* Controller */}
        <div className="card">
          <div className="card-title">Controller</div>
          <div className="field-row" style={{ marginBottom: 10 }}>
            <label>VPN IP</label>
            <input
              type="text"
              placeholder="10.9.0.x"
              value={vpnIp}
              onChange={(e) => handleVpnIpChange(e.target.value)}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: ctrlDetail ? 6 : 0 }}>
            <span className={`badge badge-${ctrlStatus === "disconnected" ? "disconnected" : ctrlStatus}`}>
              {CTRL_LABELS[ctrlStatus]}
            </span>
            <div style={{ marginLeft: "auto" }}>
              {ctrlStatus === "disconnected" || ctrlStatus === "failed" ? (
                <button
                  className="btn btn-primary"
                  disabled={!canConnect}
                  onClick={connectToController}
                >
                  Connect to Controller
                </button>
              ) : (
                <button className="btn btn-secondary" onClick={disconnectController}>
                  Disconnect
                </button>
              )}
            </div>
          </div>
          {ctrlDetail && <div className="hint">{ctrlDetail}</div>}
          {!canConnect && (ctrlStatus === "disconnected" || ctrlStatus === "failed") && !!lastOctet && vpnStatus !== "connected" && (
            <div className="hint" style={{ marginTop: 4 }}>Start VPN first.</div>
          )}
        </div>

      </div>
    </div>
  );
}
