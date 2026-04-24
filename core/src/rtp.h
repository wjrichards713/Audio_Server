/**
 * @file  rtp.h  — v2 wire-protocol header codec (C).
 * Packet layout: header(32) || explicit_iv(8) || ciphertext(var) || tag(16)
 */
#ifndef AE_RTP_H
#define AE_RTP_H
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#ifdef __cplusplus
extern "C" {
#endif

#define AE_HEADER_SIZE          32
#define AE_EXPLICIT_IV_SIZE      8
#define AE_SESSION_SALT_SIZE     4
#define AE_AEAD_TAG_SIZE        16
#define AE_AES256_KEY_SIZE      32
#define AE_NONCE_SIZE           12
#define AE_MAX_UDP_PACKET     1500
#define AE_PROTOCOL_VERSION   0x02u
#define AE_CHANNEL_ID_MIX     0xFFFFFFFFu

#define AE_PKT_AUDIO          0
#define AE_PKT_KEEPALIVE      1
#define AE_PKT_PING           2
#define AE_PKT_PONG           3
#define AE_PKT_MIXED          4
#define AE_PKT_SILENCE        5

#define AE_PAYLOAD_OPUS_48K_MONO    0
#define AE_PAYLOAD_OPUS_48K_STEREO  1
#define AE_PAYLOAD_PCM_S16          2

#define AE_FLAG_FEC         0x01
#define AE_FLAG_DTX         0x02
#define AE_FLAG_MARKER      0x04
#define AE_FLAG_MIX_EGRESS  0x08

typedef struct {
    uint8_t  version, packet_type, payload_type, flags;
    uint32_t sequence, timestamp, channel_id;
    uint64_t client_id;
    uint32_t server_id;
    uint16_t key_version, payload_length;
} ae_header_t;

int ae_header_encode(const ae_header_t *h, uint8_t *out, int out_size);
int ae_header_parse(const uint8_t *data, int data_len, ae_header_t *out);

typedef struct {
    uint32_t next_seq, max_seq, received, lost, reordered, duplicates;
    uint32_t window_bitmap, window_base;
    bool     initialized;
} ae_seq_tracker_t;
void ae_seq_init(ae_seq_tracker_t *t);
int  ae_seq_update(ae_seq_tracker_t *t, uint32_t seq);

typedef struct { uint64_t counter; } ae_iv_counter_t;
static inline void     ae_iv_init(ae_iv_counter_t *c) { c->counter = 1; }
static inline uint64_t ae_iv_next(ae_iv_counter_t *c) { return c->counter++; }

void ae_iv_encode(uint64_t iv, uint8_t *out);
void ae_nonce_build(const uint8_t *session_salt, uint64_t iv, uint8_t *out);

int ae_packet_build_audio(ae_header_t *h,
                          const uint8_t session_salt[4],
                          const uint8_t key[AE_AES256_KEY_SIZE],
                          uint64_t explicit_iv,
                          const uint8_t *plaintext, int plaintext_len,
                          uint8_t *out, int out_size);

int ae_packet_open(const uint8_t *data, int data_len,
                   const uint8_t key[AE_AES256_KEY_SIZE],
                   const uint8_t session_salt[4],
                   ae_header_t *out_header,
                   uint8_t *out_plaintext, int out_plaintext_cap);

#ifdef __cplusplus
}
#endif
#endif
