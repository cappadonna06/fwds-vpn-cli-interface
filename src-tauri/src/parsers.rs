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

    let mut wifi = parse_wifi_check(latest.get("wifi-check"));
    if let Some(dbm) = parse_wifi_signal(latest.get("wifi-signal")) {
        if let Some(w) = wifi.as_mut() {
            w.signal_dbm = Some(dbm);
        } else {
            wifi = Some(WifiDiagnostic {
                status: DiagStatus::Unknown,
                summary: "Signal sample only".into(),
                ssid: "—".into(),
                strength: 0,
                strength_label: "unknown".into(),
                signal_dbm: Some(dbm),
                ipv4: false,
                ipv6: false,
                dns_servers: "—".into(),
                internet_reachable: false,
                check_result: "Unknown".into(),
                avg_latency_ms: None,
                packet_loss_pct: 0,
            });
        }
    }

    let mut cellular = parse_cellular_check(latest.get("cellular-check"));
    if let Some(code) = parse_single_value(latest.get("cell-provider")) {
        let provider = resolve_provider(&code);
        merge_cellular(&mut cellular, |c| {
            c.provider_code = code.clone();
            c.provider = provider.clone();
            c.summary = format!("{} · {}/100 · {}", c.provider, c.strength, c.strength_label);
        });
    }
    if let Some(strength) =
        parse_single_value(latest.get("cell-signal")).and_then(|v| v.parse::<u8>().ok())
    {
        merge_cellular(&mut cellular, |c| {
            c.strength = strength;
            c.summary = format!("{} · {}/100 · {}", c.provider, c.strength, c.strength_label);
        });
    }
    if let Some(iccid) = parse_single_value(latest.get("cell-ccid")) {
        merge_cellular(&mut cellular, |c| c.iccid = Some(iccid.clone()));
    }
    if let Some(imei) = parse_single_value(latest.get("cell-imei")) {
        merge_cellular(&mut cellular, |c| c.imei = Some(imei.clone()));
    }
    if let Some(apn) = parse_single_value(latest.get("cell-apn")) {
        merge_cellular(&mut cellular, |c| c.apn = Some(apn.clone()));
    }
    if let Some(cell_status) = parse_single_value(latest.get("cell-status")) {
        merge_cellular(&mut cellular, |c| c.cell_status = Some(cell_status.clone()));
    }

    let satellite = parse_satellite(
        latest.get("setup-satellite"),
        latest
            .get("satellite-check -t")
            .or_else(|| latest.get("satellite-check -m"))
            .or_else(|| latest.get("satellite-check")),
    );

    let ethernet = parse_ethernet(
        latest.get("ethernet-check"),
        latest.get("ethtool eth0"),
        latest.get("ifconfig eth0"),
    );

    let system = parse_system(
        latest.get("sid"),
        latest.get("version"),
        latest.get("release"),
    );

    state.wifi = wifi;
    state.cellular = cellular;
    state.satellite = satellite;
    state.ethernet = ethernet;
    if system.sid.is_some() || system.version.is_some() || system.release_date.is_some() {
        state.system = Some(system);
    }
}

fn split_blocks(log: &str) -> Vec<CommandBlock> {
    let prompt_re = Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4} \[\d+\]# (.+)$")
        .expect("prompt regex");

    let mut blocks = Vec::new();
    let mut current_cmd: Option<String> = None;
    let mut current_body = String::new();

    for line in log.lines() {
        if let Some(cap) = prompt_re.captures(line) {
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

        if current_cmd.is_some() {
            current_body.push_str(line);
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

fn parse_wifi_check(block: Option<&String>) -> Option<WifiDiagnostic> {
    let text = block?;
    let ssid = capture_after(text, "Wi-Fi access point:").unwrap_or_else(|| "—".into());
    let (strength, strength_label) = parse_strength_line(capture_line(text, "Wi-Fi strength:"));
    let ipv4 = parse_yes_no(capture_after(text, "Wi-Fi supports IPv4?"));
    let ipv6 = parse_yes_no(capture_after(text, "Wi-Fi supports IPv6?"));
    let dns_servers = capture_after(text, "Wi-Fi name servers:").unwrap_or_else(|| "—".into());
    let internet_reachable = capture_after(text, "Internet reachability state:")
        .map(|s| s.eq_ignore_ascii_case("online"))
        .unwrap_or(false);
    let check_result = capture_after(text, "Done:").unwrap_or_else(|| "Unknown".into());
    let avg_latency_ms = parse_avg_latency(text);
    let packet_loss_pct = parse_packet_loss(text).unwrap_or(0);

    let status = if check_result.eq_ignore_ascii_case("failure") || !internet_reachable {
        DiagStatus::Red
    } else if check_result.eq_ignore_ascii_case("success") && internet_reachable {
        if strength >= 40 {
            DiagStatus::Green
        } else {
            DiagStatus::Orange
        }
    } else {
        DiagStatus::Unknown
    };

    Some(WifiDiagnostic {
        status,
        summary: format!("{} · {}/100 · {}", ssid, strength, strength_label),
        ssid,
        strength,
        strength_label,
        signal_dbm: None,
        ipv4,
        ipv6,
        dns_servers,
        internet_reachable,
        check_result,
        avg_latency_ms,
        packet_loss_pct,
    })
}

fn parse_wifi_signal(block: Option<&String>) -> Option<i32> {
    let text = block?;
    let re = Regex::new(r"signal strength:\s*(-?\d+)\s*dBm").ok()?;
    re.captures(text)
        .and_then(|c| c.get(1))
        .and_then(|v| v.as_str().parse::<i32>().ok())
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
    ifconfig: Option<&String>,
) -> Option<EthernetDiagnostic> {
    if ethernet_check.is_none() && ethtool.is_none() && ifconfig.is_none() {
        return None;
    }

    let internet_reachable = ethernet_check
        .and_then(|b| capture_after(b, "Internet reachability state:"))
        .map(|s| s.eq_ignore_ascii_case("online"))
        .unwrap_or(false);
    let eth_state = ethernet_check
        .and_then(|b| capture_after(b, "Ethernet state:"))
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

    let ip_address = ifconfig.and_then(parse_ifconfig_ip);
    let netmask = ifconfig.and_then(parse_ifconfig_netmask);
    let rx_errors = ifconfig.and_then(parse_ifconfig_rx_errors).unwrap_or(0);
    let tx_errors = ifconfig.and_then(parse_ifconfig_tx_errors).unwrap_or(0);
    let rx_dropped = ifconfig.and_then(parse_ifconfig_rx_dropped).unwrap_or(0);

    let status = if check_result.eq_ignore_ascii_case("failure") || !internet_reachable {
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

fn parse_ifconfig_ip(text: &String) -> Option<String> {
    let re = Regex::new(r"inet\s+(\d+\.\d+\.\d+\.\d+)").ok()?;
    re.captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

fn parse_ifconfig_netmask(text: &String) -> Option<String> {
    let re = Regex::new(r"netmask\s+(\S+)").ok()?;
    re.captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

fn parse_ifconfig_rx_errors(text: &String) -> Option<u64> {
    let re =
        Regex::new(r"RX packets\s+\d+\s+bytes\s+\d+\s+\((?:[^)]*)\)\s*\n\s*RX errors\s+(\d+)").ok();
    if let Some(re) = re {
        if let Some(v) = re
            .captures(text)
            .and_then(|c| c.get(1))
            .and_then(|m| m.as_str().parse::<u64>().ok())
        {
            return Some(v);
        }
    }
    let fallback = Regex::new(r"RX errors\s+(\d+)").ok()?;
    fallback
        .captures(text)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<u64>().ok())
}

fn parse_ifconfig_tx_errors(text: &String) -> Option<u64> {
    let re = Regex::new(r"TX errors\s+(\d+)").ok()?;
    re.captures(text)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<u64>().ok())
}

fn parse_ifconfig_rx_dropped(text: &String) -> Option<u64> {
    let re = Regex::new(r"RX dropped\s+(\d+)").ok()?;
    re.captures(text)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<u64>().ok())
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
