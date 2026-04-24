//! Prometheus metrics. Names follow docs/WIRE_SPEC.md §6.
use crate::config::Config;
use crate::error::{AudioServerError, Result};
use metrics::{describe_counter, describe_gauge, describe_histogram};
use metrics_exporter_prometheus::PrometheusBuilder;
use std::net::SocketAddr;

pub const M_AUDIO_PKTS_IN: &str = "audio_pkts_in_total";
pub const M_AUDIO_PKTS_OUT: &str = "audio_pkts_out_total";
pub const M_AUDIO_PKTS_DROPPED: &str = "audio_pkts_dropped_total";
pub const M_AUDIO_MIX_TICK_DURATION: &str = "audio_mix_tick_duration_seconds";
pub const M_AUDIO_ENCODE_DURATION: &str = "audio_encode_duration_seconds";
pub const M_AUDIO_DECODE_DURATION: &str = "audio_decode_duration_seconds";
pub const M_AUDIO_SUBSCRIBERS: &str = "audio_subscribers";
pub const M_AUDIO_FLOOR_REQUESTS: &str = "audio_floor_requests_total";
pub const M_AUDIO_CHANNEL_MEMBERS: &str = "audio_channel_members";

pub fn init(cfg: &Config) -> Result<()> {
    let addr = SocketAddr::new(cfg.bind_ip, cfg.metrics_port);
    PrometheusBuilder::new().with_http_listener(addr).install()
        .map_err(|e| AudioServerError::Other(format!("metrics exporter install: {e}")))?;
    describe_counter!(M_AUDIO_PKTS_IN, "Audio packets received on ingress UDP socket, by channel_id.");
    describe_counter!(M_AUDIO_PKTS_OUT, "Audio packets sent on egress UDP socket, by mode.");
    describe_counter!(M_AUDIO_PKTS_DROPPED, "Audio packets dropped, by reason.");
    describe_histogram!(M_AUDIO_MIX_TICK_DURATION, "Subscriber mixer tick duration (seconds).");
    describe_histogram!(M_AUDIO_ENCODE_DURATION, "Opus encode duration (seconds).");
    describe_histogram!(M_AUDIO_DECODE_DURATION, "Opus decode duration (seconds).");
    describe_gauge!(M_AUDIO_SUBSCRIBERS, "Connected subscribers, by mode (mix|forward).");
    describe_counter!(M_AUDIO_FLOOR_REQUESTS, "Floor control requests, by outcome.");
    describe_gauge!(M_AUDIO_CHANNEL_MEMBERS, "Member count per channel.");
    tracing::info!(%addr, "prometheus exporter listening");
    Ok(())
}

#[inline] pub fn inc_pkts_in(channel_id: u32) { metrics::counter!(M_AUDIO_PKTS_IN, "channel_id" => channel_id.to_string()).increment(1); }
#[inline] pub fn inc_pkts_out(mode: &'static str) { metrics::counter!(M_AUDIO_PKTS_OUT, "mode" => mode).increment(1); }
#[inline] pub fn inc_pkts_dropped(reason: &'static str) { metrics::counter!(M_AUDIO_PKTS_DROPPED, "reason" => reason).increment(1); }
#[inline] pub fn obs_mix_tick_seconds(secs: f64) { metrics::histogram!(M_AUDIO_MIX_TICK_DURATION).record(secs); }
#[inline] pub fn obs_encode_seconds(secs: f64) { metrics::histogram!(M_AUDIO_ENCODE_DURATION).record(secs); }
#[inline] pub fn obs_decode_seconds(secs: f64) { metrics::histogram!(M_AUDIO_DECODE_DURATION).record(secs); }
#[inline] pub fn set_subscribers(mode: &'static str, n: f64) { metrics::gauge!(M_AUDIO_SUBSCRIBERS, "mode" => mode).set(n); }
#[inline] pub fn inc_floor_request(outcome: &'static str) { metrics::counter!(M_AUDIO_FLOOR_REQUESTS, "outcome" => outcome).increment(1); }
#[inline] pub fn set_channel_members(channel_id: u32, n: f64) { metrics::gauge!(M_AUDIO_CHANNEL_MEMBERS, "channel_id" => channel_id.to_string()).set(n); }

pub use metrics::{counter, gauge, histogram};
