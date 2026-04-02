use regex::Regex;
use std::collections::HashMap;

use crate::{
    CellularDiagnostic, DiagStatus, DiagnosticState, EthernetDiagnostic, SatelliteDiagnostic,
    SystemDiagnostic, WifiDiagnostic,
};

#[derive(Clone, Debug)]
struct CommandBlock {
    command: String,
    body: String,
}

pub fn parse_log_into_state(log: &str, state: &mut DiagnosticState) {
    let blocks = split_blocks(log);
    if blocks.is_empty() {
        return;
    }

    let mut latest: HashMap<String, String> = HashMap::new();
    for block in blocks {
        latest.insert(block.command, block.body);
    }

    let wifi = parse_wifi(&latest);

    let cellular = parse_cellular_from_latest(&latest);

    let satellite = parse_satellite(
        find_latest(&latest, &["setup-satellite"]),
        latest
            .get("satellite-check -t")
            .or_else(|| latest.get("satellite-check -m"))
            .or_else(|| latest.get("satellite-check"))
            .or_else(|| find_latest(&latest, &["run satellite diagnostics"])),
    );

    let ethernet = parse_ethernet(
        find_latest(&latest, &["ethernet-check", "run ethernet diagnostics"]),
        find_latest(&latest, &["ethtool eth0", "run ethernet diagnostics"]),
        find_latest(
            &latest,
            &[
                "ifconfig eth0",
                "ip addr show eth0",
                "run ethernet diagnostics",
                "ethernet diags heavy",
            ],
        ),
        find_latest(
            &latest,
            &[
                "cat /proc/net/dev",
                "run ethernet diagnostics",
                "ethernet diags heavy",
            ],
        ),
        find_latest(
            &latest,
            &[
                "cat /sys/class/net/eth0/operstate",
                "run ethernet diagnostics",
                "ethernet diags heavy",
            ],
        ),
    );

    let system = parse_system(
        latest.get("sid"),
        latest.get("version"),
        latest.get("release"),
    );

    if wifi.is_some() {
        if let Some(next) = wifi {
            state.wifi = Some(match state.wifi.take() {
                Some(prev) => merge_wifi_diag(prev, next),
                None => next,
            });
        }
    }
    if cellular.is_some() {
        if let Some(next) = cellular {
            state.cellular = Some(match state.cellular.take() {
                Some(prev) => merge_cellular_diag(prev, next),
                None => next,
            });
        }
    }
    if satellite.is_some() {
        state.satellite = satellite;
    }
    if ethernet.is_some() {
        if let Some(next) = ethernet {
            state.ethernet = Some(match state.ethernet.take() {
                Some(prev) => merge_ethernet_diag(prev, next),
                None => next,
            });
        }
    }
    if system.sid.is_some() || system.version.is_some() || system.release_date.is_some() {
        state.system = Some(system);
    }
}

fn wifi_has_authoritative_check(diag: &WifiDiagnostic) -> bool {
    diag.check_result != "Unknown" || diag.check_error.is_some()
}

fn cellular_has_authoritative_check(diag: &CellularDiagnostic) -> bool {
    diag.check_result != "Unknown" || diag.check_error.is_some()
}

fn ethernet_has_authoritative_check(diag: &EthernetDiagnostic) -> bool {
    diag.check_result != "Unknown"
}

fn merge_wifi_diag(prev: WifiDiagnostic, mut next: WifiDiagnostic) -> WifiDiagnostic {
    if wifi_has_authoritative_check(&next) {
        return next;
    }
    if wifi_has_authoritative_check(&prev) {
        next.status = prev.status;
        next.summary = prev.summary;
        next.check_result = prev.check_result;
        next.check_error = prev.check_error;
        next.internet_reachable = prev.internet_reachable;
        next.wifi_state = prev.wifi_state;
        next.access_point = next.access_point.or(prev.access_point);
        next.strength_score = next.strength_score.or(prev.strength_score);
        next.strength_label = next.strength_label.or(prev.strength_label);
        next.ipv4 = next.ipv4 || prev.ipv4;
        next.ipv6 = next.ipv6 || prev.ipv6;
        if next.dns_servers == "—" {
            next.dns_servers = prev.dns_servers;
        }
        next.check_avg_latency_ms = next.check_avg_latency_ms.or(prev.check_avg_latency_ms);
        next.check_packet_loss_pct = next.check_packet_loss_pct.max(prev.check_packet_loss_pct);
    }
    next
}

fn merge_cellular_diag(
    prev: CellularDiagnostic,
    mut next: CellularDiagnostic,
) -> CellularDiagnostic {
    if cellular_has_authoritative_check(&next) {
        return next;
    }
    if cellular_has_authoritative_check(&prev) {
        next.status = prev.status;
        next.summary = prev.summary;
        next.check_result = prev.check_result;
        next.check_error = prev.check_error;
        next.internet_reachable = prev.internet_reachable;
        next.cell_state = prev.cell_state;
        next.provider_code = next.provider_code.or(prev.provider_code);
        next.strength_score = next.strength_score.or(prev.strength_score);
        next.strength_label = next.strength_label.or(prev.strength_label);
        next.ipv4 = next.ipv4 || prev.ipv4;
        next.ipv6 = next.ipv6 || prev.ipv6;
        if next.dns_servers == "—" {
            next.dns_servers = prev.dns_servers;
        }
        next.check_avg_latency_ms = next.check_avg_latency_ms.or(prev.check_avg_latency_ms);
        next.check_packet_loss_pct = next.check_packet_loss_pct.max(prev.check_packet_loss_pct);
        next.recommended_action = next.recommended_action.or(prev.recommended_action);
        if next.other_actions.is_empty() {
            next.other_actions = prev.other_actions;
        }
    }
    next
}

fn merge_ethernet_diag(
    prev: EthernetDiagnostic,
    mut next: EthernetDiagnostic,
) -> EthernetDiagnostic {
    if ethernet_has_authoritative_check(&next) {
        return next;
    }
    if ethernet_has_authoritative_check(&prev) {
        next.status = prev.status;
        next.summary = prev.summary;
        next.check_result = prev.check_result;
        next.internet_reachable = prev.internet_reachable;
        if next.eth_state == "unknown" || next.eth_state == "up" {
            next.eth_state = prev.eth_state;
        }
        next.ipv4 = next.ipv4 || prev.ipv4;
        next.ipv6 = next.ipv6 || prev.ipv6;
        if next.dns_servers == "—" {
            next.dns_servers = prev.dns_servers;
        }
    }
    next
}

fn find_latest<'a>(latest: &'a HashMap<String, String>, names: &[&str]) -> Option<&'a String> {
    for name in names {
        if let Some(v) = latest.get(*name) {
            return Some(v);
        }
    }
    latest.iter().find_map(|(k, v)| {
        let key = k.to_ascii_lowercase();
        if names.iter().any(|n| key.contains(&n.to_ascii_lowercase())) {
            Some(v)
        } else {
            None
        }
    })
}

fn find_latest_body_contains<'a>(
    latest: &'a HashMap<String, String>,
    markers: &[&str],
) -> Option<&'a String> {
    latest.values().find(|body| {
        let lower = body.to_ascii_lowercase();
        markers
            .iter()
            .all(|m| lower.contains(&m.to_ascii_lowercase()))
    })
}

fn split_blocks(log: &str) -> Vec<CommandBlock> {
    let prompt_re = Regex::new(
        r"^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{4}\s+)?(?:\[\d+\])?#\s*(.+)$",
    )
    .expect("prompt regex");
    let prompt_inline_re =
        Regex::new(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{4}\s+\[\d+\]#\s*.*$")
            .expect("inline prompt regex");
    let continuation_re = Regex::new(r"^>\s*(.+)$").expect("continuation regex");
    let ansi_re = Regex::new(r"\x1B\[[0-?]*[ -/]*[@-~]").expect("ansi regex");

    let mut blocks = Vec::new();
    let mut current_cmd: Option<String> = None;
    let mut current_body = String::new();

    for line in log.lines() {
        let cleaned = ansi_re.replace_all(line, "");
        let cleaned = cleaned.trim_matches(|c: char| c == '\r' || c == '\u{0}');
        let cleaned = cleaned.trim_start();

        let prompt_candidate = if prompt_re.is_match(cleaned) {
            Some(cleaned)
        } else {
            prompt_inline_re.find(cleaned).map(|m| m.as_str())
        };

        if let Some(candidate) = prompt_candidate {
            if let Some(cap) = prompt_re.captures(candidate) {
                if let Some(cmd) = current_cmd.take() {
                    blocks.push(CommandBlock {
                        command: cmd,
                        body: current_body.trim().to_string(),
                    });
                    current_body.clear();
                }
                if let Some(cmd_match) = cap.get(1) {
                    current_cmd = Some(cmd_match.as_str().trim().to_string());
                }
                continue;
            }
        }

        if let Some(cap) = continuation_re.captures(cleaned) {
            if let Some(cmd_match) = cap.get(1) {
                let chunk = cmd_match.as_str().trim();
                if !chunk.is_empty() {
                    if let Some(cmd) = current_cmd.as_mut() {
                        cmd.push(' ');
                        cmd.push_str(chunk);
                    }
                }
            }
            continue;
        }

        if current_cmd.is_some() {
            current_body.push_str(cleaned);
            current_body.push('\n');
        }
    }

    if let Some(cmd) = current_cmd {
        blocks.push(CommandBlock {
            command: cmd,
            body: current_body.trim().to_string(),
        });
    }

    blocks
}

#[cfg(test)]
mod tests {
    use super::{parse_log_into_state, split_blocks};
    use crate::DiagnosticState;

    #[test]
    fn split_blocks_parses_timestamped_prompts() {
        let log = "2026-04-01T10:18:37-0600 [22611067]# sid\n22611067\n2026-04-01T10:18:43-0600 [22611067]# version\nr3.3.1\n";
        let blocks = split_blocks(log);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].command, "sid");
        assert_eq!(blocks[0].body, "22611067");
        assert_eq!(blocks[1].command, "version");
        assert_eq!(blocks[1].body, "r3.3.1");
    }

    #[test]
    fn split_blocks_handles_continuation_prompts() {
        let log = "2026-04-01T10:19:20-0600 [22611067]# (\n> wifi-check\n> wifi-signal\n> )\nTesting Wi-Fi...\nDone: Success\n2026-04-01T10:19:53-0600 [22611067]# sid\n22611067\n";
        let blocks = split_blocks(log);
        assert_eq!(blocks.len(), 2);
        assert!(blocks[0].command.contains("wifi-check"));
        assert!(blocks[0].command.contains("wifi-signal"));
        assert!(blocks[0].body.contains("Done: Success"));
    }

    #[test]
    fn parse_log_keeps_existing_wifi_when_new_chunk_has_no_wifi_blocks() {
        let mut state = DiagnosticState::default();
        let wifi_log = "2026-04-01T10:32:46-0600 [22611067]# wifi-check\nTesting Wi-Fi...\nInternet reachability state: online\nWi-Fi state: online\nDone: Success\n2026-04-01T10:32:58-0600 [22611067]# wifi-signal\n\"wlan0\" signal strength: -46 dBm\n";
        parse_log_into_state(wifi_log, &mut state);
        assert!(state.wifi.is_some());
        let first_summary = state
            .wifi
            .as_ref()
            .map(|w| w.summary.clone())
            .unwrap_or_default();

        let non_wifi_log = "2026-04-01T10:33:10-0600 [22611067]# sid\n22611067\n";
        parse_log_into_state(non_wifi_log, &mut state);
        assert!(state.wifi.is_some());
        let second_summary = state
            .wifi
            .as_ref()
            .map(|w| w.summary.clone())
            .unwrap_or_default();
        assert_eq!(first_summary, second_summary);
    }

    #[test]
    fn split_blocks_handles_prompt_glued_to_previous_output() {
        let log = "Done: Success2026-04-01T10:53:01-0600 [22611067]# ethernet-check\nTesting Ethernet...\nDone: Success\n";
        let blocks = split_blocks(log);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].command, "ethernet-check");
        assert!(blocks[0].body.contains("Done: Success"));
    }

    #[test]
    fn parse_log_parses_cellular_heavy_multiline_block() {
        let mut state = DiagnosticState::default();
        let log = r#"2026-04-01T10:19:20-0600 [22611067]# (
> echo "===== CONTROLLER INFO ====="
> date
> version
> sid
> echo "===== CELLULAR CONNECTIVITY TEST ====="
> cellular-check
> echo "===== BASIC CELL INFO ====="
> cell-imei
> cell-ccid
> cell-imsi
> cell-hni
> cell-provider
> cell-status
> cell-signal
> cell-apn
> echo "===== NETWORK TECHNOLOGY ====="
> connmanctl technologies
> connmanctl services
> connmanctl state
> echo "===== INTERFACE / ROUTING ====="
> ip link show wwan0
> ip addr show wwan0
> ip route
> cat /proc/net/dev
> echo "===== MODEM / RADIO DIAGNOSTICS ====="
> cell-support --no-ofono --at
> )
===== CONTROLLER INFO =====
Thu Apr  2 10:20:00 UTC 2026
r3.3.1
22611067

===== CELLULAR CONNECTIVITY TEST =====
Internet reachability state: online
Cellular state: ready
Cellular provider: 311480
Cellular strength: 80/100 ("strong")
Cellular supports IPv4? Yes
Cellular supports IPv6? No
Done: Success

===== BASIC CELL INFO =====
868765071689128
89148000008543971083
311270028230364
311480
311480
registered
80
vzwinternet

===== NETWORK TECHNOLOGY =====
/net/connman/technology/cellular
  Powered = True
  Connected = True
*AR cellular_311480
State = ready

===== INTERFACE / ROUTING =====
3: wwan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP mode DEFAULT group default qlen 1000
    inet 100.108.114.41/29 brd 100.108.114.47 scope global wwan0
default via 100.108.114.46 dev wwan0

===== MODEM / RADIO DIAGNOSTICS =====
+CPIN: READY
+CGATT: 1
+CREG: 0,1
+QCSQ: "CAT-M1",-62,-92,93,-14
+COPS: 0,0,"Verizon ",8
"#;
        parse_log_into_state(log, &mut state);
        let cell = state
            .cellular
            .expect("cellular should parse from heavy block");
        assert_eq!(cell.status, crate::DiagStatus::Green);
        assert_eq!(cell.check_result, "Success");
        assert_eq!(cell.wwan_ipv4_address.as_deref(), Some("100.108.114.41"));
    }

    #[test]
    fn wifi_status_does_not_downgrade_on_partial_followup_chunk() {
        let mut state = DiagnosticState::default();
        let wifi_check_log = "2026-04-01T10:32:46-0600 [22611067]# wifi-check\nTesting Wi-Fi...\nInternet reachability state: online\nWi-Fi state: ready\nDone: Success\n";
        parse_log_into_state(wifi_check_log, &mut state);
        assert_eq!(
            state.wifi.as_ref().map(|w| w.check_result.as_str()),
            Some("Success")
        );

        let partial_wifi_log = "2026-04-01T10:33:01-0600 [22611067]# iw dev wlan0 link\nConnected to 9c:0b:05:30:f7:c8 (on wlan0)\n\tSSID: lieberells\n\tsignal: -30 dBm\n";
        parse_log_into_state(partial_wifi_log, &mut state);

        let wifi = state.wifi.expect("wifi should still exist");
        assert_eq!(wifi.check_result, "Success");
        assert_eq!(wifi.status, crate::DiagStatus::Green);
        assert_eq!(wifi.ssid.as_deref(), Some("lieberells"));
    }

    #[test]
    fn ethernet_status_does_not_downgrade_on_partial_followup_chunk() {
        let mut state = DiagnosticState::default();
        let eth_check_log = "2026-04-01T10:32:46-0600 [22611067]# ethernet-check\nTesting Ethernet...\nInternet reachability state: online\nEthernet state: online\nEthernet supports IPv4? Yes\nEthernet supports IPv6? Yes\nEthernet name servers: 192.168.4.1\nDone: Success\n";
        parse_log_into_state(eth_check_log, &mut state);
        assert_eq!(
            state.ethernet.as_ref().map(|e| e.check_result.as_str()),
            Some("Success")
        );

        let partial_eth_log = "2026-04-01T10:33:01-0600 [22611067]# ethtool eth0\nSettings for eth0:\n\tSpeed: 1000Mb/s\n\tDuplex: Full\n\tLink detected: yes\n";
        parse_log_into_state(partial_eth_log, &mut state);

        let eth = state.ethernet.expect("ethernet should still exist");
        assert_eq!(eth.check_result, "Success");
        assert_eq!(eth.status, crate::DiagStatus::Green);
        assert_eq!(eth.speed.as_deref(), Some("1000Mb/s"));
    }
}

fn parse_wifi(latest: &HashMap<String, String>) -> Option<WifiDiagnostic> {
    let mut w = WifiDiagnostic {
        status: DiagStatus::Unknown,
        summary: "Incomplete data".into(),
        check_result: "Unknown".into(),
        check_error: None,
        internet_reachable: false,
        wifi_state: "unknown".into(),
        access_point: None,
        strength_score: None,
        strength_label: None,
        ipv4: false,
        ipv6: false,
        dns_servers: "—".into(),
        check_avg_latency_ms: None,
        check_packet_loss_pct: 0,
        signal_dbm: None,
        signal_dbm_trusted: false,
        interface_exists: false,
        interface_name: None,
        interface_type: None,
        mac_address: None,
        ssid: None,
        tx_power_dbm: None,
        connected: None,
        ap_bssid: None,
        frequency_mhz: None,
        tx_bitrate_mbps: None,
        link_rx_bytes: None,
        link_rx_packets: None,
        link_tx_bytes: None,
        link_tx_packets: None,
        station_signal_dbm: None,
        station_tx_retries: None,
        station_tx_failed: None,
        station_tx_bitrate_mbps: None,
        lower_up_flag: None,
        link_state: None,
        ipv4_address: None,
        ipv4_prefix: None,
        default_via_wlan0: None,
        default_gateway: None,
        connman_wifi_powered: None,
        connman_wifi_connected: None,
        connman_eth_connected: None,
        connman_cell_connected: None,
        connman_active_service: None,
        connman_wifi_active: None,
        connman_state: None,
        driver: None,
        driver_version: None,
        bus_info: None,
        proc_rx_bytes: None,
        proc_rx_packets: None,
        proc_rx_errs: None,
        proc_rx_drop: None,
        proc_tx_bytes: None,
        proc_tx_packets: None,
        proc_tx_errs: None,
    };

    let wifi_check = find_latest(latest, &["wifi-check", "wifi diagnostics"]);
    let wifi_signal = find_latest(latest, &["wifi-signal", "wifi diagnostics"]);
    let iw_dev = find_latest(latest, &["iw dev", "wifi diagnostics"]);
    let iw_info = find_latest(latest, &["iw dev wlan0 info", "wifi diagnostics"]);
    let iw_link = find_latest(latest, &["iw dev wlan0 link", "wifi diagnostics"]);
    let iw_station = find_latest(latest, &["iw dev wlan0 station dump", "wifi diagnostics"]);
    let ip_link = find_latest(latest, &["ip link show wlan0", "wifi diagnostics"]);
    let ip_addr = find_latest(latest, &["ip addr show wlan0", "wifi diagnostics"]);
    let ip_route = find_latest(latest, &["ip route", "wifi diagnostics"]);
    let conn_tech = find_latest(latest, &["connmanctl technologies", "wifi diagnostics"]);
    let conn_services = find_latest(latest, &["connmanctl services", "wifi diagnostics"]);
    let conn_state = find_latest(latest, &["connmanctl state", "wifi diagnostics"]);
    let ethtool_driver = find_latest(latest, &["ethtool -i wlan0", "wifi diagnostics"]);
    let proc_net = find_latest(latest, &["cat /proc/net/dev", "wifi diagnostics"]);

    let has_wifi_inputs = wifi_check.is_some()
        || wifi_signal.is_some()
        || iw_dev.is_some()
        || iw_info.is_some()
        || iw_link.is_some()
        || iw_station.is_some()
        || ip_link.is_some()
        || ip_addr.is_some()
        || ip_route.is_some()
        || conn_tech.is_some()
        || conn_services.is_some()
        || conn_state.is_some()
        || ethtool_driver.is_some()
        || proc_net.is_some();
    if !has_wifi_inputs {
        return None;
    }

    if let Some(text) = wifi_check {
        w.internet_reachable = capture_after(text, "Internet reachability state:")
            .map(|v| v.eq_ignore_ascii_case("online"))
            .unwrap_or(false);
        w.wifi_state = capture_after(text, "Wi-Fi state:").unwrap_or_else(|| "unknown".into());
        w.access_point = capture_after(text, "Wi-Fi access point:");
        let (score, label) = parse_strength_line(capture_line(text, "Wi-Fi strength:"));
        if score > 0 {
            w.strength_score = Some(score);
            w.strength_label = Some(label);
        }
        w.ipv4 = parse_yes_no(capture_after(text, "Wi-Fi supports IPv4?"));
        w.ipv6 = parse_yes_no(capture_after(text, "Wi-Fi supports IPv6?"));
        w.dns_servers = capture_after(text, "Wi-Fi name servers:").unwrap_or_else(|| "—".into());
        if let Some(done) = capture_after(text, "Done:") {
            if done.to_ascii_lowercase().starts_with("success") {
                w.check_result = "Success".into();
            } else if done.to_ascii_lowercase().starts_with("failure") {
                w.check_result = "Failure".into();
                w.check_error = Some(done.trim_start_matches("Failure:").trim().to_string());
            } else {
                w.check_result = done;
            }
        }
        w.check_avg_latency_ms = parse_avg_latency(text);
        w.check_packet_loss_pct = parse_packet_loss(text).unwrap_or(0);
    }

    if let Some(text) = wifi_signal {
        w.signal_dbm = parse_signal_dbm(text);
    }
    if let Some(text) = iw_dev {
        w.interface_exists = text.contains("Interface wlan0");
        w.interface_name = capture_after(text, "Interface");
        w.mac_address = capture_after(text, "addr");
        w.ssid = capture_after(text, "ssid");
        w.interface_type = capture_after(text, "type");
        w.tx_power_dbm = capture_after(text, "txpower").and_then(|v| {
            v.split_whitespace()
                .next()
                .and_then(|n| n.parse::<f64>().ok())
        });
    }
    if let Some(text) = iw_info {
        w.interface_exists = true;
        w.interface_name = w
            .interface_name
            .or_else(|| capture_after(text, "Interface"));
        w.interface_type = w.interface_type.or_else(|| capture_after(text, "type"));
        w.mac_address = w.mac_address.or_else(|| capture_after(text, "addr"));
        w.ssid = w.ssid.or_else(|| capture_after(text, "ssid"));
    }
    if let Some(text) = iw_link {
        if text.contains("Not connected") {
            w.connected = Some(false);
        } else {
            w.connected = Some(true);
            w.ap_bssid = extract_regex(text, r"Connected to ([0-9a-f:]{17})");
            w.ssid = w.ssid.or_else(|| capture_after(text, "SSID:"));
            w.frequency_mhz = extract_regex(text, r"freq:\s*([0-9.]+)")
                .and_then(|v| v.parse::<f64>().ok())
                .map(|f| f.round() as u32);
            w.link_rx_bytes =
                extract_regex(text, r"RX:\s*(\d+)\s+bytes").and_then(|v| v.parse::<u64>().ok());
            w.link_rx_packets = extract_regex(text, r"RX:\s*\d+\s+bytes\s+\((\d+)\s+packets\)")
                .and_then(|v| v.parse::<u64>().ok());
            w.link_tx_bytes =
                extract_regex(text, r"TX:\s*(\d+)\s+bytes").and_then(|v| v.parse::<u64>().ok());
            w.link_tx_packets = extract_regex(text, r"TX:\s*\d+\s+bytes\s+\((\d+)\s+packets\)")
                .and_then(|v| v.parse::<u64>().ok());
            if w.signal_dbm.is_none() {
                w.signal_dbm = extract_regex(text, r"signal:\s*(-?\d+)\s*dBm")
                    .and_then(|v| v.parse::<i32>().ok());
            }
            w.tx_bitrate_mbps = extract_regex(text, r"tx bitrate:\s*([0-9.]+)\s*MBit/s")
                .and_then(|v| v.parse::<f64>().ok());
        }
    }
    if let Some(text) = iw_station {
        w.station_signal_dbm =
            extract_regex(text, r"signal:\s*(-?\d+)\s*dBm").and_then(|v| v.parse::<i32>().ok());
        w.station_tx_retries =
            extract_regex(text, r"tx retries:\s*(\d+)").and_then(|v| v.parse::<u64>().ok());
        w.station_tx_failed =
            extract_regex(text, r"tx failed:\s*(\d+)").and_then(|v| v.parse::<u64>().ok());
        w.station_tx_bitrate_mbps = extract_regex(text, r"tx bitrate:\s*([0-9.]+)\s*MBit/s")
            .and_then(|v| v.parse::<f64>().ok());
    }
    if let Some(text) = ip_link {
        let line = text.lines().next().unwrap_or_default();
        w.lower_up_flag = Some(line.contains("LOWER_UP"));
        w.link_state = extract_regex(line, r"state\s+([A-Z]+)");
    }
    if let Some(text) = ip_addr {
        let re = Regex::new(r"inet\s+(\d+\.\d+\.\d+\.\d+)/(\d{1,2})").ok();
        if let Some(re) = re {
            if let Some(c) = re.captures(text) {
                w.ipv4_address = c.get(1).map(|m| m.as_str().to_string());
                w.ipv4_prefix = c.get(2).and_then(|m| m.as_str().parse::<u8>().ok());
            }
        }
    }
    if let Some(text) = ip_route {
        let mut default_gateway = None;
        let mut default_via_wlan0 = false;
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with("default via ") {
                if let Some(gw) = extract_regex(line, r"default via (\S+)") {
                    if line.contains(" dev wlan0") {
                        default_via_wlan0 = true;
                        default_gateway = Some(gw);
                        break;
                    } else if default_gateway.is_none() {
                        default_gateway = Some(gw);
                    }
                }
            }
        }
        w.default_via_wlan0 = Some(default_via_wlan0);
        w.default_gateway = default_gateway;
    }
    if let Some(text) = conn_tech {
        let wifi_block = extract_connman_tech(text, "wifi");
        w.connman_wifi_powered = wifi_block
            .as_deref()
            .and_then(|b| extract_regex(b, r"Powered = (True|False)"))
            .map(|v| v == "True");
        w.connman_wifi_connected = wifi_block
            .as_deref()
            .and_then(|b| extract_regex(b, r"Connected = (True|False)"))
            .map(|v| v == "True");
        let eth_block = extract_connman_tech(text, "ethernet");
        w.connman_eth_connected = eth_block
            .as_deref()
            .and_then(|b| extract_regex(b, r"Connected = (True|False)"))
            .map(|v| v == "True");
        let cell_block = extract_connman_tech(text, "cellular");
        w.connman_cell_connected = cell_block
            .as_deref()
            .and_then(|b| extract_regex(b, r"Connected = (True|False)"))
            .map(|v| v == "True");
    }
    if let Some(text) = conn_services {
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("*AO ") {
                let active = trimmed.trim_start_matches("*AO ").to_string();
                w.connman_active_service =
                    Some(active.split_whitespace().next().unwrap_or("").to_string());
                w.connman_wifi_active = Some(trimmed.contains("wifi_"));
                break;
            }
        }
        if w.connman_wifi_active.is_none() {
            w.connman_wifi_active = Some(false);
        }
    }
    if let Some(text) = conn_state {
        w.connman_state = extract_regex(text, r"State = (\w+)");
    }
    if let Some(text) = ethtool_driver {
        w.driver = capture_after(text, "driver:");
        w.driver_version = capture_after(text, "version:");
        w.bus_info = capture_after(text, "bus-info:");
    }
    if let Some(text) = proc_net {
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("wlan0:") {
                let rhs = trimmed.trim_start_matches("wlan0:").trim();
                let cols: Vec<&str> = rhs.split_whitespace().collect();
                if cols.len() >= 11 {
                    w.proc_rx_bytes = cols.first().and_then(|v| v.parse::<u64>().ok());
                    w.proc_rx_packets = cols.get(1).and_then(|v| v.parse::<u64>().ok());
                    w.proc_rx_errs = cols.get(2).and_then(|v| v.parse::<u64>().ok());
                    w.proc_rx_drop = cols.get(3).and_then(|v| v.parse::<u64>().ok());
                    w.proc_tx_bytes = cols.get(8).and_then(|v| v.parse::<u64>().ok());
                    w.proc_tx_packets = cols.get(9).and_then(|v| v.parse::<u64>().ok());
                    w.proc_tx_errs = cols.get(10).and_then(|v| v.parse::<u64>().ok());
                }
            }
        }
    }

    w.signal_dbm_trusted = w.connected == Some(true)
        || w.connman_wifi_connected == Some(true)
        || (w.check_result == "Success" && w.wifi_state == "online");

    determine_wifi_status(&mut w);
    Some(w)
}

fn parse_cellular_from_latest(latest: &HashMap<String, String>) -> Option<CellularDiagnostic> {
    let mut diag = default_cellular();
    let mut has_any = false;

    if let Some(block) = find_latest_body_contains(
        latest,
        &[
            "===== cellular connectivity test =====",
            "===== basic cell info =====",
            "===== modem / radio diagnostics =====",
        ],
    ) {
        parse_cellular_block(block, &mut diag);
        has_any = true;
    }

    if let Some(block) = find_latest(latest, &["run cellular diagnostics"]) {
        parse_cellular_block(block, &mut diag);
        has_any = true;
    }

    if let Some(text) = find_latest(latest, &["date"]) {
        diag.controller_date = parse_single_value(Some(text)).or(diag.controller_date);
        has_any = has_any || !text.trim().is_empty();
    }
    if let Some(text) = find_latest(latest, &["version"]) {
        diag.controller_version = parse_single_value(Some(text)).or(diag.controller_version);
        has_any = has_any || !text.trim().is_empty();
    }
    if let Some(text) = find_latest(latest, &["sid"]) {
        diag.controller_sid = parse_single_value(Some(text)).or(diag.controller_sid);
        has_any = has_any || !text.trim().is_empty();
    }
    if let Some(text) = find_latest(latest, &["cellular-check"]) {
        parse_cellular_check_text(text, &mut diag);
        has_any = true;
    }
    let basic_cmds = [
        "cell-imei",
        "cell-ccid",
        "cell-imsi",
        "cell-hni",
        "cell-provider",
        "cell-status",
        "cell-signal",
        "cell-apn",
    ];
    let mut basic_lines: Vec<String> = Vec::new();
    for cmd in basic_cmds {
        if let Some(text) = find_latest(latest, &[cmd]) {
            has_any = true;
            if let Some(v) = parse_single_value(Some(text)) {
                basic_lines.push(v);
            }
        }
    }
    if !basic_lines.is_empty() {
        parse_basic_cell_info(&basic_lines.join("\n"), &mut diag);
    }
    if let Some(text) = find_latest(latest, &["connmanctl technologies"]) {
        parse_connman_cellular(text, &mut diag);
        has_any = true;
    }
    if let Some(text) = find_latest(latest, &["connmanctl services"]) {
        parse_connman_cellular(text, &mut diag);
        has_any = true;
    }
    if let Some(text) = find_latest(latest, &["connmanctl state"]) {
        parse_connman_cellular(text, &mut diag);
        has_any = true;
    }
    if let Some(text) = find_latest(latest, &["ip link show wwan0"]) {
        parse_wwan_interface(text, &mut diag);
        has_any = true;
    }
    if let Some(text) = find_latest(latest, &["ip addr show wwan0"]) {
        parse_wwan_interface(text, &mut diag);
        has_any = true;
    }
    if let Some(text) = find_latest(latest, &["ip route"]) {
        parse_wwan_interface(text, &mut diag);
        has_any = true;
    }
    if let Some(text) = find_latest(latest, &["cat /proc/net/dev"]) {
        parse_proc_net_dev(text, &mut diag);
        has_any = true;
    }
    if let Some(text) = find_latest(latest, &["cell-support --no-ofono --at"]) {
        parse_cell_support_at(text, &mut diag);
        has_any = true;
    }

    if !has_any {
        return None;
    }
    determine_cellular_status(&mut diag);
    Some(diag)
}

pub fn parse_cellular(block: &str) -> CellularDiagnostic {
    let mut diag = default_cellular();
    parse_cellular_block(block, &mut diag);
    determine_cellular_status(&mut diag);
    diag
}

fn default_cellular() -> CellularDiagnostic {
    CellularDiagnostic {
        status: DiagStatus::Unknown,
        summary: "Incomplete data".into(),
        controller_sid: None,
        controller_version: None,
        controller_date: None,
        check_result: "Unknown".into(),
        check_error: None,
        internet_reachable: false,
        cell_state: "unknown".into(),
        provider_code: None,
        strength_score: None,
        strength_label: None,
        ipv4: false,
        ipv6: false,
        dns_servers: "—".into(),
        check_avg_latency_ms: None,
        check_packet_loss_pct: 0,
        imei: None,
        iccid: None,
        imsi: None,
        hni: None,
        basic_provider: None,
        basic_status: None,
        basic_signal: None,
        basic_apn: None,
        connman_cell_powered: None,
        connman_cell_connected: None,
        connman_wifi_connected: None,
        connman_eth_connected: None,
        connman_active_service: None,
        connman_cell_active: None,
        connman_cell_ready: None,
        connman_state: None,
        wwan_exists: false,
        wwan_link_state: None,
        wwan_lower_up: None,
        wwan_ipv4_address: None,
        wwan_ipv4_prefix: None,
        default_via_wwan0: None,
        default_gateway: None,
        role: None,
        proc_rx_bytes: None,
        proc_rx_packets: None,
        proc_rx_errs: None,
        proc_rx_drop: None,
        proc_tx_bytes: None,
        proc_tx_packets: None,
        proc_tx_errs: None,
        modem_present: None,
        modem_model: None,
        modem_revision: None,
        sim_ready: None,
        sim_inserted: None,
        cfun: None,
        registered: None,
        attached: None,
        operator_name: None,
        qcsq: None,
        rssi_dbm: None,
        rat: None,
        mccmnc: None,
        band: None,
        channel: None,
        pdp_active: None,
        pdp_ip: None,
        at_apn: None,
        recommended_action: None,
        other_actions: vec![],
    }
}

fn parse_satellite(
    setup_block: Option<&String>,
    test_block: Option<&String>,
) -> Option<SatelliteDiagnostic> {
    if setup_block.is_none() && test_block.is_none() {
        return None;
    }

    let enabled = setup_block
        .and_then(|b| {
            capture_line(b, "Enable Satellite networking")
                .or_else(|| capture_line(b, "Enable satellite networking"))
        })
        .map(|line| line.contains("? Y") || line.ends_with('Y'))
        .unwrap_or(false);

    let loopback_passed = test_block.map(|b| {
        let lower = b.to_ascii_lowercase();
        if lower.contains("successfully completed satellite loopback") || lower.contains("success")
        {
            true
        } else if lower.contains("failed") || lower.contains("failure") {
            false
        } else {
            false
        }
    });

    let loopback_time_secs = test_block.and_then(|b| parse_satellite_time(b));

    let status = match loopback_passed {
        Some(true) => DiagStatus::Green,
        Some(false) => DiagStatus::Red,
        None if enabled => DiagStatus::Orange,
        _ => DiagStatus::Unknown,
    };

    let summary = match loopback_passed {
        Some(true) => match loopback_time_secs {
            Some(v) => format!("Loopback passed · {:.1}s", v),
            None => "Loopback passed".into(),
        },
        Some(false) => "Loopback failed".into(),
        None if enabled => "Enabled · not tested".into(),
        _ => "Offline".into(),
    };

    Some(SatelliteDiagnostic {
        status,
        summary,
        enabled,
        loopback_passed,
        loopback_time_secs,
        imei: None,
    })
}

fn parse_ethernet(
    ethernet_check: Option<&String>,
    ethtool: Option<&String>,
    interface_info: Option<&String>,
    proc_net_dev: Option<&String>,
    operstate: Option<&String>,
) -> Option<EthernetDiagnostic> {
    if ethernet_check.is_none()
        && ethtool.is_none()
        && interface_info.is_none()
        && proc_net_dev.is_none()
        && operstate.is_none()
    {
        return None;
    }

    let internet_reachable = ethernet_check
        .and_then(|b| capture_after(b, "Internet reachability state:"))
        .map(|s| s.eq_ignore_ascii_case("online"))
        .unwrap_or(false);
    let eth_state = ethernet_check
        .and_then(|b| capture_after(b, "Ethernet state:"))
        .or_else(|| operstate.and_then(|b| parse_single_value(Some(b))))
        .unwrap_or_else(|| "unknown".into());
    let ipv4 = ethernet_check
        .and_then(|b| capture_after(b, "Ethernet supports IPv4?"))
        .map(|v| parse_yes_no(Some(v)))
        .unwrap_or(false);
    let ipv6 = ethernet_check
        .and_then(|b| capture_after(b, "Ethernet supports IPv6?"))
        .map(|v| parse_yes_no(Some(v)))
        .unwrap_or(false);
    let dns_servers = ethernet_check
        .and_then(|b| capture_after(b, "Ethernet name servers:"))
        .unwrap_or_else(|| "—".into());
    let check_result = ethernet_check
        .and_then(|b| capture_after(b, "Done:"))
        .unwrap_or_else(|| "Unknown".into());

    let speed = ethtool.and_then(|b| capture_after(b, "Speed:"));
    let duplex = ethtool.and_then(|b| capture_after(b, "Duplex:"));
    let link_detected = ethtool
        .and_then(|b| capture_after(b, "Link detected:"))
        .map(|s| s.eq_ignore_ascii_case("yes"));

    let ip_address = interface_info.and_then(parse_interface_ip);
    let netmask = interface_info.and_then(parse_interface_netmask);
    let rx_errors = proc_net_dev
        .and_then(parse_proc_net_dev_stats)
        .map(|(rx_err, _, _)| rx_err)
        .unwrap_or(0);
    let tx_errors = proc_net_dev
        .and_then(parse_proc_net_dev_stats)
        .map(|(_, tx_err, _)| tx_err)
        .unwrap_or(0);
    let rx_dropped = proc_net_dev
        .and_then(parse_proc_net_dev_stats)
        .map(|(_, _, rx_drop)| rx_drop)
        .unwrap_or(0);

    let check_failed = check_result.to_ascii_lowercase().starts_with("failure");
    let status = if check_failed || (!internet_reachable && check_result != "Unknown") {
        DiagStatus::Red
    } else if check_result.eq_ignore_ascii_case("success") {
        DiagStatus::Green
    } else {
        DiagStatus::Unknown
    };

    let summary = match status {
        DiagStatus::Green => "Ethernet passing".to_string(),
        DiagStatus::Grey => "Ethernet inactive".to_string(),
        DiagStatus::Red => "Ethernet needs attention".to_string(),
        DiagStatus::Orange => "Ethernet warning".to_string(),
        DiagStatus::Unknown => "No data yet".to_string(),
    };

    Some(EthernetDiagnostic {
        status,
        summary,
        internet_reachable,
        eth_state,
        ipv4,
        ipv6,
        dns_servers,
        ip_address,
        netmask,
        speed,
        duplex,
        link_detected,
        rx_errors,
        tx_errors,
        rx_dropped,
        check_result,
        flap_count: 0,
    })
}

fn parse_system(
    sid_block: Option<&String>,
    version_block: Option<&String>,
    release_block: Option<&String>,
) -> SystemDiagnostic {
    let sid = parse_single_value(sid_block);
    let version = parse_single_value(version_block);
    let release_date = release_block.and_then(|b| capture_after(b, "Date:"));

    SystemDiagnostic {
        sid,
        version,
        release_date,
    }
}

fn parse_strength_line(line: Option<String>) -> (u8, String) {
    let Some(line) = line else {
        return (0, "unknown".into());
    };
    let re = Regex::new(r#"(\d{1,3})/100\s*\("?([a-zA-Z]+)"?\)"#).ok();
    if let Some(re) = re {
        if let Some(cap) = re.captures(&line) {
            let strength = cap
                .get(1)
                .and_then(|m| m.as_str().parse::<u8>().ok())
                .unwrap_or(0);
            let label = cap
                .get(2)
                .map(|m| m.as_str().to_lowercase())
                .unwrap_or_else(|| "unknown".into());
            return (strength, label);
        }
    }
    (0, "unknown".into())
}

fn parse_yes_no(value: Option<String>) -> bool {
    value
        .map(|v| v.trim().eq_ignore_ascii_case("yes"))
        .unwrap_or(false)
}

fn parse_avg_latency(text: &str) -> Option<f64> {
    let re = Regex::new(r"Round trip times:.*?=\s*([0-9.]+)/([0-9.]+)/([0-9.]+)/").ok()?;
    re.captures(text)
        .and_then(|c| c.get(2))
        .and_then(|m| m.as_str().parse::<f64>().ok())
}

fn parse_avg_latency_multi(text: &str) -> Option<f64> {
    let re = Regex::new(r"Round trip times:.*?=\s*([0-9.]+)/([0-9.]+)/([0-9.]+)/").ok()?;
    let mut vals: Vec<f64> = Vec::new();
    for cap in re.captures_iter(text) {
        if let Some(v) = cap.get(2).and_then(|m| m.as_str().parse::<f64>().ok()) {
            vals.push(v);
        }
    }
    if vals.is_empty() {
        None
    } else {
        Some(vals.iter().sum::<f64>() / vals.len() as f64)
    }
}

fn parse_packet_loss(text: &str) -> Option<u8> {
    let re = Regex::new(r"(\d+)%\s+packet loss").ok()?;
    re.captures(text)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<u8>().ok())
}

fn parse_packet_loss_worst(text: &str) -> Option<u8> {
    let re = Regex::new(r"(\d+)%\s+packet loss").ok()?;
    let mut worst: Option<u8> = None;
    for cap in re.captures_iter(text) {
        if let Some(v) = cap.get(1).and_then(|m| m.as_str().parse::<u8>().ok()) {
            worst = Some(worst.map_or(v, |w| w.max(v)));
        }
    }
    worst
}

fn parse_signal_dbm(text: &str) -> Option<i32> {
    extract_regex(text, r"signal strength:\s*(-?\d+)\s*dBm").and_then(|v| v.parse::<i32>().ok())
}

fn extract_regex(text: &str, pattern: &str) -> Option<String> {
    let re = Regex::new(pattern).ok()?;
    re.captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

fn extract_connman_tech(text: &str, tech: &str) -> Option<String> {
    let marker = format!("/net/connman/technology/{tech}");
    let mut out = String::new();
    let mut active = false;
    for line in text.lines() {
        if line.starts_with("/net/connman/technology/") {
            if active {
                break;
            }
            active = line.trim() == marker;
            if active {
                out.push_str(line);
                out.push('\n');
            }
            continue;
        }
        if active {
            out.push_str(line);
            out.push('\n');
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn determine_wifi_status(diag: &mut WifiDiagnostic) {
    if diag.check_result == "Unknown" && diag.check_error.is_none() {
        diag.status = DiagStatus::Unknown;
        diag.summary = "Partial data".into();
        return;
    }

    if diag
        .check_error
        .as_deref()
        .map(|e| e.contains("-65553"))
        .unwrap_or(false)
        || diag.connman_wifi_powered == Some(false)
    {
        diag.status = DiagStatus::Red;
        diag.summary = "Disabled — Wi-Fi technology not enabled".into();
        return;
    }

    if diag
        .check_error
        .as_deref()
        .map(|e| e.contains("-65554"))
        .unwrap_or(false)
        || diag.connected == Some(false)
        || (diag.connman_wifi_connected == Some(false) && diag.connman_wifi_powered == Some(true))
    {
        diag.status = DiagStatus::Red;
        diag.summary = "Not connected — Wi-Fi offline or association failed".into();
        return;
    }

    if diag.link_state.as_deref() == Some("DOWN") {
        diag.status = DiagStatus::Red;
        diag.summary = "Interface down — wlan0 not ready".into();
        return;
    }

    if diag.connected == Some(true) && diag.ipv4_address.is_none() {
        diag.status = DiagStatus::Orange;
        diag.summary = "Connected — no IP assigned (DHCP failure?)".into();
        return;
    }

    if let Some(dbm) = diag.signal_dbm {
        if diag.signal_dbm_trusted && dbm <= -75 {
            let ssid = diag
                .ssid
                .clone()
                .or(diag.access_point.clone())
                .unwrap_or_else(|| "Wi-Fi".into());
            diag.status = DiagStatus::Orange;
            diag.summary = format!("{ssid} · weak signal ({dbm} dBm)");
            return;
        }
    }

    if diag.check_packet_loss_pct >= 20 || diag.station_tx_failed.unwrap_or(0) > 0 {
        let ssid = diag
            .ssid
            .clone()
            .or(diag.access_point.clone())
            .unwrap_or_else(|| "Wi-Fi".into());
        diag.status = DiagStatus::Orange;
        diag.summary = format!("{ssid} · unstable link");
        return;
    }

    if diag.check_result == "Success" && diag.internet_reachable {
        let ssid = diag
            .ssid
            .clone()
            .or(diag.access_point.clone())
            .unwrap_or_else(|| "Wi-Fi".into());
        let signal = if diag.signal_dbm_trusted {
            diag.signal_dbm
                .map(|v| format!("{v} dBm"))
                .unwrap_or_else(|| "unknown signal".into())
        } else {
            "unknown signal".into()
        };
        let bitrate = diag
            .tx_bitrate_mbps
            .or(diag.station_tx_bitrate_mbps)
            .map(|v| format!("{v:.1} Mbps"))
            .unwrap_or_else(|| "unknown rate".into());
        let preferred = if diag.connman_wifi_active == Some(true) {
            " · preferred"
        } else {
            ""
        };
        diag.status = DiagStatus::Green;
        diag.summary = format!("{ssid} · {signal} · {bitrate}{preferred}");
        return;
    }

    diag.status = DiagStatus::Unknown;
    diag.summary = "Incomplete data".into();
}

fn parse_single_value(block: Option<&String>) -> Option<String> {
    let text = block?;
    text.lines().rev().find_map(|l| {
        let v = l.trim();
        if v.is_empty() {
            None
        } else {
            Some(v.to_string())
        }
    })
}

fn capture_after(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix(key) {
            Some(rest.trim().to_string())
        } else {
            None
        }
    })
}

fn capture_line(text: &str, contains: &str) -> Option<String> {
    text.lines()
        .find(|l| l.contains(contains))
        .map(|l| l.trim().to_string())
}

fn parse_satellite_time(text: &str) -> Option<f64> {
    let re = Regex::new(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)").ok()?;
    let cap = re.captures(text)?;
    let h = cap.get(1)?.as_str().parse::<f64>().ok()?;
    let m = cap.get(2)?.as_str().parse::<f64>().ok()?;
    let s = cap.get(3)?.as_str().parse::<f64>().ok()?;
    Some((h * 3600.0) + (m * 60.0) + s)
}

fn parse_interface_ip(text: &String) -> Option<String> {
    let re = Regex::new(r"inet\s+(\d+\.\d+\.\d+\.\d+)").ok()?;
    re.captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

fn parse_interface_netmask(text: &String) -> Option<String> {
    let hex_re = Regex::new(r"netmask\s+([0-9a-fx]+)").ok()?;
    if let Some(v) = hex_re
        .captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
    {
        return Some(v);
    }
    let cidr_re = Regex::new(r"inet\s+\d+\.\d+\.\d+\.\d+/(\d{1,2})").ok()?;
    cidr_re
        .captures(text)
        .and_then(|c| c.get(1))
        .map(|m| format!("/{}", m.as_str()))
}

fn parse_proc_net_dev_stats(text: &String) -> Option<(u64, u64, u64)> {
    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("eth0:") {
            continue;
        }
        let rhs = trimmed.trim_start_matches("eth0:").trim();
        let cols: Vec<&str> = rhs.split_whitespace().collect();
        if cols.len() < 12 {
            continue;
        }
        // /proc/net/dev: receive bytes, packets, errs, drop ... transmit bytes, packets, errs, drop ...
        let rx_err = cols.get(2).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
        let rx_drop = cols.get(3).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
        let tx_err = cols
            .get(10)
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        return Some((rx_err, tx_err, rx_drop));
    }
    None
}

fn parse_cellular_block(block: &str, diag: &mut CellularDiagnostic) {
    let sections = [
        (
            "===== CONTROLLER INFO =====",
            "===== CELLULAR CONNECTIVITY TEST =====",
        ),
        (
            "===== CELLULAR CONNECTIVITY TEST =====",
            "===== BASIC CELL INFO =====",
        ),
        (
            "===== BASIC CELL INFO =====",
            "===== NETWORK TECHNOLOGY =====",
        ),
        (
            "===== NETWORK TECHNOLOGY =====",
            "===== INTERFACE / ROUTING =====",
        ),
        (
            "===== INTERFACE / ROUTING =====",
            "===== MODEM / RADIO DIAGNOSTICS =====",
        ),
        ("===== MODEM / RADIO DIAGNOSTICS =====", ""),
    ];

    for (start, end) in sections {
        if let Some(section) = extract_between(block, start, end) {
            if start.contains("CONTROLLER INFO") {
                parse_controller_info(&section, diag);
            } else if start.contains("CONNECTIVITY TEST") {
                parse_cellular_check_text(&section, diag);
            } else if start.contains("BASIC CELL INFO") {
                parse_basic_cell_info(&section, diag);
            } else if start.contains("NETWORK TECHNOLOGY") {
                parse_connman_cellular(&section, diag);
            } else if start.contains("INTERFACE / ROUTING") {
                parse_wwan_interface(&section, diag);
                parse_proc_net_dev(&section, diag);
            } else if start.contains("MODEM / RADIO") {
                parse_cell_support_at(&section, diag);
            }
        }
    }
}

fn extract_between(text: &str, start: &str, end: &str) -> Option<String> {
    let start_idx = text.find(start)?;
    let rest = &text[start_idx + start.len()..];
    let end_idx = if end.is_empty() {
        rest.len()
    } else {
        rest.find(end).unwrap_or(rest.len())
    };
    Some(rest[..end_idx].trim().to_string())
}

fn parse_controller_info(text: &str, diag: &mut CellularDiagnostic) {
    for line in text.lines() {
        let v = line.trim();
        if v.is_empty() {
            continue;
        }
        if diag.controller_date.is_none()
            && (v.contains(':') && (v.contains("UTC") || v.contains("20")))
        {
            diag.controller_date = Some(v.to_string());
            continue;
        }
        if diag.controller_version.is_none() && (v.starts_with('r') || v.contains('.')) {
            diag.controller_version = Some(v.to_string());
            continue;
        }
        if diag.controller_sid.is_none() && v.chars().all(|c| c.is_ascii_digit()) {
            diag.controller_sid = Some(v.to_string());
        }
    }
}

fn parse_cellular_check_text(text: &str, diag: &mut CellularDiagnostic) {
    diag.internet_reachable = capture_after(text, "Internet reachability state:")
        .map(|s| s.eq_ignore_ascii_case("online"))
        .unwrap_or(diag.internet_reachable);
    if let Some(v) = capture_after(text, "Cellular state:") {
        diag.cell_state = v;
    }
    diag.provider_code = diag
        .provider_code
        .clone()
        .or_else(|| capture_after(text, "Cellular provider:"));
    let (score, label) = parse_strength_line(capture_line(text, "Cellular strength:"));
    if score > 0 {
        diag.strength_score = Some(score);
        if !label.is_empty() && label != "unknown" {
            diag.strength_label = Some(label);
        }
    }
    diag.ipv4 = parse_yes_no(capture_after(text, "Cellular supports IPv4?")) || diag.ipv4;
    diag.ipv6 = parse_yes_no(capture_after(text, "Cellular supports IPv6?")) || diag.ipv6;
    if let Some(v) = capture_after(text, "Cellular name servers:") {
        diag.dns_servers = v;
    }
    if let Some(done) = capture_after(text, "Done:") {
        let low = done.to_ascii_lowercase();
        if low.starts_with("success") {
            diag.check_result = "Success".into();
            diag.check_error = None;
        } else if low.starts_with("failure") {
            diag.check_result = "Failure".into();
            diag.check_error = Some(done.trim_start_matches("Failure:").trim().to_string());
        }
    }
    diag.check_avg_latency_ms = parse_avg_latency_multi(text).or(diag.check_avg_latency_ms);
    diag.check_packet_loss_pct =
        parse_packet_loss_worst(text).unwrap_or(diag.check_packet_loss_pct);
}

fn parse_basic_cell_info(text: &str, diag: &mut CellularDiagnostic) {
    let lines: Vec<String> = text
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    if lines.is_empty() {
        return;
    }
    let mut vals: Vec<Option<String>> = vec![None; 8];
    for (i, line) in lines.iter().take(8).enumerate() {
        if !line.to_ascii_lowercase().starts_with("error:") {
            vals[i] = Some(line.clone());
        }
    }
    diag.imei = diag.imei.clone().or(vals[0].clone());
    diag.iccid = diag.iccid.clone().or(vals[1].clone());
    diag.imsi = diag.imsi.clone().or(vals[2].clone());
    diag.hni = diag.hni.clone().or(vals[3].clone());
    diag.basic_provider = diag.basic_provider.clone().or(vals[4].clone());
    diag.basic_status = diag.basic_status.clone().or(vals[5].clone());
    diag.basic_signal = diag.basic_signal.clone().or(vals[6].clone());
    diag.basic_apn = diag.basic_apn.clone().or(vals[7].clone());
}

fn parse_connman_cellular(text: &str, diag: &mut CellularDiagnostic) {
    if let Some(block) = extract_connman_tech(text, "cellular") {
        diag.connman_cell_powered =
            extract_regex(&block, r"Powered = (True|False)").map(|v| v == "True");
        diag.connman_cell_connected =
            extract_regex(&block, r"Connected = (True|False)").map(|v| v == "True");
    }
    if let Some(block) = extract_connman_tech(text, "wifi") {
        diag.connman_wifi_connected =
            extract_regex(&block, r"Connected = (True|False)").map(|v| v == "True");
    }
    if let Some(block) = extract_connman_tech(text, "ethernet") {
        diag.connman_eth_connected =
            extract_regex(&block, r"Connected = (True|False)").map(|v| v == "True");
    }
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("*AO ") {
            let svc = trimmed
                .trim_start_matches("*AO ")
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_string();
            if !svc.is_empty() {
                diag.connman_active_service = Some(svc.clone());
                diag.connman_cell_active = Some(svc.contains("cellular_"));
            }
        }
        if trimmed.starts_with("*AR ") {
            let svc = trimmed
                .trim_start_matches("*AR ")
                .split_whitespace()
                .next()
                .unwrap_or("");
            diag.connman_cell_ready = Some(svc.contains("cellular_"));
        }
        if let Some(state) = trimmed.strip_prefix("State =") {
            diag.connman_state = Some(state.trim().to_string());
        }
    }
    if diag.connman_cell_active.is_none() {
        diag.connman_cell_active = Some(false);
    }
    if diag.connman_cell_ready.is_none() && text.contains("cellular_") {
        diag.connman_cell_ready = Some(false);
    }
    diag.role = Some(if diag.connman_cell_active == Some(true) {
        "active".into()
    } else if diag.connman_cell_ready == Some(true) {
        "backup".into()
    } else {
        "inactive".into()
    });
}

fn parse_wwan_interface(text: &str, diag: &mut CellularDiagnostic) {
    if text.contains("Device \"wwan0\" does not exist") {
        diag.wwan_exists = false;
        return;
    }
    if text.contains("wwan0") {
        diag.wwan_exists = true;
    }
    if let Some(first) = text.lines().find(|l| l.contains("wwan0")) {
        diag.wwan_lower_up = Some(first.contains("LOWER_UP"));
        diag.wwan_link_state =
            extract_regex(first, r"state\s+([A-Z]+)").or(diag.wwan_link_state.clone());
    }
    let re = Regex::new(r"inet\s+(\d+\.\d+\.\d+\.\d+)/(\d{1,2})").ok();
    if let Some(re) = re {
        if let Some(c) = re.captures(text) {
            diag.wwan_ipv4_address = c.get(1).map(|m| m.as_str().to_string());
            diag.wwan_ipv4_prefix = c.get(2).and_then(|m| m.as_str().parse::<u8>().ok());
        }
    }
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("default via ") {
            if let Some(gw) = extract_regex(line, r"default via (\S+)") {
                if line.contains(" dev wwan0") {
                    diag.default_via_wwan0 = Some(true);
                    diag.default_gateway = Some(gw);
                } else if diag.default_gateway.is_none() {
                    diag.default_gateway = Some(gw);
                    diag.default_via_wwan0.get_or_insert(false);
                }
            }
        }
    }
}

fn parse_proc_net_dev(text: &str, diag: &mut CellularDiagnostic) {
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("wwan0:") {
            let rhs = trimmed.trim_start_matches("wwan0:").trim();
            let cols: Vec<&str> = rhs.split_whitespace().collect();
            if cols.len() >= 11 {
                diag.proc_rx_bytes = cols.first().and_then(|v| v.parse::<u64>().ok());
                diag.proc_rx_packets = cols.get(1).and_then(|v| v.parse::<u64>().ok());
                diag.proc_rx_errs = cols.get(2).and_then(|v| v.parse::<u64>().ok());
                diag.proc_rx_drop = cols.get(3).and_then(|v| v.parse::<u64>().ok());
                diag.proc_tx_bytes = cols.get(8).and_then(|v| v.parse::<u64>().ok());
                diag.proc_tx_packets = cols.get(9).and_then(|v| v.parse::<u64>().ok());
                diag.proc_tx_errs = cols.get(10).and_then(|v| v.parse::<u64>().ok());
            }
        }
    }
}

fn parse_cell_support_at(text: &str, diag: &mut CellularDiagnostic) {
    if text.contains("/dev/ttyUSB2 does not exist") {
        diag.modem_present = Some(false);
    }
    if text.contains("Quectel") || text.contains("BG96") {
        diag.modem_present = Some(true);
        diag.modem_model = extract_regex(text, r"(BG96)");
    }
    diag.modem_revision = capture_after(text, "Revision:");
    if text.contains("+CPIN: READY") {
        diag.sim_ready = Some(true);
        diag.sim_inserted = Some(true);
    }
    if text.contains("+CPIN: NOT INSERTED")
        || text.to_ascii_lowercase().contains("sim not inserted")
    {
        diag.sim_ready = Some(false);
        diag.sim_inserted = Some(false);
    }
    diag.cfun = extract_regex(text, r"\+CFUN:\s*(\d+)").and_then(|v| v.parse::<u8>().ok());
    let reg = extract_regex(text, r"\+CREG:\s*\d,(\d)")
        .or_else(|| extract_regex(text, r"\+CEREG:\s*\d,(\d)"));
    if let Some(v) = reg {
        diag.registered = Some(v == "1" || v == "5");
    }
    diag.attached = extract_regex(text, r"\+CGATT:\s*(\d)").map(|v| v == "1");
    diag.operator_name =
        extract_regex(text, r#"\+COPS:.*?"([^"]+)""#).map(|v| v.trim().to_string());
    if let Some(mode) = extract_regex(text, r#"\+QCSQ:\s*"([^"]+)""#) {
        diag.qcsq = Some(mode.clone());
        if mode != "NOSERVICE" {
            diag.rat = Some(mode);
        }
    }
    diag.rssi_dbm =
        extract_regex(text, r#"\+QCSQ:\s*"[^"]+",\s*(-?\d+)"#).and_then(|v| v.parse::<i32>().ok());
    if let Some(cap) = Regex::new(r#"\+QNWINFO:\s*"([^"]+)","([^"]+)","([^"]+)",(\d+)"#)
        .ok()
        .and_then(|re| re.captures(text))
    {
        diag.rat = cap
            .get(1)
            .map(|m| m.as_str().to_string())
            .or(diag.rat.clone());
        diag.mccmnc = cap.get(2).map(|m| m.as_str().to_string());
        diag.band = cap.get(3).map(|m| m.as_str().to_string());
        diag.channel = cap.get(4).map(|m| m.as_str().to_string());
    }
    diag.pdp_active = extract_regex(text, r"\+CGACT:\s*1,(\d)").map(|v| v == "1");
    diag.pdp_ip =
        extract_regex(text, r"\+CGPADDR:\s*1,(\d+\.\d+\.\d+\.\d+)").filter(|ip| ip != "0.0.0.0");
    diag.at_apn = extract_regex(text, r"\+CGCONTRDP:.*?,[^,]*,[^,]*,[^,]*,[^,]*,([^,\s]+)")
        .or_else(|| extract_regex(text, r#"\+CGCONTRDP:.*?(vzwinternet|super)"#));
}

fn determine_cellular_status(diag: &mut CellularDiagnostic) {
    let has_authoritative_check = diag.check_result != "Unknown" || diag.check_error.is_some();
    if !has_authoritative_check {
        diag.status = DiagStatus::Unknown;
        diag.summary = "Partial data".into();
        return;
    }

    if diag
        .check_error
        .as_deref()
        .map(|e| e.contains("-65553"))
        .unwrap_or(false)
        || diag.connman_cell_powered == Some(false)
        || (diag.cfun == Some(0)
            && diag.sim_inserted == Some(true)
            && diag.modem_present == Some(true)
            && diag.check_error.is_some())
    {
        diag.status = DiagStatus::Grey;
        diag.summary = "Cellular disabled".into();
        diag.recommended_action = Some("Enable via setup-cellular".into());
        diag.other_actions = vec![];
        return;
    }
    if diag
        .check_error
        .as_deref()
        .map(|e| e.contains("-65552"))
        .unwrap_or(false)
        && diag.modem_present == Some(false)
    {
        diag.status = DiagStatus::Red;
        diag.summary = "No modem detected".into();
        diag.recommended_action = Some("Check modem connection / seating".into());
        diag.other_actions = vec!["Reboot controller".into()];
        return;
    }
    if diag.sim_inserted == Some(false)
        || (diag.sim_ready == Some(false)
            && diag.modem_present == Some(true)
            && diag.iccid.is_none())
    {
        diag.status = DiagStatus::Red;
        diag.summary = "No SIM detected".into();
        diag.recommended_action = Some("Insert SIM card".into());
        diag.other_actions = vec![];
        return;
    }
    if diag.modem_present == Some(true)
        && diag.sim_inserted == Some(true)
        && diag.registered == Some(false)
        && diag.qcsq.as_deref() == Some("NOSERVICE")
    {
        diag.status = DiagStatus::Red;
        diag.summary = "No signal — not registered".into();
        diag.recommended_action = Some("Check coverage or antenna".into());
        diag.other_actions = vec![
            "Move to known good coverage area".into(),
            "Reboot controller".into(),
            "Try alternate SIM".into(),
        ];
        return;
    }
    if diag.modem_present == Some(true)
        && diag.sim_inserted == Some(true)
        && diag.registered == Some(true)
        && diag.attached == Some(true)
        && diag.connman_cell_connected == Some(false)
    {
        diag.status = DiagStatus::Orange;
        diag.summary = "Registered · APN/profile mismatch".into();
        diag.recommended_action = Some("Check APN / firmware cellular profile".into());
        diag.other_actions = vec![
            "Try supported SIM".into(),
            "Verify APN database entry".into(),
        ];
        return;
    }
    if diag.connman_cell_connected == Some(true)
        && diag.wwan_ipv4_address.is_some()
        && diag.check_result == "Failure"
    {
        diag.status = DiagStatus::Orange;
        diag.summary = "Connected · no internet".into();
        diag.recommended_action = Some("Check carrier data service / DNS".into());
        diag.other_actions = vec![];
        return;
    }
    if diag.check_result == "Success"
        && diag.internet_reachable
        && diag.connman_cell_connected == Some(true)
        && diag.wwan_ipv4_address.is_some()
    {
        let provider = diag
            .operator_name
            .clone()
            .or(diag.basic_provider.clone())
            .or(diag.provider_code.clone())
            .unwrap_or_else(|| "Cellular".into());
        let signal = diag
            .strength_label
            .clone()
            .or(diag.strength_score.map(|v| format!("{}/100", v)))
            .unwrap_or_else(|| "connected".into());
        let role = match diag.role.as_deref() {
            Some("active") => "active",
            Some("backup") => "backup",
            _ => "connected",
        };
        diag.status = DiagStatus::Green;
        diag.summary = format!("{} · {} · {}", provider.trim(), signal, role);
        diag.recommended_action = None;
        diag.other_actions = vec![];
        return;
    }
    diag.status = DiagStatus::Unknown;
    diag.summary = "Incomplete data".into();
}
