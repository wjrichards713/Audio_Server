# Client Integration

For engineers integrating the shared C engine (`core/include/audio_engine.h`) into an Android, iOS, Raspberry Pi, or desktop client.

## 1. Engine lifecycle — quick start

```c
#include "audio_engine.h"

static int  capture_cb (float *dst, int frames, void *ud);
static void playback_cb(const float *src, int frames, void *ud);
static void event_cb   (const ae_event_t *ev, void *ud);

int main(void) {
    ae_config_t cfg = ae_config_default();
    ae_engine_t *e = ae_engine_create(&cfg);

    ae_engine_set_capture_callback (e, capture_cb,  NULL);
    ae_engine_set_playback_callback(e, playback_cb, NULL);
    ae_engine_set_event_callback   (e, event_cb,    NULL);

    ae_engine_connect(e, "audio.example.com", 3001, jwt, "device-123");
    ae_engine_subscribe(e, /*channel_id*/42, /*gain_db*/0.0f,
                        /*muted*/false, /*solo*/false, AE_ROLE_NORMAL);

    ae_engine_floor_request(e, 42, AE_PRIO_NORMAL);   /* PTT down */
    /* audio flows … */
    ae_engine_floor_release(e, 42);                   /* PTT up   */

    ae_engine_destroy(e);
    return 0;
}
```

## 2. Platform shims

- **Android** — Oboe with `PerformanceMode::LowLatency`, stream usage `USAGE_MEDIA` for listen-only and `USAGE_VOICE_COMMUNICATION` during PTT. Bridge callbacks via JNI. `setFramesPerCallback(960)` matches `AE_FRAME_SIZE_SAMPLES`.
- **iOS** — `AVAudioEngine` in `.playback` mode for listen-only; switch to `.playAndRecord` only while the user holds PTT. Pause/resume on `AVAudioSessionInterruptionNotification`.
- **Linux / Raspberry Pi** — ALSA (`snd_pcm_*`) or PipeWire. 48 kHz mono float32 both ways; 20 ms periods align with the engine.
- **macOS** — CoreAudio HAL, `kAudioUnitSubType_DefaultOutput`/`HALOutput`.
- **Windows** — WASAPI in event-driven mode. Reference is in `clients/windows/`.

All backends must deliver and accept **mono float32 at 48 kHz**. If hardware rate differs, the shim resamples; the engine does not.

## 3. Volume control

Call `ae_engine_set_channel_gain_db(e, channel_id, gain_db)` whenever the user moves a slider. The engine debounces and ramps internally to avoid zipper noise. Master volume is a separate post-mix knob: `ae_engine_set_master_volume(e, linear_gain)`.

## 4. Floor control and PTT

- Clients MUST call `ae_engine_floor_request` before emitting audio. Capture without floor is silently dropped.
- Wire PTT down-edge to `floor_request`, up-edge to `floor_release`. Show "you are live" UI on `AE_EVENT_FLOOR_GRANTED`.
- PTT local ducking runs in the engine: `ae_engine_set_ptt_mute_scope(e, AE_PTT_MUTE_ALL|OTHERS|NONE)`.
- Server-side egress pause (bandwidth optimization): `ae_engine_set_pause_egress_during_ptt(e, true)`.

## 5. Error codes

| Code | Meaning |
|---|---|
| `AE_ERR_INVALID_PARAM` | Bad argument |
| `AE_ERR_NOT_CONNECTED` | Called before `connect` returned |
| `AE_ERR_AUTH` | JWT rejected/expired — re-auth |
| `AE_ERR_CRYPTO` | AEAD decrypt failed — reconnect |
| `AE_ERR_NETWORK` | Socket error; engine will reconnect |
| `AE_ERR_FULL` | Subscription/talker cap hit |
| `AE_ERR_PROTOCOL` | Server rejected the op |
| `AE_ERR_TIMEOUT` | WS/REST call timed out |

## 6. Threading

- Capture/playback callbacks run on the host audio thread. No blocking I/O, allocation, or long work there.
- All state-mutating `AE_API` calls are thread-safe; engine locks internally.
- `ae_engine_process` drives background work; call from a 20 ms timer or dedicated thread.

## 7. Reconnect & migrate

- `AE_EVENT_DISCONNECTED` triggers automatic reconnect with backoff.
- `AE_EVENT_SERVER_MIGRATE` carries `new_server`; engine reconnects automatically and replays subscriptions.
- `AE_EVENT_KEY_ROTATED` is informational; encryption continues seamlessly.

Build UI around events, not polling. The engine keeps state; clients render it.
