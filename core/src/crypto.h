#ifndef AE_CRYPTO_H
#define AE_CRYPTO_H
#include <stdint.h>
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif

#define AE_CRYPTO_KEY_SIZE   32
#define AE_CRYPTO_NONCE_SIZE 12
#define AE_CRYPTO_TAG_SIZE   16

int  ae_crypto_seal(const uint8_t key[AE_CRYPTO_KEY_SIZE],
                    const uint8_t nonce[AE_CRYPTO_NONCE_SIZE],
                    const uint8_t *aad, int aad_len,
                    const uint8_t *plaintext, int pt_len,
                    uint8_t *out, int out_cap);
int  ae_crypto_open(const uint8_t key[AE_CRYPTO_KEY_SIZE],
                    const uint8_t nonce[AE_CRYPTO_NONCE_SIZE],
                    const uint8_t *aad, int aad_len,
                    const uint8_t *ct_and_tag, int ct_len,
                    uint8_t *out, int out_cap);
void ae_hkdf_extract(const uint8_t *salt, int salt_len,
                     const uint8_t *ikm, int ikm_len, uint8_t prk_out[32]);
int  ae_hkdf_expand(const uint8_t prk[32],
                    const uint8_t *info, int info_len,
                    uint8_t *okm_out, int okm_len);
void ae_derive_channel_key(const uint8_t session_key[32],
                           const char *tag, int tag_len,
                           uint32_t channel_id, uint16_t key_version,
                           uint8_t out[32]);
int  ae_crypto_random(uint8_t *buf, int len);
void ae_crypto_zeroize(void *buf, size_t len);
int  ae_crypto_ct_eq(const uint8_t *a, const uint8_t *b, size_t len);

#ifdef __cplusplus
}
#endif
#endif
