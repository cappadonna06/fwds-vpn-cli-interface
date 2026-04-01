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
    description: "Test and confirm Wi-Fi connectivity.",
    reboot_required: false,
    guard: "none",
    est_seconds: 10,
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
    description: "Test cellular modem operation and signal level.",
    reboot_required: false,
    guard: "none",
    est_seconds: 15,
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
    id: "satellite-check-m",
    label: "satellite-check -m",
    command: "satellite-check -m",
    category: "diagnostic",
    description: "Monitor satellite status continuously. After 10 minutes prints visibility uptime.",
    reboot_required: false,
    guard: "none",
    est_seconds: 600,
    when_to_run: "When satellite connectivity needs to be verified. Runs for ~10 minutes.",
    what_to_look_for: [
      "Watch for uptime percentage — higher is better",
      "< 50% uptime may indicate obstruction or modem issue",
      "Press Ctrl+C to stop early",
    ],
    related_command_ids: ["sat-imei", "setup-satellite"],
    tags: ["network", "iridium", "backup"],
  },
  {
    id: "satellite-check-t",
    label: "satellite-check -t",
    command: "satellite-check -t",
    category: "diagnostic",
    description: "Run Frontline loopback satellite test. Run monitor mode first to verify visibility.",
    reboot_required: false,
    guard: "none",
  },
  {
    id: "satellite-check-r",
    label: "satellite-check -r",
    command: "satellite-check -r",
    category: "diagnostic",
    description: "Run receive mode satellite test. Requires initiating a server request when prompted.",
    reboot_required: false,
    guard: "none",
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
    id: "sid",
    label: "sid",
    command: "sid",
    category: "info",
    description: "Display controller serial number.",
    reboot_required: false,
    guard: "none",
    est_seconds: 1,
    when_to_run: "To confirm controller serial number. Always run at start of session.",
    related_command_ids: ["version", "release"],
  },
  {
    id: "version",
    label: "version",
    command: "version",
    category: "info",
    description: "Display controller firmware version.",
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
    category: "info",
    description: "Display cellular signal strength (0–100%).",
    reboot_required: false,
    guard: "none",
    est_seconds: 2,
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
    category: "info",
    description: "Display Wi-Fi signal strength.",
    reboot_required: false,
    guard: "none",
    est_seconds: 2,
    when_to_run: "Quick check of Wi-Fi signal strength.",
    what_to_look_for: [
      "> 70 is good",
      "40–70 is acceptable",
      "< 40 investigate antenna or distance",
    ],
    related_command_ids: ["wifi-check"],
  },
  {
    id: "cell-imei",
    label: "cell-imei",
    command: "cell-imei",
    category: "info",
    description: "Display cellular modem IMEI.",
    reboot_required: false,
    guard: "none",
  },
  {
    id: "cell-ccid",
    label: "cell-ccid",
    command: "cell-ccid",
    category: "info",
    description: "Display SIM ICCID.",
    reboot_required: false,
    guard: "none",
  },
  {
    id: "cell-apn",
    label: "cell-apn",
    command: "cell-apn",
    category: "info",
    description: "Display cellular APN.",
    reboot_required: false,
    guard: "none",
  },
  {
    id: "cell-provider",
    label: "cell-provider",
    command: "cell-provider",
    category: "info",
    description: "Display cellular provider name.",
    reboot_required: false,
    guard: "none",
  },
  {
    id: "cell-status",
    label: "cell-status",
    command: "cell-status",
    category: "info",
    description: "Display cellular registration status.",
    reboot_required: false,
    guard: "none",
  },
  {
    id: "sat-imei",
    label: "sat-imei",
    command: "sat-imei",
    category: "info",
    description: "Display satellite modem IMEI.",
    reboot_required: false,
    guard: "none",
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
];

export const FAVORITE_COMMAND_IDS = [
  "setup-station",
  "setup-network",
  "ethernet-check",
  "wifi-check",
  "cellular-check",
  "satellite-check-m",
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
  when_to_run?: string;
  light_command_ids: string[];
  heavy_command_ids: string[];
  time_warning?: string;
  light_script?: string;
  heavy_script?: string;
}

export const DIAGNOSTIC_BLOCKS: DiagnosticBlock[] = [
  {
    id: "ethernet",
    label: "Ethernet",
    icon: "🌐",
    description: "Physical link, IP assignment, DNS, and internet reachability. Tests that the cable is connected, an IP is assigned via DHCP, DNS resolves, and the internet is reachable.",
    when_to_run: "After setup-ethernet, after any network change, or when the site reports connectivity issues.",
    light_command_ids: ["ethernet-check"],
    heavy_command_ids: ["ethernet-check", "ethtool-eth0", "ifconfig-eth0"],
    heavy_script: `echo "===== ETH DIAGNOSTICS START ====="

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
echo "--- CONNMAN ---"
connmanctl technologies
connmanctl services
connmanctl state

echo ""
echo "--- DRIVER / STATS ---"
ethtool -i eth0
ethtool -S eth0
cat /proc/net/dev

echo ""
echo "===== ETH DIAGNOSTICS END ====="`,
  },
  {
    id: "wifi",
    label: "Wi-Fi",
    icon: "📶",
    description: "Wireless connection, signal strength, and interface details. Verifies the controller is associated to the correct SSID, reports signal quality, and lists visible networks.",
    when_to_run: "After setup-wifi or when Wi-Fi connectivity or signal quality is in question.",
    light_command_ids: ["wifi-check", "wifi-signal"],
    heavy_command_ids: ["wifi-check", "wifi-signal", "iwconfig", "iwlist-scan"],
  },
  {
    id: "cellular",
    label: "Cellular",
    icon: "📱",
    description: "LTE-M modem connectivity, signal strength, provider, and SIM details. Confirms the modem is registered, signal is acceptable, and the SIM and APN are configured correctly.",
    when_to_run: "After setup-cellular or when the site reports cellular connectivity issues or alerts are not reaching the cloud.",
    light_command_ids: ["cellular-check", "cell-signal"],
    heavy_command_ids: ["cellular-check", "cell-signal", "cell-provider", "cell-ccid", "cell-imei", "cell-apn", "cell-status"],
  },
  {
    id: "satellite",
    label: "Satellite",
    icon: "🛰",
    description: "Iridium satellite modem sky visibility and uptime percentage. Runs continuously for ~10 minutes and reports the percentage of time the satellite was in view. Use this to confirm the modem has sufficient sky visibility before relying on satellite backup.",
    when_to_run: "When satellite connectivity needs to be verified or when satellite-dependent alerts are not firing.",
    light_command_ids: ["satellite-check-m"],
    heavy_command_ids: ["satellite-check-m", "sat-imei"],
    time_warning: "satellite-check -m runs for ~10 minutes. Do not close the terminal.",
  },
  {
    id: "system",
    label: "System",
    icon: "🖥",
    description: "Firmware version, controller serial number, and release metadata. Use at the start of any session to confirm which controller you are connected to and whether the firmware is current.",
    when_to_run: "At the start of any session to confirm controller identity and firmware version.",
    light_command_ids: ["version", "sid", "release"],
    heavy_command_ids: ["version", "sid", "release"],
  },
  {
    id: "networking-all",
    label: "Networking — All Light",
    icon: "⚡",
    description: "Runs the light-tier check on all four network interfaces in sequence: Ethernet, Wi-Fi, cellular, and signal readings. Good first-pass sweep after install or when multiple interfaces need a quick status check.",
    when_to_run: "First-pass network check after install or when multiple interfaces need a quick status sweep (~45 seconds total).",
    light_command_ids: ["ethernet-check", "wifi-check", "wifi-signal", "cellular-check", "cell-signal"],
    heavy_command_ids: ["ethernet-check", "wifi-check", "wifi-signal", "cellular-check", "cell-signal"],
  },
  {
    id: "full-diags",
    label: "Full Diagnostics",
    icon: "🔬",
    description: "Complete diagnostic suite across all interfaces using the heavy tier. Covers Ethernet link and IP details, Wi-Fi signal and scan, full cellular modem info, satellite visibility, and system identity. Produces a comprehensive baseline suitable for post-install sign-off or hard-to-diagnose issues.",
    when_to_run: "New install sign-off, post-repair baseline, or when a site has intermittent issues and you need a full picture.",
    light_command_ids: [],
    heavy_command_ids: [
      "ethernet-check", "ethtool-eth0", "ifconfig-eth0",
      "wifi-check", "wifi-signal",
      "cellular-check", "cell-signal", "cell-provider", "cell-ccid", "cell-imei", "cell-apn", "cell-status",
      "satellite-check-m", "sat-imei",
      "version", "sid", "release",
    ],
    time_warning: "Includes satellite-check -m (~10 min). Use 'Full Diags (no satellite)' to skip.",
  },
  {
    id: "full-diags-no-sat",
    label: "Full Diags (no satellite)",
    icon: "🔬",
    description: "Complete diagnostic suite excluding satellite commands. Same coverage as Full Diagnostics for Ethernet, Wi-Fi, cellular, and system — use when satellite is not installed or not relevant to the issue at hand.",
    when_to_run: "Same as Full Diagnostics but when satellite is not installed or not relevant to the current issue.",
    light_command_ids: [],
    heavy_command_ids: [
      "ethernet-check", "ethtool-eth0", "ifconfig-eth0",
      "wifi-check", "wifi-signal",
      "cellular-check", "cell-signal", "cell-provider", "cell-ccid", "cell-imei", "cell-apn", "cell-status",
      "version", "sid", "release",
    ],
  },
];
