/**
 * @file rtp.c — v2 wire protocol header codec.
 */
#include "rtp.h"
#include "crypto.h"
#include <string.h>

static inline void put_u16(uint8_t *p, uint16_t v) { p[0]=(uint8_t)(v>>8); p[1]=(uint8_t)v; }
static inline void put_u32(uint8_t *p, uint32_t v) { p[0]=(uint8_t)(v>>24); p[1]=(uint8_t)(v>>16); p[2]=(uint8_t)(v>>8); p[3]=(uint8_t)v; }
static inline void put_u64(uint8_t *p, uint64_t v) {
    p[0]=(uint8_t)(v>>56); p[1]=(uint8_t)(v>>48); p[2]=(uint8_t)(v>>40); p[3]=(uint8_t)(v>>32);
    p[4]=(uint8_t)(v>>24); p[5]=(uint8_t)(v>>16); p[6]=(uint8_t)(v>>8);  p[7]=(uint8_t)v;
}
static inline uint16_t get_u16(const uint8_t *p) { return ((uint16_t)p[0]<<8)|(uint16_t)p[1]; }
static inline uint32_t get_u32(const uint8_t *p) { return ((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|((uint32_t)p[2]<<8)|(uint32_t)p[3]; }
static inline uint64_t get_u64(const uint8_t *p) {
    return ((uint64_t)p[0]<<56)|((uint64_t)p[1]<<48)|((uint64_t)p[2]<<40)|((uint64_t)p[3]<<32)
         | ((uint64_t)p[4]<<24)|((uint64_t)p[5]<<16)|((uint64_t)p[6]<<8) |(uint64_t)p[7];
}

int ae_header_encode(const ae_header_t *h, uint8_t *out, int out_size) {
    if (out_size < AE_HEADER_SIZE) return -1;
    out[0] = h->version; out[1] = h->packet_type; out[2] = h->payload_type; out[3] = h->flags;
    put_u32(&out[4],  h->sequence);
    put_u32(&out[8],  h->timestamp);
    put_u32(&out[12], h->channel_id);
    put_u64(&out[16], h->client_id);
    put_u32(&out[24], h->server_id);
    put_u16(&out[28], h->key_version);
    put_u16(&out[30], h->payload_length);
    return 0;
}

int ae_header_parse(const uint8_t *data, int data_len, ae_header_t *out) {
    if (data_len < AE_HEADER_SIZE) return -1;
    if (data[0] != AE_PROTOCOL_VERSION) return -2;
    out->version = data[0]; out->packet_type = data[1]; out->payload_type = data[2]; out->flags = data[3];
    out->sequence = get_u32(&data[4]);
    out->timestamp = get_u32(&data[8]);
    out->channel_id = get_u32(&data[12]);
    out->client_id = get_u64(&data[16]);
    out->server_id = get_u32(&data[24]);
    out->key_version = get_u16(&data[28]);
    out->payload_length = get_u16(&data[30]);
    return 0;
}

void ae_seq_init(ae_seq_tracker_t *t) { memset(t, 0, sizeof(*t)); }

int ae_seq_update(ae_seq_tracker_t *t, uint32_t seq) {
    if (!t->initialized) {
        t->initialized = true; t->next_seq = seq + 1; t->max_seq = seq;
        t->received = 1; t->window_base = seq; t->window_bitmap = 1u;
        return 0;
    }
    int32_t delta = (int32_t)(seq - t->max_seq);
    if (delta > 0) {
        uint32_t shift = (uint32_t)delta;
        t->window_bitmap = (shift >= 32) ? 1u : (t->window_bitmap << shift) | 1u;
        if (shift > 1) t->lost += shift - 1;
        t->max_seq = seq; t->window_base = seq; t->next_seq = seq + 1; t->received++;
        return 0;
    } else {
        uint32_t back = (uint32_t)(-delta);
        if (back >= 32) { t->duplicates++; return -1; }
        uint32_t mask = 1u << back;
        if (t->window_bitmap & mask) { t->duplicates++; return -1; }
        t->window_bitmap |= mask; t->reordered++; t->received++;
        return 1;
    }
}

void ae_iv_encode(uint64_t iv, uint8_t *out) { put_u64(out, iv); }
void ae_nonce_build(const uint8_t *session_salt, uint64_t iv, uint8_t *out) {
    memcpy(out, session_salt, AE_SESSION_SALT_SIZE);
    put_u64(out + AE_SESSION_SALT_SIZE, iv);
}

int ae_packet_build_audio(ae_header_t *h, const uint8_t session_salt[4],
                          const uint8_t key[AE_AES256_KEY_SIZE], uint64_t explicit_iv,
                          const uint8_t *plaintext, int plaintext_len,
                          uint8_t *out, int out_size) {
    if (plaintext_len < 0 || plaintext_len + AE_AEAD_TAG_SIZE > UINT16_MAX) return -1;
    int total = AE_HEADER_SIZE + AE_EXPLICIT_IV_SIZE + plaintext_len + AE_AEAD_TAG_SIZE;
    if (total > out_size) return -2;
    h->payload_length = (uint16_t)(plaintext_len + AE_AEAD_TAG_SIZE);
    if (ae_header_encode(h, out, out_size) != 0) return -3;
    ae_iv_encode(explicit_iv, out + AE_HEADER_SIZE);
    uint8_t nonce[AE_NONCE_SIZE];
    ae_nonce_build(session_salt, explicit_iv, nonce);
    int ct_len = ae_crypto_seal(key, nonce, out, AE_HEADER_SIZE,
                                plaintext, plaintext_len,
                                out + AE_HEADER_SIZE + AE_EXPLICIT_IV_SIZE,
                                out_size - (AE_HEADER_SIZE + AE_EXPLICIT_IV_SIZE));
    if (ct_len < 0) return -4;
    return AE_HEADER_SIZE + AE_EXPLICIT_IV_SIZE + ct_len;
}

int ae_packet_open(const uint8_t *data, int data_len,
                   const uint8_t key[AE_AES256_KEY_SIZE],
                   const uint8_t session_salt[4],
                   ae_header_t *out_header,
                   uint8_t *out_plaintext, int out_plaintext_cap) {
    if (data_len < AE_HEADER_SIZE + AE_EXPLICIT_IV_SIZE + AE_AEAD_TAG_SIZE) return -1;
    if (ae_header_parse(data, data_len, out_header) != 0) return -2;
    int ct_len = data_len - AE_HEADER_SIZE - AE_EXPLICIT_IV_SIZE;
    if (ct_len < AE_AEAD_TAG_SIZE) return -3;
    if ((int)out_header->payload_length != ct_len) return -4;
    uint64_t iv = get_u64(data + AE_HEADER_SIZE);
    uint8_t nonce[AE_NONCE_SIZE];
    ae_nonce_build(session_salt, iv, nonce);
    int pt_len = ae_crypto_open(key, nonce, data, AE_HEADER_SIZE,
                                data + AE_HEADER_SIZE + AE_EXPLICIT_IV_SIZE, ct_len,
                                out_plaintext, out_plaintext_cap);
    if (pt_len < 0) return -5;
    return pt_len;
}
