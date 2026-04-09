import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const COMMAND_PAYLOAD = "cat /var/etc/fwds/station_info\ncat /var/etc/fwds/system_info";

interface SystemZone {
  number?: number | null;
  zone_type?: string | null;
  name?: string | null;
}

interface SystemDiagnostic {
  sid?: string | null;
  version?: string | null;
  release_date?: string | null;
  system_name?: string | null;
  preferred_network?: string | null;
  install_date?: string | null;
  system_type?: string | null;
  foam_module?: boolean | null;
  drain_cycle?: boolean | null;
  initiation_cycles?: number | null;
  water_use_mode?: string | null;
  zone_count?: number | null;
  zones?: SystemZone[] | null;
}

interface DiagnosticState {
  system?: SystemDiagnostic | null;
  last_updated?: string | null;
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
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const data = diagState?.system ?? null;
  const zones = data?.zones ?? [];
  const hasData = Boolean(
    data &&
      (data.system_name ||
        data.system_type ||
        data.preferred_network ||
        data.initiation_cycles != null ||
        data.water_use_mode ||
        zones.length > 0)
  );

  const hasPartialWarning = Boolean(diagState?.system && !hasData);

  async function copyPayload() {
    await navigator.clipboard.writeText(COMMAND_PAYLOAD);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function sendPayload() {
    try {
      await invoke("send_input", { text: COMMAND_PAYLOAD });
      setSent(true);
      setTimeout(() => setSent(false), 1500);
      setError(null);
    } catch {
      setError("Could not send commands. Connect to a controller terminal first.");
    }
  }

  return (
    <div className="tab-content system-config-tab">
      <div className="system-config-header">
        <h1>System Configuration</h1>
        <p>Structured system details from station and system XML output.</p>
      </div>

      <div className="card system-config-command-card">
        <div className="system-config-request-row">
          <div>
            <div className="card-title" style={{ marginBottom: 4 }}>System Configuration Request</div>
            <p className="hint" style={{ margin: 0 }}>
              Pull station and system metadata from the controller.
            </p>
          </div>
          <div className="btn-group">
            <button className="btn btn-secondary" onClick={copyPayload}>
              {copied ? "✓ Copied" : "Copy"}
            </button>
            <button className="btn btn-primary" onClick={sendPayload}>
              {sent ? "✓ Sent" : "Send"}
            </button>
          </div>
        </div>
        <div className="system-config-command-summary">
          Sends: <code>cat /var/etc/fwds/station_info</code> + <code>cat /var/etc/fwds/system_info</code>
        </div>
        {diagState?.last_updated && (
          <div className="hint" style={{ marginTop: 8 }}>
            Listening for updates… Last diagnostics update: {new Date(diagState.last_updated).toLocaleString()}
          </div>
        )}
        {error && <div className="warning-item" style={{ marginTop: 10 }}>⚠ {error}</div>}
      </div>

      {hasPartialWarning && (
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
            <div className="system-config-kv"><span>System Name</span><strong>{data?.system_name || "—"}</strong></div>
            {data?.install_date && (
              <div className="system-config-kv"><span>Install Date</span><strong>{data.install_date}</strong></div>
            )}
          </div>

          <div className="card">
            <div className="card-title">System</div>
            <div className="system-config-kv"><span>System Type</span><strong>{data?.system_type || "—"}</strong></div>
            <div className="system-config-kv"><span>Foam Module</span><strong>{yesNo(data?.foam_module)}</strong></div>
            <div className="system-config-kv"><span>Preferred Network</span><strong>{titleCase(data?.preferred_network)}</strong></div>
            <div className="system-config-kv"><span>Drain Cycle</span><strong>{yesNo(data?.drain_cycle)}</strong></div>
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
