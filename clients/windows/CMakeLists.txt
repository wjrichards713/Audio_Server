cmake_minimum_required(VERSION 3.20)
project(audio_client_windows CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT WIN32)
    message(FATAL_ERROR "audio_client_windows only builds on Windows.")
endif()

# Pull in the C engine via the core tree (shared lib so __declspec(dllimport) matches).
if(NOT TARGET audio_engine_shared)
    add_subdirectory(
        ${CMAKE_CURRENT_SOURCE_DIR}/../../core
        ${CMAKE_BINARY_DIR}/core
    )
endif()
if(NOT TARGET audio_engine)
    add_library(audio_engine ALIAS audio_engine_shared)
endif()

set(CLIENT_SOURCES
    src/main.cpp
    src/wasapi_io.cpp
    src/wasapi_io.h
    src/ui_console.cpp
    src/ui_console.h
    src/app_state.h
)
add_executable(audio_client_windows ${CLIENT_SOURCES})
set_target_properties(audio_client_windows PROPERTIES WIN32_EXECUTABLE FALSE)

target_include_directories(audio_client_windows PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR}/../../core/include
)
target_link_libraries(audio_client_windows PRIVATE
    audio_engine
    ws2_32 winmm avrt ole32 uuid
)
target_compile_definitions(audio_client_windows PRIVATE
    UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS
)
if(MSVC)
    target_compile_options(audio_client_windows PRIVATE /W4 /permissive- /Zc:__cplusplus /utf-8)
    set_target_properties(audio_client_windows PROPERTIES
        VS_DEBUGGER_WORKING_DIRECTORY "$<TARGET_FILE_DIR:audio_client_windows>")
endif()

# Post-build: copy DLL + example config next to the exe.
add_custom_command(TARGET audio_client_windows POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        $<TARGET_FILE:audio_engine_shared>
        $<TARGET_FILE_DIR:audio_client_windows>
    COMMENT "Copying audio_engine.dll next to audio_client_windows.exe")
add_custom_command(TARGET audio_client_windows POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        ${CMAKE_CURRENT_SOURCE_DIR}/config.example.toml
        $<TARGET_FILE_DIR:audio_client_windows>/config.example.toml
    COMMENT "Copying config.example.toml next to the exe")
