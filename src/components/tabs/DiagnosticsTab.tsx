import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DIAGNOSTIC_BLOCKS, DiagnosticBlock } from "../../types/commands";

type DiagStatus = "grey" | "green" | "orange" | "red" | "unknown";
type HealthTone = "healthy" | "warning" | "error" | "neutral";

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
  controller_sid?: string | null;
  controller_version?: string | null;
  controller_date?: string | null;
  sat_imei?: string | null;
  modem_present?: boolean | null;
  connman_state?: string | null;
  connman_eth_connected?: boolean | null;
  connman_wifi_connected?: boolean | null;
  connman_cell_connected?: boolean | null;
  connman_active_service?: string | null;
  default_gateway?: string | null;
  default_via_eth0?: boolean | null;
  default_via_wlan0?: boolean | null;
  default_via_wwan0?: boolean | null;
  satellites_seen?: number | null;
  light_test_ran: boolean;
  light_test_success?: boolean | null;
  light_test_timeout?: boolean | null;
  light_test_blocked_in_use?: boolean | null;
  light_test_error?: string | null;
  loopback_test_ran: boolean;
  loopback_test_success?: boolean | null;
  loopback_test_timeout?: boolean | null;
  loopback_test_blocked_in_use?: boolean | null;
  loopback_test_error?: string | null;
  station_sent_epoch?: number | null;
  server_sent_epoch?: number | null;
  current_epoch?: number | null;
  total_time_seconds?: number | null;
  recommended_action?: string | null;
  other_actions?: string[] | null;
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

type DiagRow = { label: string; value: string };
type DiagSection = { title: string; rows: DiagRow[] };

interface DiagCardProps {
  title: string;
  icon: string;
  health: HealthTone;
  primaryStatus: string;
  summaryFacts: string[];
  sections: DiagSection[];
  updatedAt?: string | null;
  expanded: boolean;
  onToggle: () => void;
  commandHint?: string;
  onCopyCommand?: () => void;
  copied?: boolean;
}

function fmtBool(v: boolean | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v ? "Yes" : "No";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveBlockScript(block: DiagnosticBlock, tier: "light" | "heavy"): string {
  const custom = tier === "light" ? block.light_script : block.heavy_script;
  if (custom && custom.trim().length > 0) return custom;
  const ids = tier === "light" ? block.light_command_ids : block.heavy_command_ids;
  return ids.join("\n");
}

function toneFromStatus(status?: DiagStatus | null): HealthTone {
  if (status === "green") return "healthy";
  if (status === "orange") return "warning";
  if (status === "red") return "error";
  return "neutral";
}

function labelFromStatus(status?: DiagStatus | null): string {
  if (status === "green") return "Connected";
  if (status === "orange") return "Degraded";
  if (status === "red") return "Offline";
  if (status === "grey") return "Disabled";
  return "No data";
}

function buildWifiSummary(wifi?: WifiDiagnostic | null): string[] {
  if (!wifi) return ["Waiting for diagnostics"];
  return [
    wifi.ssid || wifi.access_point || "SSID unavailable",
    wifi.strength_score !== null && wifi.strength_score !== undefined
      ? `${wifi.strength_score}/100${wifi.strength_label ? ` (${wifi.strength_label})` : ""}`
      : "Signal unavailable",
    wifi.ipv4_address || "No IPv4 address",
  ];
}

function buildWifiSections(wifi?: WifiDiagnostic | null): DiagSection[] {
  if (!wifi) return [{ title: "Status", rows: [{ label: "Details", value: "No recent data" }] }];

  const network: DiagRow[] = [
    { label: "State", value: wifi.wifi_state || "—" },
    { label: "SSID", value: wifi.ssid || wifi.access_point || "—" },
    { label: "Connected", value: wifi.connected === true ? "Yes" : wifi.connected === false ? "No" : "—" },
    { label: "IP address", value: wifi.ipv4_address ? `${wifi.ipv4_address}/${wifi.ipv4_prefix ?? ""}` : "—" },
    { label: "Default route", value: wifi.default_via_wlan0 === true ? "via wlan0" : wifi.default_gateway || "—" },
    { label: "DNS", value: wifi.dns_servers || "—" },
  ];

  const performance: DiagRow[] = [
    {
      label: "Signal",
      value:
        wifi.signal_dbm !== null && wifi.signal_dbm !== undefined
          ? `${wifi.signal_dbm} dBm${wifi.signal_dbm_trusted ? "" : " (untrusted)"}`
          : "—",
    },
    {
      label: "Strength",
      value: wifi.strength_score !== null && wifi.strength_score !== undefined
        ? `${wifi.strength_score}/100${wifi.strength_label ? ` (${wifi.strength_label})` : ""}`
        : "—",
    },
    { label: "Latency", value: wifi.check_avg_latency_ms !== null && wifi.check_avg_latency_ms !== undefined ? `${wifi.check_avg_latency_ms.toFixed(1)} ms` : "—" },
    { label: "Packet loss", value: `${wifi.check_packet_loss_pct}%` },
    { label: "Internet", value: wifi.internet_reachable ? "Online" : "Offline" },
  ];

  const hardware: DiagRow[] = [
    { label: "Driver", value: wifi.driver || "—" },
    { label: "MAC", value: wifi.mac_address || "—" },
    { label: "Frequency", value: wifi.frequency_mhz ? `${wifi.frequency_mhz} MHz` : "—" },
    { label: "TX bitrate", value: wifi.tx_bitrate_mbps !== null && wifi.tx_bitrate_mbps !== undefined ? `${wifi.tx_bitrate_mbps.toFixed(1)} Mbps` : "—" },
  ];

  if (wifi.proc_rx_bytes && wifi.proc_rx_bytes > 0) {
    performance.push({ label: "RX", value: `${wifi.proc_rx_packets ?? 0} pkts / ${formatBytes(wifi.proc_rx_bytes)}` });
    performance.push({ label: "TX", value: `${wifi.proc_tx_packets ?? 0} pkts / ${formatBytes(wifi.proc_tx_bytes ?? 0)}` });
  }

  if (wifi.check_error) {
    network.unshift({ label: "Error", value: wifi.check_error });
  }

  return [
    { title: "Network", rows: network },
    { title: "Performance", rows: performance },
    { title: "Hardware", rows: hardware },
  ];
}

function buildCellularSummary(cell?: CellularDiagnostic | null): string[] {
  if (!cell) return ["Waiting for diagnostics"];
  return [
    cell.operator_name || cell.basic_provider || cell.provider_code || "Carrier unavailable",
    cell.strength_score !== null && cell.strength_score !== undefined
      ? `${cell.strength_score}/100${cell.strength_label ? ` (${cell.strength_label})` : ""}`
      : cell.qcsq || "Signal unavailable",
    cell.wwan_ipv4_address || "No IPv4 address",
  ];
}

function buildCellularSections(cell?: CellularDiagnostic | null): DiagSection[] {
  if (!cell) return [{ title: "Status", rows: [{ label: "Details", value: "No recent data" }] }];

  return [
    {
      title: "Network",
      rows: [
        { label: "State", value: cell.cell_state || "—" },
        { label: "Provider", value: cell.operator_name || cell.basic_provider || cell.provider_code || cell.hni || "—" },
        { label: "Role", value: cell.role === "active" ? "Active" : cell.role === "backup" ? "Backup" : "Inactive" },
        { label: "IP address", value: cell.wwan_ipv4_address ? `${cell.wwan_ipv4_address}/${cell.wwan_ipv4_prefix ?? ""}` : "—" },
        { label: "APN", value: cell.at_apn || cell.basic_apn || "—" },
        { label: "ConnMan", value: cell.connman_cell_connected === true ? "Connected" : cell.connman_cell_powered === false ? "Disabled" : cell.connman_cell_powered === true ? "Powered, not connected" : "—" },
      ],
    },
    {
      title: "Performance",
      rows: [
        {
          label: "Signal",
          value: cell.strength_score !== null && cell.strength_score !== undefined
            ? `${cell.strength_score}/100${cell.strength_label ? ` (${cell.strength_label})` : ""}`
            : cell.qcsq === "NOSERVICE" ? "No service" : cell.qcsq || "—",
        },
        { label: "Latency", value: cell.check_avg_latency_ms !== null && cell.check_avg_latency_ms !== undefined ? `${cell.check_avg_latency_ms.toFixed(1)} ms` : "—" },
        { label: "Packet loss", value: `${cell.check_packet_loss_pct}%` },
        { label: "Internet", value: cell.internet_reachable ? "Online" : "Offline" },
      ],
    },
    {
      title: "Modem / SIM",
      rows: [
        { label: "Modem", value: cell.modem_present === true ? (cell.modem_model || "Detected") : "Not detected" },
        { label: "SIM", value: cell.sim_inserted === false ? "Not inserted" : cell.sim_ready === true ? "Ready" : "—" },
        { label: "Network", value: [cell.rat, cell.band].filter(Boolean).join(" / ") || "—" },
        { label: "Check result", value: cell.check_result || "—" },
        ...(cell.check_error ? [{ label: "Error", value: cell.check_error }] : []),
        ...(cell.recommended_action ? [{ label: "Recommended", value: cell.recommended_action }] : []),
      ],
    },
  ];
}

function buildSatelliteSummary(sat?: SatelliteDiagnostic | null): string[] {
  if (!sat) return ["Waiting for diagnostics"];
  return [
    sat.modem_present === true ? "Modem detected" : sat.modem_present === false ? "Modem not detected" : "Modem state unknown",
    sat.satellites_seen !== null && sat.satellites_seen !== undefined ? `${sat.satellites_seen} satellites seen` : "Satellite count unavailable",
    sat.connman_active_service || sat.connman_state || "No active network",
  ];
}

function buildSatelliteSections(sat?: SatelliteDiagnostic | null): DiagSection[] {
  if (!sat) return [{ title: "Status", rows: [{ label: "Details", value: "No recent data" }] }];

  return [
    {
      title: "Network",
      rows: [
        { label: "State", value: sat.connman_state || "—" },
        { label: "Primary network", value: sat.connman_active_service || "—" },
        { label: "Gateway", value: sat.default_gateway || "—" },
        { label: "Satellites seen", value: sat.satellites_seen !== null && sat.satellites_seen !== undefined ? String(sat.satellites_seen) : "—" },
      ],
    },
    {
      title: "Tests",
      rows: [
        { label: "Light test", value: sat.light_test_success === true ? "Passed" : sat.light_test_ran ? sat.light_test_blocked_in_use ? "Blocked (in use)" : "Failed" : "Not run" },
        { label: "Loopback", value: sat.loopback_test_success === true ? "Passed" : sat.loopback_test_ran ? sat.loopback_test_blocked_in_use ? "Blocked (in use)" : "Failed" : "Not run" },
        { label: "Loopback time", value: sat.total_time_seconds !== null && sat.total_time_seconds !== undefined ? `${sat.total_time_seconds}s` : "—" },
        ...(sat.loopback_test_error ? [{ label: "Last error", value: sat.loopback_test_error }] : sat.light_test_error ? [{ label: "Last error", value: sat.light_test_error }] : []),
        ...(sat.recommended_action ? [{ label: "Recommended", value: sat.recommended_action }] : []),
      ],
    },
    {
      title: "Hardware",
      rows: [
        { label: "Modem", value: sat.modem_present === true ? "Detected" : sat.modem_present === false ? "Not detected" : "—" },
        { label: "IMEI", value: sat.sat_imei || "—" },
      ],
    },
  ];
}

function buildEthernetSummary(ethernet?: EthernetDiagnostic | null): string[] {
  if (!ethernet) return ["Waiting for diagnostics"];
  return [
    ethernet.ip_address || "No IP address",
    ethernet.speed || "Speed unavailable",
    ethernet.link_detected === true ? "Link detected" : ethernet.link_detected === false ? "No link" : "Link unknown",
  ];
}

function buildEthernetSections(ethernet?: EthernetDiagnostic | null): DiagSection[] {
  if (!ethernet) return [{ title: "Status", rows: [{ label: "Details", value: "No recent data" }] }];

  return [
    {
      title: "Network",
      rows: [
        { label: "State", value: ethernet.eth_state || "—" },
        { label: "Internet", value: ethernet.internet_reachable ? "Online" : "Offline" },
        { label: "IP address", value: ethernet.ip_address || "—" },
        { label: "Netmask", value: ethernet.netmask || "—" },
        { label: "DNS", value: ethernet.dns_servers || "—" },
      ],
    },
    {
      title: "Link",
      rows: [
        { label: "Link detected", value: fmtBool(ethernet.link_detected) },
        { label: "Speed", value: ethernet.speed || "—" },
        { label: "Duplex", value: ethernet.duplex || "—" },
        { label: "IPv4", value: fmtBool(ethernet.ipv4) },
        { label: "IPv6", value: fmtBool(ethernet.ipv6) },
      ],
    },
    {
      title: "Errors",
      rows: [
        { label: "RX errors", value: String(ethernet.rx_errors) },
        { label: "TX errors", value: String(ethernet.tx_errors) },
        { label: "RX dropped", value: String(ethernet.rx_dropped) },
        { label: "Flap events", value: ethernet.flap_count > 0 ? String(ethernet.flap_count) : "0" },
        { label: "Check result", value: ethernet.check_result || "—" },
      ],
    },
  ];
}

function DiagCard({
  title,
  icon,
  health,
  primaryStatus,
  summaryFacts,
  sections,
  updatedAt,
  expanded,
  onToggle,
  commandHint,
  onCopyCommand,
  copied,
}: DiagCardProps) {
  return (
    <article className={`diag-card diag-card-${health} ${expanded ? "diag-card-open" : ""}`}>
      <button className="diag-card-head" onClick={onToggle}>
        <div className="diag-card-title-wrap">
          <span className="diag-card-icon" aria-hidden>{icon}</span>
          <span className="diag-card-title">{title}</span>
        </div>
        <div className="diag-card-head-right">
          <span className={`diag-status-dot diag-status-${health}`} />
          <span className={`diag-chevron ${expanded ? "open" : ""}`} aria-hidden>▾</span>
        </div>
      </button>

      <div className="diag-card-status-line">{primaryStatus}</div>

      <ul className="diag-summary-list">
        {summaryFacts.slice(0, 3).map((fact) => <li key={`${title}-${fact}`}>{fact}</li>)}
      </ul>

      {expanded && (
        <div className="diag-details-wrap">
          {sections.map((section) => (
            <section key={`${title}-${section.title}`} className="diag-details-section">
              <h4>{section.title}</h4>
              <div>
                {section.rows.map((row) => (
                  <div key={`${title}-${section.title}-${row.label}`} className="diag-row">
                    <div className="diag-row-label">{row.label}</div>
                    <div className="diag-row-value">{row.value}</div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {commandHint && onCopyCommand && (
        <div className="diag-card-action-row">
          <span>{commandHint}</span>
          <button className="diag-copy-link" onClick={onCopyCommand}>
            {copied ? "Copied" : "Copy command block"}
          </button>
        </div>
      )}

      <div className="diag-card-updated">Updated {updatedAt ?? "—"}</div>
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
  const [copiedCommandId, setCopiedCommandId] = useState<string | null>(null);

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
    setCopiedCommandId(null);
  }

  async function copyDiagnosticBlock(blockId: string) {
    const block = DIAGNOSTIC_BLOCKS.find((item) => item.id === blockId);
    if (!block) return;
    const script = resolveBlockScript(block, "heavy");
    if (!script) return;
    await navigator.clipboard.writeText(script).catch(() => {});
    setCopiedCommandId(blockId);
    setTimeout(() => setCopiedCommandId((prev) => (prev === blockId ? null : prev)), 1400);
  }

  const wifiNeedsRefresh = !wifi || !wifi.ipv4_address || (!wifi.ssid && !wifi.access_point);
  const cellularNeedsRefresh = !cellular || cellular.modem_present === false || !cellular.wwan_ipv4_address;
  const satelliteNeedsRefresh = !satellite || satellite.modem_present !== true;
  const ethernetNeedsRefresh = !ethernet || ethernet.link_detected !== true || !ethernet.ip_address;
  const fullDiagBlockId = satellite?.modem_present === true ? "full-diags" : "full-diags-no-sat";

  const systemIdentity = [
    system?.sid ? `SID ${system.sid}` : null,
    system?.version ? `v${system.version}` : null,
    system?.release_date ? system.release_date : null,
  ].filter(Boolean).join(" · ");

  return (
    <section className="tab-content diag-page">
      <div className="diag-header">
        <div className="diag-header-left">
          <h2>System Diagnostics</h2>
          <div className="diag-system-line">{systemIdentity || "No system identity data yet"}</div>
          <div className="diag-system-line">System updated {systemUpdatedAt ?? "—"}</div>
        </div>

        <div className="diag-header-right">
          <div className="diag-updated">Last updated {lastUpdated ?? "—"}</div>
          <button className="btn btn-secondary" onClick={clearCards}>Clear Cards</button>
        </div>
      </div>

      {showNoSessionBanner && (
        <div className="diag-empty">
          <div className="diag-empty-title">No data yet</div>
          <div>Waiting for diagnostics from this session.</div>
          <button className="diag-copy-link" onClick={() => copyDiagnosticBlock(fullDiagBlockId)}>
            {copiedCommandId === fullDiagBlockId ? "Copied" : "Copy full diagnostics block"}
          </button>
        </div>
      )}

      <div className="diag-grid">
        <DiagCard
          title="Wi-Fi"
          icon="🌐"
          health={toneFromStatus(wifi?.status)}
          primaryStatus={wifi?.summary || labelFromStatus(wifi?.status)}
          summaryFacts={buildWifiSummary(wifi)}
          sections={buildWifiSections(wifi)}
          expanded={expanded.wifi}
          onToggle={() => setExpanded((p) => ({ ...p, wifi: !p.wifi }))}
          updatedAt={cardUpdatedAt.wifi}
          commandHint={wifiNeedsRefresh ? "Limited data available." : undefined}
          onCopyCommand={wifiNeedsRefresh ? () => copyDiagnosticBlock("wifi") : undefined}
          copied={copiedCommandId === "wifi"}
        />

        <DiagCard
          title="Cellular"
          icon="📶"
          health={toneFromStatus(cellular?.status)}
          primaryStatus={cellular?.summary || labelFromStatus(cellular?.status)}
          summaryFacts={buildCellularSummary(cellular)}
          sections={buildCellularSections(cellular)}
          expanded={expanded.cellular}
          onToggle={() => setExpanded((p) => ({ ...p, cellular: !p.cellular }))}
          updatedAt={cardUpdatedAt.cellular}
          commandHint={cellularNeedsRefresh ? "Limited data available." : undefined}
          onCopyCommand={cellularNeedsRefresh ? () => copyDiagnosticBlock("cellular") : undefined}
          copied={copiedCommandId === "cellular"}
        />

        <DiagCard
          title="Satellite"
          icon="🛰️"
          health={toneFromStatus(satellite?.status)}
          primaryStatus={satellite?.summary || labelFromStatus(satellite?.status)}
          summaryFacts={buildSatelliteSummary(satellite)}
          sections={buildSatelliteSections(satellite)}
          expanded={expanded.satellite}
          onToggle={() => setExpanded((p) => ({ ...p, satellite: !p.satellite }))}
          updatedAt={cardUpdatedAt.satellite}
          commandHint={satelliteNeedsRefresh ? "Limited data available." : undefined}
          onCopyCommand={satelliteNeedsRefresh ? () => copyDiagnosticBlock("satellite") : undefined}
          copied={copiedCommandId === "satellite"}
        />

        <DiagCard
          title="Ethernet"
          icon="🔌"
          health={toneFromStatus(ethernet?.status)}
          primaryStatus={ethernet?.summary || labelFromStatus(ethernet?.status)}
          summaryFacts={buildEthernetSummary(ethernet)}
          sections={buildEthernetSections(ethernet)}
          expanded={expanded.ethernet}
          onToggle={() => setExpanded((p) => ({ ...p, ethernet: !p.ethernet }))}
          updatedAt={cardUpdatedAt.ethernet}
          commandHint={ethernetNeedsRefresh ? "Limited data available." : undefined}
          onCopyCommand={ethernetNeedsRefresh ? () => copyDiagnosticBlock("ethernet") : undefined}
          copied={copiedCommandId === "ethernet"}
        />
      </div>
    </section>
  );
}
