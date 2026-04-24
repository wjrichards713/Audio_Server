// ui_console.h — line-based console UI + command dispatcher.
#pragma once
#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <string_view>
#include "app_state.h"

namespace aclient {

enum class LogColor { Plain, Info, Good, Warn, Bad, Event, Meter };

class Logger {
public:
    explicit Logger(const std::string& log_path);
    ~Logger();
    Logger(const Logger&) = delete;
    Logger& operator=(const Logger&) = delete;
    void log(LogColor c, std::string_view msg);
    void info (std::string_view m) { log(LogColor::Info,  m); }
    void good (std::string_view m) { log(LogColor::Good,  m); }
    void warn (std::string_view m) { log(LogColor::Warn,  m); }
    void error(std::string_view m) { log(LogColor::Bad,   m); }
    void event(std::string_view m) { log(LogColor::Event, m); }
    void meter(std::string_view m) { log(LogColor::Meter, m); }
private:
    void rotate_if_needed_unlocked();
    std::mutex mu_;
    std::string path_;
    void* file_ = nullptr;
    std::uint64_t bytes_written_ = 0;
    void* con_out_ = nullptr;
    bool  color_   = false;
};

bool read_command_line(std::string& out, const std::atomic<bool>& running);
bool dispatch_command(const std::string& line, AppState& app, Logger& log);

} // namespace aclient
