import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ACTION_PRESETS,
  DIAGNOSTIC_PRESETS,
  RECOMMENDATION_PRESETS,
  buildAutoSessionReport,
  buildJiraSummary,
  buildSlackSummary,
  ReportAppState,
  ReportLine,
  ReportSection,
  ReportSectionKey,
  SessionReport,
} from "../../lib/sessionReport";

type DiagnosticState = ReportAppState & {
  session_has_data?: boolean;
};

type ReportEditorState = {
  sid?: string;
  timestamp?: string;
  firmware?: string;
  zones?: number;
  actions: ReportLine[];
  diagnostics: ReportLine[];
  recommendations: ReportLine[];
};

const SECTION_TITLES: Record<ReportSectionKey, string> = {
  actions: "Actions",
  diagnostics: "Network Diagnostics",
  recommendations: "Recommended Actions / Follow-ups",
};

function makeReport(editor: ReportEditorState): SessionReport {
  const section = (key: ReportSectionKey): ReportSection => ({
    key,
    title: SECTION_TITLES[key],
    lines: editor[key],
  });

  return {
    sid: editor.sid,
    timestamp: editor.timestamp,
    firmware: editor.firmware,
    zones: editor.zones,
    actions: section("actions"),
    diagnostics: section("diagnostics"),
    recommendations: section("recommendations"),
  };
}

function toEditorState(report: SessionReport): ReportEditorState {
  return {
    sid: report.sid,
    timestamp: report.timestamp,
    firmware: report.firmware,
    zones: report.zones,
    actions: report.actions.lines,
    diagnostics: report.diagnostics.lines,
    recommendations: report.recommendations.lines,
  };
}

function createLineId(section: ReportSectionKey): string {
  return `${section}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function dedupeLines(lines: ReportLine[]): ReportLine[] {
  const seen = new Set<string>();
  return lines.filter((entry) => {
    const key = entry.text.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sectionPresets(key: ReportSectionKey): readonly string[] {
  if (key === "actions") return ACTION_PRESETS;
  if (key === "diagnostics") return DIAGNOSTIC_PRESETS;
  return RECOMMENDATION_PRESETS;
}

export default function LogsTab() {
  const [diag, setDiag] = useState<DiagnosticState | null>(null);
  const [editor, setEditor] = useState<ReportEditorState | null>(null);
  const [dirty, setDirty] = useState<Record<ReportSectionKey, boolean>>({
    actions: false,
    diagnostics: false,
    recommendations: false,
  });
  const [selectedPreset, setSelectedPreset] = useState<Record<ReportSectionKey, string>>({
    actions: ACTION_PRESETS[0],
    diagnostics: DIAGNOSTIC_PRESETS[0],
    recommendations: RECOMMENDATION_PRESETS[0],
  });
  const [customInput, setCustomInput] = useState<Record<ReportSectionKey, string>>({
    actions: "",
    diagnostics: "",
    recommendations: "",
  });
  const [copyState, setCopyState] = useState<"idle" | "slack" | "jira">("idle");

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const state = await invoke<DiagnosticState>("get_diagnostic_state");
        setDiag(state);
      } catch {
        // best effort polling
      }
    }, 2000);

    invoke<DiagnosticState>("get_diagnostic_state").then(setDiag).catch(() => {});

    return () => clearInterval(id);
  }, []);

  const autoReport = useMemo(() => buildAutoSessionReport(diag ?? {}), [diag]);

  useEffect(() => {
    setEditor((prev) => {
      if (!prev) return toEditorState(autoReport);
      return {
        ...prev,
        sid: autoReport.sid,
        timestamp: autoReport.timestamp,
        firmware: autoReport.firmware,
        zones: autoReport.zones,
        actions: dirty.actions ? prev.actions : autoReport.actions.lines,
        diagnostics: dirty.diagnostics ? prev.diagnostics : autoReport.diagnostics.lines,
        recommendations: dirty.recommendations ? prev.recommendations : autoReport.recommendations.lines,
      };
    });
  }, [autoReport, dirty.actions, dirty.diagnostics, dirty.recommendations]);

  function updateSection(key: ReportSectionKey, nextLines: ReportLine[]) {
    setEditor((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        [key]: dedupeLines(nextLines),
      };
    });
    setDirty((prev) => ({ ...prev, [key]: true }));
  }

  function handleEditLine(section: ReportSectionKey, id: string, text: string) {
    if (!editor) return;
    const nextLines = editor[section].map((line) => (line.id === id ? { ...line, text } : line));
    updateSection(section, nextLines);
  }

  function handleDeleteLine(section: ReportSectionKey, id: string) {
    if (!editor) return;
    updateSection(
      section,
      editor[section].filter((line) => line.id !== id),
    );
  }

  function addLine(section: ReportSectionKey, text: string, source: ReportLine["source"]) {
    if (!editor) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    if (editor[section].some((line) => line.text.trim().toLowerCase() === trimmed.toLowerCase())) {
      return;
    }
    updateSection(section, [
      ...editor[section],
      {
        id: createLineId(section),
        text: trimmed,
        source,
      },
    ]);
  }

  function resetSection(section: ReportSectionKey) {
    setEditor((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        [section]: autoReport[section].lines,
      };
    });
    setDirty((prev) => ({ ...prev, [section]: false }));
  }

  function resetAll() {
    setEditor(toEditorState(autoReport));
    setDirty({ actions: false, diagnostics: false, recommendations: false });
  }

  async function copySummary(kind: "slack" | "jira") {
    if (!editor) return;
    const report = makeReport(editor);
    const payload = kind === "slack" ? buildSlackSummary(report) : buildJiraSummary(report);
    await navigator.clipboard.writeText(payload).catch(() => {});
    setCopyState(kind);
    setTimeout(() => setCopyState("idle"), 1400);
  }

  if (!editor) {
    return (
      <section className="tab-content report-page">
        <div className="report-loading">Loading session report…</div>
      </section>
    );
  }

  const displayTimestamp = editor.timestamp ? new Date(editor.timestamp).toLocaleString() : "—";

  return (
    <section className="tab-content report-page">
      <header className="report-header">
        <div>
          <h2>Session Report</h2>
          <div className="report-subtitle">{editor.sid ? `SID ${editor.sid}` : "No SID available"}</div>
          <div className="report-subtitle">Last updated {displayTimestamp}</div>
        </div>
        <div className="report-export-row">
          <button className="btn btn-secondary" onClick={() => copySummary("slack")}> 
            {copyState === "slack" ? "Slack Summary Copied" : "Copy Slack Summary"}
          </button>
          <button className="btn btn-secondary" onClick={() => copySummary("jira")}> 
            {copyState === "jira" ? "Jira Summary Copied" : "Copy Jira Summary"}
          </button>
          <button className="btn" onClick={resetAll}>Reset All to Auto</button>
        </div>
      </header>

      {(["actions", "diagnostics", "recommendations"] as ReportSectionKey[]).map((section) => (
        <article className="report-card" key={section}>
          <div className="report-card-header">
            <h3>{SECTION_TITLES[section]}</h3>
            <button className="btn btn-secondary" onClick={() => resetSection(section)}>Reset section</button>
          </div>

          <div className="report-lines">
            {editor[section].length === 0 && <div className="report-empty">No {section} captured yet.</div>}
            {editor[section].map((entry) => (
              <div className="report-line" key={entry.id}>
                <input
                  className="report-line-input"
                  value={entry.text}
                  onChange={(event) => handleEditLine(section, entry.id, event.target.value)}
                />
                <button className="btn btn-secondary" onClick={() => handleDeleteLine(section, entry.id)}>
                  Delete
                </button>
              </div>
            ))}
          </div>

          <div className="report-add-row">
            <select
              className="report-select"
              value={selectedPreset[section]}
              onChange={(event) => setSelectedPreset((prev) => ({ ...prev, [section]: event.target.value }))}
            >
              {sectionPresets(section).map((preset) => (
                <option key={preset} value={preset}>{preset}</option>
              ))}
            </select>
            <button
              className="btn btn-secondary"
              onClick={() => addLine(section, selectedPreset[section], "preset")}
            >
              Add preset
            </button>
          </div>

          <div className="report-add-row">
            <input
              className="report-line-input"
              placeholder="Add custom line"
              value={customInput[section]}
              onChange={(event) => setCustomInput((prev) => ({ ...prev, [section]: event.target.value }))}
            />
            <button
              className="btn btn-secondary"
              onClick={() => {
                addLine(section, customInput[section], "manual");
                setCustomInput((prev) => ({ ...prev, [section]: "" }));
              }}
            >
              Add custom
            </button>
          </div>
        </article>
      ))}

      {!diag?.session_has_data && <div className="report-footnote">No diagnostics detected yet — you can still build this report manually.</div>}
    </section>
  );
}
