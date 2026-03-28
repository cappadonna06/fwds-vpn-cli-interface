import { useState } from "react";

type LogSource = "vpn" | "ssh";

export default function LogsTab() {
  const [source, setSource] = useState<LogSource>("vpn");

  const placeholder =
    source === "vpn"
      ? "OpenVPN output will appear here when a VPN session is active."
      : "SSH session transcript will appear here when connected to a controller.";

  function copyDiagnostics() {
    const text = [
      "=== FWDS Controller Console Diagnostics ===",
      `Generated: ${new Date().toISOString()}`,
      "",
      "VPN Status: disconnected",
      "Controller Status: idle",
      "",
      "Recent Logs:",
      "(no active session)",
    ].join("\n");
    navigator.clipboard.writeText(text);
  }

  return (
    <div className="tab-content">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div className="log-source-tabs">
          <button
            className={`palette-tab ${source === "vpn" ? "active" : ""}`}
            onClick={() => setSource("vpn")}
          >
            OpenVPN
          </button>
          <button
            className={`palette-tab ${source === "ssh" ? "active" : ""}`}
            onClick={() => setSource("ssh")}
          >
            SSH Transcript
          </button>
        </div>
        <button className="btn btn-secondary" style={{ marginLeft: "auto" }} onClick={copyDiagnostics}>
          Copy Diagnostics
        </button>
      </div>

      <div className="log-pane" style={{ flex: 1 }}>
        <span className="log-info">{placeholder}</span>
      </div>
    </div>
  );
}
