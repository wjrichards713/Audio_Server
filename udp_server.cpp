#include <boost/asio.hpp>
#include <boost/asio/ip/udp.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/version.hpp>
#include <boost/json.hpp>
#include <iostream>
#include <unordered_map>
#include <thread>
#include <vector>
#include <mutex>

using namespace boost::asio;
using namespace boost::asio::ip;
namespace http = boost::beast::http;
namespace json = boost::json;

const int API_PORT = 3000;
const std::vector<int> available_ports = {8000, 8001};
std::unordered_map<int, udp::endpoint> port_registrar;
std::unordered_map<std::string, std::vector<int>> channel_ports = {
    {"555", {8000, 8001}},
    {"666", {8001}}
};
std::mutex registrar_mutex;

void handle_udp_server(io_context& io, int port) {
    udp::socket socket(io, udp::endpoint(udp::v4(), port));
    char data[1024];
    
    for (;;) {
        udp::endpoint sender_endpoint;
        boost::system::error_code ec;
        size_t length = socket.receive_from(buffer(data), sender_endpoint, 0, ec);
        if (ec) continue;

        std::string message(data, length);
        try {
            json::value parsed = json::parse(message);
            std::string channel_id = std::string(parsed.at("channel_id").as_string().data());

            std::lock_guard<std::mutex> lock(registrar_mutex);
            port_registrar[port] = sender_endpoint;

            for (int p : channel_ports[channel_id]) {
                if (p != port) {
                    socket.send_to(buffer(message), udp::endpoint(address::from_string("127.0.0.1"), p), 0, ec);
                }
            }
        } catch (...) {
            std::lock_guard<std::mutex> lock(registrar_mutex);
            port_registrar[port] = sender_endpoint;
        }
    }
}

void handle_http_request(tcp::socket& socket) {
    boost::beast::flat_buffer buffer;
    http::request<http::string_body> req;
    http::read(socket, buffer, req);

    if (req.method() == http::verb::get && req.target() == "/audioserver-port") {
        json::object response_json;
        {
            std::lock_guard<std::mutex> lock(registrar_mutex);
            for (int port : available_ports) {
                if (port_registrar.find(port) == port_registrar.end()) {
                    response_json["udp_port"] = port;
                    break;
                }
            }
        }

        if (response_json.empty()) {
            response_json["message"] = "No available ports for this channel";
            http::response<http::string_body> res{http::status::not_found, req.version()};
            res.set(http::field::content_type, "application/json");
            res.body() = json::serialize(response_json);
            res.prepare_payload();
            http::write(socket, res);
        } else {
            http::response<http::string_body> res{http::status::ok, req.version()};
            res.set(http::field::content_type, "application/json");
            res.body() = json::serialize(response_json);
            res.prepare_payload();
            http::write(socket, res);
        }
    }
    socket.shutdown(tcp::socket::shutdown_send);
}

void http_server(io_context& io) {
    tcp::acceptor acceptor(io, tcp::endpoint(tcp::v4(), API_PORT));
    for (;;) {
        tcp::socket socket(io);
        acceptor.accept(socket);
        std::thread([socket = std::move(socket)]() mutable { handle_http_request(socket); }).detach();
    }
}

int main() {
    try {
        io_context io;

        // Start UDP servers
        for (int port : available_ports) {
            std::thread(handle_udp_server, std::ref(io), port).detach();
        }

        // Start HTTP server
        http_server(io);

    } catch (std::exception& e) {
        std::cerr << "Error: " << e.what() << std::endl;
    }

    return 0;
}
