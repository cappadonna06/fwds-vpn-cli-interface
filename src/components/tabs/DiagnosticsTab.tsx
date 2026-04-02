import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

// ── Types ─────────────────────────────────────────────────────────────────────

type DiagStatus = "green" | "orange" | "red" | "unknown";

interface WifiDiagnostic {
  status: DiagStatus;
  summary: string;
  ssid: string;
  strength: number;
  strength_label: string;
  signal_dbm: number | null;
  ipv4: boolean;
  ipv6: boolean;
  dns_servers: string;
  internet_reachable: boolean;
  check_result: string;
  avg_latency_ms: number | null;
  packet_loss_pct: number;
}

interface CellularDiagnostic {
  status: DiagStatus;
  summary: string;
  provider: string;
  provider_code: string;
  strength: number;
  strength_label: string;
  ipv4: boolean;
  ipv6: boolean;
  dns_servers: string;
  internet_reachable: boolean;
  check_result: string;
  avg_latency_ms: number | null;
  packet_loss_pct: number;
  imei: string | null;
  iccid: string | null;
  apn: string | null;
  cell_status: string | null;
}

interface SatelliteDiagnostic {
  status: DiagStatus;
  summary: string;
  enabled: boolean;
  loopback_passed: boolean | null;
  loopback_time_secs: number | null;
  imei: string | null;
}

interface EthernetDiagnostic {
  status: DiagStatus;
  summary: string;
  check_result: string;
  check_error: string | null;
  internet_reachable: boolean;
  eth_state: string;
  ipv4: boolean;
  ipv6: boolean;
  dns_servers: string;
  check_avg_latency_ms: number | null;
  check_packet_loss_pct: number;
  link_detected: boolean | null;
  speed: string | null;
  duplex: string | null;
  auto_negotiation: boolean | null;
  carrier: boolean | null;
  operstate: string | null;
  no_carrier_flag: boolean | null;
  lower_up_flag: boolean | null;
  link_state: string | null;
  mac_address: string | null;
  ipv4_address: string | null;
  ipv4_prefix: number | null;
  default_via_eth0: boolean | null;
  default_gateway: string | null;
  connman_eth_powered: boolean | null;
  connman_eth_connected: boolean | null;
  connman_wifi_connected: boolean | null;
  connman_cell_connected: boolean | null;
  connman_active_service: string | null;
  connman_eth_active: boolean | null;
  connman_state: string | null;
  dmesg_link_events: string[];
  flap_count: number;
  hw_tx_packets: number | null;
  hw_rx_packets: number | null;
  hw_rx_crc_errors: number | null;
  hw_rx_align_errors: number | null;
  proc_rx_bytes: number | null;
  proc_rx_packets: number | null;
  proc_rx_errs: number | null;
  proc_rx_drop: number | null;
  proc_tx_bytes: number | null;
  proc_tx_packets: number | null;
  proc_tx_errs: number | null;
}

interface SystemDiagnostic {
  sid: string | null;
  version: string | null;
  release_date: string | null;
}

interface DiagnosticState {
  wifi: WifiDiagnostic | null;
  cellular: CellularDiagnostic | null;
  satellite: SatelliteDiagnostic | null;
  ethernet: EthernetDiagnostic | null;
  system: SystemDiagnostic | null;
  last_updated: string | null;
}

// ── DiagCard ──────────────────────────────────────────────────────────────────

interface DiagCardRow {
  label: string;
  value: string;
}

interface DiagCardProps {
  title: string;
  icon: string;
  status: DiagStatus;
  summary: string;
  rows: DiagCardRow[];
  loading?: boolean;
}

function statusLabel(status: DiagStatus): string {
  switch (status) {
    case "green": return "Connected";
    case "orange": return "Degraded";
    case "red": return "Offline";
    case "unknown": return "No data yet";
  }
}

function DiagCard({ title, icon, status, summary, rows, loading }: DiagCardProps) {
  const isUnknown = status === "unknown";
  return (
    <div className={`diag-card${isUnknown ? " diag-card-unknown" : ""}`}>
      <div className="diag-card-header">
        <span className="diag-card-icon">{icon}</span>
        <span className="diag-card-title">{title}</span>
        <span className={`diag-status-dot ${status}`} />
      </div>
      <div className="diag-card-status">{statusLabel(status)}</div>
      {!isUnknown && <div className="diag-card-summary">{summary}</div>}
      {isUnknown && (
        <div className="diag-card-summary diag-card-no-data">
          {loading ? "Loading…" : "Run diagnostics in the terminal to populate"}
        </div>
      )}
      {!isUnknown && rows.length > 0 && (
        <>
          <hr className="diag-card-divider" />
          <div className="diag-card-rows">
            {rows.map((row) => (
              <div key={row.label} className="diag-row">
                <span className="diag-row-label">{row.label}</span>
                <span className="diag-row-value">{row.value}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Row builders ──────────────────────────────────────────────────────────────

function yesNo(b: boolean): string {
  return b ? "Yes" : "No";
}

function dash(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

function buildWifiRows(w: WifiDiagnostic): DiagCardRow[] {
  const rows: DiagCardRow[] = [
    { label: "SSID", value: dash(w.ssid) },
    { label: "Signal", value: `${w.strength}/100 (${w.strength_label})` },
  ];
  if (w.signal_dbm !== null) {
    rows.push({ label: "Signal (dBm)", value: `${w.signal_dbm} dBm` });
  }
  rows.push(
    { label: "IPv4", value: yesNo(w.ipv4) },
    { label: "IPv6", value: yesNo(w.ipv6) },
    { label: "DNS", value: dash(w.dns_servers) },
  );
  if (w.avg_latency_ms !== null) {
    rows.push({ label: "Latency (avg)", value: `${w.avg_latency_ms.toFixed(1)} ms` });
  }
  rows.push(
    { label: "Packet loss", value: `${w.packet_loss_pct}%` },
    { label: "Check result", value: dash(w.check_result) },
  );
  return rows;
}

function buildCellularRows(c: CellularDiagnostic): DiagCardRow[] {
  const rows: DiagCardRow[] = [
    { label: "Provider", value: `${c.provider} (${c.provider_code})` },
    { label: "Signal", value: `${c.strength}/100 (${c.strength_label})` },
    { label: "IPv4", value: yesNo(c.ipv4) },
    { label: "IPv6", value: yesNo(c.ipv6) },
    { label: "DNS", value: dash(c.dns_servers) },
  ];
  if (c.avg_latency_ms !== null) {
    rows.push({ label: "Latency (avg)", value: `${c.avg_latency_ms.toFixed(1)} ms` });
  }
  rows.push({ label: "Packet loss", value: `${c.packet_loss_pct}%` });
  if (c.imei !== null) rows.push({ label: "IMEI", value: dash(c.imei) });
  if (c.iccid !== null) rows.push({ label: "ICCID", value: dash(c.iccid) });
  if (c.apn !== null) rows.push({ label: "APN", value: dash(c.apn) });
  if (c.cell_status !== null) rows.push({ label: "Status", value: dash(c.cell_status) });
  rows.push({ label: "Check result", value: dash(c.check_result) });
  return rows;
}

function buildSatelliteRows(s: SatelliteDiagnostic): DiagCardRow[] {
  const rows: DiagCardRow[] = [
    { label: "Enabled", value: yesNo(s.enabled) },
    {
      label: "Loopback",
      value: s.loopback_passed === null ? "Not run" : s.loopback_passed ? "Passed" : "Failed",
    },
  ];
  if (s.loopback_passed && s.loopback_time_secs !== null) {
    const mins = Math.floor(s.loopback_time_secs / 60);
    const secs = Math.floor(s.loopback_time_secs % 60);
    rows.push({ label: "Loopback time", value: `${mins}m ${secs}s` });
  }
  if (s.imei !== null) rows.push({ label: "IMEI", value: dash(s.imei) });
  return rows;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildEthernetRows(e: EthernetDiagnostic): DiagCardRow[] {
  const rows: DiagCardRow[] = [];

  // Check result
  rows.push({ label: "Check result", value: dash(e.check_result) });
  if (e.check_error) rows.push({ label: "Error", value: e.check_error });
  rows.push({ label: "Internet", value: e.internet_reachable ? "Online" : "Offline" });
  rows.push({ label: "State", value: dash(e.eth_state) });

  // Link / PHY
  if (e.link_detected !== null) rows.push({ label: "Link detected", value: yesNo(e.link_detected) });
  if (e.carrier !== null) rows.push({ label: "Carrier", value: e.carrier ? "Yes (1)" : "No (0)" });
  if (e.operstate !== null) rows.push({ label: "Operstate", value: e.operstate });
  if (e.speed !== null) rows.push({ label: "Speed", value: e.speed });
  if (e.duplex !== null) rows.push({ label: "Duplex", value: e.duplex });

  // Interface
  if (e.ipv4_address !== null) {
    rows.push({ label: "IP address", value: `${e.ipv4_address}${e.ipv4_prefix !== null ? `/${e.ipv4_prefix}` : ""}` });
  }
  rows.push({ label: "IPv4", value: yesNo(e.ipv4) });
  rows.push({ label: "IPv6", value: yesNo(e.ipv6) });
  if (e.mac_address !== null) rows.push({ label: "MAC", value: e.mac_address });

  // Routing
  if (e.default_gateway !== null) {
    rows.push({
      label: "Default route",
      value: e.default_via_eth0 ? `${e.default_gateway} via eth0 ✓` : `${e.default_gateway} (not eth0)`,
    });
  }

  // ConnMan
  if (e.connman_eth_connected !== null || e.connman_eth_powered !== null) {
    const v = e.connman_eth_connected
      ? "Connected"
      : e.connman_eth_powered
        ? "Powered, not connected"
        : "Off";
    rows.push({ label: "ConnMan eth", value: v });
  }
  if (e.connman_active_service !== null) rows.push({ label: "Active service", value: e.connman_active_service });
  if (e.connman_state !== null) rows.push({ label: "Network state", value: e.connman_state });

  // DNS
  if (e.dns_servers) rows.push({ label: "DNS", value: e.dns_servers });

  // Latency / loss
  if (e.check_avg_latency_ms !== null) {
    rows.push({ label: "Latency (avg)", value: `${e.check_avg_latency_ms.toFixed(1)} ms` });
  }
  rows.push({ label: "Packet loss", value: `${e.check_packet_loss_pct}%` });

  // Flap
  if (e.flap_count > 0) {
    rows.push({ label: "Link flaps", value: `${e.flap_count} (unstable!)` });
  }

  // Traffic — only show if non-zero
  const rxBytes = e.proc_rx_bytes ?? 0;
  const txBytes = e.proc_tx_bytes ?? 0;
  if (rxBytes > 0 || txBytes > 0) {
    rows.push({ label: "RX", value: `${e.proc_rx_packets ?? 0} pkts / ${formatBytes(rxBytes)}` });
    rows.push({ label: "TX", value: `${e.proc_tx_packets ?? 0} pkts / ${formatBytes(txBytes)}` });
  }
  const rxDrop = e.proc_rx_drop ?? 0;
  if (rxDrop > 0) rows.push({ label: "RX dropped", value: String(rxDrop) });
  const crcErr = e.hw_rx_crc_errors ?? 0;
  if (crcErr > 0) rows.push({ label: "CRC errors", value: String(crcErr) });

  return rows;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DiagnosticsTab() {
  const [diag, setDiag] = useState<DiagnosticState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Best-effort watcher start — if no IP is set yet, this silently fails
    invoke("start_log_watcher").catch(() => {});

    const id = setInterval(async () => {
      try {
        const state = await invoke<DiagnosticState>("get_diagnostic_state");
        setDiag(state);
        setLoading(false);
      } catch {
        setLoading(false);
      }
    }, 2000);

    // Initial fetch immediately
    invoke<DiagnosticState>("get_diagnostic_state")
      .then((state) => { setDiag(state); setLoading(false); })
      .catch(() => setLoading(false));

    return () => clearInterval(id);
  }, []);

  const sys = diag?.system ?? null;
  const hasAnyData = diag !== null && (
    diag.wifi !== null ||
    diag.cellular !== null ||
    diag.satellite !== null ||
    diag.ethernet !== null ||
    diag.system !== null
  );

  return (
    <div className="diag-page">
      {/* Page header */}
      <div className="diag-header">
        <div>
          <span className="diag-header-title">System Diagnostics</span>
          {sys && (
            <span className="diag-header-meta">
              {[sys.sid, sys.version, sys.release_date?.split("T")[0]]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </div>
        {diag?.last_updated && (
          <span className="diag-timestamp">Last updated {diag.last_updated}</span>
        )}
      </div>

      {/* System info card (narrow, above grid) */}
      {sys && (
        <div className="diag-system-card">
          <span className="diag-card-icon">🖥</span>
          <div className="diag-row">
            <span className="diag-row-label">SID</span>
            <span className="diag-row-value">{dash(sys.sid)}</span>
          </div>
          <div className="diag-row">
            <span className="diag-row-label">Firmware</span>
            <span className="diag-row-value">{dash(sys.version)}</span>
          </div>
          <div className="diag-row">
            <span className="diag-row-label">Release</span>
            <span className="diag-row-value">{dash(sys.release_date)}</span>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!hasAnyData && !loading && (
        <div className="diag-empty">
          <div>ℹ No session data yet.</div>
          <div>
            Launch a controller terminal and run diagnostic commands.
            <br />
            Cards will populate automatically as output is detected.
          </div>
        </div>
      )}

      {/* Diagnostic grid */}
      <div className="diag-grid">
        <DiagCard
          title="Wi-Fi"
          icon="📶"
          status={diag?.wifi?.status ?? "unknown"}
          summary={diag?.wifi?.summary ?? ""}
          rows={diag?.wifi ? buildWifiRows(diag.wifi) : []}
          loading={loading}
        />
        <DiagCard
          title="Cellular"
          icon="📡"
          status={diag?.cellular?.status ?? "unknown"}
          summary={diag?.cellular?.summary ?? ""}
          rows={diag?.cellular ? buildCellularRows(diag.cellular) : []}
          loading={loading}
        />
        <DiagCard
          title="Satellite"
          icon="🛰"
          status={diag?.satellite?.status ?? "unknown"}
          summary={diag?.satellite?.summary ?? ""}
          rows={diag?.satellite ? buildSatelliteRows(diag.satellite) : []}
          loading={loading}
        />
        <DiagCard
          title="Ethernet"
          icon="🔌"
          status={diag?.ethernet?.status ?? "unknown"}
          summary={diag?.ethernet?.summary ?? ""}
          rows={diag?.ethernet ? buildEthernetRows(diag.ethernet) : []}
          loading={loading}
        />
      </div>
    </div>
  );
}
