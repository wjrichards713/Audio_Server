#include <boost/asio.hpp>
#include <iostream>
#include <thread>
#include <unordered_map>
#include <vector>
#include <nlohmann/json.hpp> // Include for JSON parsing (requires nlohmann/json library)

using boost::asio::ip::udp;
using json = nlohmann::json;

std::unordered_map<int, udp::endpoint> port_registrar;
std::unordered_map<std::string, std::vector<int>> channel_ports = {
    {"555", {8000, 8001}},
    {"666", {8001}}
};

void listen_on_port(boost::asio::io_context& io_context, int port, std::string group_name) {
    udp::socket socket(io_context, udp::endpoint(udp::v4(), port));
    char buffer[1600];

    while (true) {
        try {
            udp::endpoint sender_endpoint;
            boost::system::error_code error;

            // Receive packet
            size_t length = socket.receive_from(boost::asio::buffer(buffer), sender_endpoint, 0, error);

            if (error && error != boost::asio::error::message_size) {
                std::cerr << "Error receiving packet on port " << port << ": " << error.message() << std::endl;
                continue;
            }

            std::string msg(buffer, length);
            json data;
            try {
                data = json::parse(msg);
            } catch (const std::exception& e) {
                std::cerr << "Failed to parse JSON: " << e.what() << std::endl;
                continue;
            }

            std::string sender_address = sender_endpoint.address().to_string();
            if (sender_address == "127.0.0.1" && port_registrar.find(port) != port_registrar.end()) {
                // Forward to registered client
                auto& dest_endpoint = port_registrar[port];
                socket.send_to(boost::asio::buffer(msg), dest_endpoint);
                std::cout << "Forwarded packet to " << dest_endpoint << std::endl;
            } else if (sender_address != "127.0.0.1" && data.contains("channel_id")) {
                // Register port and forward to other ports in the same channel
                port_registrar[port] = sender_endpoint;
                for (int p : channel_ports[data["channel_id"]]) {
                    if (p != port && port_registrar.find(p) != port_registrar.end()) {
                        auto& dest_endpoint = port_registrar[p];
                        socket.send_to(boost::asio::buffer(msg), dest_endpoint);
                        std::cout << "Forwarded packet to port " << p << " at " << dest_endpoint << std::endl;
                    }
                }
            } else if (sender_address != "127.0.0.1") {
                // Register sender for the port
                port_registrar[port] = sender_endpoint;
            }

            // Debug: Print port registrar
            for (const auto& [port, endpoint] : port_registrar) {
                std::cout << "Port " << port << " registered with " << endpoint << std::endl;
            }

        } catch (const std::exception& e) {
            std::cerr << "Error on port " << port << ": " << e.what() << std::endl;
        }
    }
}

int main() {
    try {
        boost::asio::io_context io_context;
        std::vector<std::thread> threads;

        std::vector<int> available_ports = {8000, 8001};
        for (int port : available_ports) {
            threads.emplace_back([&, port]() {
                listen_on_port(io_context, port, "group");
            });
        }

        for (auto& t : threads) {
            t.join();
        }
    } catch (const std::exception& e) {
        std::cerr << "Exception in main: " << e.what() << std::endl;
    }

    return 0;
}
