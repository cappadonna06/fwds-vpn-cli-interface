import { SystemConfig, defaultConfig, HHCType, WaterUseMode, PreferredNetwork, Zone } from "../types/config";
import { parseZoneField } from "./zoneParser";

const HHC_TYPES: HHCType[] = ["MP3", "HP6", "Legacy", "LV2"];
const WATER_MODES: WaterUseMode[] = ["Standard", "High"];

function inferHHCType(raw: string): HHCType {
  const upper = raw.toUpperCase();
  for (const t of HHC_TYPES) {
    if (upper.includes(t.toUpperCase())) return t;
  }
  return "MP3";
}

function inferWaterMode(raw: string): WaterUseMode {
  const upper = raw.toUpperCase();
  for (const m of WATER_MODES) {
    if (upper.includes(m.toUpperCase())) return m;
  }
  return "Standard";
}

function hasFoam(features: string[]): boolean {
  return features.some((f) => f.toLowerCase().includes("foam"));
}

function inferPreferredNetwork(wifiSsid: string): PreferredNetwork {
  return wifiSsid.trim() ? "W" : "E";
}

/**
 * Generates a default zone map when zone details are not available.
 * Splits evenly between Roof and Eave; odd remainder goes to Eave.
 * Names: "Roof 1", "Roof 2", ..., "Eave 1", "Eave 2", ...
 */
function generateDefaultZones(count: number): Zone[] {
  const roofCount = Math.floor(count / 2);
  const eaveCount = Math.ceil(count / 2);
  const zones: Zone[] = [];
  for (let i = 1; i <= roofCount; i++) zones.push({ type: "Roof", name: `Roof ${i}` });
  for (let i = 1; i <= eaveCount; i++) zones.push({ type: "Eave", name: `Eave ${i}` });
  return zones;
}

const DEFAULT_ZONES_WARNING =
  "ZONE NAMES ARE DEFAULTS — not accurate. Check with requester or installation design document before proceeding.";

/**
 * Parses a raw tab-separated PM intake row (from Slack/Sheets paste).
 *
 * Expected field order:
 *  0  @PM name
 *  1  Timestamp (human)
 *  2  Address / location
 *  3  Structure name
 *  4  Controller ID
 *  5  Status note 1
 *  6  Status note 2
 *  7  HHC type
 *  8  Features (comma-separated)
 *  9  Water use mode
 *  10 Zone count
 *  11 WiFi SSID
 *  12 WiFi password
 *  13 Zone breakdown (freeform)
 *  14 (blank / future)
 *  15 PM name (dupe — ignored)
 *  16 Timestamp (dupe — ignored)
 *
 * Returns a SystemConfig with all derivable fields populated and defaults applied.
 * Fields that cannot be parsed are left at their defaults.
 */
export function parseIntakeRow(raw: string): {
  config: SystemConfig;
  warnings: string[];
} {
  const config = defaultConfig();
  const warnings: string[] = [];

  const fields = raw.split("\t");

  const get = (i: number) => fields[i]?.trim() ?? "";

  // PM / request metadata
  config.requested_by = get(0).replace(/^@/, "");
  config.requested_at = get(1) || new Date().toISOString();

  // Location
  config.location = get(2);
  config.structure_name = get(3);

  // Controller ID
  config.controller_id = get(4);
  if (!config.controller_id) {
    warnings.push("Controller ID is missing.");
  }

  // Status notes (skip blanks)
  config.status_notes = [get(5), get(6)].filter(Boolean);

  // HHC type
  const hhcRaw = get(7);
  if (hhcRaw) {
    config.hhc_type = inferHHCType(hhcRaw);
  } else {
    warnings.push("HHC type not provided — defaulted to MP3.");
  }

  // Features
  config.features = get(8)
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  config.foam_module = hasFoam(config.features);

  // Water use mode
  const modeRaw = get(9);
  config.water_use_mode = modeRaw ? inferWaterMode(modeRaw) : "Standard";

  // Zone count
  const zoneCountRaw = get(10);
  const parsedCount = parseInt(zoneCountRaw, 10);
  if (!isNaN(parsedCount)) {
    config.num_zones = parsedCount;
  }

  // WiFi
  config.wifi_ssid = get(11);
  config.wifi_password = get(12);

  // Zone breakdown
  const zoneRaw = get(13);
  if (zoneRaw) {
    const zones = parseZoneField(zoneRaw);
    if (zones) {
      config.zones = zones;
      // Reconcile with zone count if both present
      if (config.num_zones > 0 && zones.length !== config.num_zones) {
        warnings.push(
          `Zone count (${config.num_zones}) does not match parsed zones (${zones.length}). Review zone map.`
        );
      }
      config.num_zones = zones.length;
    } else {
      warnings.push(`Could not parse zone field: "${zoneRaw}". Zone map defaulted — ${DEFAULT_ZONES_WARNING}`);
      if (config.num_zones > 0) {
        config.zones = generateDefaultZones(config.num_zones);
      }
    }
  } else if (config.num_zones > 0) {
    warnings.push(`No zone breakdown in intake. Zone map defaulted — ${DEFAULT_ZONES_WARNING}`);
    config.zones = generateDefaultZones(config.num_zones);
  }

  // Network defaults
  config.cellular_enabled = true;
  config.satellite_enabled = true;
  config.preferred_network = inferPreferredNetwork(config.wifi_ssid);

  // Required field checks
  if (!config.customer_name) {
    warnings.push("Customer name is required for setup-station but was not in the intake.");
  }

  return { config, warnings };
}
