cmake_minimum_required(VERSION 3.14)
project(audio_engine_core C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(CORE_SOURCES
    src/audio_engine.c
    src/opus_codec.c
    src/jitter_buffer.c
    src/mixer.c
    src/crypto.c
    src/rtp.c
    src/network.c
    src/ws_client.c
    src/ring_buffer.c
)

set(CORE_HEADERS
    include/audio_engine.h
    src/opus_codec.h
    src/jitter_buffer.h
    src/mixer.h
    src/crypto.h
    src/rtp.h
    src/network.h
    src/ws_client.h
    src/ring_buffer.h
    src/atomic_compat.h
    src/internal.h
)

add_library(audio_engine_static STATIC ${CORE_SOURCES} ${CORE_HEADERS})
target_include_directories(audio_engine_static
    PUBLIC  ${CMAKE_CURRENT_SOURCE_DIR}/include
    PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src
)
set_target_properties(audio_engine_static PROPERTIES OUTPUT_NAME audio_engine)

add_library(audio_engine_shared SHARED ${CORE_SOURCES} ${CORE_HEADERS})
target_include_directories(audio_engine_shared
    PUBLIC  ${CMAKE_CURRENT_SOURCE_DIR}/include
    PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src
)
set_target_properties(audio_engine_shared PROPERTIES
    OUTPUT_NAME audio_engine VERSION 0.1.0 SOVERSION 0
)
target_compile_definitions(audio_engine_shared PRIVATE AE_BUILDING_DLL)

find_package(PkgConfig QUIET)
if(PKG_CONFIG_FOUND)
    pkg_check_modules(OPUS QUIET opus)
endif()
if(OPUS_FOUND)
    target_include_directories(audio_engine_static PRIVATE ${OPUS_INCLUDE_DIRS})
    target_link_libraries(audio_engine_static PRIVATE ${OPUS_LIBRARIES})
    target_include_directories(audio_engine_shared PRIVATE ${OPUS_INCLUDE_DIRS})
    target_link_libraries(audio_engine_shared PRIVATE ${OPUS_LIBRARIES})
else()
    find_library(OPUS_LIB NAMES opus)
    find_path(OPUS_INC NAMES opus/opus.h)
    if(OPUS_LIB AND OPUS_INC)
        target_include_directories(audio_engine_static PRIVATE ${OPUS_INC})
        target_link_libraries(audio_engine_static PRIVATE ${OPUS_LIB})
        target_include_directories(audio_engine_shared PRIVATE ${OPUS_INC})
        target_link_libraries(audio_engine_shared PRIVATE ${OPUS_LIB})
    else()
        message(WARNING "libopus not found. Set OPUS_ROOT or install via vcpkg.")
        if(DEFINED OPUS_ROOT)
            target_include_directories(audio_engine_static PRIVATE ${OPUS_ROOT}/include)
            target_link_directories(audio_engine_static PRIVATE ${OPUS_ROOT}/lib)
            target_link_libraries(audio_engine_static PRIVATE opus)
            target_include_directories(audio_engine_shared PRIVATE ${OPUS_ROOT}/include)
            target_link_directories(audio_engine_shared PRIVATE ${OPUS_ROOT}/lib)
            target_link_libraries(audio_engine_shared PRIVATE opus)
        endif()
    endif()
endif()

find_package(OpenSSL QUIET)
if(OPENSSL_FOUND)
    message(STATUS "OpenSSL found: AES-256-GCM available")
    target_compile_definitions(audio_engine_static PRIVATE AE_CRYPTO_OPENSSL)
    target_link_libraries(audio_engine_static PRIVATE OpenSSL::Crypto)
    target_compile_definitions(audio_engine_shared PRIVATE AE_CRYPTO_OPENSSL)
    target_link_libraries(audio_engine_shared PRIVATE OpenSSL::Crypto)
else()
    message(STATUS "OpenSSL not found: using software AES-256-GCM (slower)")
endif()

if(WIN32)
    target_link_libraries(audio_engine_static PRIVATE ws2_32 bcrypt)
    target_link_libraries(audio_engine_shared PRIVATE ws2_32 bcrypt)
elseif(ANDROID)
    target_link_libraries(audio_engine_static PRIVATE log)
    target_link_libraries(audio_engine_shared PRIVATE log)
endif()

if(UNIX AND NOT APPLE)
    target_link_libraries(audio_engine_static PRIVATE m pthread)
    target_link_libraries(audio_engine_shared PRIVATE m pthread)
endif()

if(MSVC)
    target_compile_options(audio_engine_static PRIVATE /W4)
    target_compile_options(audio_engine_shared PRIVATE /W4)
else()
    target_compile_options(audio_engine_static PRIVATE -Wall -Wextra -Wpedantic -Wno-unused-parameter)
    target_compile_options(audio_engine_shared PRIVATE -Wall -Wextra -Wpedantic -Wno-unused-parameter)
endif()

include(GNUInstallDirs)
install(TARGETS audio_engine_static audio_engine_shared
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
    LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
)
install(FILES include/audio_engine.h DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
