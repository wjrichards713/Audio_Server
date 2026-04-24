/**
 * @file jitter_buffer.h — per-stream jitter buffer of opaque encoded frames.
 */
#ifndef AE_JITTER_BUFFER_H
#define AE_JITTER_BUFFER_H
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
#define AE_JB_MAX_FRAME_BYTES 2048
#define AE_JB_MAX_SLOTS         64

typedef struct {
    uint8_t  data[AE_JB_MAX_FRAME_BYTES];
    int      len;
    uint32_t seq;
    bool     used;
} ae_jb_slot_t;

typedef struct {
    ae_jb_slot_t slots[AE_JB_MAX_SLOTS];
    uint32_t     capacity;
    uint32_t     min_fill;
    uint32_t     max_fill;
    uint32_t     count;
    int32_t      last_popped;
    uint64_t received, popped, dropped_overflow, dropped_late, reordered;
} ae_jb_t;

int  ae_jb_init(ae_jb_t *jb, uint32_t capacity, uint32_t min_fill, uint32_t max_fill);
void ae_jb_destroy(ae_jb_t *jb);
void ae_jb_reset(ae_jb_t *jb);
int  ae_jb_push(ae_jb_t *jb, uint32_t seq, const uint8_t *frame, int frame_len);
int  ae_jb_pop(ae_jb_t *jb, uint8_t *out_frame, int out_cap);
int32_t ae_jb_peek_next_seq(const ae_jb_t *jb);
uint32_t ae_jb_count(const ae_jb_t *jb);
#ifdef __cplusplus
}
#endif
#endif
