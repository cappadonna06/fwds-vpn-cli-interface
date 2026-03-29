import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SystemConfig, defaultConfig, ZoneType, HHCType, WaterUseMode } from "../../types/config";
import { parseIntakeRow } from "../../lib/parseIntake";

type WizardView = "import" | "review" | "run";
type AppStatus = { vpn_phase: string; shell_phase: string; controller_ip: string | null };
type RunField = { label: string; value: string; sensitive?: boolean };
type RunSection = {
  id: string;
  step: number;
  title: string;
  command: string;
  note: string;
  caution?: string;
  fields: RunField[];
  checks?: string[];
};

const HHC_OPTIONS: HHCType[] = ["MP3", "HP6", "Legacy", "LV2"];
const ZONE_TYPES: ZoneType[] = ["Roof", "Eave", "Perimeter"];
const WATER_MODES: WaterUseMode[] = ["Standard", "High"];
const NETWORK_OPTIONS = [
  { value: "E", label: "Ethernet" },
  { value: "W", label: "Wi-Fi" },
  { value: "C", label: "Cellular" },
];

export default function WizardTab() {
  const [view, setView] = useState<WizardView>("import");
  const [rawIntake, setRawIntake] = useState("");
  const [config, setConfig] = useState<SystemConfig>(defaultConfig());
  const [warnings, setWarnings] = useState<string[]>([]);
  const [preflightChecked, setPreflightChecked] = useState<boolean[]>([]);
  const [appStatus, setAppStatus] = useState<AppStatus>({
    vpn_phase: "disconnected",
    shell_phase: "disconnected",
    controller_ip: null,
  });
  const [runError, setRunError] = useState("");
  const [copied, setCopied] = useState("");

  useEffect(() => {
    async function pollStatus() {
      try {
        const next = await invoke<AppStatus>("get_app_state");
        setAppStatus(next);
      } catch {
        // Ignore status polling failures while the app is starting or reconnecting.
      }
    }
    pollStatus();
    const id = setInterval(pollStatus, 2000);
    return () => clearInterval(id);
  }, []);

  function handleImport() {
    const { config: parsed, warnings: w } = parseIntakeRow(rawIntake);
    setConfig(parsed);
    setWarnings(w);
    setPreflightChecked(new Array(parsed.status_notes.length).fill(false));
    setView("review");
  }

  function handleStartBlank() {
    const c = defaultConfig();
    setConfig(c);
    setWarnings([]);
    setPreflightChecked([]);
    setView("review");
  }

  function setZone(i: number, field: "type" | "name", value: string) {
    setConfig((prev) => {
      const zones = [...prev.zones];
      zones[i] = { ...zones[i], [field]: value };
      return { ...prev, zones };
    });
  }

  function addZone() {
    setConfig((prev) => ({
      ...prev,
      zones: [...prev.zones, { type: "Roof", name: `Roof Zone ${prev.zones.length + 1}` }],
      num_zones: prev.zones.length + 1,
    }));
  }

  function removeZone(i: number) {
    setConfig((prev) => {
      const zones = prev.zones.filter((_, idx) => idx !== i);
      return { ...prev, zones, num_zones: zones.length };
    });
  }

  const preflightComplete =
    preflightChecked.length === 0 || preflightChecked.every(Boolean);
  const canStartWizard = config.customer_name.trim() && preflightComplete;
  const runSections = buildRunSections(config);

  async function openTerminal() {
    setRunError("");
    try {
      await invoke("open_controller_terminal");
    } catch (e) {
      setRunError(String(e));
    }
  }

  async function copyText(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => {
        setCopied((current) => (current === key ? "" : current));
      }, 1500);
    } catch {
      setRunError("Clipboard write failed.");
    }
  }

  if (view === "import") {
    return (
      <div className="tab-content" style={{ alignItems: "center" }}>
        <div className="card" style={{ width: "100%", maxWidth: 640 }}>
          <div className="card-title">Import PM Intake</div>
          <p className="hint">
            Paste the Slack/Sheets intake row below. Fields are tab-separated.
          </p>
          <textarea
            className="intake-input"
            rows={5}
            placeholder="@PM Name&#9;March 26th...&#9;32041 E. Citrus Ave.&#9;..."
            value={rawIntake}
            onChange={(e) => setRawIntake(e.target.value)}
          />
          <div className="btn-group" style={{ marginTop: 12 }}>
            <button
              className="btn btn-primary"
              disabled={!rawIntake.trim()}
              onClick={handleImport}
            >
              Parse Intake
            </button>
            <button className="btn btn-secondary" onClick={handleStartBlank}>
              Start Blank
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (view === "review") {
    return (
      <div className="tab-content" style={{ overflowY: "auto", alignItems: "center" }}>
      <div style={{ width: "100%", maxWidth: 640 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 className="section-heading">
            Config Review — {config.controller_id || "No ID"} · {config.structure_name || "No name"}
          </h2>
          <button className="btn btn-secondary" onClick={() => setView("import")}>
            ← Re-import
          </button>
        </div>

        {warnings.length > 0 && (
          <div className="warning-list">
            {warnings.map((w, i) => (
              <div key={i} className="warning-item">⚠ {w}</div>
            ))}
          </div>
        )}

        {/* Station */}
        <div className="card">
          <div className="card-title">Station</div>
          <div className="field-row">
            <label>Customer Name *</label>
            <input
              type="text"
              value={config.customer_name}
              onChange={(e) => setConfig((p) => ({ ...p, customer_name: e.target.value }))}
              placeholder="Required"
              className={!config.customer_name ? "input-required" : ""}
            />
          </div>
          <div className="field-row">
            <label>Location</label>
            <input
              type="text"
              value={config.location}
              onChange={(e) => setConfig((p) => ({ ...p, location: e.target.value }))}
            />
          </div>
          <div className="field-row">
            <label>Structure Name</label>
            <input
              type="text"
              value={config.structure_name}
              onChange={(e) => setConfig((p) => ({ ...p, structure_name: e.target.value }))}
            />
          </div>
          <div className="field-row">
            <label>Install Date</label>
            <input
              type="date"
              value={config.install_date}
              onChange={(e) => setConfig((p) => ({ ...p, install_date: e.target.value }))}
            />
          </div>
        </div>

        {/* System */}
        <div className="card">
          <div className="card-title">System</div>
          <div className="field-row">
            <label>HHC Type</label>
            <select
              value={config.hhc_type}
              onChange={(e) => setConfig((p) => ({ ...p, hhc_type: e.target.value as HHCType }))}
            >
              {HHC_OPTIONS.map((o) => <option key={o}>{o}</option>)}
            </select>
          </div>
          <div className="field-row">
            <label>Foam Module</label>
            <select
              value={config.foam_module ? "yes" : "no"}
              onChange={(e) => setConfig((p) => ({ ...p, foam_module: e.target.value === "yes" }))}
            >
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </div>
          <div className="field-row">
            <label>Drain Cycle</label>
            <select
              value={config.drain_cycle ? "yes" : "no"}
              onChange={(e) => setConfig((p) => ({ ...p, drain_cycle: e.target.value === "yes" }))}
            >
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </div>
          <div className="field-row">
            <label>Init Cycles</label>
            <input
              type="number"
              min={1}
              max={9}
              value={config.initiation_cycles}
              onChange={(e) => setConfig((p) => ({ ...p, initiation_cycles: parseInt(e.target.value) || 4 }))}
              style={{ width: 64 }}
            />
          </div>
          <div className="field-row">
            <label>Water Use Mode</label>
            <select
              value={config.water_use_mode}
              onChange={(e) => setConfig((p) => ({ ...p, water_use_mode: e.target.value as WaterUseMode }))}
            >
              {WATER_MODES.map((m) => <option key={m}>{m}</option>)}
            </select>
          </div>
        </div>

        {/* Zone Map */}
        <div className="card">
          <div className="card-title">Zone Map ({config.zones.length} zones)</div>
          <div className="zone-table">
            {config.zones.map((zone, i) => (
              <div key={i} className="zone-row">
                <span className="zone-num">{i + 1}</span>
                <select
                  value={zone.type}
                  onChange={(e) => setZone(i, "type", e.target.value)}
                >
                  {ZONE_TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
                <input
                  type="text"
                  value={zone.name}
                  maxLength={16}
                  onChange={(e) => setZone(i, "name", e.target.value)}
                  placeholder="Zone name (16 char max)"
                />
                <button className="btn-icon" onClick={() => removeZone(i)} title="Remove">✕</button>
              </div>
            ))}
            <button className="btn btn-secondary" style={{ marginTop: 8 }} onClick={addZone}>
              + Add Zone
            </button>
          </div>
        </div>

        {/* Network */}
        <div className="card">
          <div className="card-title">Network</div>
          <div className="field-row">
            <label>WiFi SSID</label>
            <input
              type="text"
              value={config.wifi_ssid}
              onChange={(e) => setConfig((p) => ({ ...p, wifi_ssid: e.target.value }))}
            />
          </div>
          <div className="field-row">
            <label>WiFi Password</label>
            <input
              type="password"
              value={config.wifi_password}
              onChange={(e) => setConfig((p) => ({ ...p, wifi_password: e.target.value }))}
            />
          </div>
          <div className="field-row">
            <label>Cellular</label>
            <span className="field-static">Always enabled</span>
          </div>
          <div className="field-row">
            <label>Satellite</label>
            <span className="field-static">Always enabled</span>
          </div>
          <div className="field-row">
            <label>Preferred Network</label>
            <select
              value={config.preferred_network ?? "E"}
              onChange={(e) =>
                setConfig((p) => ({ ...p, preferred_network: e.target.value as "E" | "W" | "C" }))
              }
            >
              {NETWORK_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Pre-flight */}
        {config.status_notes.length > 0 && (
          <div className="card">
            <div className="card-title">Pre-flight Checklist</div>
            {config.status_notes.map((note, i) => (
              <label key={i} className="preflight-item">
                <input
                  type="checkbox"
                  checked={preflightChecked[i] ?? false}
                  onChange={(e) => {
                    const updated = [...preflightChecked];
                    updated[i] = e.target.checked;
                    setPreflightChecked(updated);
                  }}
                />
                {note}
              </label>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="btn btn-primary"
            disabled={!canStartWizard}
            onClick={() => setView("run")}
          >
            Start Setup Wizard →
          </button>
          {!config.customer_name && (
            <span className="hint-inline">Customer name required to continue.</span>
          )}
          {!preflightComplete && (
            <span className="hint-inline">Complete pre-flight checklist to continue.</span>
          )}
        </div>
      </div>
      </div>
    );
  }

  return (
    <div className="tab-content" style={{ overflowY: "auto", alignItems: "center" }}>
      <div style={{ width: "100%", maxWidth: 920, display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="card">
          <div className="card-title">Setup Runbook</div>
          <p className="hint" style={{ marginBottom: 8 }}>
            Use the app for intake, values, and command order. Run the actual setup in Terminal.app so controller prompts behave like a normal SSH session.
          </p>
          <div className="wizard-status-row">
            <span className={`badge badge-${appStatus.vpn_phase}`}>VPN {appStatus.vpn_phase}</span>
            <span className={`badge badge-${appStatus.shell_phase === "connected" ? "connected" : appStatus.shell_phase}`}>
              Shell {appStatus.shell_phase}
            </span>
            {appStatus.controller_ip && (
              <span className="badge badge-connected">{appStatus.controller_ip}</span>
            )}
          </div>
          <div className="wizard-action-row">
            <button
              className="btn btn-primary"
              disabled={appStatus.vpn_phase !== "connected" || !appStatus.controller_ip}
              onClick={openTerminal}
            >
              Open Controller in Terminal
            </button>
            <button className="btn btn-secondary" onClick={() => setView("review")}>
              ← Back to Review
            </button>
          </div>
          {runError && <div className="warning-item" style={{ marginTop: 10 }}>{runError}</div>}
        </div>

        <div className="wizard-grid">
          <div className="card">
            <div className="card-title">Controller Summary</div>
            <div className="wizard-field-list">
              <RunFieldRow label="Controller ID" value={config.controller_id || "Not set"} onCopy={() => copyText(config.controller_id, "summary-controller")} copied={copied === "summary-controller"} />
              <RunFieldRow label="Customer" value={config.customer_name || "Required"} onCopy={() => copyText(config.customer_name, "summary-customer")} copied={copied === "summary-customer"} />
              <RunFieldRow label="Location" value={config.location || "Not set"} onCopy={() => copyText(config.location, "summary-location")} copied={copied === "summary-location"} />
              <RunFieldRow label="Structure" value={config.structure_name || "Not set"} onCopy={() => copyText(config.structure_name, "summary-structure")} copied={copied === "summary-structure"} />
              <RunFieldRow label="Wi-Fi SSID" value={config.wifi_ssid || "Not set"} onCopy={() => copyText(config.wifi_ssid, "summary-ssid")} copied={copied === "summary-ssid"} />
              <RunFieldRow label="Wi-Fi Password" value={config.wifi_password || "Not set"} masked onCopy={() => copyText(config.wifi_password, "summary-pass")} copied={copied === "summary-pass"} />
            </div>
          </div>

          <div className="card">
            <div className="card-title">Operator Notes</div>
            <div className="wizard-checklist">
              <div className="wizard-note">1. Click <strong>Open Controller in Terminal</strong>.</div>
              <div className="wizard-note">2. Run the commands below in order.</div>
              <div className="wizard-note">3. Use the copied values from this page when the controller prompts for input.</div>
              <div className="wizard-note">4. Return here after each stage so you do not lose the next command or field values.</div>
            </div>
          </div>
        </div>

        {runSections.map((section) => (
          <div key={section.id} className="card">
            <div className="wizard-step-header">
              <div>
                <div className="card-title">Step {section.step} · {section.title}</div>
                <div className="hint" style={{ marginBottom: 0 }}>{section.note}</div>
              </div>
              <div className="wizard-step-actions">
                <code className="wizard-command">{section.command}</code>
                <button
                  className="btn btn-secondary"
                  onClick={() => copyText(section.command, `${section.id}-command`)}
                >
                  {copied === `${section.id}-command` ? "Copied" : "Copy Command"}
                </button>
              </div>
            </div>
            {section.caution && (
              <div className="warning-item" style={{ marginTop: 10 }}>{section.caution}</div>
            )}
            <div className="wizard-field-list" style={{ marginTop: 12 }}>
              {section.fields.map((field) => (
                <RunFieldRow
                  key={`${section.id}-${field.label}`}
                  label={field.label}
                  value={field.value}
                  masked={field.sensitive}
                  onCopy={() => copyText(field.value, `${section.id}-${field.label}`)}
                  copied={copied === `${section.id}-${field.label}`}
                />
              ))}
            </div>
            {section.checks && section.checks.length > 0 && (
              <div className="wizard-checklist" style={{ marginTop: 12 }}>
                {section.checks.map((check, index) => (
                  <div key={`${section.id}-check-${index}`} className="wizard-note">{check}</div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function RunFieldRow({
  label,
  value,
  masked,
  onCopy,
  copied,
}: {
  label: string;
  value: string;
  masked?: boolean;
  onCopy: () => void;
  copied: boolean;
}) {
  const display = masked && value !== "Not set" ? "•".repeat(Math.max(8, value.length)) : value;
  return (
    <div className="wizard-field-row">
      <div>
        <div className="wizard-field-label">{label}</div>
        <div className="wizard-field-value">{display}</div>
      </div>
      <button className="btn btn-secondary" onClick={onCopy} disabled={!value || value === "Not set" || value === "Required"}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function buildRunSections(config: SystemConfig): RunSection[] {
  const zoneSummary = config.zones.length
    ? config.zones.map((zone, index) => `${index + 1}. ${zone.type} - ${zone.name}`).join("\n")
    : "Review and enter zone map manually.";
  const sections: RunSection[] = [
    {
      id: "station",
      step: 1,
      title: "Station Metadata",
      command: "setup-station",
      note: "Use this first to set customer/site identity before changing hardware or connectivity.",
      fields: [
        { label: "Customer Name", value: config.customer_name || "Required" },
        { label: "Location", value: config.location || "Not set" },
        { label: "Structure Name", value: config.structure_name || "Not set" },
        { label: "Install Date", value: config.install_date || "Not set" },
      ],
      checks: [
        "Run `setup-station` in Terminal.",
        "Accept defaults only when they already match the values above.",
      ],
    },
    {
      id: "system",
      step: 2,
      title: "Hydraulic System",
      command: "setup-system",
      note: "Use this only when the controller hardware config needs to be created or corrected.",
      caution: "setup-system can overwrite an existing hardware configuration. Stop here if the controller is already commissioned and you are not intending to replace that config.",
      fields: [
        { label: "HHC Type", value: config.hhc_type },
        { label: "Foam Module", value: yesNo(config.foam_module) },
        { label: "Drain Cycle", value: yesNo(config.drain_cycle) },
        { label: "Initiation Cycles", value: String(config.initiation_cycles) },
        { label: "Water Use Mode", value: config.water_use_mode },
        { label: "Zone Count", value: String(config.zones.length) },
        { label: "Zone Map", value: zoneSummary },
      ],
      checks: [
        "Review every prompt before accepting it.",
        "Use the zone map block above for zone-by-zone entry.",
      ],
    },
  ];

  if (config.wifi_ssid || config.wifi_password) {
    sections.push({
      id: "wifi",
      step: 3,
      title: "Wi-Fi",
      command: "setup-wifi",
      note: "Configure Wi-Fi credentials if this controller should use a local wireless network.",
      fields: [
        { label: "Enable Wi-Fi Networking", value: "Y" },
        { label: "SSID", value: config.wifi_ssid || "Not set" },
        { label: "Password", value: config.wifi_password || "Not set", sensitive: true },
      ],
      checks: [
        "After setup completes, run `wifi-check` to confirm connectivity.",
      ],
    });
  }

  sections.push({
    id: "network",
    step: config.wifi_ssid || config.wifi_password ? 4 : 3,
    title: "Preferred Network",
    command: "setup-preferred-network",
    note: "Choose which interface should be primary after connectivity is configured.",
    fields: [
      { label: "Preferred Network", value: preferredNetworkLabel(config.preferred_network) },
      { label: "Ethernet Enabled", value: yesNo(config.ethernet_enabled) },
      { label: "Cellular Enabled", value: yesNo(config.cellular_enabled) },
      { label: "Satellite Enabled", value: yesNo(config.satellite_enabled) },
    ],
    checks: [
      "After setting the preferred network, run the matching check command.",
      "Recommended follow-ups: `wifi-check`, `cellular-check`, `ethernet-check`.",
    ],
  });

  return sections;
}

function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

function preferredNetworkLabel(value: SystemConfig["preferred_network"]): string {
  switch (value) {
    case "E":
      return "Ethernet";
    case "W":
      return "Wi-Fi";
    case "C":
      return "Cellular";
    default:
      return "Choose during setup";
  }
}
