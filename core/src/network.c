/**
 * @file network.c — cross-platform UDP socket wrapper.
 */
#include "network.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

#ifdef _WIN32
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  ifdef _MSC_VER
#    pragma comment(lib, "ws2_32.lib")
#  endif
   static int g_wsa_inited = 0;
#  define ae_sock_close closesocket
#else
#  include <sys/socket.h>
#  include <sys/types.h>
#  include <netinet/in.h>
#  include <arpa/inet.h>
#  include <netdb.h>
#  include <unistd.h>
#  include <fcntl.h>
#  include <errno.h>
#  include <poll.h>
#  define ae_sock_close close
#endif

int ae_net_global_init(void) {
#ifdef _WIN32
    if (!g_wsa_inited) { WSADATA d; if (WSAStartup(MAKEWORD(2, 2), &d) != 0) return -1; g_wsa_inited = 1; }
#endif
    return 0;
}
void ae_net_global_cleanup(void) {
#ifdef _WIN32
    if (g_wsa_inited) { WSACleanup(); g_wsa_inited = 0; }
#endif
}

int ae_udp_open(ae_udp_t *u, uint16_t bind_port) {
    if (!u) return -1;
    memset(u, 0, sizeof(*u));
    u->sock = AE_INVALID_SOCK;
    if (ae_net_global_init() != 0) return -1;
    ae_sock_t s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (s == AE_INVALID_SOCK) return -1;
    if (bind_port != 0) {
        struct sockaddr_in a;
        memset(&a, 0, sizeof(a));
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_ANY);
        a.sin_port = htons(bind_port);
        if (bind(s, (struct sockaddr *)&a, sizeof(a)) != 0) { ae_sock_close(s); return -1; }
    }
    u->sock = s; u->connected = false;
    return 0;
}

void ae_udp_close(ae_udp_t *u) {
    if (!u) return;
    if (u->sock != AE_INVALID_SOCK) { ae_sock_close(u->sock); u->sock = AE_INVALID_SOCK; }
    u->connected = false;
}

int ae_udp_connect(ae_udp_t *u, const char *host, uint16_t port) {
    if (!u || !host) return -1;
    if (u->sock == AE_INVALID_SOCK) {
        if (ae_udp_open(u, 0) != 0) return -1;
    }
    struct addrinfo hints, *res = NULL;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET; hints.ai_socktype = SOCK_DGRAM; hints.ai_protocol = IPPROTO_UDP;
    char port_s[8]; snprintf(port_s, sizeof(port_s), "%u", (unsigned)port);
    if (getaddrinfo(host, port_s, &hints, &res) != 0 || !res) return -1;
    int r = connect(u->sock, res->ai_addr, (int)res->ai_addrlen);
    freeaddrinfo(res);
    if (r != 0) return -1;
    u->connected = true;
    strncpy(u->peer_host, host, sizeof(u->peer_host) - 1);
    u->peer_host[sizeof(u->peer_host) - 1] = 0;
    u->peer_port = port;
    return 0;
}

int ae_udp_send(ae_udp_t *u, const uint8_t *data, int len) {
    if (!u || u->sock == AE_INVALID_SOCK || !data || len <= 0) return -1;
#ifdef _WIN32
    return send(u->sock, (const char *)data, len, 0);
#else
    return (int)send(u->sock, data, (size_t)len, 0);
#endif
}

int ae_udp_recv(ae_udp_t *u, uint8_t *buf, int cap, int timeout_ms) {
    if (!u || u->sock == AE_INVALID_SOCK || !buf || cap <= 0) return -1;
    if (timeout_ms > 0) {
#ifdef _WIN32
        fd_set rfds; FD_ZERO(&rfds); FD_SET(u->sock, &rfds);
        struct timeval tv;
        tv.tv_sec = timeout_ms / 1000; tv.tv_usec = (timeout_ms % 1000) * 1000;
        int sel = select(0, &rfds, NULL, NULL, &tv);
        if (sel == 0) return 0; if (sel < 0) return -1;
#else
        struct pollfd pfd; pfd.fd = u->sock; pfd.events = POLLIN; pfd.revents = 0;
        int rv = poll(&pfd, 1, timeout_ms);
        if (rv == 0) return 0; if (rv < 0) return (errno == EINTR) ? 0 : -1;
        if (!(pfd.revents & POLLIN)) return -1;
#endif
    }
#ifdef _WIN32
    int n = recv(u->sock, (char *)buf, cap, 0);
#else
    int n = (int)recv(u->sock, buf, (size_t)cap, 0);
#endif
    return n < 0 ? -1 : n;
}

int ae_udp_set_rcvbuf(ae_udp_t *u, int bytes) {
    if (!u || u->sock == AE_INVALID_SOCK) return -1;
#ifdef _WIN32
    return setsockopt(u->sock, SOL_SOCKET, SO_RCVBUF, (const char *)&bytes, sizeof(bytes));
#else
    return setsockopt(u->sock, SOL_SOCKET, SO_RCVBUF, &bytes, sizeof(bytes));
#endif
}
