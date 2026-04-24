/**
 * @file network.h — cross-platform UDP socket wrapper.
 */
#ifndef AE_NETWORK_H
#define AE_NETWORK_H
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
#ifdef _WIN32
#  ifndef WIN32_LEAN_AND_MEAN
#  define WIN32_LEAN_AND_MEAN
#  endif
#  include <winsock2.h>
#  include <ws2tcpip.h>
   typedef SOCKET ae_sock_t;
#  define AE_INVALID_SOCK INVALID_SOCKET
#else
   typedef int ae_sock_t;
#  define AE_INVALID_SOCK (-1)
#endif

typedef struct {
    ae_sock_t sock;
    bool      connected;
    char      peer_host[256];
    uint16_t  peer_port;
} ae_udp_t;

int  ae_net_global_init(void);
void ae_net_global_cleanup(void);
int  ae_udp_open(ae_udp_t *u, uint16_t bind_port);
void ae_udp_close(ae_udp_t *u);
int  ae_udp_connect(ae_udp_t *u, const char *host, uint16_t port);
int  ae_udp_send(ae_udp_t *u, const uint8_t *data, int len);
int  ae_udp_recv(ae_udp_t *u, uint8_t *buf, int cap, int timeout_ms);
int  ae_udp_set_rcvbuf(ae_udp_t *u, int bytes);
#ifdef __cplusplus
}
#endif
#endif
