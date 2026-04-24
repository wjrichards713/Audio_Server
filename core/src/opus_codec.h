/**
 * @file opus_codec.h — thin libopus wrapper for 48 kHz 20 ms frames.
 */
#ifndef AE_OPUS_CODEC_H
#define AE_OPUS_CODEC_H
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#ifdef __cplusplus
extern "C" {
#endif
#define AE_OPUS_MAX_PACKET 4000
typedef struct ae_opus_enc ae_opus_enc_t;
typedef struct ae_opus_dec ae_opus_dec_t;

/* Two-arg create variants used by audio_engine.c. */
ae_opus_enc_t *ae_opus_encoder_create_simple(int sample_rate, int channels, int application,
                                             int bitrate_bps, int complexity, int fec, int dtx);
int ae_opus_encoder_create(int sample_rate, int channels, int application,
                            int bitrate_bps, int complexity, int fec, int dtx,
                            ae_opus_enc_t **out_enc);
void ae_opus_encoder_destroy(ae_opus_enc_t *enc);
int ae_opus_enc_set_bitrate(ae_opus_enc_t *enc, int bitrate_bps);
int ae_opus_enc_set_packet_loss(ae_opus_enc_t *enc, int percent);
int ae_opus_enc_set_fec(ae_opus_enc_t *enc, int on);
int ae_opus_encode(ae_opus_enc_t *enc, const float *pcm_f32, uint8_t *out, int out_cap);
int ae_opus_decoder_create(int sample_rate, int channels, ae_opus_dec_t **out_dec);
void ae_opus_decoder_destroy(ae_opus_dec_t *dec);
int ae_opus_decode(ae_opus_dec_t *dec, const uint8_t *in, int in_len, float *out_pcm_f32, int decode_fec);
int ae_opus_decode_plc(ae_opus_dec_t *dec, float *out_pcm_f32);
#ifdef __cplusplus
}
#endif
#endif
