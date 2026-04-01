import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type DiagStatus = "green" | "orange" | "red" | "unknown";

interface WifiDiagnostic {
  status: DiagStatus;
  summary: string;
  ssid: string;
  strength: number;
  strength_label: string;
  signal_dbm?: number | null;
  ipv4: boolean;
  ipv6: boolean;
  dns_servers: string;
  internet_reachable: boolean;
  check_result: string;
  avg_latency_ms?: number | null;
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
  avg_latency_ms?: number | null;
  packet_loss_pct: number;
  imei?: string | null;
  iccid?: string | null;
  apn?: string | null;
  cell_status?: string | null;
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
}

interface DiagCardProps {
  title: string;
  icon: string;
  status: DiagStatus;
  summary: string;
  rows: { label: string; value: string }[];
}

function fmtBool(v: boolean | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v ? "Yes" : "No";
}

function fmtNum(v: number | null | undefined, suffix = ""): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${v}${suffix}`;
}

function DiagCard({ title, icon, status, summary, rows }: DiagCardProps) {
  const statusLabel =
    status === "green" ? "Healthy" :
      status === "orange" ? "Warning" :
        status === "red" ? "Error" : "Unknown";

  return (
    <article className={`diag-card ${status === "unknown" ? "diag-card-unknown" : ""}`}>
      <div className="diag-card-header">
        <div>{icon} {title}</div>
        <span className={`diag-status-dot diag-status-${status}`} />
      </div>
      <div className="diag-card-status">{statusLabel}</div>
      <div className="diag-card-summary">{summary}</div>
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

  useEffect(() => {
    invoke("start_log_watcher").catch(() => {});

    const id = setInterval(async () => {
      try {
        const state = await invoke<DiagnosticState>("get_diagnostic_state");
        setDiag(state);
        setLastUpdated(state.last_updated ?? null);
      } catch {
        // best effort
      }
    }, 2000);

    return () => clearInterval(id);
  }, []);

  const isEmpty = useMemo(() => {
    if (!diag) return true;
    return !diag.wifi && !diag.cellular && !diag.satellite && !diag.ethernet && !diag.system;
  }, [diag]);

  if (isEmpty) {
    return (
      <section className="tab-content diag-page">
        <h2>System Diagnostics</h2>
        <div className="diag-empty">
          <div>ℹ No session data yet.</div>
          <div>Launch a controller terminal and run diagnostic commands.</div>
          <div>Cards will populate automatically as output is detected.</div>
        </div>
      </section>
    );
  }

  const wifi = diag?.wifi;
  const cellular = diag?.cellular;
  const satellite = diag?.satellite;
  const ethernet = diag?.ethernet;
  const system = diag?.system;

  return (
    <section className="tab-content diag-page">
      <div className="diag-header">
        <div>
          <h2>System Diagnostics</h2>
          <div className="diag-system-line">
            SID {system?.sid ?? "—"} · {system?.version ?? "—"} · {system?.release_date ?? "—"}
          </div>
        </div>
        <div className="diag-updated">Last updated {lastUpdated ?? "—"}</div>
      </div>

      <div className="diag-grid">
        <DiagCard
          title="Wi-Fi"
          icon="🌐"
          status={wifi?.status ?? "unknown"}
          summary={wifi?.summary ?? "Run wifi-check to populate"}
          rows={[
            { label: "SSID", value: wifi?.ssid ?? "—" },
            { label: "Signal", value: wifi ? `${wifi.strength}/100 (${wifi.strength_label})` : "—" },
            ...(wifi?.signal_dbm !== null && wifi?.signal_dbm !== undefined ? [{ label: "Signal (dBm)", value: `${wifi.signal_dbm} dBm` }] : []),
            { label: "IPv4", value: fmtBool(wifi?.ipv4) },
            { label: "IPv6", value: fmtBool(wifi?.ipv6) },
            { label: "DNS", value: wifi?.dns_servers ?? "—" },
            ...(wifi?.avg_latency_ms !== null && wifi?.avg_latency_ms !== undefined ? [{ label: "Latency (avg)", value: `${wifi.avg_latency_ms.toFixed(1)} ms` }] : []),
            { label: "Packet loss", value: wifi ? `${wifi.packet_loss_pct}%` : "—" },
            { label: "Check result", value: wifi?.check_result ?? "—" },
          ]}
        />

        <DiagCard
          title="Cellular"
          icon="📶"
          status={cellular?.status ?? "unknown"}
          summary={cellular?.summary ?? "Run cellular-check to populate"}
          rows={[
            { label: "Provider", value: cellular ? `${cellular.provider} (${cellular.provider_code})` : "—" },
            { label: "Signal", value: cellular ? `${cellular.strength}/100 (${cellular.strength_label})` : "—" },
            { label: "IPv4", value: fmtBool(cellular?.ipv4) },
            { label: "IPv6", value: fmtBool(cellular?.ipv6) },
            { label: "DNS", value: cellular?.dns_servers ?? "—" },
            { label: "Latency (avg)", value: cellular?.avg_latency_ms ? `${cellular.avg_latency_ms.toFixed(1)} ms` : "—" },
            { label: "Packet loss", value: cellular ? `${cellular.packet_loss_pct}%` : "—" },
            ...(cellular?.imei ? [{ label: "IMEI", value: cellular.imei }] : []),
            ...(cellular?.iccid ? [{ label: "ICCID", value: cellular.iccid }] : []),
            ...(cellular?.apn ? [{ label: "APN", value: cellular.apn }] : []),
            ...(cellular?.cell_status ? [{ label: "Status", value: cellular.cell_status }] : []),
            { label: "Check result", value: cellular?.check_result ?? "—" },
          ]}
        />

        <DiagCard
          title="Satellite"
          icon="🛰️"
          status={satellite?.status ?? "unknown"}
          summary={satellite?.summary ?? "Run satellite-check to populate"}
          rows={[
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
          ]}
        />

        <DiagCard
          title="Ethernet"
          icon="🔌"
          status={ethernet?.status ?? "unknown"}
          summary={ethernet?.summary ?? "Run ethernet-check to populate"}
          rows={[
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
          ]}
        />
      </div>
    </section>
  );
}
