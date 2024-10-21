cmake_minimum_required(VERSION 3.20)
project(MasmDebugAdapter LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(${PROJECT_NAME} main.cpp)

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
