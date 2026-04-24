// wasapi_io.h — WASAPI capture + render wrapper.
#pragma once
#include <atomic>
#include <functional>
#include <string>
#include <thread>

struct IAudioClient;
struct IAudioCaptureClient;
struct IAudioRenderClient;
struct IMMDevice;

namespace aclient {

class WasapiIO {
public:
    using CaptureCb = std::function<void(const float* mono, int frames)>;
    using RenderCb  = std::function<void(float* mono, int frames)>;
    WasapiIO();
    ~WasapiIO();
    WasapiIO(const WasapiIO&) = delete;
    WasapiIO& operator=(const WasapiIO&) = delete;
    bool start(int sample_rate, int frame_block_ms, CaptureCb capture, RenderCb render);
    void stop();
    const std::string& last_error() const { return last_error_; }
private:
    void capture_thread();
    void render_thread();
    bool init_capture();
    bool init_render();
    IMMDevice*           cap_device_   = nullptr;
    IAudioClient*        cap_client_   = nullptr;
    IAudioCaptureClient* cap_capture_  = nullptr;
    void*                cap_event_    = nullptr;
    int                  cap_channels_ = 0;
    int                  cap_rate_     = 0;
    IMMDevice*           rnd_device_   = nullptr;
    IAudioClient*        rnd_client_   = nullptr;
    IAudioRenderClient*  rnd_render_   = nullptr;
    void*                rnd_event_    = nullptr;
    int                  rnd_channels_ = 0;
    int                  rnd_rate_     = 0;
    std::uint32_t        rnd_buffer_frames_ = 0;
    std::thread cap_thread_;
    std::thread rnd_thread_;
    std::atomic<bool> running_{false};
    CaptureCb capture_cb_;
    RenderCb  render_cb_;
    std::string last_error_;
};

} // namespace aclient
