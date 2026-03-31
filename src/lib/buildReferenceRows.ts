import { SystemConfig, HHCType, ZoneType, WaterUseMode } from "../types/config";

export interface PromptRow {
  id: string;
  label: string;
  value: string;
  valueSuffix?: string;            // non-copyable descriptive text shown after [Copy]
  split?: { id: string; value: string }; // second sequential prompt on the same row
  sensitive?: boolean;
  warning?: string;
  helper?: string;
}

export interface ReferenceSection {
  id: string;
  title: string;
  command?: string;
  rows: PromptRow[];
  sectionNote?: string;
  sectionHelper?: string;
}

const HHC_NUM: Record<HHCType, string> = {
  Legacy: "0",
  HP6: "1",
  MP3: "2",
  LV2: "3",
};

const ZONE_TYPE_NUM: Record<ZoneType, string> = {
  Roof: "0",
  Eave: "1",
  Perimeter: "2",
};

const WATER_MODE_NUM: Record<WaterUseMode, string> = {
  Standard: "0",
  High: "1",
};

export function buildReferenceSections(config: SystemConfig): ReferenceSection[] {
  const today = new Date().toISOString().slice(0, 10);
  const sections: ReferenceSection[] = [];

  // ── SECTION 1: setup-station ──────────────────────────────────────────────
  sections.push({
    id: "setup-station",
    title: "setup-station",
    command: "setup-station",
    rows: [
      {
        id: "station-customer-name",
        label: "Customer name",
        value: config.customer_name,
        warning: !config.customer_name
          ? "Customer name is missing — enter manually in the terminal"
          : undefined,
        helper:
          "The name that appears on alerts and the dashboard. Use the property owner's name, not the installer or PM name. Maximum 32 characters.",
      },
      {
        id: "station-location",
        label: "Location",
        value: config.location,
        warning: !config.location ? "Location is missing — enter manually" : undefined,
        helper:
          "The site address. Used for display purposes only — does not affect system behavior.",
      },
      {
        id: "station-install-date",
        label: "Installation date (YYYY-MM-DD)",
        value: config.install_date || today,
        helper:
          "Use today's date for a new install. Only backfill a prior date if explicitly requested. Format: YYYY-MM-DD.",
      },
    ],
  });

  // ── SECTION 2: setup-system (part 1 — before zone names) ─────────────────
  const systemRows1: PromptRow[] = [
    {
      id: "system-hhc-type",
      label: "HHC type (0–3)",
      value: HHC_NUM[config.hhc_type],
      valueSuffix: config.hhc_type,
      helper:
        "Enter the number: 0 = Legacy, 1 = HP6, 2 = MP3, 3 = LV2. Must match the physical unit installed. Wrong HHC type will cause zone mapping and pressure behavior to be incorrect.",
    },
  ];

  if (config.hhc_type !== "LV2") {
    systemRows1.push({
      id: "system-foam",
      label: "Foam module installed (Y/N)",
      value: config.foam_module ? "Y" : "N",
      helper:
        "Check the physical hardware — the foam module has a separate canister mounted on the HHC unit. Y = canister is present and connected. If unsure, check the intake notes or inspect the unit before answering.",
    });
  }

  systemRows1.push({
    id: "system-zones",
    label: "Number of zones (1–9)",
    value: String(config.num_zones || ""),
    warning:
      !config.num_zones || config.num_zones === 0
        ? "Zone count is zero — verify with intake or physical count"
        : undefined,
    helper:
      "The total number of sprinkler zones connected to this controller. Must match the physical wiring. Entering the wrong count will cause zones to be skipped or misconfigured.",
  });

  sections.push({
    id: "setup-system",
    title: "setup-system",
    command: "setup-system",
    rows: systemRows1,
  });

  // ── SECTION 3: Zone names (prompted within setup-system, after zone count) ─
  if (config.zones.length > 0) {
    sections.push({
      id: "zone-names",
      title: "Zone names",
      rows: config.zones.map((zone, i) => ({
        id: `zone-${i}`,
        label: `Zone ${i + 1}`,
        value: ZONE_TYPE_NUM[zone.type],
        valueSuffix: zone.type,
        split: { id: `zone-${i}-name`, value: zone.name },
        warning: !zone.name ? `Zone ${i + 1} name is missing` : undefined,
        helper:
          "Two prompts in sequence: first the zone type (0 = Roof, 1 = Eave, 2 = Perimeter), then the name. Zone names appear on the dashboard and in alerts. Maximum 16 characters.",
      })),
      sectionNote:
        "Zone entries are prompted sequentially within setup-system, after zone count.",
    });
  }

  // ── SECTION 4: setup-system (part 2 — after zone names) ──────────────────
  const systemRows2: PromptRow[] = [
    {
      id: "system-drain",
      label: "Drain cycle during deactivation (Y/N)",
      value: config.drain_cycle ? "Y" : "N",
      helper:
        "Enables automatic draining of the system after activation. Almost always Y. Only set to N if the site has a specific reason to disable draining — this should be noted in the intake.",
    },
  ];

  if (config.hhc_type !== "LV2") {
    systemRows2.push(
      {
        id: "system-init-cycles",
        label: "Initiation cycles (1–9)",
        value: String(config.initiation_cycles),
        helper:
          "The number of short test activations the system runs on first arm. Default is 4. Only change if specifically noted in the intake or requested by engineering. Higher values mean more water used on first arm.",
      },
      {
        id: "system-water-mode",
        label: "Water use mode (0–1)",
        value: WATER_MODE_NUM[config.water_use_mode],
        valueSuffix: config.water_use_mode,
        helper:
          "Enter the number: 0 = Standard, 1 = High. Standard is correct for most installs. High increases flow rate and is used for sites with larger coverage requirements or lower water pressure. Should be specified in the intake — do not change without instruction.",
      }
    );
  }

  if (config.hhc_type === "HP6" || config.hhc_type === "Legacy") {
    systemRows2.push(
      {
        id: "system-bypass",
        label: "Bypass valve installed (Y/N)",
        value: config.bypass_valve ? "Y" : "N",
        helper:
          "Indicates whether a bypass valve is installed in the hydraulic circuit. Check the physical plumbing or intake notes. Incorrect setting can cause pressure issues at activation.",
      },
      {
        id: "system-pressure-relief",
        label: "Pressure relief enabled (Y/N)",
        value: config.pressure_relief ? "Y" : "N",
        helper:
          "Enables the pressure relief zone, which releases excess pressure from the manifold after activation. Almost always Y on HP6 installs. Disabling this without a hardware reason can cause pressure buildup.",
      }
    );

    if (config.pressure_relief) {
      systemRows2.push({
        id: "system-pressure-zone",
        label: "Pressure relief zone",
        value: String(config.pressure_relief_zone),
        helper:
          "The zone number assigned to pressure relief. Usually zone 1 unless the system was specifically designed otherwise. Check the zone map or intake notes if unsure.",
      });
    }
  }

  sections.push({
    id: "setup-system-2",
    title: "↳ setup-system (continued)",
    rows: systemRows2,
  });

  // ── SECTION 5: setup-ethernet ─────────────────────────────────────────────
  sections.push({
    id: "setup-ethernet",
    title: "setup-ethernet",
    command: "setup-ethernet",
    rows: [
      {
        id: "ethernet-enable",
        label: "Enable Ethernet networking (Y/N)",
        value: config.ethernet_enabled ? "Y" : "N",
        helper:
          "Almost always Y. Disable only if no Ethernet cable is connected at this site and Ethernet is not the preferred interface. Disabling Ethernet here will remove it as a preferred-network option.",
      },
    ],
  });

  // ── SECTION 6: setup-wifi ─────────────────────────────────────────────────
  if (config.wifi_ssid) {
    sections.push({
      id: "setup-wifi",
      title: "setup-wifi",
      command: "setup-wifi",
      rows: [
        {
          id: "wifi-enable",
          label: "Enable Wi-Fi networking (Y/N)",
          value: "Y",
          helper:
            "Always Y when Wi-Fi credentials are present. The controller will scan for available networks after this prompt.",
        },
        {
          id: "wifi-add-replace",
          label: "Add, Replace, or Use (A/R/U)",
          value: "A",
          helper:
            "A = Add a new network (first install or adding a second network). R = Replace the existing saved network with new credentials. U = Use the existing saved network without changes. This prompt only appears if the controller already has a saved Wi-Fi network. For a first install, always use A.",
        },
        {
          id: "wifi-ssid",
          label: "SSID (select by number from list)",
          value: config.wifi_ssid,
          warning: !config.wifi_ssid ? "Wi-Fi SSID is missing" : undefined,
          helper:
            "The controller displays a numbered list of nearby networks. Find this SSID in the list and enter its number — do not type the name directly. If it doesn't appear, choose M (Manual) and enter it. Network names are case-sensitive.",
        },
        {
          id: "wifi-password",
          label: "Password",
          value: config.wifi_password,
          sensitive: true,
          warning: !config.wifi_password ? "Wi-Fi password is missing" : undefined,
          helper:
            "Case sensitive. Typed directly into the prompt. If connection fails after setup, the most common cause is a password typo. Re-run setup-wifi and choose R (Replace) to correct it.",
        },
      ],
    });
  }

  // ── SECTION 7: setup-cellular ─────────────────────────────────────────────
  sections.push({
    id: "setup-cellular",
    title: "setup-cellular",
    command: "setup-cellular",
    rows: [
      {
        id: "cellular-enable",
        label: "Enable Cellular networking (Y/N)",
        value: "Y",
        helper:
          "Almost always Y. The controller detects the SIM automatically — no APN or credentials are required on standard Frontline SIMs.",
      },
    ],
    sectionHelper:
      "If prompted for APN, contact engineering — this is not required on standard Frontline SIMs. If the cellular check fails after setup, verify the SIM is seated correctly and the antenna is connected.",
  });

  // ── SECTION 8: setup-satellite ────────────────────────────────────────────
  sections.push({
    id: "setup-satellite",
    title: "setup-satellite",
    command: "setup-satellite",
    rows: [
      {
        id: "satellite-enable",
        label: "Enable Satellite networking (Y/N)",
        value: "Y",
        helper:
          "Always Y. Satellite is configured automatically — no manual input is required beyond enabling it.",
      },
    ],
    sectionHelper:
      "Satellite is a backup link only. It does not need to show as online during install — it may take several hours to register after deployment. Run satellite-check -m after the install is complete to verify visibility.",
  });

  // ── SECTION 9: setup-preferred-network ───────────────────────────────────
  const prefNames: Record<string, string> = {
    E: "Ethernet",
    W: "Wi-Fi",
    C: "Cellular",
  };
  const prefValue = config.preferred_network ?? "E";

  sections.push({
    id: "setup-preferred-network",
    title: "setup-preferred-network",
    command: "setup-preferred-network",
    rows: [
      {
        id: "preferred-network",
        label: "Preferred network (E/W/C)",
        value: prefValue,
        valueSuffix: prefNames[prefValue] ?? prefValue,
        warning: !config.preferred_network
          ? "Preferred network not set in intake — defaulting to Ethernet"
          : undefined,
        helper:
          "The primary network interface. Alerts fire if this interface loses connectivity. The prompt only lists interfaces that are enabled — if Ethernet was disabled above, E will not appear. Choose the most reliable link at this site.",
      },
    ],
  });

  return sections;
}
