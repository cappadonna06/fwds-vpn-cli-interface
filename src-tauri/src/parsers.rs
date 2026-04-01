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

fn parse_ethernet_check(block: &str) -> Option<EthernetDiagnostic> {
    let mut internet_reachable = false;
    let mut eth_state = String::new();
    let mut ipv4 = false;
    let mut ipv6 = false;
    let mut dns_servers = String::new();
    let mut check_result = String::new();

    for line in block.lines() {
        if let Some(v) = extract_after(line, "Internet reachability state:") {
            internet_reachable = v.eq_ignore_ascii_case("online");
        } else if let Some(v) = extract_after(line, "Ethernet state:") {
            eth_state = v.to_string();
        } else if let Some(v) = extract_after(line, "Ethernet supports IPv4?") {
            ipv4 = parse_yes_no(v);
        } else if let Some(v) = extract_after(line, "Ethernet supports IPv6?") {
            ipv6 = parse_yes_no(v);
        } else if let Some(v) = extract_after(line, "Ethernet name servers:") {
            dns_servers = v.to_string();
        } else if let Some(v) = extract_after(line, "Done:") {
            check_result = v.to_string();
        }
    }

    if eth_state.is_empty() && check_result.is_empty() {
        return None;
    }

    let avg_latency_ms = parse_rtt_avg(block);
    let _packet_loss_pct = parse_packet_loss(block);

    let success = check_result.eq_ignore_ascii_case("Success");
    let status = if success && internet_reachable {
        DiagStatus::Green
    } else if internet_reachable {
        DiagStatus::Orange
    } else {
        DiagStatus::Red
    };

    let summary = if internet_reachable {
        format!("Connected · {}", eth_state)
    } else {
        format!("Offline · {}", eth_state)
    };

    Some(EthernetDiagnostic {
        status,
        summary,
        internet_reachable,
        eth_state,
        ipv4,
        ipv6,
        dns_servers,
        ip_address: None,
        netmask: None,
        speed: None,
        duplex: None,
        link_detected: None,
        rx_errors: 0,
        tx_errors: 0,
        rx_dropped: 0,
        check_result,
        flap_count: 0,
    })
}

/// Parse `ethtool eth0` block — extract Speed, Duplex, Link detected.
fn parse_ethtool(block: &str) -> (Option<String>, Option<String>, Option<bool>) {
    let mut speed: Option<String> = None;
    let mut duplex: Option<String> = None;
    let mut link_detected: Option<bool> = None;

    for line in block.lines() {
        if let Some(v) = extract_after(line, "Speed:") {
            speed = Some(v.to_string());
        } else if let Some(v) = extract_after(line, "Duplex:") {
            duplex = Some(v.to_string());
        } else if let Some(v) = extract_after(line, "Link detected:") {
            link_detected = Some(v.eq_ignore_ascii_case("yes"));
        }
    }

    (speed, duplex, link_detected)
}

/// Parse `ifconfig eth0` block — extract inet, netmask, RX errors/dropped, TX errors.
fn parse_ifconfig(block: &str) -> (Option<String>, Option<String>, u64, u64, u64) {
    let mut ip_address: Option<String> = None;
    let mut netmask: Option<String> = None;
    let mut rx_errors: u64 = 0;
    let mut tx_errors: u64 = 0;
    let mut rx_dropped: u64 = 0;

    // RX errors pattern: "RX errors 0  dropped 0  overruns 0  frame 0"
    let rx_re = Regex::new(r"RX errors\s+(\d+).*dropped\s+(\d+)").unwrap();
    let tx_re = Regex::new(r"TX errors\s+(\d+)").unwrap();

    for line in block.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("inet ") {
            // "inet 192.168.1.100  netmask 0xffffff00  broadcast ..."
            // or "inet 192.168.1.100 netmask 255.255.255.0"
            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if parts.len() >= 2 {
                ip_address = Some(parts[1].to_string());
            }
            // Look for netmask in same line
            if let Some(v) = extract_after(trimmed, "netmask ") {
                let nm = v.split_whitespace().next().unwrap_or("").to_string();
                if !nm.is_empty() {
                    // Convert hex netmask if needed
                    if nm.starts_with("0x") {
                        netmask = Some(hex_netmask_to_dotted(&nm).unwrap_or(nm));
                    } else {
                        netmask = Some(nm);
                    }
                }
            }
        } else if let Some(cap) = rx_re.captures(trimmed) {
            rx_errors = cap[1].parse().unwrap_or(0);
            rx_dropped = cap[2].parse().unwrap_or(0);
        } else if let Some(cap) = tx_re.captures(trimmed) {
            tx_errors = cap[1].parse().unwrap_or(0);
        }
    }

    (ip_address, netmask, rx_errors, tx_errors, rx_dropped)
}

fn hex_netmask_to_dotted(hex: &str) -> Option<String> {
    let stripped = hex.trim_start_matches("0x");
    let n = u32::from_str_radix(stripped, 16).ok()?;
    Some(format!(
        "{}.{}.{}.{}",
        (n >> 24) & 0xff,
        (n >> 16) & 0xff,
        (n >> 8) & 0xff,
        n & 0xff
    ))
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

    // ── Ethernet ──
    if let Some(block) = latest.get("ethernet-check") {
        state.ethernet = parse_ethernet_check(block);
    }
    if let Some(ref mut eth) = state.ethernet {
        // Merge ethtool (may be "ethtool eth0" as full command)
        let ethtool_block = latest
            .iter()
            .find(|(k, _)| k.starts_with("ethtool"))
            .map(|(_, v)| v.as_str());
        if let Some(block) = ethtool_block {
            let (speed, duplex, link) = parse_ethtool(block);
            eth.speed = speed;
            eth.duplex = duplex;
            eth.link_detected = link;
            if eth.link_detected == Some(false) && !eth.internet_reachable {
                eth.status = DiagStatus::Red;
                eth.summary = "No link detected".into();
            }
        }

        // Merge ifconfig (may be "ifconfig eth0")
        let ifconfig_block = latest
            .iter()
            .find(|(k, _)| k.starts_with("ifconfig"))
            .map(|(_, v)| v.as_str());
        if let Some(block) = ifconfig_block {
            let (ip, nm, rx_err, tx_err, rx_drop) = parse_ifconfig(block);
            eth.ip_address = ip;
            eth.netmask = nm;
            eth.rx_errors = rx_err;
            eth.tx_errors = tx_err;
            eth.rx_dropped = rx_drop;
        }
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
