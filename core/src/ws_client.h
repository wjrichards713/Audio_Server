/**
 * @file ws_client.h — minimal client-side WebSocket (RFC 6455).
 */
#ifndef AE_WS_CLIENT_H
#define AE_WS_CLIENT_H
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif

typedef struct ae_ws ae_ws_t;

/* The audio_engine.c uses simpler 4-arg connect with no headers/TLS. */
int  ae_ws_connect(ae_ws_t *ws, const char *host, int port, const char *path);
ae_ws_t *ae_ws_connect_full(const char *host, int port, const char *path,
                            const char *headers, int use_tls);
int  ae_ws_send_text(ae_ws_t *ws, const char *utf8, int len);
int  ae_ws_recv_text(ae_ws_t *ws, char *out_buf, int cap, int timeout_ms);
void ae_ws_close(ae_ws_t *ws);
bool ae_ws_is_open(const ae_ws_t *ws);
int  ae_ws_backoff_ms(int attempt, int base_ms);
#ifdef __cplusplus
}
#endif
#endif
