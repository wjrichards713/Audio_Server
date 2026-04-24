/**
 * @file ring_buffer.c — SPSC implementation.
 */
#include "ring_buffer.h"
#include <stdlib.h>
#include <string.h>

static uint32_t round_up_pow2(uint32_t v) {
    if (v < 2) return 2;
    v--; v |= v >> 1; v |= v >> 2; v |= v >> 4; v |= v >> 8; v |= v >> 16;
    return v + 1;
}

int ae_ringbuf_init(ae_ringbuf_t *rb, uint32_t min_capacity) {
    if (!rb) return -1;
    uint32_t cap = round_up_pow2(min_capacity);
    rb->buf = (float *)calloc(cap, sizeof(float));
    if (!rb->buf) return -1;
    rb->capacity = cap; rb->mask = cap - 1u;
    ae_atomic_store_u32(&rb->head, 0);
    ae_atomic_store_u32(&rb->tail, 0);
    return 0;
}
void ae_ringbuf_destroy(ae_ringbuf_t *rb) { if (!rb) return; free(rb->buf); rb->buf = NULL; rb->capacity = rb->mask = 0; }
void ae_ringbuf_reset(ae_ringbuf_t *rb)   { if (!rb) return; ae_atomic_store_u32(&rb->head, 0); ae_atomic_store_u32(&rb->tail, 0); }
uint32_t ae_ringbuf_available(const ae_ringbuf_t *rb) { if (!rb) return 0; uint32_t h = ae_atomic_load_u32((ae_atomic_u32 *)&rb->head); uint32_t t = ae_atomic_load_u32((ae_atomic_u32 *)&rb->tail); return h - t; }
uint32_t ae_ringbuf_space(const ae_ringbuf_t *rb)     { if (!rb) return 0; return rb->capacity - ae_ringbuf_available(rb); }

uint32_t ae_ringbuf_write(ae_ringbuf_t *rb, const float *src, uint32_t n) {
    if (!rb || !src || n == 0) return 0;
    uint32_t h = ae_atomic_load_u32(&rb->head);
    uint32_t t = ae_atomic_load_u32(&rb->tail);
    uint32_t free_sp = rb->capacity - (h - t);
    if (n > free_sp) n = free_sp;
    if (n == 0) return 0;
    uint32_t start = h & rb->mask;
    uint32_t first = (start + n <= rb->capacity) ? n : (rb->capacity - start);
    memcpy(rb->buf + start, src, first * sizeof(float));
    if (n > first) memcpy(rb->buf, src + first, (n - first) * sizeof(float));
    ae_atomic_store_u32(&rb->head, h + n);
    return n;
}

uint32_t ae_ringbuf_read(ae_ringbuf_t *rb, float *dst, uint32_t n) {
    if (!rb || !dst || n == 0) return 0;
    uint32_t h = ae_atomic_load_u32(&rb->head);
    uint32_t t = ae_atomic_load_u32(&rb->tail);
    uint32_t avail = h - t;
    if (n > avail) n = avail;
    if (n == 0) return 0;
    uint32_t start = t & rb->mask;
    uint32_t first = (start + n <= rb->capacity) ? n : (rb->capacity - start);
    memcpy(dst, rb->buf + start, first * sizeof(float));
    if (n > first) memcpy(dst + first, rb->buf, (n - first) * sizeof(float));
    ae_atomic_store_u32(&rb->tail, t + n);
    return n;
}
