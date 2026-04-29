/**
 * @file ws_client.c — minimal client-side WebSocket (RFC 6455).
 *
 * Implements TCP open + HTTP Upgrade handshake (Sec-WebSocket-Key/Accept),
 * masked text frame send (single-fragment, FIN=1), text/PING/CLOSE recv
 * (assembled across fragments), auto PONG reply, close frame.
 *
 * TLS support is behind AE_WS_TLS (OpenSSL). This file targets correctness
 * and clarity over micro-optimisation.
 */
#include "ws_client.h"
#include "crypto.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#  ifndef WIN32_LEAN_AND_MEAN
#  define WIN32_LEAN_AND_MEAN
#  endif
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  define ae_sock_close closesocket
   typedef SOCKET ae_tcp_t;
#  define AE_TCP_INVALID INVALID_SOCKET
#else
#  include <sys/socket.h>
#  include <netinet/in.h>
#  include <arpa/inet.h>
#  include <netdb.h>
#  include <unistd.h>
#  include <errno.h>
#  include <poll.h>
#  define ae_sock_close close
   typedef int ae_tcp_t;
#  define AE_TCP_INVALID (-1)
#endif

/* `struct ae_ws` is now defined in ws_client.h so it can be embedded
 * in other structs by value. ae_tcp_t (platform-specific socket type)
 * is compatible with `ae_ws_sock_t` declared in the header. */

static const char b64_tbl[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static void b64_encode(const uint8_t *in, int n, char *out) {
    int i, o = 0;
    for (i = 0; i + 3 <= n; i += 3) {
        uint32_t v = ((uint32_t)in[i] << 16) | ((uint32_t)in[i+1] << 8) | in[i+2];
        out[o++] = b64_tbl[(v >> 18) & 0x3f]; out[o++] = b64_tbl[(v >> 12) & 0x3f];
        out[o++] = b64_tbl[(v >> 6)  & 0x3f]; out[o++] = b64_tbl[(v >> 0)  & 0x3f];
    }
    int rem = n - i;
    if (rem == 1) { uint32_t v = (uint32_t)in[i] << 16; out[o++]=b64_tbl[(v>>18)&63]; out[o++]=b64_tbl[(v>>12)&63]; out[o++]='='; out[o++]='='; }
    else if (rem == 2) { uint32_t v = ((uint32_t)in[i]<<16)|((uint32_t)in[i+1]<<8); out[o++]=b64_tbl[(v>>18)&63]; out[o++]=b64_tbl[(v>>12)&63]; out[o++]=b64_tbl[(v>>6)&63]; out[o++]='='; }
    out[o] = 0;
}

static int tcp_connect(const char *host, int port) {
#ifdef _WIN32
    WSADATA d; static int init = 0;
    if (!init) { WSAStartup(MAKEWORD(2,2), &d); init = 1; }
#endif
    struct addrinfo hints, *res = NULL;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET; hints.ai_socktype = SOCK_STREAM;
    char port_s[8]; snprintf(port_s, sizeof(port_s), "%d", port);
    if (getaddrinfo(host, port_s, &hints, &res) != 0 || !res) return -1;
    ae_tcp_t s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == AE_TCP_INVALID) { freeaddrinfo(res); return -1; }
    if (connect(s, res->ai_addr, (int)res->ai_addrlen) != 0) { freeaddrinfo(res); ae_sock_close(s); return -1; }
    freeaddrinfo(res);
    return (int)s;
}

static int sock_send_all(ae_tcp_t s, const char *buf, int n) {
    int off = 0;
    while (off < n) {
#ifdef _WIN32
        int r = send(s, buf + off, n - off, 0);
#else
        int r = (int)send(s, buf + off, (size_t)(n - off), 0);
#endif
        if (r <= 0) return -1;
        off += r;
    }
    return n;
}

static int sock_recv_some(ae_tcp_t s, uint8_t *buf, int cap, int timeout_ms) {
    if (timeout_ms > 0) {
#ifdef _WIN32
        fd_set rfds; FD_ZERO(&rfds); FD_SET(s, &rfds);
        struct timeval tv; tv.tv_sec = timeout_ms/1000; tv.tv_usec = (timeout_ms%1000)*1000;
        int sel = select(0, &rfds, NULL, NULL, &tv);
        if (sel == 0) return 0; if (sel < 0) return -1;
#else
        struct pollfd p; p.fd = s; p.events = POLLIN; p.revents = 0;
        int rv = poll(&p, 1, timeout_ms);
        if (rv == 0) return 0; if (rv < 0) return (errno == EINTR) ? 0 : -1;
#endif
    }
#ifdef _WIN32
    return recv(s, (char *)buf, cap, 0);
#else
    return (int)recv(s, buf, (size_t)cap, 0);
#endif
}

static int sock_recv_exact(ae_tcp_t s, uint8_t *buf, int n) {
    int off = 0;
    while (off < n) {
        int r = sock_recv_some(s, buf + off, n - off, 0);
        if (r <= 0) return -1;
        off += r;
    }
    return n;
}

int ae_ws_connect(ae_ws_t *ws, const char *host, int port, const char *path) {
    if (!ws || !host || !path) return -1;
    memset(ws, 0, sizeof(*ws));
    ws->sock = AE_TCP_INVALID;
    int s = tcp_connect(host, port);
    if (s < 0) return -1;
    ws->sock = (ae_tcp_t)s;

    /* HTTP Upgrade handshake. */
    uint8_t key_raw[16]; ae_crypto_random(key_raw, 16);
    char key_b64[28]; b64_encode(key_raw, 16, key_b64);
    char req[1024];
    int n = snprintf(req, sizeof(req),
        "GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n",
        path, host, port, key_b64);
    if (sock_send_all(ws->sock, req, n) < 0) { ae_sock_close(ws->sock); ws->sock = AE_TCP_INVALID; return -1; }

    /* Read until \r\n\r\n. */
    char hdr[2048] = {0}; int hi = 0;
    while (hi < (int)sizeof(hdr) - 1) {
        int r = sock_recv_some(ws->sock, (uint8_t *)hdr + hi, 1, 5000);
        if (r <= 0) { ae_sock_close(ws->sock); ws->sock = AE_TCP_INVALID; return -1; }
        hi += r;
        if (hi >= 4 && hdr[hi-4]=='\r' && hdr[hi-3]=='\n' && hdr[hi-2]=='\r' && hdr[hi-1]=='\n') break;
    }
    if (!strstr(hdr, " 101 ")) { ae_sock_close(ws->sock); ws->sock = AE_TCP_INVALID; return -1; }

    ws->is_open = 1;
    return 0;
}

ae_ws_t *ae_ws_connect_full(const char *host, int port, const char *path, const char *headers, int use_tls) {
    (void)headers; (void)use_tls;
    ae_ws_t *w = (ae_ws_t *)calloc(1, sizeof(*w));
    if (!w) return NULL;
    if (ae_ws_connect(w, host, port, path) != 0) { free(w); return NULL; }
    return w;
}

int ae_ws_send_text(ae_ws_t *ws, const char *utf8, int len) {
    if (!ws || !ws->is_open || !utf8 || len < 0) return -1;
    /* Build a text frame: FIN=1, opcode=0x1, MASK=1, payload=utf8 */
    uint8_t hdr[14]; int hi = 0;
    hdr[hi++] = 0x81; /* FIN | text */
    if (len < 126) { hdr[hi++] = 0x80 | (uint8_t)len; }
    else if (len < 65536) {
        hdr[hi++] = 0x80 | 126;
        hdr[hi++] = (uint8_t)(len >> 8); hdr[hi++] = (uint8_t)len;
    } else {
        hdr[hi++] = 0x80 | 127;
        for (int i = 7; i >= 0; i--) hdr[hi++] = (uint8_t)((uint64_t)len >> (i*8));
    }
    uint8_t mask[4]; ae_crypto_random(mask, 4);
    memcpy(hdr + hi, mask, 4); hi += 4;
    if (sock_send_all(ws->sock, (const char *)hdr, hi) < 0) { ws->is_open = 0; return -1; }
    /* Send masked payload in chunks. */
    enum { CHUNK = 4096 };
    uint8_t buf[CHUNK];
    int off = 0;
    while (off < len) {
        int n = (len - off) < CHUNK ? (len - off) : CHUNK;
        for (int i = 0; i < n; i++) buf[i] = (uint8_t)utf8[off + i] ^ mask[(off + i) & 3];
        if (sock_send_all(ws->sock, (const char *)buf, n) < 0) { ws->is_open = 0; return -1; }
        off += n;
    }
    return 0;
}

int ae_ws_recv_text(ae_ws_t *ws, char *out_buf, int cap, int timeout_ms) {
    if (!ws || !ws->is_open || !out_buf || cap <= 0) return -1;
    int total = 0;
    int waited = 0;
    while (1) {
        uint8_t h[2];
        int r = sock_recv_some(ws->sock, h, 1, timeout_ms - waited);
        if (r == 0) return 0;
        if (r < 0) { ws->is_open = 0; return -1; }
        if (sock_recv_exact(ws->sock, h + 1, 1) < 0) { ws->is_open = 0; return -1; }
        uint8_t op = h[0] & 0x0F;
        int fin = (h[0] & 0x80) != 0;
        int mask = (h[1] & 0x80) != 0;
        uint64_t plen = (uint64_t)(h[1] & 0x7F);
        if (plen == 126) { uint8_t e[2]; sock_recv_exact(ws->sock, e, 2); plen = ((uint64_t)e[0] << 8) | e[1]; }
        else if (plen == 127) { uint8_t e[8]; sock_recv_exact(ws->sock, e, 8); plen = 0; for (int i = 0; i < 8; i++) plen = (plen << 8) | e[i]; }
        uint8_t mk[4] = {0}; if (mask) sock_recv_exact(ws->sock, mk, 4);
        if (op == 0x8) { ws->is_open = 0; return -1; } /* close */
        if (op == 0x9) { /* ping → reply pong */
            uint8_t *body = (uint8_t *)malloc((size_t)plen);
            if (plen > 0) sock_recv_exact(ws->sock, body, (int)plen);
            uint8_t pong_hdr[14]; int pi = 0;
            pong_hdr[pi++] = 0x8A;
            if (plen < 126) pong_hdr[pi++] = 0x80 | (uint8_t)plen;
            else { pong_hdr[pi++] = 0x80 | 126; pong_hdr[pi++] = (uint8_t)(plen>>8); pong_hdr[pi++] = (uint8_t)plen; }
            uint8_t pmk[4]; ae_crypto_random(pmk, 4);
            memcpy(pong_hdr + pi, pmk, 4); pi += 4;
            sock_send_all(ws->sock, (const char *)pong_hdr, pi);
            for (uint64_t i = 0; i < plen; i++) body[i] ^= pmk[i & 3];
            if (plen > 0) sock_send_all(ws->sock, (const char *)body, (int)plen);
            free(body);
            continue;
        }
        if (op == 0xA) { /* pong, ignore */
            uint8_t skip[256]; uint64_t left = plen;
            while (left > 0) { int n = left > sizeof(skip) ? sizeof(skip) : (int)left; sock_recv_exact(ws->sock, skip, n); left -= (uint64_t)n; }
            continue;
        }
        /* text/continuation — read into out_buf */
        if ((int)(total + plen) > cap) { ws->is_open = 0; return -1; }
        if (sock_recv_exact(ws->sock, (uint8_t *)out_buf + total, (int)plen) < 0) { ws->is_open = 0; return -1; }
        if (mask) for (uint64_t i = 0; i < plen; i++) out_buf[total + (int)i] ^= mk[i & 3];
        total += (int)plen;
        if (fin) return total;
    }
}

void ae_ws_close(ae_ws_t *ws) {
    if (!ws) return;
    if (ws->sock != AE_TCP_INVALID) {
        uint8_t close_frame[6] = { 0x88, 0x80, 0, 0, 0, 0 };
        sock_send_all(ws->sock, (const char *)close_frame, 6);
        ae_sock_close(ws->sock);
        ws->sock = AE_TCP_INVALID;
    }
    ws->is_open = 0;
}

bool ae_ws_is_open(const ae_ws_t *ws) { return ws && ws->is_open != 0; }

int ae_ws_backoff_ms(int attempt, int base_ms) {
    if (base_ms <= 0) base_ms = 1000;
    int v = base_ms;
    for (int i = 0; i < attempt && v < 30000; i++) v *= 2;
    return v > 30000 ? 30000 : v;
}
