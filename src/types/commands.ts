export type CommandCategory = "config" | "diagnostic" | "info" | "system";
export type GuardLevel = "none" | "confirm" | "hard";

export interface ControllerCommand {
  id: string;
  label: string;
  command: string;
  category: CommandCategory;
  description: string;
  reboot_required: boolean;
  guard: GuardLevel;
  guard_message?: string;
  destructive?: boolean;
  est_seconds?: number;
  when_to_run?: string;
  what_to_look_for?: string[];
  related_command_ids?: string[];
  tags?: string[];
}

export const COMMANDS: ControllerCommand[] = [
  // Config — top level
  {
    id: "setup",
    label: "setup",
    command: "setup",
    category: "config",
    description: "Full first-time setup: runs setup-station, setup-system, and setup-network in sequence.",
    reboot_required: true,
    guard: "none",
  },
  {
    id: "setup-station",
    label: "setup-station",
    command: "setup-station",
    category: "config",
    description: "Station and site configuration: customer name, location, install date. Non-destructive.",
    reboot_required: true,
    guard: "none",
    est_seconds: 90,
    when_to_run: "First-time install or when station metadata needs correction.",
    what_to_look_for: [
      "Prompts for customer name, location, and install date",
      "Accept defaults by pressing Enter, or type new values",
    ],
    related_command_ids: ["setup-system", "setup-network"],
  },
  {
    id: "setup-system",
    label: "setup-system",
    command: "setup-system",
    category: "config",
    description: "Hydraulic hardware configuration: HHC type, zones, foam, drain. DESTRUCTIVE — does not preserve existing settings.",
    reboot_required: true,
    guard: "confirm",
    guard_message: "setup-system is destructive and will erase existing hydraulic configuration. Continue?",
    destructive: true,
    est_seconds: 150,
    when_to_run: "First-time install only. DESTRUCTIVE on already-configured controllers.",
    what_to_look_for: [
      "Prompts for HHC type, zone count, foam, drain settings",
      "Will erase existing hydraulic config without warning",
    ],
    related_command_ids: ["setup-station", "setup-network"],
  },
  {
    id: "setup-network",
    label: "setup-network",
    command: "setup-network",
    category: "config",
    description: "Network configuration: Ethernet, Wi-Fi, Cellular, Satellite, preferred network.",
    reboot_required: true,
    guard: "none",
    est_seconds: 180,
    when_to_run: "After first install or when network configuration needs to change.",
    what_to_look_for: [
      "Prompts for Ethernet, Wi-Fi, Cellular, Satellite, preferred network",
      "Requires reboot to take effect",
    ],
    related_command_ids: ["setup-wifi", "setup-ethernet", "setup-cellular"],
  },
  {
    id: "setup-ethernet",
    label: "setup-ethernet",
    command: "setup-ethernet",
    category: "config",
    description: "Configure wired Ethernet. No reboot required unless primary network changes.",
    reboot_required: false,
    guard: "none",
    est_seconds: 15,
    when_to_run: "When Ethernet configuration needs to change independently.",
    related_command_ids: ["ethernet-check", "setup-network"],
  },
  {
    id: "setup-wifi",
    label: "setup-wifi",
    command: "setup-wifi",
    category: "config",
    description: "Configure Wi-Fi. Scans and presents available networks. No reboot required unless primary network changes.",
    reboot_required: false,
    guard: "none",
    est_seconds: 30,
    when_to_run: "When only Wi-Fi needs to change without running full setup-network.",
    what_to_look_for: [
      "Prompts: Add, Replace, or Use existing network",
      "Enter SSID and password when prompted",
    ],
    related_command_ids: ["setup-network", "wifi-check"],
  },
  {
    id: "setup-cellular",
    label: "setup-cellular",
    command: "setup-cellular",
    category: "config",
    description: "Configure LTE-M cellular. No reboot required unless primary network changes.",
    reboot_required: false,
    guard: "none",
    est_seconds: 20,
    when_to_run: "When cellular configuration needs to change independently.",
    related_command_ids: ["cellular-check", "setup-network"],
  },
  {
    id: "setup-satellite",
    label: "setup-satellite",
    command: "setup-satellite",
    category: "config",
    description: "Configure Iridium satellite. Reboot required. Run satellite-check after.",
    reboot_required: true,
    guard: "none",
  },
  {
    id: "setup-preferred-network",
    label: "setup-preferred-network",
    command: "setup-preferred-network",
    category: "config",
    description: "Set the primary network interface. Alerts fire if this interface loses connectivity.",
    reboot_required: true,
    guard: "none",
  },
  {
    id: "setup-server",
    label: "setup-server",
    command: "setup-server",
    category: "config",
    description: "Frontline cloud services configuration. Support use only — do not run unless instructed by engineering.",
    reboot_required: true,
    guard: "confirm",
    guard_message: "setup-server is for support use only. Only run if explicitly instructed by engineering. Continue?",
  },
  {
    id: "factory-reset",
    label: "factory-reset",
    command: "factory-reset",
    category: "config",
    description: "Resets ALL controller settings to factory defaults. Erases station, network, and system configuration.",
    reboot_required: false,
    guard: "hard",
    guard_message: "This will erase ALL controller configuration including station, network, and system settings. This cannot be undone.",
    destructive: true,
  },
  {
    id: "factory-reset-network",
    label: "factory-reset-network",
    command: "factory-reset-network",
    category: "config",
    description: "Resets network configuration only. Does not affect hydraulic or station settings.",
    reboot_required: false,
    guard: "confirm",
    guard_message: "This will erase all network configuration. Continue?",
    destructive: true,
  },

  // Diagnostic
  {
    id: "ethtool-eth0",
    label: "ethtool eth0",
    command: "ethtool eth0",
    category: "diagnostic",
    description: "Display Ethernet interface link state, speed, duplex, and driver details.",
    reboot_required: false,
    guard: "none",
    est_seconds: 2,
    when_to_run: "When ethernet-check fails or link state needs closer inspection.",
    what_to_look_for: [
      "Link detected: yes — physical connection is present",
      "Link detected: no — cable or switch port issue",
      "Speed and duplex mismatch can cause intermittent failures",
    ],
    related_command_ids: ["ethernet-check", "ifconfig-eth0"],
    tags: ["network", "ethernet", "link", "speed"],
  },
  {
    id: "iwconfig",
    label: "iwconfig",
    command: "iwconfig",
    category: "diagnostic",
    description: "Display wireless interface configuration: SSID, mode, bit rate, signal level.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
    when_to_run: "When detailed Wi-Fi connection properties are needed.",
    what_to_look_for: [
      "ESSID shows the connected network name",
      "Bit Rate and Signal level indicate connection quality",
      'Mode: Managed indicates normal client connection',
    ],
    related_command_ids: ["wifi-check", "wifi-signal"],
    tags: ["network", "wireless", "ssid", "signal"],
  },
  {
    id: "iwlist-scan",
    label: "iwlist wlan0 scan",
    command: "iwlist wlan0 scan",
    category: "diagnostic",
    description: "Scan and list all nearby Wi-Fi networks with SSID, signal, and channel.",
    reboot_required: false,
    guard: "none",
    est_seconds: 5,
    when_to_run: "When verifying a target SSID is visible or checking for interference.",
    what_to_look_for: [
      "Target SSID appears in scan results",
      "Signal level > -70 dBm is acceptable for connection",
      "Multiple networks on same channel can cause interference",
    ],
    related_command_ids: ["wifi-check", "iwconfig"],
    tags: ["network", "wireless", "ssid", "scan"],
  },
  {
    id: "wifi-check",
    label: "wifi-check",
    command: "wifi-check",
    category: "diagnostic",
    description: "System-level Wi-Fi status and connectivity test.",
    reboot_required: false,
    guard: "none",
    est_seconds: 12,
    when_to_run: "After setup-wifi or when Wi-Fi connectivity is in question.",
    what_to_look_for: [
      "✓ wifi-check: Success at the end of output",
      "⚠ Connected but weak signal — check antenna or move controller",
      "✗ Not connected — verify SSID and password with setup-wifi",
    ],
    related_command_ids: ["wifi-signal", "setup-wifi"],
    tags: ["network", "wireless", "ssid"],
  },
  {
    id: "cellular-check",
    label: "cellular-check",
    command: "cellular-check",
    category: "diagnostic",
    description: "System-level cellular status and connectivity test.",
    reboot_required: false,
    guard: "none",
    est_seconds: 12,
    when_to_run: "After setup-cellular or when cellular connectivity is in question.",
    what_to_look_for: [
      "✓ Internet reachability: online — cellular is working",
      "⚠ Cellular state: ready but low signal — check antenna placement",
      "✗ Cellular state: not ready — SIM issue or APN misconfiguration",
    ],
    related_command_ids: ["cell-signal", "cell-provider", "cell-ccid"],
    tags: ["network", "lte", "sim", "verizon", "att"],
  },
  {
    id: "ethernet-check",
    label: "ethernet-check",
    command: "ethernet-check",
    category: "diagnostic",
    description: "Test and confirm Ethernet connectivity.",
    reboot_required: false,
    guard: "none",
    est_seconds: 10,
    when_to_run: "After setup-ethernet, after any network change, or when the site reports connectivity issues.",
    what_to_look_for: [
      "✓ Done: Success — Ethernet is healthy",
      "⚠ Done: Failure + link detected: yes — link is up but DNS/routing failed, check router",
      "✗ Done: Failure + link detected: no — physical layer problem, swap switch port or cable",
    ],
    related_command_ids: ["ethtool-eth0", "ifconfig-eth0", "setup-ethernet"],
    tags: ["network", "connectivity", "dns", "link"],
  },
  {
    id: "satellite-check",
    label: "satellite-check",
    command: "satellite-check",
    category: "diagnostic",
    description: "Satellite connectivity check.",
    reboot_required: false,
    guard: "none",
    est_seconds: 60,
  },
  {
    id: "satellite-check-light",
    label: "satellite-check -c 1 -W 1 -w 1",
    command: "satellite-check -c 1 -W 1 -w 1",
    category: "diagnostic",
    description: "Quick satellite sanity check.",
    reboot_required: false,
    guard: "none",
    est_seconds: 60,
  },
  {
    id: "satellite-check-light-verbose",
    label: "satellite-check -c 1 -W 1 -w 1 -v",
    command: "satellite-check -c 1 -W 1 -w 1 -v",
    category: "diagnostic",
    description: "Quick satellite sanity check with verbose output.",
    reboot_required: false,
    guard: "none",
    est_seconds: 60,
  },
  {
    id: "satellite-check-loopback",
    label: "satellite-check -t",
    command: "satellite-check -t",
    category: "diagnostic",
    description: "Satellite loopback validation test.",
    reboot_required: false,
    guard: "none",
    est_seconds: 300,
  },
  {
    id: "satellite-check-loopback-full",
    label: "satellite-check -t -f -v -W 5 -w 10",
    command: "satellite-check -t -f -v -W 5 -w 10",
    category: "diagnostic",
    description: "Full satellite loopback validation with verbose/full stats.",
    reboot_required: false,
    guard: "none",
    est_seconds: 600,
  },

  // Informational
  {
    id: "ifconfig-eth0",
    label: "ifconfig eth0",
    command: "ifconfig eth0",
    category: "info",
    description: "Display Ethernet interface IP address, netmask, MAC address, and packet stats.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
    when_to_run: "When ethernet-check fails or IP assignment needs to be verified.",
    what_to_look_for: [
      "inet shows the assigned IP address",
      "No inet line means DHCP failed — check router or cable",
      "RX/TX errors count may indicate hardware or cable issues",
    ],
    related_command_ids: ["ethernet-check", "ethtool-eth0"],
    tags: ["network", "ethernet", "ip", "dhcp"],
  },
  {
    id: "cat-station-info",
    label: "cat /var/etc/fwds/station_info",
    command: "cat /var/etc/fwds/station_info",
    category: "diagnostic",
    description: "Raw station configuration XML (name, preferred network, install metadata).",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "cat-system-info",
    label: "cat /var/etc/fwds/system_info",
    command: "cat /var/etc/fwds/system_info",
    category: "diagnostic",
    description: "Raw system configuration XML (HHC type, zones, foam/drain configuration).",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "sid",
    label: "sid",
    command: "sid",
    category: "diagnostic",
    description: "Controller serial number.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
    when_to_run: "To confirm controller serial number. Always run at start of session.",
    related_command_ids: ["version", "release"],
  },
  {
    id: "date",
    label: "date",
    command: "date",
    category: "diagnostic",
    description: "Current system time.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "version",
    label: "version",
    command: "version",
    category: "diagnostic",
    description: "Controller software version.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
    when_to_run: "To confirm firmware version or check if an update is available.",
    related_command_ids: ["sid", "release"],
  },
  {
    id: "release",
    label: "release",
    command: "release",
    category: "info",
    description: "Display firmware release metadata.",
    reboot_required: false,
    guard: "none",
  },
  {
    id: "cell-signal",
    label: "cell-signal",
    command: "cell-signal",
    category: "diagnostic",
    description: "Current cellular signal quality score.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
    when_to_run: "Quick check of cellular signal strength, 0–100.",
    what_to_look_for: [
      "> 60 is good",
      "40–60 is acceptable",
      "< 40 may cause reliability issues",
    ],
    related_command_ids: ["cellular-check"],
  },
  {
    id: "wifi-signal",
    label: "wifi-signal",
    command: "wifi-signal",
    category: "diagnostic",
    description: "Current Wi-Fi RSSI in dBm.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "iw-dev",
    label: "iw dev",
    command: "iw dev",
    category: "diagnostic",
    description: "Wireless interface, SSID, mode, and tx power.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "iw-wlan0-info",
    label: "iw dev wlan0 info",
    command: "iw dev wlan0 info",
    category: "diagnostic",
    description: "wlan0 interface details.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "iw-wlan0-link",
    label: "iw dev wlan0 link",
    command: "iw dev wlan0 link",
    category: "diagnostic",
    description: "Current AP, frequency, signal, bitrate, RX/TX counters.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "iw-wlan0-station-dump",
    label: "iw dev wlan0 station dump",
    command: "iw dev wlan0 station dump",
    category: "diagnostic",
    description: "Retries, failures, signal, tx bitrate.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "ip-link-wlan0",
    label: "ip link show wlan0",
    command: "ip link show wlan0",
    category: "diagnostic",
    description: "Interface flags — UP / LOWER_UP / DOWN.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "ip-addr-wlan0",
    label: "ip addr show wlan0",
    command: "ip addr show wlan0",
    category: "diagnostic",
    description: "IP address assignment on wlan0.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "ip-route",
    label: "ip route",
    command: "ip route",
    category: "diagnostic",
    description: "Routing table — shows default route.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "cat-resolv-conf",
    label: "cat /etc/resolv.conf",
    command: "cat /etc/resolv.conf",
    category: "diagnostic",
    description: "DNS config (ConnMan proxy).",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "connmanctl-technologies",
    label: "connmanctl technologies",
    command: "connmanctl technologies",
    category: "diagnostic",
    description: "ConnMan technology status.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "connmanctl-services",
    label: "connmanctl services",
    command: "connmanctl services",
    category: "diagnostic",
    description: "ConnMan active services.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "connmanctl-state",
    label: "connmanctl state",
    command: "connmanctl state",
    category: "diagnostic",
    description: "Global ConnMan state.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "ethtool-driver-wlan0",
    label: "ethtool -i wlan0",
    command: "ethtool -i wlan0",
    category: "diagnostic",
    description: "Wi-Fi driver info.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "proc-net-dev",
    label: "cat /proc/net/dev",
    command: "cat /proc/net/dev",
    category: "diagnostic",
    description: "Traffic baseline for all interfaces.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "cell-imei",
    label: "cell-imei",
    command: "cell-imei",
    category: "diagnostic",
    description: "Cellular modem IMEI.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "cell-ccid",
    label: "cell-ccid",
    command: "cell-ccid",
    category: "diagnostic",
    description: "SIM ICCID.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "cell-imsi",
    label: "cell-imsi",
    command: "cell-imsi",
    category: "diagnostic",
    description: "SIM IMSI.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "cell-hni",
    label: "cell-hni",
    command: "cell-hni",
    category: "diagnostic",
    description: "Home network identifier / MCCMNC.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "cell-apn",
    label: "cell-apn",
    command: "cell-apn",
    category: "diagnostic",
    description: "Configured / active cellular APN.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "cell-provider",
    label: "cell-provider",
    command: "cell-provider",
    category: "diagnostic",
    description: "Current cellular provider identifier.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "cell-status",
    label: "cell-status",
    command: "cell-status",
    category: "diagnostic",
    description: "Current cellular registration state.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "ip-link-wwan0",
    label: "ip link show wwan0",
    command: "ip link show wwan0",
    category: "diagnostic",
    description: "wwan0 link state.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "ip-addr-wwan0",
    label: "ip addr show wwan0",
    command: "ip addr show wwan0",
    category: "diagnostic",
    description: "wwan0 IP assignment.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "cell-support-at",
    label: "cell-support --no-ofono --at",
    command: "cell-support --no-ofono --at",
    category: "diagnostic",
    description: "Raw modem / AT diagnostics.",
    reboot_required: false,
    guard: "none",
    est_seconds: 8,
  },
  {
    id: "cell-support-scan",
    label: "cell-support --no-ofono --at --scan",
    command: "cell-support --no-ofono --at --scan",
    category: "diagnostic",
    description: "Full modem AT diagnostics including network carrier scan (~3 min). Shows which carriers are visible at this location.",
    reboot_required: false,
    guard: "none",
    est_seconds: 180,
    tags: ["cellular", "sim", "carrier", "scan", "at", "cops"],
    when_to_run: "When cellular has no service and you need to know which carrier SIM to install.",
    what_to_look_for: [
      "+COPS: list shows detectable carriers — stat=1 means can attach, stat=3 means detected but wrong SIM",
      "+QCSQ: NOSERVICE with empty COPS = dead zone, no SIM will help",
      "+CME ERROR: operation not allowed = modem stuck, reboot first",
    ],
  },
  {
    id: "sat-imei",
    label: "sat-imei",
    command: "sat-imei",
    category: "diagnostic",
    description: "Satellite modem IMEI.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "pressure-monitor",
    label: "pressure-monitor",
    command: "pressure-monitor -v --hhc=mp3 --pressure-sensor=source -u us",
    category: "diagnostic",
    description: "Pressure sensor diagnostics (source, supply, distribution) with snapshot and live samples.",
    reboot_required: false,
    guard: "none",
    est_seconds: 35,
    when_to_run: "When pressure behavior is suspect or during full install sign-off.",
    tags: ["pressure", "sensors", "hydraulics"],
  },
  {
    id: "help",
    label: "help",
    command: "help",
    category: "info",
    description: "Display controller command help.",
    reboot_required: false,
    guard: "none",
  },

  // System
  {
    id: "reboot",
    label: "reboot",
    command: "reboot",
    category: "system",
    description: "Restart the controller. Current SSH session will drop.",
    reboot_required: false,
    guard: "confirm",
    guard_message: "Reboot the controller? The current session will disconnect.",
    est_seconds: 60,
    when_to_run: "After setup commands that require a reboot to take effect. Session will drop.",
    what_to_look_for: [
      "SSH session will disconnect immediately",
      "Allow 60 seconds before reconnecting",
    ],
  },
  {
    id: "exit",
    label: "exit",
    command: "exit",
    category: "system",
    description: "Exit the controller shell session.",
    reboot_required: false,
    guard: "none",
  },
  {
    id: "ethtool-driver-eth0",
    label: "ethtool -i eth0",
    command: "ethtool -i eth0",
    category: "diagnostic",
    description: "Ethernet driver name, version, and bus info.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "dmesg-eth",
    label: "dmesg | grep -i eth",
    command: "dmesg | grep -i eth",
    category: "diagnostic",
    description: "Kernel log entries for Ethernet — link up/down events, driver errors.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
  },
  {
    id: "ping-8-8-8-8",
    label: "ping -c 3 8.8.8.8",
    command: "ping -c 3 8.8.8.8",
    category: "diagnostic",
    description: "ICMP reachability to Google DNS — confirms IP-layer internet access.",
    reboot_required: false,
    guard: "none",
    est_seconds: 5,
  },
  {
    id: "ping-google",
    label: "ping -c 3 google.com",
    command: "ping -c 3 google.com",
    category: "diagnostic",
    description: "ICMP reachability via DNS name — confirms both DNS and internet are working.",
    reboot_required: false,
    guard: "none",
    est_seconds: 5,
  },
];

export const FAVORITE_COMMAND_IDS = [
  "setup-station",
  "setup-network",
  "ethernet-check",
  "wifi-check",
  "cellular-check",
  "satellite-check-light",
  "cell-signal",
  "wifi-signal",
  "version",
  "sid",
  "reboot",
];

export interface DiagnosticBlock {
  id: string;
  label: string;
  icon: string;
  description: string;
  affected_interfaces: Array<"wifi" | "cellular" | "satellite" | "ethernet" | "pressure" | "sim_picker" | "system">;
  when_to_run?: string;
  light_command_ids: string[];
  heavy_command_ids: string[];
  time_warning?: string;
  light_script?: string;
  heavy_script?: string;
}

export const DIAGNOSTIC_BLOCKS: DiagnosticBlock[] = [
  {
    id: "quick-diags",
    label: "Quick Diags",
    icon: "⚡",
    description: "All subsystems, no satellite loopback — runs in ~2 minutes",
    affected_interfaces: ["ethernet", "wifi", "cellular", "satellite", "system"],
    light_command_ids: [],
    heavy_command_ids: [
      // ETH
      "ethernet-check",
      "ethtool-eth0",
      "cat-eth0-carrier",
      "cat-eth0-operstate",
      "dmesg-eth",
      "ip-link-eth0",
      "ip-addr-eth0",
      "ip-route",
      "cat-resolv-conf",
      "ping-8-8-8-8",
      "ping-google",
      "ethtool-driver-eth0",
      "ethtool-stats-eth0",
      "proc-net-dev",
      // WiFi
      "connmanctl-technologies",
      "connmanctl-services",
      "connmanctl-state",
      "wifi-check",
      "wifi-signal",
      "iw-dev",
      "iw-wlan0-info",
      "iw-wlan0-link",
      "iw-wlan0-station-dump",
      "ip-link-wlan0",
      "ip-addr-wlan0",
      "ethtool-driver-wlan0",
      // Cellular
      "cellular-check",
      "cell-imei",
      "cell-ccid",
      "cell-imsi",
      "cell-hni",
      "cell-provider",
      "cell-status",
      "cell-signal",
      "cell-apn",
      "ip-link-wwan0",
      "ip-addr-wwan0",
      "cell-support-at",
      // Satellite
      "sat-imei",
      // System
      "cat-station-info",
      "cat-system-info",
      "version",
      "sid",
      "release",
    ],
    heavy_script: `(
echo "===== CONTROLLER INFO ====="
date
version
sid

echo ""
echo "===== ETH DIAGNOSTICS START ====="

echo ""
echo "--- FRONTLINE ---"
ethernet-check

echo ""
echo "--- LINK / PHY ---"
ethtool eth0
cat /sys/class/net/eth0/carrier
cat /sys/class/net/eth0/operstate
dmesg | grep -i eth

echo ""
echo "--- INTERFACE ---"
ip link show eth0
ip addr show eth0

echo ""
echo "--- ROUTING / DNS ---"
ip route
cat /etc/resolv.conf

echo ""
echo "--- CONNECTIVITY ---"
ping -c 3 8.8.8.8
ping -c 3 google.com

echo ""
echo "--- DRIVER / STATS ---"
ethtool -i eth0
ethtool -S eth0
cat /proc/net/dev

echo ""
echo "===== ETH DIAGNOSTICS END ====="

echo ""
echo "===== WIFI DIAGNOSTICS START ====="

echo ""
echo "--- FRONTLINE ---"
wifi-check
wifi-signal

echo ""
echo "--- IW ---"
iw dev
iw dev wlan0 info
iw dev wlan0 link
iw dev wlan0 station dump

echo ""
echo "--- INTERFACE ---"
ip link show wlan0
ip addr show wlan0

echo ""
echo "--- ROUTING / DNS ---"
ip route
cat /etc/resolv.conf

echo ""
echo "--- CONNMAN ---"
connmanctl technologies
connmanctl services
connmanctl state

echo ""
echo "--- DRIVER / STATS ---"
ethtool -i wlan0
cat /proc/net/dev

echo ""
echo "===== WIFI DIAGNOSTICS END ====="

echo ""
echo "===== CELLULAR DIAGNOSTICS START ====="
echo "===== CELLULAR CONNECTIVITY TEST ====="
cellular-check

echo ""
echo "===== BASIC CELL INFO ====="
cell-imei
cell-ccid
cell-imsi
cell-hni
cell-provider
cell-status
cell-signal
cell-apn

echo ""
echo "===== NETWORK TECHNOLOGY ====="
connmanctl technologies
connmanctl services
connmanctl state

echo ""
echo "===== INTERFACE / ROUTING ====="
ip link show wwan0
ip addr show wwan0
ip route
cat /proc/net/dev

echo ""
echo "===== MODEM / RADIO DIAGNOSTICS ====="
cell-support --no-ofono --at
echo "===== CELLULAR DIAGNOSTICS END ====="

echo ""
echo "===== SATELLITE DIAGNOSTICS START ====="
echo ""
echo "===== SATELLITE BASIC ====="
sat-imei
echo "===== SATELLITE DIAGNOSTICS END ====="

echo ""
echo "===== SYSTEM ====="
cat /var/etc/fwds/station_info
cat /var/etc/fwds/system_info
version
sid
release
)`,
  },
  {
    id: "ethernet",
    label: "Ethernet",
    icon: "🌐",
    description: "Physical link, IP assignment, DNS, and internet reachability. Tests that the cable is connected, an IP is assigned via DHCP, DNS resolves, and the internet is reachable.",
    affected_interfaces: ["ethernet", "system"],
    when_to_run: "After setup-ethernet, after any network change, or when the site reports connectivity issues.",
    light_command_ids: ["ethernet-check"],
    heavy_command_ids: ["ethernet-check", "ethtool-eth0", "ifconfig-eth0"],
    heavy_script: `(
echo "===== CONTROLLER INFO ====="
date
version
sid

echo ""
echo "===== ETH DIAGNOSTICS START ====="

echo ""
echo "--- FRONTLINE ---"
ethernet-check

echo ""
echo "--- LINK / PHY ---"
ethtool eth0
cat /sys/class/net/eth0/carrier
cat /sys/class/net/eth0/operstate
dmesg | grep -i eth

echo ""
echo "--- INTERFACE ---"
ip link show eth0
ip addr show eth0

echo ""
echo "--- ROUTING / DNS ---"
ip route
cat /etc/resolv.conf

echo ""
echo "--- CONNECTIVITY ---"
ping -c 3 8.8.8.8
ping -c 3 google.com

echo ""
echo "--- DRIVER / STATS ---"
ethtool -i eth0
ethtool -S eth0
cat /proc/net/dev

echo ""
echo "===== ETH DIAGNOSTICS END ====="
)`,
  },
  {
    id: "wifi",
    label: "Wi-Fi",
    icon: "📶",
    description: "Full Wi-Fi diagnostic suite — wrapper, association, interface, routing, ConnMan, and stats",
    affected_interfaces: ["wifi", "system"],
    light_command_ids: ["wifi-check", "wifi-signal"],
    heavy_command_ids: [
      "wifi-check",
      "wifi-signal",
      "iw-dev",
      "iw-wlan0-info",
      "iw-wlan0-link",
      "iw-wlan0-station-dump",
      "ip-link-wlan0",
      "ip-addr-wlan0",
      "ip-route",
      "cat-resolv-conf",
      "connmanctl-technologies",
      "connmanctl-services",
      "connmanctl-state",
      "ethtool-driver-wlan0",
      "proc-net-dev",
    ],
    heavy_script: `(
echo "===== CONTROLLER INFO ====="
date
version
sid

echo ""
echo "===== WIFI DIAGNOSTICS START ====="

echo ""
echo "--- FRONTLINE ---"
wifi-check
wifi-signal

echo ""
echo "--- IW ---"
iw dev
iw dev wlan0 info
iw dev wlan0 link
iw dev wlan0 station dump

echo ""
echo "--- INTERFACE ---"
ip link show wlan0
ip addr show wlan0

echo ""
echo "--- ROUTING / DNS ---"
ip route
cat /etc/resolv.conf

echo ""
echo "--- CONNMAN ---"
connmanctl technologies
connmanctl services
connmanctl state

echo ""
echo "--- DRIVER / STATS ---"
ethtool -i wlan0
cat /proc/net/dev

echo ""
echo "===== WIFI DIAGNOSTICS END ====="
)`,
  },
  {
    id: "cellular",
    label: "Cellular",
    icon: "📡",
    description: "Full cellular diagnostic suite — controller info, SIM/modem status, routing, ConnMan, connectivity, and AT diagnostics",
    affected_interfaces: ["cellular", "system"],
    light_command_ids: ["cellular-check", "cell-status", "cell-signal"],
    heavy_command_ids: [
      "date",
      "version",
      "sid",
      "cellular-check",
      "cell-imei",
      "cell-ccid",
      "cell-imsi",
      "cell-hni",
      "cell-provider",
      "cell-status",
      "cell-signal",
      "cell-apn",
      "connmanctl-technologies",
      "connmanctl-services",
      "connmanctl-state",
      "ip-link-wwan0",
      "ip-addr-wwan0",
      "ip-route",
      "proc-net-dev",
      "cell-support-at",
    ],
    heavy_script: `(
echo "===== CONTROLLER INFO ====="
date
version
sid

echo ""
echo "===== CELLULAR DIAGNOSTICS START ====="
echo "===== CELLULAR CONNECTIVITY TEST ====="
cellular-check

echo ""
echo "===== BASIC CELL INFO ====="
cell-imei
cell-ccid
cell-imsi
cell-hni
cell-provider
cell-status
cell-signal
cell-apn

echo ""
echo "===== NETWORK TECHNOLOGY ====="
connmanctl technologies
connmanctl services
connmanctl state

echo ""
echo "===== INTERFACE / ROUTING ====="
ip link show wwan0
ip addr show wwan0
ip route
cat /proc/net/dev

echo ""
echo "===== MODEM / RADIO DIAGNOSTICS ====="
cell-support --no-ofono --at
echo "===== CELLULAR DIAGNOSTICS END ====="
)`,
  },
  {
    id: "sim-picker",
    label: "SIM Picker",
    icon: "📶",
    description: "Full cellular diagnostics + carrier scan. Populates both Cellular and SIM Picker cards (~3 min).",
    affected_interfaces: ["cellular", "sim_picker", "system"],
    when_to_run: "When cellular has no service or weak signal and you want to know if a different carrier SIM would work better.",
    time_warning: "Carrier scan takes approximately 3 minutes.",
    light_command_ids: [],
    heavy_command_ids: ["cell-support-scan"],
    heavy_script: `(
echo "===== SIM PICKER START ====="
date
version
sid

echo ""
echo "===== CELLULAR DIAGNOSTICS START ====="
echo "===== CELLULAR CONNECTIVITY TEST ====="
cellular-check

echo ""
echo "===== BASIC CELL INFO ====="
cell-imei
cell-ccid
cell-imsi
cell-hni
cell-provider
cell-status
cell-signal
cell-apn

echo ""
echo "===== NETWORK TECHNOLOGY ====="
connmanctl technologies
connmanctl services
connmanctl state

echo ""
echo "===== INTERFACE / ROUTING ====="
ip link show wwan0
ip addr show wwan0
ip route
cat /proc/net/dev

echo ""
echo "===== MODEM / RADIO DIAGNOSTICS ====="
cell-support --no-ofono --at --scan
echo "===== CELLULAR DIAGNOSTICS END ====="

echo ""
echo "===== SIM PICKER END ====="
)`,
  },
  {
    id: "pressure-mp3",
    label: "Pressure (MP3 / CDS)",
    icon: "💧",
    description: "Pressure diagnostics for MP3 and CDS systems — source and distribution sensors (P1 supply not wired on these platforms).",
    affected_interfaces: ["pressure", "system"],
    when_to_run: "When validating hydraulic pressure sensor behavior on MP3 or CDS controllers.",
    light_command_ids: ["pressure-monitor"],
    heavy_command_ids: ["date", "version", "sid", "pressure-monitor"],
    heavy_script: `(
echo "===== CONTROLLER INFO ====="
date
version
sid

echo ""
echo "===== PRESSURE SNAPSHOT ====="
pressure-monitor -v --hhc=mp3 --pressure-sensor=source -u us
pressure-monitor -v --hhc=mp3 --pressure-sensor=distribution -u us

echo ""
echo "===== PRESSURE LIVE ====="
pressure-monitor -v --hhc=mp3 --pressure-sensor=source -u us --period=500 --wait=10
pressure-monitor -v --hhc=mp3 --pressure-sensor=distribution -u us --period=500 --wait=10
)`,
  },
  {
    id: "pressure-hp6",
    label: "Pressure (HP6)",
    icon: "💧",
    description: "Pressure diagnostics for HP6 systems — source, supply, and distribution sensors (all three required).",
    affected_interfaces: ["pressure", "system"],
    when_to_run: "When validating hydraulic pressure sensor behavior on HP6 controllers.",
    light_command_ids: ["pressure-monitor"],
    heavy_command_ids: ["date", "version", "sid", "pressure-monitor"],
    heavy_script: `(
echo "===== CONTROLLER INFO ====="
date
version
sid

echo ""
echo "===== PRESSURE SNAPSHOT ====="
pressure-monitor -v --hhc=hp6 --pressure-sensor=source -u us
pressure-monitor -v --hhc=hp6 --pressure-sensor=supply -u us
pressure-monitor -v --hhc=hp6 --pressure-sensor=distribution -u us

echo ""
echo "===== PRESSURE LIVE ====="
pressure-monitor -v --hhc=hp6 --pressure-sensor=source -u us --period=500 --wait=10
pressure-monitor -v --hhc=hp6 --pressure-sensor=supply -u us --period=500 --wait=10
pressure-monitor -v --hhc=hp6 --pressure-sensor=distribution -u us --period=500 --wait=10
)`,
  },
  {
    id: "satellite",
    label: "Satellite",
    icon: "🛰️",
    description: "Satellite diagnostics — quick sanity and full loopback validation",
    affected_interfaces: ["satellite", "system"],
    light_command_ids: [
      "sat-imei",
      "satellite-check-light",
    ],
    heavy_command_ids: [
      "date",
      "version",
      "sid",
      "sat-imei",
      "connmanctl-technologies",
      "connmanctl-services",
      "connmanctl-state",
      "ip-route",
      "proc-net-dev",
      "satellite-check-loopback-full",
    ],
    light_script: `(
echo "===== CONTROLLER INFO ====="
date
version
sid

echo ""
echo "===== SATELLITE DIAGNOSTICS START ====="
echo ""
echo "===== SATELLITE BASIC ====="
sat-imei

echo ""
echo "===== NETWORK STATE ====="
connmanctl technologies
connmanctl services
connmanctl state

echo ""
echo "===== QUICK SATELLITE CHECK ====="
satellite-check -c 1 -W 1 -w 1
echo "===== SATELLITE DIAGNOSTICS END ====="
)`,
    heavy_script: `(
echo "===== CONTROLLER INFO ====="
date
version
sid

echo ""
echo "===== SATELLITE DIAGNOSTICS START ====="
echo ""
echo "===== SATELLITE BASIC ====="
sat-imei

echo ""
echo "===== NETWORK STATE ====="
connmanctl technologies
connmanctl services
connmanctl state

echo ""
echo "===== SATELLITE LOOPBACK TEST ====="
satellite-check -t
echo "===== SATELLITE DIAGNOSTICS END ====="
)`,
  },
  {
    id: "system",
    label: "System",
    icon: "🖥",
    description: "Firmware version, controller serial number, and release metadata. Use at the start of any session to confirm which controller you are connected to and whether the firmware is current.",
    affected_interfaces: ["system"],
    when_to_run: "At the start of any session to confirm controller identity and firmware version.",
    light_command_ids: ["version", "sid", "release", "cell-imei", "sat-imei", "cat-station-info", "cat-system-info"],
    heavy_command_ids: ["version", "sid", "release", "cell-imei", "sat-imei", "cat-station-info", "cat-system-info"],
  },
  {
    id: "firmware",
    label: "Firmware",
    icon: "💾",
    description: "Check firmware version from the controller.",
    affected_interfaces: ["system"],
    when_to_run: "To check current firmware version without running full system diagnostics.",
    light_command_ids: ["version"],
    heavy_command_ids: ["version"],
  },
  {
    id: "networking-all",
    label: "All Networking",
    icon: "⚡",
    description: "Runs a quick first-pass check across Ethernet, Wi-Fi, and cellular in a single wrapped block so parser-driven cards update cleanly in real time.",
    affected_interfaces: ["ethernet", "wifi", "cellular", "system"],
    when_to_run: "First-pass network check after install or when multiple interfaces need a quick status sweep (~45 seconds total).",
    light_command_ids: ["date", "version", "sid", "ethernet-check", "wifi-check", "wifi-signal", "cellular-check"],
    heavy_command_ids: ["date", "version", "sid", "ethernet-check", "wifi-check", "wifi-signal", "cellular-check"],
    heavy_script: `(
echo "===== CONTROLLER INFO ====="
date
version
sid

echo "===== ETH DIAGNOSTICS START ====="
ethernet-check
echo "===== ETH DIAGNOSTICS END ====="

echo "===== WIFI DIAGNOSTICS START ====="
wifi-check
wifi-signal
echo "===== WIFI DIAGNOSTICS END ====="

echo "===== CELLULAR DIAGNOSTICS START ====="
echo "===== CELLULAR CONNECTIVITY TEST ====="
cellular-check
echo "===== CELLULAR DIAGNOSTICS END ====="
)`,
  },
  {
    id: "full-diags",
    label: "Full Diags + Satellite",
    icon: "🔬",
    description: "Complete suite including satellite loopback (~12 min total)",
    affected_interfaces: ["ethernet", "wifi", "cellular", "pressure", "satellite", "system"],
    when_to_run: "New install sign-off, post-repair baseline, or when a site has intermittent issues and you need a full picture.",
    light_command_ids: [],
    heavy_command_ids: [
      "ethernet-check", "ethtool-eth0", "ifconfig-eth0",
      "wifi-check", "wifi-signal",
      "cellular-check", "cell-signal", "cell-provider", "cell-ccid", "cell-imei", "cell-apn", "cell-status",
      "satellite-check-loopback-full", "sat-imei",
      "pressure-monitor",
      "cat-station-info", "cat-system-info",
      "version", "sid", "release",
    ],
    heavy_script: `(
echo "===== CONTROLLER INFO ====="
date
version
sid

echo ""
echo "===== ETH DIAGNOSTICS START ====="

echo ""
echo "--- FRONTLINE ---"
ethernet-check

echo ""
echo "--- LINK / PHY ---"
ethtool eth0
cat /sys/class/net/eth0/carrier
cat /sys/class/net/eth0/operstate
dmesg | grep -i eth

echo ""
echo "--- INTERFACE ---"
ip link show eth0
ip addr show eth0

echo ""
echo "--- ROUTING / DNS ---"
ip route
cat /etc/resolv.conf

echo ""
echo "--- CONNECTIVITY ---"
ping -c 3 8.8.8.8
ping -c 3 google.com

echo ""
echo "--- DRIVER / STATS ---"
ethtool -i eth0
ethtool -S eth0
cat /proc/net/dev

echo ""
echo "===== ETH DIAGNOSTICS END ====="

echo ""
echo "===== WIFI DIAGNOSTICS START ====="

echo ""
echo "--- FRONTLINE ---"
wifi-check
wifi-signal

echo ""
echo "--- IW ---"
iw dev
iw dev wlan0 info
iw dev wlan0 link
iw dev wlan0 station dump

echo ""
echo "--- INTERFACE ---"
ip link show wlan0
ip addr show wlan0

echo ""
echo "--- ROUTING / DNS ---"
ip route
cat /etc/resolv.conf

echo ""
echo "--- CONNMAN ---"
connmanctl technologies
connmanctl services
connmanctl state

echo ""
echo "--- DRIVER / STATS ---"
ethtool -i wlan0
cat /proc/net/dev

echo ""
echo "===== WIFI DIAGNOSTICS END ====="

echo ""
echo "===== CELLULAR DIAGNOSTICS START ====="
echo "===== CELLULAR CONNECTIVITY TEST ====="
cellular-check

echo ""
echo "===== BASIC CELL INFO ====="
cell-imei
cell-ccid
cell-imsi
cell-hni
cell-provider
cell-status
cell-signal
cell-apn

echo ""
echo "===== NETWORK TECHNOLOGY ====="
connmanctl technologies
connmanctl services
connmanctl state

echo ""
echo "===== INTERFACE / ROUTING ====="
ip link show wwan0
ip addr show wwan0
ip route
cat /proc/net/dev

echo ""
echo "===== MODEM / RADIO DIAGNOSTICS ====="
cell-support --no-ofono --at
echo "===== CELLULAR DIAGNOSTICS END ====="

echo ""
echo "===== SYSTEM ====="
cat /var/etc/fwds/station_info
cat /var/etc/fwds/system_info
version
sid
release

echo ""
echo "===== PRESSURE SNAPSHOT ====="
pressure-monitor -v --hhc=mp3 --pressure-sensor=source -u us
pressure-monitor -v --hhc=mp3 --pressure-sensor=supply -u us
pressure-monitor -v --hhc=mp3 --pressure-sensor=distribution -u us

echo ""
echo "===== PRESSURE LIVE ====="
pressure-monitor -v --hhc=mp3 --pressure-sensor=source -u us --period=500 --wait=10
pressure-monitor -v --hhc=mp3 --pressure-sensor=supply -u us --period=500 --wait=10
pressure-monitor -v --hhc=mp3 --pressure-sensor=distribution -u us --period=500 --wait=10

echo ""
echo "===== SATELLITE DIAGNOSTICS START ====="
echo ""
echo "===== SATELLITE BASIC ====="
sat-imei

echo ""
echo "===== SATELLITE LOOPBACK TEST ====="
satellite-check -t
echo "===== SATELLITE DIAGNOSTICS END ====="
)`,
    time_warning: "Includes satellite loopback diagnostics. Use 'Full Diags (no satellite)' to skip.",
  },
  {
    id: "full-diags-no-sat",
    label: "Full Diags (no loopback)",
    icon: "🔬",
    description: "Complete diagnostics without satellite loopback. Includes satellite IMEI verification plus Ethernet, Wi-Fi, cellular, and system checks.",
    affected_interfaces: ["ethernet", "wifi", "cellular", "pressure", "satellite", "system"],
    when_to_run: "Use when you want full network/system coverage but need to skip the long satellite loopback test.",
    light_command_ids: [],
    heavy_command_ids: [
      "ethernet-check", "ethtool-eth0", "ifconfig-eth0",
      "wifi-check", "wifi-signal",
      "cellular-check", "cell-signal", "cell-provider", "cell-ccid", "cell-imei", "cell-apn", "cell-status",
      "sat-imei",
      "pressure-monitor",
      "cat-station-info", "cat-system-info",
      "version", "sid", "release",
    ],
    heavy_script: `(
echo "===== CONTROLLER INFO ====="
date
version
sid

echo ""
echo "===== ETH DIAGNOSTICS START ====="

echo ""
echo "--- FRONTLINE ---"
ethernet-check

echo ""
echo "--- LINK / PHY ---"
ethtool eth0
cat /sys/class/net/eth0/carrier
cat /sys/class/net/eth0/operstate
dmesg | grep -i eth

echo ""
echo "--- INTERFACE ---"
ip link show eth0
ip addr show eth0

echo ""
echo "--- ROUTING / DNS ---"
ip route
cat /etc/resolv.conf

echo ""
echo "--- CONNECTIVITY ---"
ping -c 3 8.8.8.8
ping -c 3 google.com

echo ""
echo "--- DRIVER / STATS ---"
ethtool -i eth0
ethtool -S eth0
cat /proc/net/dev

echo ""
echo "===== ETH DIAGNOSTICS END ====="

echo ""
echo "===== WIFI DIAGNOSTICS START ====="

echo ""
echo "--- FRONTLINE ---"
wifi-check
wifi-signal

echo ""
echo "--- IW ---"
iw dev
iw dev wlan0 info
iw dev wlan0 link
iw dev wlan0 station dump

echo ""
echo "--- INTERFACE ---"
ip link show wlan0
ip addr show wlan0

echo ""
echo "--- ROUTING / DNS ---"
ip route
cat /etc/resolv.conf

echo ""
echo "--- CONNMAN ---"
connmanctl technologies
connmanctl services
connmanctl state

echo ""
echo "--- DRIVER / STATS ---"
ethtool -i wlan0
cat /proc/net/dev

echo ""
echo "===== WIFI DIAGNOSTICS END ====="

echo ""
echo "===== CELLULAR DIAGNOSTICS START ====="
echo "===== CELLULAR CONNECTIVITY TEST ====="
cellular-check

echo ""
echo "===== BASIC CELL INFO ====="
cell-imei
cell-ccid
cell-imsi
cell-hni
cell-provider
cell-status
cell-signal
cell-apn

echo ""
echo "===== NETWORK TECHNOLOGY ====="
connmanctl technologies
connmanctl services
connmanctl state

echo ""
echo "===== INTERFACE / ROUTING ====="
ip link show wwan0
ip addr show wwan0
ip route
cat /proc/net/dev

echo ""
echo "===== MODEM / RADIO DIAGNOSTICS ====="
cell-support --no-ofono --at
echo "===== CELLULAR DIAGNOSTICS END ====="

echo ""
echo "===== SYSTEM ====="
cat /var/etc/fwds/station_info
cat /var/etc/fwds/system_info
version
sid
release

echo ""
echo "===== PRESSURE SNAPSHOT ====="
pressure-monitor -v --hhc=mp3 --pressure-sensor=source -u us
pressure-monitor -v --hhc=mp3 --pressure-sensor=supply -u us
pressure-monitor -v --hhc=mp3 --pressure-sensor=distribution -u us

echo ""
echo "===== PRESSURE LIVE ====="
pressure-monitor -v --hhc=mp3 --pressure-sensor=source -u us --period=500 --wait=10
pressure-monitor -v --hhc=mp3 --pressure-sensor=supply -u us --period=500 --wait=10
pressure-monitor -v --hhc=mp3 --pressure-sensor=distribution -u us --period=500 --wait=10

echo ""
echo "===== SATELLITE DIAGNOSTICS START ====="
echo ""
echo "===== SATELLITE BASIC ====="
sat-imei
echo "===== SATELLITE DIAGNOSTICS END ====="
)`,
  },
];
