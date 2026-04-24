/**
 * @file audio_engine.c — cross-platform client engine implementation.
 */
#include "audio_engine.h"
#include "internal.h"
#include "crypto.h"
#include "rtp.h"
#include "opus_codec.h"
#include "mixer.h"
#include "jitter_buffer.h"
#include "ring_buffer.h"
#include "network.h"
#include "ws_client.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>
#include <stdarg.h>

static ae_log_callback_t g_log_cb = NULL;
static void *g_log_ud = NULL;
static ae_log_level_t g_log_level = AE_LOG_INFO;

void ae_log_set_callback(ae_log_callback_t cb, void *ud) { g_log_cb = cb; g_log_ud = ud; }
void ae_log_set_level(ae_log_level_t level) { g_log_level = level; }

static void ae_log(ae_log_level_t level, const char *fmt, ...) {
    if (level < g_log_level) return;
    char buf[512]; va_list ap; va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap); va_end(ap);
    if (g_log_cb) g_log_cb(level, buf, g_log_ud);
    else fprintf(stderr, "[ae] %s\n", buf);
}

ae_config_t ae_config_default(void) {
    ae_config_t c = {
        .sample_rate = AE_SAMPLE_RATE, .frame_size_samples = AE_FRAME_SIZE_SAMPLES,
        .opus_bitrate_bps = AE_OPUS_BITRATE_BPS, .opus_fec = true, .opus_dtx = true,
        .opus_complexity = 8, .jitter_buffer_frames = AE_JITTER_DEFAULT_FRAMES,
        .session_mode = AE_MODE_MIX, .ptt_mute_scope = AE_PTT_MUTE_ALL,
        .pause_egress_during_ptt = true, .sidetone_db = -18.0f,
    };
    return c;
}

ae_engine_t *ae_engine_create(const ae_config_t *cfg) {
    if (!cfg) return NULL;
    ae_engine_t *e = (ae_engine_t *)calloc(1, sizeof(*e));
    if (!e) return NULL;
    e->cfg = *cfg; e->master_volume = 1.0f;
    e->ptt_holding_channel = 0; e->ptt_engaged = false;
    mtx_init_compat(&e->state_mtx);
    if (ae_ringbuf_init(&e->playback_ring, AE_FRAME_SIZE_SAMPLES * 64) != 0) goto fail;
    if (ae_ringbuf_init(&e->capture_ring,  AE_FRAME_SIZE_SAMPLES * 64) != 0) goto fail;
    if (ae_opus_encoder_create(cfg->sample_rate, 1, 1, cfg->opus_bitrate_bps, cfg->opus_complexity, cfg->opus_fec, cfg->opus_dtx, &e->encoder) != 0) goto fail;
    if (ae_mixer_init(&e->mixer, AE_MAX_MIX_INPUTS, AE_FRAME_SIZE_SAMPLES) != 0) goto fail;
    ae_log(AE_LOG_INFO, "engine created (sr=%d frame=%d bitrate=%d)", cfg->sample_rate, cfg->frame_size_samples, cfg->opus_bitrate_bps);
    return e;
fail:
    ae_engine_destroy(e); return NULL;
}

void ae_engine_destroy(ae_engine_t *e) {
    if (!e) return;
    ae_engine_disconnect(e);
    for (int i = 0; i < AE_MAX_SUBSCRIBED_CHANNELS; i++) {
        if (e->channels[i].in_use) {
            ae_opus_decoder_destroy(e->channels[i].decoder);
            ae_jb_destroy(&e->channels[i].jitter);
            e->channels[i].in_use = false;
        }
    }
    ae_opus_encoder_destroy(e->encoder);
    ae_mixer_destroy(&e->mixer);
    ae_ringbuf_destroy(&e->playback_ring);
    ae_ringbuf_destroy(&e->capture_ring);
    mtx_destroy_compat(&e->state_mtx);
    ae_crypto_zeroize(e->session_key, sizeof(e->session_key));
    free(e);
}

void ae_engine_set_capture_callback(ae_engine_t *e, ae_capture_callback_t cb, void *ud) {
    if (!e) return; mtx_lock_compat(&e->state_mtx); e->capture_cb = cb; e->capture_ud = ud; mtx_unlock_compat(&e->state_mtx);
}
void ae_engine_set_playback_callback(ae_engine_t *e, ae_playback_callback_t cb, void *ud) {
    if (!e) return; mtx_lock_compat(&e->state_mtx); e->playback_cb = cb; e->playback_ud = ud; mtx_unlock_compat(&e->state_mtx);
}
void ae_engine_set_event_callback(ae_engine_t *e, ae_event_callback_t cb, void *ud) {
    if (!e) return; mtx_lock_compat(&e->state_mtx); e->event_cb = cb; e->event_ud = ud; mtx_unlock_compat(&e->state_mtx);
}

ae_error_t ae_engine_connect(ae_engine_t *e, const char *host, int ws_port, const char *jwt, const char *device_id) {
    if (!e || !host || !jwt || !device_id) return AE_ERR_INVALID_PARAM;
    if (e->connected) return AE_OK;
    if (ae_ws_connect(&e->ws, host, ws_port, "/ws") != 0) { ae_log(AE_LOG_ERROR, "ws connect to %s:%d failed", host, ws_port); return AE_ERR_NETWORK; }
    uint8_t client_pk[32]; ae_crypto_random(client_pk, sizeof(client_pk));
    char pk_hex[65];
    for (int i = 0; i < 32; i++) snprintf(&pk_hex[i*2], 3, "%02x", client_pk[i]);
    char auth_json[1024];
    snprintf(auth_json, sizeof(auth_json),
        "{\"op\":\"auth\",\"id\":\"00000000-0000-0000-0000-000000000000\","
        "\"data\":{\"jwt\":\"%s\",\"device_id\":\"%s\",\"client_pubkey_x25519_hex\":\"%s\"}}",
        jwt, device_id, pk_hex);
    if (ae_ws_send_text(&e->ws, auth_json, (int)strlen(auth_json)) != 0) return AE_ERR_NETWORK;
    char resp[2048];
    int n = ae_ws_recv_text(&e->ws, resp, sizeof(resp) - 1, 10000);
    if (n <= 0) { ae_log(AE_LOG_ERROR, "auth_ok recv failed (%d)", n); return AE_ERR_AUTH; }
    resp[n] = 0;
    if (!strstr(resp, "\"auth_ok\"")) { ae_log(AE_LOG_ERROR, "non-auth_ok reply: %.200s", resp); return AE_ERR_AUTH; }
    const char *udp_host = strstr(resp, "\"udp_host\":\"");
    const char *udp_port_s = strstr(resp, "\"udp_port\":");
    const char *salt_hex = strstr(resp, "\"session_salt_hex\":\"");
    const char *kv = strstr(resp, "\"key_version\":");
    if (!udp_host || !udp_port_s || !salt_hex || !kv) return AE_ERR_AUTH;
    char udp_host_str[128] = {0};
    sscanf(udp_host + 12, "%127[^\"]", udp_host_str);
    int udp_port = 0; sscanf(udp_port_s + 11, "%d", &udp_port);
    char salt_hex_str[16] = {0}; sscanf(salt_hex + 21, "%15[^\"]", salt_hex_str);
    int key_version = 1; sscanf(kv + 14, "%d", &key_version);
    for (int i = 0; i < 4; i++) { unsigned int b; sscanf(&salt_hex_str[i*2], "%2x", &b); e->session_salt[i] = (uint8_t)b; }
    e->key_version = (uint16_t)key_version;
    if (ae_udp_connect(&e->udp, udp_host_str, udp_port) != 0) { ae_log(AE_LOG_ERROR, "udp connect failed"); return AE_ERR_NETWORK; }
    uint8_t prk[32];
    ae_hkdf_extract(e->session_salt, 4, client_pk, 32, prk);
    ae_hkdf_expand(prk, (const uint8_t *)"redenes/audio/v2/session", 24, e->session_key, 32);
    e->connected = true; e->authed = true;
    if (e->event_cb) { ae_event_t ev = { .type = AE_EVENT_AUTHED }; e->event_cb(&ev, e->event_ud); }
    ae_log(AE_LOG_INFO, "authed, udp endpoint %s:%d", udp_host_str, udp_port);
    return AE_OK;
}

void ae_engine_disconnect(ae_engine_t *e) {
    if (!e) return;
    if (e->connected) {
        ae_ws_close(&e->ws); ae_udp_close(&e->udp);
        e->connected = false; e->authed = false;
        if (e->event_cb) { ae_event_t ev = { .type = AE_EVENT_DISCONNECTED }; e->event_cb(&ev, e->event_ud); }
    }
}

bool ae_engine_is_connected(const ae_engine_t *e) { return e && e->connected; }
bool ae_engine_is_authed(const ae_engine_t *e)    { return e && e->authed; }

static ae_error_t send_json(ae_engine_t *e, const char *json, int len) {
    if (!e || !e->connected) return AE_ERR_NOT_CONNECTED;
    return ae_ws_send_text(&e->ws, json, len) == 0 ? AE_OK : AE_ERR_NETWORK;
}

ae_error_t ae_engine_subscribe(ae_engine_t *e, uint32_t channel_id, float gain_db, bool muted, bool solo, ae_channel_role_t role) {
    if (!e) return AE_ERR_INVALID_PARAM;
    const char *role_s = (role == AE_ROLE_MONITOR) ? "monitor" : (role == AE_ROLE_EMERGENCY_OVERRIDE) ? "emergency_override" : "normal";
    char buf[512];
    int n = snprintf(buf, sizeof(buf),
        "{\"op\":\"subscribe\",\"id\":\"00000000-0000-0000-0000-000000000000\","
        "\"data\":{\"channel_id\":%u,\"gain_db\":%.2f,\"muted\":%s,\"solo\":%s,\"priority\":\"%s\"}}",
        channel_id, gain_db, muted?"true":"false", solo?"true":"false", role_s);
    ae_error_t rc = send_json(e, buf, n);
    mtx_lock_compat(&e->state_mtx);
    for (int i = 0; i < AE_MAX_SUBSCRIBED_CHANNELS; i++) {
        if (!e->channels[i].in_use || e->channels[i].channel_id == channel_id) {
            e->channels[i].in_use = true; e->channels[i].channel_id = channel_id;
            e->channels[i].gain_db = gain_db;
            e->channels[i].target_gain_linear = powf(10.0f, gain_db / 20.0f);
            e->channels[i].current_gain_linear = e->channels[i].target_gain_linear;
            e->channels[i].muted = muted; e->channels[i].solo = solo; e->channels[i].role = role;
            if (!e->channels[i].decoder) {
                ae_opus_decoder_create(e->cfg.sample_rate, 1, &e->channels[i].decoder);
                ae_jb_init(&e->channels[i].jitter, 20, e->cfg.jitter_buffer_frames);
            }
            break;
        }
    }
    mtx_unlock_compat(&e->state_mtx);
    return rc;
}

ae_error_t ae_engine_unsubscribe(ae_engine_t *e, uint32_t channel_id) {
    if (!e) return AE_ERR_INVALID_PARAM;
    char buf[256];
    int n = snprintf(buf, sizeof(buf), "{\"op\":\"unsubscribe\",\"id\":\"00000000-0000-0000-0000-000000000000\",\"data\":{\"channel_id\":%u}}", channel_id);
    ae_error_t rc = send_json(e, buf, n);
    mtx_lock_compat(&e->state_mtx);
    for (int i = 0; i < AE_MAX_SUBSCRIBED_CHANNELS; i++) {
        if (e->channels[i].in_use && e->channels[i].channel_id == channel_id) {
            ae_opus_decoder_destroy(e->channels[i].decoder); e->channels[i].decoder = NULL;
            ae_jb_destroy(&e->channels[i].jitter);
            memset(&e->channels[i], 0, sizeof(e->channels[i]));
            break;
        }
    }
    mtx_unlock_compat(&e->state_mtx);
    return rc;
}

ae_error_t ae_engine_unsubscribe_all(ae_engine_t *e) {
    if (!e) return AE_ERR_INVALID_PARAM;
    mtx_lock_compat(&e->state_mtx);
    for (int i = 0; i < AE_MAX_SUBSCRIBED_CHANNELS; i++) {
        if (e->channels[i].in_use) {
            ae_opus_decoder_destroy(e->channels[i].decoder);
            ae_jb_destroy(&e->channels[i].jitter);
            memset(&e->channels[i], 0, sizeof(e->channels[i]));
        }
    }
    mtx_unlock_compat(&e->state_mtx);
    return AE_OK;
}

static ae_error_t send_prefs_update(ae_engine_t *e, uint32_t ch, const char *k, const char *v) {
    char buf[256];
    int n = snprintf(buf, sizeof(buf),
        "{\"op\":\"set_channel_prefs\",\"id\":\"00000000-0000-0000-0000-000000000000\",\"data\":{\"channel_id\":%u,\"%s\":%s}}", ch, k, v);
    return send_json(e, buf, n);
}

ae_error_t ae_engine_set_channel_gain_db(ae_engine_t *e, uint32_t ch, float db) {
    if (!e) return AE_ERR_INVALID_PARAM;
    mtx_lock_compat(&e->state_mtx);
    for (int i = 0; i < AE_MAX_SUBSCRIBED_CHANNELS; i++) {
        if (e->channels[i].in_use && e->channels[i].channel_id == ch) {
            e->channels[i].gain_db = db;
            e->channels[i].target_gain_linear = powf(10.0f, db / 20.0f);
            break;
        }
    }
    mtx_unlock_compat(&e->state_mtx);
    char vbuf[32]; snprintf(vbuf, sizeof(vbuf), "%.2f", db);
    return send_prefs_update(e, ch, "gain_db", vbuf);
}

ae_error_t ae_engine_set_channel_muted(ae_engine_t *e, uint32_t ch, bool m) {
    if (!e) return AE_ERR_INVALID_PARAM;
    mtx_lock_compat(&e->state_mtx);
    for (int i = 0; i < AE_MAX_SUBSCRIBED_CHANNELS; i++) {
        if (e->channels[i].in_use && e->channels[i].channel_id == ch) { e->channels[i].muted = m; break; }
    }
    mtx_unlock_compat(&e->state_mtx);
    return send_prefs_update(e, ch, "muted", m ? "true" : "false");
}

ae_error_t ae_engine_set_channel_solo(ae_engine_t *e, uint32_t ch, bool s) {
    if (!e) return AE_ERR_INVALID_PARAM;
    mtx_lock_compat(&e->state_mtx);
    for (int i = 0; i < AE_MAX_SUBSCRIBED_CHANNELS; i++) {
        if (e->channels[i].in_use && e->channels[i].channel_id == ch) { e->channels[i].solo = s; break; }
    }
    mtx_unlock_compat(&e->state_mtx);
    return send_prefs_update(e, ch, "solo", s ? "true" : "false");
}

ae_error_t ae_engine_set_channel_role(ae_engine_t *e, uint32_t ch, ae_channel_role_t r) {
    if (!e) return AE_ERR_INVALID_PARAM;
    const char *rs = (r == AE_ROLE_MONITOR) ? "\"monitor\"" : (r == AE_ROLE_EMERGENCY_OVERRIDE) ? "\"emergency_override\"" : "\"normal\"";
    mtx_lock_compat(&e->state_mtx);
    for (int i = 0; i < AE_MAX_SUBSCRIBED_CHANNELS; i++) {
        if (e->channels[i].in_use && e->channels[i].channel_id == ch) { e->channels[i].role = r; break; }
    }
    mtx_unlock_compat(&e->state_mtx);
    return send_prefs_update(e, ch, "priority", rs);
}

ae_error_t ae_engine_set_session_mode(ae_engine_t *e, ae_session_mode_t m) {
    if (!e) return AE_ERR_INVALID_PARAM;
    e->cfg.session_mode = m;
    char buf[256]; const char *ms = m == AE_MODE_MIX ? "mix" : "forward";
    int n = snprintf(buf, sizeof(buf),
        "{\"op\":\"set_session_options\",\"id\":\"00000000-0000-0000-0000-000000000000\",\"data\":{\"mode\":\"%s\"}}", ms);
    return send_json(e, buf, n);
}
ae_error_t ae_engine_set_ptt_mute_scope(ae_engine_t *e, ae_ptt_mute_scope_t s) { if (!e) return AE_ERR_INVALID_PARAM; e->cfg.ptt_mute_scope = s; return AE_OK; }
ae_error_t ae_engine_set_pause_egress_during_ptt(ae_engine_t *e, bool on) { if (!e) return AE_ERR_INVALID_PARAM; e->cfg.pause_egress_during_ptt = on; return AE_OK; }
ae_error_t ae_engine_set_sidetone_db(ae_engine_t *e, float db) { if (!e) return AE_ERR_INVALID_PARAM; e->cfg.sidetone_db = db; return AE_OK; }
ae_error_t ae_engine_set_master_volume(ae_engine_t *e, float v) { if (!e) return AE_ERR_INVALID_PARAM; e->master_volume = v < 0.0f ? 0.0f : (v > 4.0f ? 4.0f : v); return AE_OK; }

ae_error_t ae_engine_floor_request(ae_engine_t *e, uint32_t ch, ae_priority_t pr) {
    if (!e) return AE_ERR_INVALID_PARAM;
    const char *ps = pr == AE_PRIO_IMMINENT_PERIL ? "imminent_peril" : pr == AE_PRIO_EMERGENCY ? "emergency" : pr == AE_PRIO_HIGH ? "high" : "normal";
    char buf[256];
    int n = snprintf(buf, sizeof(buf),
        "{\"op\":\"floor_request\",\"id\":\"00000000-0000-0000-0000-000000000000\",\"data\":{\"channel_id\":%u,\"priority\":\"%s\"}}", ch, ps);
    e->ptt_holding_channel = ch; e->ptt_engaged = true;
    return send_json(e, buf, n);
}
ae_error_t ae_engine_floor_release(ae_engine_t *e, uint32_t ch) {
    if (!e) return AE_ERR_INVALID_PARAM;
    char buf[256];
    int n = snprintf(buf, sizeof(buf),
        "{\"op\":\"floor_release\",\"id\":\"00000000-0000-0000-0000-000000000000\",\"data\":{\"channel_id\":%u}}", ch);
    e->ptt_engaged = false; e->ptt_holding_channel = 0;
    return send_json(e, buf, n);
}
bool ae_engine_has_floor(const ae_engine_t *e, uint32_t ch) { return e && e->ptt_engaged && e->ptt_holding_channel == ch; }

ae_error_t ae_engine_write_capture(ae_engine_t *e, const float *samples, int frames) {
    if (!e || !samples || frames <= 0) return AE_ERR_INVALID_PARAM;
    ae_ringbuf_write(&e->capture_ring, samples, frames);
    return AE_OK;
}

int ae_engine_read_playback(ae_engine_t *e, float *out, int frames) {
    if (!e || !out || frames <= 0) return 0;
    int got = ae_ringbuf_read(&e->playback_ring, out, frames);
    for (int i = got; i < frames; i++) out[i] = 0.0f;
    float gain = e->master_volume;
    if (e->ptt_engaged && e->cfg.ptt_mute_scope != AE_PTT_MUTE_NONE) gain = 0.0f;
    if (gain != 1.0f) for (int i = 0; i < frames; i++) out[i] *= gain;
    return frames;
}

void ae_engine_process(ae_engine_t *e) { (void)e; }

ae_stats_t ae_engine_get_stats(const ae_engine_t *e) {
    ae_stats_t s = {0};
    if (!e) return s;
    s.rtt_ms = e->rtt_ms; s.packet_loss_pct = e->packet_loss_pct;
    s.packets_sent = e->packets_sent; s.packets_received = e->packets_received;
    s.packets_dropped = e->packets_dropped;
    s.subscribed_channels = 0;
    for (int i = 0; i < AE_MAX_SUBSCRIBED_CHANNELS; i++) if (e->channels[i].in_use) s.subscribed_channels++;
    s.mode = e->cfg.session_mode;
    return s;
}
