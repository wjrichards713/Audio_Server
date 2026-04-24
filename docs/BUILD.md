# Build

Step-by-step build instructions for the server, the shared C core library, and the Windows reference client.

## 1. Server (Rust)

Toolchain pinned in `rust-toolchain.toml` to Rust 1.78.

```
rustup show             # installs the pinned toolchain
cargo build --release -p audio-server
```

Release profile uses fat LTO; clean build takes 3–6 minutes. For a debuggable release:

```
cargo build --profile release-with-debug -p audio-server
```

Run tests: `cargo test --workspace`

## 2. Core library (C)

CMake 3.16+. Deps: libopus + OpenSSL 1.1.1+.

### Linux / macOS

```
cmake -B build core
cmake --build build --config Release -j
```

System packages:
- Debian/Ubuntu: `sudo apt install cmake libopus-dev libssl-dev`
- Fedora/RHEL:   `sudo dnf install cmake opus-devel openssl-devel`
- macOS:         `brew install cmake opus openssl@3`

### Windows

```
vcpkg install opus:x64-windows openssl:x64-windows
cmake -B build core -DCMAKE_TOOLCHAIN_FILE=%VCPKG_ROOT%/scripts/buildsystems/vcpkg.cmake
cmake --build build --config Release
```

### Android

```
cmake -B build-arm64 core \
  -DCMAKE_TOOLCHAIN_FILE=$ANDROID_NDK/build/cmake/android.toolchain.cmake \
  -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-26
cmake --build build-arm64 --config Release
```

Repeat for `armeabi-v7a`, `x86_64`. Bundle `.so`s under `jniLibs/<abi>/`.

### iOS

Build as XCFramework via CMake's Xcode generator, or as a static archive consumed from a Swift Package wrapper. Target arm64 device + arm64-simulator.

## 3. Windows client

```
cmake -B build clients/windows \
    -DCMAKE_TOOLCHAIN_FILE=%VCPKG_ROOT%/scripts/buildsystems/vcpkg.cmake
cmake --build build --config Release
```

Output: `build\Release\audio_client.exe`. Requires `audio_engine.dll` on PATH.

## 4. Local smoke test

Minimal `docker-compose.yml`:

```yaml
services:
  redis:
    image: redis:7
    command: redis-server --port 6379
    ports: ["6379:6379"]
  sentinel:
    image: redis:7
    command: >
      sh -c '
        cat >/tmp/sentinel.conf <<EOF
        port 26379
        sentinel monitor mymaster redis 6379 1
        sentinel down-after-milliseconds mymaster 5000
        sentinel failover-timeout mymaster 10000
        EOF
        redis-sentinel /tmp/sentinel.conf'
    ports: ["26379:26379"]
    depends_on: [redis]
  fake-rest:
    image: mockserver/mockserver:latest
    ports: ["1080:1080"]
```

```
export REDIS_SENTINELS=localhost:26379
export REST_BASE_URL=http://localhost:1080
# …other vars from .env.example
cargo run --release -p audio-server
```

Server + core builds are independent: ship a server update without rebuilding clients (and vice versa) as long as `WIRE_SPEC.md` does not change.
