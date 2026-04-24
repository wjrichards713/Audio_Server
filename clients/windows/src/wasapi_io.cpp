// wasapi_io.cpp — WASAPI shared-mode event-driven capture+render.
#include "wasapi_io.h"
#include <algorithm>
#include <cstring>
#include <sstream>
#include <string>
#include <utility>
#include <vector>
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <avrt.h>
#include <functiondiscoverykeys_devpkey.h>

namespace aclient {
namespace {

constexpr REFERENCE_TIME kHnsPerMs = 10000;

std::string hr_to_string(HRESULT hr) { std::ostringstream os; os << "hr=0x" << std::hex << static_cast<unsigned>(hr); return os.str(); }

bool extract_rate_channels(const WAVEFORMATEX* wf, int& rate, int& channels) {
    if (!wf) return false;
    rate = (int)wf->nSamplesPerSec;
    channels = (int)wf->nChannels;
    if (wf->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) return wf->wBitsPerSample == 32;
    if (wf->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
        const auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(wf);
        return ext->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT && wf->wBitsPerSample == 32;
    }
    return false;
}

HANDLE boost_thread_for_pro_audio() { DWORD ix = 0; return AvSetMmThreadCharacteristicsW(L"Pro Audio", &ix); }

} // namespace

WasapiIO::WasapiIO() = default;
WasapiIO::~WasapiIO() { stop(); }

bool WasapiIO::start(int sample_rate, int, CaptureCb capture, RenderCb render) {
    if (sample_rate != 48000) { last_error_ = "engine requires 48 kHz; got " + std::to_string(sample_rate); return false; }
    capture_cb_ = std::move(capture); render_cb_ = std::move(render);
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) { last_error_ = "CoInitializeEx " + hr_to_string(hr); return false; }
    if (!init_capture()) return false;
    if (!init_render())  return false;
    running_.store(true);
    cap_thread_ = std::thread(&WasapiIO::capture_thread, this);
    rnd_thread_ = std::thread(&WasapiIO::render_thread,  this);
    return true;
}

void WasapiIO::stop() {
    if (!running_.exchange(false)) return;
    if (cap_event_) SetEvent(static_cast<HANDLE>(cap_event_));
    if (rnd_event_) SetEvent(static_cast<HANDLE>(rnd_event_));
    if (cap_thread_.joinable()) cap_thread_.join();
    if (rnd_thread_.joinable()) rnd_thread_.join();
    if (cap_capture_) { cap_capture_->Release(); cap_capture_ = nullptr; }
    if (cap_client_)  { cap_client_->Stop(); cap_client_->Release(); cap_client_ = nullptr; }
    if (cap_device_)  { cap_device_->Release(); cap_device_ = nullptr; }
    if (cap_event_)   { CloseHandle(static_cast<HANDLE>(cap_event_)); cap_event_ = nullptr; }
    if (rnd_render_)  { rnd_render_->Release(); rnd_render_ = nullptr; }
    if (rnd_client_)  { rnd_client_->Stop(); rnd_client_->Release(); rnd_client_ = nullptr; }
    if (rnd_device_)  { rnd_device_->Release(); rnd_device_ = nullptr; }
    if (rnd_event_)   { CloseHandle(static_cast<HANDLE>(rnd_event_)); rnd_event_ = nullptr; }
}

bool WasapiIO::init_capture() {
    IMMDeviceEnumerator* enumr = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumr));
    if (FAILED(hr)) { last_error_ = "capture: MMDeviceEnumerator " + hr_to_string(hr); return false; }
    hr = enumr->GetDefaultAudioEndpoint(eCapture, eCommunications, &cap_device_);
    if (FAILED(hr)) hr = enumr->GetDefaultAudioEndpoint(eCapture, eConsole, &cap_device_);
    enumr->Release();
    if (FAILED(hr)) { last_error_ = "capture: GetDefaultAudioEndpoint " + hr_to_string(hr); return false; }
    hr = cap_device_->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&cap_client_));
    if (FAILED(hr)) { last_error_ = "capture: Activate " + hr_to_string(hr); return false; }
    WAVEFORMATEX* mix = nullptr;
    hr = cap_client_->GetMixFormat(&mix);
    if (FAILED(hr) || !mix) { last_error_ = "capture: GetMixFormat " + hr_to_string(hr); return false; }
    int rate = 0, channels = 0;
    if (!extract_rate_channels(mix, rate, channels)) { CoTaskMemFree(mix); last_error_ = "capture: not IEEE float32"; return false; }
    if (rate != 48000) { CoTaskMemFree(mix); last_error_ = "capture: " + std::to_string(rate) + " Hz; need 48000"; return false; }
    if (channels != 1 && channels != 2) { CoTaskMemFree(mix); last_error_ = "capture: bad channel count"; return false; }
    cap_rate_ = rate; cap_channels_ = channels;
    REFERENCE_TIME buf_hns = 10 * kHnsPerMs;
    hr = cap_client_->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, buf_hns, 0, mix, nullptr);
    CoTaskMemFree(mix);
    if (FAILED(hr)) { last_error_ = "capture: Initialize " + hr_to_string(hr); return false; }
    cap_event_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!cap_event_) { last_error_ = "capture: CreateEvent failed"; return false; }
    hr = cap_client_->SetEventHandle(static_cast<HANDLE>(cap_event_));
    if (FAILED(hr)) { last_error_ = "capture: SetEventHandle " + hr_to_string(hr); return false; }
    hr = cap_client_->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&cap_capture_));
    if (FAILED(hr)) { last_error_ = "capture: GetService " + hr_to_string(hr); return false; }
    hr = cap_client_->Start();
    if (FAILED(hr)) { last_error_ = "capture: Start " + hr_to_string(hr); return false; }
    return true;
}

bool WasapiIO::init_render() {
    IMMDeviceEnumerator* enumr = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumr));
    if (FAILED(hr)) { last_error_ = "render: MMDeviceEnumerator " + hr_to_string(hr); return false; }
    hr = enumr->GetDefaultAudioEndpoint(eRender, eCommunications, &rnd_device_);
    if (FAILED(hr)) hr = enumr->GetDefaultAudioEndpoint(eRender, eConsole, &rnd_device_);
    enumr->Release();
    if (FAILED(hr)) { last_error_ = "render: GetDefaultAudioEndpoint " + hr_to_string(hr); return false; }
    hr = rnd_device_->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&rnd_client_));
    if (FAILED(hr)) { last_error_ = "render: Activate " + hr_to_string(hr); return false; }
    WAVEFORMATEX* mix = nullptr;
    hr = rnd_client_->GetMixFormat(&mix);
    if (FAILED(hr) || !mix) { last_error_ = "render: GetMixFormat " + hr_to_string(hr); return false; }
    int rate = 0, channels = 0;
    if (!extract_rate_channels(mix, rate, channels)) { CoTaskMemFree(mix); last_error_ = "render: not IEEE float32"; return false; }
    if (rate != 48000) { CoTaskMemFree(mix); last_error_ = "render: " + std::to_string(rate) + " Hz; need 48000"; return false; }
    if (channels != 1 && channels != 2) { CoTaskMemFree(mix); last_error_ = "render: bad channel count"; return false; }
    rnd_rate_ = rate; rnd_channels_ = channels;
    REFERENCE_TIME buf_hns = 10 * kHnsPerMs;
    hr = rnd_client_->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, buf_hns, 0, mix, nullptr);
    CoTaskMemFree(mix);
    if (FAILED(hr)) { last_error_ = "render: Initialize " + hr_to_string(hr); return false; }
    rnd_event_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!rnd_event_) { last_error_ = "render: CreateEvent failed"; return false; }
    hr = rnd_client_->SetEventHandle(static_cast<HANDLE>(rnd_event_));
    if (FAILED(hr)) { last_error_ = "render: SetEventHandle " + hr_to_string(hr); return false; }
    hr = rnd_client_->GetService(__uuidof(IAudioRenderClient), reinterpret_cast<void**>(&rnd_render_));
    if (FAILED(hr)) { last_error_ = "render: GetService " + hr_to_string(hr); return false; }
    hr = rnd_client_->GetBufferSize(&rnd_buffer_frames_);
    if (FAILED(hr)) { last_error_ = "render: GetBufferSize " + hr_to_string(hr); return false; }
    BYTE* p = nullptr;
    hr = rnd_render_->GetBuffer(rnd_buffer_frames_, &p);
    if (SUCCEEDED(hr)) {
        std::memset(p, 0, rnd_buffer_frames_ * rnd_channels_ * sizeof(float));
        rnd_render_->ReleaseBuffer(rnd_buffer_frames_, AUDCLNT_BUFFERFLAGS_SILENT);
    }
    hr = rnd_client_->Start();
    if (FAILED(hr)) { last_error_ = "render: Start " + hr_to_string(hr); return false; }
    return true;
}

void WasapiIO::capture_thread() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    HANDLE mmcss = boost_thread_for_pro_audio();
    std::vector<float> mono; mono.reserve(960);
    while (running_.load()) {
        DWORD wr = WaitForSingleObject(static_cast<HANDLE>(cap_event_), 200);
        if (!running_.load()) break;
        if (wr != WAIT_OBJECT_0) continue;
        for (;;) {
            UINT32 packet_frames = 0;
            HRESULT hr = cap_capture_->GetNextPacketSize(&packet_frames);
            if (FAILED(hr) || packet_frames == 0) break;
            BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0;
            hr = cap_capture_->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
            if (FAILED(hr)) break;
            const bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
            mono.resize(frames);
            if (silent || !data) std::fill(mono.begin(), mono.end(), 0.0f);
            else if (cap_channels_ == 1) std::memcpy(mono.data(), data, frames * sizeof(float));
            else {
                const float* src = reinterpret_cast<const float*>(data);
                for (UINT32 i = 0; i < frames; ++i) mono[i] = 0.5f * (src[2*i] + src[2*i + 1]);
            }
            if (capture_cb_) capture_cb_(mono.data(), static_cast<int>(frames));
            cap_capture_->ReleaseBuffer(frames);
        }
    }
    if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
    CoUninitialize();
}

void WasapiIO::render_thread() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    HANDLE mmcss = boost_thread_for_pro_audio();
    std::vector<float> mono;
    while (running_.load()) {
        DWORD wr = WaitForSingleObject(static_cast<HANDLE>(rnd_event_), 200);
        if (!running_.load()) break;
        if (wr != WAIT_OBJECT_0) continue;
        UINT32 padding = 0;
        if (FAILED(rnd_client_->GetCurrentPadding(&padding))) continue;
        UINT32 to_write = rnd_buffer_frames_ - padding;
        if (to_write == 0) continue;
        BYTE* out = nullptr;
        if (FAILED(rnd_render_->GetBuffer(to_write, &out))) continue;
        mono.resize(to_write);
        if (render_cb_) render_cb_(mono.data(), static_cast<int>(to_write));
        else std::fill(mono.begin(), mono.end(), 0.0f);
        if (rnd_channels_ == 1) std::memcpy(out, mono.data(), to_write * sizeof(float));
        else {
            float* dst = reinterpret_cast<float*>(out);
            for (UINT32 i = 0; i < to_write; ++i) { dst[2*i] = mono[i]; dst[2*i + 1] = mono[i]; }
        }
        rnd_render_->ReleaseBuffer(to_write, 0);
    }
    if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
    CoUninitialize();
}

} // namespace aclient
