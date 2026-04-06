import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  SessionReport,
  ReportRecommendedAction,
  emptyReport,
} from "../../types/report";
import {
  generateActions,
  generateNetworkRows,
  generateRecommendedActions,
  formatSlack,
  formatJira,
} from "../../lib/generateReport";

// ── Constants ─────────────────────────────────────────────────────────────────

const IFACE_ICON: Record<string, string> = {
  Ethernet: "🔌",
  "Wi-Fi": "📶",
  Cellular: "📡",
  Satellite: "🛰️",
};

const STATUS_EMOJI: Record<string, string> = {
  green: "🟢",
  orange: "🟠",
  red: "🔴",
  unknown: "⚪",
};

// ── SlackPreview ──────────────────────────────────────────────────────────────

function SlackPreview({ report }: { report: SessionReport }) {
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
          <div className="report-preview-heading">Actions</div>
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

// ── ReportTab ─────────────────────────────────────────────────────────────────

export default function ReportTab() {
  const [report, setReport] = useState<SessionReport>(emptyReport());
  const [copiedSlack, setCopiedSlack] = useState(false);
  const [copiedJira, setCopiedJira] = useState(false);
  const reportRef = useRef(report);
  reportRef.current = report;

  async function fetchAndUpdate() {
    try {
      const [diagState, appState] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        invoke<any>("get_diagnostic_state"),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        invoke<any>("get_app_state"),
      ]);

      const actions = generateActions(diagState, appState);
      const networkRows = generateNetworkRows(diagState);
      const recommendedActions = generateRecommendedActions(diagState);

      setReport(prev => ({
        ...prev,
        sid: diagState.system?.sid ?? appState.controller_ip ?? "",
        version: diagState.system?.version ?? "",
        ip: appState.controller_ip ?? "",
        date: new Date().toISOString().slice(0, 10),
        generated: true,
        actions,
        networkRows,
        recommendedActions,
        // notes and networkNotes preserved from prev
      }));
    } catch (e) {
      console.error("Failed to generate report:", e);
    }
  }

  useEffect(() => {
    fetchAndUpdate();
    const id = setInterval(fetchAndUpdate, 5000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addAction() {
    setReport(r => ({
      ...r,
      actions: [...r.actions, { id: Date.now().toString(), text: "", dismissed: false }],
    }));
  }

  function addRec() {
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
    setReport(r => ({
      ...r,
      actions: r.actions.map(a => a.id === id ? { ...a, dismissed: true } : a),
    }));
  }

  function dismissRec(id: string) {
    setReport(r => ({
      ...r,
      recommendedActions: r.recommendedActions.map(a => a.id === id ? { ...a, dismissed: true } : a),
    }));
  }

  function updateActionText(id: string, text: string) {
    setReport(r => ({
      ...r,
      actions: r.actions.map(a => a.id === id ? { ...a, text } : a),
    }));
  }

  function updateRec(id: string, patch: Partial<ReportRecommendedAction>) {
    setReport(r => ({
      ...r,
      recommendedActions: r.recommendedActions.map(a => a.id === id ? { ...a, ...patch } : a),
    }));
  }

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
                <span className="report-section-label">⚡ ACTIONS</span>
                <button className="btn-link" onClick={addAction}>+ Add</button>
              </div>
              {report.actions.filter(a => !a.dismissed).length === 0 && (
                <div className="report-empty-section">No actions recorded. Add one above.</div>
              )}
              {report.actions.map(action => !action.dismissed && (
                <div key={action.id} className="report-action-row">
                  <span className="report-action-bullet">•</span>
                  <input
                    className="report-action-input"
                    type="text"
                    value={action.text}
                    placeholder="Describe action…"
                    onChange={e => updateActionText(action.id, e.target.value)}
                  />
                  <button className="report-dismiss-btn" onClick={() => dismissAction(action.id)}>✕</button>
                </div>
              ))}
            </div>

            {/* NETWORK STATUS */}
            <div className="report-card">
              <div className="report-section-header">
                <span className="report-section-label">🌐 NETWORK STATUS</span>
              </div>
              {report.networkRows.map(row => (
                <div
                  key={row.interface}
                  className={`report-network-block report-network-block-${row.status}`}
                >
                  <div className="report-network-row">
                    <div className={`report-status-dot report-status-dot-${row.status}`} />
                    <span className="report-network-iface">
                      {IFACE_ICON[row.interface]} {row.interface}
                    </span>
                    <span className="report-network-summary">{row.summary}</span>
                  </div>
                  <input
                    className="report-network-note"
                    type="text"
                    value={report.networkNotes[row.interface] ?? ""}
                    placeholder="Add note…"
                    onChange={e => setReport(r => ({
                      ...r,
                      networkNotes: { ...r.networkNotes, [row.interface]: e.target.value },
                    }))}
                  />
                </div>
              ))}
            </div>

            {/* RECOMMENDED ACTIONS */}
            <div className="report-card">
              <div className="report-section-header">
                <span className="report-section-label">🔧 RECOMMENDED ACTIONS</span>
                <button className="btn-link" onClick={addRec}>+ Add</button>
              </div>
              {report.recommendedActions.filter(a => !a.dismissed).length === 0 && (
                <div className="report-empty-section">
                  No recommended actions. Add one or re-run diagnostics.
                </div>
              )}
              {report.recommendedActions.map(action => !action.dismissed && (
                <div key={action.id} className="report-rec-row">
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
              <textarea
                className="report-notes"
                rows={3}
                placeholder="Add session notes, observations, or context…"
                value={report.notes}
                onChange={e => setReport(r => ({ ...r, notes: e.target.value }))}
              />
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
            <SlackPreview report={report} />
          </div>

        </div>
      )}

      {/* ── Footer ── */}
      {(
        <div className="report-footer">
          <button
            className="btn btn-secondary"
            onClick={() => {
              navigator.clipboard.writeText(formatSlack(report));
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
