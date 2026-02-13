# Barix Instreamer Integration Plan
## REDENES Audio Server — Two-Way Radio Audio Ingestion

**Date:** February 2026
**System:** REDENES Real-Time Audio Streaming Platform
**Goal:** Allow Barix Instreamer hardware devices to feed two-way radio audio into the existing REDENES audio server, so all connected Android, iOS, and Web clients receive the radio audio on their channels — with zero changes to client apps.

---

## 1. Overview

### What Is the Barix Instreamer?
The Barix Instreamer is a hardware IP audio encoder. It takes analog audio in via RCA line-level inputs (from a two-way radio's speaker/audio output) and streams it over the network as digital audio using standard IP protocols.

### Supported Audio Formats (Instreamer)
- **PCM 16-bit** — 8, 12, 24, 32, 44.1, or 48 kHz mono (big or little endian); 44.1 and 48 kHz also available in stereo
- **G.711** (aLaw/uLaw) — 8 or 24 kHz
- **MP3** — VBR or CBR, 35–320 kbps

### Supported Streaming Protocols (Instreamer)
- **Raw UDP** (recommended for this integration — lowest latency, simplest)
- **RTP** (standard Real-Time Protocol with 12-byte header)
- **BRTP** (Barix proprietary RTP)
- **HTTP** (Icecast/Shoutcast source)
- **Raw TCP**
- **SIP**

### Why Raw UDP?
- Lowest latency (sub-100ms with PCM)
- Simplest packet structure — just raw PCM audio bytes, no headers to strip
- Instreamer sends directly to a specific IP:port
- Matches our server's existing UDP-based architecture

---

## 2. Architecture

### Current System Flow (App Clients)
```
Phone Mic → Opus Encode → AES-GCM Encrypt → Base64 → JSON
→ UDP to Server → Server Forwards to Channel Members
→ Client Receives JSON → Base64 Decode → AES Decrypt → Opus Decode → Speaker
```

### New Flow (Barix Instreamer Added)
```
Two-Way Radio (analog audio out via RCA)
    ↓
Barix Instreamer (encodes to PCM 16-bit 48kHz mono, sends Raw UDP)
    ↓
REDENES Server — NEW BarixIngestionService
    ↓ (receives raw PCM → Opus encode → AES-GCM encrypt → Base64 → JSON)
    ↓
REDENES Server — EXISTING ReceiveUdpMessages forwarding pipeline (UNCHANGED)
    ↓
Android / iOS / Web Clients (UNCHANGED — receive same JSON+Opus+AES packets)
```

### What Changes vs What Stays the Same

| Component | Change Required |
|-----------|----------------|
| **Android app** | NONE |
| **iOS app** | NONE |
| **Web client** | NONE |
| **Server — existing UDP forwarding** | NONE |
| **Server — existing WebSocket signaling** | NONE |
| **Server — existing channel membership** | NONE |
| **Server — new BarixIngestionService** | NEW CODE |
| **Server — new API endpoints for Barix management** | NEW CODE |
| **Server — new NuGet package (Concentus for Opus)** | NEW DEPENDENCY |
| **Redis database** | NEW DATA STRUCTURE for Barix device registry |
| **Dashboard** | UPDATED — add Barix device status section |
| **Barix Instreamer device** | CONFIGURED via its web interface |

---

## 3. Barix Instreamer Device Configuration

Each Barix Instreamer needs to be configured via its built-in web interface (accessible by browsing to the device's IP address on your LAN).

### Network Setup
1. Connect the Barix Instreamer to your network via Ethernet
2. The device will get an IP via DHCP (or configure a static IP)
3. Access the web interface at `http://<barix-ip>/`

### Audio Input Configuration
| Setting | Value | Notes |
|---------|-------|-------|
| **Input Source** | Line Input (Left RCA — white connector) | Connect 2-way radio audio output here |
| **Encoding** | PCM 16-bit | Uncompressed — the server will re-encode to Opus |
| **Sample Rate** | 48000 Hz | Matches the REDENES system sample rate |
| **Channels** | Mono | Matches the REDENES system (mono throughout) |
| **Endianness** | Little Endian | Matches standard PCM16 LE (same as Android AudioRecord output) |

### Streaming Configuration
| Setting | Value | Notes |
|---------|-------|-------|
| **Streaming Type** | Raw UDP | Lowest latency, simplest — just raw PCM bytes |
| **Destination IP** | `<your-server-public-ip>` | The REDENES audio server's public IP address |
| **Destination Port** | Assigned per device (see Section 5) | Each Barix gets a unique port from the server |
| **Streaming Strategy** | Lowest Latency | Sends data immediately after encoding (vs. filling a packet) |

### Important Notes
- Only the **Left Input** (white RCA connector) audio is streamed in mono mode
- With Raw UDP at PCM 16-bit 48kHz mono, the bitrate is approximately **768 kbps** plus ~7 kbps UDP overhead
- Packet rate is approximately **75 packets/second**
- Each packet contains approximately **1280 bytes** of PCM audio data (roughly 13.3ms of audio at 48kHz 16-bit mono)

---

## 4. Redis Database — Barix Device Registry

Each Barix Instreamer needs a persistent configuration stored in Redis that maps it to a channel and tracks its status.

### Redis Key Structure

**Device Registry** — `barix:devices` (Hash of all registered devices)
```
Key: barix:devices:<device_id>
Value: {
    "device_id": "barix_001",
    "device_name": "Fire Dispatch Radio - Engine 1",
    "listen_port": 6001,
    "channel_id": "fire-dispatch-ch1",
    "affiliation_id": "aff_12345",
    "agency_name": "Metro Fire Department",
    "encoding": "pcm16",
    "sample_rate": 48000,
    "status": "active",
    "last_packet_time": 1739400000,
    "created_at": 1739300000,
    "created_by": "admin@redenes.org"
}
```

**Port Allocation** — `barix:ports` (Set of all allocated Barix listen ports)
```
Key: barix:ports
Value: Set { 6001, 6002, 6003, ... }
```

**Port Range Configuration** — `barix:config`
```
Key: barix:config:port_range_start → 6000
Key: barix:config:port_range_end → 6999
```

This gives you up to **1000 Barix devices** (ports 6000–6999), completely separate from the dynamic client UDP ports that the existing system allocates.

### Why Separate Port Range?
- Client UDP ports are dynamically allocated (ephemeral ports) and short-lived
- Barix ports are **statically assigned** and long-lived — the hardware device is configured once and runs continuously
- Keeping them in a separate range (6000–6999) prevents collisions and makes firewall rules simple
- The server needs to open these ports and listen on them at startup (not on-demand like client ports)

---

## 5. Server Changes — New Code

### 5.1 New NuGet Package

Add the **Concentus** package for server-side Opus encoding. This is a pure C# Opus encoder — no native dependencies needed.

```xml
<PackageReference Include="Concentus" Version="2.0.8" />
```

Also add **StackExchange.Redis** if not already present:
```xml
<PackageReference Include="StackExchange.Redis" Version="2.7.10" />
```

### 5.2 New Class: BarixIngestionService

This is the core new component. It:
1. Reads the Barix device registry from Redis on startup
2. Opens a UDP listener on each registered device's port
3. Receives raw PCM 16-bit audio bytes from the Barix
4. Accumulates PCM into 20ms frames (960 samples at 48kHz)
5. Opus-encodes each frame
6. AES-GCM encrypts with the shared key
7. Base64 encodes
8. Wraps in the same JSON format: `{"type":"audio","channel_id":"...","data":"..."}`
9. Injects into the existing forwarding pipeline (sends the JSON packet to all channel members via their UDP sockets)

### Processing Pipeline Detail

```
Raw PCM bytes from Barix (little-endian 16-bit samples)
    ↓
Frame Accumulator (buffer until we have 960 samples = 20ms at 48kHz)
    ↓
Opus Encoder (Concentus) → compressed bytes
    ↓
AES-GCM Encrypt (same key: "46dR4QR5KH7JhPyyjh/ZS4ki/3QBVwwOTkkQTdZQkC0=")
    ↓  Prepend 12-byte IV to ciphertext (same format as apps)
    ↓
Base64 Encode
    ↓
JSON Wrap: {"type":"audio","channel_id":"<from redis config>","data":"<base64>"}
    ↓
Forward to all channel members via existing AudioServerController.members
    and AudioServerController.udpSockets / udpClients dictionaries
```

### 5.3 New API Endpoints

These endpoints allow the dashboard (and future admin UI) to manage Barix devices.

**POST `/api/barix/register`** — Register a new Barix device
```json
Request: {
    "device_name": "Fire Dispatch Radio",
    "channel_id": "fire-dispatch-ch1",
    "affiliation_id": "aff_12345",
    "agency_name": "Metro Fire Department"
}
Response: {
    "device_id": "barix_001",
    "listen_port": 6001,
    "status": "active"
}
```
This auto-allocates the next available port from the 6000–6999 range, saves to Redis, and immediately starts listening on that port. The admin then configures the Barix hardware to send to `server-ip:6001`.

**GET `/api/barix/devices`** — List all registered Barix devices
```json
Response: [
    {
        "device_id": "barix_001",
        "device_name": "Fire Dispatch Radio",
        "listen_port": 6001,
        "channel_id": "fire-dispatch-ch1",
        "agency_name": "Metro Fire Department",
        "status": "active",
        "last_packet_time": 1739400000
    }
]
```

**PUT `/api/barix/devices/{device_id}`** — Update device config (change channel, name, etc.)

**DELETE `/api/barix/devices/{device_id}`** — Unregister a device (stops the listener, frees the port)

**GET `/api/barix/devices/{device_id}/status`** — Get live status (last packet time, packets/sec, audio level)

### 5.4 VOX Detection (Voice-Operated Switch)

Since the Barix sends audio continuously (including silence/noise when the radio is not transmitting), the server should detect when actual voice is present to:
- Automatically trigger `transmit_started` / `transmit_ended` WebSocket events
- Avoid forwarding silence/static to clients (saves bandwidth)

**Implementation:**
- Calculate RMS (root-mean-square) audio level of each 20ms frame
- When RMS exceeds a configurable threshold for N consecutive frames → trigger "transmit started"
- When RMS drops below threshold for M consecutive frames → trigger "transmit ended"
- Configurable per device: threshold, hold time, etc.
- Only forward audio frames to channel members when "transmitting" is active

### 5.5 Startup Integration

On server startup, the `BarixIngestionService` should:
1. Connect to Redis
2. Load all registered Barix devices from `barix:devices:*`
3. For each device, open a `UdpClient` on the configured `listen_port`
4. Start receiving on each port in a background task
5. Log status for each device

This runs alongside the existing server — no changes to the existing `Program.Main`, just an additional hosted service.

---

## 6. Server Firewall / Port Requirements

### Current Ports
| Port | Protocol | Purpose |
|------|----------|---------|
| 3000 | TCP | HTTP API + static files |
| 3001 | TCP | WebSocket signaling |
| Dynamic | UDP | Per-client audio (ephemeral ports) |

### New Ports to Open
| Port Range | Protocol | Purpose |
|------------|----------|---------|
| 6000–6999 | UDP | Barix Instreamer audio ingestion (one port per device) |

The firewall rule is simple: open UDP 6000–6999 inbound from the IP addresses of your Barix devices (or from any if the devices are behind NAT).

---

## 7. Dashboard Updates

Add a new section to `dashboard.html` for Barix device monitoring:

### New Dashboard Section: "Barix Instreamers"
- Device name, assigned port, mapped channel
- Status indicator (green = receiving audio, yellow = registered but no data, red = error)
- Last packet received timestamp
- Audio level meter (real-time RMS level)
- VOX status (transmitting / idle)
- Packets per second counter
- Button to register new device
- Button to remove device

This data comes from the new `GET /api/barix/devices` endpoint.

---

## 8. Step-by-Step Implementation Checklist

### Phase 1: Server Preparation
- [ ] Add `Concentus` NuGet package to `AudioServer.csproj`
- [ ] Add `StackExchange.Redis` NuGet package to `AudioServer.csproj`
- [ ] Set up Redis instance (if not already running) or configure connection string
- [ ] Define the Redis key structure for Barix devices

### Phase 2: BarixIngestionService Core
- [ ] Create `BarixIngestionService` class
- [ ] Implement PCM frame accumulator (buffer raw bytes → 960-sample frames)
- [ ] Implement Opus encoding using Concentus (48kHz, mono, 20ms frames)
- [ ] Implement AES-GCM encryption (same key and IV format as app clients)
- [ ] Implement Base64 + JSON wrapping
- [ ] Implement forwarding to channel members using existing `AudioServerController.members`, `udpSockets`, and `udpClients` dictionaries
- [ ] Implement per-device UDP listener lifecycle (start/stop)

### Phase 3: VOX Detection
- [ ] Implement RMS audio level calculation on PCM frames
- [ ] Implement configurable threshold + hold time logic
- [ ] Only forward frames when voice is detected (above threshold)
- [ ] Generate `transmit_started` / `transmit_ended` WebSocket broadcast events

### Phase 4: API Endpoints
- [ ] POST `/api/barix/register` — register device, auto-allocate port, save to Redis, start listener
- [ ] GET `/api/barix/devices` — list all devices with status
- [ ] PUT `/api/barix/devices/{device_id}` — update device config
- [ ] DELETE `/api/barix/devices/{device_id}` — unregister, stop listener, free port
- [ ] GET `/api/barix/devices/{device_id}/status` — live status

### Phase 5: Startup Integration
- [ ] Load all Barix devices from Redis on server startup
- [ ] Start UDP listeners for all registered devices
- [ ] Add `BarixIngestionService` as a hosted service in `Program.cs`

### Phase 6: Dashboard
- [ ] Add Barix Instreamers section to `dashboard.html`
- [ ] Show device list with status, audio level, VOX state
- [ ] Add register/remove device UI

### Phase 7: Hardware Setup & Testing
- [ ] Connect Barix Instreamer to network
- [ ] Configure Barix via web interface (PCM 16-bit, 48kHz, mono, LE, Raw UDP)
- [ ] Set Barix destination to server IP + assigned port
- [ ] Register device via API or dashboard
- [ ] Test: transmit on radio → verify audio arrives on Android/iOS/Web clients
- [ ] Tune VOX threshold for the specific radio's noise floor
- [ ] Test with multiple Barix devices on different channels simultaneously

---

## 9. Hardware Shopping List

For each two-way radio channel you want to bring into REDENES:

| Item | Purpose | Qty |
|------|---------|-----|
| Barix Instreamer (or Instreamer 100) | IP audio encoder | 1 per radio |
| RCA audio cable (3.5mm to RCA or RCA to RCA) | Connect radio audio output to Barix Left Input | 1 per radio |
| Ethernet cable | Connect Barix to network | 1 per radio |
| Power supply (included with Barix) | Power the Barix device | 1 per radio |

### Audio Connection
- Most two-way radios have a **speaker/audio output** jack (3.5mm or 2.5mm)
- Use an appropriate adapter cable to connect to the Barix **Left Input** (white RCA connector)
- The Barix takes **line-level** input — if the radio outputs speaker-level, you may need to reduce the volume or use a pad to avoid clipping
- Test the audio level on the Barix web interface before going live

---

## 10. Summary

The Barix Instreamer integration is a **server-side addition only**. It adds a new ingestion service that translates raw PCM audio from hardware radio encoders into the same encrypted Opus JSON protocol that all REDENES clients already understand.

**Key points:**
- One dedicated UDP port per Barix device (port range 6000–6999)
- Ports stored in Redis so they persist across server restarts and can be managed via API
- Server transcodes: PCM → Opus → AES → Base64 → JSON → forward to channel members
- VOX detection prevents forwarding dead air
- Zero changes to Android, iOS, or Web clients
- Zero changes to existing server forwarding logic
- Barix device configured once via its web interface, then runs unattended

---

*Document prepared for REDENES Audio Server — Barix Instreamer Integration*
