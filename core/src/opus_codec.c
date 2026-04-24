/**
 * @file opus_codec.c — libopus wrapper.
 */
#include "opus_codec.h"
#include "../include/audio_engine.h"
#include <opus.h>
#include <stdlib.h>
#include <string.h>

struct ae_opus_enc { OpusEncoder *enc; int channels; int frame_size; };
struct ae_opus_dec { OpusDecoder *dec; int channels; int frame_size; };

ae_opus_enc_t *ae_opus_encoder_create_simple(int sample_rate, int channels, int application,
                                             int bitrate_bps, int complexity, int fec, int dtx) {
    if (sample_rate <= 0) sample_rate = AE_SAMPLE_RATE;
    if (channels != 1 && channels != 2) channels = 1;
    if (complexity < 0 || complexity > 10) complexity = 8;
    ae_opus_enc_t *e = (ae_opus_enc_t *)calloc(1, sizeof(*e));
    if (!e) return NULL;
    int err = OPUS_OK;
    int app = application ? OPUS_APPLICATION_VOIP : OPUS_APPLICATION_AUDIO;
    e->enc = opus_encoder_create(sample_rate, channels, app, &err);
    if (err != OPUS_OK || !e->enc) { free(e); return NULL; }
    e->channels = channels;
    e->frame_size = (sample_rate / 1000) * AE_FRAME_DURATION_MS;
    if (bitrate_bps > 0) opus_encoder_ctl(e->enc, OPUS_SET_BITRATE(bitrate_bps));
    opus_encoder_ctl(e->enc, OPUS_SET_COMPLEXITY(complexity));
    opus_encoder_ctl(e->enc, OPUS_SET_INBAND_FEC(fec ? 1 : 0));
    opus_encoder_ctl(e->enc, OPUS_SET_PACKET_LOSS_PERC(fec ? 10 : 0));
    opus_encoder_ctl(e->enc, OPUS_SET_DTX(dtx ? 1 : 0));
    opus_encoder_ctl(e->enc, OPUS_SET_SIGNAL(app == OPUS_APPLICATION_VOIP ? OPUS_SIGNAL_VOICE : OPUS_AUTO));
    return e;
}

int ae_opus_encoder_create(int sample_rate, int channels, int application,
                            int bitrate_bps, int complexity, int fec, int dtx,
                            ae_opus_enc_t **out_enc) {
    if (!out_enc) return -1;
    *out_enc = ae_opus_encoder_create_simple(sample_rate, channels, application, bitrate_bps, complexity, fec, dtx);
    return *out_enc ? 0 : -1;
}

void ae_opus_encoder_destroy(ae_opus_enc_t *enc) {
    if (!enc) return;
    if (enc->enc) opus_encoder_destroy(enc->enc);
    free(enc);
}

int ae_opus_enc_set_bitrate(ae_opus_enc_t *enc, int bitrate_bps) {
    if (!enc || !enc->enc) return -1;
    return opus_encoder_ctl(enc->enc, OPUS_SET_BITRATE(bitrate_bps)) == OPUS_OK ? 0 : -1;
}
int ae_opus_enc_set_packet_loss(ae_opus_enc_t *enc, int percent) {
    if (!enc || !enc->enc) return -1;
    if (percent < 0) percent = 0; if (percent > 100) percent = 100;
    return opus_encoder_ctl(enc->enc, OPUS_SET_PACKET_LOSS_PERC(percent)) == OPUS_OK ? 0 : -1;
}
int ae_opus_enc_set_fec(ae_opus_enc_t *enc, int on) {
    if (!enc || !enc->enc) return -1;
    return opus_encoder_ctl(enc->enc, OPUS_SET_INBAND_FEC(on ? 1 : 0)) == OPUS_OK ? 0 : -1;
}
int ae_opus_encode(ae_opus_enc_t *enc, const float *pcm_f32, uint8_t *out, int out_cap) {
    if (!enc || !enc->enc || !pcm_f32 || !out || out_cap <= 0) return -1;
    return opus_encode_float(enc->enc, pcm_f32, enc->frame_size, out, out_cap);
}

int ae_opus_decoder_create(int sample_rate, int channels, ae_opus_dec_t **out_dec) {
    if (!out_dec) return -1;
    if (sample_rate <= 0) sample_rate = AE_SAMPLE_RATE;
    if (channels != 1 && channels != 2) channels = 1;
    ae_opus_dec_t *d = (ae_opus_dec_t *)calloc(1, sizeof(*d));
    if (!d) return -1;
    int err = OPUS_OK;
    d->dec = opus_decoder_create(sample_rate, channels, &err);
    if (err != OPUS_OK || !d->dec) { free(d); return -1; }
    d->channels = channels;
    d->frame_size = (sample_rate / 1000) * AE_FRAME_DURATION_MS;
    *out_dec = d;
    return 0;
}
void ae_opus_decoder_destroy(ae_opus_dec_t *dec) {
    if (!dec) return;
    if (dec->dec) opus_decoder_destroy(dec->dec);
    free(dec);
}
int ae_opus_decode(ae_opus_dec_t *dec, const uint8_t *in, int in_len, float *out_pcm_f32, int decode_fec) {
    if (!dec || !dec->dec || !out_pcm_f32) return -1;
    const unsigned char *data = (in && in_len > 0) ? in : NULL;
    int len = (in && in_len > 0) ? in_len : 0;
    return opus_decode_float(dec->dec, data, len, out_pcm_f32, dec->frame_size, decode_fec ? 1 : 0);
}
int ae_opus_decode_plc(ae_opus_dec_t *dec, float *out_pcm_f32) { return ae_opus_decode(dec, NULL, 0, out_pcm_f32, 0); }
