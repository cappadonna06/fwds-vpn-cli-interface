use regex::Regex;

use crate::{
    CellularDiagnostic, DiagStatus, DiagnosticState, EthernetDiagnostic, SatelliteDiagnostic,
    SystemDiagnostic, WifiDiagnostic,
};

// ── Block splitting ────────────────────────────────────────────────────────────

/// A single command block: the command name and all output text that followed.
struct Block {
    command: String,
    text: String,
}

/// Split the full log text into command blocks.
/// Each block starts at a timestamp+prompt line and runs until the next one.
fn split_into_blocks(log: &str) -> Vec<Block> {
    // Matches: 2026-03-31T18:46:45-0600 [24250072]# wifi-check
    let prompt_re = Regex::new(
        r"(?m)^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4} \[\d+\]# (.+)$",
    )
    .unwrap();

    let mut blocks: Vec<Block> = Vec::new();
    let mut last_end = 0usize;
    let mut last_cmd: Option<String> = None;

    for cap in prompt_re.captures_iter(log) {
        let m = cap.get(0).unwrap();
        let cmd = cap[1].trim().to_string();

        if let Some(prev_cmd) = last_cmd.take() {
            let text = log[last_end..m.start()].to_string();
            blocks.push(Block {
                command: prev_cmd,
                text,
            });
        }

        last_cmd = Some(cmd);
        last_end = m.end();
    }

    // Last block
    if let Some(cmd) = last_cmd {
        blocks.push(Block {
            command: cmd,
            text: log[last_end..].to_string(),
        });
    }

    blocks
}

// ── Generic helpers ────────────────────────────────────────────────────────────

fn extract_after<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    line.find(prefix)
        .map(|i| line[i + prefix.len()..].trim())
}

fn parse_yes_no(val: &str) -> bool {
    val.trim().eq_ignore_ascii_case("yes")
}

/// Parse "53/100 (\"weak\")" → (53, "weak")
fn parse_strength(text: &str) -> Option<(u8, String)> {
    let re = Regex::new(r#"(\d+)/100 \("(\w+)"\)"#).unwrap();
    let cap = re.captures(text)?;
    let strength: u8 = cap[1].parse().ok()?;
    let label = cap[2].to_string();
    Some((strength, label))
}

/// Parse round-trip-time line "min/avg/max/last/mdev = 1.2/3.4/5.6/7.8/0.1"
/// and return the avg (second field).
fn parse_rtt_avg(block: &str) -> Option<f64> {
    for line in block.lines() {
        if line.contains("min/avg/max") && line.contains('=') {
            let after_eq = line.splitn(2, '=').nth(1)?.trim();
            let avg = after_eq.split('/').nth(1)?;
            return avg.trim().parse().ok();
        }
    }
    None
}

/// Parse "X packets transmitted, Y received, Z% packet loss"
fn parse_packet_loss(block: &str) -> u8 {
    let re = Regex::new(r"(\d+)% packet loss").unwrap();
    for line in block.lines() {
        if let Some(cap) = re.captures(line) {
            if let Ok(v) = cap[1].parse() {
                return v;
            }
        }
    }
    0
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

// ── Per-command parsers ────────────────────────────────────────────────────────

fn parse_wifi_check(block: &str) -> Option<WifiDiagnostic> {
    let mut internet_reachable = false;
    let mut ssid = String::new();
    let mut strength: u8 = 0;
    let mut strength_label = String::new();
    let mut ipv4 = false;
    let mut ipv6 = false;
    let mut dns_servers = String::new();
    let mut check_result = String::new();

    for line in block.lines() {
        if let Some(v) = extract_after(line, "Internet reachability state:") {
            internet_reachable = v.eq_ignore_ascii_case("online");
        } else if let Some(v) = extract_after(line, "Wi-Fi access point:") {
            ssid = v.to_string();
        } else if let Some(v) = extract_after(line, "Wi-Fi strength:") {
            if let Some((s, l)) = parse_strength(v) {
                strength = s;
                strength_label = l;
            }
        } else if let Some(v) = extract_after(line, "Wi-Fi supports IPv4?") {
            ipv4 = parse_yes_no(v);
        } else if let Some(v) = extract_after(line, "Wi-Fi supports IPv6?") {
            ipv6 = parse_yes_no(v);
        } else if let Some(v) = extract_after(line, "Wi-Fi name servers:") {
            dns_servers = v.to_string();
        } else if let Some(v) = extract_after(line, "Done:") {
            check_result = v.to_string();
        }
    }

    if ssid.is_empty() && check_result.is_empty() {
        return None;
    }

    let avg_latency_ms = parse_rtt_avg(block);
    let packet_loss_pct = parse_packet_loss(block);

    let success = check_result.eq_ignore_ascii_case("Success");
    let status = if success && internet_reachable && strength >= 40 {
        DiagStatus::Green
    } else if success && internet_reachable {
        DiagStatus::Orange
    } else {
        DiagStatus::Red
    };

    let summary = format!("{} · {}/100 · {}", ssid, strength, strength_label);

    Some(WifiDiagnostic {
        status,
        summary,
        ssid,
        strength,
        strength_label,
        signal_dbm: None, // merged later from wifi-signal
        ipv4,
        ipv6,
        dns_servers,
        internet_reachable,
        check_result,
        avg_latency_ms,
        packet_loss_pct,
    })
}

fn parse_wifi_signal(block: &str) -> Option<i32> {
    let re = Regex::new(r"signal strength:\s*(-?\d+)\s*dBm").unwrap();
    for line in block.lines() {
        if let Some(cap) = re.captures(line) {
            return cap[1].parse().ok();
        }
    }
    None
}

fn parse_cellular_check(block: &str) -> Option<CellularDiagnostic> {
    let mut internet_reachable = false;
    let mut provider_code = String::new();
    let mut strength: u8 = 0;
    let mut strength_label = String::new();
    let mut ipv4 = false;
    let mut ipv6 = false;
    let mut dns_servers = String::new();
    let mut check_result = String::new();

    for line in block.lines() {
        if let Some(v) = extract_after(line, "Internet reachability state:") {
            internet_reachable = v.eq_ignore_ascii_case("online");
        } else if let Some(v) = extract_after(line, "Cellular provider:") {
            provider_code = v.to_string();
        } else if let Some(v) = extract_after(line, "Cellular strength:") {
            if let Some((s, l)) = parse_strength(v) {
                strength = s;
                strength_label = l;
            }
        } else if let Some(v) = extract_after(line, "Cellular supports IPv4?") {
            ipv4 = parse_yes_no(v);
        } else if let Some(v) = extract_after(line, "Cellular supports IPv6?") {
            ipv6 = parse_yes_no(v);
        } else if let Some(v) = extract_after(line, "Cellular name servers:") {
            dns_servers = v.to_string();
        } else if let Some(v) = extract_after(line, "Done:") {
            check_result = v.to_string();
        }
    }

    if provider_code.is_empty() && check_result.is_empty() {
        return None;
    }

    let avg_latency_ms = parse_rtt_avg(block);
    let packet_loss_pct = parse_packet_loss(block);
    let provider = resolve_provider(&provider_code);

    let success = check_result.eq_ignore_ascii_case("Success");
    let status = if success && internet_reachable && strength >= 50 {
        DiagStatus::Green
    } else if success && internet_reachable {
        DiagStatus::Orange
    } else {
        DiagStatus::Red
    };

    let summary = format!("{} · {}/100 · {}", provider, strength, strength_label);

    Some(CellularDiagnostic {
        status,
        summary,
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

fn parse_cell_signal(block: &str) -> Option<u8> {
    for line in block.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            if let Ok(v) = trimmed.parse::<u8>() {
                return Some(v);
            }
        }
    }
    None
}

fn parse_cell_single_line(block: &str) -> Option<String> {
    for line in block.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn parse_satellite(setup_block: Option<&str>, check_block: Option<&str>) -> Option<SatelliteDiagnostic> {
    let mut enabled = false;
    let mut loopback_passed: Option<bool> = None;
    let mut loopback_time_secs: Option<f64> = None;

    if let Some(block) = setup_block {
        // Look for "Satellite is available" + "Y" response
        let lower = block.to_lowercase();
        if lower.contains("satellite is available") {
            enabled = true;
        }
    }

    if let Some(block) = check_block {
        for line in block.lines() {
            if line.contains("successfully completed satellite loopback") {
                loopback_passed = Some(true);
            } else if line.to_lowercase().contains("failed") && line.to_lowercase().contains("loopback") {
                loopback_passed = Some(false);
            } else if let Some(v) = extract_after(line, "time=") {
                // Parse H:MM:SS.mmm
                if let Some(secs) = parse_time_to_secs(v) {
                    loopback_time_secs = Some(secs);
                }
            }
        }
    }

    if !enabled && loopback_passed.is_none() {
        return None;
    }

    let status = match loopback_passed {
        Some(true) => DiagStatus::Green,
        Some(false) => DiagStatus::Red,
        None if enabled => DiagStatus::Orange,
        None => DiagStatus::Unknown,
    };

    let summary = match loopback_passed {
        Some(true) => {
            if let Some(t) = loopback_time_secs {
                let mins = (t / 60.0) as u32;
                let secs = (t % 60.0) as u32;
                format!("Loopback passed · {}m {}s", mins, secs)
            } else {
                "Loopback passed".into()
            }
        }
        Some(false) => "Loopback failed".into(),
        None if enabled => "Enabled · not tested".into(),
        None => "Offline".into(),
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

/// Parse "H:MM:SS.mmm" or "M:SS.mmm" to total seconds.
fn parse_time_to_secs(s: &str) -> Option<f64> {
    let s = s.trim();
    let parts: Vec<&str> = s.split(':').collect();
    match parts.len() {
        3 => {
            let h: f64 = parts[0].parse().ok()?;
            let m: f64 = parts[1].parse().ok()?;
            let sec: f64 = parts[2].parse().ok()?;
            Some(h * 3600.0 + m * 60.0 + sec)
        }
        2 => {
            let m: f64 = parts[0].parse().ok()?;
            let sec: f64 = parts[1].parse().ok()?;
            Some(m * 60.0 + sec)
        }
        _ => None,
    }
}

// ── Comprehensive Ethernet parsers ────────────────────────────────────────────

fn eth_check_from_block(block: &str, diag: &mut EthernetDiagnostic) {
    for line in block.lines() {
        if let Some(v) = extract_after(line, "Internet reachability state:") {
            diag.internet_reachable = v.eq_ignore_ascii_case("online");
        } else if let Some(v) = extract_after(line, "Ethernet state:") {
            diag.eth_state = v.to_string();
        } else if let Some(v) = extract_after(line, "Ethernet supports IPv4?") {
            diag.ipv4 = parse_yes_no(v);
        } else if let Some(v) = extract_after(line, "Ethernet supports IPv6?") {
            diag.ipv6 = parse_yes_no(v);
        } else if let Some(v) = extract_after(line, "Ethernet name servers:") {
            diag.dns_servers = v.to_string();
        } else if let Some(v) = extract_after(line, "Done: Failure:") {
            diag.check_result = "Failure".into();
            diag.check_error = Some(v.trim().to_string());
        } else if let Some(v) = extract_after(line, "Done:") {
            diag.check_result = v.trim().to_string();
        }
    }
    // Average all RTT lines (may have multiple ICMP targets)
    let mut rtt_sum = 0.0f64;
    let mut rtt_count = 0usize;
    for line in block.lines() {
        if line.contains("min/avg/max") && line.contains('=') {
            if let Some(avg) = parse_rtt_avg(line) {
                rtt_sum += avg;
                rtt_count += 1;
            }
        }
    }
    if rtt_count > 0 {
        diag.check_avg_latency_ms = Some(rtt_sum / rtt_count as f64);
    }
    diag.check_packet_loss_pct = parse_packet_loss(block);
}

fn ethtool_from_block(block: &str, diag: &mut EthernetDiagnostic) {
    for line in block.lines() {
        let t = line.trim();
        if let Some(v) = extract_after(t, "Speed:") {
            // "Unknown!" → leave as string, frontend handles display
            let s = v.to_string();
            if !s.starts_with("Unknown") {
                diag.speed = Some(s);
            }
        } else if let Some(v) = extract_after(t, "Duplex:") {
            let s = v.to_string();
            if !s.starts_with("Unknown") {
                diag.duplex = Some(s);
            }
        } else if let Some(v) = extract_after(t, "Auto-negotiation:") {
            diag.auto_negotiation = Some(v.eq_ignore_ascii_case("on"));
        } else if let Some(v) = extract_after(t, "Link detected:") {
            diag.link_detected = Some(v.eq_ignore_ascii_case("yes"));
        }
    }
}

fn carrier_from_block(block: &str, diag: &mut EthernetDiagnostic) {
    for line in block.lines() {
        let t = line.trim();
        if t == "1" { diag.carrier = Some(true); return; }
        if t == "0" { diag.carrier = Some(false); return; }
    }
}

fn operstate_from_block(block: &str, diag: &mut EthernetDiagnostic) {
    for line in block.lines() {
        let t = line.trim();
        if !t.is_empty() {
            diag.operstate = Some(t.to_string());
            return;
        }
    }
}

fn ip_link_from_block(block: &str, diag: &mut EthernetDiagnostic) {
    // 2: eth0: <NO-CARRIER,BROADCAST,MULTICAST,DYNAMIC,UP> mtu 1500 ... state DOWN
    let flags_re = Regex::new(r"<([^>]+)>").unwrap();
    let state_re = Regex::new(r"\bstate\s+(UP|DOWN|UNKNOWN)\b").unwrap();
    let mac_re = Regex::new(r"link/ether\s+([0-9a-f:]{17})").unwrap();

    for line in block.lines() {
        if line.contains("eth0") {
            if let Some(cap) = flags_re.captures(line) {
                let flags = &cap[1];
                diag.no_carrier_flag = Some(flags.contains("NO-CARRIER"));
                diag.lower_up_flag = Some(flags.contains("LOWER_UP"));
            }
            if let Some(cap) = state_re.captures(line) {
                diag.link_state = Some(cap[1].to_string());
            }
        }
        if let Some(cap) = mac_re.captures(line) {
            diag.mac_address = Some(cap[1].to_string());
        }
    }
}

fn ip_addr_from_block(block: &str, diag: &mut EthernetDiagnostic) {
    // "    inet 192.168.7.42/22 brd ..."
    let re = Regex::new(r"inet\s+(\d+\.\d+\.\d+\.\d+)/(\d+)").unwrap();
    for line in block.lines() {
        if line.trim_start().starts_with("inet ") && !line.contains("inet6") {
            if let Some(cap) = re.captures(line) {
                diag.ipv4_address = Some(cap[1].to_string());
                diag.ipv4_prefix = cap[2].parse().ok();
            }
        }
    }
}

fn ip_route_from_block(block: &str, diag: &mut EthernetDiagnostic) {
    // "default via 192.168.4.1 dev eth0"
    let re = Regex::new(r"default via (\d+\.\d+\.\d+\.\d+) dev (\S+)").unwrap();
    for line in block.lines() {
        if let Some(cap) = re.captures(line) {
            let gw = cap[1].to_string();
            let dev = &cap[2];
            if dev == "eth0" {
                diag.default_via_eth0 = Some(true);
                diag.default_gateway = Some(gw);
                return;
            } else if diag.default_gateway.is_none() {
                diag.default_via_eth0 = Some(false);
                diag.default_gateway = Some(gw);
            }
        }
    }
    if diag.default_via_eth0.is_none() && diag.default_gateway.is_some() {
        diag.default_via_eth0 = Some(false);
    }
}

fn connman_tech_from_block(block: &str, diag: &mut EthernetDiagnostic) {
    let mut current_type: Option<&str> = None;
    for line in block.lines() {
        let t = line.trim();
        if t.contains("technology/ethernet") { current_type = Some("ethernet"); }
        else if t.contains("technology/wifi") { current_type = Some("wifi"); }
        else if t.contains("technology/cellular") || t.contains("technology/gadget") {
            current_type = Some("cellular");
        }
        if let Some(v) = extract_after(t, "Connected =") {
            let is_conn = v.trim().eq_ignore_ascii_case("true");
            match current_type {
                Some("ethernet") => diag.connman_eth_connected = Some(is_conn),
                Some("wifi") => diag.connman_wifi_connected = Some(is_conn),
                Some("cellular") => diag.connman_cell_connected = Some(is_conn),
                _ => {}
            }
        }
        if let Some(v) = extract_after(t, "Powered =") {
            let is_on = v.trim().eq_ignore_ascii_case("true");
            if current_type == Some("ethernet") {
                diag.connman_eth_powered = Some(is_on);
            }
        }
    }
}

fn connman_services_from_block(block: &str, diag: &mut EthernetDiagnostic) {
    // "*AO Wired                ethernet_0004f387eb94_cable"
    // "*AO lieberells           wifi_..."
    for line in block.lines() {
        if !line.contains("*AO") { continue; }
        // Extract service name (second whitespace-separated token)
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 {
            let name = parts[1].to_string();
            diag.connman_active_service = Some(name);
        }
        // Check if the *AO line contains ethernet service
        diag.connman_eth_active = Some(line.contains("ethernet_"));
        break;
    }
}

fn connman_state_from_block(block: &str, diag: &mut EthernetDiagnostic) {
    for line in block.lines() {
        if let Some(v) = extract_after(line.trim(), "State =") {
            diag.connman_state = Some(v.trim().to_string());
            return;
        }
    }
}

fn dmesg_eth_from_block(block: &str, diag: &mut EthernetDiagnostic) {
    // [13582.743270] fec 2188000.ethernet eth0: Link is Up
    let re = Regex::new(r"\[\s*(\d+)\.\d+\].*eth0: Link is (Up|Down)").unwrap();
    for line in block.lines() {
        if let Some(cap) = re.captures(line) {
            let ts: f64 = cap[1].parse().unwrap_or(0.0);
            if ts < 30.0 { continue; } // skip boot-time events
            diag.dmesg_link_events.push(line.trim().to_string());
        }
    }
    // Count flaps: each Up→Down pair is one flap
    let mut up_seen = false;
    for event in &diag.dmesg_link_events {
        if event.contains("Link is Up") { up_seen = true; }
        else if event.contains("Link is Down") && up_seen {
            diag.flap_count += 1;
            up_seen = false;
        }
    }
}

fn ethtool_stats_from_block(block: &str, diag: &mut EthernetDiagnostic) {
    for line in block.lines() {
        let t = line.trim();
        if let Some(v) = extract_after(t, "tx_packets:") {
            diag.hw_tx_packets = v.trim().parse().ok();
        } else if let Some(v) = extract_after(t, "rx_packets:") {
            diag.hw_rx_packets = v.trim().parse().ok();
        } else if let Some(v) = extract_after(t, "rx_crc_errors:") {
            diag.hw_rx_crc_errors = v.trim().parse().ok();
        } else if let Some(v) = extract_after(t, "IEEE_rx_align:") {
            diag.hw_rx_align_errors = v.trim().parse().ok();
        }
    }
}

fn proc_net_dev_from_block(block: &str, diag: &mut EthernetDiagnostic) {
    // eth0: rx_bytes rx_pkts rx_errs rx_drop ... tx_bytes tx_pkts tx_errs ...
    for line in block.lines() {
        if let Some(rest) = line.find("eth0:").map(|i| &line[i + 5..]) {
            let cols: Vec<&str> = rest.split_whitespace().collect();
            // RX: cols 0-7, TX: cols 8-15
            if cols.len() >= 11 {
                diag.proc_rx_bytes   = cols[0].parse().ok();
                diag.proc_rx_packets = cols[1].parse().ok();
                diag.proc_rx_errs    = cols[2].parse().ok();
                diag.proc_rx_drop    = cols[3].parse().ok();
                diag.proc_tx_bytes   = cols[8].parse().ok();
                diag.proc_tx_packets = cols[9].parse().ok();
                diag.proc_tx_errs    = cols[10].parse().ok();
            }
        }
    }
}

fn determine_eth_status(diag: &mut EthernetDiagnostic) {
    // RED: No physical link
    if diag.link_detected == Some(false)
        || diag.carrier == Some(false)
        || diag.operstate.as_deref() == Some("down")
        || diag.no_carrier_flag == Some(true)
    {
        diag.status = DiagStatus::Red;
        diag.summary = "No link — cable unplugged or bad port".into();
        return;
    }
    // RED: ConnMan says Ethernet technology not connected
    if diag.check_error.as_deref().map(|e| e.contains("-65554")).unwrap_or(false) {
        diag.status = DiagStatus::Red;
        diag.summary = "Not connected — Ethernet technology not enabled".into();
        return;
    }
    // RED: Flapping
    if diag.flap_count > 3 {
        diag.status = DiagStatus::Red;
        diag.summary = format!("Flapping — {} link events detected", diag.flap_count);
        return;
    }
    // GREEN: All good
    if diag.check_result == "Success" && diag.internet_reachable {
        let ip = diag.ipv4_address.as_deref().unwrap_or("no IP");
        let speed = diag.speed.as_deref().unwrap_or("unknown speed");
        let preferred = if diag.connman_eth_active == Some(true) { " · preferred" } else { "" };
        diag.status = DiagStatus::Green;
        diag.summary = format!("{} · {}{}", ip, speed, preferred);
        return;
    }
    // ORANGE: Link up but DNS/internet failure
    if diag.link_detected == Some(true) && diag.ipv4_address.is_some() {
        diag.status = DiagStatus::Orange;
        diag.summary = "Link up — DNS or internet failure".into();
        return;
    }
    // ORANGE: Link up but no IP
    if diag.link_detected == Some(true) {
        diag.status = DiagStatus::Orange;
        diag.summary = "Link up — no IP assigned (DHCP failure?)".into();
        return;
    }
    // Incomplete data
    if !diag.check_result.is_empty() {
        diag.status = DiagStatus::Orange;
        diag.summary = "Partial data".into();
    }
}

fn make_empty_ethernet() -> EthernetDiagnostic {
    EthernetDiagnostic {
        status: DiagStatus::Unknown,
        summary: String::new(),
        check_result: String::new(),
        check_error: None,
        internet_reachable: false,
        eth_state: String::new(),
        ipv4: false,
        ipv6: false,
        dns_servers: String::new(),
        check_avg_latency_ms: None,
        check_packet_loss_pct: 0,
        link_detected: None,
        speed: None,
        duplex: None,
        auto_negotiation: None,
        carrier: None,
        operstate: None,
        no_carrier_flag: None,
        lower_up_flag: None,
        link_state: None,
        mac_address: None,
        ipv4_address: None,
        ipv4_prefix: None,
        default_via_eth0: None,
        default_gateway: None,
        connman_eth_powered: None,
        connman_eth_connected: None,
        connman_wifi_connected: None,
        connman_cell_connected: None,
        connman_active_service: None,
        connman_eth_active: None,
        connman_state: None,
        dmesg_link_events: Vec::new(),
        flap_count: 0,
        hw_tx_packets: None,
        hw_rx_packets: None,
        hw_rx_crc_errors: None,
        hw_rx_align_errors: None,
        proc_rx_bytes: None,
        proc_rx_packets: None,
        proc_rx_errs: None,
        proc_rx_drop: None,
        proc_tx_bytes: None,
        proc_tx_packets: None,
        proc_tx_errs: None,
    }
}

fn parse_version(block: &str) -> Option<String> {
    for line in block.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn parse_sid(block: &str) -> Option<String> {
    for line in block.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn parse_release_date(block: &str) -> Option<String> {
    for line in block.lines() {
        if let Some(v) = extract_after(line, "Date:") {
            return Some(v.to_string());
        }
    }
    None
}

// ── Public entry point ─────────────────────────────────────────────────────────

/// Parse the full accumulated log text and update DiagnosticState in-place.
/// Always uses the most recent occurrence of each command block.
/// Never panics on malformed/partial output.
pub fn parse_log_into_state(text: &str, state: &mut DiagnosticState) {
    let blocks = split_into_blocks(text);

    // Collect the last occurrence of each command
    use std::collections::HashMap;
    let mut latest: HashMap<String, String> = HashMap::new();
    for block in blocks {
        // Normalize command: take first token (handles "ethtool eth0", "satellite-check -t", etc.)
        let key = block.command.clone();
        latest.insert(key, block.text);
    }

    // ── WiFi ──
    if let Some(block) = latest.get("wifi-check") {
        state.wifi = parse_wifi_check(block);
    }
    if let Some(block) = latest.get("wifi-signal") {
        if let Some(dbm) = parse_wifi_signal(block) {
            if let Some(ref mut wifi) = state.wifi {
                wifi.signal_dbm = Some(dbm);
            }
        }
    }

    // ── Cellular ──
    if let Some(block) = latest.get("cellular-check") {
        state.cellular = parse_cellular_check(block);
    }
    // Merge cell-* supplements
    if let Some(ref mut cell) = state.cellular {
        if let Some(block) = latest.get("cell-signal") {
            if let Some(s) = parse_cell_signal(block) {
                cell.strength = s;
                // Update summary with new strength
                cell.summary = format!("{} · {}/100 · {}", cell.provider, s, cell.strength_label);
            }
        }
        if let Some(block) = latest.get("cell-provider") {
            if let Some(code) = parse_cell_single_line(block) {
                let provider = resolve_provider(&code);
                cell.provider = provider.clone();
                cell.provider_code = code;
                cell.summary = format!("{} · {}/100 · {}", provider, cell.strength, cell.strength_label);
            }
        }
        if let Some(block) = latest.get("cell-ccid") {
            cell.iccid = parse_cell_single_line(block);
        }
        if let Some(block) = latest.get("cell-imei") {
            cell.imei = parse_cell_single_line(block);
        }
        if let Some(block) = latest.get("cell-apn") {
            cell.apn = parse_cell_single_line(block);
        }
        if let Some(block) = latest.get("cell-status") {
            cell.cell_status = parse_cell_single_line(block);
        }
    }

    // ── Satellite ──
    // Handle both "setup-satellite" and "satellite-check -t" (key is the full command string)
    let sat_setup = latest.get("setup-satellite").map(|s| s.as_str());
    // satellite-check may appear as "satellite-check -t" or "satellite-check -m"
    let sat_check = latest
        .iter()
        .filter(|(k, _)| k.starts_with("satellite-check"))
        .max_by_key(|(k, _)| k.len()) // prefer more specific
        .map(|(_, v)| v.as_str());

    if sat_setup.is_some() || sat_check.is_some() {
        state.satellite = parse_satellite(sat_setup, sat_check);
    }

    // ── Ethernet — build from any available command blocks ──
    let has_eth_data = latest.keys().any(|k|
        k == "ethernet-check"
        || k.starts_with("ethtool")
        || k.starts_with("ip link")
        || k.starts_with("ip addr")
        || k.starts_with("ip route")
        || k.starts_with("cat /sys/class/net/eth0")
        || k.starts_with("connmanctl")
        || k.starts_with("dmesg")
        || k.starts_with("cat /proc/net/dev")
    );

    if has_eth_data {
        let mut eth = make_empty_ethernet();

        if let Some(block) = latest.get("ethernet-check") {
            eth_check_from_block(block, &mut eth);
        }
        if let Some(block) = latest.iter().find(|(k, _)| k.starts_with("ethtool") && !k.contains("-S")).map(|(_, v)| v.as_str()) {
            ethtool_from_block(block, &mut eth);
        }
        if let Some(block) = latest.iter().find(|(k, _)| k.starts_with("ethtool -S") || k.starts_with("ethtool-stats")).map(|(_, v)| v.as_str()) {
            ethtool_stats_from_block(block, &mut eth);
        }
        if let Some(block) = latest.get("cat /sys/class/net/eth0/carrier").map(|s| s.as_str()) {
            carrier_from_block(block, &mut eth);
        }
        if let Some(block) = latest.get("cat /sys/class/net/eth0/operstate").map(|s| s.as_str()) {
            operstate_from_block(block, &mut eth);
        }
        // "ip link show eth0" or "ip link"
        if let Some(block) = latest.iter().find(|(k, _)| k.starts_with("ip link")).map(|(_, v)| v.as_str()) {
            ip_link_from_block(block, &mut eth);
        }
        // "ip addr show eth0" or "ip addr"
        if let Some(block) = latest.iter().find(|(k, _)| k.starts_with("ip addr")).map(|(_, v)| v.as_str()) {
            ip_addr_from_block(block, &mut eth);
        }
        if let Some(block) = latest.get("ip route").map(|s| s.as_str()) {
            ip_route_from_block(block, &mut eth);
        }
        if let Some(block) = latest.get("connmanctl technologies").map(|s| s.as_str()) {
            connman_tech_from_block(block, &mut eth);
        }
        if let Some(block) = latest.get("connmanctl services").map(|s| s.as_str()) {
            connman_services_from_block(block, &mut eth);
        }
        if let Some(block) = latest.get("connmanctl state").map(|s| s.as_str()) {
            connman_state_from_block(block, &mut eth);
        }
        if let Some(block) = latest.iter().find(|(k, _)| k.starts_with("dmesg")).map(|(_, v)| v.as_str()) {
            dmesg_eth_from_block(block, &mut eth);
        }
        if let Some(block) = latest.get("cat /proc/net/dev").map(|s| s.as_str()) {
            proc_net_dev_from_block(block, &mut eth);
        }

        determine_eth_status(&mut eth);
        state.ethernet = Some(eth);
    }

    // ── System ──
    let sid = latest.get("sid").and_then(|b| parse_sid(b));
    let version = latest.get("version").and_then(|b| parse_version(b));
    let release_date = latest.get("release").and_then(|b| parse_release_date(b));

    if sid.is_some() || version.is_some() || release_date.is_some() {
        let sys = state.system.get_or_insert(SystemDiagnostic {
            sid: None,
            version: None,
            release_date: None,
        });
        if sid.is_some() {
            sys.sid = sid;
        }
        if version.is_some() {
            sys.version = version;
        }
        if release_date.is_some() {
            sys.release_date = release_date;
        }
    }
}
