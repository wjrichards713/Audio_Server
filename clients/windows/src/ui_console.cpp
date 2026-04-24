// ui_console.cpp — logger + command parser.
#include "ui_console.h"
#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <sstream>
#include <string>
#include <vector>
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

namespace aclient {
namespace {

constexpr std::uint64_t kRotateAtBytes = 10ull * 1024ull * 1024ull;

WORD color_attr(LogColor c) {
    switch (c) {
        case LogColor::Info:  return FOREGROUND_GREEN | FOREGROUND_BLUE | FOREGROUND_INTENSITY;
        case LogColor::Good:  return FOREGROUND_GREEN | FOREGROUND_INTENSITY;
        case LogColor::Warn:  return FOREGROUND_RED   | FOREGROUND_GREEN | FOREGROUND_INTENSITY;
        case LogColor::Bad:   return FOREGROUND_RED   | FOREGROUND_INTENSITY;
        case LogColor::Event: return FOREGROUND_RED   | FOREGROUND_BLUE  | FOREGROUND_INTENSITY;
        case LogColor::Meter: return FOREGROUND_BLUE  | FOREGROUND_INTENSITY;
        case LogColor::Plain: default: return FOREGROUND_RED | FOREGROUND_GREEN | FOREGROUND_BLUE;
    }
}

std::string timestamp() {
    std::time_t now = std::time(nullptr);
    std::tm t{}; localtime_s(&t, &now);
    char buf[32]; std::snprintf(buf, sizeof(buf), "%02d:%02d:%02d", t.tm_hour, t.tm_min, t.tm_sec);
    return buf;
}

std::string lower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c){ return static_cast<char>(std::tolower(c)); });
    return s;
}

std::vector<std::string> split_ws(const std::string& s) {
    std::vector<std::string> out;
    std::istringstream is(s); std::string tok;
    while (is >> tok) out.push_back(std::move(tok));
    return out;
}

bool parse_u32(const std::string& s, std::uint32_t& out) {
    try { size_t n = 0; unsigned long long v = std::stoull(s, &n, 0);
          if (n != s.size()) return false; if (v > 0xFFFFFFFFull) return false;
          out = static_cast<std::uint32_t>(v); return true; } catch (...) { return false; }
}
bool parse_float(const std::string& s, float& out) {
    try { size_t n = 0; out = std::stof(s, &n); return n == s.size(); } catch (...) { return false; }
}

} // namespace

Logger::Logger(const std::string& log_path) : path_(log_path) {
    con_out_ = GetStdHandle(STD_OUTPUT_HANDLE);
    DWORD mode = 0;
    color_ = GetConsoleMode(static_cast<HANDLE>(con_out_), &mode) != 0;
    if (!path_.empty()) {
        HANDLE h = CreateFileA(path_.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ, nullptr,
                               OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (h != INVALID_HANDLE_VALUE) {
            file_ = h;
            LARGE_INTEGER sz{}; GetFileSizeEx(h, &sz);
            bytes_written_ = static_cast<std::uint64_t>(sz.QuadPart);
        }
    }
}
Logger::~Logger() { if (file_) CloseHandle(static_cast<HANDLE>(file_)); }

void Logger::rotate_if_needed_unlocked() {
    if (bytes_written_ < kRotateAtBytes || !file_) return;
    CloseHandle(static_cast<HANDLE>(file_)); file_ = nullptr;
    std::string rotated = path_ + ".1";
    DeleteFileA(rotated.c_str());
    MoveFileA(path_.c_str(), rotated.c_str());
    HANDLE h = CreateFileA(path_.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ, nullptr,
                           CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h != INVALID_HANDLE_VALUE) { file_ = h; bytes_written_ = 0; }
}

void Logger::log(LogColor c, std::string_view msg) {
    std::lock_guard<std::mutex> lk(mu_);
    std::string line; line.reserve(msg.size() + 32);
    line += '['; line += timestamp(); line += "] ";
    line.append(msg.data(), msg.size()); line += "\r\n";
    if (con_out_) {
        CONSOLE_SCREEN_BUFFER_INFO prev{};
        bool got_prev = color_ && GetConsoleScreenBufferInfo(static_cast<HANDLE>(con_out_), &prev);
        if (color_) SetConsoleTextAttribute(static_cast<HANDLE>(con_out_), color_attr(c));
        DWORD written = 0;
        WriteFile(static_cast<HANDLE>(con_out_), line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
        if (got_prev) SetConsoleTextAttribute(static_cast<HANDLE>(con_out_), prev.wAttributes);
    }
    if (file_) {
        DWORD written = 0;
        WriteFile(static_cast<HANDLE>(file_), line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
        bytes_written_ += written;
        rotate_if_needed_unlocked();
    }
}

bool read_command_line(std::string& out, const std::atomic<bool>& running) {
    out.clear();
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    if (in == INVALID_HANDLE_VALUE) return false;
    DWORD mode = 0;
    if (!GetConsoleMode(in, &mode)) {
        char buf[1024];
        if (!std::fgets(buf, sizeof(buf), stdin)) return false;
        out = buf;
        if (!out.empty() && out.back() == '\n') out.pop_back();
        if (!out.empty() && out.back() == '\r') out.pop_back();
        return true;
    }
    SetConsoleMode(in, mode | ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT);
    while (running.load()) {
        DWORD wr = WaitForSingleObject(in, 250);
        if (!running.load()) return false;
        if (wr != WAIT_OBJECT_0) continue;
        wchar_t wbuf[1024]; DWORD n = 0;
        if (!ReadConsoleW(in, wbuf, 1023, &n, nullptr)) return false;
        if (n == 0) return false;
        int needed = WideCharToMultiByte(CP_UTF8, 0, wbuf, static_cast<int>(n), nullptr, 0, nullptr, nullptr);
        std::string s(static_cast<size_t>(needed), '\0');
        WideCharToMultiByte(CP_UTF8, 0, wbuf, static_cast<int>(n), s.data(), needed, nullptr, nullptr);
        while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
        out = std::move(s);
        return true;
    }
    return false;
}

bool dispatch_command(const std::string& line, AppState& app, Logger& log) {
    auto toks = split_ws(line);
    if (toks.empty()) return true;
    std::string cmd = lower(toks[0]);
    auto usage = [&](std::string_view msg){ log.warn(msg); };
    auto need_chan = [&](std::uint32_t& out) -> bool {
        if (toks.size() < 2) { usage("missing <channel_id>"); return false; }
        if (!parse_u32(toks[1], out)) { usage("invalid channel id"); return false; }
        return true;
    };

    if (cmd == ":quit" || cmd == ":q") { log.info("quit"); app.running.store(false); return false; }
    if (cmd == ":list") {
        std::lock_guard<std::mutex> lk(app.subs_mutex);
        std::ostringstream os; os << "subscribed (" << app.subscribed.size() << "):";
        for (auto id : app.subscribed) os << ' ' << id;
        log.info(os.str()); return true;
    }
    if (cmd == ":stats") {
        auto s = ae_engine_get_stats(app.engine);
        std::ostringstream os;
        os << "stats: rtt=" << s.rtt_ms << "ms jitter=" << s.jitter_ms << "ms loss=" << s.packet_loss_pct
           << "% sent=" << s.packets_sent << " recv=" << s.packets_received << " drop=" << s.packets_dropped
           << " streams=" << s.active_streams << " subs=" << s.subscribed_channels << " xruns=" << s.buffer_underruns
           << " mode=" << (s.mode == AE_MODE_MIX ? "mix" : "forward");
        log.info(os.str()); return true;
    }
    if (cmd == ":subscribe") {
        std::uint32_t id = 0; if (!need_chan(id)) return true;
        auto rc = ae_engine_subscribe(app.engine, id, 0.0f, false, false, AE_ROLE_NORMAL);
        if (rc == AE_OK) { std::lock_guard<std::mutex> lk(app.subs_mutex); app.subscribed.insert(id); log.good("subscribe " + std::to_string(id)); }
        else log.error("subscribe failed rc=" + std::to_string(rc));
        return true;
    }
    if (cmd == ":unsubscribe") {
        std::uint32_t id = 0; if (!need_chan(id)) return true;
        auto rc = ae_engine_unsubscribe(app.engine, id);
        if (rc == AE_OK) { std::lock_guard<std::mutex> lk(app.subs_mutex); app.subscribed.erase(id); log.info("unsubscribe " + std::to_string(id)); }
        else log.error("unsubscribe failed rc=" + std::to_string(rc));
        return true;
    }
    if (cmd == ":gain") {
        if (toks.size() < 3) { usage(":gain <channel_id> <db>"); return true; }
        std::uint32_t id = 0; float db = 0.0f;
        if (!parse_u32(toks[1], id) || !parse_float(toks[2], db)) { usage("bad args"); return true; }
        auto rc = ae_engine_set_channel_gain_db(app.engine, id, db);
        log.info("gain ch=" + std::to_string(id) + " db=" + std::to_string(db) + " rc=" + std::to_string(rc));
        return true;
    }
    if (cmd == ":mute" || cmd == ":unmute") {
        std::uint32_t id = 0; if (!need_chan(id)) return true;
        bool mute = (cmd == ":mute");
        auto rc = ae_engine_set_channel_muted(app.engine, id, mute);
        log.info((mute?"mute ":"unmute ") + std::to_string(id) + " rc=" + std::to_string(rc));
        return true;
    }
    if (cmd == ":solo" || cmd == ":unsolo") {
        std::uint32_t id = 0; if (!need_chan(id)) return true;
        bool solo = (cmd == ":solo");
        auto rc = ae_engine_set_channel_solo(app.engine, id, solo);
        log.info((solo?"solo ":"unsolo ") + std::to_string(id) + " rc=" + std::to_string(rc));
        return true;
    }
    if (cmd == ":prio") {
        if (toks.size() < 3) { usage(":prio <ch> monitor|normal|emergency_override"); return true; }
        std::uint32_t id = 0;
        if (!parse_u32(toks[1], id)) { usage("bad channel id"); return true; }
        std::string r = lower(toks[2]);
        ae_channel_role_t role;
        if      (r == "monitor")            role = AE_ROLE_MONITOR;
        else if (r == "normal")             role = AE_ROLE_NORMAL;
        else if (r == "emergency_override") role = AE_ROLE_EMERGENCY_OVERRIDE;
        else { usage("unknown role"); return true; }
        auto rc = ae_engine_set_channel_role(app.engine, id, role);
        log.info("prio ch=" + std::to_string(id) + " role=" + r + " rc=" + std::to_string(rc));
        return true;
    }
    if (cmd == ":ptt_mode") {
        if (toks.size() < 2) { usage(":ptt_mode all|others|none"); return true; }
        std::string m = lower(toks[1]);
        ae_ptt_mute_scope_t s;
        if      (m == "all")    s = AE_PTT_MUTE_ALL;
        else if (m == "others") s = AE_PTT_MUTE_OTHERS;
        else if (m == "none")   s = AE_PTT_MUTE_NONE;
        else { usage("unknown ptt_mode"); return true; }
        auto rc = ae_engine_set_ptt_mute_scope(app.engine, s);
        log.info("ptt_mode=" + m + " rc=" + std::to_string(rc));
        return true;
    }
    if (cmd == ":sidetone") {
        if (toks.size() < 2) { usage(":sidetone <db>"); return true; }
        float db = 0.0f;
        if (!parse_float(toks[1], db)) { usage("bad db"); return true; }
        auto rc = ae_engine_set_sidetone_db(app.engine, db);
        log.info("sidetone=" + std::to_string(db) + "dB rc=" + std::to_string(rc));
        return true;
    }
    if (cmd == ":mode") {
        if (toks.size() < 2) { usage(":mode mix|forward"); return true; }
        std::string m = lower(toks[1]);
        ae_session_mode_t sm;
        if      (m == "mix")     sm = AE_MODE_MIX;
        else if (m == "forward") sm = AE_MODE_FORWARD;
        else { usage("unknown mode"); return true; }
        auto rc = ae_engine_set_session_mode(app.engine, sm);
        log.info("mode=" + m + " rc=" + std::to_string(rc));
        return true;
    }
    if (cmd == ":ptt") {
        std::uint32_t id = 0; if (!need_chan(id)) return true;
        app.ptt_target.store(id);
        auto rc = ae_engine_floor_request(app.engine, id, AE_PRIO_NORMAL);
        if (rc == AE_OK) { app.ptt_active.store(true); log.good("PTT request ch=" + std::to_string(id)); }
        else log.error("PTT request failed rc=" + std::to_string(rc));
        return true;
    }
    if (cmd == ":release") {
        std::uint32_t id = 0; if (!need_chan(id)) return true;
        auto rc = ae_engine_floor_release(app.engine, id);
        app.ptt_active.store(false);
        log.info("PTT release ch=" + std::to_string(id) + " rc=" + std::to_string(rc));
        return true;
    }
    if (cmd == ":ptt_target") {
        std::uint32_t id = 0; if (!need_chan(id)) return true;
        app.ptt_target.store(id);
        log.info("space-bar PTT target = " + std::to_string(id));
        return true;
    }
    if (cmd == ":help" || cmd == ":?") {
        log.info("commands: :subscribe :unsubscribe :gain :mute :unmute :solo :unsolo :prio :ptt_mode :sidetone :mode :ptt :release :ptt_target :stats :list :quit");
        return true;
    }
    log.warn("unknown command '" + toks[0] + "' — type :help");
    return true;
}

} // namespace aclient
