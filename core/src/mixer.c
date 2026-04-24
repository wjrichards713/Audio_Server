/**
 * @file mixer.c — float32 mixer impl.
 */
#include "mixer.h"
#include <math.h>
#include <string.h>

int ae_mixer_init(ae_mixer_t *m, int max_inputs, int frame_size) {
    if (!m || max_inputs <= 0 || frame_size <= 0) return -1;
    m->max_inputs = max_inputs; m->frame_size = frame_size;
    return 0;
}
void ae_mixer_destroy(ae_mixer_t *m) { (void)m; }

void ae_mixer_mix(ae_mixer_t *m, const float * const *inputs,
                  const float *prev_gains, const float *target_gains,
                  float *out_prev_gains, int n_inputs,
                  float *out, int frame_size, bool apply_limiter) {
    if (!m || !out || frame_size <= 0) return;
    memset(out, 0, (size_t)frame_size * sizeof(float));
    if (!inputs || n_inputs <= 0) return;
    if (n_inputs > m->max_inputs) n_inputs = m->max_inputs;
    const int ramp = (AE_RAMP_SAMPLES < frame_size) ? AE_RAMP_SAMPLES : frame_size;
    for (int i = 0; i < n_inputs; i++) {
        if (!inputs[i]) { if (out_prev_gains && target_gains) out_prev_gains[i] = target_gains[i]; continue; }
        float g0 = prev_gains   ? prev_gains[i]   : 1.0f;
        float g1 = target_gains ? target_gains[i] : 1.0f;
        if (fabsf(g0 - g1) < 1e-6f) {
            if (fabsf(g1 - 1.0f) < 1e-6f) { for (int s = 0; s < frame_size; s++) out[s] += inputs[i][s]; }
            else if (fabsf(g1) > 1e-9f)   { for (int s = 0; s < frame_size; s++) out[s] += inputs[i][s] * g1; }
        } else {
            float step = (g1 - g0) / (float)ramp;
            float g = g0;
            int s = 0;
            for (; s < ramp; s++) { out[s] += inputs[i][s] * g; g += step; }
            for (; s < frame_size; s++) out[s] += inputs[i][s] * g1;
        }
        if (out_prev_gains) out_prev_gains[i] = g1;
    }
    if (apply_limiter) for (int s = 0; s < frame_size; s++) out[s] = tanhf(out[s]);
}
