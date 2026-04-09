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
  link_detected?: boolean | null;
  flap_count?: number;
}

interface WifiDiag {
  status: DiagStatus;
  summary: string;
  check_result?: string | null;
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
  connman_cell_connected?: boolean | null;
  pdp_active?: boolean | null;
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
  loopback_test_ran?: boolean;
  loopback_test_success?: boolean | null;
  sat_imei?: string | null;
  loopback_duration_seconds?: number | null;
  total_time_seconds?: number | null;
  loopback_packet_loss_pct?: number | null;
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
  return status === "green" ? "✓"
    : status === "orange" ? "⚠"
    : status === "red" ? "✗"
    : "—";
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

function formatWifiSummary(wifi: WifiDiag): string {
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
  const state = sat.loopback_test_success === true
    ? "Link verified"
    : sat.loopback_test_ran
      ? "Loopback failed"
      : sat.summary || "Not validated";
  const details: string[] = [];
  if (sat.sat_imei) details.push(`IMEI ${sat.sat_imei}`);
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
  const carrier = cell.operator_name || cell.provider_code || "Cellular";
  const quality = qualityLabel(cell.strength_score, cell.strength_label);
  const scorePart = cell.strength_score !== null && cell.strength_score !== undefined
    ? ` ${cell.strength_score}/100`
    : "";
  return `${carrier} · 📶 ${quality}${scorePart}`;
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
  if (diag.ethernet) diagRun.push(`Ethernet ${statusEmoji(diag.ethernet.status)}`);
  if (diag.wifi) diagRun.push(`Wi-Fi ${statusEmoji(diag.wifi.status)}`);
  if (diag.cellular) diagRun.push(`Cellular ${statusEmoji(diag.cellular.status)}`);
  if (diag.satellite) diagRun.push(`Satellite ${statusEmoji(diag.satellite.status)}`);
  if (diag.pressure) diagRun.push(`Pressure ${statusEmoji(diag.pressure.status)}`);

  if (diagRun.length > 0) {
    actions.push({
      id: mkId(),
      key: "diagnostics-run",
      text: `Diagnostics run — ${diagRun.join(" · ")}`,
      dismissed: false,
      autoGenerated: true,
    });
  }

  return actions;
}

// ── generateNetworkRows ───────────────────────────────────────────────────────

export function generateNetworkRows(diag: DiagnosticState): NetworkStatusRow[] {
  const toStatus = (s?: DiagStatus | null): "green" | "orange" | "red" | "unknown" => {
    if (s === "green") return "green";
    if (s === "orange") return "orange";
    if (s === "red") return "red";
    return "unknown";
  };

  return [
    {
      interface: "Ethernet",
      status: toStatus(diag.ethernet?.status),
      summary: diag.ethernet?.summary ?? "Diagnostics not collected",
    },
    {
      interface: "Wi-Fi",
      status: toStatus(diag.wifi?.status),
      summary: diag.wifi ? formatWifiSummary(diag.wifi) : "Diagnostics not collected",
    },
    {
      interface: "Cellular",
      status: toStatus(diag.cellular?.status),
      summary: diag.cellular ? formatCellSummary(diag.cellular) : "Diagnostics not collected",
    },
    {
      interface: "Satellite",
      status: toStatus(diag.satellite?.status),
      summary: diag.satellite ? formatSatelliteSummary(diag.satellite) : "Diagnostics not collected",
    },
  ];
}

export function generatePressureRows(diag: DiagnosticState): PressureStatusRow[] {
  const toStatus = (s?: DiagStatus | null): "green" | "orange" | "red" | "unknown" => {
    if (s === "green") return "green";
    if (s === "orange") return "orange";
    if (s === "red") return "red";
    return "unknown";
  };
  const pressure = diag.pressure;
  const source = pressure?.sensors?.source?.latest;
  const distribution = pressure?.sensors?.distribution?.latest;
  const hasValid = (v?: number | null) => v !== null && v !== undefined && v >= 0 && v <= 218;
  const readingParts: string[] = [];
  if (hasValid(source)) readingParts.push(`Source (P3) ${source!.toFixed(2)} PSI`);
  if (hasValid(distribution)) readingParts.push(`Distribution (P2) ${distribution!.toFixed(2)} PSI`);
  const issueTitles = (pressure?.issues ?? []).map((i) => i.title).join(", ");
  const summary = readingParts.length > 0
    ? `${issueTitles ? `${issueTitles} · ` : ""}${readingParts.join(" · ")}`
    : pressure?.summary ?? "Diagnostics not collected";

  return [{
    label: "System Pressure",
    status: toStatus(pressure?.status),
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
        text: "Verify SSID and password",
        detail: "Connection failed. Re-run setup-wifi to correct credentials.",
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

      if (noService && !cell.sim_inserted) {
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
        } else if (!sp?.scan_attempted) {
          // Suggest running SIM Picker
          actions.push({
            id: mkId(), interface: "Cellular",
            text: "Run SIM Picker to check carrier coverage",
            detail: "No service detected. Copy the SIM Picker command block to find out which carrier has coverage at this location.",
            dismissed: false, checked: false, custom: false,
          });
        } else {
          actions.push({
            id: mkId(), interface: "Cellular",
            text: "Check coverage area and antenna",
            detail: "SIM detected but no network service. Verify antenna connection and site coverage.",
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

    if (sat.status === "red" && sat.loopback_test_success === false) {
      actions.push({
        id: mkId(), interface: "Satellite",
        text: "Check antenna cabling and sky view",
        detail: "Loopback test failed. Verify N-type connector is hand-tight, cable has no sharp bends, and antenna has clear unobstructed sky view.",
        dismissed: false, checked: false, custom: false,
      });
    } else if (sat.status === "orange" && !sat.loopback_test_ran) {
      actions.push({
        id: mkId(), interface: "Satellite",
        text: "Run satellite-check -t to verify connectivity",
        detail: "Satellite configured but loopback not yet tested this session.",
        dismissed: false, checked: false, custom: false,
      });
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

// ── formatSlack ───────────────────────────────────────────────────────────────

export function formatSlack(report: SessionReport): string {
  const lines: string[] = [];

  lines.push(`*Controller Session — ${report.date}*`);
  lines.push(`*SID:* ${report.sid || "—"} · ${report.version || "—"}`);
  lines.push("");

  const visibleActions = report.actions.filter(a => !a.dismissed);
  if (visibleActions.length > 0) {
    lines.push("*Actions*");
    visibleActions.forEach(a => lines.push(`• ${a.text}`));
    lines.push("");
  }

  lines.push("*Network*");
  report.networkRows.forEach(row => {
    const dot = row.status === "green" ? "🟢"
      : row.status === "orange" ? "🟠"
      : row.status === "red" ? "🔴"
      : "⚪";
    const note = report.networkNotes[row.interface];
    const noteSuffix = note ? ` — ${note}` : "";
    lines.push(`${dot} *${row.interface}*: ${row.summary}${noteSuffix}`);
  });
  lines.push("");

  if (report.pressureRows.length > 0) {
    lines.push("*Pressure Readings*");
    report.pressureRows.forEach(row => {
      const dot = row.status === "green" ? "🟢"
        : row.status === "orange" ? "🟠"
        : row.status === "red" ? "🔴"
        : "⚪";
      lines.push(`${dot} *${row.label}*: ${row.summary}`);
    });
    lines.push("");
  }

  const visibleRecs = report.recommendedActions.filter(a => !a.dismissed);
  if (visibleRecs.length > 0) {
    lines.push("*Recommended Actions*");
    visibleRecs.forEach(a => {
      const checkbox = a.checked ? "✓" : "☐";
      lines.push(`${checkbox} ${a.interface} — ${a.text}`);
      if (a.detail) lines.push(`  ${a.detail}`);
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
