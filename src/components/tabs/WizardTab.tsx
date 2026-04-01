import { useState } from "react";
import { SystemConfig, defaultConfig, ZoneType, HHCType, WaterUseMode } from "../../types/config";
import { parseIntakeRow } from "../../lib/parseIntake";
import { buildReferenceSections } from "../../lib/buildReferenceRows";

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

  // Run view state
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [wifiMode, setWifiMode] = useState<"add" | "replace">("add");
  const [showPassword, setShowPassword] = useState(false);

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
  const sections = buildReferenceSections(config);

  // Map parse warnings to the section they belong to so they render inline
  const sectionWarnings: Record<string, string[]> = {};
  for (const w of warnings) {
    let id: string | null = null;
    if (/zone/i.test(w))              id = "zone-names";
    else if (/HHC type/i.test(w))     id = "setup-system";
    else if (/customer name/i.test(w)) id = "setup-station";
    if (id) {
      if (!sectionWarnings[id]) sectionWarnings[id] = [];
      sectionWarnings[id].push(w);
    }
  }

  function copyValue(value: string, id: string) {
    navigator.clipboard.writeText(value);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  function toggleRow(id: string) {
    setExpandedRows(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleSection(id: string) {
    setExpandedSections(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
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
            onClick={() => {
              setExpandedRows(new Set());
              setExpandedSections(new Set());
              setCopiedId(null);
              setWifiMode("add");
              setShowPassword(false);
              setView("run");
            }}
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
    <div className="ref-page">

      {/* ── Header ── */}
      <div className="ref-header">
        <div className="ref-header-left">
          <span className="ref-title">Setup Reference</span>
          <span className="ref-meta">
            {[
              config.customer_name,
              config.location,
              config.hhc_type,
              config.num_zones ? `${config.num_zones} zones` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <button
          className="btn btn-secondary"
          onClick={() => setView("review")}
        >
          ← Back to Review
        </button>
      </div>

      {/* ── Scrollable body ── */}
      <div className="ref-body">
      <div className="ref-body-inner">
        {sections.map(section => (
          <div key={section.id} className="ref-section">

            {/* Section header */}
            <div className="ref-section-header">
              <code className="ref-section-title">{section.title}</code>
              {section.command && (
                <button
                  className="btn btn-secondary ref-section-copy"
                  onClick={() => copyValue(section.command!, `section-cmd-${section.id}`)}
                >
                  {copiedId === `section-cmd-${section.id}` ? "✓ Copied" : "Copy command"}
                </button>
              )}
            </div>

            {/* Section note (e.g. zone-names context, cellular/satellite) */}
            {section.sectionNote && (
              <div className="ref-info-row">
                <span className="ref-info-note">ℹ {section.sectionNote}</span>
                {section.sectionHelper && (
                  <button
                    className="ref-help-btn"
                    onClick={() => toggleSection(section.id)}
                    title="More info"
                  >
                    {expandedSections.has(section.id) ? "▲" : "?"}
                  </button>
                )}
              </div>
            )}
            {section.sectionHelper && expandedSections.has(section.id) && (
              <div className="ref-helper-text">{section.sectionHelper}</div>
            )}

            {/* Section-level warnings from parse (e.g. default zone map) */}
            {sectionWarnings[section.id]?.map((w, i) => (
              <div key={i} className="ref-section-warning">⚠ {w}</div>
            ))}

            {/* Prompt rows */}
            {section.rows.length > 0 && (
              <div className="ref-rows">

                {/* Wi-Fi A/R toggle — inject above rows for setup-wifi section */}
                {section.id === "setup-wifi" && (
                  <div className="ref-wifi-toggle">
                    <label className="ref-radio-label">
                      <input
                        type="radio"
                        name="wifiMode"
                        checked={wifiMode === "add"}
                        onChange={() => setWifiMode("add")}
                      />
                      First install — Add (A)
                    </label>
                    <label className="ref-radio-label">
                      <input
                        type="radio"
                        name="wifiMode"
                        checked={wifiMode === "replace"}
                        onChange={() => setWifiMode("replace")}
                      />
                      Changing network — Replace (R)
                    </label>
                  </div>
                )}

                {section.rows.map(row => {
                  const isExpanded = expandedRows.has(row.id);
                  const isPasswordRow = !!row.sensitive;
                  const displayValue =
                    row.id === "wifi-add-replace"
                      ? wifiMode === "add" ? "A" : "R"
                      : row.value;
                  const copyTarget =
                    row.id === "wifi-add-replace"
                      ? wifiMode === "add" ? "A" : "R"
                      : row.value;

                  return (
                    <div key={row.id} className="ref-row-wrapper">
                      <div className={`ref-row${row.warning ? " ref-row-warning" : ""}`}>

                        {/* Label */}
                        <span className="ref-row-label">{row.label}</span>

                        {/* Value */}
                        <span className={(row.split || row.valueSuffix) ? "ref-row-value ref-row-value-fixed" : "ref-row-value"}>
                          {isPasswordRow && !showPassword
                            ? "••••••••"
                            : displayValue || <span className="ref-row-empty">—</span>}
                        </span>

                        {/* Password reveal */}
                        {isPasswordRow && (
                          <button
                            className="ref-reveal-btn"
                            onClick={() => setShowPassword(v => !v)}
                          >
                            {showPassword ? "Hide" : "Reveal"}
                          </button>
                        )}

                        {/* Non-copyable descriptor next to value (HHC name, water mode, etc.) */}
                        {row.valueSuffix && (
                          <>
                            <span className="ref-row-suffix">{row.valueSuffix}</span>
                            {!row.split && <span className="ref-row-spacer" />}
                          </>
                        )}

                        {/* Copy button */}
                        <button
                          className="btn btn-secondary ref-copy-btn"
                          onClick={() => copyValue(copyTarget, row.id)}
                          disabled={!copyTarget}
                        >
                          {copiedId === row.id ? "✓" : "Copy"}
                        </button>

                        {/* Split second prompt (zone name after zone type) */}
                        {row.split && (
                          <>
                            <span className="ref-row-split-divider" aria-hidden="true" />
                            <span className="ref-row-value ref-row-split-value">
                              {row.split.value || <span className="ref-row-empty">—</span>}
                            </span>
                            <button
                              className="btn btn-secondary ref-copy-btn"
                              onClick={() => copyValue(row.split!.value, row.split!.id)}
                              disabled={!row.split.value}
                            >
                              {copiedId === row.split.id ? "✓" : "Copy"}
                            </button>
                          </>
                        )}

                        {/* Help toggle — only if helper text exists */}
                        {row.helper && (
                          <button
                            className="ref-help-btn"
                            onClick={() => toggleRow(row.id)}
                            title="More info"
                          >
                            {isExpanded ? "▲" : "?"}
                          </button>
                        )}
                      </div>

                      {/* Warning */}
                      {row.warning && (
                        <div className="ref-row-warning-text">⚠ {row.warning}</div>
                      )}

                      {/* Expanded helper */}
                      {isExpanded && row.helper && (
                        <div className="ref-helper-text">{row.helper}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
      </div>
    </div>
  );
}
