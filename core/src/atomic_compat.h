/**
 * @file atomic_compat.h — portable atomics + mutex + thread + sleep wrappers.
 */
#ifndef AE_ATOMIC_COMPAT_H
#define AE_ATOMIC_COMPAT_H
#include <stdint.h>
#include <stdbool.h>

#if defined(_MSC_VER)
#include <intrin.h>
#include <windows.h>
typedef volatile long     ae_atomic_i32;
typedef volatile long     ae_atomic_u32;
typedef volatile __int64  ae_atomic_i64;
typedef volatile __int64  ae_atomic_u64;
typedef volatile long     ae_atomic_bool;
#define ae_atomic_store_i32(p, v)   (*(p) = (long)(v))
#define ae_atomic_load_i32(p)       (*(p))
#define ae_atomic_store_u32(p, v)   (*(p) = (long)(v))
#define ae_atomic_load_u32(p)       ((uint32_t)*(p))
#define ae_atomic_store_u64(p, v)   (*(p) = (__int64)(v))
#define ae_atomic_load_u64(p)       ((uint64_t)*(p))
#define ae_atomic_store_bool(p, v)  (*(p) = (v) ? 1 : 0)
#define ae_atomic_load_bool(p)      (*(p) != 0)
#define ae_atomic_fetch_add_i32(p, v)  _InterlockedExchangeAdd((p), (long)(v))
#define ae_atomic_fetch_add_u32(p, v)  ((uint32_t)_InterlockedExchangeAdd((p), (long)(v)))
#define ae_atomic_fetch_add_u64(p, v)  ((uint64_t)_InterlockedExchangeAdd64((p), (__int64)(v)))
#define ae_atomic_exchange_i32(p, v)   _InterlockedExchange((p), (long)(v))
#define ae_atomic_exchange_bool(p, v)  (_InterlockedExchange((p), (v) ? 1 : 0) != 0)
typedef CRITICAL_SECTION ae_mutex_t;
static __forceinline void ae_mutex_init(ae_mutex_t *m)    { InitializeCriticalSection(m); }
static __forceinline void ae_mutex_destroy(ae_mutex_t *m) { DeleteCriticalSection(m); }
static __forceinline void ae_mutex_lock(ae_mutex_t *m)    { EnterCriticalSection(m); }
static __forceinline void ae_mutex_unlock(ae_mutex_t *m)  { LeaveCriticalSection(m); }
typedef HANDLE ae_thread_t;
typedef DWORD  (WINAPI *ae_thread_fn_t)(LPVOID);
static __forceinline int  ae_thread_create(ae_thread_t *t, ae_thread_fn_t fn, void *arg) { *t = CreateThread(NULL, 0, fn, arg, 0, NULL); return (*t == NULL) ? -1 : 0; }
static __forceinline void ae_thread_join(ae_thread_t t) { if (t) { WaitForSingleObject(t, INFINITE); CloseHandle(t); } }
static __forceinline void ae_sleep_ms(unsigned int ms) { Sleep(ms); }
#else
#include <stdatomic.h>
#include <pthread.h>
#include <time.h>
#include <unistd.h>
typedef _Atomic int32_t   ae_atomic_i32;
typedef _Atomic uint32_t  ae_atomic_u32;
typedef _Atomic int64_t   ae_atomic_i64;
typedef _Atomic uint64_t  ae_atomic_u64;
typedef _Atomic bool      ae_atomic_bool;
#define ae_atomic_store_i32(p, v)   atomic_store_explicit((p), (v), memory_order_release)
#define ae_atomic_load_i32(p)       atomic_load_explicit((p), memory_order_acquire)
#define ae_atomic_store_u32(p, v)   atomic_store_explicit((p), (v), memory_order_release)
#define ae_atomic_load_u32(p)       atomic_load_explicit((p), memory_order_acquire)
#define ae_atomic_store_u64(p, v)   atomic_store_explicit((p), (v), memory_order_release)
#define ae_atomic_load_u64(p)       atomic_load_explicit((p), memory_order_acquire)
#define ae_atomic_store_bool(p, v)  atomic_store_explicit((p), (v), memory_order_release)
#define ae_atomic_load_bool(p)      atomic_load_explicit((p), memory_order_acquire)
#define ae_atomic_fetch_add_i32(p, v)  atomic_fetch_add_explicit((p), (v), memory_order_acq_rel)
#define ae_atomic_fetch_add_u32(p, v)  atomic_fetch_add_explicit((p), (v), memory_order_acq_rel)
#define ae_atomic_fetch_add_u64(p, v)  atomic_fetch_add_explicit((p), (v), memory_order_acq_rel)
#define ae_atomic_exchange_i32(p, v)   atomic_exchange_explicit((p), (v), memory_order_acq_rel)
#define ae_atomic_exchange_bool(p, v)  atomic_exchange_explicit((p), (v), memory_order_acq_rel)
typedef pthread_mutex_t ae_mutex_t;
static inline void ae_mutex_init(ae_mutex_t *m)    { pthread_mutex_init(m, NULL); }
static inline void ae_mutex_destroy(ae_mutex_t *m) { pthread_mutex_destroy(m); }
static inline void ae_mutex_lock(ae_mutex_t *m)    { pthread_mutex_lock(m); }
static inline void ae_mutex_unlock(ae_mutex_t *m)  { pthread_mutex_unlock(m); }
typedef pthread_t ae_thread_t;
typedef void *(*ae_thread_fn_t)(void *);
static inline int ae_thread_create(ae_thread_t *t, ae_thread_fn_t fn, void *arg) { return pthread_create(t, NULL, fn, arg); }
static inline void ae_thread_join(ae_thread_t t) { if (t) pthread_join(t, NULL); }
static inline void ae_sleep_ms(unsigned int ms) { struct timespec ts; ts.tv_sec=(time_t)(ms/1000u); ts.tv_nsec=(long)((ms%1000u)*1000000ul); nanosleep(&ts, NULL); }
#endif

/* compat aliases used by audio_engine.c */
#define mtx_init_compat(m)    ae_mutex_init(m)
#define mtx_destroy_compat(m) ae_mutex_destroy(m)
#define mtx_lock_compat(m)    ae_mutex_lock(m)
#define mtx_unlock_compat(m)  ae_mutex_unlock(m)

static inline uint64_t ae_now_ms(void) {
#if defined(_MSC_VER)
    static LARGE_INTEGER freq = {0};
    LARGE_INTEGER now;
    if (freq.QuadPart == 0) QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&now);
    return (uint64_t)((now.QuadPart * 1000ll) / freq.QuadPart);
#else
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000ull + (uint64_t)(ts.tv_nsec / 1000000);
#endif
}
#endif
