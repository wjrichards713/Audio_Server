# Observability

## 1. Prometheus metrics

Scrape `:9100/metrics`. All names prefixed `audio_`. Source: `server/src/metrics.rs`.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `audio_pkts_in_total` | counter | `channel_id` | UDP ingress accepted |
| `audio_pkts_out_total` | counter | `mode` (mix/forward) | UDP egress emitted |
| `audio_pkts_dropped_total` | counter | `reason` | UDP drops |
| `audio_mix_tick_duration_seconds` | histogram | — | Per-subscriber tick |
| `audio_encode_duration_seconds` | histogram | — | Opus encode time |
| `audio_decode_duration_seconds` | histogram | — | Opus decode time |
| `audio_subscribers` | gauge | `mode` | Connected subscribers |
| `audio_floor_requests_total` | counter | `outcome` | Floor outcomes |
| `audio_channel_members` | gauge | `channel_id` | Members per channel |

Process metrics (`process_cpu_seconds_total`, RSS, FDs) via the `prometheus` `process` feature.

Useful queries:
- Loss: `rate(audio_pkts_dropped_total[1m]) / rate(audio_pkts_in_total[1m])`
- Mixer headroom: `histogram_quantile(0.99, sum by (le) (rate(audio_mix_tick_duration_seconds_bucket[1m])))`
- Floor churn: `rate(audio_floor_requests_total{outcome="preempted"}[5m])`

## 2. Logs

`tracing` + `tracing-subscriber`. `LOG_FORMAT=pretty` (dev) or `json` (prod).

Structured fields:

| Field | Type | When |
|---|---|---|
| `ts` | RFC3339 | always |
| `level` | string | always |
| `session_id` | UUID | inside session span |
| `client_id` | hex u64 | inside session span |
| `channel_id` | u32 | inside channel work |
| `op` | string | control/REST spans |
| `duration_ms` | number | on span close |
| `outcome` | string | `ok`, `err:<class>`, `timeout` |
| `correlation_id` | UUID | from request `id` |

**Never** log plaintext audio bytes, keys, JWTs, or full header hex.

## 3. Dashboards

`docs/grafana-dashboard.json` is **TODO**. Until shipped, use the queries above directly or the project's shared Grafana library.

## 4. Traces

`tracing` spans via `env-filter` today. OpenTelemetry OTLP export is wired in `Cargo.toml` deps but not enabled by default — set `OTEL_EXPORTER_OTLP_ENDPOINT` once a collector is in place. Until then, correlate via `correlation_id` in structured logs.

## 5. Alerts

| Alert | Condition | Severity |
|---|---|---|
| Mixer headroom exhausted | `audio_mix_tick_duration_seconds` p99 > 10 ms for 5 min | page |
| Packet drop rate elevated | `rate(dropped[5m]) / rate(in[5m]) > 0.01` | page |
| Auth failures spike | `rate(dropped{reason="auth"}[5m]) > 5 × baseline` | warn |
| Redis connection loss | `redis_up == 0` | page |
| `/readyz` failing | red > 2 min | page |
| Floor preemption storm | `rate(preempted[5m]) > 10` | warn |

Tune baselines after one week of production data.

## 6. Health endpoints

See `docs/DEPLOYMENT.md §6`. `/healthz` is liveness only; `/readyz` depends on Redis, REST, sockets.

Leading indicator of trouble: `audio_mix_tick_duration_seconds`. Leading indicator of a security event: spike in `audio_pkts_dropped_total{reason="decrypt"|"auth"}`.
