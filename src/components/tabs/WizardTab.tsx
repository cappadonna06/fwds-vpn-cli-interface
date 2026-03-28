import { useState } from "react";
import { SystemConfig, defaultConfig, ZoneType, HHCType, WaterUseMode } from "../../types/config";
import { parseIntakeRow } from "../../lib/parseIntake";

type WizardView = "import" | "review" | "run";

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

  // run view — placeholder for the interactive wizard
  return (
    <div className="tab-content">
      <div className="card">
        <div className="card-title">Setup Wizard — Active</div>
        <p className="hint">
          Controller: <strong>{config.controller_id}</strong> · {config.structure_name}
        </p>
        <div className="wizard-placeholder">
          Interactive setup wizard coming next. Will display live controller prompts pre-filled from config.
        </div>
        <button className="btn btn-secondary" style={{ marginTop: 12 }} onClick={() => setView("review")}>
          ← Back to Review
        </button>
      </div>
    </div>
  );
}
