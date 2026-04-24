/**
 * @file ring_buffer.h — lock-free SPSC ring buffer of float32 samples.
 */
#ifndef AE_RING_BUFFER_H
#define AE_RING_BUFFER_H
#include "atomic_compat.h"
#include <stdint.h>
#include <stdbool.h>
#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    float          *buf;
    uint32_t        capacity;
    uint32_t        mask;
    ae_atomic_u32   head;
    ae_atomic_u32   tail;
} ae_ringbuf_t;

int  ae_ringbuf_init(ae_ringbuf_t *rb, uint32_t min_capacity);
void ae_ringbuf_destroy(ae_ringbuf_t *rb);
void ae_ringbuf_reset(ae_ringbuf_t *rb);
uint32_t ae_ringbuf_available(const ae_ringbuf_t *rb);
uint32_t ae_ringbuf_space(const ae_ringbuf_t *rb);
uint32_t ae_ringbuf_write(ae_ringbuf_t *rb, const float *src, uint32_t n);
uint32_t ae_ringbuf_read(ae_ringbuf_t *rb, float *dst, uint32_t n);
#ifdef __cplusplus
}
#endif
#endif
