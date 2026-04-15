import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface ControllerPoll {
  phase: string;
  detail: string;
  new_lines: string[];
}

interface LogLine {
  id: number;
  text: string;
  type: "input" | "output" | "wizard" | "error" | "debug";
}

export default function ControllerTerminalWindow() {
  const [log, setLog] = useState<LogLine[]>([]);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState("disconnected");
  const [detail, setDetail] = useState("");
  const [pendingEcho, setPendingEcho] = useState<string | null>(null);
  const idRef = useRef(1);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = setInterval(pollOutput, 400);
    pollOutput();
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  async function pollOutput() {
    try {
      const r = await invoke<ControllerPoll>("poll_controller");
      setPhase(r.phase);
      setDetail(r.detail);
      if (!r.new_lines.length) return;

      setLog((prev) => {
        const entries: LogLine[] = [];
        for (const raw of r.new_lines) {
          if (raw.startsWith("\x01")) {
            const text = raw.slice(1);
            if (pendingEcho && text === pendingEcho) {
              setPendingEcho(null);
              continue;
            }
            entries.push({ id: idRef.current++, text, type: "input" });
            continue;
          }
          if (raw.startsWith("\x02")) {
            entries.push({ id: idRef.current++, text: raw.slice(1), type: "wizard" });
            continue;
          }
          if (raw.startsWith("\x03")) {
            entries.push({ id: idRef.current++, text: raw.slice(1), type: "debug" });
            continue;
          }
          entries.push({ id: idRef.current++, text: raw, type: "output" });
        }
        return entries.length ? [...prev, ...entries] : prev;
      });
    } catch {
      // ignore
    }
  }

  async function send() {
    const canEmpty = input.length === 0;
    if (!canEmpty && !input.trim()) return;
    const value = input;
    setInput("");
    if (value.trim()) {
      setPendingEcho(value);
      setLog((prev) => [...prev, { id: idRef.current++, text: value, type: "input" }]);
    }
    try {
      await invoke("send_external_input", { text: value });
    } catch (e) {
      setLog((prev) => [...prev, { id: idRef.current++, text: `Error: ${String(e)}`, type: "error" }]);
      setPendingEcho(null);
    }
  }

  async function sendInterrupt() {
    await invoke("send_interrupt").catch(() => {});
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#0b1020", color: "#e5e7eb", fontFamily: "Inter, sans-serif" }}>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid #1f2937", display: "flex", alignItems: "center", gap: 10 }}>
        <strong>Controller Terminal</strong>
        <span style={{ fontSize: 12, opacity: 0.85 }}>
          {phase === "connected" ? "Connected" : phase === "connecting" ? "Connecting…" : phase === "failed" ? "Failed" : "Disconnected"}
          {detail ? ` — ${detail}` : ""}
        </span>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13 }}>
        {log.length === 0 && <div style={{ opacity: 0.7 }}>Waiting for controller output…</div>}
        {log.map((line) => (
          <div
            key={line.id}
            style={{
              whiteSpace: "pre-wrap",
              lineHeight: 1.35,
              color:
                line.type === "error" ? "#fca5a5" :
                line.type === "input" ? "#93c5fd" :
                line.type === "wizard" ? "#fcd34d" :
                line.type === "debug" ? "#f59e0b" :
                "#e5e7eb",
            }}
          >
            {line.type === "input" ? `> ${line.text}` : line.text}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div style={{ borderTop: "1px solid #1f2937", padding: 10, display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
            if (e.key === "c" && e.ctrlKey) {
              e.preventDefault();
              sendInterrupt();
            }
          }}
          placeholder="Type command and press Enter"
          style={{ flex: 1, borderRadius: 6, border: "1px solid #374151", background: "#111827", color: "#f9fafb", padding: "8px 10px" }}
        />
        <button onClick={sendInterrupt} style={{ padding: "8px 10px" }}>Ctrl+C</button>
        <button onClick={send} style={{ padding: "8px 14px" }}>Send</button>
      </div>
    </div>
  );
}
