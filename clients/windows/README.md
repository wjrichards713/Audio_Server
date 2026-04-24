# audio_client_windows

A minimal Windows console test client for the public-safety 2-way audio system. **First platform target** — exists to prove out the Rust Tokio server and the shared C `audio_engine` core library.

A full Win32 / WinUI 3 GUI client will follow once the protocol and core are stable. Until then, use this console app to:

- Smoke-test the server from a real Windows box.
- Validate the C engine's WASAPI integration end-to-end.
- Reproduce field issues by typing exactly what a dispatcher would click.

## Requirements

| Tool | Version |
|---|---|
| Windows | 10 (1903+) or 11 |
| Visual Studio | 2022 (17.6+), MSVC `cl.exe` 19.x |
| Windows 10/11 SDK | 10.0.19041+ |
| CMake | 3.20+ |
| vcpkg | recent (for libopus + openssl) |

## Dependencies via vcpkg

```powershell
git clone https://github.com/microsoft/vcpkg C:\vcpkg
C:\vcpkg\bootstrap-vcpkg.bat
C:\vcpkg\vcpkg install opus:x64-windows openssl:x64-windows
```

## Build

From the repo root:

```powershell
cmake -B build/windows-client -S clients/windows ^
      -G "Visual Studio 17 2022" -A x64 ^
      -DCMAKE_TOOLCHAIN_FILE=C:\vcpkg\scripts\buildsystems\vcpkg.cmake
cmake --build build/windows-client --config Release
```

Produces (in `build\windows-client\Release\`):
- `audio_engine.dll`
- `audio_client_windows.exe`
- `config.example.toml`

A post-build step copies the DLL + example config next to the exe.

## Configure

```powershell
cd build\windows-client\Release
copy config.example.toml config.toml
notepad config.toml
```

Required: `server_host`, `ws_port`, `jwt`, `device_id`. See `config.example.toml` for the full list.

- The JWT is **never logged**.
- Rotating log file: `.\audio-client-windows.log` (10 MB, keeps one prior).

## Run

```powershell
audio_client_windows.exe [channel_id ...]
```

Channels passed on the command line are subscribed immediately after auth (overriding `auto_subscribe` in config).

## Console commands

Type `:help` at the prompt for the live list. Summary:

| Command | Effect |
|---|---|
| `:subscribe <ch>` | Subscribe to channel id |
| `:unsubscribe <ch>` | Unsubscribe |
| `:gain <ch> <db>` | Per-channel gain in dB |
| `:mute <ch>` / `:unmute <ch>` | Per-channel mute toggle |
| `:solo <ch>` / `:unsolo <ch>` | Per-channel solo |
| `:prio <ch> normal\|monitor\|emergency_override` | Per-channel role |
| `:ptt_mode all\|others\|none` | PTT duck scope |
| `:sidetone <db>` | Sidetone level |
| `:mode mix\|forward` | Switch session mode at runtime |
| `:ptt <ch>` | Set the channel SPACE-bar PTT targets |
| `:release <ch>` | Release floor on a channel |
| `:ptt_target <ch>` | Same as `:ptt <ch>` |
| `:stats` | Dump engine stats |
| `:list` | List subscribed channels |
| `:quit` | Exit cleanly |

## SPACE-bar PTT

Hold SPACE to transmit on the channel set via `:ptt <ch>`. Release SPACE to release the floor. Focus loss also releases (we read bit 15 of `GetAsyncKeyState`).

## Audio path

- WASAPI shared mode, event-driven, 10 ms buffers, IEEE float32.
- Two dedicated threads (capture, render) at MMCSS "Pro Audio" class.
- Engine I/O via `ae_engine_write_capture` / `ae_engine_read_playback`.
- A 20 ms pump thread drives `ae_engine_process` for background work.
- Sample rate must be 48 kHz; the client refuses anything else.
- Stereo devices are downmixed (capture) and upmixed (render) without resampling.

## Telemetry

Every 500 ms the meter line shows: `rtt_ms / loss_pct / rx / tx / streams / subs / xruns` plus a `[PTT]` badge while transmitting. Wider per-channel peak meters land once the engine exposes a tap.

## Cleanup

Ctrl-C triggers `SetConsoleCtrlHandler`, which calls (in order):
`ae_engine_disconnect` → `wasapi.stop()` → join helper threads → `ae_engine_destroy`.
