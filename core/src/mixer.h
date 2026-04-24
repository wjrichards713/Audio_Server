/**
 * @file mixer.h — small float32 mixer with linear ramp + tanh limiter.
 */
#ifndef AE_MIXER_H
#define AE_MIXER_H
#include <stdint.h>
#include <stdbool.h>
#ifdef __cplusplus
extern "C" {
#endif
#define AE_RAMP_SAMPLES 240

typedef struct {
    int max_inputs;
    int frame_size;
} ae_mixer_t;

int  ae_mixer_init(ae_mixer_t *m, int max_inputs, int frame_size);
void ae_mixer_destroy(ae_mixer_t *m);
void ae_mixer_mix(ae_mixer_t *m, const float * const *inputs,
                  const float *prev_gains, const float *target_gains,
                  float *out_prev_gains, int n_inputs,
                  float *out, int frame_size, bool apply_limiter);
#ifdef __cplusplus
}
#endif
#endif
