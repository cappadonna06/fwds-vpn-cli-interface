export type HHCType = "MP3" | "HP6" | "Legacy" | "LV2";
export type ZoneType = "Roof" | "Eave" | "Perimeter";
export type WaterUseMode = "Standard" | "High";
export type PreferredNetwork = "E" | "W" | "C" | null;

export interface Zone {
  type: ZoneType;
  name: string;
}

export interface SystemConfig {
  // From PM intake
  requested_by: string;
  requested_at: string;
  controller_id: string;
  location: string;
  structure_name: string;
  status_notes: string[];
  features: string[];

  // Station setup
  customer_name: string;
  install_date: string;

  // System setup
  hhc_type: HHCType;
  foam_module: boolean;
  drain_cycle: boolean;
  num_zones: number;
  zones: Zone[];
  initiation_cycles: number;
  water_use_mode: WaterUseMode;

  // HP6/Legacy only
  bypass_valve: boolean;
  pressure_relief: boolean;
  pressure_relief_zone: number;

  // Network setup
  ethernet_enabled: boolean;
  wifi_ssid: string;
  wifi_password: string;
  cellular_enabled: boolean;
  satellite_enabled: boolean;
  preferred_network: PreferredNetwork;
}

export const defaultConfig = (): SystemConfig => ({
  requested_by: "",
  requested_at: new Date().toISOString(),
  controller_id: "",
  location: "",
  structure_name: "",
  status_notes: [],
  features: [],
  customer_name: "",
  install_date: new Date().toISOString().slice(0, 10),
  hhc_type: "MP3",
  foam_module: true,
  drain_cycle: true,
  num_zones: 0,
  zones: [],
  initiation_cycles: 4,
  water_use_mode: "Standard",
  bypass_valve: false,
  pressure_relief: true,
  pressure_relief_zone: 1,
  ethernet_enabled: true,
  wifi_ssid: "",
  wifi_password: "",
  cellular_enabled: true,
  satellite_enabled: true,
  preferred_network: null,
});
