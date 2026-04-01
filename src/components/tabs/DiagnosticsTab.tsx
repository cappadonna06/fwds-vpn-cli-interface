import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type DiagStatus = "grey" | "green" | "orange" | "red" | "unknown";

interface WifiDiagnostic {
  status: DiagStatus;
  summary: string;
  check_result: string;
  check_error?: string | null;
  internet_reachable: boolean;
  wifi_state: string;
  access_point?: string | null;
  strength_score?: number | null;
  strength_label?: string | null;
  ipv4: boolean;
  ipv6: boolean;
  dns_servers: string;
  check_avg_latency_ms?: number | null;
  check_packet_loss_pct: number;
  signal_dbm?: number | null;
  signal_dbm_trusted: boolean;
  interface_exists: boolean;
  interface_name?: string | null;
  interface_type?: string | null;
  mac_address?: string | null;
  ssid?: string | null;
  tx_power_dbm?: number | null;
  connected?: boolean | null;
  ap_bssid?: string | null;
  frequency_mhz?: number | null;
  tx_bitrate_mbps?: number | null;
  station_tx_retries?: number | null;
  station_tx_failed?: number | null;
  station_tx_bitrate_mbps?: number | null;
  lower_up_flag?: boolean | null;
  link_state?: string | null;
  ipv4_address?: string | null;
  ipv4_prefix?: number | null;
  default_via_wlan0?: boolean | null;
  default_gateway?: string | null;
  connman_wifi_powered?: boolean | null;
  connman_wifi_connected?: boolean | null;
  connman_active_service?: string | null;
  connman_wifi_active?: boolean | null;
  connman_state?: string | null;
  driver?: string | null;
  proc_rx_bytes?: number | null;
  proc_rx_packets?: number | null;
  proc_rx_drop?: number | null;
  proc_tx_bytes?: number | null;
  proc_tx_packets?: number | null;
}

interface CellularDiagnostic {
  status: DiagStatus;
  summary: string;
  check_result: string;
  check_error?: string | null;
  internet_reachable: boolean;
  cell_state: string;
  provider_code?: string | null;
  strength_score?: number | null;
  strength_label?: string | null;
  ipv4: boolean;
  ipv6: boolean;
  dns_servers: string;
  check_avg_latency_ms?: number | null;
  check_packet_loss_pct: number;
  imei?: string | null;
  iccid?: string | null;
  imsi?: string | null;
  hni?: string | null;
  basic_provider?: string | null;
  basic_status?: string | null;
  basic_signal?: string | null;
  basic_apn?: string | null;
  connman_cell_powered?: boolean | null;
  connman_cell_connected?: boolean | null;
  connman_wifi_connected?: boolean | null;
  connman_eth_connected?: boolean | null;
  connman_active_service?: string | null;
  connman_cell_active?: boolean | null;
  connman_cell_ready?: boolean | null;
  connman_state?: string | null;
  wwan_ipv4_address?: string | null;
  wwan_ipv4_prefix?: number | null;
  role?: string | null;
  modem_present?: boolean | null;
  modem_model?: string | null;
  sim_ready?: boolean | null;
  sim_inserted?: boolean | null;
  operator_name?: string | null;
  qcsq?: string | null;
  rat?: string | null;
  band?: string | null;
  at_apn?: string | null;
  recommended_action?: string | null;
  other_actions?: string[] | null;
}

interface SatelliteDiagnostic {
  status: DiagStatus;
  summary: string;
  enabled: boolean;
  loopback_passed?: boolean | null;
  loopback_time_secs?: number | null;
  imei?: string | null;
}

interface EthernetDiagnostic {
  status: DiagStatus;
  summary: string;
  internet_reachable: boolean;
  eth_state: string;
  ipv4: boolean;
  ipv6: boolean;
  dns_servers: string;
  ip_address?: string | null;
  netmask?: string | null;
  speed?: string | null;
  duplex?: string | null;
  link_detected?: boolean | null;
  rx_errors: number;
  tx_errors: number;
  rx_dropped: number;
  check_result: string;
  flap_count: number;
}

interface SystemDiagnostic {
  sid?: string | null;
  version?: string | null;
  release_date?: string | null;
}

interface DiagnosticState {
  wifi?: WifiDiagnostic | null;
  cellular?: CellularDiagnostic | null;
  satellite?: SatelliteDiagnostic | null;
  ethernet?: EthernetDiagnostic | null;
  system?: SystemDiagnostic | null;
  last_updated?: string | null;
  session_has_data?: boolean;
}

interface DiagCardProps {
  title: string;
  icon: string;
  status: DiagStatus;
  summary: string;
  rows: { label: string; value: string }[];
  updatedAt?: string | null;
}

function fmtBool(v: boolean | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v ? "Yes" : "No";
}

function fmtNum(v: number | null | undefined, suffix = ""): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${v}${suffix}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildWifiRows(wifi?: WifiDiagnostic | null): { label: string; value: string }[] {
  if (!wifi) return [];
  const rows: { label: string; value: string }[] = [];
  rows.push({ label: "Check result", value: wifi.check_result || "—" });
  if (wifi.check_error) rows.push({ label: "Error", value: wifi.check_error });
  rows.push({ label: "Internet", value: wifi.internet_reachable ? "Online" : "Offline" });
  rows.push({ label: "State", value: wifi.wifi_state || "—" });
  rows.push({ label: "SSID", value: wifi.ssid || wifi.access_point || "—" });
  rows.push({ label: "Connected", value: wifi.connected === true ? "Yes" : wifi.connected === false ? "No" : "—" });
  if (wifi.ap_bssid) rows.push({ label: "AP BSSID", value: wifi.ap_bssid });
  if (wifi.signal_dbm !== null && wifi.signal_dbm !== undefined) {
    rows.push({ label: "Signal", value: wifi.signal_dbm_trusted ? `${wifi.signal_dbm} dBm` : `${wifi.signal_dbm} dBm (untrusted)` });
  }
  if (wifi.strength_score !== null && wifi.strength_score !== undefined) {
    rows.push({ label: "Strength", value: `${wifi.strength_score}/100${wifi.strength_label ? ` (${wifi.strength_label})` : ""}` });
  }
  if (wifi.frequency_mhz) rows.push({ label: "Frequency", value: `${wifi.frequency_mhz} MHz` });
  if (wifi.tx_bitrate_mbps !== null && wifi.tx_bitrate_mbps !== undefined) rows.push({ label: "TX bitrate", value: `${wifi.tx_bitrate_mbps.toFixed(1)} Mbps` });
  rows.push({ label: "IP address", value: wifi.ipv4_address ? `${wifi.ipv4_address}/${wifi.ipv4_prefix ?? ""}` : "—" });
  rows.push({ label: "IPv4", value: wifi.ipv4 ? "Yes" : "No" });
  rows.push({ label: "IPv6", value: wifi.ipv6 ? "Yes" : "No" });
  if (wifi.mac_address) rows.push({ label: "MAC", value: wifi.mac_address });
  if (wifi.driver) rows.push({ label: "Driver", value: wifi.driver });
  rows.push({ label: "Default route", value: wifi.default_via_wlan0 === true ? "via wlan0 ✓" : wifi.default_gateway ? `via ${wifi.default_gateway} (not wlan0)` : "—" });
  rows.push({ label: "ConnMan Wi-Fi", value: wifi.connman_wifi_connected === true ? "Connected" : wifi.connman_wifi_powered === true ? "Powered, not connected" : wifi.connman_wifi_powered === false ? "Disabled" : "—" });
  rows.push({ label: "Active service", value: wifi.connman_active_service || "—" });
  rows.push({ label: "Network state", value: wifi.connman_state || "—" });
  if (wifi.dns_servers) rows.push({ label: "DNS", value: wifi.dns_servers });
  if (wifi.check_avg_latency_ms !== null && wifi.check_avg_latency_ms !== undefined) rows.push({ label: "Latency (avg)", value: `${wifi.check_avg_latency_ms.toFixed(1)} ms` });
  rows.push({ label: "Packet loss", value: `${wifi.check_packet_loss_pct}%` });
  if (wifi.station_tx_retries !== null && wifi.station_tx_retries !== undefined) rows.push({ label: "TX retries", value: String(wifi.station_tx_retries) });
  if (wifi.station_tx_failed !== null && wifi.station_tx_failed !== undefined) rows.push({ label: "TX failed", value: String(wifi.station_tx_failed) });
  if (wifi.proc_rx_bytes && wifi.proc_rx_bytes > 0) {
    rows.push({ label: "RX", value: `${wifi.proc_rx_packets ?? 0} pkts / ${formatBytes(wifi.proc_rx_bytes)}` });
    rows.push({ label: "TX", value: `${wifi.proc_tx_packets ?? 0} pkts / ${formatBytes(wifi.proc_tx_bytes ?? 0)}` });
  }
  if (wifi.proc_rx_drop && wifi.proc_rx_drop > 0) rows.push({ label: "RX dropped", value: String(wifi.proc_rx_drop) });
  return rows;
}

function buildCellularRows(cell?: CellularDiagnostic | null): { label: string; value: string }[] {
  if (!cell) return [];
  const rows: { label: string; value: string }[] = [];

  rows.push({ label: "Check result", value: cell.check_result || "—" });
  if (cell.check_error) rows.push({ label: "Error", value: cell.check_error });

  rows.push({ label: "State", value: cell.cell_state || "—" });

  const provider =
    cell.operator_name ||
    cell.basic_provider ||
    cell.provider_code ||
    cell.hni ||
    "—";
  rows.push({ label: "Provider", value: provider });

  if (cell.strength_score !== null && cell.strength_score !== undefined) {
    rows.push({
      label: "Signal",
      value: `${cell.strength_score}/100${cell.strength_label ? ` (${cell.strength_label})` : ""}`,
    });
  } else if (cell.qcsq) {
    rows.push({ label: "Signal", value: cell.qcsq === "NOSERVICE" ? "No service" : cell.qcsq });
  }

  rows.push({
    label: "Connected",
    value: cell.connman_cell_connected === true ? "Yes" : "No",
  });

  rows.push({
    label: "Role",
    value:
      cell.role === "active"
        ? "Active"
        : cell.role === "backup"
          ? "Backup"
          : "Inactive",
  });

  rows.push({
    label: "IP address",
    value: cell.wwan_ipv4_address ? `${cell.wwan_ipv4_address}/${cell.wwan_ipv4_prefix ?? ""}` : "—",
  });

  if (cell.basic_apn || cell.at_apn) {
    rows.push({ label: "APN", value: cell.at_apn || cell.basic_apn || "—" });
  }

  rows.push({
    label: "SIM",
    value:
      cell.sim_inserted === false
        ? "Not inserted"
        : cell.sim_ready === true
          ? "Ready"
          : "—",
  });

  rows.push({
    label: "Modem",
    value: cell.modem_present === true ? (cell.modem_model || "Detected") : "Not detected",
  });

  if (cell.rat || cell.band) {
    rows.push({
      label: "Network",
      value: [cell.rat, cell.band].filter(Boolean).join(" / ") || "—",
    });
  }

  rows.push({
    label: "ConnMan",
    value:
      cell.connman_cell_connected === true
        ? "Connected"
        : cell.connman_cell_powered === false
          ? "Disabled"
          : cell.connman_cell_powered === true
            ? "Powered, not connected"
            : "—",
  });

  if (cell.check_avg_latency_ms !== null && cell.check_avg_latency_ms !== undefined) {
    rows.push({ label: "Latency", value: `${cell.check_avg_latency_ms.toFixed(1)} ms` });
  }

  if (cell.check_packet_loss_pct !== null && cell.check_packet_loss_pct !== undefined) {
    rows.push({ label: "Packet loss", value: `${cell.check_packet_loss_pct}%` });
  }

  if (cell.recommended_action) {
    rows.push({ label: "Recommended", value: cell.recommended_action });
  }

  if (cell.other_actions && cell.other_actions.length > 0) {
    rows.push({ label: "Other options", value: cell.other_actions.join(" • ") });
  }

  return rows;
}

function DiagCard({ title, icon, status, summary, rows, updatedAt }: DiagCardProps) {
  const statusLabel =
    status === "green" ? "Healthy" :
      status === "grey" ? "Disabled" :
      status === "orange" ? "Warning" :
        status === "red" ? "Error" : "Unknown";

  return (
    <article className={`diag-card ${status === "unknown" ? "diag-card-unknown" : ""}`}>
      <div className="diag-card-header">
        <div>{icon} {title}</div>
        <span className={`diag-status-dot diag-status-${status === "grey" ? "unknown" : status}`} />
      </div>
      <div className="diag-card-status">{statusLabel}</div>
      <div className="diag-card-summary">{summary}</div>
      <div className="diag-card-updated">Updated {updatedAt ?? "—"}</div>
      <div className="diag-card-divider" />
      <div>
        {rows.map((row) => (
          <div key={`${title}-${row.label}`} className="diag-row">
            <div className="diag-row-label">{row.label}</div>
            <div className="diag-row-value">{row.value}</div>
          </div>
        ))}
      </div>
    </article>
  );
}

export default function DiagnosticsTab() {
  const [diag, setDiag] = useState<DiagnosticState | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    wifi: false,
    cellular: false,
    satellite: false,
    ethernet: false,
  });
  const [cardUpdatedAt, setCardUpdatedAt] = useState<Record<string, string | null>>({
    wifi: null,
    cellular: null,
    satellite: null,
    ethernet: null,
  });
  const prevCardsRef = useRef<Record<string, string>>({
    wifi: "",
    cellular: "",
    satellite: "",
    ethernet: "",
  });
  const prevSystemRef = useRef<string>("");
  const [systemUpdatedAt, setSystemUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    invoke("start_log_watcher").catch(() => {});

    const id = setInterval(async () => {
      try {
        const state = await invoke<DiagnosticState>("get_diagnostic_state");
        const now = new Date().toLocaleTimeString();
        const nextCards: Record<string, string> = {
          wifi: JSON.stringify(state.wifi ?? null),
          cellular: JSON.stringify(state.cellular ?? null),
          satellite: JSON.stringify(state.satellite ?? null),
          ethernet: JSON.stringify(state.ethernet ?? null),
        };
        const nextSystem = JSON.stringify(state.system ?? null);

        setCardUpdatedAt((prev) => {
          const updated = { ...prev };
          (Object.keys(nextCards) as Array<keyof typeof nextCards>).forEach((k) => {
            if (nextCards[k] !== prevCardsRef.current[k]) {
              updated[k] = now;
            }
          });
          return updated;
        });
        if (nextSystem !== prevSystemRef.current) {
          setSystemUpdatedAt(now);
        }
        prevCardsRef.current = nextCards;
        prevSystemRef.current = nextSystem;
        setDiag(state);
        setLastUpdated(state.last_updated ?? null);
      } catch {
        // best effort
      }
    }, 2000);

    return () => clearInterval(id);
  }, []);

  const showNoSessionBanner = useMemo(() => !diag?.session_has_data, [diag]);

  const wifi = diag?.wifi;
  const cellular = diag?.cellular;
  const satellite = diag?.satellite;
  const ethernet = diag?.ethernet;
  const system = diag?.system;

  async function clearCards() {
    await invoke("clear_diagnostic_state").catch(() => {});
    setDiag({
      wifi: null,
      cellular: null,
      satellite: null,
      ethernet: null,
      system: null,
      last_updated: null,
      session_has_data: false,
    });
    setLastUpdated(null);
    setSystemUpdatedAt(null);
    setCardUpdatedAt({ wifi: null, cellular: null, satellite: null, ethernet: null });
    prevCardsRef.current = { wifi: "", cellular: "", satellite: "", ethernet: "" };
    prevSystemRef.current = "";
  }

  return (
    <section className="tab-content diag-page">
      <div className="diag-header">
        <div>
          <h2>System Diagnostics</h2>
          <div className="diag-system-line">
            SID {system?.sid ?? "—"} · {system?.version ?? "—"} · {system?.release_date ?? "—"}
          </div>
          <div className="diag-system-line">System updated {systemUpdatedAt ?? "—"}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="diag-updated">Last updated {lastUpdated ?? "—"}</div>
          <button className="btn btn-secondary" onClick={clearCards}>Clear Cards</button>
        </div>
      </div>
      {showNoSessionBanner && (
        <div className="diag-empty">
          <div>ℹ No data collected this session yet.</div>
          <div>Showing known diagnostics; run command blocks to refresh cards.</div>
          <div>Tip: run <code>sid</code>, <code>version</code>, and <code>release</code> at session start.</div>
        </div>
      )}

      <div className="diag-grid">
        <div>
          <button className="diag-expand-btn" onClick={() => setExpanded((p) => ({ ...p, wifi: !p.wifi }))}>
            {expanded.wifi ? "▾" : "▸"} Wi-Fi details
          </button>
          <DiagCard
            title="Wi-Fi"
            icon="🌐"
            status={wifi?.status ?? "unknown"}
            summary={wifi?.summary ?? "Run wifi-check / wifi diagnostics to populate"}
            rows={expanded.wifi ? buildWifiRows(wifi) : []}
            updatedAt={cardUpdatedAt.wifi}
          />
        </div>

        <div>
          <button className="diag-expand-btn" onClick={() => setExpanded((p) => ({ ...p, cellular: !p.cellular }))}>
            {expanded.cellular ? "▾" : "▸"} Cellular details
          </button>
          <DiagCard
          title="Cellular"
          icon="📶"
          status={cellular?.status ?? "unknown"}
          summary={cellular?.summary ?? "Run cellular-check / cellular diagnostics to populate"}
          rows={expanded.cellular ? buildCellularRows(cellular) : []}
          updatedAt={cardUpdatedAt.cellular}
          />
        </div>

        <div>
          <button className="diag-expand-btn" onClick={() => setExpanded((p) => ({ ...p, satellite: !p.satellite }))}>
            {expanded.satellite ? "▾" : "▸"} Satellite details
          </button>
          <DiagCard
          title="Satellite"
          icon="🛰️"
          status={satellite?.status ?? "unknown"}
          summary={satellite?.summary ?? "Run satellite-check to populate"}
          rows={expanded.satellite ? [
            { label: "Enabled", value: fmtBool(satellite?.enabled) },
            {
              label: "Loopback",
              value:
                satellite?.loopback_passed === true
                  ? "Passed"
                  : satellite?.loopback_passed === false
                    ? "Failed"
                    : "Not run",
            },
            ...(satellite?.loopback_time_secs ? [{ label: "Loopback time", value: `${satellite.loopback_time_secs.toFixed(1)}s` }] : []),
            ...(satellite?.imei ? [{ label: "IMEI", value: satellite.imei }] : []),
          ] : []}
          updatedAt={cardUpdatedAt.satellite}
          />
        </div>

        <div>
          <button className="diag-expand-btn" onClick={() => setExpanded((p) => ({ ...p, ethernet: !p.ethernet }))}>
            {expanded.ethernet ? "▾" : "▸"} Ethernet details
          </button>
          <DiagCard
          title="Ethernet"
          icon="🔌"
          status={ethernet?.status ?? "unknown"}
          summary={ethernet?.summary ?? "Run ethernet-check / ethernet diagnostics to populate"}
          rows={expanded.ethernet ? [
            { label: "Internet", value: ethernet ? (ethernet.internet_reachable ? "Online" : "Offline") : "—" },
            { label: "State", value: ethernet?.eth_state ?? "—" },
            { label: "IP address", value: ethernet?.ip_address ?? "—" },
            { label: "Netmask", value: ethernet?.netmask ?? "—" },
            { label: "Speed", value: ethernet?.speed ?? "—" },
            { label: "Duplex", value: ethernet?.duplex ?? "—" },
            { label: "Link detected", value: fmtBool(ethernet?.link_detected) },
            { label: "IPv4", value: fmtBool(ethernet?.ipv4) },
            { label: "IPv6", value: fmtBool(ethernet?.ipv6) },
            { label: "DNS", value: ethernet?.dns_servers ?? "—" },
            { label: "RX errors", value: fmtNum(ethernet?.rx_errors) },
            { label: "TX errors", value: fmtNum(ethernet?.tx_errors) },
            { label: "RX dropped", value: fmtNum(ethernet?.rx_dropped) },
            ...(ethernet && ethernet.flap_count > 0 ? [{ label: "Flap events", value: String(ethernet.flap_count) }] : []),
            { label: "Check result", value: ethernet?.check_result ?? "—" },
          ] : []}
          updatedAt={cardUpdatedAt.ethernet}
          />
        </div>
      </div>
    </section>
  );
}
