// main.cpp — Windows console test client for the audio_engine library.
#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <functional>
#include <sstream>
#include <string>
#include <thread>
#include <vector>
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include "audio_engine.h"
#include "app_state.h"
#include "ui_console.h"
#include "wasapi_io.h"
using namespace aclient;

static AppState* g_app = nullptr;
static Logger*   g_log = nullptr;

static std::string strip(std::string s) {
    auto not_space = [](unsigned char c){ return !std::isspace(c); };
    s.erase(s.begin(), std::find_if(s.begin(), s.end(), not_space));
    s.erase(std::find_if(s.rbegin(), s.rend(), not_space).base(), s.end());
    return s;
}

static bool load_config(const std::string& path, Config& cfg, std::string& err) {
    std::ifstream f(path);
    if (!f) { err = "cannot open config: " + path; return false; }
    std::string line;
    while (std::getline(f, line)) {
        auto hash = line.find('#');
        if (hash != std::string::npos) line.erase(hash);
        line = strip(line);
        if (line.empty()) continue;
        auto eq = line.find('=');
        if (eq == std::string::npos) continue;
        std::string key = strip(line.substr(0, eq));
        std::string val = strip(line.substr(eq + 1));
        if (val.size() >= 2 && val.front() == '"' && val.back() == '"')
            val = val.substr(1, val.size() - 2);
        if      (key == "server_host")   cfg.server_host = val;
        else if (key == "ws_port")       cfg.ws_port     = std::atoi(val.c_str());
        else if (key == "jwt")           cfg.jwt         = val;
        else if (key == "device_id")     cfg.device_id   = val;
        else if (key == "session_mode")  cfg.session_mode = (val == "forward") ? AE_MODE_FORWARD : AE_MODE_MIX;
        else if (key == "ptt_mute_scope") {
            if      (val == "all")    cfg.ptt_mute_scope = AE_PTT_MUTE_ALL;
            else if (val == "none")   cfg.ptt_mute_scope = AE_PTT_MUTE_NONE;
            else                      cfg.ptt_mute_scope = AE_PTT_MUTE_OTHERS;
        } else if (key == "sidetone_db") cfg.sidetone_db = static_cast<float>(std::atof(val.c_str()));
        else if (key == "auto_subscribe") {
            std::istringstream is(val); std::string tok;
            while (std::getline(is, tok, ',')) {
                tok = strip(tok);
                if (!tok.empty()) cfg.auto_subscribe.push_back(static_cast<std::uint32_t>(std::strtoul(tok.c_str(), nullptr, 0)));
            }
        }
    }
    if (cfg.server_host.empty()) { err = "server_host missing"; return false; }
    if (cfg.device_id.empty())   { err = "device_id missing";   return false; }
    if (cfg.jwt.empty())         { err = "jwt missing";         return false; }
    return true;
}

static const char* ev_name(ae_event_type_t t) {
    switch (t) {
        case AE_EVENT_CONNECTED: return "CONNECTED"; case AE_EVENT_DISCONNECTED: return "DISCONNECTED";
        case AE_EVENT_AUTHED: return "AUTHED"; case AE_EVENT_SUBSCRIBED: return "SUBSCRIBED";
        case AE_EVENT_UNSUBSCRIBED: return "UNSUBSCRIBED"; case AE_EVENT_USER_JOINED: return "USER_JOINED";
        case AE_EVENT_USER_LEFT: return "USER_LEFT"; case AE_EVENT_USER_SPEAKING: return "USER_SPEAKING";
        case AE_EVENT_USER_STOPPED: return "USER_STOPPED"; case AE_EVENT_FLOOR_GRANTED: return "FLOOR_GRANTED";
        case AE_EVENT_FLOOR_DENIED: return "FLOOR_DENIED"; case AE_EVENT_FLOOR_RELEASED: return "FLOOR_RELEASED";
        case AE_EVENT_FLOOR_REVOKED: return "FLOOR_REVOKED"; case AE_EVENT_FLOOR_QUEUED: return "FLOOR_QUEUED";
        case AE_EVENT_KEY_ROTATED: return "KEY_ROTATED"; case AE_EVENT_SERVER_MIGRATE: return "SERVER_MIGRATE";
        case AE_EVENT_ERROR: return "ERROR";
    }
    return "?";
}

static void on_engine_event(const ae_event_t* ev, void* ud) {
    auto* app = static_cast<AppState*>(ud);
    if (!ev || !app || !g_log) return;
    switch (ev->type) {
        case AE_EVENT_CONNECTED:    app->connected.store(true);  break;
        case AE_EVENT_DISCONNECTED: app->connected.store(false); app->authed.store(false); break;
        case AE_EVENT_AUTHED:       app->authed.store(true);     break;
        case AE_EVENT_SUBSCRIBED:   { std::lock_guard<std::mutex> lk(app->subs_mutex); app->subscribed.insert(ev->channel_id); } break;
        case AE_EVENT_UNSUBSCRIBED: { std::lock_guard<std::mutex> lk(app->subs_mutex); app->subscribed.erase(ev->channel_id); }  break;
        case AE_EVENT_FLOOR_RELEASED: case AE_EVENT_FLOOR_REVOKED: case AE_EVENT_FLOOR_DENIED:
            app->ptt_active.store(false); break;
        default: break;
    }
    std::ostringstream os;
    os << "[event] " << ev_name(ev->type) << " ch=" << ev->channel_id << " client=" << ev->client_id;
    if (ev->user_name && *ev->user_name) os << " user=" << ev->user_name;
    if (ev->message   && *ev->message)   os << " msg=\"" << ev->message << '"';
    if (ev->type == AE_EVENT_FLOOR_QUEUED) os << " pos=" << ev->queue_position;
    if (ev->type == AE_EVENT_SERVER_MIGRATE && ev->new_server) os << " new_server=" << ev->new_server;
    g_log->event(os.str());
}

static void on_engine_log(ae_log_level_t level, const char* msg, void*) {
    if (!g_log || !msg) return;
    switch (level) {
        case AE_LOG_ERROR: g_log->error(std::string("engine: ") + msg); break;
        case AE_LOG_WARN:  g_log->warn (std::string("engine: ") + msg); break;
        case AE_LOG_INFO:  g_log->info (std::string("engine: ") + msg); break;
        case AE_LOG_DEBUG: break;
    }
}

static BOOL WINAPI console_ctrl_handler(DWORD type) {
    if (type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT || type == CTRL_CLOSE_EVENT) {
        if (g_app) g_app->running.store(false);
        if (g_log) g_log->warn("ctrl-C received; shutting down");
        return TRUE;
    }
    return FALSE;
}

static void ptt_poller(AppState& app, Logger& log) {
    bool prev_down = false;
    while (app.running.load()) {
        SHORT s = GetAsyncKeyState(VK_SPACE);
        bool down = (s & 0x8000) != 0;
        std::uint32_t target = app.ptt_target.load();
        if (target != 0 && app.authed.load()) {
            if (down && !prev_down) {
                auto rc = ae_engine_floor_request(app.engine, target, AE_PRIO_NORMAL);
                if (rc == AE_OK) { app.ptt_active.store(true); log.good("[space] PTT request ch=" + std::to_string(target)); }
                else log.error("[space] PTT request failed rc=" + std::to_string(rc));
            } else if (!down && prev_down) {
                ae_engine_floor_release(app.engine, target);
                app.ptt_active.store(false);
                log.info("[space] PTT release ch=" + std::to_string(target));
            }
        }
        prev_down = down;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    std::uint32_t target = app.ptt_target.load();
    if (target != 0 && app.ptt_active.load()) ae_engine_floor_release(app.engine, target);
}

static void process_pump(AppState& app) {
    while (app.running.load()) { ae_engine_process(app.engine); std::this_thread::sleep_for(std::chrono::milliseconds(20)); }
}

static void meter_tick(AppState& app, Logger& log) {
    auto next = std::chrono::steady_clock::now();
    while (app.running.load()) {
        next += std::chrono::milliseconds(500);
        std::this_thread::sleep_until(next);
        if (!app.running.load()) break;
        if (!app.engine) continue;
        auto s = ae_engine_get_stats(app.engine);
        std::ostringstream os;
        os << "meter | rtt=" << s.rtt_ms << "ms loss=" << s.packet_loss_pct
           << "% rx=" << s.packets_received << " tx=" << s.packets_sent
           << " streams=" << s.active_streams << " subs=" << s.subscribed_channels
           << " xruns=" << s.buffer_underruns << (app.ptt_active.load() ? " [PTT]" : "");
        log.meter(os.str());
    }
}

static void on_wasapi_capture(AppState& app, const float* mono, int frames) {
    if (!app.engine) return;
    ae_engine_write_capture(app.engine, mono, frames);
}
static void on_wasapi_render(AppState& app, float* mono, int frames) {
    if (!app.engine) { std::memset(mono, 0, frames * sizeof(float)); return; }
    int got = ae_engine_read_playback(app.engine, mono, frames);
    if (got < frames) std::memset(mono + got, 0, (frames - got) * sizeof(float));
}

static void print_banner(Logger& log, const Config& cfg) {
    std::ostringstream os;
    os << "audio_client_windows starting — host=" << cfg.server_host << " port=" << cfg.ws_port
       << " device_id=" << cfg.device_id
       << " mode=" << (cfg.session_mode == AE_MODE_MIX ? "mix" : "forward")
       << " sidetone=" << cfg.sidetone_db << "dB";
    log.info(os.str());
}
static void usage() {
    std::fprintf(stderr,
        "Usage: audio_client_windows.exe [--config PATH] [channel_id ...]\n"
        "  --config PATH   TOML config (default: ./config.toml)\n"
        "  channel_id ...  optional channels to auto-subscribe\n"
        "Interactive: type :help at the prompt.\n");
}

int main(int argc, char** argv) {
    std::string config_path = "config.toml";
    std::vector<std::uint32_t> cli_channels;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--config" && i + 1 < argc) config_path = argv[++i];
        else if (a == "-h" || a == "--help") { usage(); return 0; }
        else {
            char* end = nullptr;
            unsigned long v = std::strtoul(a.c_str(), &end, 0);
            if (end && *end == 0) cli_channels.push_back(static_cast<std::uint32_t>(v));
            else { std::fprintf(stderr, "bad arg: %s\n", a.c_str()); usage(); return 2; }
        }
    }

    Logger log("audio-client-windows.log");
    g_log = &log;

    Config cfg; std::string err;
    if (!load_config(config_path, cfg, err)) { log.error(err); return 1; }
    print_banner(log, cfg);

    ae_config_t ec = ae_config_default();
    ec.session_mode = cfg.session_mode;
    ec.ptt_mute_scope = cfg.ptt_mute_scope;
    ec.sidetone_db = cfg.sidetone_db;

    ae_engine_t* eng = ae_engine_create(&ec);
    if (!eng) { log.error("ae_engine_create failed"); return 1; }

    AppState app; app.engine = eng; g_app = &app;

    ae_log_set_callback(on_engine_log, nullptr);
    ae_log_set_level(AE_LOG_INFO);
    ae_engine_set_event_callback(eng, on_engine_event, &app);

    SetConsoleCtrlHandler(console_ctrl_handler, TRUE);

    WasapiIO wasapi;
    if (!wasapi.start(AE_SAMPLE_RATE, 10,
            [&](const float* m, int f){ on_wasapi_capture(app, m, f); },
            [&](float* m, int f){ on_wasapi_render(app, m, f); })) {
        log.error("WASAPI init failed: " + wasapi.last_error());
        ae_engine_destroy(eng); return 1;
    }
    log.good("WASAPI started (shared, 48 kHz, event-driven, 10 ms)");

    auto rc = ae_engine_connect(eng, cfg.server_host.c_str(), cfg.ws_port, cfg.jwt.c_str(), cfg.device_id.c_str());
    if (rc != AE_OK) { log.error("connect failed rc=" + std::to_string(rc)); wasapi.stop(); ae_engine_destroy(eng); return 1; }
    log.good("connect OK; waiting for AUTHED event...");

    std::thread th_process(process_pump, std::ref(app));
    std::thread th_meter  (meter_tick,   std::ref(app), std::ref(log));
    std::thread th_ptt    (ptt_poller,   std::ref(app), std::ref(log));

    auto subs = !cli_channels.empty() ? cli_channels : cfg.auto_subscribe;
    if (!subs.empty()) {
        for (int i = 0; i < 50 && !app.authed.load() && app.running.load(); ++i)
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        for (auto id : subs) {
            auto r = ae_engine_subscribe(eng, id, 0.0f, false, false, AE_ROLE_NORMAL);
            if (r == AE_OK) {
                std::lock_guard<std::mutex> lk(app.subs_mutex);
                app.subscribed.insert(id);
                log.good("auto-subscribe " + std::to_string(id));
            } else log.error("auto-subscribe " + std::to_string(id) + " failed rc=" + std::to_string(r));
        }
        if (!subs.empty()) app.ptt_target.store(subs.front());
    }

    log.info("type :help for commands; SPACE = PTT on ptt_target channel");

    std::string line;
    while (app.running.load()) {
        std::printf("> "); std::fflush(stdout);
        if (!read_command_line(line, app.running)) break;
        if (!dispatch_command(line, app, log)) break;
    }

    log.info("shutting down...");
    ae_engine_disconnect(eng);
    wasapi.stop();
    app.running.store(false);
    if (th_process.joinable()) th_process.join();
    if (th_meter.joinable())   th_meter.join();
    if (th_ptt.joinable())     th_ptt.join();
    ae_engine_destroy(eng);
    g_app = nullptr; g_log = nullptr;
    log.good("bye");
    return 0;
}
