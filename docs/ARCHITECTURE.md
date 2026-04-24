# Architecture

Engineering overview of the v2 audio server. Byte-level protocol: `docs/WIRE_SPEC.md`. Operator concerns: `docs/DEPLOYMENT.md`.

## 1. System diagram

```
  ┌────────────┐   ┌────────────┐   ┌────────────┐
  │  Android   │   │    iOS     │   │  Desktop   │   … clients embed core/
  │  (Oboe)    │   │ (AVAudio)  │   │ (ALSA/etc) │     audio_engine.h
  └─────┬──────┘   └─────┬──────┘   └─────┬──────┘
        │ WS :3001       │ UDP :4002       │   (TLS / AES-GCM)
        ▼                ▼                 ▼
  ┌───────────────────────────────────────────┐
  │                Audio Server cluster                │
  │   ┌──────────┐   ┌──────────┐   ┌──────────┐       │
  │   │ node A   │◄─►│ node B   │◄─►│ node C   │  mesh │
  │   └─────┬────┘   └─────┬────┘   └─────┬────┘ :4003 │
  └─────────┼──────────────┼──────────────┼────────────┘
            │              │              │
            ▼              ▼              ▼
     ┌─────────────┐   ┌────────────────────────┐
     │ Redis Senti- │   │   REST API (out of band) │
     │ nel + master │   │  channels, users, keys   │
     └─────────────┘   └────────────────────────┘
```

## 2. Planes

- **Media plane (UDP, binary).** 32-byte header + 8-byte explicit IV + AES-256-GCM ciphertext + 16-byte tag. Carries Opus audio, keepalives, pings.
- **Control plane (WebSocket, JSON).** One per client: `auth`, `subscribe`, prefs, floor, presence, key rotation.
- **State plane (Redis).** Session anchoring, presence fan-out, floor mirror, key version.
- **Peer plane (UDP mesh).** Node-to-node forwarding on shared mesh key; operates on decrypted Opus.

## 3. Per-subscriber mixer (MIX vs FWD)

- **FWD** — server re-encrypts incoming streams under the subscriber's egress key. Client decodes N streams, mixes locally. For dispatch consoles.
- **MIX (default)** — server decodes, applies gain/mute/solo/role, mixes float32, Opus-encodes once. One egress packet per 20 ms tick. Active-talker cap: `AUDIO_MAX_ACTIVE_TALKERS`.

## 4. Floor control

States: Idle → Granted → (Queued | Preempted) → Idle. Caps: normal=30s, high=60s, emergency/imminent_peril unlimited. Order: priority desc, then FIFO. Full-duplex channels skip arbitration. See `server/src/floor.rs`.

## 5. Identity / session lifecycle

1. Client opens WSS → `auth` with JWT + X25519 pubkey.
2. Server verifies JWT, derives K_session via ECDH+HKDF, replies with `auth_ok` (udp_host, udp_port, session_salt, key_version).
3. Client subscribes; per-channel ingress/egress keys derived on demand.
4. Session ends on WS close, missed heartbeats, or `server_migrate`.

## 6. Key hierarchy

```
K_session   = HKDF(ECDH(client_priv, server_pub), salt=session_salt)
K_ingress   = HKDF-Expand(K_session, "in"  || cid || kv)
K_egress    = HKDF-Expand(K_session, "out" || cid || kv)
```

## 7. Multi-server scaling

- **Sticky sessions** by 5-tuple/connection (L4 UDP balancers won't survive rehash).
- **Mesh forwarding**: node A decrypts T's audio, forwards via mesh AEAD to node B, which mixes for L's lane locally.
- **Redis coordination**: presence, floor, `key_version`, server inventory.
- **Drain on SIGTERM**: emit `server_migrate`, stop accepting new sessions.

## 8. Observability

- Prometheus on :9100/metrics, `audio_` prefix.
- JSON logs with session/client/channel/op/duration_ms/outcome.
- /healthz (liveness), /readyz (Redis+REST reachable).

## 9. Capacity sizing

| Workload | Per vCPU |
|---|---|
| MIX, avg 2 talkers | ~500 |
| FWD, avg 4 streams | ~1200 |
| Floor arbitration | trivial |
| Mesh forwarding | ~20k pkts/s |

Leading indicator under load: `audio_mix_tick_duration_seconds` p99. Alert when it crosses 10 ms.
