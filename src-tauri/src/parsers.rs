use regex::Regex;
use std::collections::HashMap;

use crate::{
    CellularDiagnostic, CopsNetwork, DiagStatus, DiagnosticState, EthernetDiagnostic,
    SatelliteDiagnostic, SimPickerDiagnostic, SimPickerRecommendation, SystemDiagnostic,
    WifiDiagnostic,
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

    let mut cellular = parse_cellular_from_latest(&latest);

    // Post-process: detect setup-cellular events from the full log (outside command blocks)
    // then compute modem_unreachable and re-run status if needed.
    if let Some(ref mut cell_diag) = cellular {
        detect_setup_cellular_events(log, cell_diag);

        cell_diag.modem_unreachable =
            cell_diag.imei.is_some()
            && (cell_diag.at_interface_failed == Some(true) || cell_diag.setup_timed_out)
            && (cell_diag.cellular_disabled || cell_diag.setup_attempted);

        if cell_diag.modem_unreachable {
            determine_cellular_status(cell_diag);
        }
    }

    let satellite = build_satellite_parse_block(&latest).map(|block| parse_satellite(&block));

    let ethernet_block = find_latest_body_contains(
        &latest,
        &[
            "===== eth diagnostics start =====",
            "===== eth diagnostics end =====",
        ],
    );
    let full_eth_block_run = ethernet_block.is_some();
    let ethernet_diag_attempted = full_eth_block_run
        || find_latest(&latest, &["ethernet-check"]).is_some()
        || find_latest(&latest, &["ethtool eth0"]).is_some()
        || latest.values().any(|body| {
            let lower = body.to_ascii_lowercase();
            lower.contains("===== eth diagnostics start =====")
                || lower.contains("ethtool eth0")
                || lower.contains("ethernet-check")
        });
    let ethernet = if ethernet_diag_attempted {
        parse_ethernet(
            find_latest(&latest, &["ethernet-check", "run ethernet diagnostics"])
                .or(ethernet_block),
            find_latest(&latest, &["ethtool eth0", "run ethernet diagnostics"]).or(ethernet_block),
            find_latest(
                &latest,
                &[
                    "ifconfig eth0",
                    "ip addr show eth0",
                    "run ethernet diagnostics",
                    "ethernet diags heavy",
                ],
            )
            .or(ethernet_block),
            find_latest(
                &latest,
                &[
                    "cat /proc/net/dev",
                    "run ethernet diagnostics",
                    "ethernet diags heavy",
                ],
            )
            .or(ethernet_block),
            find_latest(
                &latest,
                &[
                    "cat /sys/class/net/eth0/operstate",
                    "run ethernet diagnostics",
                    "ethernet diags heavy",
                ],
            )
            .or(ethernet_block),
            full_eth_block_run,
            ethernet_diag_attempted,
        )
    } else {
        None
    };

    let mut system = parse_system(
        find_latest(&latest, &["sid"]),
        find_latest(&latest, &["version"]),
        find_latest(&latest, &["release"]),
    );
    if system.sid.is_none() {
        system.sid = parse_sid_from_prompt(log);
    }

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
    if let Some(next) = satellite {
        state.satellite = Some(next);
    }

    // SIM Picker: look for the block sentinel or any cell-support --scan output
    let sim_picker_block = find_latest_body_contains(&latest, &["===== sim picker start ====="])
        .or_else(|| find_latest(&latest, &["cell-support --no-ofono --at --scan"]));
    if let Some(block) = sim_picker_block {
        let sp = parse_sim_picker(block);
        if sp.scan_attempted || sp.full_block_run {
            // When the unified SIM Picker block was run it contains all cellular commands too.
            // Parse cellular from it so the Cellular card populates even if no separate
            // cellular diag block exists in the log.
            if sp.full_block_run {
                let cell = parse_cellular(block);
                state.cellular = Some(match state.cellular.take() {
                    Some(prev) => {
                        // Only replace if the block-parsed result has more data
                        if cell.imei.is_some() || cell.internet_reachable {
                            cell
                        } else {
                            prev
                        }
                    }
                    None => cell,
                });
            }
            state.sim_picker = Some(sp);
        }
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

fn find_latest_body_contains_any<'a>(
    latest: &'a HashMap<String, String>,
    markers: &[&str],
) -> Option<&'a String> {
    latest.values().find(|body| {
        let lower = body.to_ascii_lowercase();
        markers
            .iter()
            .any(|m| lower.contains(&m.to_ascii_lowercase()))
    })
}

fn parse_sid_from_prompt(log: &str) -> Option<String> {
    let sid_re = Regex::new(r"\[(\d{6,10})\]#").ok()?;
    sid_re
        .captures_iter(log)
        .filter_map(|caps| caps.get(1).map(|m| m.as_str().to_string()))
        .last()
}

fn build_satellite_parse_block(latest: &HashMap<String, String>) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    let keys = [
        "date",
        "version",
        "sid",
        "sat-imei",
        "connmanctl technologies",
        "connmanctl services",
        "connmanctl state",
        "ip route",
        "satellite-check -c 1 -W 1 -w 1",
        "satellite-check -c 1 -W 1 -w 1 -v",
        "satellite-check -t -f -v -W 5 -w 10",
        "satellite-check -t",
        "satellite-check",
    ];

    for key in keys {
        if let Some(body) = latest.get(key) {
            parts.push(format!("$ {key}\n{body}"));
        }
    }

    if let Some(wrapped) = find_latest(
        latest,
        &[
            "run satellite diagnostics",
            "===== QUICK SATELLITE CHECK =====",
            "===== SATELLITE LOOPBACK TEST =====",
        ],
    ) {
        parts.push(wrapped.clone());
    }

    if parts.is_empty() {
        // Fall back to finding the satellite section embedded in a full-block body.
        // When the full (...) subshell ran, split_blocks produces one block whose key
        // is "(" and whose body contains all sections including satellite markers.
        if let Some(full_block) = find_latest_body_contains_any(
            latest,
            &[
                "===== satellite loopback test =====",
                "===== satellite basic =====",
            ],
        ) {
            return Some(full_block.clone());
        }
        None
    } else {
        Some(parts.join("\n\n"))
    }
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
    let mut orphan_body = String::new();

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
                if !orphan_body.trim().is_empty() {
                    blocks.push(CommandBlock {
                        command: "__orphan__".to_string(),
                        body: orphan_body.trim().to_string(),
                    });
                    orphan_body.clear();
                }
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
        } else if !cleaned.is_empty() {
            orphan_body.push_str(cleaned);
            orphan_body.push('\n');
        }
    }

    if !orphan_body.trim().is_empty() {
        blocks.push(CommandBlock {
            command: "__orphan__".to_string(),
            body: orphan_body.trim().to_string(),
        });
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
    use super::{parse_cellular, parse_log_into_state, split_blocks};
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
    fn parse_log_extracts_system_sid_from_prompt_when_sid_command_missing() {
        let mut state = DiagnosticState::default();
        let log =
            "2026-04-01T10:33:10-0600 [22611067]# wifi-check\nTesting Wi-Fi...\nDone: Success\n";
        parse_log_into_state(log, &mut state);
        let sid = state.system.as_ref().and_then(|s| s.sid.as_deref());
        assert_eq!(sid, Some("22611067"));
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

    #[test]
    fn ethernet_parse_scopes_to_eth_section_in_full_block() {
        let mut state = DiagnosticState::default();
        let log = r#"2026-04-08T09:54:01-0600 [45230110]# (
> echo "===== ETH DIAGNOSTICS START ====="
> ethernet-check
> ethtool eth0
> ip addr show eth0
> cat /proc/net/dev
> echo "===== ETH DIAGNOSTICS END ====="
> echo "===== WIFI DIAGNOSTICS START ====="
> wifi-check
> )
===== ETH DIAGNOSTICS START =====
Testing Ethernet...
Done: Failure: -65553: Network technology is not enabled
Settings for eth0:
        Link detected: no
2: eth0: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN group default qlen 1000
Inter-|   Receive                                                |  Transmit
  eth0:       0       0    0    0    0     0          0         0        0       0
===== ETH DIAGNOSTICS END =====
===== WIFI DIAGNOSTICS START =====
Testing Wi-Fi...
Internet reachability state: online
Done: Success
"#;

        parse_log_into_state(log, &mut state);
        let eth = state.ethernet.expect("ethernet should parse");
        assert_eq!(eth.check_result, "Failure: -65553: Network technology is not enabled");
        assert!(!eth.internet_reachable);
        assert_eq!(eth.link_detected, Some(false));
    }

    #[test]
    fn split_blocks_captures_orphan_output_chunk() {
        let log = "Testing Wi-Fi...\nInternet reachability state: online\nDone: Success\n";
        let blocks = split_blocks(log);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].command, "__orphan__");
        assert!(blocks[0].body.contains("Done: Success"));
    }

    #[test]
    fn parse_cellular_classifies_no_modem_from_quoted_ttyusb_error() {
        let block = r#"
===== CELLULAR CONNECTIVITY TEST =====
Testing Cellular...
Done: Failure: -65552: Network technology not available

===== INTERFACE / ROUTING =====
Device "wwan0" does not exist.

===== MODEM / RADIO DIAGNOSTICS =====
Running AT commands...
ERROR: device "/dev/ttyUSB2" does not exist
"#;
        let cell = parse_cellular(block);
        assert_eq!(cell.check_result, "Failure");
        assert_eq!(cell.modem_present, Some(false));
        assert_eq!(cell.status, crate::DiagStatus::Red);
        assert_eq!(cell.summary, "No modem detected");
    }

    #[test]
    fn parse_cellular_basic_info_ignores_raw_at_lines_for_apn_and_provider() {
        let block = r#"
===== CELLULAR CONNECTIVITY TEST =====
Internet reachability state: offline
Done: Failure: timeout

===== BASIC CELL INFO =====
868765071689128
89148000008543971083
311270028230364
311480
+CGPADDR: 1,0.0.0.0
registered
80
+QCSQ: "NOSERVICE"
"#;
        let cell = parse_cellular(block);
        assert_eq!(cell.basic_provider, None);
        assert_eq!(cell.basic_apn, None);
    }

    #[test]
    fn parse_cellular_basic_info_parses_keyed_fields() {
        let block = r#"
===== CELLULAR CONNECTIVITY TEST =====
Internet reachability state: online
Done: Success

===== BASIC CELL INFO =====
IMEI: 868765071689128
ICCID: 89148000008543971083
IMSI: 311270028230364
HNI: 311480
Provider: Verizon
Status: registered
Signal: 80
APN: vzwinternet
"#;
        let cell = parse_cellular(block);
        assert_eq!(cell.imei.as_deref(), Some("868765071689128"));
        assert_eq!(cell.basic_provider.as_deref(), Some("Verizon"));
        assert_eq!(cell.basic_apn.as_deref(), Some("vzwinternet"));
    }
}

// Parse all WiFi fields from a scoped WiFi section body (or any single wifi-related
// text block). Analogous to parse_cellular_block. Called both from the full-section
// path (text = extract_between result) and can be reused for partial blocks.
fn parse_wifi_section(text: &str, w: &mut WifiDiagnostic) {
    // wifi-check
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

    // wifi-signal
    if w.signal_dbm.is_none() {
        w.signal_dbm = parse_signal_dbm(text);
    }

    // iw dev / iw dev wlan0 info
    w.interface_exists = w.interface_exists || text.contains("Interface wlan0");
    w.interface_name = w.interface_name.clone().or_else(|| capture_after(text, "Interface"));
    w.mac_address = w.mac_address.clone().or_else(|| capture_after(text, "addr"));
    w.ssid = w.ssid.clone().or_else(|| capture_after(text, "ssid").filter(|s| !s.starts_with('=')));
    w.interface_type = w.interface_type.clone().or_else(|| capture_after(text, "type"));
    w.tx_power_dbm = w.tx_power_dbm.or_else(|| {
        capture_after(text, "txpower").and_then(|v| {
            v.split_whitespace()
                .next()
                .and_then(|n| n.parse::<f64>().ok())
        })
    });

    // iw dev wlan0 link
    if text.contains("Not connected") {
        w.connected = Some(false);
    } else if text.contains("Connected to ") {
        w.connected = Some(true);
        w.ap_bssid = extract_regex(text, r"Connected to ([0-9a-f:]{17})");
        w.ssid = w.ssid.clone().or_else(|| capture_after(text, "SSID:"));
        w.frequency_mhz = extract_regex(text, r"freq:\s*([0-9.]+)")
            .and_then(|v| v.parse::<f64>().ok())
            .map(|f| f.round() as u32);
        w.link_rx_bytes =
            extract_regex(text, r"RX:\s*(\d+)\s+bytes").and_then(|v| v.parse::<u64>().ok());
        w.link_rx_packets =
            extract_regex(text, r"RX:\s*\d+\s+bytes\s+\((\d+)\s+packets\)")
                .and_then(|v| v.parse::<u64>().ok());
        w.link_tx_bytes =
            extract_regex(text, r"TX:\s*(\d+)\s+bytes").and_then(|v| v.parse::<u64>().ok());
        w.link_tx_packets =
            extract_regex(text, r"TX:\s*\d+\s+bytes\s+\((\d+)\s+packets\)")
                .and_then(|v| v.parse::<u64>().ok());
        if w.signal_dbm.is_none() {
            w.signal_dbm =
                extract_regex(text, r"signal:\s*(-?\d+)\s*dBm").and_then(|v| v.parse::<i32>().ok());
        }
        w.tx_bitrate_mbps = extract_regex(text, r"tx bitrate:\s*([0-9.]+)\s*MBit/s")
            .and_then(|v| v.parse::<f64>().ok());
    }

    // iw dev wlan0 station dump
    w.station_signal_dbm = extract_regex(text, r"signal:\s*(-?\d+)\s*dBm")
        .and_then(|v| v.parse::<i32>().ok());
    w.station_tx_retries =
        extract_regex(text, r"tx retries:\s*(\d+)").and_then(|v| v.parse::<u64>().ok());
    w.station_tx_failed =
        extract_regex(text, r"tx failed:\s*(\d+)").and_then(|v| v.parse::<u64>().ok());
    w.station_tx_bitrate_mbps = extract_regex(text, r"tx bitrate:\s*([0-9.]+)\s*MBit/s")
        .and_then(|v| v.parse::<f64>().ok());

    // ip link show wlan0 — search for the interface line rather than blindly taking
    // the first line (which may be wifi-check output when parsing the full section).
    let iface_line = text
        .lines()
        .find(|l| l.contains("wlan0:") && l.contains('<'))
        .unwrap_or_default();
    w.lower_up_flag = Some(iface_line.contains("LOWER_UP"));
    if w.link_state.is_none() {
        w.link_state = extract_regex(iface_line, r"state\s+([A-Z]+)");
    }

    // ip addr show wlan0
    let re = Regex::new(r"inet\s+(\d+\.\d+\.\d+\.\d+)/(\d{1,2})").ok();
    if let Some(re) = re {
        if let Some(c) = re.captures(text) {
            w.ipv4_address = w
                .ipv4_address
                .clone()
                .or_else(|| c.get(1).map(|m| m.as_str().to_string()));
            w.ipv4_prefix = w.ipv4_prefix.or_else(|| {
                c.get(2).and_then(|m| m.as_str().parse::<u8>().ok())
            });
        }
    }

    // ip route
    if w.default_via_wlan0.is_none() {
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

    // connmanctl technologies
    let wifi_tech = extract_connman_tech(text, "wifi");
    if wifi_tech.is_some() {
        w.connman_wifi_powered = wifi_tech
            .as_deref()
            .and_then(|b| extract_regex(b, r"Powered = (True|False)"))
            .map(|v| v == "True");
        w.connman_wifi_connected = wifi_tech
            .as_deref()
            .and_then(|b| extract_regex(b, r"Connected = (True|False)"))
            .map(|v| v == "True");
        let eth_tech = extract_connman_tech(text, "ethernet");
        w.connman_eth_connected = eth_tech
            .as_deref()
            .and_then(|b| extract_regex(b, r"Connected = (True|False)"))
            .map(|v| v == "True");
        let cell_tech = extract_connman_tech(text, "cellular");
        w.connman_cell_connected = cell_tech
            .as_deref()
            .and_then(|b| extract_regex(b, r"Connected = (True|False)"))
            .map(|v| v == "True");
    }

    // connmanctl services
    if w.connman_wifi_active.is_none() {
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

    // connmanctl state
    if w.connman_state.is_none() {
        w.connman_state = extract_regex(text, r"State = (\w+)");
    }

    // ethtool -i wlan0
    if w.driver.is_none() {
        w.driver = capture_after(text, "driver:");
        w.driver_version = capture_after(text, "version:");
        w.bus_info = capture_after(text, "bus-info:");
    }

    // cat /proc/net/dev
    if w.proc_rx_bytes.is_none() {
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

    let wifi_block = find_latest_body_contains(
        latest,
        &[
            "===== wifi diagnostics start =====",
            "===== wifi diagnostics end =====",
        ],
    )
    .or_else(|| {
        find_latest_body_contains_any(
            latest,
            &[
                "===== wifi diagnostics start =====",
                "wifi-check",
                "wifi-signal",
                "iw dev wlan0",
            ],
        )
    });

    // When the full WiFi block ran (both START and END markers present), extract just
    // the WiFi section. This prevents ETH section "Done: Failure: -65553" and cellular
    // section output from contaminating WiFi field parsing when all sections run in the
    // same (…) subshell — which makes find_latest() return the entire combined body for
    // every command key lookup. Mirrors the parse_cellular_block() approach.
    if let Some(block) = wifi_block {
        let lower = block.to_ascii_lowercase();
        if lower.contains("===== wifi diagnostics start =====")
            && lower.contains("===== wifi diagnostics end =====")
        {
            if let Some(section) = extract_between(
                block,
                "===== WIFI DIAGNOSTICS START =====",
                "===== WIFI DIAGNOSTICS END =====",
            ) {
                parse_wifi_section(&section, &mut w);
                w.signal_dbm_trusted = w.connected == Some(true)
                    || w.connman_wifi_connected == Some(true)
                    || (w.check_result == "Success" && w.wifi_state == "online");
                determine_wifi_status(&mut w);
                return Some(w);
            }
        }
    }

    // Individual command lookup path: used when commands ran in separate shell blocks
    // (not wrapped in a (…) subshell). Each command has its own dedicated HashMap entry.
    let wifi_check = find_latest(latest, &["wifi-check", "wifi diagnostics"]).or(wifi_block);
    let wifi_signal = find_latest(latest, &["wifi-signal", "wifi diagnostics"]).or(wifi_block);
    let iw_dev = find_latest(latest, &["iw dev", "wifi diagnostics"]).or(wifi_block);
    let iw_info = find_latest(latest, &["iw dev wlan0 info", "wifi diagnostics"]).or(wifi_block);
    let iw_link = find_latest(latest, &["iw dev wlan0 link", "wifi diagnostics"]).or(wifi_block);
    let iw_station =
        find_latest(latest, &["iw dev wlan0 station dump", "wifi diagnostics"]).or(wifi_block);
    let ip_link = find_latest(latest, &["ip link show wlan0", "wifi diagnostics"]).or(wifi_block);
    let ip_addr = find_latest(latest, &["ip addr show wlan0", "wifi diagnostics"]).or(wifi_block);
    let ip_route = find_latest(latest, &["ip route", "wifi diagnostics"]).or(wifi_block);
    let conn_tech =
        find_latest(latest, &["connmanctl technologies", "wifi diagnostics"]).or(wifi_block);
    let conn_services =
        find_latest(latest, &["connmanctl services", "wifi diagnostics"]).or(wifi_block);
    let conn_state = find_latest(latest, &["connmanctl state", "wifi diagnostics"]).or(wifi_block);
    let ethtool_driver =
        find_latest(latest, &["ethtool -i wlan0", "wifi diagnostics"]).or(wifi_block);
    let proc_net = find_latest(latest, &["cat /proc/net/dev", "wifi diagnostics"]).or(wifi_block);

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
        w.ssid = capture_after(text, "ssid").filter(|s| !s.starts_with('='));
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
        w.ssid = w.ssid.or_else(|| capture_after(text, "ssid").filter(|s| !s.starts_with('=')));
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
    // Only set true for commands that are exclusively part of cellular diagnostic scripts.
    // Commands shared with WiFi (connmanctl, ip route, proc/net/dev, date/version/sid) must NOT
    // set this flag — the WiFi subshell creates a single block whose key contains those command
    // strings as substrings, causing find_latest() to return the WiFi block body.
    let mut has_cellular_specific = false;
    // When the full multi-section block is found (via body markers), all sections are parsed
    // correctly by parse_cellular_block using extract_between. Individual command lookups must be
    // SKIPPED in this case — they would all return the same full block body via substring key
    // matching, causing parse_single_value to return the last non-empty line of the entire output
    // (which can be garbage mid-stream), and parse_basic_cell_info's positional assignment would
    // write that garbage to IMEI, ICCID, APN, etc.
    let mut full_section_parsed = false;

    // One uniquely-cellular marker is sufficient. The previous 3-marker requirement created a
    // ~12-second window before "===== modem / radio diagnostics =====" appeared in the body,
    // during which individual command lookups ran and all returned the same full block body
    // via substring key matching. parse_single_value on that body returned the last non-empty
    // line (e.g. a /proc/net/dev "lo: 184779..." line), which parse_basic_cell_info then
    // positionally assigned to basic_provider (→ card title) and basic_apn.
    // With a single early marker, full_section_parsed triggers within ~0.5s and
    // parse_cellular_block safely handles missing later sections via extract_between.
    if let Some(block) = find_latest_body_contains(
        latest,
        &["===== cellular connectivity test ====="],
    ) {
        parse_cellular_block(block, &mut diag);
        has_cellular_specific = true;
        full_section_parsed = true;
    }

    if !full_section_parsed {
        // Individual command lookup path — used when commands ran separately (not in a subshell).
        // Each command has its own dedicated block with clean single-value output.
        if let Some(block) = find_latest(latest, &["run cellular diagnostics"]) {
            parse_cellular_block(block, &mut diag);
            has_cellular_specific = true;
        }

        // date/version/sid appear in many diagnostic runs — NOT cellular-specific
        if let Some(text) = find_latest(latest, &["date"]) {
            diag.controller_date = parse_single_value(Some(text)).or(diag.controller_date);
        }
        if let Some(text) = find_latest(latest, &["version"]) {
            diag.controller_version = parse_single_value(Some(text)).or(diag.controller_version);
        }
        if let Some(text) = find_latest(latest, &["sid"]) {
            diag.controller_sid = parse_single_value(Some(text)).or(diag.controller_sid);
        }
        if let Some(text) = find_latest(latest, &["cellular-check"]) {
            parse_cellular_check_text(text, &mut diag);
            has_cellular_specific = true;
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
                has_cellular_specific = true;
                if let Some(v) = parse_single_value(Some(text)) {
                    basic_lines.push(v);
                }
            }
        }
        if !basic_lines.is_empty() {
            parse_basic_cell_info(&basic_lines.join("\n"), &mut diag);
        }
        // connmanctl commands appear in the WiFi subshell key as substrings — NOT cellular-specific
        if let Some(text) = find_latest(latest, &["connmanctl technologies"]) {
            parse_connman_cellular(text, &mut diag);
        }
        if let Some(text) = find_latest(latest, &["connmanctl services"]) {
            parse_connman_cellular(text, &mut diag);
        }
        if let Some(text) = find_latest(latest, &["connmanctl state"]) {
            parse_connman_cellular(text, &mut diag);
        }
        // ip/wwan/proc commands also appear in WiFi subshell — NOT cellular-specific
        if let Some(text) = find_latest(latest, &["ip link show wwan0"]) {
            parse_wwan_interface(text, &mut diag);
        }
        if let Some(text) = find_latest(latest, &["ip addr show wwan0"]) {
            parse_wwan_interface(text, &mut diag);
        }
        if let Some(text) = find_latest(latest, &["ip route"]) {
            parse_wwan_interface(text, &mut diag);
        }
        if let Some(text) = find_latest(latest, &["cat /proc/net/dev"]) {
            parse_proc_net_dev(text, &mut diag);
        }
        if let Some(text) = find_latest(latest, &["cell-support --no-ofono --at"]) {
            parse_cell_support_at(text, &mut diag);
            has_cellular_specific = true;
        }
    }

    // Only return a cellular struct when at least one cellular-specific command ran.
    // Returning None here prevents a WiFi-only run from populating the cellular card
    // with connman/routing data found as key substrings of the WiFi subshell block.
    if !has_cellular_specific {
        return None;
    }
    // full_block_run = true when the big section-based subshell ran (full_section_parsed)
    // OR when cell-support --no-ofono --at was run as a standalone command.
    diag.full_block_run = full_section_parsed || latest.contains_key("cell-support --no-ofono --at");
    compute_cellular_flags(&mut diag);
    determine_cellular_status(&mut diag);
    Some(diag)
}

pub fn parse_cellular(block: &str) -> CellularDiagnostic {
    let mut diag = default_cellular();
    parse_cellular_block(block, &mut diag);
    compute_cellular_flags(&mut diag);
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
        full_block_run: false,
        modem_not_present: false,
        modem_unreachable: false,
        setup_attempted: false,
        setup_timed_out: false,
        at_interface_failed: None,
        cellular_disabled: false,
        no_service: false,
        sim_present: false,
    }
}

pub fn parse_satellite(block: &str) -> SatelliteDiagnostic {
    let mut diag = SatelliteDiagnostic {
        status: DiagStatus::Unknown,
        summary: "Incomplete data".into(),
        controller_sid: None,
        controller_version: None,
        controller_date: None,
        sat_imei: None,
        modem_present: None,
        connman_state: None,
        connman_eth_connected: None,
        connman_wifi_connected: None,
        connman_cell_connected: None,
        connman_active_service: None,
        default_gateway: None,
        default_via_eth0: None,
        default_via_wlan0: None,
        default_via_wwan0: None,
        satellites_seen: None,
        light_test_ran: false,
        light_test_success: None,
        light_test_timeout: None,
        light_test_blocked_in_use: None,
        light_test_error: None,
        loopback_test_ran: false,
        loopback_test_success: None,
        loopback_test_timeout: None,
        loopback_test_blocked_in_use: None,
        loopback_test_error: None,
        station_sent_epoch: None,
        server_sent_epoch: None,
        current_epoch: None,
        total_time_seconds: None,
        recommended_action: None,
        other_actions: vec![],
    };

    parse_satellite_controller_info(block, &mut diag);
    parse_satellite_imei(block, &mut diag);
    parse_satellite_connman_context(block, &mut diag);
    parse_satellite_routing_context(block, &mut diag);
    parse_satellite_check(block, &mut diag);
    determine_satellite_status(&mut diag);
    diag
}

fn parse_satellite_controller_info(text: &str, diag: &mut SatelliteDiagnostic) {
    for line in text.lines() {
        let value = line.trim();
        if value.is_empty() {
            continue;
        }
        if diag.controller_date.is_none()
            && (value.contains("UTC") || value.contains(" GMT") || value.contains(" CST"))
        {
            diag.controller_date = Some(value.to_string());
            continue;
        }
        if diag.controller_version.is_none() && (value.starts_with('r') || value.contains('.')) {
            diag.controller_version = Some(value.to_string());
            continue;
        }
        if diag.controller_sid.is_none() && value.chars().all(|c| c.is_ascii_digit()) {
            diag.controller_sid = Some(value.to_string());
        }
    }
}

fn parse_satellite_imei(text: &str, diag: &mut SatelliteDiagnostic) {
    if let Ok(imei_re) = Regex::new(r"\b\d{14,17}\b") {
        if let Some(cap) = imei_re.find(text) {
            diag.sat_imei = Some(cap.as_str().to_string());
            diag.modem_present = Some(true);
        }
    }
}

fn parse_satellite_connman_context(text: &str, diag: &mut SatelliteDiagnostic) {
    if let Some(block) = extract_connman_tech(text, "ethernet") {
        diag.connman_eth_connected =
            extract_regex(&block, r"Connected = (True|False)").map(|v| v == "True");
    }
    if let Some(block) = extract_connman_tech(text, "wifi") {
        diag.connman_wifi_connected =
            extract_regex(&block, r"Connected = (True|False)").map(|v| v == "True");
    }
    if let Some(block) = extract_connman_tech(text, "cellular") {
        diag.connman_cell_connected =
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
                diag.connman_active_service = Some(svc);
            }
        }
        if let Some(state) = trimmed.strip_prefix("State =") {
            diag.connman_state = Some(state.trim().to_string());
        }
    }
}

fn parse_satellite_routing_context(text: &str, diag: &mut SatelliteDiagnostic) {
    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("default via ") {
            continue;
        }
        if let Some(gw) = extract_regex(trimmed, r"default via (\S+)") {
            if diag.default_gateway.is_none() {
                diag.default_gateway = Some(gw.clone());
            }
            if trimmed.contains(" dev eth0") {
                diag.default_via_eth0 = Some(true);
                diag.default_gateway = Some(gw.clone());
            } else {
                diag.default_via_eth0.get_or_insert(false);
            }
            if trimmed.contains(" dev wlan0") {
                diag.default_via_wlan0 = Some(true);
                diag.default_gateway = Some(gw.clone());
            } else {
                diag.default_via_wlan0.get_or_insert(false);
            }
            if trimmed.contains(" dev wwan0") {
                diag.default_via_wwan0 = Some(true);
                diag.default_gateway = Some(gw.clone());
            } else {
                diag.default_via_wwan0.get_or_insert(false);
            }
        }
    }
}

fn parse_satellite_check(text: &str, diag: &mut SatelliteDiagnostic) {
    let lower = text.to_ascii_lowercase();
    let looks_like_loopback = lower.contains("satellite loopback test")
        || lower.contains("satellite-check -t")
        || lower.contains("loopback test");
    let has_success_marker =
        lower.contains("test completed") || lower.contains("received satellite ping response");
    let blocked_in_use = lower.contains("network service is in use by another resource")
        || lower.contains("(-65555)");
    let timeout_like = lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("deadline exceeded");

    if blocked_in_use {
        if looks_like_loopback {
            diag.loopback_test_ran = true;
            diag.loopback_test_success = Some(false);
            diag.loopback_test_blocked_in_use = Some(true);
            diag.loopback_test_error = Some(extract_last_non_empty_line(text));
        } else {
            diag.light_test_ran = true;
            diag.light_test_success = Some(false);
            diag.light_test_blocked_in_use = Some(true);
            diag.light_test_error = Some(extract_last_non_empty_line(text));
        }
        return;
    }

    if looks_like_loopback {
        diag.loopback_test_ran = true;
        if has_success_marker {
            diag.loopback_test_success = Some(true);
        } else if lower.contains("fail") || lower.contains("error") || timeout_like {
            diag.loopback_test_success = Some(false);
            if timeout_like {
                diag.loopback_test_timeout = Some(true);
            }
            diag.loopback_test_error = Some(extract_last_non_empty_line(text));
        }
        diag.station_sent_epoch =
            extract_regex(text, r"time station sent ping:\s*(\d+)").and_then(|v| v.parse().ok());
        diag.server_sent_epoch = extract_regex(text, r"time server sent ping response:\s*(\d+)")
            .and_then(|v| v.parse().ok());
        diag.current_epoch =
            extract_regex(text, r"current time:\s*(\d+)").and_then(|v| v.parse().ok());
        diag.total_time_seconds =
            extract_regex(text, r"total time:\s*(\d+)").and_then(|v| v.parse().ok());
    }

    let has_light_command = lower.contains("satellite-check -c 1 -w 1")
        || lower.contains("satellite-check -c 1 -w 1 -v")
        || lower.contains("quick satellite check");
    if has_light_command || (!looks_like_loopback && lower.contains("satellite-check")) {
        diag.light_test_ran = true;
        if has_success_marker {
            diag.light_test_success = Some(true);
        } else if lower.contains("fail") || lower.contains("error") || timeout_like {
            diag.light_test_success = Some(false);
            if timeout_like {
                diag.light_test_timeout = Some(true);
            }
            diag.light_test_error = Some(extract_last_non_empty_line(text));
        }
    }
}

fn determine_satellite_status(diag: &mut SatelliteDiagnostic) {
    if diag.modem_present == Some(false) {
        diag.status = DiagStatus::Red;
        diag.summary = "No satellite modem detected".into();
        diag.recommended_action = Some("Check satellite modem / hardware connection".into());
        diag.other_actions = vec!["Reboot controller".into()];
        return;
    }

    if diag.loopback_test_ran && diag.loopback_test_success == Some(false) {
        if diag.loopback_test_blocked_in_use == Some(true) {
            diag.status = DiagStatus::Orange;
            diag.summary = "Satellite test blocked — service in use".into();
            diag.recommended_action = Some("Retry when satellite service is not in use".into());
            diag.other_actions = vec![];
            return;
        }

        diag.status = DiagStatus::Red;
        diag.summary = "Satellite communication failed".into();
        diag.recommended_action = Some("Check antenna placement and provisioning".into());
        diag.other_actions = vec![
            "Move antenna to clear sky".into(),
            "Retry loopback test".into(),
        ];
        return;
    }

    if let Some(seen) = diag.satellites_seen {
        if seen <= 0.0 {
            diag.status = DiagStatus::Red;
            diag.summary = "No satellites visible".into();
            diag.recommended_action = Some("Check antenna placement and connection".into());
            diag.other_actions = vec![
                "Move antenna to clear sky".into(),
                "Retry quick satellite check".into(),
            ];
            return;
        }
    }

    if diag.loopback_test_ran && diag.loopback_test_success == Some(true) {
        diag.status = DiagStatus::Green;
        diag.summary = "Satellite link verified".into();
        diag.recommended_action = None;
        diag.other_actions = vec![];
        return;
    }

    if diag.light_test_ran && diag.light_test_success == Some(true) {
        diag.status = DiagStatus::Green;
        diag.summary = "Satellite check passed".into();
        diag.recommended_action = None;
        diag.other_actions = vec![];
        return;
    }

    if diag.light_test_ran
        && diag.light_test_success == Some(false)
        && !diag.light_test_blocked_in_use.unwrap_or(false)
    {
        diag.status = DiagStatus::Red;
        diag.summary = "Satellite quick check failed".into();
        diag.recommended_action = Some("Run full loopback test for details".into());
        diag.other_actions = vec![];
        return;
    }

    if diag.modem_present == Some(true) {
        diag.status = DiagStatus::Grey;
        diag.summary = "Satellite not validated".into();
        diag.recommended_action = Some("Run full satellite loopback test".into());
        diag.other_actions = vec![];
        return;
    }

    diag.status = DiagStatus::Unknown;
    diag.summary = "Incomplete data".into();
}

fn extract_last_non_empty_line(text: &str) -> String {
    text.lines()
        .rev()
        .find_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
        .unwrap_or_else(|| "Satellite check failed".to_string())
}

fn parse_ethernet(
    ethernet_check: Option<&String>,
    ethtool: Option<&String>,
    interface_info: Option<&String>,
    proc_net_dev: Option<&String>,
    operstate: Option<&String>,
    full_block_run: bool,
    ethernet_diag_attempted: bool,
) -> Option<EthernetDiagnostic> {
    if ethernet_check.is_none()
        && ethtool.is_none()
        && interface_info.is_none()
        && proc_net_dev.is_none()
        && operstate.is_none()
    {
        return None;
    }

    let ethernet_check_scoped = ethernet_check.map(|b| extract_eth_diagnostics_section(b));
    let ethtool_scoped = ethtool.map(|b| extract_eth_diagnostics_section(b));
    let interface_info_scoped = interface_info.map(|b| extract_eth_diagnostics_section(b));
    let proc_net_dev_scoped = proc_net_dev.map(|b| extract_eth_diagnostics_section(b));
    let operstate_scoped = operstate.map(|b| extract_eth_diagnostics_section(b));

    let internet_reachable = ethernet_check_scoped
        .and_then(|b| capture_after(b, "Internet reachability state:"))
        .map(|s| s.eq_ignore_ascii_case("online"))
        .unwrap_or(false);
    const KNOWN_ETH_STATES: &[&str] = &[
        "up", "down", "dormant", "lowerlayerdown", "notpresent",
        "unknown", "idle", "failure", "association", "configuration",
        "ready", "online", "disconnect",
    ];
    let eth_state = ethernet_check_scoped
        .and_then(|b| capture_after(b, "Ethernet state:"))
        .or_else(|| {
            operstate_scoped.and_then(parse_single_value_str).filter(|s| {
                let lower = s.to_ascii_lowercase();
                KNOWN_ETH_STATES.iter().any(|&known| lower == known)
            })
        })
        .unwrap_or_else(|| "unknown".into());
    let ipv4 = ethernet_check_scoped
        .and_then(|b| capture_after(b, "Ethernet supports IPv4?"))
        .map(|v| parse_yes_no(Some(v)))
        .unwrap_or(false);
    let ipv6 = ethernet_check_scoped
        .and_then(|b| capture_after(b, "Ethernet supports IPv6?"))
        .map(|v| parse_yes_no(Some(v)))
        .unwrap_or(false);
    let dns_servers = ethernet_check_scoped
        .and_then(|b| capture_after(b, "Ethernet name servers:"))
        .unwrap_or_else(|| "—".into());
    let check_result = ethernet_check_scoped
        .and_then(|b| capture_after(b, "Done:"))
        .unwrap_or_else(|| "Unknown".into());

    let speed = ethtool_scoped.and_then(|b| capture_after(b, "Speed:"));
    let duplex = ethtool_scoped.and_then(|b| capture_after(b, "Duplex:"));
    let link_detected = ethtool_scoped
        .and_then(|b| capture_after(b, "Link detected:"))
        .map(|s| s.eq_ignore_ascii_case("yes"));

    let ip_address = interface_info_scoped.and_then(parse_interface_ip);
    let netmask = interface_info_scoped.and_then(parse_interface_netmask);
    let rx_errors = proc_net_dev_scoped
        .and_then(parse_proc_net_dev_stats)
        .map(|(rx_err, _, _)| rx_err)
        .unwrap_or(0);
    let tx_errors = proc_net_dev_scoped
        .and_then(parse_proc_net_dev_stats)
        .map(|(_, tx_err, _)| tx_err)
        .unwrap_or(0);
    let rx_dropped = proc_net_dev_scoped
        .and_then(parse_proc_net_dev_stats)
        .map(|(_, _, rx_drop)| rx_drop)
        .unwrap_or(0);

    let check_failed = check_result.to_ascii_lowercase().starts_with("failure");
    let status = if link_detected == Some(false) {
        DiagStatus::Unknown
    } else if check_failed || (!internet_reachable && check_result != "Unknown") {
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
        full_block_run,
        ethernet_diag_attempted,
    })
}

fn extract_eth_diagnostics_section(text: &str) -> &str {
    let lower = text.to_ascii_lowercase();
    let start_marker = "===== eth diagnostics start =====";
    let end_marker = "===== eth diagnostics end =====";
    let Some(start_idx) = lower.find(start_marker) else {
        return text;
    };
    let end_idx = lower[start_idx..]
        .find(end_marker)
        .map(|offset| start_idx + offset + end_marker.len())
        .unwrap_or(text.len());
    &text[start_idx..end_idx]
}

fn parse_system(
    sid_block: Option<&String>,
    version_block: Option<&String>,
    release_block: Option<&String>,
) -> SystemDiagnostic {
    let sid = parse_single_value(sid_block).and_then(|v| sanitize_sid(&v));
    let version = parse_single_value(version_block).and_then(|v| sanitize_version(&v));
    let release_date = release_block.and_then(|b| capture_after(b, "Date:"));

    SystemDiagnostic {
        sid,
        version,
        release_date,
    }
}

fn sanitize_sid(input: &str) -> Option<String> {
    let clean = input.trim();
    if clean.len() == 8 && clean.chars().all(|c| c.is_ascii_digit()) {
        Some(clean.to_string())
    } else {
        None
    }
}

fn sanitize_version(input: &str) -> Option<String> {
    let clean = input.trim();
    let re = Regex::new(r"^r\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9._-]+)?$").ok()?;
    if re.is_match(clean) {
        Some(clean.to_string())
    } else {
        None
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

    // FAST PATH: frontline check confirmed live internet connectivity.
    // Skip raw interface state checks (iw/ip data may be stale or from a different moment).
    // Only apply quality-of-link checks (signal + packet loss) which come from the same run.
    if diag.check_result == "Success" && diag.internet_reachable {
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
        if diag.check_packet_loss_pct >= 20 || diag.station_tx_failed.unwrap_or(0) >= 5 {
            let ssid = diag
                .ssid
                .clone()
                .or(diag.access_point.clone())
                .unwrap_or_else(|| "Wi-Fi".into());
            diag.status = DiagStatus::Orange;
            diag.summary = format!("{ssid} · unstable link");
            return;
        }
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

    // Slow path: check failed or unknown — fall back to raw interface state
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

fn parse_single_value_str(text: &str) -> Option<String> {
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

fn parse_interface_ip(text: &str) -> Option<String> {
    let re = Regex::new(r"inet\s+(\d+\.\d+\.\d+\.\d+)").ok()?;
    re.captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

fn parse_interface_netmask(text: &str) -> Option<String> {
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

fn parse_proc_net_dev_stats(text: &str) -> Option<(u64, u64, u64)> {
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
        .filter(|l| !l.is_empty() && !l.starts_with("====="))
        .collect();
    if lines.is_empty() {
        return;
    }
    let mut keyed = false;
    for line in &lines {
        let lower = line.to_ascii_lowercase();
        let value = line.split_once(':').map(|(_, rhs)| rhs.trim().to_string());
        if lower.starts_with("imei:") {
            diag.imei = diag
                .imei
                .clone()
                .or_else(|| value.and_then(clean_cell_display_value));
            keyed = true;
        } else if lower.starts_with("iccid:") || lower.starts_with("ccid:") {
            diag.iccid = diag
                .iccid
                .clone()
                .or_else(|| value.and_then(clean_cell_display_value));
            keyed = true;
        } else if lower.starts_with("imsi:") {
            diag.imsi = diag
                .imsi
                .clone()
                .or_else(|| value.and_then(clean_cell_display_value));
            keyed = true;
        } else if lower.starts_with("hni:") {
            diag.hni = diag
                .hni
                .clone()
                .or_else(|| value.and_then(clean_cell_display_value));
            keyed = true;
        } else if lower.starts_with("provider:") {
            diag.basic_provider = diag
                .basic_provider
                .clone()
                .or_else(|| value.and_then(clean_cell_display_value));
            keyed = true;
        } else if lower.starts_with("status:") {
            diag.basic_status = diag
                .basic_status
                .clone()
                .or_else(|| value.and_then(clean_cell_display_value));
            keyed = true;
        } else if lower.starts_with("signal:") {
            diag.basic_signal = diag
                .basic_signal
                .clone()
                .or_else(|| value.and_then(clean_cell_display_value));
            keyed = true;
        } else if lower.starts_with("apn:") {
            diag.basic_apn = diag
                .basic_apn
                .clone()
                .or_else(|| value.and_then(clean_cell_display_value));
            keyed = true;
        }
    }

    if keyed {
        return;
    }

    let mut vals: Vec<Option<String>> = vec![None; 8];
    for (i, line) in lines.iter().take(8).enumerate() {
        if !line.to_ascii_lowercase().starts_with("error:") {
            vals[i] = clean_cell_display_value(line.to_string());
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

fn clean_cell_display_value(value: String) -> Option<String> {
    let trimmed = value
        .trim()
        .trim_matches('"')
        .trim_end_matches(',')
        .trim()
        .to_string();
    if trimmed.is_empty() {
        return None;
    }
    // Reject multi-token garbage: /proc/net/dev lines have 17 tokens, ICMP lines have 10+.
    // Valid cell values (APN, carrier name, IMEI, ICCID, status) are all 1–3 tokens.
    if trimmed.split_whitespace().count() > 3 {
        return None;
    }
    let upper = trimmed.to_ascii_uppercase();
    if upper == "0.0.0.0" || upper == "—" || upper == "-" {
        return None;
    }
    if upper.starts_with('+')
        || upper.starts_with("ERROR")
        || upper.contains("CGPADDR")
        || upper.contains("CGACT")
        || upper.contains("QCSQ")
    {
        return None;
    }
    Some(trimmed)
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
    if text.contains("/dev/ttyUSB2 does not exist")
        || (text.contains("/dev/ttyUSB2") && text.contains("does not exist"))
    {
        diag.modem_present = Some(false);
    }
    // "Running AT commands... Failed" — AT interface is dead
    if text.contains("Running AT commands") && text.contains("Failed") {
        diag.at_interface_failed = Some(true);
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
    // +CGCONTRDP: <cid>,<bearer_id>,<APN>[,<local_addr>[,<subnet>[,<gw>[,<dns_prim>...]]]]
    // Capture field 3 (APN name) directly — previous regex counted too many commas and
    // captured the gateway/DNS IP in field 6 instead of the APN in field 3.
    diag.at_apn = extract_regex(text, r"\+CGCONTRDP:\s*\d+,\s*\d+,\s*([^,\s]+)")
        .filter(|s| !s.is_empty() && s != "0.0.0.0");
}

fn parse_cops_scan(line: &str) -> Vec<CopsNetwork> {
    let mut networks = Vec::new();
    let re = match Regex::new(r#"\((\d+),"([^"]*?)","([^"]*?)","(\d+)",(\d+)\)"#) {
        Ok(r) => r,
        Err(_) => return networks,
    };
    for cap in re.captures_iter(line) {
        let numeric = cap[4].to_string();
        let resolved_name = resolve_carrier(&numeric);
        networks.push(CopsNetwork {
            stat: cap[1].parse().unwrap_or(0),
            long_name: cap[2].to_string(),
            numeric,
            act: cap[5].parse().unwrap_or(0),
            resolved_name,
        });
    }
    networks
}

fn resolve_carrier(code: &str) -> String {
    match code {
        "311270" | "311271" | "311272" | "311273" | "311274" | "311275" |
        "311276" | "311277" | "311278" | "311279" | "311280" | "311480" |
        "311481" | "311482" | "311483" | "311484" | "311485" | "311486" |
        "311487" | "311488" | "311489" => "Verizon".into(),
        "310260" | "310026" | "310490" | "310660" | "312250" | "310230" |
        "310240" | "310250" => "T-Mobile".into(),
        "310410" | "310380" | "310980" | "311180" | "310030" | "310560" |
        "310680" => "AT&T".into(),
        "313100" => "FirstNet (AT&T — restricted)".into(),
        "310000" => "Dish".into(),
        _ => format!("Carrier ({})", code),
    }
}

pub fn parse_sim_picker(block: &str) -> SimPickerDiagnostic {
    let mut diag = SimPickerDiagnostic::default();
    diag.full_block_run = block.to_ascii_lowercase().contains("sim picker start");
    parse_installed_sim(block, &mut diag);
    determine_scan_outcome(block, &mut diag);
    // nwscanmode: +QCFG: "nwscanmode",N
    diag.nwscanmode = Regex::new(r#"\+QCFG:\s*"nwscanmode",(\d+)"#)
        .ok()
        .and_then(|re| re.captures(block))
        .and_then(|cap| cap[1].parse::<u8>().ok());
    // +QCSQ: "CAT-M1",-62,-91,107,-13  → cap[2] is RSRP
    diag.qcsq_rsrp = Regex::new(r#"\+QCSQ:\s*"[^"]+",(-?\d+),(-?\d+)"#)
        .ok()
        .and_then(|re| re.captures(block))
        .and_then(|cap| cap[2].parse::<i32>().ok());
    // +QNWINFO: "CAT-M1","311480","LTE BAND 13",5230 → cap[1] is registered MCC-MNC
    diag.current_registered_code = Regex::new(r#"\+QNWINFO:\s*"[^"]+","(\d{5,6})""#)
        .ok()
        .and_then(|re| re.captures(block))
        .map(|cap| cap[1].to_string());
    determine_recommendation(&mut diag);
    diag
}

fn parse_installed_sim(at_block: &str, diag: &mut SimPickerDiagnostic) {
    // ICCID from +QCCID: 89148000008235254186
    if let Some(iccid) = extract_regex(at_block, r"\+QCCID:\s*(\d{15,20})") {
        diag.installed_iccid = Some(iccid);
    }
    // IMSI — 15-digit number starting with 3, appears alone on a line
    if let Some(imsi) = extract_regex(at_block, r"(?m)^(3\d{14})$") {
        let carrier_code = imsi[..imsi.len().min(6)].to_string();
        let carrier_name = resolve_carrier(&carrier_code);
        diag.installed_imsi = Some(imsi);
        diag.installed_carrier_code = Some(carrier_code);
        diag.installed_carrier_name = Some(carrier_name);
    }
}

fn determine_scan_outcome(at_block: &str, diag: &mut SimPickerDiagnostic) {
    diag.scan_attempted = at_block.contains("Scanning...");

    if at_block.contains("CME ERROR: operation not allowed") {
        diag.scan_failed = true;
        diag.scan_completed = false;
        return;
    }

    for line in at_block.lines() {
        if line.starts_with("+COPS:") && line.contains('"') {
            let networks = parse_cops_scan(line);
            if !networks.is_empty() {
                diag.detected_networks = networks;
                diag.scan_completed = true;
                diag.scan_empty = false;
                return;
            }
        }
    }

    if diag.scan_attempted {
        diag.scan_completed = true;
        diag.scan_empty = true;
    }
}

fn determine_recommendation(diag: &mut SimPickerDiagnostic) {
    if !diag.scan_attempted {
        diag.recommendation = SimPickerRecommendation::NotRun;
        diag.recommendation_detail = "Run the SIM Picker scan to check available carriers.".into();
        return;
    }

    if diag.scan_failed {
        diag.recommendation = SimPickerRecommendation::ScanFailed;
        diag.recommendation_detail = if diag.nwscanmode == Some(1) {
            "Modem locked to LTE-only mode. Run setup-cellular to reset scan mode, then retry.".into()
        } else {
            "Network scan failed. Reboot controller and try again.".into()
        };
        return;
    }

    if diag.scan_empty {
        diag.recommendation = SimPickerRecommendation::DeadZone;
        diag.recommendation_detail =
            "No carriers detected at this location. No SIM will provide service here. Check antenna placement and sky view.".into();
        return;
    }

    let installed_code = diag.installed_carrier_code.clone().unwrap_or_default();
    let installed_name = resolve_carrier(&installed_code);

    // Find the installed carrier's entry in scan results
    let installed_network = diag.detected_networks.iter()
        .find(|n| resolve_carrier(&n.numeric) == installed_name)
        .cloned();

    let installed_stat = installed_network.as_ref().map(|n| n.stat);

    // +QNWINFO gives the currently registered MCC-MNC, which is authoritative even when
    // the carrier doesn't appear in +COPS=? scan results (e.g., truncated output or
    // scan while already locked to a network). If it resolves to the installed carrier,
    // treat as if stat=2 (currently connected).
    let currently_on_installed = diag.current_registered_code.as_deref()
        .map(|code| resolve_carrier(code) == installed_name)
        .unwrap_or(false);

    diag.installed_carrier_detected = installed_stat.is_some() || currently_on_installed;

    // stat=2 means actively connected; currently_on_installed is equivalent evidence.
    // Combined with good signal (RSRP > -100 dBm, or unknown), never recommend a swap.
    if installed_stat == Some(2) || currently_on_installed {
        let strong = diag.qcsq_rsrp.map(|r| r > -100).unwrap_or(true);
        if strong {
            diag.recommendation = SimPickerRecommendation::KeepCurrent;
            diag.recommendation_detail = format!(
                "{} is connected and has good signal at this location. No SIM change needed.",
                diag.installed_carrier_name.as_deref().unwrap_or(&installed_name)
            );
            return;
        }
        // Connected but weak — fall through to check alternatives
    }

    // Valid alternatives: exclude the installed carrier and restricted networks
    let valid_alts: Vec<&CopsNetwork> = diag.detected_networks.iter()
        .filter(|n| {
            resolve_carrier(&n.numeric) != installed_name
                && n.numeric != "313100" // FirstNet — restricted public safety network
        })
        .collect();

    // Best alternative: prefer stat=1 (available) over stat=3 (detected/wrong SIM)
    let best_alt = valid_alts.iter()
        .min_by_key(|n| match n.stat { 1 => 0, 3 => 1, 0 => 2, _ => 3 })
        .copied()
        .cloned();

    if !diag.installed_carrier_detected {
        // Installed carrier not visible at all
        if let Some(ref alt) = best_alt {
            diag.recommendation = SimPickerRecommendation::SwapTo(alt.resolved_name.clone());
            diag.best_network_code = Some(alt.numeric.clone());
            diag.best_network_name = Some(alt.resolved_name.clone());
            diag.recommendation_detail = format!(
                "{} not detected. {} is {} at this location — install {} SIM.",
                diag.installed_carrier_name.as_deref().unwrap_or("Installed carrier"),
                alt.resolved_name,
                if alt.stat == 1 { "available" } else { "detectable" },
                alt.resolved_name,
            );
        } else {
            diag.recommendation = SimPickerRecommendation::DeadZone;
            diag.recommendation_detail = format!(
                "{} not detected and no valid alternatives found. Check antenna.",
                diag.installed_carrier_name.as_deref().unwrap_or("Installed carrier")
            );
        }
        return;
    }

    // Installed carrier detected (stat=3 or stat=0) but not actively connected
    if let Some(ref alt) = best_alt {
        if alt.stat == 1 {
            diag.recommendation = SimPickerRecommendation::SwapTo(alt.resolved_name.clone());
            diag.best_network_code = Some(alt.numeric.clone());
            diag.best_network_name = Some(alt.resolved_name.clone());
            diag.recommendation_detail = format!(
                "{} detected but not connected. {} is available — may provide better service.",
                diag.installed_carrier_name.as_deref().unwrap_or("Installed carrier"),
                alt.resolved_name,
            );
            return;
        }
    }

    diag.recommendation = SimPickerRecommendation::KeepCurrent;
    diag.recommendation_detail = if best_alt.is_none() {
        format!(
            "{} is the only carrier detected at this location.",
            diag.installed_carrier_name.as_deref().unwrap_or("Installed carrier")
        )
    } else {
        format!(
            "{} is detected at this location. No clearly better alternative found.",
            diag.installed_carrier_name.as_deref().unwrap_or("Installed carrier")
        )
    };
}


/// Pre-compute boolean flag fields from raw parsed data.
/// Must be called before determine_cellular_status.
fn compute_cellular_flags(diag: &mut CellularDiagnostic) {
    diag.modem_not_present =
        diag.check_error.as_deref().map(|e| e.contains("-65552")).unwrap_or(false)
        && (diag.modem_present == Some(false) || !diag.wwan_exists);

    diag.cellular_disabled =
        diag.connman_cell_powered == Some(false)
        || diag.check_error.as_deref().map(|e| e.contains("-65553")).unwrap_or(false)
        || (diag.cfun == Some(0)
            && diag.sim_inserted == Some(true)
            && diag.modem_present == Some(true)
            && diag.check_error.is_some());

    diag.no_service =
        diag.modem_present == Some(true)
        && (diag.registered == Some(false)
            || diag.qcsq.as_deref() == Some("NOSERVICE"));

    diag.sim_present = diag.sim_inserted == Some(true);
}

/// Scan the full log (not just the cellular block) for setup-cellular events,
/// which are emitted outside standard command blocks as interactive output.
fn detect_setup_cellular_events(log: &str, diag: &mut CellularDiagnostic) {
    if log.contains("setup-cellular") {
        diag.setup_attempted = true;
    }
    if log.contains("Failed to connect to Cellular network")
        && log.contains("connection timed out")
    {
        diag.setup_timed_out = true;
    }
}

fn determine_cellular_status(diag: &mut CellularDiagnostic) {
    // 1. Hardware not present at all
    if diag.modem_not_present {
        diag.status = DiagStatus::Unknown;
        diag.summary = "No modem detected".into();
        diag.recommended_action = Some("Check modem connection and seating".into());
        diag.other_actions = vec![
            "Reboot controller".into(),
            "Check modem hardware".into(),
        ];
        return;
    }

    // 2. Hardware visible but AT interface dead / setup timed out
    //    This is RED — setup was attempted and failed
    if diag.modem_unreachable {
        diag.status = DiagStatus::Red;
        diag.summary = "Cellular hardware not responding".into();
        diag.recommended_action = Some(
            "Reboot controller — modem AT interface not responding".into(),
        );
        diag.other_actions = vec![
            "Reboot usually resolves without physical intervention".into(),
            "Reseat modem if reboot does not resolve".into(),
            "Check firmware version after reboot".into(),
        ];
        return;
    }

    // 3. Cellular intentionally disabled (never tried to enable)
    if diag.cellular_disabled {
        diag.status = DiagStatus::Unknown;
        let imei_note = if diag.imei.is_some() { " (modem detected)" } else { "" };
        diag.summary = format!("Cellular disabled{}", imei_note);
        diag.recommended_action = Some("Enable via setup-cellular".into());
        diag.other_actions = vec![];
        return;
    }

    // FAST PATH: frontline check confirmed live cellular internet.
    // Skip AT-state checks (no_service, registered) — they may reflect stale modem state.
    if diag.check_result == "Success" && diag.internet_reachable {
        let provider = diag
            .operator_name
            .as_deref()
            .or(diag.basic_provider.as_deref())
            .or(diag.provider_code.as_deref())
            .unwrap_or("Unknown");
        let strength = diag.strength_score.unwrap_or(0);
        let label = diag.strength_label.as_deref().unwrap_or("");
        if strength >= 60 {
            diag.status = DiagStatus::Green;
            diag.summary = format!("{} · {}/100 · {}", provider, strength, label);
        } else if strength >= 40 {
            diag.status = DiagStatus::Orange;
            diag.summary = format!("{} · {}/100 · weak signal", provider, strength);
            diag.recommended_action = Some("Check antenna connection and placement".into());
        } else {
            diag.status = DiagStatus::Red;
            diag.summary = format!("{} · {}/100 · signal too weak", provider, strength);
            diag.recommended_action = Some("Check antenna — signal critically low".into());
        }
        return;
    }

    // 4. No service — modem powered, searching
    if diag.no_service {
        diag.status = DiagStatus::Red;

        if !diag.sim_present {
            diag.status = DiagStatus::Unknown;
            diag.summary = "No SIM detected".into();
            diag.recommended_action = Some("Check SIM card is seated correctly".into());
            diag.other_actions = vec![
                "Reseat SIM".into(),
                "Try a known-good SIM".into(),
            ];
            return;
        }

        diag.summary = "No service — searching for network".into();
        diag.recommended_action = Some("Check coverage area and antenna".into());
        diag.other_actions = vec![
            "Reboot controller".into(),
            "Check antenna placement".into(),
        ];
        return;
    }

    // 5. Check explicitly failed — unknown reason
    if diag.check_result == "Failure" {
        diag.status = DiagStatus::Red;
        diag.summary = format!(
            "Failed — {}",
            diag.check_error.as_deref().unwrap_or("unknown error")
        );
        diag.recommended_action = Some("Run setup-cellular to reconfigure".into());
        return;
    }

    // 6. Connected — determine signal quality
    if diag.check_result == "Success" && diag.internet_reachable {
        let provider = diag
            .operator_name
            .as_deref()
            .or(diag.basic_provider.as_deref())
            .or(diag.provider_code.as_deref())
            .unwrap_or("Unknown");
        let strength = diag.strength_score.unwrap_or(0);
        let label = diag.strength_label.as_deref().unwrap_or("");

        if strength >= 60 {
            diag.status = DiagStatus::Green;
            diag.summary = format!("{} · {}/100 · {}", provider, strength, label);
        } else if strength >= 40 {
            diag.status = DiagStatus::Orange;
            diag.summary = format!("{} · {}/100 · weak signal", provider, strength);
            diag.recommended_action =
                Some("Check antenna connection and placement".into());
        } else {
            diag.status = DiagStatus::Red;
            diag.summary = format!("{} · {}/100 · signal too weak", provider, strength);
            diag.recommended_action =
                Some("Check antenna — signal critically low".into());
        }
        return;
    }

    // 7. Fallback: connman confirms connected even though check wasn't run explicitly.
    //    This happens when cellular data is parsed from the SIM Picker block — connman
    //    state reflects the live connection but cellular-check ran inside the subshell
    //    and its output may not match the section-based parsing expectations.
    //    Guard: only apply when genuine cellular data exists (full AT block ran OR
    //    cellular-check produced a result). Without this guard, incidentally parsed
    //    connman data from a WiFi-only run could trigger a false Green status.
    if diag.connman_cell_connected == Some(true)
        && (diag.full_block_run || diag.check_result != "Unknown")
    {
        let provider = diag
            .operator_name
            .as_deref()
            .or(diag.basic_provider.as_deref())
            .or(diag.provider_code.as_deref())
            .unwrap_or("Unknown");
        let strength = diag.strength_score.unwrap_or(0);
        let label = diag.strength_label.as_deref().unwrap_or("");
        if strength >= 60 {
            diag.status = DiagStatus::Green;
            diag.summary = format!("{} · {}/100 · {}", provider, strength, label);
        } else if strength >= 40 {
            diag.status = DiagStatus::Orange;
            diag.summary = format!("{} · {}/100 · weak signal", provider, strength);
            diag.recommended_action =
                Some("Check antenna connection and placement".into());
        } else if strength > 0 {
            diag.status = DiagStatus::Red;
            diag.summary = format!("{} · {}/100 · signal too weak", provider, strength);
            diag.recommended_action =
                Some("Check antenna — signal critically low".into());
        } else {
            // Connected but no signal score (e.g., only connman output, no AT data yet)
            diag.status = DiagStatus::Green;
            diag.summary = format!("{} · connected", provider);
        }
        return;
    }

    diag.status = DiagStatus::Unknown;
    diag.summary = "No data".into();
}
