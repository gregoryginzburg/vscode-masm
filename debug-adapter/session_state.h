#pragma once

#include <condition_variable>
#include <mutex>

struct SessionState {
    bool terminate = false;
    std::mutex mutex;
    std::condition_variable cv;
};

