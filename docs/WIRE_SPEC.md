# Audio Server v2 — Wire Specification

This is the authoritative source-of-truth contract for the media plane, control
plane, and inter-server mesh. Every implementation (Rust server, C core, any
future client) MUST follow these formats byte-for-byte.

## 1. Media packet (UDP)

Every media-plane UDP datagram is:

```
+----------------------------------------------------------------+
| Header (32 bytes, BIG-ENDIAN, unencrypted, used as AEAD AAD)  |
+----------------------------------------------------------------+
| Explicit IV (8 bytes) — concatenated with 4-byte session salt  |
|                          to form the 12-byte AES-GCM nonce     |
+----------------------------------------------------------------+
| Ciphertext (variable) — AES-256-GCM(plaintext)                 |
+----------------------------------------------------------------+
| Tag (16 bytes, AES-GCM authentication tag)                     |
+----------------------------------------------------------------+
```

### 1.1 Header (32 bytes)

Offset / Size / Field / Notes
- 0 / 1 / version / 0x02
- 1 / 1 / type / 0=audio 1=keepalive 2=ping 3=pong 4=mixed 5=silence
- 2 / 1 / payload_type / 0=opus-48k-mono 1=opus-48k-stereo 2=pcm-s16
- 3 / 1 / flags / bit0=FEC bit1=DTX bit2=MARKER bit3=MIX_EGRESS
- 4 / 4 / sequence / u32 per (channel_id, client_id) ingress or per subscriber-channel egress
- 8 / 4 / timestamp / u32 RTP-style, 48 kHz ticks
- 12 / 4 / channel_id / u32 (0xFFFFFFFF for MIX egress)
- 16 / 8 / client_id / u64 (source client; 0 for server-generated)
- 24 / 4 / server_id / u32 origin server id
- 28 / 2 / key_version / u16 — which per-channel master key was used
- 30 / 2 / payload_length / u16 — length of ciphertext+tag, not header+iv

All fields big-endian.

### 1.2 AEAD envelope

- Algorithm: AES-256-GCM (RFC 5116).
- Key: 32 bytes. Derived per (channel_id, client_id, session_id, key_version).
- Nonce: 12 bytes = `session_salt (4 bytes)` || `explicit_iv (8 bytes)`.
  The explicit_iv MUST be a monotonic counter that never repeats under the same key.
- AAD: the 32-byte header exactly as on the wire.
- Tag: 16 bytes appended to ciphertext.

### 1.3 IV generation

- `explicit_iv` is a big-endian `u64` counter.
- For ingress (client → server) the counter is driven by the client.
- For egress (server → client) the counter is driven by the server's per-subscriber state.
- Key rotation bumps `key_version` and resets the counter.

### 1.4 Payload

- Audio: Opus frame (20 ms, 48 kHz). FEC inband, DTX handled by encoder.
- Mixed egress (server → MIX subscriber): Opus mixed output, `channel_id = 0xFFFFFFFF`, `flags |= MIX_EGRESS`.
- Keepalive/ping/pong: 8-byte timestamp payload only.

## 2. Control plane (WebSocket, JSON)

All messages: `{"op":"<name>","id":"<uuid-v4>","data":{...}}`.

Server responds with `ack` or `nack` carrying the same `id`.

Client → Server ops:
- `auth` {jwt, device_id, client_pubkey_x25519_hex}
- `subscribe` {channel_id, gain_db?, muted?, solo?, priority?}
- `unsubscribe` {channel_id}
- `set_channel_prefs` {channel_id, gain_db?, muted?, solo?, priority?}
- `set_subscriptions` [{channel_id, gain_db, muted, solo, priority}]
- `set_session_options` {mode?, pause_egress_during_ptt?, ptt_mutes?, sidetone_db?}
- `floor_request` {channel_id, priority}
- `floor_release` {channel_id}
- `ping` {timestamp_ms}

Server → Client ops: `auth_ok`, `auth_error`, `ack`, `nack`, `subscriptions_state`, `presence`, `floor_state`, `key_rotation`, `server_migrate`, `pong`, `error`.

Session modes: `mix` (server mixes all subscribed channels into one encrypted stream) | `forward` (one stream per channel).
PTT mute scopes: `all` | `others` | `none`.

## 3. Inter-server mesh (UDP)

Same 32-byte header, transport key is a pair-wise mesh key provisioned out of band (`MESH_KEY_HEX`). Plaintext is the decrypted Opus payload (mesh operates on decrypted audio so the receiving server can mix for its own subscribers without re-keying). Mesh port: `mesh_port` (default 4003).

## 4. Floor control semantics

- Priorities low→high: `normal (0) < high (1) < emergency (2) < imminent_peril (3)`.
- Idle + request → grant, broadcast.
- Granted + same-or-lower priority → queue.
- Granted + higher priority → preempt.
- Grant caps: normal=30 s, high=60 s, emergency/ip=unlimited.
- Queue order: priority-desc, FIFO.
- Full-duplex channels skip arbitration.

## 5. Key derivation

```
K_session = HKDF-SHA256(ikm=ECDH(client_priv, server_pub), salt=session_salt, info="redenes/audio/v2/session")
K_ingress = HKDF-Expand(K_session, info="in" || u32_be(channel_id) || u16_be(key_version))[:32]
K_egress  = HKDF-Expand(K_session, info="out"|| u32_be(channel_id) || u16_be(key_version))[:32]
```

## 6. Observability

Structured JSON logs (ts, level, session_id, client_id, channel_id, op, duration_ms, outcome).
Prometheus metrics prefix: `audio_`.
