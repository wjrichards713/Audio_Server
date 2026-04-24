# Audio Server v2

Public-safety 2-way audio relay + shared C client engine. Binary RTP-like UDP
with AES-256-GCM, per-subscriber MIX/FWD mixer, floor control, Redis Sentinel,
REST integration. Near-real-time multi-channel audio for first responders on
Android, iOS, Raspberry Pi, Windows, macOS, and Linux.

## Repo layout

```
audio_server/
├── server/          Rust audio relay (workspace member `audio-server`)
├── core/            Portable C engine library (audio_engine.h)
├── clients/
│   └── windows/     Reference WASAPI + UI client
├── docs/            Specifications and operator guides
└── Cargo.toml       Workspace manifest
```

## Quick start

### Prerequisites

- Rust 1.78 (pinned in `rust-toolchain.toml`)
- CMake 3.16
- libopus (system package or vcpkg)
- OpenSSL 1.1.1+ (or a FIPS-validated provider, see `docs/SECURITY.md`)
- Redis Sentinel (3 sentinels recommended) pointing at a Redis master
- REST API backend for channel config, user auth, and master key issuance

### Run the server

```
cp .env.example .env
# fill in secrets: JWT_PUBLIC_KEY_PEM, MESH_KEY_HEX, REST_API_KEY, REDIS_PASSWORD
set -a; . ./.env; set +a
cargo run --release -p audio-server
```

The server binds:
- UDP `:4002` for the media plane
- WS  `:3001` for the control plane
- UDP `:4003` for inter-server mesh
- HTTP `:9100` for `/metrics`, `/healthz`, `/readyz`

### Build the C core and the Windows client

See `docs/BUILD.md`.

## Key features

- Unlimited channels per deployment; per-session cap configurable (`AUDIO_MAX_SUBSCRIPTIONS`, default 50)
- Per-channel gain, mute, solo, role (`normal` / `monitor` / `emergency_override`)
- Floor control with four priorities (`normal` / `high` / `emergency` / `imminent_peril`), preemption, queueing, hold timeouts
- PTT duck (local playback attenuation) with `all` / `others` / `none` scopes
- MIX mode: server emits a single pre-mixed Opus stream per subscriber to save mobile battery and bandwidth
- FWD mode: server forwards per-channel Opus streams unchanged (client mixes)
- FIPS-ready crypto boundary — AES-256-GCM envelope with swappable provider
- Horizontal scale via inter-server mesh over UDP and Redis Sentinel state

## Documentation

- `docs/WIRE_SPEC.md` — byte-for-byte media, control, and mesh contract
- `docs/ARCHITECTURE.md` — engineering overview, planes, mixer, scaling
- `docs/DEPLOYMENT.md` — AWS ASG pattern, env vars, drain, health, secrets
- `docs/CLIENT_INTEGRATION.md` — C API usage, platform shims, threading
- `docs/BUILD.md` — server, core library, Windows client build steps
- `docs/OBSERVABILITY.md` — Prometheus metrics, log fields, alerts
- `docs/SECURITY.md` — crypto, keys, replay, JWT, FIPS, threat model

## Status

v2 initial release. Not backwards compatible with v1 (the old Node.js JSON-over-UDP relay is superseded entirely). Clients must use the v2 wire protocol and the shared `audio_engine` library.
