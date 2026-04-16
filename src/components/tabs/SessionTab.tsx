import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type VpnStatus = "disconnected" | "starting" | "connected" | "manual" | "stopping" | "failed" | "unknown";
type ControllerStatus = "disconnected" | "connecting" | "connected" | "failed";
type LocalStatusTone = "neutral" | "ok" | "fail";
type ConnectionMode = "vpn" | "local";
type RemoteAccessState = "disabled" | "enabled-unconfigured" | "ready";

const VPN_LABELS: Record<VpnStatus, string> = {
  disconnected: "Not connected",
  starting: "Starting...",
  connected: "Connected",
  manual: "Ready to finish",
  stopping: "Stopping...",
  failed: "Failed",
  unknown: "Unknown",
};

const CTRL_LABELS: Record<ControllerStatus, string> = {
  disconnected: "Not connected",
  connecting: "Connecting...",
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
  if (status === "connecting" || status === "starting" || status === "stopping" || status === "manual") return "warn";
  if (status === "failed") return "fail";
  return "neutral";
}

interface SessionTabProps {
  onControllerConnected?: () => void;
}

export default function SessionTab({ onControllerConnected }: SessionTabProps) {
  const isWindows = typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>("local");
  const [remoteAccessEnabled, setRemoteAccessEnabled] = useState(false);
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
    const savedRemoteEnabled = localStorage.getItem("remote_access_enabled");
    if (savedRemoteEnabled === "true") setRemoteAccessEnabled(true);

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
      if (r.phase === "connected") {
        setPreflight((prev) => {
          if (!vpnIp) {
            return prev;
          }
          return {
            ping_ok: prev?.ping_ok ?? false,
            port_ok: true,
            detail: prev?.ping_ok
              ? `${vpnIp} reachable, port 22 open`
              : `${vpnIp} SSH connected`,
          };
        });
      }
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
    if (vpnStatus === "connected" || (isWindows && vpnStatus === "manual")) {
      runPreflight(vpnIp);
    }
  }

  async function startVpn() {
    setVpnStatus("starting");
    setVpnDetail(isWindows ? "Opening VPN..." : "Requesting administrator privileges...");
    try {
      await invoke("start_vpn", { folder: bundlePath });
      await pollVpn();
    } catch (e) {
      setVpnStatus("failed");
      setVpnDetail(String(e));
    }
  }

  async function stopVpn() {
    setVpnStatus("stopping");
    setVpnDetail(isWindows ? "Closing VPN..." : "Stopping OpenVPN...");
    setPreflight(null);
    try {
      await invoke("stop_vpn");
      await pollVpn();
    } catch {
      // best effort
    }
  }

  async function connectToController() {
    if (!vpnIp) return false;
    localStorage.setItem("vpn_last_octet", lastOctet);
    setSavedOctet(lastOctet);
    setCtrlStatus("connecting");
    setCtrlDetail(`Connecting to ${vpnIp}...`);
    prevCtrlPhaseRef.current = "connecting";
    try {
      await invoke("connect_controller", { ip: vpnIp });
      return true;
    } catch (e) {
      setCtrlStatus("failed");
      setCtrlDetail(String(e));
      return false;
    }
  }

  function showSuccess(msg: string) {
    setSuccessBanner(msg);
    if (successBannerTimerRef.current) clearTimeout(successBannerTimerRef.current);
    successBannerTimerRef.current = setTimeout(() => setSuccessBanner(null), 7000);
  }

  async function connectAndLaunch() {
    if (!canConnect) return;
    const connected = await connectToController();
    if (!connected) return;
    try {
      await invoke("open_controller_terminal");
      await invoke("start_log_watcher").catch(() => {});
      showSuccess(isWindows ? "Connection successful - terminal window opened" : "Connection successful - terminal app opened");
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
      setSerialDetail("Connecting...");
      localStorage.setItem("local_serial_device", serialDevice);
      await invoke("open_local_serial_terminal", { device: serialDevice });
      await invoke("start_log_watcher").catch(() => {});
      const isWindows = typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);
      setSerialDetail(isWindows ? "Connected via PuTTY" : "Connected");
      showSuccess(isWindows ? "Connection successful - PuTTY opened" : "Connection successful - terminal window opened");
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
  const remoteAccessState: RemoteAccessState = !remoteAccessEnabled
    ? "disabled"
    : allFilesOk
      ? "ready"
      : "enabled-unconfigured";
  const remoteAccessGated = remoteAccessState !== "ready";
  const octetNum = parseInt(lastOctet, 10);
  const octetValid = lastOctet !== "" && !Number.isNaN(octetNum) && octetNum >= 1 && octetNum <= 254;
  const manualVpnReady = isWindows && vpnStatus === "manual" && preflight?.port_ok === true;
  const canConnect = octetValid && (vpnStatus === "connected" || manualVpnReady);
  const showPreflight = octetValid && (vpnStatus === "connected" || (isWindows && vpnStatus === "manual"));

  const localState: { label: string; tone: LocalStatusTone } = useMemo(() => {
    const normalized = serialDetail.toLowerCase();
    if (normalized.includes("connected")) return { label: "Connected", tone: "ok" };
    if (normalized.includes("error") || normalized.includes("failed")) return { label: "Failed", tone: "fail" };
    if (normalized.includes("disconnected")) return { label: "Idle", tone: "neutral" };
    return { label: "Idle", tone: "neutral" };
  }, [serialDetail]);

  function preflightDotClass(kind: "ping" | "port", ok: boolean | undefined): string {
    if (preflight === null) return "idle";
    if (kind === "ping" && ok === false && preflight.port_ok) return "warn";
    return ok ? "ok" : "fail";
  }

  function enableRemoteAccess() {
    setRemoteAccessEnabled(true);
    localStorage.setItem("remote_access_enabled", "true");
  }

  return (
    <div className="tab-content session-tab">
      {successBanner && (
        <div className="session-success-banner" role="status" aria-live="polite">
          <span className="session-success-icon">✓</span>
          {successBanner}
          <button className="session-success-dismiss" onClick={() => setSuccessBanner(null)} aria-label="Dismiss">x</button>
        </div>
      )}
      <div className="session-shell">
        <div className="session-heading">
          <h1>Connect</h1>
          <p>Choose one connection mode at a time.</p>
        </div>

        <div className="connect-mode-toggle" role="tablist" aria-label="Connection mode">
          <button
            className={`mode-toggle-btn ${connectionMode === "local" ? "active" : ""}`}
            onClick={() => setConnectionMode("local")}
            role="tab"
            aria-selected={connectionMode === "local"}
          >
            Local
          </button>
          <button
            className={`mode-toggle-btn ${connectionMode === "vpn" ? "active" : ""} ${remoteAccessGated ? "gated" : ""}`}
            onClick={() => setConnectionMode("vpn")}
            role="tab"
            aria-selected={connectionMode === "vpn"}
          >
            <span className="mode-toggle-label">
              {remoteAccessGated && (
                <span className="mode-toggle-lock" aria-hidden="true">
                  <svg viewBox="0 0 16 16" focusable="false">
                    <path d="M5.5 6V4.75a2.5 2.5 0 1 1 5 0V6" />
                    <rect x="3.5" y="6" width="9" height="7" rx="1.75" />
                  </svg>
                </span>
              )}
              <span>Remote (VPN)</span>
            </span>
          </button>
        </div>

        {connectionMode === "local" ? (
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
        ) : (
          <section className="connect-card connect-card-single">
            <div className="connect-card-head">
              <div>
                <h2>Remote Controller Access</h2>
                <p>Main flow: Bundle ready, Open VPN, enter VPN ID, then Connect + Launch.</p>
              </div>
              {remoteAccessState === "ready" && (
                <div className="status-chip-row">
                  <span className="status-chip ok">Bundle ready</span>
                  <span className={`status-chip ${statusTone(vpnStatus)}`}>{vpnStatus === "connected" ? "VPN connected" : VPN_LABELS[vpnStatus]}</span>
                  {showPreflight && preflight?.port_ok && <span className="status-chip ok">SSH reachable</span>}
                </div>
              )}
            </div>

            {remoteAccessState === "disabled" && (
              <div className="remote-stage-card">
                <div className="remote-stage-badge">Approval required</div>
                <h3>Remote Controller Access</h3>
                <p>Remote access is disabled by default.</p>
                <div className="remote-stage-list-label">This feature requires:</div>
                <ul className="remote-stage-list">
                  <li>VPN credentials (bundle)</li>
                  <li>Management / IT approval</li>
                </ul>
                <div className="card-actions">
                  <button className="btn btn-primary" onClick={enableRemoteAccess}>
                    Enable Remote Access
                  </button>
                </div>
              </div>
            )}

            {remoteAccessState === "enabled-unconfigured" && (
              <div className="remote-stage-card remote-stage-card-setup">
                <div className="status-chip-row">
                  <span className="status-chip ok">Remote access enabled</span>
                  <span className="status-chip neutral">No bundle detected</span>
                </div>
                <h3>Remote Controller Access</h3>
                <div className="remote-stage-step">Step 1 - Add VPN bundle</div>
                <p className="remote-stage-empty">No bundle detected</p>
                <div className="card-actions">
                  <button className="btn btn-primary" onClick={selectFolder}>
                    Select VPN Bundle
                  </button>
                </div>
                <p className="remote-stage-helper">You can get this from your admin.</p>
                {bundlePath && (
                  <div className="remote-stage-inline">
                    <span className="bundle-path" title={bundlePath}>{bundlePath}</span>
                    <button className="btn-link" onClick={selectFolder}>Change bundle</button>
                  </div>
                )}
                {validation !== null && !allFilesOk && (
                  <div className="hint session-hint error">Missing: {missingFiles.join(", ")}</div>
                )}
              </div>
            )}

            {remoteAccessState === "ready" && (
              <>
                <div className="flow-group flow-group-soft">
                  <div className="flow-row flow-row-stack-mobile">
                    <div className="row-context">Bundle</div>
                    <span className="bundle-path" title={bundlePath}>{bundlePath}</span>
                    <span className="status-chip ok">Bundle ready</span>
                    <button className="btn-link" onClick={selectFolder}>Change bundle</button>
                  </div>
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
                  {isWindows && vpnStatus === "manual" && (
                    <div className="hint session-hint">
                      VPN app opened. Connect there, then return here and click Check.
                    </div>
                  )}
                </div>

                <div className="flow-group">
                  <div className="flow-row ip-row flow-row-stack-mobile">
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
                        <span className={`preflight-dot ${preflightDotClass("ping", preflight?.ping_ok)}`}>Ping</span>
                        <span className={`preflight-dot ${preflightDotClass("port", preflight?.port_ok)}`}>Port 22</span>
                        {preflight && <span className="preflight-detail">{preflight.detail}</span>}
                        <button className="btn-link preflight-action" onClick={() => runPreflight(vpnIp)} disabled={preflightRunning}>
                          {preflightRunning ? "Checking..." : preflight ? "Re-check" : "Check"}
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

                <div className="hint session-hint">Controller: {CTRL_LABELS[ctrlStatus]}{ctrlDetail ? ` - ${ctrlDetail}` : ""}</div>
                {!canConnect && (ctrlStatus === "disconnected" || ctrlStatus === "failed") && Boolean(lastOctet) && vpnStatus !== "connected" && (
                  <div className="hint session-hint">
                    {isWindows && vpnStatus === "manual"
                      ? "Finish connecting in the VPN app, then click Check."
                      : "Open VPN first."}
                  </div>
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
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
