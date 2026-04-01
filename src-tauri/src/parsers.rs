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

    let mut cellular = parse_cellular_check(find_latest(
        &latest,
        &["cellular-check", "run cellular diagnostics"],
    ));
    if let Some(code) = parse_single_value(find_latest(
        &latest,
        &["cell-provider", "run cellular diagnostics"],
    )) {
        let provider = resolve_provider(&code);
        merge_cellular(&mut cellular, |c| {
            c.provider_code = code.clone();
            c.provider = provider.clone();
            c.summary = format!("{} · {}/100 · {}", c.provider, c.strength, c.strength_label);
        });
    }
    if let Some(strength) = parse_single_value(find_latest(
        &latest,
        &["cell-signal", "run cellular diagnostics"],
    ))
    .and_then(|v| v.parse::<u8>().ok())
    {
        merge_cellular(&mut cellular, |c| {
            c.strength = strength;
            c.summary = format!("{} · {}/100 · {}", c.provider, c.strength, c.strength_label);
        });
    }
    if let Some(iccid) = parse_single_value(find_latest(
        &latest,
        &["cell-ccid", "run cellular diagnostics"],
    )) {
        merge_cellular(&mut cellular, |c| c.iccid = Some(iccid.clone()));
    }
    if let Some(imei) = parse_single_value(find_latest(
        &latest,
        &["cell-imei", "run cellular diagnostics"],
    )) {
        merge_cellular(&mut cellular, |c| c.imei = Some(imei.clone()));
    }
    if let Some(apn) = parse_single_value(find_latest(
        &latest,
        &["cell-apn", "run cellular diagnostics"],
    )) {
        merge_cellular(&mut cellular, |c| c.apn = Some(apn.clone()));
    }
    if let Some(cell_status) = parse_single_value(find_latest(
        &latest,
        &["cell-status", "run cellular diagnostics"],
    )) {
        merge_cellular(&mut cellular, |c| c.cell_status = Some(cell_status.clone()));
    }

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
        find_latest(&latest, &["sid", "run system diagnostics"]),
        find_latest(&latest, &["version", "run system diagnostics"]),
        find_latest(&latest, &["release", "run system diagnostics"]),
    );

    state.wifi = wifi;
    state.cellular = cellular;
    state.satellite = satellite;
    state.ethernet = ethernet;
    if system.sid.is_some() || system.version.is_some() || system.release_date.is_some() {
        state.system = Some(system);
    }
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

fn split_blocks(log: &str) -> Vec<CommandBlock> {
    let prompt_re = Regex::new(
        r"^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{4}\s+)?(?:\[\d+\])?#\s*(.+)$",
    )
    .expect("prompt regex");
    let continuation_re = Regex::new(r"^>\s*(.+)$").expect("continuation regex");
    let ansi_re = Regex::new(r"\x1B\[[0-?]*[ -/]*[@-~]").expect("ansi regex");

    let mut blocks = Vec::new();
    let mut current_cmd: Option<String> = None;
    let mut current_body = String::new();

    for line in log.lines() {
        let cleaned = ansi_re.replace_all(line, "");
        let cleaned = cleaned.trim_end_matches('\r');

        if let Some(cap) = prompt_re.captures(cleaned) {
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
    use super::split_blocks;

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

fn parse_cellular_check(block: Option<&String>) -> Option<CellularDiagnostic> {
    let text = block?;
    let provider_code = capture_after(text, "Cellular provider:").unwrap_or_else(|| "—".into());
    let provider = resolve_provider(&provider_code);
    let (strength, strength_label) = parse_strength_line(capture_line(text, "Cellular strength:"));
    let ipv4 = parse_yes_no(capture_after(text, "Cellular supports IPv4?"));
    let ipv6 = parse_yes_no(capture_after(text, "Cellular supports IPv6?"));
    let dns_servers = capture_after(text, "Cellular name servers:").unwrap_or_else(|| "—".into());
    let internet_reachable = capture_after(text, "Internet reachability state:")
        .map(|s| s.eq_ignore_ascii_case("online"))
        .unwrap_or(false);
    let check_result = capture_after(text, "Done:").unwrap_or_else(|| "Unknown".into());
    let avg_latency_ms = parse_avg_latency(text);
    let packet_loss_pct = parse_packet_loss(text).unwrap_or(0);

    let status = if check_result.eq_ignore_ascii_case("failure") || !internet_reachable {
        DiagStatus::Red
    } else if check_result.eq_ignore_ascii_case("success") && internet_reachable {
        if strength >= 50 {
            DiagStatus::Green
        } else {
            DiagStatus::Orange
        }
    } else {
        DiagStatus::Unknown
    };

    Some(CellularDiagnostic {
        status,
        summary: format!("{} · {}/100 · {}", provider, strength, strength_label),
        provider,
        provider_code,
        strength,
        strength_label,
        ipv4,
        ipv6,
        dns_servers,
        internet_reachable,
        check_result,
        avg_latency_ms,
        packet_loss_pct,
        imei: None,
        iccid: None,
        apn: None,
        cell_status: None,
    })
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

fn resolve_provider(code: &str) -> String {
    match code {
        "311480" | "311481" | "311482" => "Verizon".into(),
        "310260" | "310026" => "T-Mobile".into(),
        "310410" => "AT&T".into(),
        "311490" => "T-Mobile (MVNO)".into(),
        _ => code.into(),
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

fn parse_packet_loss(text: &str) -> Option<u8> {
    let re = Regex::new(r"(\d+)%\s+packet loss").ok()?;
    re.captures(text)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<u8>().ok())
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

fn merge_cellular(
    cellular: &mut Option<CellularDiagnostic>,
    mutator: impl FnOnce(&mut CellularDiagnostic),
) {
    if cellular.is_none() {
        *cellular = Some(CellularDiagnostic {
            status: DiagStatus::Unknown,
            summary: "Cell data sample only".into(),
            provider: "—".into(),
            provider_code: "—".into(),
            strength: 0,
            strength_label: "unknown".into(),
            ipv4: false,
            ipv6: false,
            dns_servers: "—".into(),
            internet_reachable: false,
            check_result: "Unknown".into(),
            avg_latency_ms: None,
            packet_loss_pct: 0,
            imei: None,
            iccid: None,
            apn: None,
            cell_status: None,
        });
    }
    if let Some(cell) = cellular.as_mut() {
        mutator(cell);
    }
}
