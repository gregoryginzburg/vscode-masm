cmake_minimum_required(VERSION 3.20)
project(MasmDebugAdapter LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Needed to aboid a crash when locking std::mutex, when the user doesn't have the latest VSRedist140* package
# More info:
# https://stackoverflow.com/questions/78598141/first-stdmutexlock-crashes-in-application-built-with-latest-visual-studio
# https://developercommunity.visualstudio.com/t/Access-violation-in-_Thrd_yield-after-up/10664660
add_compile_definitions(_DISABLE_CONSTEXPR_MUTEX_CONSTRUCTOR)

add_executable(${PROJECT_NAME} main.cpp debugger.cpp event.cpp)

add_subdirectory(cppdap)

target_link_libraries(${PROJECT_NAME}
    PRIVATE
        cppdap
        dbgeng.lib
        rpcrt4.lib
        dbghelp.lib
)

target_include_directories(${PROJECT_NAME}
    PRIVATE
        ${CMAKE_SOURCE_DIR}/path/to/cppdap/include
)


if(MSVC)
    target_compile_options(${PROJECT_NAME} PRIVATE /W4 /permissive- /MP)
endif()


add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy
        $<TARGET_FILE:${PROJECT_NAME}>
        ${CMAKE_BINARY_DIR}/../../bin/$<TARGET_FILE_NAME:${PROJECT_NAME}>
)
