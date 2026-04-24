/**
 * audio_engine.h — Cross-platform real-time audio engine (v2 wire protocol).
 * Public API for the shared C library used by all clients.
 */
#ifndef AUDIO_ENGINE_H
#define AUDIO_ENGINE_H
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
#ifdef _WIN32
  #ifdef AE_BUILDING_DLL
    #define AE_API __declspec(dllexport)
  #else
    #define AE_API __declspec(dllimport)
  #endif
#else
  #define AE_API __attribute__((visibility("default")))
#endif

#define AE_SAMPLE_RATE              48000
#define AE_FRAME_SIZE_SAMPLES         960
#define AE_FRAME_DURATION_MS           20
#define AE_MAX_SUBSCRIBED_CHANNELS    200
#define AE_MAX_MIX_INPUTS               8
#define AE_JITTER_DEFAULT_FRAMES        3
#define AE_OPUS_BITRATE_BPS         24000

typedef enum {
    AE_OK = 0, AE_ERR_INVALID_PARAM = -1, AE_ERR_NO_MEMORY = -2,
    AE_ERR_OPUS = -3, AE_ERR_NETWORK = -4, AE_ERR_CRYPTO = -5,
    AE_ERR_FULL = -6, AE_ERR_NOT_FOUND = -7, AE_ERR_NOT_CONNECTED = -8,
    AE_ERR_AUTH = -9, AE_ERR_PROTOCOL = -10, AE_ERR_TIMEOUT = -11,
} ae_error_t;

typedef struct ae_engine ae_engine_t;

typedef enum { AE_MODE_MIX = 0, AE_MODE_FORWARD = 1 } ae_session_mode_t;
typedef enum { AE_PTT_MUTE_ALL = 0, AE_PTT_MUTE_OTHERS = 1, AE_PTT_MUTE_NONE = 2 } ae_ptt_mute_scope_t;
typedef enum { AE_PRIO_NORMAL = 0, AE_PRIO_HIGH = 1, AE_PRIO_EMERGENCY = 2, AE_PRIO_IMMINENT_PERIL = 3 } ae_priority_t;
typedef enum { AE_ROLE_NORMAL = 0, AE_ROLE_MONITOR = 1, AE_ROLE_EMERGENCY_OVERRIDE = 2 } ae_channel_role_t;

typedef int (*ae_capture_callback_t)(float *samples, int frames, void *ud);
typedef void (*ae_playback_callback_t)(const float *samples, int frames, void *ud);

typedef enum {
    AE_EVENT_CONNECTED, AE_EVENT_DISCONNECTED, AE_EVENT_AUTHED,
    AE_EVENT_SUBSCRIBED, AE_EVENT_UNSUBSCRIBED,
    AE_EVENT_USER_JOINED, AE_EVENT_USER_LEFT,
    AE_EVENT_USER_SPEAKING, AE_EVENT_USER_STOPPED,
    AE_EVENT_FLOOR_GRANTED, AE_EVENT_FLOOR_DENIED,
    AE_EVENT_FLOOR_RELEASED, AE_EVENT_FLOOR_REVOKED, AE_EVENT_FLOOR_QUEUED,
    AE_EVENT_KEY_ROTATED, AE_EVENT_SERVER_MIGRATE, AE_EVENT_ERROR,
} ae_event_type_t;

typedef struct {
    ae_event_type_t type;
    uint32_t channel_id;
    uint64_t client_id;
    const char *user_name;
    const char *message;
    const char *new_server;
    int queue_position;
    ae_priority_t priority;
} ae_event_t;

typedef void (*ae_event_callback_t)(const ae_event_t *ev, void *ud);

typedef struct {
    int  sample_rate;
    int  frame_size_samples;
    int  opus_bitrate_bps;
    bool opus_fec;
    bool opus_dtx;
    int  opus_complexity;
    int  jitter_buffer_frames;
    ae_session_mode_t session_mode;
    ae_ptt_mute_scope_t ptt_mute_scope;
    bool pause_egress_during_ptt;
    float sidetone_db;
} ae_config_t;

AE_API ae_config_t ae_config_default(void);
AE_API ae_engine_t *ae_engine_create(const ae_config_t *cfg);
AE_API void         ae_engine_destroy(ae_engine_t *e);

AE_API void ae_engine_set_capture_callback(ae_engine_t *e, ae_capture_callback_t cb, void *ud);
AE_API void ae_engine_set_playback_callback(ae_engine_t *e, ae_playback_callback_t cb, void *ud);
AE_API void ae_engine_set_event_callback(ae_engine_t *e, ae_event_callback_t cb, void *ud);

AE_API ae_error_t ae_engine_connect(ae_engine_t *e, const char *server_host, int ws_port, const char *jwt, const char *device_id);
AE_API void       ae_engine_disconnect(ae_engine_t *e);
AE_API bool       ae_engine_is_connected(const ae_engine_t *e);
AE_API bool       ae_engine_is_authed(const ae_engine_t *e);

AE_API ae_error_t ae_engine_set_session_mode(ae_engine_t *e, ae_session_mode_t mode);
AE_API ae_error_t ae_engine_set_ptt_mute_scope(ae_engine_t *e, ae_ptt_mute_scope_t scope);
AE_API ae_error_t ae_engine_set_pause_egress_during_ptt(ae_engine_t *e, bool on);
AE_API ae_error_t ae_engine_set_sidetone_db(ae_engine_t *e, float db);
AE_API ae_error_t ae_engine_set_master_volume(ae_engine_t *e, float linear_gain);

AE_API ae_error_t ae_engine_subscribe(ae_engine_t *e, uint32_t channel_id, float gain_db, bool muted, bool solo, ae_channel_role_t role);
AE_API ae_error_t ae_engine_unsubscribe(ae_engine_t *e, uint32_t channel_id);
AE_API ae_error_t ae_engine_unsubscribe_all(ae_engine_t *e);

AE_API ae_error_t ae_engine_set_channel_gain_db(ae_engine_t *e, uint32_t channel_id, float gain_db);
AE_API ae_error_t ae_engine_set_channel_muted(ae_engine_t *e, uint32_t channel_id, bool muted);
AE_API ae_error_t ae_engine_set_channel_solo(ae_engine_t *e, uint32_t channel_id, bool solo);
AE_API ae_error_t ae_engine_set_channel_role(ae_engine_t *e, uint32_t channel_id, ae_channel_role_t role);

AE_API ae_error_t ae_engine_floor_request(ae_engine_t *e, uint32_t channel_id, ae_priority_t pr);
AE_API ae_error_t ae_engine_floor_release(ae_engine_t *e, uint32_t channel_id);
AE_API bool       ae_engine_has_floor(const ae_engine_t *e, uint32_t channel_id);

AE_API ae_error_t ae_engine_write_capture(ae_engine_t *e, const float *samples, int frames);
AE_API int        ae_engine_read_playback(ae_engine_t *e, float *samples, int frames);
AE_API void       ae_engine_process(ae_engine_t *e);

typedef struct {
    float rtt_ms; float jitter_ms; float packet_loss_pct;
    uint64_t packets_sent; uint64_t packets_received; uint64_t packets_dropped;
    uint64_t decode_errors;
    int active_streams; int subscribed_channels; int buffer_underruns;
    ae_session_mode_t mode;
} ae_stats_t;
AE_API ae_stats_t ae_engine_get_stats(const ae_engine_t *e);

typedef enum { AE_LOG_DEBUG, AE_LOG_INFO, AE_LOG_WARN, AE_LOG_ERROR } ae_log_level_t;
typedef void (*ae_log_callback_t)(ae_log_level_t level, const char *msg, void *ud);
AE_API void ae_log_set_callback(ae_log_callback_t cb, void *ud);
AE_API void ae_log_set_level(ae_log_level_t level);

#ifdef __cplusplus
}
#endif
#endif
