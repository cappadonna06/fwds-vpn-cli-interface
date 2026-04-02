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

interface PreflightResult {
  ping_ok: boolean;
  port_ok: boolean;
  detail: string;
}

type ConnectionMode = "vpn" | "serial";

export default function SessionTab() {
  // ── Mode ─────────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<ConnectionMode>("vpn");

  // ── VPN state ─────────────────────────────────────────────────────────────
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

  // ── Serial state ──────────────────────────────────────────────────────────
  const [serialDevice, setSerialDevice] = useState("");
  const [serialDevices, setSerialDevices] = useState<string[]>([]);
  const [serialActive, setSerialActive] = useState(false);
  const [serialDetail, setSerialDetail] = useState("");
  const [scanningDevices, setScanningDevices] = useState(false);

  const vpnPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ctrlPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevCtrlPhaseRef = useRef<string>("disconnected");
  const prevVpnPhaseRef = useRef<string>("disconnected");

  // Restore persisted state on mount
  useEffect(() => {
    const savedPath = localStorage.getItem("vpn_bundle_path");
    if (savedPath) loadFolder(savedPath);
    const octet = localStorage.getItem("vpn_last_octet");
    if (octet) setSavedOctet(octet);
    const savedDevice = localStorage.getItem("serial_device");
    if (savedDevice) setSerialDevice(savedDevice);
    // Sync serial active status from backend
    invoke<{ serial_device: string | null }>("get_app_state")
      .then((s) => { if (s.serial_device) { setSerialActive(true); setSerialDevice(s.serial_device); } })
      .catch(() => {});
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

  // Controller polling
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
      if (prev !== "connected" && r.phase === "connected") {
        setVpnIp((ip) => {
          if (ip) { setPreflight(null); runPreflight(ip); }
          return ip;
        });
      }
    } catch { /* ignore */ }
  }

  async function pollController() {
    try {
      const r = await invoke<{ phase: string; detail: string }>("get_controller_status");
      const prev = prevCtrlPhaseRef.current;
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
    if (vpnStatus === "connected") runPreflight(vpnIp);
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

  // ── Serial handlers ───────────────────────────────────────────────────────

  async function scanSerialDevices() {
    setScanningDevices(true);
    try {
      const devices = await invoke<string[]>("list_serial_devices");
      setSerialDevices(devices);
      if (devices.length === 1) setSerialDevice(devices[0]);
    } catch { /* ignore */ }
    finally { setScanningDevices(false); }
  }

  async function launchSerialTerminal() {
    if (!serialDevice.trim()) return;
    setSerialDetail("");
    try {
      await invoke("open_serial_terminal", { device: serialDevice.trim() });
      localStorage.setItem("serial_device", serialDevice.trim());
      setSerialActive(true);
      setSerialDetail(`minicom session active — log writing to Desktop`);
    } catch (e) {
      setSerialDetail(String(e));
    }
  }

  async function disconnectSerial() {
    try { await invoke("disconnect_serial"); } catch { /* best effort */ }
    setSerialActive(false);
    setSerialDetail("");
  }

  // ── Derived flags ─────────────────────────────────────────────────────────

  const allFilesOk = validation !== null && BUNDLE_FILES.every((f) => validation[f] === true);
  const octetNum = parseInt(lastOctet, 10);
  const octetValid = lastOctet !== "" && !isNaN(octetNum) && octetNum >= 1 && octetNum <= 254;
  const canConnect = octetValid && vpnStatus === "connected";
  const showPreflight = vpnStatus === "connected" && octetValid;
  const serialBusy = ctrlStatus === "connected"; // SSH active → disable serial
  const vpnBusy = serialActive; // serial active → disable VPN/SSH

  function preflightDotClass(ok: boolean | undefined): string {
    if (preflight === null) return "idle";
    return ok ? "ok" : "fail";
  }

  return (
    <div className="tab-content" style={{ alignItems: "center", overflowY: "auto" }}>
      <div style={{ width: "100%", maxWidth: 480, display: "flex", flexDirection: "column", gap: 12 }}>

        {/* Connection mode toggle */}
        <div className="card" style={{ padding: "10px 16px" }}>
          <div style={{ display: "flex", gap: 4 }}>
            <button
              className={`tab-btn${mode === "vpn" ? " active" : ""}`}
              style={{ flex: 1 }}
              onClick={() => setMode("vpn")}
            >
              VPN
            </button>
            <button
              className={`tab-btn${mode === "serial" ? " active" : ""}`}
              style={{ flex: 1 }}
              onClick={() => setMode("serial")}
            >
              Local (Serial)
            </button>
          </div>
        </div>

        {/* ── VPN mode ─────────────────────────────────────────────────────── */}
        {mode === "vpn" && (
          <>
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
            <div className={`card${vpnBusy ? " card-disabled" : ""}`}>
              <div className="card-title">OpenVPN</div>
              {vpnBusy && <div className="hint" style={{ marginBottom: 8 }}>Disconnect serial session first.</div>}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: vpnDetail ? 6 : 0 }}>
                <span className={`badge badge-${vpnStatus}`}>{VPN_LABELS[vpnStatus]}</span>
                <div className="btn-group" style={{ marginLeft: "auto" }}>
                  <button
                    className="btn btn-primary"
                    disabled={vpnBusy || !allFilesOk || vpnStatus === "connected" || vpnStatus === "connecting"}
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
            <div className={`card${vpnBusy ? " card-disabled" : ""}`}>
              <div className="card-title">Controller</div>
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
                    disabled={vpnBusy}
                  />
                </div>
              </div>
              {savedOctet && !lastOctet && !vpnBusy && (
                <div style={{ marginBottom: 10 }}>
                  <button className="btn-link" onClick={() => handleOctetChange(savedOctet)}>
                    Use last: .{savedOctet}
                  </button>
                </div>
              )}

              {showPreflight && !vpnBusy && (
                <div className="preflight-row">
                  <div className="preflight-checks">
                    <span className={`preflight-dot ${preflightDotClass(preflight?.ping_ok)}`}>Ping</span>
                    <span className={`preflight-dot ${preflightDotClass(preflight?.port_ok)}`}>Port 22</span>
                    {preflight && <span className="preflight-detail">{preflight.detail}</span>}
                  </div>
                  <button className="btn-link" onClick={() => runPreflight(vpnIp)} disabled={preflightRunning}>
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
                    <button className="btn btn-primary" disabled={vpnBusy || !canConnect} onClick={connectToController}>
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
              {!canConnect && (ctrlStatus === "disconnected" || ctrlStatus === "failed") && !!lastOctet && vpnStatus !== "connected" && !vpnBusy && (
                <div className="hint" style={{ marginTop: 4 }}>Start VPN first.</div>
              )}

              {ctrlStatus === "connected" && (
                <div style={{ marginTop: 10 }}>
                  <button className="btn btn-primary" style={{ width: "100%" }} onClick={launchTerminal}>
                    Launch Controller Terminal
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {/* ── Serial mode ───────────────────────────────────────────────────── */}
        {mode === "serial" && (
          <div className="card">
            <div className="card-title">Local Serial Connection</div>

            {serialBusy && (
              <div className="hint" style={{ marginBottom: 8 }}>
                Disconnect the SSH session first.
              </div>
            )}

            <div className="hint" style={{ marginBottom: 12 }}>
              Connect the DB9-to-USB cable: DB9 end → controller serial port, USB end → this Mac.
              Leave the controller powered off, then connect.
            </div>

            {/* Device picker */}
            <div className="field-row" style={{ alignItems: "flex-start", flexDirection: "column", gap: 6, marginBottom: 10 }}>
              <div style={{ display: "flex", gap: 6, width: "100%", alignItems: "center" }}>
                <label style={{ width: "auto", flexShrink: 0 }}>Device</label>
                <input
                  style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 12 }}
                  type="text"
                  placeholder="/dev/cu.usbserial-XXXX"
                  value={serialDevice}
                  onChange={(e) => setSerialDevice(e.target.value)}
                  disabled={serialBusy || serialActive}
                />
                <button
                  className="btn btn-secondary"
                  style={{ flexShrink: 0 }}
                  disabled={serialBusy || scanningDevices}
                  onClick={scanSerialDevices}
                >
                  {scanningDevices ? "Scanning…" : "Scan"}
                </button>
              </div>
              {serialDevices.length > 0 && !serialActive && (
                <div className="serial-device-list">
                  {serialDevices.map((d) => (
                    <button
                      key={d}
                      className={`serial-device-row${d === serialDevice ? " selected" : ""}`}
                      onClick={() => setSerialDevice(d)}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              )}
              {serialDevices.length === 0 && !scanningDevices && (
                <div className="hint" style={{ fontSize: 11 }}>
                  Run <code>ls /dev/cu.*</code> in Terminal to find your device, or click Scan.
                </div>
              )}
            </div>

            {/* minicom settings note */}
            <div className="hint" style={{ marginBottom: 12 }}>
              Baud rate: <strong>115200</strong>. The terminal window will open with minicom and session logging enabled.
            </div>

            {/* Action buttons */}
            <div style={{ display: "flex", gap: 8 }}>
              {!serialActive ? (
                <button
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                  disabled={serialBusy || !serialDevice.trim()}
                  onClick={launchSerialTerminal}
                >
                  Launch Serial Terminal
                </button>
              ) : (
                <button className="btn btn-secondary" style={{ flex: 1 }} onClick={disconnectSerial}>
                  Disconnect Serial
                </button>
              )}
            </div>

            {serialDetail && (
              <div className="hint" style={{ marginTop: 8, color: serialActive ? "var(--success)" : "var(--danger)" }}>
                {serialDetail}
              </div>
            )}

            {serialActive && (
              <div style={{ marginTop: 12 }}>
                <div className="bundle-ready">✓ Serial session active — Diagnostics tab will auto-populate</div>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
