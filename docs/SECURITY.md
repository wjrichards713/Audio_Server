# Security

## 1. AEAD envelope

AES-256-GCM (RFC 5116) on every media datagram. Key: 32 bytes per `(session_id, channel_id, direction, key_version)`. Nonce: `session_salt(4) || explicit_iv(8)` — explicit_iv is monotonic per (key, direction). AAD = the 32-byte header. 16-byte tag appended. Tampering with channel_id/server_id/flags fails the tag check.

Constants in `server/src/protocol.rs`.

## 2. Key hierarchy

```
K_session   = HKDF-SHA256(ikm = ECDH(client_x25519, server_x25519), salt = session_salt, info = "redenes/audio/v2/session")
K_ingress   = HKDF-Expand(K_session, "in"  || u32(channel_id) || u16(key_version))[:32]
K_egress    = HKDF-Expand(K_session, "out" || u32(channel_id) || u16(key_version))[:32]
```

No raw key material crosses the wire. The per-channel master key (REST) gates rotation, not encryption.

## 3. Key rotation

1. Admin/scheduled → REST issues new master with `key_version = v+1`.
2. Server bumps in-memory `key_version`, resets explicit-IV counter for that key.
3. Redis pub/sub notifies other nodes.
4. WS `key_rotation` to subscribers.
5. Both sides derive new K_ingress/K_egress from the held K_session.

Old keys decrypt during a short overlap window, then are zeroized (`zeroize` crate).

## 4. Authentication

- WS `auth` op: JWT verified against `JWT_PUBLIC_KEY_PEM` (RS256/EdDSA), `aud == JWT_AUDIENCE`, `iss == JWT_ISSUER`, expiry.
- Client X25519 public key in `auth`; server returns server X25519 in `auth_ok`. ECDH → K_session.
- No anonymous sessions, no resumption across WS disconnects.

## 5. Replay protection

Per `(channel_id, client_id, direction, key_version)` sliding sequence window. Out-of-window or duplicate → dropped, counted as `audio_pkts_dropped_total{reason}`. Tracker in `core/src/rtp.c` and Rust ingress.

## 6. Transport security

- **WebSocket**: TLS mandatory in production (rustls or LB termination).
- **UDP media**: AEAD only; the envelope provides confidentiality+integrity+authenticity.
- **Mesh**: same envelope, key = `MESH_KEY_HEX`. Rotate by rolling the cluster.

## 7. FIPS 140-3 readiness

AEAD is behind one module boundary in `core/src/crypto.c`. Switch backend to a FIPS-validated OpenSSL or BoringCrypto via build flag; no protocol changes. HKDF-SHA256 and X25519 likewise delegated.

## 8. Threat model

In scope:
- Network adversary on public Internet: no decrypt, no forge, no replay, may drop.
- Compromised client: JWT gates admission; subscription/talker caps + floor rules contain misbehaviour.
- Mesh peer impersonation: prevented by MESH_KEY_HEX AEAD.

Out of scope by design:
- **End-to-end encryption between clients.** Server must terminate keys to mix audio in MIX mode. E2E and server-mix are mutually exclusive; we chose server-mix for battery, bandwidth, and moderation.
- **Host compromise.** Root on the server host → K_session in RAM is recoverable.

Operational controls:
- Secrets in a manager (AWS Secrets Manager / Vault), env-projected at boot; never on disk.
- Mobile client X25519 keys in hardware keystore (Android Keystore, iOS Secure Enclave).
- Audit log for floor grants, key rotations, emergency_override usage; ship off-host.
- CVE patch cadence: `aes-gcm`, `hkdf`, `rustls`, `openssl`, FIPS provider — page-worthy.

Watch for spikes in `audio_pkts_dropped_total{reason="decrypt"}` or `{reason="auth"}` — potential incidents.
