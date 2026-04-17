import {
  ReportAction,
  PressureStatusRow,
  ReportRecommendedAction,
  NetworkStatusRow,
  SessionReport,
} from "../types/report";

// ── Local types mirroring Rust DiagnosticState serialization ─────────────────

type DiagStatus = "unknown" | "grey" | "green" | "orange" | "red";

interface EthernetDiag {
  status: DiagStatus;
  summary: string;
  technology_disabled?: boolean;
  link_detected?: boolean | null;
  flap_count?: number;
  internet_reachable?: boolean | null;
  check_result?: string | null;
}

interface WifiDiag {
  status: DiagStatus;
  summary: string;
  check_result?: string | null;
  check_error?: string | null;
  connected?: boolean | null;
  connman_wifi_connected?: boolean | null;
  internet_reachable?: boolean | null;
  connman_wifi_powered?: boolean | null;
  strength_score?: number | null;
  strength_label?: string | null;
  signal_dbm?: number | null;
  tx_bitrate_mbps?: number | null;
  station_tx_bitrate_mbps?: number | null;
  ssid?: string | null;
  access_point?: string | null;
}

interface CellularDiag {
  status: DiagStatus;
  summary: string;
  check_result?: string | null;
  check_error?: string | null;
  connman_cell_connected?: boolean | null;
  connman_cell_powered?: boolean | null;
  pdp_active?: boolean | null;
  internet_reachable?: boolean | null;
  sim_inserted?: boolean | null;
  provider_code?: string | null;
  imsi?: string | null;
  operator_name?: string | null;
  strength_score?: number | null;
  strength_label?: string | null;
  modem_not_present?: boolean;
  modem_unreachable?: boolean;
  no_service?: boolean;
}

type SimPickerRec =
  | "NotRun" | "ScanFailed" | "DeadZone" | "KeepCurrent" | "WeakButBest"
  | { SwapTo: string };

interface SimPickerDiag {
  scan_attempted: boolean;
  scan_completed: boolean;
  scan_failed: boolean;
  scan_empty: boolean;
  installed_carrier_name?: string | null;
  installed_carrier_detected: boolean;
  best_network_name?: string | null;
  recommendation: SimPickerRec;
  recommendation_detail: string;
  nwscanmode?: number | null;
}

interface SatelliteDiag {
  status: DiagStatus;
  summary: string;
  modem_present?: boolean | null;
  satellite_state?: string | null;
  satellites_seen?: number | null;
  light_test_ran?: boolean;
  light_test_success?: boolean | null;
  loopback_test_ran?: boolean;
  loopback_test_success?: boolean | null;
  sat_imei?: string | null;
  loopback_duration_seconds?: number | null;
  total_time_seconds?: number | null;
  loopback_packet_loss_pct?: number | null;
  recommended_action?: string | null;
  other_actions?: string[] | null;
}

interface SystemDiag {
  sid?: string | null;
  version?: string | null;
}

interface PressureDiag {
  status: DiagStatus;
  summary: string;
  sensors?: {
    source?: { latest: number } | null;
    distribution?: { latest: number } | null;
  };
  issues?: Array<{ id: string; severity: DiagStatus; title: string; description: string; action: string }>;
}

interface DiagnosticState {
  ethernet?: EthernetDiag | null;
  wifi?: WifiDiag | null;
  cellular?: CellularDiag | null;
  satellite?: SatelliteDiag | null;
  pressure?: PressureDiag | null;
  system?: SystemDiag | null;
  sim_picker?: SimPickerDiag | null;
}

interface AppState {
  controller_ip?: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusEmoji(status: DiagStatus | string): string {
  if (status === "green") return "✅";
  if (status === "orange") return "⚠️";
  if (status === "red") return "❌";
  return "⏺";
}

function toReportStatus(status?: DiagStatus | null): "green" | "orange" | "red" | "unknown" {
  if (status === "green") return "green";
  if (status === "orange") return "orange";
  if (status === "red") return "red";
  return "unknown";
}

function normalizePressureIssueTitle(title: string): string {
  return title
    .replace(/^P3 Source Pressure\b/i, "P3")
    .replace(/^P2 Distribution Pressure\b/i, "P2")
    .replace(/^P1 Supply Pressure\b/i, "P1")
    .trim();
}

function titleCase(value?: string | null): string | null {
  if (!value) return null;
  const clean = value.replace(/^"+|"+$/g, "").trim();
  if (!clean) return null;
  return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
}

function qualityLabel(score?: number | null, label?: string | null): string {
  const fromLabel = titleCase(label);
  if (fromLabel) return fromLabel;
  if (score === null || score === undefined) return "Unknown";
  if (score >= 75) return "Strong";
  if (score >= 50) return "Average";
  if (score >= 25) return "Fair";
  if (score > 0) return "Weak";
  return "No service";
}

function resolveCarrierCode(code?: string | null): string | null {
  if (!code) return null;
  if (!/^\d{5,6}$/.test(code)) return code;
  const map: Record<string, string> = {
    "311270": "Verizon", "311271": "Verizon", "311272": "Verizon", "311273": "Verizon",
    "311274": "Verizon", "311275": "Verizon", "311276": "Verizon", "311277": "Verizon",
    "311278": "Verizon", "311279": "Verizon", "311280": "Verizon", "311480": "Verizon",
    "311481": "Verizon", "311482": "Verizon", "311483": "Verizon", "311484": "Verizon",
    "311485": "Verizon", "311486": "Verizon", "311487": "Verizon", "311488": "Verizon",
    "311489": "Verizon",
    "310260": "T-Mobile", "310026": "T-Mobile", "310490": "T-Mobile", "310660": "T-Mobile",
    "312250": "T-Mobile", "310230": "T-Mobile", "310240": "T-Mobile", "310250": "T-Mobile",
    "310410": "AT&T", "310380": "AT&T", "310980": "AT&T", "311180": "AT&T",
    "310030": "AT&T", "310560": "AT&T", "310680": "AT&T",
    "313100": "FirstNet (AT&T)",
    "310000": "Dish",
  };
  return map[code] ?? code;
}

function formatEthernetSummary(eth: EthernetDiag): string {
  const checkResultLower = (eth.check_result || "").toLowerCase();
  const notConnected = checkResultLower.startsWith("failure")
    && (checkResultLower.includes("-65554")
      || checkResultLower.includes("network technology is not connected"));
  if (notConnected) return "No Ethernet link";
  if (eth.link_detected === false) return "No Ethernet link";
  if (eth.status === "grey") return "Inactive — technology disabled";
  if (eth.status === "green") return "Connected";
  if (eth.status === "red") return "No connection";
  return eth.summary || "Unknown";
}

function formatWifiSummary(wifi: WifiDiag): string {
  const connected = wifiConnectedState(wifi);

  if (!connected) {
    // Extract a human-readable reason from the check_result/check_error, e.g.
    // "Done: Failure: -65553: Network technology is not enabled" → "Network technology is not enabled"
    const raw = wifi.check_error || wifi.check_result || null;
    if (raw) {
      const meaningful = raw.split(":").map((p: string) => p.trim())
        .find((p: string) => p && !/^(done|failure|success|-?\d+)$/i.test(p));
      // Skip connman's generic "is not connected" — it just means WiFi is unassociated,
      // which is already captured by "Not connected". Keep specific reasons like
      // "Network technology is not enabled" or "Association failed".
      if (meaningful && !/\bis not connected\b/i.test(meaningful)) {
        return `Not connected — ${meaningful}`;
      }
    }
    return "Not connected";
  }

  const network = wifi.ssid || wifi.access_point || "Unknown network";
  const quality = qualityLabel(wifi.strength_score, wifi.strength_label);
  const scorePart = wifi.strength_score !== null && wifi.strength_score !== undefined
    ? ` ${wifi.strength_score}/100`
    : "";
  const dbmPart = wifi.signal_dbm !== null && wifi.signal_dbm !== undefined
    ? ` (${wifi.signal_dbm} dBm)`
    : "";
  const speedMbps = wifi.tx_bitrate_mbps ?? wifi.station_tx_bitrate_mbps;
  const speedPart = speedMbps !== null && speedMbps !== undefined
    ? ` · ${speedMbps.toFixed(1)} Mbps`
    : "";
  return `${network} · 📶 ${quality}${scorePart}${dbmPart}${speedPart}`;
}

function formatSatelliteSummary(sat: SatelliteDiag): string {
  const state = sat.satellite_state === "manager_unresponsive"
    ? "Satellite test unavailable"
    : sat.loopback_test_success === true
    ? "Link verified"
    : sat.loopback_test_ran
      ? "Loopback failed"
      : sat.summary || "Not validated";
  const details: string[] = [];
  const duration = sat.loopback_duration_seconds ?? sat.total_time_seconds;
  if (duration !== null && duration !== undefined) {
    const rounded = Math.round(duration);
    const mins = Math.floor(rounded / 60);
    const secs = rounded % 60;
    details.push(mins > 0 ? `Duration ${mins}m ${secs}s` : `Duration ${secs}s`);
  }
  if (sat.loopback_packet_loss_pct !== null && sat.loopback_packet_loss_pct !== undefined) {
    details.push(`Loss ${sat.loopback_packet_loss_pct}%`);
  }
  return details.length ? `${state} · ${details.join(" · ")}` : state;
}

function formatCellSummary(cell: CellularDiag): string {
  if (cell.modem_not_present) return "No modem detected";
  if (cell.modem_unreachable) return "Modem not responding — reboot controller";

  const connected = cellularConnectedState(cell);
  const carrierLabel = resolveCarrierCode(cell.operator_name || cell.provider_code) || "Cellular";

  if (!connected) {
    if (cell.sim_inserted === false) return "No SIM detected";
    if (cellularExplicitNoService(cell)) {
      const carrier = resolveCarrierCode(cell.operator_name || cell.provider_code);
      return carrier ? `${carrier} — No service` : "No service";
    }
    const carrier = resolveCarrierCode(cell.operator_name || cell.provider_code);
    return carrier ? `${carrier} — Not connected` : "Not connected";
  }

  const quality = qualityLabel(cell.strength_score, cell.strength_label);
  const scorePart = cell.strength_score !== null && cell.strength_score !== undefined
    ? ` ${cell.strength_score}/100`
    : "";
  return `${carrierLabel} · 📶 ${quality}${scorePart}`;
}

function wifiHasAuthoritativeCheck(wifi?: WifiDiag | null): boolean {
  return !!wifi && ((wifi.check_result ?? "Unknown") !== "Unknown" || !!wifi.check_error);
}

function wifiCheckConnected(wifi?: WifiDiag | null): boolean {
  return !!wifi
    && wifi.check_result === "Success"
    && (wifi.internet_reachable !== false);
}

function wifiConnectedState(wifi?: WifiDiag | null): boolean {
  if (!wifi) return false;
  if (wifiHasAuthoritativeCheck(wifi)) return wifiCheckConnected(wifi);
  return wifi.connected === true || wifi.connman_wifi_connected === true || wifi.internet_reachable === true;
}

function wifiReportStatus(wifi?: WifiDiag | null): "green" | "orange" | "red" | "unknown" {
  if (!wifi) return "unknown";
  const connected = wifiConnectedState(wifi);
  const weakByLabel = (wifi.strength_label ?? "").toLowerCase() === "weak";
  const weakByScore = (wifi.strength_score ?? 0) > 0 && (wifi.strength_score ?? 0) < 25;
  const notEnabled = (wifi.check_error || "").toLowerCase().includes("-65553")
    || (wifi.check_error || "").toLowerCase().includes("not enabled")
    || wifi.connman_wifi_powered === false;
  if (!connected) return notEnabled ? "orange" : "unknown";
  if (weakByLabel || weakByScore) return "orange";
  if (wifi.check_result === "Failure") return "orange";
  return "green";
}

function cellularHasAuthoritativeCheck(cell?: CellularDiag | null): boolean {
  return !!cell && ((cell.check_result ?? "Unknown") !== "Unknown" || !!cell.check_error);
}

function cellularCheckConnected(cell?: CellularDiag | null): boolean {
  return !!cell
    && cell.check_result === "Success"
    && (cell.internet_reachable !== false);
}

function cellularConnectedState(cell?: CellularDiag | null): boolean {
  if (!cell) return false;
  if (cellularHasAuthoritativeCheck(cell)) return cellularCheckConnected(cell);
  return cell.connman_cell_connected === true || cell.pdp_active === true || cell.internet_reachable === true;
}

function cellularExplicitNoService(cell?: CellularDiag | null): boolean {
  if (!cell) return false;
  if (cellularConnectedState(cell)) return false;
  const checkError = (cell.check_error || "").toLowerCase();
  return cell.no_service === true
    || checkError.includes("network technology is not connected")
    || checkError.includes("-65554");
}

function cellularReportStatus(cell?: CellularDiag | null): "green" | "orange" | "red" | "unknown" {
  if (!cell) return "unknown";
  if (cell.modem_not_present || cell.modem_unreachable || cellularExplicitNoService(cell)) return "red";
  if (cell.sim_inserted === false || cell.connman_cell_powered === false) return "unknown";
  if (!cellularConnectedState(cell)) return "unknown";
  if ((cell.strength_score ?? 0) > 0 && (cell.strength_score ?? 0) < 25) return "orange";
  return "green";
}

// ── generateActions ───────────────────────────────────────────────────────────

export function generateActions(
  diag: DiagnosticState,
  _appState: AppState,
): ReportAction[] {
  const actions: ReportAction[] = [];
  let id = 0;
  const mkId = () => String(++id);

  // Diagnostics run — auto-updated each poll, marked so polling can replace just this row
  const diagRun: string[] = [];
  const networkRows = generateNetworkRows(diag);
  const networkStatus = Object.fromEntries(networkRows.map(row => [row.interface, row.status])) as Record<NetworkStatusRow["interface"], NetworkStatusRow["status"]>;
  if (diag.ethernet) diagRun.push(`Ethernet ${statusEmoji(networkStatus.Ethernet)}`);
  if (diag.wifi) diagRun.push(`Wi-Fi ${statusEmoji(networkStatus["Wi-Fi"])}`);
  if (diag.cellular) diagRun.push(`Cellular ${statusEmoji(networkStatus.Cellular)}`);
  if (diag.satellite) diagRun.push(`Satellite ${statusEmoji(networkStatus.Satellite)}`);
  if (diag.pressure) diagRun.push(`Pressure ${statusEmoji(toReportStatus(diag.pressure.status))}`);

  if (diagRun.length > 0) {
    actions.push({
      id: mkId(),
      key: "diagnostics-run",
      text: `Diagnostics run: ${diagRun.join(" · ")}`,
      dismissed: false,
      autoGenerated: true,
    });
  }

  return actions;
}

// ── generateNetworkRows ───────────────────────────────────────────────────────

export function generateNetworkRows(diag: DiagnosticState): NetworkStatusRow[] {
  // Mirror the diag card summarize logic: inactive / no-link interfaces show
  // gray ("unknown") rather than the raw backend "red" status, which the backend
  // emits even for simply-unconfigured interfaces. This keeps the report status
  // dots consistent with what the diag cards display.
  const wifiConnected = wifiConnectedState(diag.wifi);
  const ethLinked = diag.ethernet?.link_detected === true
    || diag.ethernet?.internet_reachable === true;

  // "Not enabled" WiFi shows amber to indicate configuration is needed, not just
  // an unplugged cable. Mirrors the warning health added to the diag card.
  const wifiCheckErrLower = (diag.wifi?.check_error || "").toLowerCase();
  const wifiNotEnabled = wifiCheckErrLower.includes("-65553")
    || wifiCheckErrLower.includes("not enabled")
    || diag.wifi?.connman_wifi_powered === false;

  return [
    {
      interface: "Ethernet",
      status: !diag.ethernet ? "unknown" : (ethLinked ? toReportStatus(diag.ethernet.status) : "unknown"),
      summary: diag.ethernet ? formatEthernetSummary(diag.ethernet) : "Diagnostics not collected",
    },
    {
      interface: "Wi-Fi",
      status: !diag.wifi
          ? "unknown"
          : wifiConnected || wifiNotEnabled
            ? wifiReportStatus(diag.wifi)
            : "unknown",
      summary: diag.wifi ? formatWifiSummary(diag.wifi) : "Diagnostics not collected",
    },
    {
      interface: "Cellular",
      status: cellularReportStatus(diag.cellular),
      summary: diag.cellular ? formatCellSummary(diag.cellular) : "Diagnostics not collected",
    },
    {
      interface: "Satellite",
      status: toReportStatus(diag.satellite?.status),
      summary: diag.satellite ? formatSatelliteSummary(diag.satellite) : "Diagnostics not collected",
    },
  ];
}

export function generatePressureRows(diag: DiagnosticState): PressureStatusRow[] {
  const PRESSURE_NEAR_ZERO_DISPLAY_THRESHOLD = 0.5;
  const pressure = diag.pressure;
  const source = pressure?.sensors?.source?.latest;
  const distribution = pressure?.sensors?.distribution?.latest;
  const hasValidSource = (v?: number | null) => v !== null && v !== undefined && v >= 0 && v <= 218;
  const hasReportableDistribution = (v?: number | null) =>
    v !== null
    && v !== undefined
    && v <= 218
    && (v >= 0 || Math.abs(v) < PRESSURE_NEAR_ZERO_DISPLAY_THRESHOLD);
  const formatDistribution = (v: number) =>
    Math.abs(v) < PRESSURE_NEAR_ZERO_DISPLAY_THRESHOLD ? "~0.0 PSI" : `${v.toFixed(2)} PSI`;
  const readingParts: string[] = [];
  if (hasValidSource(source)) readingParts.push(`P3 ${source!.toFixed(2)} PSI`);
  if (hasReportableDistribution(distribution)) readingParts.push(`P2 ${formatDistribution(distribution!)}`);
  const issueTitles = (pressure?.issues ?? []).map((i) => normalizePressureIssueTitle(i.title)).join(" · ");
  const summary = readingParts.length > 0
    ? `${issueTitles ? `${issueTitles} · ` : ""}${readingParts.join(" · ")}`
    : pressure?.summary ?? "Diagnostics not collected";

  return [{
    label: "System Pressure",
    status: toReportStatus(pressure?.status),
    summary,
  }];
}

// ── generateRecommendedActions ────────────────────────────────────────────────

export function generateRecommendedActions(
  diag: DiagnosticState,
): ReportRecommendedAction[] {
  const actions: ReportRecommendedAction[] = [];
  let id = 0;
  const mkId = () => String(++id);

  // ── ETHERNET ──────────────────────────────────────────────────────────────
  if (diag.ethernet) {
    const eth = diag.ethernet;

    if (eth.status === "red" && (eth.flap_count ?? 0) > 3) {
      actions.push({
        id: mkId(), interface: "Ethernet",
        text: "Swap switch port",
        detail: `Link flapping detected — ${eth.flap_count} events. Force switch port speed or move to different port.`,
        dismissed: false, checked: false, custom: false,
      });
    } else if (eth.status === "red" && eth.link_detected === false) {
      actions.push({
        id: mkId(), interface: "Ethernet",
        text: "Check cable and switch port",
        detail: "No physical link detected. Verify cable is seated and switch port is active.",
        dismissed: false, checked: false, custom: false,
      });
    } else if (eth.status === "orange") {
      actions.push({
        id: mkId(), interface: "Ethernet",
        text: "Check router upstream connectivity",
        detail: "Link is up but DNS or internet is failing. Issue is likely upstream of the controller.",
        dismissed: false, checked: false, custom: false,
      });
    }
  }

  // ── WI-FI ─────────────────────────────────────────────────────────────────
  if (diag.wifi) {
    const wifi = diag.wifi;

    if (wifi.status === "red" && wifi.check_result === "Failure") {
      actions.push({
        id: mkId(), interface: "Wi-Fi",
        text: "Configure Wi-Fi",
        detail: "Re-run setup-wifi and configure to verified SSID and password.",
        dismissed: false, checked: false, custom: false,
      });
    } else if (wifi.status === "red" && (wifi.strength_score ?? 100) < 40) {
      actions.push({
        id: mkId(), interface: "Wi-Fi",
        text: "Relocate router or add repeater",
        detail: `Signal critically weak — ${wifi.strength_score}/100. Controller may lose Wi-Fi intermittently.`,
        dismissed: false, checked: false, custom: false,
      });
    } else if (
      wifi.status === "orange" &&
      ((wifi.strength_score ?? 100) < 60 || (wifi.strength_label ?? "").toLowerCase() === "weak")
    ) {
      actions.push({
        id: mkId(), interface: "Wi-Fi",
        text: "Improve Wi-Fi coverage",
        detail: `Signal ${wifi.strength_score ?? "?"}/100 (${wifi.strength_label ?? "weak"}). Move AP closer or add a repeater to improve reliability.`,
        dismissed: false, checked: false, custom: false,
      });
    }
  }

  // ── CELLULAR ──────────────────────────────────────────────────────────────
  if (diag.cellular) {
    const cell = diag.cellular;

    if (cell.modem_unreachable) {
      actions.push({
        id: mkId(), interface: "Cellular",
        text: "Reboot controller — modem not responding",
        detail: "Hardware detected but AT interface failed. Reboot resolves this in most cases. If issue persists after reboot, reseat the modem.",
        dismissed: false, checked: false, custom: false,
      });
      // modem_unreachable takes precedence — skip other cellular actions
    } else {
      if (cell.modem_not_present) {
        actions.push({
          id: mkId(), interface: "Cellular",
          text: "Check modem connection / seating",
          detail: "No modem detected. Verify modem board is seated, then reboot controller.",
          dismissed: false, checked: false, custom: false,
        });
      }

      const noService = !cell.connman_cell_connected && !cell.pdp_active;

      if (noService && cell.sim_inserted === false) {
        actions.push({
          id: mkId(), interface: "Cellular",
          text: "Check SIM card is seated correctly",
          detail: "Modem detected but SIM not found. Reseat SIM or try a known-good SIM.",
          dismissed: false, checked: false, custom: false,
        });
      } else if (noService && cell.sim_inserted) {
        // If SIM Picker has already run and recommends a swap, surface that
        const sp = diag.sim_picker;
        if (sp?.scan_completed && !sp.scan_empty) {
          const rec = sp.recommendation;
          if (typeof rec === "object" && "SwapTo" in rec) {
            actions.push({
              id: mkId(), interface: "Cellular",
              text: `Install ${rec.SwapTo} SIM`,
              detail: sp.recommendation_detail,
              dismissed: false, checked: false, custom: false,
            });
          } else if (sp.scan_empty) {
            actions.push({
              id: mkId(), interface: "Cellular",
              text: "No carrier coverage at this location",
              detail: "SIM Picker found no detectable carriers. Check antenna and sky view.",
              dismissed: false, checked: false, custom: false,
            });
          }
        } else {
          actions.push({
            id: mkId(), interface: "Cellular",
            text: "Check coverage area and antenna",
            detail: "SIM detected but no network service. Verify antenna connection and site coverage.",
            dismissed: false, checked: false, custom: false,
          });
          actions.push({
            id: mkId(), interface: "Cellular",
            text: "Reboot controller",
            detail: "After checking coverage and antenna, reboot and retry cellular diagnostics.",
            dismissed: false, checked: false, custom: false,
          });
        }
      } else if (cell.status === "orange" && (cell.strength_score ?? 100) < 50) {
        actions.push({
          id: mkId(), interface: "Cellular",
          text: "Check antenna connection and placement",
          detail: `Signal ${cell.strength_score}/100. Verify antenna is hand-tight and not obstructed.`,
          dismissed: false, checked: false, custom: false,
        });
      }
    }
  }

  // ── SATELLITE ─────────────────────────────────────────────────────────────
  if (diag.satellite) {
    const sat = diag.satellite;
    const addSatelliteAction = (text: string, detail = "") => {
      if (!text.trim()) return;
      const exists = actions.some((action) =>
        action.interface === "Satellite"
        && action.text === text
        && action.detail === detail
      );
      if (exists) return;
      actions.push({
        id: mkId(), interface: "Satellite",
        text,
        detail,
        dismissed: false, checked: false, custom: false,
      });
    };

    const satelliteDetails = new Map<string, string>();
    if (sat.modem_present === false) {
      satelliteDetails.set("Check satellite modem / hardware connection", "No satellite modem detected. Verify the modem is present, seated, and connected.");
      satelliteDetails.set("Reboot controller", "After checking the modem/hardware connection, reboot and rerun satellite diagnostics.");
    }
    if (sat.satellite_state === "manager_unresponsive") {
      satelliteDetails.set("Reboot controller and retry satellite loopback test", "satellite-check -t returned \"Network Manager\" never responded.");
      satelliteDetails.set("Re-run satellite setup and retry test", "Refresh satellite configuration before rerunning the loopback test.");
      satelliteDetails.set("If issue persists, reinstall firmware, reconfigure controller, rerun satellite setup, and retry test", "Use this when the Network Manager response failure survives reboot and setup retry.");
    }
    if (sat.loopback_test_ran && sat.loopback_test_success === false) {
      satelliteDetails.set("Check antenna placement and provisioning", "Loopback test failed. Verify provisioning, connector integrity, and unobstructed sky view.");
      satelliteDetails.set("Move antenna to clear sky", "Ensure the antenna has a clear, unobstructed view of the sky.");
      satelliteDetails.set("Retry loopback test", "Re-run the full loopback test after correcting antenna placement or provisioning issues.");
      satelliteDetails.set("Retry when satellite service is not in use", "Retry once the satellite service is idle so the loopback test can run.");
    }
    if ((sat.satellites_seen ?? null) === 0) {
      satelliteDetails.set("Check antenna placement and connection", "No satellites are visible. Verify cable connection and antenna placement.");
      satelliteDetails.set("Move antenna to clear sky", "Ensure the antenna has a clear, unobstructed view of the sky.");
      satelliteDetails.set("Retry quick satellite check", "Run a quick satellite check again after improving placement.");
    }
    if (sat.light_test_ran && sat.light_test_success === false) {
      satelliteDetails.set("Run full loopback test for details", "Quick satellite check failed. Run the full loopback test for a more specific diagnosis.");
    }
    if (sat.modem_present === true && sat.status !== "green") {
      satelliteDetails.set("Run full satellite loopback test", "Satellite hardware is present but this session does not yet include a full loopback verification.");
    }

    const parserDrivenActions = [
      sat.recommended_action,
      ...((sat.other_actions ?? []).filter(Boolean)),
    ].filter((value): value is string => !!value);

    for (const text of parserDrivenActions) {
      addSatelliteAction(text, satelliteDetails.get(text) ?? "");
    }

    if (parserDrivenActions.length === 0 && sat.satellite_state === "manager_unresponsive") {
      addSatelliteAction(
        "Reboot controller and retry satellite loopback test",
        "satellite-check -t returned \"Network Manager\" never responded.",
      );
      addSatelliteAction(
        "Re-run satellite setup and retry test",
        "Refresh satellite configuration before rerunning the loopback test.",
      );
      addSatelliteAction(
        "If issue persists, reinstall firmware, reconfigure controller, rerun satellite setup, and retry test",
        "Use this when the Network Manager response failure survives reboot and setup retry.",
      );
    } else if (parserDrivenActions.length === 0 && sat.status === "red" && sat.loopback_test_success === false) {
      addSatelliteAction(
        "Check antenna cabling and sky view",
        "Loopback test failed. Verify N-type connector is hand-tight, cable has no sharp bends, and antenna has clear unobstructed sky view.",
      );
    } else if (parserDrivenActions.length === 0 && sat.status === "orange" && !sat.loopback_test_ran) {
      addSatelliteAction(
        "Run satellite-check -t to verify connectivity",
        "Satellite configured but loopback not yet tested this session.",
      );
    }
  }

  // ── PRESSURE ──────────────────────────────────────────────────────────────
  if (diag.pressure?.issues?.length) {
    for (const issue of diag.pressure.issues) {
      actions.push({
        id: mkId(), interface: "Pressure",
        text: issue.title,
        detail: `${issue.description} ${issue.action}`.trim(),
        dismissed: false, checked: false, custom: false,
      });
    }
  }

  // Sort: red issues first, then orange
  return actions.sort((a, b) => {
    const priority = (action: ReportRecommendedAction): number => {
      if (action.custom) return 2;
      const diagMap: Record<string, DiagStatus | undefined> = {
        Ethernet: diag.ethernet?.status,
        "Wi-Fi": diag.wifi?.status,
        Cellular: diag.cellular?.status,
        Satellite: diag.satellite?.status,
        Pressure: diag.pressure?.status,
      };
      const status = diagMap[action.interface];
      return status === "red" ? 0 : status === "orange" ? 1 : 2;
    };
    return priority(a) - priority(b);
  });
}

function slackStatusDot(status: "green" | "orange" | "red" | "unknown"): string {
  if (status === "green") return "🟢";
  if (status === "orange") return "🟠";
  if (status === "red") return "🔴";
  return "⚪";
}

function parsePressureSummary(row: PressureStatusRow): {
  dot: string;
  label: string;
  statusText: string;
  details: Array<{ label: string; value: string }>;
} {
  const parts = row.summary.split(" · ").map(part => part.trim()).filter(Boolean);
  const measurementParts = parts.filter(part => /^P\d\s+.+\bPSI$/i.test(part));
  const statusParts = parts.filter(part => !/^P\d\s+.+\bPSI$/i.test(part));
  const details = measurementParts.map((part) => {
    const match = /^P(\d)\s+(.+)$/i.exec(part);
    if (!match) return { label: part, value: "" };
    const label = match[1] === "1"
      ? "P1 Supply"
      : match[1] === "2"
        ? "P2 Distribution"
        : "P3 Source";
    return { label, value: match[2] };
  });

  return {
    dot: slackStatusDot(row.status),
    label: row.label,
    statusText: statusParts.join(" · ").trim(),
    details,
  };
}

// ── formatSlack ───────────────────────────────────────────────────────────────

export function formatSlack(report: SessionReport): string {
  const lines: string[] = [];

  lines.push(`*Controller Session — ${report.date}*`);
  lines.push(`*SID:* ${report.sid || "—"} · ${report.version || "—"}`);
  lines.push("");

  const visibleActions = report.actions.filter(a => !a.dismissed);
  if (visibleActions.length > 0) {
    lines.push("*Actions*");
    visibleActions.forEach(a => {
      const text = a.text.startsWith("Diagnostics run:")
        ? a.text.replace("Diagnostics run:", "*Diagnostics run:*")
        : a.text;
      lines.push(`• ${text}`);
    });
    lines.push("");
  }

  lines.push("*Network*");
  report.networkRows.forEach(row => {
    const dot = slackStatusDot(row.status);
    const note = report.networkNotes[row.interface];
    const noteSuffix = note ? ` — ${note}` : "";
    lines.push(`${dot} *${row.interface}*: ${row.summary}${noteSuffix}`);
  });
  lines.push("");

  if (report.pressureRows.length > 0) {
    lines.push("*Pressure Readings*");
    report.pressureRows.forEach(row => {
      const pressure = parsePressureSummary(row);
      lines.push(pressure.statusText
        ? `${pressure.dot}*${pressure.label}* — ${pressure.statusText}`
        : `${pressure.dot}*${pressure.label}*`);
      pressure.details.forEach(detail => lines.push(`• *${detail.label}:* ${detail.value}`));
    });
    lines.push("");
  }

  const visibleRecs = report.recommendedActions.filter(a => !a.dismissed);
  if (visibleRecs.length > 0) {
    lines.push("*Recommended Actions*");
    visibleRecs.forEach(a => {
      const checkbox = a.checked ? "✓" : "☐";
      lines.push(`${checkbox} *${a.interface}* — ${a.text}`);
      if (a.detail) lines.push(`  • ${a.detail}`);
    });
    lines.push("");
  }

  if (report.notes.trim()) {
    lines.push("*Notes*");
    lines.push(report.notes.trim());
    lines.push("");
  }

  const outcomeLabel = report.outcome === "complete" ? "Complete"
    : report.outcome === "escalated" ? "Escalated"
    : "Follow-up needed";
  lines.push(`*Outcome:* ${outcomeLabel}`);

  return lines.join("\n");
}

function escapeSlackHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatSlackHtml(report: SessionReport): string {
  const blocks: string[] = [];
  const pushLine = (content = "") => {
    blocks.push(content ? `<div>${content}</div>` : "<div><br></div>");
  };

  pushLine(`<b>${escapeSlackHtml(`Controller Session — ${report.date}`)}</b>`);
  pushLine(`<b>SID:</b> ${escapeSlackHtml(report.sid || "—")} · ${escapeSlackHtml(report.version || "—")}`);
  pushLine();

  const visibleActions = report.actions.filter(a => !a.dismissed);
  if (visibleActions.length > 0) {
    pushLine("<b><u>Actions</u></b>");
    visibleActions.forEach(a => {
      if (a.text.startsWith("Diagnostics run:")) {
        const suffix = a.text.slice("Diagnostics run:".length);
        pushLine(`• <b>Diagnostics run:</b>${escapeSlackHtml(suffix)}`);
        return;
      }
      pushLine(escapeSlackHtml(`• ${a.text}`));
    });
    pushLine();
  }

  pushLine("<b><u>Network</u></b>");
  report.networkRows.forEach(row => {
    const note = report.networkNotes[row.interface];
    const noteSuffix = note ? ` — ${note}` : "";
    pushLine(`${escapeSlackHtml(`${slackStatusDot(row.status)} `)}<b>${escapeSlackHtml(`${row.interface}:`)}</b> ${escapeSlackHtml(`${row.summary}${noteSuffix}`)}`);
  });
  pushLine();

  if (report.pressureRows.length > 0) {
    pushLine("<b><u>Pressure Readings</u></b>");
    report.pressureRows.forEach(row => {
      const pressure = parsePressureSummary(row);
      pushLine(
        pressure.statusText
          ? `${escapeSlackHtml(`${pressure.dot}`)}<b>${escapeSlackHtml(pressure.label)}</b> — ${escapeSlackHtml(pressure.statusText)}`
          : `${escapeSlackHtml(`${pressure.dot}`)}<b>${escapeSlackHtml(pressure.label)}</b>`
      );
      pressure.details.forEach(detail => {
        pushLine(`• <b>${escapeSlackHtml(`${detail.label}:`)}</b> ${escapeSlackHtml(detail.value)}`);
      });
    });
    pushLine();
  }

  const visibleRecs = report.recommendedActions.filter(a => !a.dismissed);
  if (visibleRecs.length > 0) {
    pushLine("<b><u>Recommended Actions</u></b>");
    visibleRecs.forEach(a => {
      const checkbox = a.checked ? "✓" : "☐";
      pushLine(`${escapeSlackHtml(`${checkbox} `)}<b>${escapeSlackHtml(a.interface)}</b> ${escapeSlackHtml(`— ${a.text}`)}`);
      if (a.detail) pushLine(escapeSlackHtml(`  • ${a.detail}`));
    });
    pushLine();
  }

  if (report.notes.trim()) {
    pushLine("<b>Notes</b>");
    pushLine(escapeSlackHtml(report.notes.trim()));
    pushLine();
  }

  const outcomeLabel = report.outcome === "complete" ? "Complete"
    : report.outcome === "escalated" ? "Escalated"
    : "Follow-up needed";
  pushLine(`<b>Outcome:</b> ${escapeSlackHtml(outcomeLabel)}`);

  return `<meta charset="utf-8">${blocks.join("")}`;
}

// ── formatJira ────────────────────────────────────────────────────────────────

export function formatJira(report: SessionReport): string {
  const lines: string[] = [];

  lines.push(`h2. Controller Session — ${report.date}`);
  lines.push(`*SID:* ${report.sid || "—"} | *Firmware:* ${report.version || "—"} | *IP:* ${report.ip || "—"}`);
  lines.push("");

  const visibleActions = report.actions.filter(a => !a.dismissed);
  if (visibleActions.length > 0) {
    lines.push("h3. Actions");
    visibleActions.forEach(a => lines.push(`* ${a.text}`));
    lines.push("");
  }

  lines.push("h3. Network Status");
  lines.push("|| Interface || Status || Detail ||");
  report.networkRows.forEach(row => {
    const statusLabel = row.status === "green" ? "Connected"
      : row.status === "orange" ? "Warning"
      : row.status === "red" ? "Failed"
      : "No data";
    const note = report.networkNotes[row.interface];
    const detail = note ? `${row.summary} — ${note}` : row.summary;
    lines.push(`| ${row.interface} | ${statusLabel} | ${detail} |`);
  });
  lines.push("");

  if (report.pressureRows.length > 0) {
    lines.push("h3. Pressure Readings");
    lines.push("|| Sensor || Status || Detail ||");
    report.pressureRows.forEach(row => {
      const statusLabel = row.status === "green" ? "OK"
        : row.status === "orange" ? "Warning"
        : row.status === "red" ? "Error"
        : "No data";
      lines.push(`| ${row.label} | ${statusLabel} | ${row.summary} |`);
    });
    lines.push("");
  }

  const visibleRecs = report.recommendedActions.filter(a => !a.dismissed);
  if (visibleRecs.length > 0) {
    lines.push("h3. Recommended Actions");
    visibleRecs.forEach(a => {
      const done = a.checked ? " ✓ Done" : "";
      lines.push(`* ${a.interface} — ${a.text}${done}`);
      if (a.detail) lines.push(`** ${a.detail}`);
    });
    lines.push("");
  }

  if (report.notes.trim()) {
    lines.push("h3. Notes");
    lines.push(report.notes.trim());
    lines.push("");
  }

  const outcomeLabel = report.outcome === "complete" ? "Complete"
    : report.outcome === "escalated" ? "Escalated"
    : "Follow-up needed";
  lines.push(`*Outcome:* ${outcomeLabel}`);

  return lines.join("\n");
}
