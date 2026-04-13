import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { copyCommandText, sendCommandText } from "../../lib/commandActions";

const COMMAND_PAYLOAD = "cat /var/etc/fwds/station_info\ncat /var/etc/fwds/system_info\ncell-imei\nsat-imei";

interface SystemZone {
  number?: number | null;
  zone_type?: string | null;
  name?: string | null;
  motor_driver?: string | null;
}

interface SystemDiagnostic {
  sid?: string | null;
  imei?: string | null;
  version?: string | null;
  release_date?: string | null;
  display_name?: string | null;
  location?: string | null;
  system_name?: string | null;
  preferred_network?: string | null;
  preferred_network_service_type?: string | null;
  install_date?: string | null;
  system_type?: string | null;
  hydraulic_hardware_configuration?: string | null;
  foam_module?: boolean | null;
  no_foam_system?: boolean | null;
  drain_cycle?: boolean | null;
  drain_during_deactivation?: boolean | null;
  initiation_cycles?: number | null;
  water_use_mode?: string | null;
  zone_count?: number | null;
  zones?: SystemZone[] | null;
}

interface InterfaceRunState {
  in_progress?: boolean;
  started_at?: string | null;
}

interface DiagnosticState {
  system?: SystemDiagnostic | null;
  cellular?: { imei?: string | null } | null;
  satellite?: { sat_imei?: string | null } | null;
  interface_runs?: Record<string, InterfaceRunState> | null;
}

function titleCase(input?: string | null): string {
  if (!input) return "—";
  return input
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function yesNo(value?: boolean | null): string {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "—";
}

export default function SystemConfigurationTab() {
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [diagState, setDiagState] = useState<DiagnosticState | null>(null);

  useEffect(() => {
    let alive = true;

    async function refresh() {
      try {
        const state = await invoke<DiagnosticState>("get_diagnostic_state");
        if (alive) setDiagState(state);
      } catch {
        if (alive) setDiagState(null);
      }
    }

    refresh();
    const id = setInterval(refresh, 2000);
    const unlistenSid = listen("controller-sid-detected", () => { refresh(); });
    const unlistenSystem = listen("system-config-updated", () => { refresh(); });
    return () => {
      alive = false;
      clearInterval(id);
      unlistenSid.then((fn) => fn());
      unlistenSystem.then((fn) => fn());
    };
  }, []);

  const data = diagState?.system ?? null;
  const zones = data?.zones ?? [];
  const systemUpdating = diagState?.interface_runs?.system?.in_progress === true;
  const hasData = Boolean(
    diagState?.cellular?.imei ||
    diagState?.satellite?.sat_imei ||
    (data &&
      (data.sid ||
        data.imei ||
        data.version ||
        data.release_date ||
        data.display_name ||
        data.system_name ||
        data.location ||
        data.system_type ||
        data.hydraulic_hardware_configuration ||
        data.preferred_network ||
        data.preferred_network_service_type ||
        data.initiation_cycles != null ||
        data.water_use_mode ||
        data.zone_count != null ||
        zones.length > 0))
  );

  const hasPartialWarning = Boolean(diagState?.system && !hasData);

  async function copyPayload() {
    await copyCommandText(COMMAND_PAYLOAD);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function sendPayload() {
    try {
      await sendCommandText(COMMAND_PAYLOAD);
      setSent(true);
      setTimeout(() => setSent(false), 1500);
      setError(null);
    } catch {
      setError("Could not send commands. Connect to a controller terminal first.");
    }
  }

  async function clearSystemConfig() {
    await invoke("clear_diagnostic_interface", { interface: "system" }).catch(() => {});
    setDiagState((prev) => (prev ? { ...prev, system: null } : prev));
  }

  return (
    <div className="tab-content system-config-tab">
      <div className="system-config-header">
        <h1>System Configuration</h1>
        <p>Structured system details from station and system XML output.</p>
      </div>

      <div className="diag-header-toolbar system-config-request-toolbar">
        <div className="system-config-request-title">System Configuration Request</div>
        <div className="btn-group">
          <button className="btn btn-secondary" onClick={clearSystemConfig}>
            Clear
          </button>
          <button className="btn btn-secondary" onClick={copyPayload}>
            {copied ? "Copied" : "Copy"}
          </button>
          <button className="btn btn-secondary" onClick={sendPayload}>
            {sent ? "Sent" : "Send"}
          </button>
        </div>
        {error && <div className="warning-item">⚠ {error}</div>}
      </div>

      {systemUpdating && (
        <div className="system-config-warning">
          Collecting system configuration data…
        </div>
      )}
      {hasPartialWarning && !systemUpdating && (
        <div className="system-config-warning">
          ⚠ Some system details are missing. Run the diagnostics block again to refresh data.
        </div>
      )}

      {!hasData ? (
        <div className="card system-config-empty-state">
          <div className="system-config-empty-icon">🧭</div>
          <h2>No system details yet</h2>
          <p>
            Run <strong>System Configuration Request</strong> to populate system information, then
            return here for a structured configuration snapshot.
          </p>
        </div>
      ) : (
        <div className="system-config-grid">
          <div className="card">
            <div className="card-title">Customer</div>
            <div className="system-config-kv"><span>SID</span><strong>{data?.sid || "—"}</strong></div>
            <div className="system-config-kv"><span>Cellular IMEI</span><strong>{diagState?.cellular?.imei || data?.imei || "—"}</strong></div>
            <div className="system-config-kv"><span>Satellite IMEI</span><strong>{diagState?.satellite?.sat_imei || "—"}</strong></div>
            <div className="system-config-kv"><span>Display Name</span><strong>{data?.display_name || data?.system_name || "—"}</strong></div>
            <div className="system-config-kv"><span>Location</span><strong>{data?.location || "—"}</strong></div>
            {data?.install_date && (
              <div className="system-config-kv"><span>Install Date</span><strong>{data.install_date}</strong></div>
            )}
            <div className="system-config-kv"><span>Firmware Version</span><strong>{data?.version || "—"}</strong></div>
            {data?.release_date && (
              <div className="system-config-kv"><span>Release Date</span><strong>{data.release_date}</strong></div>
            )}
          </div>

          <div className="card">
            <div className="card-title">System</div>
            <div className="system-config-kv"><span>System Type</span><strong>{data?.system_type || "—"}</strong></div>
            <div className="system-config-kv"><span>Preferred Network</span><strong>{titleCase(data?.preferred_network_service_type || data?.preferred_network)}</strong></div>
            <div className="system-config-kv"><span>Hydraulic Hardware</span><strong>{titleCase(data?.hydraulic_hardware_configuration) || "—"}</strong></div>
            <div className="system-config-kv"><span>Foam Module</span><strong>{yesNo(data?.foam_module)}</strong></div>
            <div className="system-config-kv"><span>Foam System</span><strong>{data?.no_foam_system == null ? "—" : (data.no_foam_system ? "No" : "Yes")}</strong></div>
            <div className="system-config-kv"><span>Drain During Deactivation</span><strong>{yesNo(data?.drain_during_deactivation ?? data?.drain_cycle)}</strong></div>
            <div className="system-config-kv"><span>Init Cycles</span><strong>{data?.initiation_cycles ?? "—"}</strong></div>
            <div className="system-config-kv"><span>Water Use Mode</span><strong>{titleCase(data?.water_use_mode)}</strong></div>
          </div>

          <div className="card system-config-zone-card">
            <div className="card-title">Zone Map</div>
            <div className="system-config-zone-count">
              {data?.zone_count ?? zones.length} zone{(data?.zone_count ?? zones.length) === 1 ? "" : "s"}
            </div>
            {zones.length === 0 ? (
              <p className="hint">No zone rows were detected in the latest system output.</p>
            ) : (
              <div className="system-zone-table">
                <div className="system-zone-row system-zone-head">
                  <span>Number</span>
                  <span>Type</span>
                  <span>Name</span>
                </div>
                {zones.map((zone, idx) => (
                  <div key={`${zone.number ?? "n"}-${idx}`} className="system-zone-row">
                    <span>{zone.number ?? idx + 1}</span>
                    <span>{titleCase(zone.zone_type)}</span>
                    <span>{zone.name || "—"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
