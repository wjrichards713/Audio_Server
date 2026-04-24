/**
 * @file crypto.c — AES-256-GCM + HKDF-SHA256.
 * Backends: AE_CRYPTO_OPENSSL (default) | AE_CRYPTO_MBEDTLS.
 */
#include "crypto.h"
#include <string.h>
#include <stdlib.h>

#if !defined(AE_CRYPTO_OPENSSL) && !defined(AE_CRYPTO_MBEDTLS)
#  define AE_CRYPTO_OPENSSL 1
#endif

#if defined(_WIN32)
#  include <windows.h>
#  include <bcrypt.h>
#  ifdef _MSC_VER
#    pragma comment(lib, "bcrypt.lib")
#  endif
int ae_crypto_random(uint8_t *buf, int len) {
    if (!buf || len < 0) return -1;
    if (len == 0) return 0;
    NTSTATUS s = BCryptGenRandom(NULL, buf, (ULONG)len, BCRYPT_USE_SYSTEM_PREFERRED_RNG);
    return (s == 0) ? 0 : -1;
}
#elif defined(__linux__)
#  include <sys/random.h>
#  include <errno.h>
int ae_crypto_random(uint8_t *buf, int len) {
    if (!buf || len < 0) return -1;
    int off = 0;
    while (off < len) {
        ssize_t n = getrandom(buf + off, (size_t)(len - off), 0);
        if (n < 0) { if (errno == EINTR) continue; return -1; }
        off += (int)n;
    }
    return 0;
}
#else
#  include <stdio.h>
int ae_crypto_random(uint8_t *buf, int len) {
    if (!buf || len < 0) return -1;
    FILE *f = fopen("/dev/urandom", "rb");
    if (!f) return -1;
    int ok = ((int)fread(buf, 1, (size_t)len, f) == len) ? 0 : -1;
    fclose(f); return ok;
}
#endif

void ae_crypto_zeroize(void *buf, size_t len) {
#if defined(AE_CRYPTO_OPENSSL)
    extern void OPENSSL_cleanse(void *ptr, size_t len);
    OPENSSL_cleanse(buf, len);
#else
    volatile uint8_t *p = (volatile uint8_t *)buf;
    while (len--) *p++ = 0;
#endif
}

int ae_crypto_ct_eq(const uint8_t *a, const uint8_t *b, size_t len) {
    if (!a || !b) return 0;
    uint8_t diff = 0;
    for (size_t i = 0; i < len; i++) diff |= (uint8_t)(a[i] ^ b[i]);
    return diff == 0 ? 1 : 0;
}

#if defined(AE_CRYPTO_OPENSSL)
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/err.h>

int ae_crypto_seal(const uint8_t key[AE_CRYPTO_KEY_SIZE], const uint8_t nonce[AE_CRYPTO_NONCE_SIZE],
                   const uint8_t *aad, int aad_len,
                   const uint8_t *plaintext, int pt_len,
                   uint8_t *out, int out_cap) {
    if (!key || !nonce || !out || pt_len < 0 || aad_len < 0) return -1;
    if (out_cap < pt_len + AE_CRYPTO_TAG_SIZE) return -2;
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    if (!ctx) return -3;
    int ok = 1, outl = 0, final_len = 0;
    ok = ok && EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), NULL, NULL, NULL);
    ok = ok && EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, AE_CRYPTO_NONCE_SIZE, NULL);
    ok = ok && EVP_EncryptInit_ex(ctx, NULL, NULL, key, nonce);
    if (ok && aad && aad_len > 0) ok = ok && EVP_EncryptUpdate(ctx, NULL, &outl, aad, aad_len);
    if (ok && plaintext && pt_len > 0) ok = ok && EVP_EncryptUpdate(ctx, out, &outl, plaintext, pt_len);
    else outl = 0;
    ok = ok && EVP_EncryptFinal_ex(ctx, out + outl, &final_len);
    int body_len = outl + final_len;
    ok = ok && EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, AE_CRYPTO_TAG_SIZE, out + body_len);
    EVP_CIPHER_CTX_free(ctx);
    if (!ok) return -4;
    return body_len + AE_CRYPTO_TAG_SIZE;
}

int ae_crypto_open(const uint8_t key[AE_CRYPTO_KEY_SIZE], const uint8_t nonce[AE_CRYPTO_NONCE_SIZE],
                   const uint8_t *aad, int aad_len,
                   const uint8_t *ct_and_tag, int ct_len,
                   uint8_t *out, int out_cap) {
    if (!key || !nonce || !ct_and_tag || !out || aad_len < 0) return -2;
    if (ct_len < AE_CRYPTO_TAG_SIZE) return -2;
    int body = ct_len - AE_CRYPTO_TAG_SIZE;
    if (out_cap < body) return -2;
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    if (!ctx) return -2;
    int ok = 1, outl = 0, final_len = 0;
    ok = ok && EVP_DecryptInit_ex(ctx, EVP_aes_256_gcm(), NULL, NULL, NULL);
    ok = ok && EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, AE_CRYPTO_NONCE_SIZE, NULL);
    ok = ok && EVP_DecryptInit_ex(ctx, NULL, NULL, key, nonce);
    if (ok && aad && aad_len > 0) ok = ok && EVP_DecryptUpdate(ctx, NULL, &outl, aad, aad_len);
    if (ok && body > 0) ok = ok && EVP_DecryptUpdate(ctx, out, &outl, ct_and_tag, body);
    else outl = 0;
    ok = ok && EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG, AE_CRYPTO_TAG_SIZE, (void *)(ct_and_tag + body));
    int verified = ok ? EVP_DecryptFinal_ex(ctx, out + outl, &final_len) : 0;
    EVP_CIPHER_CTX_free(ctx);
    if (!ok || !verified) { if (body > 0) ae_crypto_zeroize(out, (size_t)body); return -1; }
    return outl + final_len;
}

void ae_hkdf_extract(const uint8_t *salt, int salt_len, const uint8_t *ikm, int ikm_len, uint8_t prk_out[32]) {
    unsigned int outlen = 32;
    const uint8_t zero_salt[32] = {0};
    const uint8_t *use_salt = (salt && salt_len > 0) ? salt : zero_salt;
    int use_salt_len = (salt && salt_len > 0) ? salt_len : 32;
    HMAC(EVP_sha256(), use_salt, use_salt_len, ikm ? ikm : (const uint8_t *)"", ikm_len > 0 ? ikm_len : 0, prk_out, &outlen);
}

int ae_hkdf_expand(const uint8_t prk[32], const uint8_t *info, int info_len, uint8_t *okm_out, int okm_len) {
    if (!prk || !okm_out || okm_len < 0) return -1;
    if (okm_len > 255 * 32) return -1;
    if (info_len < 0) info_len = 0;
    uint8_t t[32]; unsigned int tlen = 0;
    int produced = 0; uint8_t counter = 1;
    HMAC_CTX *ctx = HMAC_CTX_new();
    if (!ctx) return -1;
    while (produced < okm_len) {
        if (!HMAC_Init_ex(ctx, prk, 32, EVP_sha256(), NULL)) { HMAC_CTX_free(ctx); return -1; }
        if (counter > 1) if (!HMAC_Update(ctx, t, tlen)) { HMAC_CTX_free(ctx); return -1; }
        if (info && info_len > 0) if (!HMAC_Update(ctx, info, info_len)) { HMAC_CTX_free(ctx); return -1; }
        if (!HMAC_Update(ctx, &counter, 1)) { HMAC_CTX_free(ctx); return -1; }
        if (!HMAC_Final(ctx, t, &tlen)) { HMAC_CTX_free(ctx); return -1; }
        int take = (okm_len - produced) < (int)tlen ? (okm_len - produced) : (int)tlen;
        memcpy(okm_out + produced, t, (size_t)take);
        produced += take; counter++;
    }
    HMAC_CTX_free(ctx);
    ae_crypto_zeroize(t, sizeof(t));
    return 0;
}

#elif defined(AE_CRYPTO_MBEDTLS)
#include <mbedtls/gcm.h>
#include <mbedtls/hkdf.h>
#include <mbedtls/md.h>
int ae_crypto_seal(const uint8_t key[AE_CRYPTO_KEY_SIZE], const uint8_t nonce[AE_CRYPTO_NONCE_SIZE],
                   const uint8_t *aad, int aad_len, const uint8_t *plaintext, int pt_len,
                   uint8_t *out, int out_cap) {
    if (!key || !nonce || !out || pt_len < 0 || aad_len < 0) return -1;
    if (out_cap < pt_len + AE_CRYPTO_TAG_SIZE) return -2;
    mbedtls_gcm_context ctx; mbedtls_gcm_init(&ctx);
    int r = mbedtls_gcm_setkey(&ctx, MBEDTLS_CIPHER_ID_AES, key, 256);
    if (r == 0) r = mbedtls_gcm_crypt_and_tag(&ctx, MBEDTLS_GCM_ENCRYPT, (size_t)pt_len, nonce, AE_CRYPTO_NONCE_SIZE,
        aad ? aad : (const uint8_t *)"", (size_t)aad_len, plaintext, out, AE_CRYPTO_TAG_SIZE, out + pt_len);
    mbedtls_gcm_free(&ctx);
    return (r == 0) ? pt_len + AE_CRYPTO_TAG_SIZE : -3;
}
int ae_crypto_open(const uint8_t key[AE_CRYPTO_KEY_SIZE], const uint8_t nonce[AE_CRYPTO_NONCE_SIZE],
                   const uint8_t *aad, int aad_len, const uint8_t *ct_and_tag, int ct_len, uint8_t *out, int out_cap) {
    if (!key || !nonce || !ct_and_tag || !out || aad_len < 0) return -2;
    if (ct_len < AE_CRYPTO_TAG_SIZE) return -2;
    int body = ct_len - AE_CRYPTO_TAG_SIZE;
    if (out_cap < body) return -2;
    mbedtls_gcm_context ctx; mbedtls_gcm_init(&ctx);
    int r = mbedtls_gcm_setkey(&ctx, MBEDTLS_CIPHER_ID_AES, key, 256);
    if (r == 0) r = mbedtls_gcm_auth_decrypt(&ctx, (size_t)body, nonce, AE_CRYPTO_NONCE_SIZE,
        aad ? aad : (const uint8_t *)"", (size_t)aad_len, ct_and_tag + body, AE_CRYPTO_TAG_SIZE, ct_and_tag, out);
    mbedtls_gcm_free(&ctx);
    if (r != 0) { if (body > 0) ae_crypto_zeroize(out, (size_t)body); return -1; }
    return body;
}
void ae_hkdf_extract(const uint8_t *salt, int salt_len, const uint8_t *ikm, int ikm_len, uint8_t prk_out[32]) {
    const mbedtls_md_info_t *md = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    mbedtls_hkdf_extract(md, salt, salt_len > 0 ? (size_t)salt_len : 0, ikm, ikm_len > 0 ? (size_t)ikm_len : 0, prk_out);
}
int ae_hkdf_expand(const uint8_t prk[32], const uint8_t *info, int info_len, uint8_t *okm_out, int okm_len) {
    const mbedtls_md_info_t *md = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    int r = mbedtls_hkdf_expand(md, prk, 32, info, info_len > 0 ? (size_t)info_len : 0, okm_out, (size_t)okm_len);
    return r == 0 ? 0 : -1;
}
#else
#  error "No crypto backend selected: define AE_CRYPTO_OPENSSL or AE_CRYPTO_MBEDTLS"
#endif

void ae_derive_channel_key(const uint8_t session_key[32], const char *tag, int tag_len,
                           uint32_t channel_id, uint16_t key_version, uint8_t out[32]) {
    uint8_t info[16]; int n = 0;
    if (tag && tag_len > 0 && tag_len <= 8) { memcpy(info + n, tag, (size_t)tag_len); n += tag_len; }
    info[n++] = (uint8_t)(channel_id >> 24);
    info[n++] = (uint8_t)(channel_id >> 16);
    info[n++] = (uint8_t)(channel_id >>  8);
    info[n++] = (uint8_t)(channel_id);
    info[n++] = (uint8_t)(key_version >> 8);
    info[n++] = (uint8_t)(key_version);
    ae_hkdf_expand(session_key, info, n, out, 32);
    ae_crypto_zeroize(info, sizeof(info));
}
