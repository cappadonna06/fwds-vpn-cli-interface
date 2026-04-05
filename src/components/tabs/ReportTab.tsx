import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  SessionReport,
  emptyReport,
} from "../../types/report";
import {
  generateActions,
  generateNetworkRows,
  generateRecommendedActions,
  formatSlack,
  formatJira,
} from "../../lib/generateReport";

export default function ReportTab() {
  const [report, setReport] = useState<SessionReport>(emptyReport());
  const [copiedSlack, setCopiedSlack] = useState(false);
  const [copiedJira, setCopiedJira] = useState(false);

  async function handleGenerate() {
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
        // notes and networkNotes preserved from prev on Regenerate
      }));
    } catch (e) {
      console.error("Failed to generate report:", e);
    }
  }

  return (
    <div className="report-page">

      {/* ── Header ── */}
      <div className="report-header">
        <div className="report-header-left">
          <span className="report-title">Session Report</span>
          {report.generated && (
            <span className="report-meta">
              {[report.sid, report.version, report.ip, report.date]
                .filter(Boolean).join(" · ")}
            </span>
          )}
        </div>
        <div className="report-header-actions">
          <button className="btn btn-secondary" onClick={() => setReport(emptyReport())}>
            Clear
          </button>
          <button className="btn btn-primary" onClick={handleGenerate}>
            {report.generated ? "Regenerate" : "Generate"}
          </button>
        </div>
      </div>

      {/* ── Empty state ── */}
      {!report.generated && (
        <div className="report-empty">
          <p>No report generated yet.</p>
          <p className="report-empty-sub">
            Run diagnostics, then press Generate to create a session report.
          </p>
          <button className="btn btn-primary" onClick={handleGenerate}>
            Generate Report
          </button>
        </div>
      )}

      {/* ── Report body ── */}
      {report.generated && (
        <div className="report-body">

          {/* ACTIONS */}
          <div className="report-section">
            <div className="report-section-header">
              <span className="report-section-label">ACTIONS</span>
              <button
                className="btn-link"
                onClick={() => setReport(r => ({
                  ...r,
                  actions: [...r.actions, {
                    id: Date.now().toString(),
                    text: "",
                    dismissed: false,
                  }],
                }))}
              >
                + Add
              </button>
            </div>

            {report.actions.filter(a => !a.dismissed).length === 0 && (
              <div className="report-empty-section">No actions recorded. Add one above.</div>
            )}

            {report.actions.map(action => (
              !action.dismissed && (
                <div key={action.id} className="report-action-row">
                  <span className="report-action-bullet">•</span>
                  <input
                    className="report-action-input"
                    type="text"
                    value={action.text}
                    placeholder="Describe action…"
                    onChange={e => setReport(r => ({
                      ...r,
                      actions: r.actions.map(a =>
                        a.id === action.id ? { ...a, text: e.target.value } : a
                      ),
                    }))}
                  />
                  <button
                    className="report-dismiss-btn"
                    onClick={() => setReport(r => ({
                      ...r,
                      actions: r.actions.map(a =>
                        a.id === action.id ? { ...a, dismissed: true } : a
                      ),
                    }))}
                  >✕</button>
                </div>
              )
            ))}
          </div>

          {/* NETWORK STATUS */}
          <div className="report-section">
            <div className="report-section-header">
              <span className="report-section-label">NETWORK STATUS</span>
            </div>

            {report.networkRows.map(row => (
              <div key={row.interface} className="report-network-block">
                <div className="report-network-row">
                  <div className={`report-status-dot report-status-dot-${row.status}`} />
                  <span className="report-network-iface">{row.interface}</span>
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
          <div className="report-section">
            <div className="report-section-header">
              <span className="report-section-label">RECOMMENDED ACTIONS</span>
              <button
                className="btn-link"
                onClick={() => setReport(r => ({
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
                }))}
              >
                + Add
              </button>
            </div>

            {report.recommendedActions.filter(a => !a.dismissed).length === 0 && (
              <div className="report-empty-section">
                No recommended actions. Add one or re-run diagnostics.
              </div>
            )}

            {report.recommendedActions.map(action => (
              !action.dismissed && (
                <div key={action.id} className="report-rec-row">
                  <input
                    type="checkbox"
                    className="report-rec-check"
                    checked={action.checked}
                    onChange={e => setReport(r => ({
                      ...r,
                      recommendedActions: r.recommendedActions.map(a =>
                        a.id === action.id ? { ...a, checked: e.target.checked } : a
                      ),
                    }))}
                  />
                  <div className="report-rec-content">
                    {!action.custom && (
                      <span className="report-rec-iface">{action.interface} —</span>
                    )}
                    <input
                      className="report-rec-input"
                      type="text"
                      value={action.text}
                      placeholder="Action…"
                      onChange={e => setReport(r => ({
                        ...r,
                        recommendedActions: r.recommendedActions.map(a =>
                          a.id === action.id ? { ...a, text: e.target.value } : a
                        ),
                      }))}
                    />
                    {action.detail && (
                      <div className="report-rec-detail">{action.detail}</div>
                    )}
                  </div>
                  <button
                    className="report-dismiss-btn"
                    onClick={() => setReport(r => ({
                      ...r,
                      recommendedActions: r.recommendedActions.map(a =>
                        a.id === action.id ? { ...a, dismissed: true } : a
                      ),
                    }))}
                  >✕</button>
                </div>
              )
            ))}
          </div>

          {/* NOTES */}
          <div className="report-section">
            <div className="report-section-header">
              <span className="report-section-label">NOTES</span>
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
          <div className="report-section">
            <div className="report-section-header">
              <span className="report-section-label">OUTCOME</span>
            </div>
            <div className="report-outcome-row">
              {(["complete", "escalated", "followup"] as const).map(o => (
                <label key={o} className="report-outcome-label">
                  <input
                    type="radio"
                    name="outcome"
                    checked={report.outcome === o}
                    onChange={() => setReport(r => ({ ...r, outcome: o }))}
                  />
                  {o === "complete" ? "Complete"
                    : o === "escalated" ? "Escalated"
                    : "Follow-up needed"}
                </label>
              ))}
            </div>
          </div>

        </div>
      )}

      {/* ── Footer ── */}
      {report.generated && (
        <div className="report-footer">
          <button
            className="btn btn-secondary"
            onClick={() => {
              navigator.clipboard.writeText(formatSlack(report));
              setCopiedSlack(true);
              setTimeout(() => setCopiedSlack(false), 1500);
            }}
          >
            {copiedSlack ? "✓ Copied" : "Copy Slack"}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => {
              navigator.clipboard.writeText(formatJira(report));
              setCopiedJira(true);
              setTimeout(() => setCopiedJira(false), 1500);
            }}
          >
            {copiedJira ? "✓ Copied" : "Copy Jira"}
          </button>
        </div>
      )}
    </div>
  );
}
