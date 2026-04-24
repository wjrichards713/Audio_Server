/**
 * @file jitter_buffer.c — implementation.
 */
#include "jitter_buffer.h"
#include <string.h>

static inline int32_t seq_cmp(uint32_t a, uint32_t b) { return (int32_t)(a - b); }

int ae_jb_init(ae_jb_t *jb, uint32_t capacity, uint32_t min_fill, uint32_t max_fill) {
    if (!jb) return -1;
    memset(jb, 0, sizeof(*jb));
    if (capacity == 0) capacity = 8;
    if (capacity > AE_JB_MAX_SLOTS) capacity = AE_JB_MAX_SLOTS;
    if (min_fill > capacity) min_fill = capacity;
    if (max_fill == 0 || max_fill > capacity) max_fill = capacity;
    jb->capacity = capacity; jb->min_fill = min_fill; jb->max_fill = max_fill;
    jb->last_popped = -1;
    return 0;
}
void ae_jb_destroy(ae_jb_t *jb) { if (jb) memset(jb, 0, sizeof(*jb)); }
void ae_jb_reset(ae_jb_t *jb) {
    if (!jb) return;
    for (uint32_t i = 0; i < AE_JB_MAX_SLOTS; i++) jb->slots[i].used = false;
    jb->count = 0; jb->last_popped = -1;
    jb->received = jb->popped = jb->dropped_overflow = jb->dropped_late = jb->reordered = 0;
}

static int oldest_slot(const ae_jb_t *jb) {
    int best = -1; uint32_t best_seq = 0;
    for (uint32_t i = 0; i < jb->capacity; i++) {
        if (!jb->slots[i].used) continue;
        if (best < 0 || seq_cmp(jb->slots[i].seq, best_seq) < 0) { best = (int)i; best_seq = jb->slots[i].seq; }
    }
    return best;
}

int ae_jb_push(ae_jb_t *jb, uint32_t seq, const uint8_t *frame, int frame_len) {
    if (!jb || !frame || frame_len < 0 || frame_len > AE_JB_MAX_FRAME_BYTES) return -1;
    if (jb->last_popped >= 0 && seq_cmp(seq, (uint32_t)jb->last_popped) <= 0) { jb->dropped_late++; return -1; }
    for (uint32_t i = 0; i < jb->capacity; i++) {
        if (jb->slots[i].used && jb->slots[i].seq == seq) {
            memcpy(jb->slots[i].data, frame, (size_t)frame_len);
            jb->slots[i].len = frame_len;
            return 1;
        }
    }
    int free_idx = -1;
    for (uint32_t i = 0; i < jb->capacity; i++) { if (!jb->slots[i].used) { free_idx = (int)i; break; } }
    if (free_idx < 0 || jb->count >= jb->max_fill) {
        int old = oldest_slot(jb);
        if (old >= 0) { jb->slots[old].used = false; jb->count--; jb->dropped_overflow++; if (free_idx < 0) free_idx = old; }
        else { jb->dropped_overflow++; return -1; }
    }
    ae_jb_slot_t *s = &jb->slots[free_idx];
    memcpy(s->data, frame, (size_t)frame_len);
    s->len = frame_len; s->seq = seq; s->used = true;
    jb->count++; jb->received++;
    for (uint32_t i = 0; i < jb->capacity; i++) {
        if (jb->slots[i].used && i != (uint32_t)free_idx && seq_cmp(jb->slots[i].seq, seq) > 0) { jb->reordered++; break; }
    }
    return 0;
}

int ae_jb_pop(ae_jb_t *jb, uint8_t *out_frame, int out_cap) {
    if (!jb || !out_frame) return -1;
    if (jb->count < jb->min_fill) return -1;
    int idx = oldest_slot(jb);
    if (idx < 0) return -1;
    ae_jb_slot_t *s = &jb->slots[idx];
    int n = s->len; if (n > out_cap) n = out_cap;
    memcpy(out_frame, s->data, (size_t)n);
    jb->last_popped = (int32_t)s->seq;
    s->used = false; jb->count--; jb->popped++;
    return n;
}

int32_t ae_jb_peek_next_seq(const ae_jb_t *jb) {
    if (!jb) return -1;
    int idx = oldest_slot(jb);
    return idx < 0 ? -1 : (int32_t)jb->slots[idx].seq;
}
uint32_t ae_jb_count(const ae_jb_t *jb) { return jb ? jb->count : 0u; }
