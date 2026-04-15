import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

type VpnStatus = "disconnected" | "starting" | "connected" | "stopping" | "failed" | "unknown";
type ControllerStatus = "disconnected" | "connecting" | "connected" | "failed";
type LocalStatusTone = "neutral" | "ok" | "fail";
type ConnectionMode = "vpn" | "local";

const VPN_LABELS: Record<VpnStatus, string> = {
  disconnected: "Not connected",
  starting: "Starting…",
  connected: "Connected",
  stopping: "Stopping…",
  failed: "Failed",
  unknown: "Unknown",
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
  if (status === "connecting" || status === "starting" || status === "stopping") return "warn";
  if (status === "failed") return "fail";
  return "neutral";
}

interface SessionTabProps {
  onControllerConnected?: () => void;
}

export default function SessionTab({ onControllerConnected }: SessionTabProps) {
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>("vpn");
  const [bundlePath, setBundlePath] = useState("");
  const [validation, setValidation] = useState<Record<string, boolean> | null>(null);

  const [vpnStatus, setVpnStatus] = useState<VpnStatus>("disconnected");
  const [vpnDetail, setVpnDetail] = useState("");

  const [vpnIp, setVpnIp] = useState("");
  const [lastOctet, setLastOctet] = useState("");
  const [savedOctet, setSavedOctet] = useState("");
  const [showVpnHelp, setShowVpnHelp] = useState(false);
  const [ctrlStatus, setCtrlStatus] = useState<ControllerStatus>("disconnected");
  const [ctrlDetail, setCtrlDetail] = useState("");

  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [preflightRunning, setPreflightRunning] = useState(false);
  const [serialDevice, setSerialDevice] = useState("");
  const [serialDevices, setSerialDevices] = useState<string[]>([]);
  const [serialDetail, setSerialDetail] = useState("");

  const [successBanner, setSuccessBanner] = useState<string | null>(null);
  const successBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    const active = vpnStatus === "starting" || vpnStatus === "connected" || vpnStatus === "stopping";
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
    setVpnStatus("starting");
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
    setVpnStatus("stopping");
    setVpnDetail("Stopping OpenVPN…");
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

  function showSuccess(msg: string) {
    setSuccessBanner(msg);
    if (successBannerTimerRef.current) clearTimeout(successBannerTimerRef.current);
    successBannerTimerRef.current = setTimeout(() => setSuccessBanner(null), 7000);
  }

  async function connectAndLaunch() {
    if (!canConnect) return;
    await connectToController();
    try {
      await invoke("open_controller_terminal");
      await invoke("start_log_watcher").catch(() => {});
      showSuccess("Connection successful — terminal app opened");
      onControllerConnected?.();
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
      setSerialDetail("Connecting…");
      localStorage.setItem("local_serial_device", serialDevice);
      await invoke("open_local_serial_terminal", { device: serialDevice });
      await invoke("start_log_watcher").catch(() => {});
      if (typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent)) {
        const label = "controller-terminal";
        let terminalWin = await WebviewWindow.getByLabel(label);
        if (!terminalWin) {
          terminalWin = new WebviewWindow(label, {
            title: "Controller Terminal",
            url: "/?terminalWindow=1",
            width: 980,
            height: 700,
            minWidth: 760,
            minHeight: 420,
          });
        }
      }
      setSerialDetail("Connected");
      showSuccess("Connection successful — terminal window opened");
      onControllerConnected?.();
    } catch (e) {
      setSerialDetail(`Failed: ${String(e)}`);
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
      {successBanner && (
        <div className="session-success-banner" role="status" aria-live="polite">
          <span className="session-success-icon">✓</span>
          {successBanner}
          <button className="session-success-dismiss" onClick={() => setSuccessBanner(null)} aria-label="Dismiss">×</button>
        </div>
      )}
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
                <div className="btn-group">
                  <button
                    className="btn btn-primary"
                    disabled={!allFilesOk || vpnStatus === "connected" || vpnStatus === "starting" || vpnStatus === "stopping"}
                    onClick={startVpn}
                  >
                    Open VPN
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={vpnStatus === "disconnected" || vpnStatus === "stopping"}
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
                    <button className="btn-link preflight-action" onClick={() => runPreflight(vpnIp)} disabled={preflightRunning}>
                      {preflightRunning ? "Checking…" : preflight ? "Re-check" : "Check"}
                    </button>
                  </div>
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
            <div className="vpn-help">
              <button
                className="btn-link vpn-help-toggle"
                type="button"
                onClick={() => setShowVpnHelp((prev) => !prev)}
                aria-expanded={showVpnHelp}
              >
                Having VPN issues?
              </button>
              {showVpnHelp && (
                <ol className="vpn-help-list">
                  <li>Disconnect controller in app.</li>
                  <li>Stop VPN in API.</li>
                  <li>Refresh API page.</li>
                  <li>Start VPN in API.</li>
                  <li>Stop OpenVPN in app.</li>
                  <li>Start OpenVPN in app.</li>
                  <li>Reconnect + Launch.</li>
                </ol>
              )}
            </div>
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
