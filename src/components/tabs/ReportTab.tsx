import { useState, useEffect, useRef, useMemo, useDeferredValue, useLayoutEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  SessionReport,
  ReportRecommendedAction,
  NetworkStatusRow,
  emptyReport,
} from "../../types/report";
import {
  generateActions,
  generateNetworkRows,
  generatePressureRows,
  generateRecommendedActions,
  formatSlack,
  formatSlackHtml,
  formatJira,
} from "../../lib/generateReport";

// ── Constants ─────────────────────────────────────────────────────────────────

const IFACE_ICON: Record<string, string> = {
  Ethernet: "🌐",
  "Wi-Fi": "🛜",
  Cellular: "📡",
  Satellite: "🛰️",
  Pressure: "💧",
};

const STATUS_EMOJI: Record<string, string> = {
  green: "🟢",
  orange: "🟠",
  red: "🔴",
  unknown: "⚪",
};

// ── SlackPreview ──────────────────────────────────────────────────────────────

export function SlackPreview({ report }: { report: SessionReport }) {
  const visibleActions = report.actions.filter(a => !a.dismissed && a.text.trim());
  const visibleRecs = report.recommendedActions.filter(a => !a.dismissed);

  const outcomeLabel =
    report.outcome === "complete" ? "Complete"
    : report.outcome === "escalated" ? "Escalated"
    : "Follow-up needed";

  return (
    <div className="report-preview-body">
      {/* Title */}
      <div className="report-preview-section">
        <div className="report-preview-heading">
          Controller Session — {report.date}
        </div>
        <div className="report-preview-meta">
          <strong>SID:</strong> {report.sid || "—"} &middot;{" "}
          {report.version || "—"} &middot;{" "}
          {report.ip || "—"}
        </div>
      </div>

      {/* Actions */}
      {visibleActions.length > 0 && (
        <div className="report-preview-section">
          <div className="report-preview-heading">Actions Taken</div>
          {visibleActions.map(a => (
            <div key={a.id} className="report-preview-bullet">
              <span className="report-preview-bullet-dot">•</span>
              <span>{a.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* Network */}
      <div className="report-preview-section">
        <div className="report-preview-heading">Network</div>
        {report.networkRows.map(row => {
          const note = report.networkNotes[row.interface];
          return (
            <div key={row.interface}>
              <div className="report-preview-network-row">
                <span>{STATUS_EMOJI[row.status] ?? "⚫"}</span>
                <span>
                  <strong>{IFACE_ICON[row.interface]} {row.interface}:</strong>{" "}
                  {row.summary}
                  {note ? <span className="report-preview-note-suffix"> — {note}</span> : null}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {report.pressureRows.length > 0 && (
        <div className="report-preview-section">
          <div className="report-preview-heading">Pressure Readings</div>
          {report.pressureRows.map(row => (
            <div key={row.label} className="report-preview-network-row">
              <span>{STATUS_EMOJI[row.status] ?? "⚫"}</span>
              <span>
                <strong>💧 {row.label}:</strong> {row.summary}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Recommended actions */}
      {visibleRecs.length > 0 && (
        <div className="report-preview-section">
          <div className="report-preview-heading">Recommended Actions</div>
          {visibleRecs.map(a => (
            <div key={a.id}>
              <div className="report-preview-rec-row">
                <span>{a.checked ? "✓" : "☐"}</span>
                <span>
                  {!a.custom && (
                    <span className="report-preview-rec-iface">
                      {IFACE_ICON[a.interface] ?? ""} {a.interface} —{" "}
                    </span>
                  )}
                  {a.text || <em>Untitled action</em>}
                </span>
              </div>
              {a.detail && (
                <div className="report-preview-rec-detail">{a.detail}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Notes */}
      {report.notes.trim() && (
        <div className="report-preview-section">
          <div className="report-preview-heading">Notes</div>
          <div className="report-preview-notes-text">{report.notes.trim()}</div>
        </div>
      )}

      {/* Outcome */}
      <div className="report-preview-outcome">
        <strong>Outcome:</strong> {outcomeLabel}
      </div>
    </div>
  );
}

// ── Clipboard helper ──────────────────────────────────────────────────────────

function SlackPreviewExact({ report }: { report: SessionReport }) {
  return (
    <div
      className="report-preview-body"
      dangerouslySetInnerHTML={{ __html: formatSlackHtml(report) }}
    />
  );
}

// ── Quick-select action templates ─────────────────────────────────────────────

const QUICK_ACTIONS = (version: string, zoneCount?: number | null) => [
  { label: "Upgraded firmware", text: `Upgraded firmware to ${version || "(x.x)"}` },
  { label: "Configured zones",  text: `System configured: ${zoneCount ?? "(x)"} zones` },
  { label: "Set primary network", text: "Set primary network to (x)" },
  { label: "Configured network",  text: "Configured (x) network" },
];

// ── Network preset chips (Ethernet + Wi-Fi) ───────────────────────────────────

type IfacePreset = {
  label: string;
  status: NetworkStatusRow["status"];
  summary: string;
  /** Optional recommended action to auto-add when this preset is applied. */
  recommendedAction?: {
    interface: ReportRecommendedAction["interface"];
    text: string;
    detail?: string;
  };
};

const NETWORK_PRESETS: Partial<Record<NetworkStatusRow["interface"], IfacePreset[]>> = {
  Ethernet: [
    { label: "Not connected", status: "unknown", summary: "Not connected" },
    { label: "N/A",           status: "unknown", summary: "N/A"           },
  ],
  "Wi-Fi": [
    {
      label: "Not configured",
      status: "orange",
      summary: "Not configured",
      recommendedAction: { interface: "Wi-Fi", text: "Configure Wi-Fi", detail: "Set SSID and passphrase via the WiFi setup workflow." },
    },
    { label: "N/A", status: "unknown", summary: "N/A" },
  ],
};

// ── Local-state inputs (prevent full-component re-render on keypress) ─────────

function NetworkSummaryInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [local, setLocal] = useState(value);
  const focused = useRef(false);
  // Sync from parent only when the user isn't actively typing
  useEffect(() => { if (!focused.current) setLocal(value); }, [value]);
  return (
    <input
      className="report-network-summary report-network-summary-input"
      type="text"
      value={local}
      placeholder="Add summary…"
      onChange={e => setLocal(e.target.value)}
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; onChange(local); }}
    />
  );
}

function NetworkNoteInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [local, setLocal] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setLocal(value); }, [value]);
  return (
    <input
      className="report-network-note"
      type="text"
      value={local}
      placeholder="Add note…"
      onChange={e => setLocal(e.target.value)}
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; onChange(local); }}
    />
  );
}

function ActionTextInput({ value, onCommit, placeholder }: { value: string; onCommit: (v: string) => void; placeholder: string }) {
  const [local, setLocal] = useState(value);
  const focused = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const resizeTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  useLayoutEffect(() => {
    if (!focused.current) setLocal(value);
  }, [value]);

  useLayoutEffect(() => {
    resizeTextarea();
    const raf = window.requestAnimationFrame(resizeTextarea);
    return () => window.cancelAnimationFrame(raf);
  }, [local, value]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    const handleResize = () => resizeTextarea();
    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => handleResize())
      : null;

    observer?.observe(el);
    if (el.parentElement) observer?.observe(el.parentElement);
    window.addEventListener("resize", handleResize);

    const raf = window.requestAnimationFrame(handleResize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", handleResize);
      window.cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <textarea
      ref={textareaRef}
      className="report-action-input"
      rows={1}
      value={local}
      placeholder={placeholder}
      onChange={e => {
        setLocal(e.target.value);
        resizeTextarea();
      }}
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; onCommit(local); }}
    />
  );
}

function NotesInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [local, setLocal] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setLocal(value); }, [value]);
  return (
    <textarea
      className="report-notes"
      rows={3}
      placeholder="Add session notes, observations, or context…"
      value={local}
      onChange={e => setLocal(e.target.value)}
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; onCommit(local); }}
    />
  );
}

const STATUS_OPTIONS: Array<{ value: NetworkStatusRow["status"]; label: string }> = [
  { value: "green", label: "Green" },
  { value: "orange", label: "Amber" },
  { value: "red", label: "Red" },
  { value: "unknown", label: "Gray" },
];

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) {
    return items;
  }
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function StatusPicker({
  value,
  onChange,
}: {
  value: NetworkStatusRow["status"];
  onChange: (next: NetworkStatusRow["status"]) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="report-status-picker">
      <button
        className={`report-status-dot report-status-dot-${value} report-status-dot-btn`}
        title="Choose status color"
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div className="report-status-menu">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className="report-status-menu-item"
              title={opt.label}
              aria-label={opt.label}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
            >
              <span className={`report-status-dot report-status-dot-${opt.value}`} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── ReportTab ─────────────────────────────────────────────────────────────────

export default function ReportTab() {
  const [report, setReport] = useState<SessionReport>(emptyReport());
  const [diagSnapshot, setDiagSnapshot] = useState<any>(null);
  const [copiedSlack, setCopiedSlack] = useState(false);
  const [copiedJira, setCopiedJira] = useState(false);
  const lastEditAtRef = useRef(0);
  const previewReport = useDeferredValue(report);
  const reportRef = useRef(report);
  reportRef.current = report;
  const visibleActions = report.actions.filter((action) => !action.dismissed);
  const visibleRecommendedActions = report.recommendedActions.filter((action) => !action.dismissed);

  async function fetchAndUpdate() {
    if (Date.now() - lastEditAtRef.current < 1200) {
      return;
    }
    try {
      const [diagState, appState] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        invoke<any>("get_diagnostic_state"),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        invoke<any>("get_app_state"),
      ]);

      const actions = generateActions(diagState, appState);
      const networkRows = generateNetworkRows(diagState);
      const pressureRows = generatePressureRows(diagState);
      const recommendedActions = generateRecommendedActions(diagState);

      setDiagSnapshot(diagState);
      setReport(prev => {
        // Merge actions: for auto-generated ones match by stable key so dismissal persists.
        const mergedGeneratedActions = actions.map(a => {
          if (!a.autoGenerated || !a.key) return a;
          const prevMatch = prev.actions.find(pa => pa.key === a.key);
          return prevMatch ? { ...a, id: prevMatch.id, dismissed: prevMatch.dismissed } : a;
        });
        const mergedGeneratedActionsByKey = new Map(
          mergedGeneratedActions
            .filter(a => a.autoGenerated && a.key)
            .map(a => [a.key as string, a])
        );
        const usedGeneratedActionKeys = new Set<string>();
        const mergedActions = [
          ...prev.actions.flatMap((action) => {
            if (action.autoGenerated && action.key) {
              const refreshed = mergedGeneratedActionsByKey.get(action.key);
              if (!refreshed) return [];
              usedGeneratedActionKeys.add(action.key);
              return [refreshed];
            }
            return [action];
          }),
          ...mergedGeneratedActions.filter(
            (action) => !(action.autoGenerated && action.key && usedGeneratedActionKeys.has(action.key))
          ),
        ];

        // Merge recommendedActions: preserve dismissed/checked by interface+text key;
        // keep custom user-added actions.
        const prevRecMap = new Map(
          prev.recommendedActions.filter(a => !a.custom).map(a => [`${a.interface}|${a.text}`, a])
        );
        const mergedGeneratedRecs = recommendedActions.map(a => {
          const p = prevRecMap.get(`${a.interface}|${a.text}`);
          return p ? { ...a, id: p.id, dismissed: p.dismissed, checked: p.checked } : a;
        });
        const mergedGeneratedRecsByKey = new Map(
          mergedGeneratedRecs
            .filter(a => !a.custom)
            .map(a => [`${a.interface}|${a.text}`, a])
        );
        const usedGeneratedRecKeys = new Set<string>();
        const mergedRecs = [
          ...prev.recommendedActions.flatMap((action) => {
            if (action.custom) return [action];
            const key = `${action.interface}|${action.text}`;
            const refreshed = mergedGeneratedRecsByKey.get(key);
            if (!refreshed) return [];
            usedGeneratedRecKeys.add(key);
            return [refreshed];
          }),
          ...mergedGeneratedRecs.filter((action) => {
            if (action.custom) return false;
            return !usedGeneratedRecKeys.has(`${action.interface}|${action.text}`);
          }),
        ];

        // Apply user overrides to network rows so edited fields don't get auto-reset.
        const mergedNetworkRows = networkRows.map(row => {
          const ov = prev.networkOverrides[row.interface];
          if (!ov) return row;
          return {
            ...row,
            ...(ov.status !== undefined ? { status: ov.status } : {}),
            ...(ov.summary !== undefined ? { summary: ov.summary } : {}),
          };
        });

        const mergedPressureRows = pressureRows.map(row => {
          const ov = prev.pressureOverrides[row.label];
          if (!ov) return row;
          return {
            ...row,
            ...(ov.status !== undefined ? { status: ov.status } : {}),
            ...(ov.summary !== undefined ? { summary: ov.summary } : {}),
          };
        });

        return {
          ...prev,
          sid: diagState.system?.sid ?? appState.controller_ip ?? "",
          version: diagState.system?.version ?? "",
          ip: appState.controller_ip ?? "",
          date: new Date().toISOString().slice(0, 10),
          generated: true,
          actions: mergedActions,
          networkRows: mergedNetworkRows,
          pressureRows: mergedPressureRows,
          // networkNotes, networkOverrides, notes, outcome preserved from prev via spread
          recommendedActions: mergedRecs,
        };
      });
    } catch (e) {
      console.error("Failed to generate report:", e);
    }
  }

  useEffect(() => {
    fetchAndUpdate();
    const id = setInterval(fetchAndUpdate, 2000);
    const unlistenSid = listen("controller-sid-detected", () => { fetchAndUpdate(); });
    return () => {
      clearInterval(id);
      unlistenSid.then((fn) => fn());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addAction() {
    lastEditAtRef.current = Date.now();
    setReport(r => ({
      ...r,
      actions: [...r.actions, { id: Date.now().toString(), text: "", dismissed: false }],
    }));
  }

  function addRec() {
    lastEditAtRef.current = Date.now();
    setReport(r => ({
      ...r,
      recommendedActions: [...r.recommendedActions, {
        id: Date.now().toString(),
        interface: "Custom" as const,
        text: "",
        detail: "",
        dismissed: false,
        checked: false,
        custom: true,
      }],
    }));
  }

  function dismissAction(id: string) {
    lastEditAtRef.current = Date.now();
    setReport(r => ({
      ...r,
      actions: r.actions.map(a => a.id === id ? { ...a, dismissed: true } : a),
    }));
  }

  function dismissRec(id: string) {
    lastEditAtRef.current = Date.now();
    setReport(r => ({
      ...r,
      recommendedActions: r.recommendedActions.map(a => a.id === id ? { ...a, dismissed: true } : a),
    }));
  }

  function updateActionText(id: string, text: string) {
    lastEditAtRef.current = Date.now();
    setReport(r => ({
      ...r,
      actions: r.actions.map(a => a.id === id ? { ...a, text } : a),
    }));
  }

  function updateRec(id: string, patch: Partial<ReportRecommendedAction>) {
    lastEditAtRef.current = Date.now();
    setReport(r => ({
      ...r,
      recommendedActions: r.recommendedActions.map(a => a.id === id ? { ...a, ...patch } : a),
    }));
  }

  function moveAction(id: string, offset: -1 | 1) {
    lastEditAtRef.current = Date.now();
    setReport((current) => {
      const visible = current.actions.filter((action) => !action.dismissed);
      const index = visible.findIndex((action) => action.id === id);
      const target = index + offset;
      if (index === -1 || target < 0 || target >= visible.length) return current;
      const fromIndex = current.actions.findIndex((action) => action.id === visible[index].id);
      const toIndex = current.actions.findIndex((action) => action.id === visible[target].id);
      if (fromIndex === -1 || toIndex === -1) return current;
      return { ...current, actions: moveItem(current.actions, fromIndex, toIndex) };
    });
  }

  function moveRecommendedAction(id: string, offset: -1 | 1) {
    lastEditAtRef.current = Date.now();
    setReport((current) => {
      const visible = current.recommendedActions.filter((action) => !action.dismissed);
      const index = visible.findIndex((action) => action.id === id);
      const target = index + offset;
      if (index === -1 || target < 0 || target >= visible.length) return current;
      const fromIndex = current.recommendedActions.findIndex((action) => action.id === visible[index].id);
      const toIndex = current.recommendedActions.findIndex((action) => action.id === visible[target].id);
      if (fromIndex === -1 || toIndex === -1) return current;
      return { ...current, recommendedActions: moveItem(current.recommendedActions, fromIndex, toIndex) };
    });
  }

  function setNetworkStatus(iface: string, next: NetworkStatusRow["status"]) {
    lastEditAtRef.current = Date.now();
    setReport(r => ({
      ...r,
      networkOverrides: { ...r.networkOverrides, [iface]: { ...r.networkOverrides[iface], status: next } },
    }));
  }

  function overrideNetworkSummary(iface: string, summary: string) {
    lastEditAtRef.current = Date.now();
    setReport(r => ({
      ...r,
      networkOverrides: { ...r.networkOverrides, [iface]: { ...r.networkOverrides[iface], summary } },
    }));
  }

  function applyNetworkPreset(iface: string, preset: IfacePreset) {
    lastEditAtRef.current = Date.now();
    setReport(r => {
      let recs = r.recommendedActions;
      if (preset.recommendedAction) {
        const ra = preset.recommendedAction;
        const exists = recs.some(a => a.interface === ra.interface && a.text === ra.text);
        if (!exists) {
          recs = [...recs, {
            id: `preset:${ra.interface}:${ra.text}`,
            interface: ra.interface,
            text: ra.text,
            detail: ra.detail ?? "",
            dismissed: false,
            checked: false,
            custom: true,
          }];
        }
      }
      return {
        ...r,
        networkOverrides: { ...r.networkOverrides, [iface]: { status: preset.status, summary: preset.summary } },
        recommendedActions: recs,
      };
    });
  }

  function clearNetworkOverride(iface: string) {
    lastEditAtRef.current = Date.now();
    setReport(r => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [iface]: _removed, ...rest } = r.networkOverrides;
      return { ...r, networkOverrides: rest };
    });
  }

  function setPressureStatus(label: string, next: NetworkStatusRow["status"]) {
    lastEditAtRef.current = Date.now();
    setReport(r => ({
      ...r,
      pressureOverrides: { ...r.pressureOverrides, [label]: { ...r.pressureOverrides[label], status: next } },
    }));
  }

  function overridePressureSummary(label: string, summary: string) {
    lastEditAtRef.current = Date.now();
    setReport(r => ({
      ...r,
      pressureOverrides: { ...r.pressureOverrides, [label]: { ...r.pressureOverrides[label], summary } },
    }));
  }

  function clearPressureOverride(label: string) {
    lastEditAtRef.current = Date.now();
    setReport(r => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [label]: _removed, ...rest } = r.pressureOverrides;
      return { ...r, pressureOverrides: rest };
    });
  }

  const quickActions = useMemo(
    () => QUICK_ACTIONS(report.version, diagSnapshot?.system?.zone_count),
    [report.version, diagSnapshot?.system?.zone_count]
  );

  return (
    <div className="report-page">

      {/* ── Header ── */}
      <div className="report-header">
        <div className="report-header-left">
          <span className="report-title">Session Report</span>
          <span className="report-header-sub">
            {report.generated
              ? [report.sid, report.version, report.ip, report.date].filter(Boolean).join(" · ")
              : "Auto-generated from diagnostics · edit freely"}
          </span>
        </div>
        <div className="report-header-actions">
          <button className="btn btn-secondary" onClick={() => setReport(emptyReport())}>
            Clear
          </button>
        </div>
      </div>

      {/* ── Split body ── */}
      {(
        <div className="report-split">

          {/* Left — editor */}
          <div className="report-edit-pane">

            {/* ACTIONS */}
            <div className="report-card">
              <div className="report-section-header">
                <span className="report-section-label">Actions Taken</span>
                <button className="btn-link" onClick={addAction}>+ Add</button>
              </div>
              {visibleActions.length === 0 && (
                <div className="report-empty-section">No actions taken yet. Add one or use a quick-select below.</div>
              )}
              {visibleActions.map((action, index) => (
                <div key={action.id} className="report-action-row">
                  <div className="report-reorder-controls" aria-label="Reorder action">
                    <button
                      type="button"
                      className="report-reorder-button"
                      onClick={() => moveAction(action.id, -1)}
                      disabled={index === 0}
                      title="Move up"
                      aria-label="Move action up"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="report-reorder-button"
                      onClick={() => moveAction(action.id, 1)}
                      disabled={index === visibleActions.length - 1}
                      title="Move down"
                      aria-label="Move action down"
                    >
                      ↓
                    </button>
                  </div>
                  <span className="report-action-bullet">•</span>
                  <ActionTextInput
                    value={action.text}
                    placeholder="Describe action…"
                    onCommit={(v) => updateActionText(action.id, v)}
                  />
                  <button className="report-dismiss-btn" onClick={() => dismissAction(action.id)}>✕</button>
                </div>
              ))}
              <div className="report-quick-actions">
                {quickActions.map(qa => (
                  <button
                    key={qa.label}
                    className="report-quick-action-pill"
                    onClick={() => {
                      lastEditAtRef.current = Date.now();
                      setReport(r => ({
                        ...r,
                        actions: [...r.actions, { id: Date.now().toString(), text: qa.text, dismissed: false }],
                      }));
                    }}
                  >
                    + {qa.label}
                  </button>
                ))}
              </div>
            </div>

            {/* NETWORK STATUS */}
            <div className="report-card">
              <div className="report-section-header">
                <span className="report-section-label">🌐 NETWORK STATUS</span>
              </div>
              {report.networkRows.map(row => {
                const hasOverride = !!report.networkOverrides[row.interface];
                return (
                  <div
                    key={row.interface}
                    className={`report-network-block report-network-block-${row.status}`}
                  >
                    <div className="report-network-row">
                      <StatusPicker
                        value={row.status}
                        onChange={(next) => setNetworkStatus(row.interface, next)}
                      />
                      <span className="report-network-iface">
                        {IFACE_ICON[row.interface]} {row.interface}
                      </span>
                      <NetworkSummaryInput
                        value={row.summary}
                        onChange={v => overrideNetworkSummary(row.interface, v)}
                      />
                      {hasOverride && (
                        <button
                          className="report-network-reset"
                          title="Reset to auto-populated"
                          onClick={() => clearNetworkOverride(row.interface)}
                        >
                          ↺
                        </button>
                      )}
                    </div>
                    {NETWORK_PRESETS[row.interface] && (
                      <div className="report-network-presets">
                        {NETWORK_PRESETS[row.interface]!.map(preset => (
                          <button
                            key={preset.label}
                            className="report-network-preset-pill"
                            onClick={() => applyNetworkPreset(row.interface, preset)}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                    )}
                    <NetworkNoteInput
                      value={report.networkNotes[row.interface] ?? ""}
                      onChange={v => {
                        lastEditAtRef.current = Date.now();
                        setReport(r => ({ ...r, networkNotes: { ...r.networkNotes, [row.interface]: v } }));
                      }}
                    />
                  </div>
                );
              })}
            </div>

            <div className="report-card">
              <div className="report-section-header">
                <span className="report-section-label">💧 PRESSURE READINGS</span>
              </div>
              {report.pressureRows.map(row => (
                <div key={row.label} className={`report-network-block report-network-block-${row.status}`}>
                  <div className="report-network-row">
                    <StatusPicker
                      value={row.status}
                      onChange={(next) => setPressureStatus(row.label, next)}
                    />
                    <span className="report-network-iface">💧 {row.label}</span>
                    <NetworkSummaryInput
                      value={row.summary}
                      onChange={v => overridePressureSummary(row.label, v)}
                    />
                    {!!report.pressureOverrides[row.label] && (
                      <button
                        className="report-network-reset"
                        title="Reset to auto-populated"
                        onClick={() => clearPressureOverride(row.label)}
                      >
                        ↺
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* RECOMMENDED ACTIONS */}
            <div className="report-card">
              <div className="report-section-header">
                <span className="report-section-label">🔧 RECOMMENDED ACTIONS</span>
                <button className="btn-link" onClick={addRec}>+ Add</button>
              </div>
              {visibleRecommendedActions.length === 0 && (
                <div className="report-empty-section">
                  No recommended actions. Add one or re-run diagnostics.
                </div>
              )}
              {visibleRecommendedActions.map((action, index) => (
                <div key={action.id} className="report-rec-row">
                  <div className="report-reorder-controls" aria-label="Reorder recommended action">
                    <button
                      type="button"
                      className="report-reorder-button"
                      onClick={() => moveRecommendedAction(action.id, -1)}
                      disabled={index === 0}
                      title="Move up"
                      aria-label="Move recommended action up"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="report-reorder-button"
                      onClick={() => moveRecommendedAction(action.id, 1)}
                      disabled={index === visibleRecommendedActions.length - 1}
                      title="Move down"
                      aria-label="Move recommended action down"
                    >
                      ↓
                    </button>
                  </div>
                  <input
                    type="checkbox"
                    className="report-rec-check"
                    checked={action.checked}
                    onChange={e => updateRec(action.id, { checked: e.target.checked })}
                  />
                  <div className="report-rec-content">
                    {!action.custom && (
                      <span className="report-rec-iface">
                        {IFACE_ICON[action.interface] ?? ""} {action.interface} —
                      </span>
                    )}
                    <input
                      className="report-rec-input"
                      type="text"
                      value={action.text}
                      placeholder="Action…"
                      onChange={e => updateRec(action.id, { text: e.target.value })}
                    />
                    {action.detail && (
                      <div className="report-rec-detail">{action.detail}</div>
                    )}
                  </div>
                  <button className="report-dismiss-btn" onClick={() => dismissRec(action.id)}>✕</button>
                </div>
              ))}
            </div>

            {/* NOTES */}
            <div className="report-card">
              <div className="report-section-header">
                <span className="report-section-label">📝 NOTES</span>
              </div>
              <NotesInput value={report.notes} onCommit={(v) => setReport(r => ({ ...r, notes: v }))} />
            </div>

            {/* OUTCOME */}
            <div className="report-card">
              <div className="report-section-header">
                <span className="report-section-label">✅ OUTCOME</span>
              </div>
              <div className="report-outcome-pills">
                {(["complete", "escalated", "followup"] as const).map(o => (
                  <button
                    key={o}
                    className={`report-outcome-pill${report.outcome === o ? ` report-outcome-pill-${o} active` : ""}`}
                    onClick={() => setReport(r => ({ ...r, outcome: o }))}
                  >
                    {o === "complete" ? "✓ Complete"
                      : o === "escalated" ? "↑ Escalated"
                      : "→ Follow-up"}
                  </button>
                ))}
              </div>
            </div>

          </div>

          {/* Right — Slack preview */}
          <div className="report-preview-pane">
            <div className="report-preview-label">
              <span>📨</span> Slack Preview
            </div>
            <SlackPreviewExact report={previewReport} />
          </div>

        </div>
      )}

      {/* ── Footer ── */}
      {(
        <div className="report-footer">
          <button
            className="btn btn-secondary"
            onClick={() => {
              const text = formatSlack(report);
              navigator.clipboard.write([
                new ClipboardItem({
                  "text/html":  new Blob([formatSlackHtml(report)], { type: "text/html" }),
                  "text/plain": new Blob([text],              { type: "text/plain" }),
                }),
              ]).catch(() => navigator.clipboard.writeText(text));
              setCopiedSlack(true);
              setTimeout(() => setCopiedSlack(false), 1500);
            }}
          >
            {copiedSlack ? "✓ Copied" : "📋 Copy Slack"}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => {
              navigator.clipboard.writeText(formatJira(report));
              setCopiedJira(true);
              setTimeout(() => setCopiedJira(false), 1500);
            }}
          >
            {copiedJira ? "✓ Copied" : "📋 Copy Jira"}
          </button>
        </div>
      )}
    </div>
  );
}
