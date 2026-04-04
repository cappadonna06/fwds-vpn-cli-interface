import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type VpnStatus = "disconnected" | "connecting" | "connected" | "failed";
type ControllerStatus = "disconnected" | "connecting" | "connected" | "failed";
type LocalStatusTone = "neutral" | "ok" | "fail";
type ConnectionMode = "vpn" | "local";

const VPN_LABELS: Record<VpnStatus, string> = {
  disconnected: "Not connected",
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

function statusTone(status: VpnStatus | ControllerStatus): "neutral" | "ok" | "warn" | "fail" {
  if (status === "connected") return "ok";
  if (status === "connecting") return "warn";
  if (status === "failed") return "fail";
  return "neutral";
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

  useEffect(() => {
    const savedPath = localStorage.getItem("vpn_bundle_path");
    if (savedPath) loadFolder(savedPath);

    const octet = localStorage.getItem("vpn_last_octet");
    if (octet) setSavedOctet(octet);

    const savedSerial = localStorage.getItem("local_serial_device");
    if (savedSerial) setSerialDevice(savedSerial);
  }, []);

  useEffect(() => {
    const active = vpnStatus === "connecting" || vpnStatus === "connected";
    if (active && !vpnPollRef.current) {
      vpnPollRef.current = setInterval(pollVpn, 1000);
    } else if (!active && vpnPollRef.current) {
      clearInterval(vpnPollRef.current);
      vpnPollRef.current = null;
    }
    return () => {
      if (vpnPollRef.current) {
        clearInterval(vpnPollRef.current);
        vpnPollRef.current = null;
      }
    };
  }, [vpnStatus]);

  useEffect(() => {
    const active = ctrlStatus === "connecting" || ctrlStatus === "connected";
    if (active && !ctrlPollRef.current) {
      ctrlPollRef.current = setInterval(pollController, 800);
    } else if (!active && ctrlPollRef.current) {
      clearInterval(ctrlPollRef.current);
      ctrlPollRef.current = null;
    }
    return () => {
      if (ctrlPollRef.current) {
        clearInterval(ctrlPollRef.current);
        ctrlPollRef.current = null;
      }
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
          if (ip) {
            setPreflight(null);
            runPreflight(ip);
          }
          return ip;
        });
      }
    } catch {
      // ignore
    }
  }

  async function pollController() {
    try {
      const r = await invoke<{ phase: string; detail: string }>("get_controller_status");
      prevCtrlPhaseRef.current = r.phase;
      setCtrlStatus(r.phase as ControllerStatus);
      setCtrlDetail(r.detail);
    } catch {
      // ignore
    }
  }

  async function runPreflight(ip: string) {
    if (!ip || preflightRunning) return;
    setPreflightRunning(true);
    setPreflight(null);
    try {
      const r = await invoke<PreflightResult>("run_preflight", { ip });
      setPreflight(r);
    } catch {
      // ignore
    } finally {
      setPreflightRunning(false);
    }
  }

  async function loadFolder(path: string) {
    setBundlePath(path);
    setValidation(null);
    try {
      const results = await invoke<Record<string, boolean>>("validate_bundle", { folder: path });
      setValidation(results);
    } catch {
      // folder may no longer exist
    }
  }

  async function selectFolder() {
    try {
      const path = await invoke<string>("select_vpn_folder");
      localStorage.setItem("vpn_bundle_path", path);
      await loadFolder(path);
    } catch {
      // cancelled
    }
  }

  function handleOctetChange(raw: string) {
    const cleaned = raw.replace(/\D/g, "").slice(0, 3);
    setLastOctet(cleaned);
    setVpnIp(cleaned ? `10.9.0.${cleaned}` : "");
    setPreflight(null);
  }

  function handleOctetBlur() {
    const n = parseInt(lastOctet, 10);
    if (!lastOctet || Number.isNaN(n) || n < 1 || n > 254) return;
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
    try {
      await invoke("stop_vpn");
    } catch {
      // best effort
    }
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

  async function connectAndLaunch() {
    if (!canConnect) return;
    await connectToController();
    try {
      await invoke("open_controller_terminal");
      await invoke("start_log_watcher").catch(() => {});
    } catch (e) {
      setCtrlDetail(String(e));
    }
  }

  async function disconnectController() {
    try {
      await invoke("disconnect_controller");
    } catch {
      // best effort
    }
    setCtrlStatus("disconnected");
    setCtrlDetail("");
    prevCtrlPhaseRef.current = "disconnected";
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
      await invoke("start_log_watcher").catch(() => {});
      setSerialDetail("Connected");
    } catch (e) {
      setSerialDetail(String(e));
    }
  }

  async function disconnectLocalSession() {
    try {
      await invoke("disconnect_local_controller");
      setSerialDetail("Local session disconnected.");
    } catch (e) {
      setSerialDetail(String(e));
    }
  }

  const allFilesOk = validation !== null && BUNDLE_FILES.every((f) => validation[f] === true);
  const missingFiles = useMemo(
    () => (validation === null ? [] : BUNDLE_FILES.filter((f) => validation[f] !== true)),
    [validation],
  );
  const octetNum = parseInt(lastOctet, 10);
  const octetValid = lastOctet !== "" && !Number.isNaN(octetNum) && octetNum >= 1 && octetNum <= 254;
  const canConnect = octetValid && vpnStatus === "connected";
  const showPreflight = vpnStatus === "connected" && octetValid;

  const localState: { label: string; tone: LocalStatusTone } = useMemo(() => {
    const normalized = serialDetail.toLowerCase();
    if (normalized.includes("connected")) return { label: "Connected", tone: "ok" };
    if (normalized.includes("error") || normalized.includes("failed")) return { label: "Failed", tone: "fail" };
    if (normalized.includes("disconnected")) return { label: "Idle", tone: "neutral" };
    return { label: "Idle", tone: "neutral" };
  }, [serialDetail]);

  function preflightDotClass(ok: boolean | undefined): string {
    if (preflight === null) return "idle";
    return ok ? "ok" : "fail";
  }

  return (
    <div className="tab-content session-tab">
      <div className="session-shell">
        <div className="session-heading">
          <h1>Connect</h1>
          <p>Choose one connection mode at a time.</p>
        </div>

        <div className="connect-mode-toggle" role="tablist" aria-label="Connection mode">
          <button
            className={`mode-toggle-btn ${connectionMode === "vpn" ? "active" : ""}`}
            onClick={() => setConnectionMode("vpn")}
            role="tab"
            aria-selected={connectionMode === "vpn"}
          >
            VPN
          </button>
          <button
            className={`mode-toggle-btn ${connectionMode === "local" ? "active" : ""}`}
            onClick={() => setConnectionMode("local")}
            role="tab"
            aria-selected={connectionMode === "local"}
          >
            Local
          </button>
        </div>

        {connectionMode === "vpn" ? (
          <section className="connect-card connect-card-single">
            <div className="connect-card-head">
              <div>
                <h2>Connect via VPN</h2>
                <p>Main flow: Open VPN → Enter VPN ID → Connect + Launch</p>
              </div>
              <div className="status-chip-row">
                <span className={`status-chip ${allFilesOk ? "ok" : "neutral"}`}>{allFilesOk ? "Bundle ok" : "Bundle needed"}</span>
                <span className={`status-chip ${statusTone(vpnStatus)}`}>{vpnStatus === "connected" ? "VPN connected" : VPN_LABELS[vpnStatus]}</span>
                {showPreflight && preflight?.port_ok && <span className="status-chip ok">SSH reachable</span>}
              </div>
            </div>

            <div className="flow-group flow-group-soft">
              <div className="flow-row">
                <div className="row-context">Bundle</div>
                {bundlePath ? (
                  <span className="bundle-path" title={bundlePath}>{bundlePath}</span>
                ) : (
                  <span className="muted">No bundle selected</span>
                )}
                <button className="btn-link" onClick={selectFolder}>{bundlePath ? "Change bundle" : "Select bundle"}</button>
              </div>
              {validation !== null && (
                !allFilesOk && (
                  <div className="hint session-hint error">Missing: {missingFiles.join(", ")}</div>
                )
              )}
              <div className="flow-row">
                <div className="row-context">1) VPN</div>
                <span className={`status-chip ${statusTone(vpnStatus)}`}>{VPN_LABELS[vpnStatus]}</span>
                <div className="btn-group">
                  <button
                    className="btn btn-primary"
                    disabled={!allFilesOk || vpnStatus === "connected" || vpnStatus === "connecting"}
                    onClick={startVpn}
                  >
                    Open VPN
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={vpnStatus === "disconnected" || vpnStatus === "failed"}
                    onClick={stopVpn}
                  >
                    Stop
                  </button>
                </div>
              </div>
              {vpnDetail && <div className="hint session-hint">{vpnDetail}</div>}
            </div>

            <div className="flow-group">
              <div className="flow-row ip-row">
                <div className="row-context">2) VPN ID</div>
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
                {savedOctet && !lastOctet && (
                  <button className="btn-link" onClick={() => handleOctetChange(savedOctet)}>
                    Use last .{savedOctet}
                  </button>
                )}
              </div>

              {showPreflight && (
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
            </div>

            <div className="card-actions">
              {ctrlStatus === "disconnected" || ctrlStatus === "failed" ? (
                <button className="btn btn-primary" disabled={!canConnect} onClick={connectAndLaunch}>
                  3) Connect + Launch
                </button>
              ) : (
                <button className="btn btn-secondary" onClick={disconnectController}>
                  Disconnect
                </button>
              )}
            </div>

            <div className="hint session-hint">Controller: {CTRL_LABELS[ctrlStatus]}{ctrlDetail ? ` — ${ctrlDetail}` : ""}</div>
            {!canConnect && (ctrlStatus === "disconnected" || ctrlStatus === "failed") && Boolean(lastOctet) && vpnStatus !== "connected" && (
              <div className="hint session-hint">Start VPN first.</div>
            )}
          </section>
        ) : (
          <section className="connect-card connect-card-single">
            <div className="connect-card-head">
              <div>
                <h2>Connect locally</h2>
                <p>USB / serial access</p>
              </div>
              <div className="status-chip-row">
                <span className={`status-chip ${localState.tone}`}>{localState.label}</span>
              </div>
            </div>

            <div className="flow-group flow-group-soft">
              <div className="flow-row">
                <div className="row-context">Device</div>
                <div className="serial-picker-row">
                  <input
                    value={serialDevice}
                    onChange={(e) => setSerialDevice(e.target.value)}
                    placeholder="Select or enter a serial path"
                    list="serial-device-options"
                  />
                  <datalist id="serial-device-options">
                    {serialDevices.map((device) => (
                      <option key={device} value={device} />
                    ))}
                  </datalist>
                  <button className="btn btn-secondary" onClick={detectSerialDevices}>Refresh</button>
                </div>
              </div>
              {serialDevices.length > 0 && (
                <div className="serial-quick-picks">
                  {serialDevices.slice(0, 6).map((device) => (
                    <button
                      key={device}
                      className={`chip-button ${serialDevice === device ? "active" : ""}`}
                      onClick={() => setSerialDevice(device)}
                      type="button"
                    >
                      {device}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="card-actions">
              <button className="btn btn-primary" disabled={!serialDevice} onClick={launchLocalSerialTerminal}>
                Connect
              </button>
              {localState.tone === "ok" && (
                <button className="btn btn-secondary" onClick={disconnectLocalSession}>
                  Disconnect
                </button>
              )}
            </div>

            {serialDetail && <div className="hint session-hint">{serialDetail}</div>}
          </section>
        )}
      </div>
    </div>
  );
}
