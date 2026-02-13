# Barix InStreamer Integration - Setup Guide

## Overview

This guide covers how to configure a Barix InStreamer to send audio to the Audio Server, which then converts it to the same encrypted Opus format used by all existing clients (Android, iOS, Web). No changes are needed on any client.

## Architecture

```
Two-Way Radio (analog audio out)
    |
    v
Barix InStreamer (sends raw PCM 16-bit over UDP)
    |
    v
Audio Server - BarixIngestionService
    |  1. Receives raw PCM UDP packets
    |  2. Accumulates into 20ms frames (960 samples @ 48kHz)
    |  3. Opus encodes each frame
    |  4. AES-GCM encrypts
    |  5. Wraps in JSON {channel_id, audio}
    |  6. Forwards to all channel members
    |
    v
Existing Clients (unchanged - Android/iOS/Web)
```

## Step 1: Register the Barix Device on the Server

Before configuring the InStreamer hardware, register the device via the API:

```bash
curl -X POST http://<server-ip>:3000/api/barix/register \
  -H "Content-Type: application/json" \
  -d '{
    "device_id": "barix-01",
    "name": "Dispatch Radio 1",
    "channel_id": "your-channel-id-here"
  }'
```

The response will include the `udp_port` to configure on the InStreamer (default range: 6000-6099).

You can also register devices via the dashboard UI at `http://<server-ip>:3000/dashboard.html`.

## Step 2: Configure the Barix InStreamer

### Access the InStreamer Web UI

1. Connect the InStreamer to your network
2. Find its IP address (check your DHCP server or use the Barix Discovery tool)
3. Open a browser to `http://<instreamer-ip>`

### Audio Settings

Navigate to **Configuration > Audio** and set:

| Setting        | Value              |
|----------------|--------------------|
| Encoding       | PCM (Linear)       |
| Sample Rate    | 48000 Hz           |
| Channels       | Mono               |
| Bit Depth      | 16-bit             |
| Byte Order     | Little Endian      |

**Important:** Do NOT select MP3 or G.711 encoding. The server requires raw PCM and handles all encoding internally.

### Streaming / Network Settings

Navigate to **Configuration > Streaming** and set:

| Setting          | Value                                              |
|------------------|----------------------------------------------------|
| Protocol         | Raw UDP                                            |
| Destination IP   | Your Audio Server's IP address                     |
| Destination Port | The port returned from device registration (e.g. 6000) |
| Packet Size      | 960 bytes (recommended)                            |

**Why Raw UDP?** Raw UDP provides the lowest latency and simplest packet format. Do NOT use RTP, BRTP, HTTP/Icecast, or SIP protocols - the server expects raw PCM bytes.

### Packet Size Recommendations

| Packet Size | Latency per Packet | Notes                      |
|-------------|--------------------|-----------------------------|
| 960 bytes   | 10ms               | Half a frame, good balance  |
| 1920 bytes  | 20ms               | Exactly one Opus frame      |
| 480 bytes   | 5ms                | Lower latency, more packets |

The server accumulates packets into 20ms frames regardless of packet size, so any size works. Smaller packets mean lower latency but higher packet overhead.

## Step 3: Connect the Audio Source

1. Connect the two-way radio's **audio output** (speaker out or line out) to the InStreamer's **RCA input** or **3.5mm jack**
2. Set the radio output volume to a moderate level
3. On the InStreamer, if there is an input gain control, adjust so that normal speech shows approximately -12dB to -6dB on the InStreamer's level meter
4. Avoid clipping - keep peaks below -3dB

## Step 4: Verify the Connection

### Check via API

```bash
# List all devices and their status
curl http://<server-ip>:3000/api/barix/devices

# Check a specific device
curl http://<server-ip>:3000/api/barix/devices/barix-01/status
```

### Check via Dashboard

Open `http://<server-ip>:3000/dashboard.html` and look at the **Barix InStreamer Devices** section. An active device will show:
- Green "Active" badge
- Increasing packet and frame counters
- Source IP address of the InStreamer

### Check Server Logs

The server logs Barix activity with the `[Barix]` prefix:
```
[Barix] Registered device 'Dispatch Radio 1' (ID: barix-01) on port 6000 -> channel your-channel-id
[Barix] Device 'Dispatch Radio 1' source address: 192.168.1.50
[Barix] VOX activated for device 'Dispatch Radio 1' (RMS: 1523)
[Barix] VOX deactivated for device 'Dispatch Radio 1' (RMS: 45)
```

## Server Configuration

The server's Barix settings are in `appsettings.json`:

```json
{
  "Barix": {
    "PortRangeStart": 6000,
    "PortRangeEnd": 6099,
    "SampleRate": 48000,
    "Channels": 1,
    "BitDepth": 16,
    "OpusBitrate": 64000,
    "FrameDurationMs": 20,
    "VoxEnabled": true,
    "VoxThresholdRms": 200,
    "VoxHoldTimeMs": 500
  }
}
```

### Configuration Options

| Setting          | Default | Description                                              |
|------------------|---------|----------------------------------------------------------|
| PortRangeStart   | 6000    | First UDP port for Barix devices                         |
| PortRangeEnd     | 6099    | Last UDP port (supports up to 100 devices)               |
| SampleRate       | 48000   | Must match the InStreamer's sample rate                   |
| Channels         | 1       | 1 = Mono (must match InStreamer)                         |
| BitDepth         | 16      | 16-bit PCM (must match InStreamer)                       |
| OpusBitrate      | 64000   | Opus encoder bitrate in bps (32000-128000 typical)       |
| FrameDurationMs  | 20      | Opus frame duration (20ms is standard)                   |
| VoxEnabled       | true    | Enable voice activity detection                          |
| VoxThresholdRms  | 200     | RMS level to trigger voice detection (0-32767 for 16-bit)|
| VoxHoldTimeMs    | 500     | How long to keep transmitting after voice stops          |

### VOX (Voice-Operated Switch)

VOX prevents silence from being encoded and transmitted. When enabled:
- Audio frames below `VoxThresholdRms` are discarded
- Once voice is detected, transmission continues for `VoxHoldTimeMs` after the last voice frame
- This reduces bandwidth and prevents clients from hearing constant background noise

To disable VOX (always transmit), set `VoxEnabled` to `false`.

## API Reference

### Register a device
```
POST /api/barix/register
Body: { "device_id": "...", "name": "...", "channel_id": "...", "port": 6000 (optional) }
```

### List all devices
```
GET /api/barix/devices
```

### Get device status
```
GET /api/barix/devices/{device_id}/status
```

### Remove a device
```
DELETE /api/barix/devices/{device_id}
```

### Get InStreamer configuration guide
```
GET /api/barix/instreamer-config
```

## Firewall Requirements

Ensure these UDP ports are open on the server:

| Port Range  | Direction | Purpose                           |
|-------------|-----------|-----------------------------------|
| 6000-6099   | Inbound   | Barix InStreamer raw PCM audio     |
| 3000        | Inbound   | HTTP API (TCP)                    |
| 3001        | Inbound   | WebSocket signaling (TCP)         |
| Ephemeral   | Inbound   | Client UDP audio (dynamic ports)  |

## Troubleshooting

| Symptom                        | Check                                                      |
|--------------------------------|------------------------------------------------------------|
| No packets received            | Verify InStreamer IP/port settings, check firewall          |
| Device shows "Idle"            | Ensure InStreamer is streaming, check source address in API |
| Audio sounds distorted         | Check sample rate matches (must be 48000 Hz on both sides) |
| Audio cuts in/out              | Lower VoxThresholdRms or increase VoxHoldTimeMs            |
| No audio but packets received  | Verify 16-bit PCM Little Endian encoding on InStreamer     |
| Clients don't hear audio       | Ensure clients are joined to the same channel_id           |
