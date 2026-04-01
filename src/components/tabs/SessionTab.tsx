import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

type VpnStatus = "disconnected" | "connecting" | "connected" | "failed";
type ControllerStatus = "disconnected" | "connecting" | "connected" | "failed";
type ConnectionMode = "vpn" | "local";

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

interface PreflightResult {
  ping_ok: boolean;
  port_ok: boolean;
  detail: string;
}

export default function SessionTab() {
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>("vpn");
  const [bundlePath, setBundlePath] = useState("");
  const [validation, setValidation] = useState<Record<string, boolean> | null>(null);

  const [vpnStatus, setVpnStatus] = useState<VpnStatus>("disconnected");
  const [vpnDetail, setVpnDetail] = useState("");

  const [vpnIp, setVpnIp] = useState("");
  const [lastOctet, setLastOctet] = useState("");
  const [savedOctet, setSavedOctet] = useState("");
  const [ctrlStatus, setCtrlStatus] = useState<ControllerStatus>("disconnected");
  const [ctrlDetail, setCtrlDetail] = useState("");

  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [preflightRunning, setPreflightRunning] = useState(false);
  const [serialDevice, setSerialDevice] = useState("");
  const [serialDevices, setSerialDevices] = useState<string[]>([]);
  const [serialDetail, setSerialDetail] = useState("");

  const vpnPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ctrlPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevCtrlPhaseRef = useRef<string>("disconnected");
  const prevVpnPhaseRef = useRef<string>("disconnected");

  // Restore last-used bundle folder and VPN octet on mount
  useEffect(() => {
    const savedPath = localStorage.getItem("vpn_bundle_path");
    if (savedPath) loadFolder(savedPath);

    const octet = localStorage.getItem("vpn_last_octet");
    if (octet) setSavedOctet(octet);

    const savedSerial = localStorage.getItem("local_serial_device");
    if (savedSerial) setSerialDevice(savedSerial);
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
      const prev = prevVpnPhaseRef.current;
      prevVpnPhaseRef.current = r.phase;
      setVpnStatus(r.phase as VpnStatus);
      setVpnDetail(r.detail);
      // Auto-run preflight once when VPN first becomes connected and IP is already set
      if (prev !== "connected" && r.phase === "connected") {
        setVpnIp((ip) => {
          if (ip) {
            setPreflight(null);
            runPreflight(ip);
          }
          return ip;
        });
      }
    } catch { /* ignore */ }
  }

  async function pollController() {
    try {
      const r = await invoke<{ phase: string; detail: string }>("get_controller_status");
      prevCtrlPhaseRef.current = r.phase;
      setCtrlStatus(r.phase as ControllerStatus);
      setCtrlDetail(r.detail);
    } catch { /* ignore */ }
  }

  async function runPreflight(ip: string) {
    if (!ip || preflightRunning) return;
    setPreflightRunning(true);
    setPreflight(null);
    try {
      const r = await invoke<PreflightResult>("run_preflight", { ip });
      setPreflight(r);
    } catch { /* ignore */ }
    finally { setPreflightRunning(false); }
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

  function handleOctetChange(raw: string) {
    const cleaned = raw.replace(/\D/g, "").slice(0, 3);
    setLastOctet(cleaned);
    setVpnIp(cleaned ? `10.9.0.${cleaned}` : "");
    setPreflight(null);
  }

  function handleOctetBlur() {
    const n = parseInt(lastOctet, 10);
    if (!lastOctet || isNaN(n) || n < 1 || n > 254) return;
    if (vpnStatus === "connected") {
      runPreflight(vpnIp);
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
    setPreflight(null);
  }

  async function connectToController() {
    if (!vpnIp) return;
    localStorage.setItem("vpn_last_octet", lastOctet);
    setSavedOctet(lastOctet);
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

  async function launchTerminal() {
    try {
      await invoke("open_controller_terminal");
    } catch (e) {
      setCtrlDetail(String(e));
    }
  }

  async function detectSerialDevices() {
    try {
      const devices = await invoke<string[]>("list_serial_devices");
      setSerialDevices(devices);
      setSerialDetail(devices.length ? `Found ${devices.length} device(s)` : "No serial devices found.");
    } catch (e) {
      setSerialDetail(String(e));
    }
  }

  async function launchLocalSerialTerminal() {
    if (!serialDevice) return;
    try {
      localStorage.setItem("local_serial_device", serialDevice);
      await invoke("open_local_serial_terminal", { device: serialDevice });
      setSerialDetail(`Launched minicom on ${serialDevice}`);
    } catch (e) {
      setSerialDetail(String(e));
    }
  }

  const allFilesOk = validation !== null && BUNDLE_FILES.every((f) => validation[f] === true);
  const bundleValid = allFilesOk;
  const octetNum = parseInt(lastOctet, 10);
  const octetValid = lastOctet !== "" && !isNaN(octetNum) && octetNum >= 1 && octetNum <= 254;
  const canConnect = octetValid && vpnStatus === "connected";
  const showPreflight = vpnStatus === "connected" && octetValid;

  function preflightDotClass(ok: boolean | undefined): string {
    if (preflight === null) return "idle";
    return ok ? "ok" : "fail";
  }

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
            allFilesOk ? (
              <div className="bundle-ready">✓ Bundle ready</div>
            ) : (
              <div className="file-checklist">
                {BUNDLE_FILES.filter((f) => validation[f] !== true).map((f) => (
                  <div key={f} className="file-check-row">
                    <span className="file-check-icon missing">✗</span>
                    <span className="file-name" style={{ color: "var(--danger)" }}>{f}</span>
                  </div>
                ))}
              </div>
            )
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
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <button className={`btn ${connectionMode === "vpn" ? "btn-primary" : "btn-secondary"}`} onClick={() => setConnectionMode("vpn")}>
              VPN / SSH
            </button>
            <button className={`btn ${connectionMode === "local" ? "btn-primary" : "btn-secondary"}`} onClick={() => setConnectionMode("local")}>
              Local Serial
            </button>
          </div>
          {connectionMode === "vpn" && (
            <>
          <div className="field-row" style={{ marginBottom: savedOctet && !lastOctet ? 4 : 10 }}>
            <label>VPN IP</label>
            <div className="ip-input-group">
              <span className="ip-prefix">10.9.0.</span>
              <input
                className="ip-octet-input"
                type="text"
                inputMode="numeric"
                placeholder="x"
                maxLength={3}
                value={lastOctet}
                onChange={(e) => handleOctetChange(e.target.value)}
                onBlur={handleOctetBlur}
              />
            </div>
          </div>
          {savedOctet && !lastOctet && (
            <div style={{ marginBottom: 10 }}>
              <button className="btn-link" onClick={() => handleOctetChange(savedOctet)}>
                Use last: .{savedOctet}
              </button>
            </div>
          )}

          {/* Pre-flight diagnostics */}
          {showPreflight && (
            <div className="preflight-row">
              <div className="preflight-checks">
                <span className={`preflight-dot ${preflightDotClass(preflight?.ping_ok)}`}>
                  Ping
                </span>
                <span className={`preflight-dot ${preflightDotClass(preflight?.port_ok)}`}>
                  Port 22
                </span>
                {preflight && (
                  <span className="preflight-detail">{preflight.detail}</span>
                )}
              </div>
              <button
                className="btn-link"
                onClick={() => runPreflight(vpnIp)}
                disabled={preflightRunning}
              >
                {preflightRunning ? "Checking…" : preflight ? "Re-check" : "Check"}
              </button>
            </div>
          )}

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

          {/* Launch Controller Terminal */}
          {ctrlStatus === "connected" && (
            <div style={{ marginTop: 10 }}>
              <button
                className="btn btn-primary"
                style={{ width: "100%" }}
                onClick={launchTerminal}
              >
                Launch Controller Terminal
              </button>
            </div>
          )}
            </>
          )}
          {connectionMode === "local" && (
            <>
              <div className="field-row">
                <label>Serial</label>
                <input
                  value={serialDevice}
                  onChange={(e) => setSerialDevice(e.target.value)}
                  placeholder="/dev/cu.usbserial-XXXX"
                />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-secondary" onClick={detectSerialDevices}>
                  Detect Devices
                </button>
                <button className="btn btn-primary" disabled={!serialDevice} onClick={launchLocalSerialTerminal}>
                  Launch Serial Terminal
                </button>
              </div>
              {serialDevices.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-secondary)" }}>
                  {serialDevices.slice(0, 5).map((d) => (
                    <div key={d}>{d}</div>
                  ))}
                </div>
              )}
              {serialDetail && <div className="hint" style={{ marginTop: 8 }}>{serialDetail}</div>}
            </>
          )}
        </div>

      </div>
    </div>
  );
}
