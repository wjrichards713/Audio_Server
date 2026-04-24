// app_state.h — shared cross-thread state.
#pragma once
#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <unordered_set>
#include <vector>
#include "audio_engine.h"

namespace aclient {

struct Config {
    std::string server_host;
    int         ws_port = 443;
    std::string jwt;
    std::string device_id;
    ae_session_mode_t   session_mode    = AE_MODE_MIX;
    ae_ptt_mute_scope_t ptt_mute_scope  = AE_PTT_MUTE_OTHERS;
    float               sidetone_db     = -20.0f;
    std::vector<std::uint32_t> auto_subscribe;
};

struct AppState {
    ae_engine_t *engine = nullptr;
    std::atomic<bool> running{true};
    std::atomic<bool> connected{false};
    std::atomic<bool> authed{false};
    std::mutex                                subs_mutex;
    std::unordered_set<std::uint32_t>         subscribed;
    std::atomic<std::uint32_t> ptt_target{0};
    std::atomic<bool> ptt_active{false};
};

} // namespace aclient
