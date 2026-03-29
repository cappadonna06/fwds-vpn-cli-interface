import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { COMMANDS, FAVORITE_COMMAND_IDS, ControllerCommand, CommandCategory } from "../../types/commands";

type CommandPaletteTab = "favorites" | "common" | "all";

const COMMON_CATEGORIES: CommandCategory[] = ["diagnostic", "info"];

function categoryLabel(cat: CommandCategory): string {
  return { config: "Config", diagnostic: "Diagnostic", info: "Info", system: "System" }[cat];
}

interface LogLine {
  id: number;
  text: string;
  // input  = command echo / wizard answer  (accent colour, "> " prefix for wizard answers)
  // output = regular shell output          (muted)
  // wizard = interactive prompt waiting    (muted, slightly different visual)
  // error  = ssh/app errors               (red)
  // info   = app messages                 (muted italic)
  type: "input" | "output" | "wizard" | "error" | "info";
}

interface ControllerPoll { phase: string; detail: string; new_lines: string[]; }

export default function ConsoleTab() {
  const [input, setInput] = useState("");
  const [log, setLog] = useState<LogLine[]>([
    { id: 0, text: "Connect to a controller in the Session tab, then run commands here.", type: "info" },
  ]);
  const [ctrlPhase, setCtrlPhase] = useState("disconnected");
  const ctrlPhaseRef = useRef("disconnected");
  // Tracks an input we've already echoed locally so we can skip the SSH round-trip echo.
  const pendingEchoRef = useRef<string | null>(null);
  const [paletteTab, setPaletteTab] = useState<CommandPaletteTab>("favorites");
  const [search, setSearch] = useState("");
  const [confirmCommand, setConfirmCommand] = useState<ControllerCommand | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(1);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  // Always poll — picks up connection state whenever it changes,
  // regardless of when the tab was mounted relative to the connection.
  useEffect(() => {
    pollOutput();
    const id = setInterval(pollOutput, 600);
    return () => clearInterval(id);
  }, []);

  async function pollOutput() {
    try {
      const r = await invoke<ControllerPoll>("poll_controller");
      if (r.phase !== ctrlPhaseRef.current) {
        ctrlPhaseRef.current = r.phase;
        setCtrlPhase(r.phase);
      }
      if (r.new_lines.length > 0) {
        setLog((prev) => {
          const newEntries = r.new_lines.flatMap((raw) => {
            if (raw.startsWith("\x01")) {
              const text = raw.slice(1);
              // Skip SSH echo if we already showed this input locally.
              if (pendingEchoRef.current === text) {
                pendingEchoRef.current = null;
                return [];
              }
              return [{ id: idRef.current++, text, type: "input" as const }];
            }
            if (raw.startsWith("\x02")) return [{ id: idRef.current++, text: raw.slice(1), type: "wizard" as const }];
            return [{ id: idRef.current++, text: raw, type: "output" as const }];
          });
          return newEntries.length > 0 ? [...prev, ...newEntries] : prev;
        });
      }
    } catch { /* ignore */ }
  }

  function addLine(text: string, type: LogLine["type"]) {
    setLog((prev) => [...prev, { id: idRef.current++, text, type }]);
  }

  async function sendCommand(cmd: string) {
    if (!cmd.trim()) return;
    setInput("");
    // Immediately echo the command locally so the user sees it without waiting
    // for the SSH round-trip. The SSH echo (prefixed \x01) will be deduped.
    addLine(cmd, "input");
    pendingEchoRef.current = cmd;
    try {
      await invoke("send_input", { text: cmd });
    } catch (e) {
      pendingEchoRef.current = null;
      addLine(`Error: ${String(e)}`, "error");
    }
  }

  async function sendInterrupt() {
    try {
      await invoke("send_interrupt");
    } catch { /* ignore if no shell */ }
  }

  function handlePreset(cmd: ControllerCommand) {
    if (cmd.guard === "hard" || cmd.guard === "confirm") {
      setConfirmCommand(cmd);
    } else {
      sendCommand(cmd.command);
    }
  }

  function confirmAndSend() {
    if (confirmCommand) {
      sendCommand(confirmCommand.command);
      setConfirmCommand(null);
    }
  }

  function filteredCommands(): ControllerCommand[] {
    let cmds = COMMANDS;
    if (paletteTab === "favorites") {
      cmds = COMMANDS.filter((c) => FAVORITE_COMMAND_IDS.includes(c.id));
    } else if (paletteTab === "common") {
      cmds = COMMANDS.filter((c) => COMMON_CATEGORIES.includes(c.category));
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      cmds = cmds.filter(
        (c) => c.command.includes(q) || c.description.toLowerCase().includes(q)
      );
    }
    return cmds;
  }

  const displayed = filteredCommands();

  // Detect when the controller is waiting for input (last output line is a prompt)
  const lastLine = log[log.length - 1];
  const waitingForInput =
    ctrlPhase === "connected" &&
    (
      lastLine?.type === "wizard" ||
      (lastLine?.type === "output" && /[:#>$] $/.test(lastLine.text))
    );

  // Group by category for "all" tab
  const grouped: Partial<Record<CommandCategory, ControllerCommand[]>> = {};
  if (paletteTab === "all" && !search.trim()) {
    for (const cmd of displayed) {
      grouped[cmd.category] = [...(grouped[cmd.category] ?? []), cmd];
    }
  }

  return (
    <div className="tab-content split" style={{ gap: 0 }}>
      {/* Left — output + input */}
      <div className="console-main">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span className={`badge badge-${ctrlPhase === "connected" ? "connected" : ctrlPhase === "connecting" ? "connecting" : ctrlPhase === "failed" ? "failed" : "disconnected"}`}>
            {ctrlPhase === "connected" ? "Shell connected" : ctrlPhase === "connecting" ? "Connecting…" : ctrlPhase === "failed" ? "Failed" : "Not connected"}
          </span>
          {waitingForInput && (
            <span className="hint-inline" style={{ color: "var(--accent)" }}>
              Waiting for input ↓
            </span>
          )}
        </div>
        <div className="log-pane console-log">
          {log.map((line, i) => {
            const prevType = i > 0 ? log[i - 1].type : null;
            const isWizardAnswer = line.type === "input" && prevType === "wizard";
            return (
              <div key={line.id} className={`log-line log-${line.type}`}>
                {isWizardAnswer ? `> ${line.text}` : line.text}
              </div>
            );
          })}
          <div ref={logEndRef} />
        </div>
        <div className="console-input-row">
          <span className="console-prompt">$</span>
          <input
            className="console-input"
            type="text"
            value={input}
            placeholder={waitingForInput ? "Type response and press Enter…" : "Enter command…"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") sendCommand(input);
              if (e.key === "c" && e.ctrlKey) {
                e.preventDefault();
                sendInterrupt();
              }
            }}
            autoFocus
          />
          <button
            className="btn btn-secondary"
            title="Send Ctrl+C (interrupt)"
            onClick={sendInterrupt}
            style={{ fontFamily: "var(--mono)", fontSize: 11, padding: "4px 8px" }}
          >
            ⌃C
          </button>
          <button
            className="btn btn-primary"
            disabled={!input.trim()}
            onClick={() => sendCommand(input)}
          >
            Send
          </button>
        </div>
      </div>

      {/* Right — command palette */}
      <div className="console-palette">
        <div className="palette-header">
          <div className="palette-tabs">
            {(["favorites", "common", "all"] as CommandPaletteTab[]).map((t) => (
              <button
                key={t}
                className={`palette-tab ${paletteTab === t ? "active" : ""}`}
                onClick={() => setPaletteTab(t)}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          <input
            className="palette-search"
            type="text"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="palette-list">
          {paletteTab === "all" && !search.trim()
            ? (["config", "diagnostic", "info", "system"] as CommandCategory[]).map((cat) =>
                grouped[cat]?.length ? (
                  <div key={cat} className="palette-group">
                    <div className="palette-group-label">{categoryLabel(cat)}</div>
                    {grouped[cat]!.map((cmd) => (
                      <CommandButton key={cmd.id} cmd={cmd} onRun={handlePreset} />
                    ))}
                  </div>
                ) : null
              )
            : displayed.map((cmd) => (
                <CommandButton key={cmd.id} cmd={cmd} onRun={handlePreset} />
              ))}
          {displayed.length === 0 && (
            <div className="palette-empty">No commands match.</div>
          )}
        </div>
      </div>

      {/* Confirm modal */}
      {confirmCommand && (
        <div className="modal-overlay" onClick={() => setConfirmCommand(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">
              {confirmCommand.guard === "hard" ? "Warning" : "Confirm"}
            </div>
            <div className="modal-body">{confirmCommand.guard_message}</div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setConfirmCommand(null)}>
                Cancel
              </button>
              <button
                className={`btn ${confirmCommand.destructive ? "btn-danger" : "btn-primary"}`}
                onClick={confirmAndSend}
              >
                Run {confirmCommand.command}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CommandButton({ cmd, onRun }: { cmd: ControllerCommand; onRun: (c: ControllerCommand) => void }) {
  return (
    <button className={`cmd-btn ${cmd.destructive ? "cmd-btn-destructive" : ""}`} onClick={() => onRun(cmd)}>
      <div className="cmd-btn-top">
        <code className="cmd-name">{cmd.label}</code>
        {cmd.reboot_required && <span className="cmd-tag">reboot</span>}
        {cmd.destructive && <span className="cmd-tag cmd-tag-danger">destructive</span>}
      </div>
      <div className="cmd-desc">{cmd.description}</div>
    </button>
  );
}
