/**
 * @file internal.h — private engine state.
 */
#ifndef AE_INTERNAL_H
#define AE_INTERNAL_H
#include "../include/audio_engine.h"
#include "atomic_compat.h"
#include "ring_buffer.h"
#include "jitter_buffer.h"
#include "mixer.h"
#include "opus_codec.h"
#include "network.h"
#include "ws_client.h"
#include "rtp.h"
#include "crypto.h"
#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool              in_use;
    uint32_t          channel_id;
    float             gain_db;
    float             target_gain_linear;
    float             current_gain_linear;
    bool              muted;
    bool              solo;
    ae_channel_role_t role;
    ae_opus_dec_t    *decoder;
    ae_jb_t           jitter;
    uint32_t          last_seq;
} ae_channel_sub_t;

struct ae_engine {
    ae_config_t          cfg;
    ae_capture_callback_t  capture_cb;   void *capture_ud;
    ae_playback_callback_t playback_cb;  void *playback_ud;
    ae_event_callback_t    event_cb;     void *event_ud;
    ae_mutex_t           state_mtx;
    bool                 connected;
    bool                 authed;
    ae_ws_t              ws;
    ae_udp_t             udp;
    uint8_t              session_salt[AE_SESSION_SALT_SIZE];
    uint8_t              session_key[AE_AES256_KEY_SIZE];
    uint16_t             key_version;
    uint64_t             client_id;
    ae_channel_sub_t     channels[AE_MAX_SUBSCRIBED_CHANNELS];
    ae_opus_enc_t       *encoder;
    ae_ringbuf_t         playback_ring;
    ae_ringbuf_t         capture_ring;
    uint32_t             ptt_holding_channel;
    bool                 ptt_engaged;
    ae_mixer_t           mixer;
    float                master_volume;
    uint64_t             packets_sent;
    uint64_t             packets_received;
    uint64_t             packets_dropped;
    float                rtt_ms;
    float                packet_loss_pct;
};

#ifdef __cplusplus
}
#endif
#endif
