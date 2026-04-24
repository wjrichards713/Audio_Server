# Deployment

Operator's guide. Architecture: `docs/ARCHITECTURE.md`.

## 1. AWS ASG pattern

v1 ran behind an AWS ASG fronted by an NLB; v2 keeps the same topology.

- ASG of `audio-server` instances across 2–3 AZs.
- NLB with two listeners:
  - TCP :443 → :3001 (WS over TLS, terminated at NLB or server)
  - UDP :4002 → :4002 (media plane)
- Private SG: UDP :4003 (mesh) between ASG members only.
- Separate SG for Prometheus VPC → :9100.
- Redis Sentinel: 3-node, private-only.
- REST API on internal hostname.

New nodes pull secrets from AWS Secrets Manager at boot and project into env.

## 2. Environment variables

Read once at startup by `Config::from_env()` in `server/src/config.rs`. Boot fails on missing required vars or malformed `MESH_KEY_HEX`.

| Variable | Required | Default | Notes |
|---|:---:|---|---|
| `AUDIO_PUBLIC_HOST` | yes | — | Advertised in `auth_ok` |
| `AUDIO_BIND_IP` | no | `0.0.0.0` | Bind interface |
| `AUDIO_UDP_PORT` | no | `4002` | Media plane |
| `AUDIO_WS_PORT` | no | `3001` | Control plane |
| `AUDIO_MESH_PORT` | no | `4003` | Inter-server |
| `AUDIO_METRICS_PORT` | no | `9100` | metrics+health |
| `AUDIO_SERVER_ID` | no | `1` | Unique per node |
| `REDIS_SENTINELS` | yes | — | `host:port,...` |
| `REDIS_MASTER_NAME` | no | `mymaster` | Sentinel master |
| `REDIS_PASSWORD` | no | — | If Redis AUTH |
| `REST_BASE_URL` | yes | — | e.g. `https://api.example.com/v1` |
| `REST_API_KEY` | no | — | Bearer token |
| `MESH_KEY_HEX` | yes | — | 32 bytes hex; identical across peers |
| `AUDIO_DEFAULT_MODE` | no | `mix` | `mix` or `forward` |
| `AUDIO_MAX_SUBSCRIPTIONS` | no | `50` | Per session |
| `AUDIO_MAX_ACTIVE_TALKERS` | no | `8` | Per MIX lane |
| `AUDIO_MAX_SESSIONS_PER_SERVER` | no | `4000` | Hard cap |
| `JWT_AUDIENCE` | no | `redenes-audio` | `aud` claim |
| `JWT_ISSUER` | no | `redenes-auth` | `iss` claim |
| `JWT_PUBLIC_KEY_PEM` | yes | — | PEM, RS256/EdDSA |
| `LOG_FORMAT` | no | `pretty` | `pretty`/`json` |

## 3. Redis Sentinel

Three sentinels, quorum 2. Auto-reconnect on failover. Key prefixes: `audio:session:*`, `audio:channel:*`, `audio:floor:*`, `audio:presence:*`, `audio:keyver:*`. Peak RPS ≈ `sessions × 10/s`.

## 4. REST API dependencies

The server calls `REST_BASE_URL` for: channel config, user authorization/profile, per-channel master keys, audit reporting. Treat REST as opaque JSON-over-HTTPS. All calls carry `Authorization: Bearer $REST_API_KEY` when set.

## 5. Graceful drain

SIGTERM → sequence in `server/src/shutdown.rs`:

1. Stop accepting new WS; `/readyz` returns 503.
2. For each active session, emit `server_migrate` to a peer node.
3. Wait `DRAIN_GRACE_SECS` (30 s) for client reconnects; existing audio keeps flowing.
4. Close UDP and WS, flush metrics, exit 0.

Clients handle `AE_EVENT_SERVER_MIGRATE` in the engine — reconnect, re-auth, re-subscribe.

## 6. Health checks

- `/healthz` — liveness, always 200 if process is alive.
- `/readyz` — 200 only when Redis+REST reachable, sockets bound, not draining.
- `/metrics` — Prometheus.

Use `/readyz` for LB target group health; `/healthz` for ASG instance health.

## 7. Autoscaling signals

Scale out on:
- CPU > 70 % for 5 min, OR
- `audio_subscribers / AUDIO_MAX_SESSIONS_PER_SERVER > 0.7`, OR
- `audio_mix_tick_duration_seconds` p99 > 8 ms.

Scale in conservatively: drain ~30 s + cold-start ~10 s. Max 1 node/min.

## 8. Networking

| Port | Proto | Direction | Purpose |
|---|---|---|---|
| 3001 | TCP | Clients→server | WebSocket control |
| 4002 | UDP | Clients↔server | Media |
| 4003 | UDP | Server↔server | Mesh (internal SG) |
| 9100 | TCP | Prom→server | Metrics (internal) |

Expose 3001 + 4002 publicly; restrict 4003 + 9100.

## 9. Secrets management

Never in VCS, logs, or images:
- `JWT_PUBLIC_KEY_PEM` — dual-key during IdP rollover.
- `MESH_KEY_HEX` — rotate via blue/green cluster swap; partial rotation impossible.
- `REST_API_KEY` — per REST team's schedule.

Store in AWS Secrets Manager / Vault, project into env at boot, never to disk.
