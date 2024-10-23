#pragma once

#include <condition_variable>
#include <mutex>

class Event {
public:
    // wait() blocks until the event is fired.
    void wait();

    // fire() signals the event, and unblocks any calls to wait().
    void fire();

private:
    std::mutex mutex;
    std::condition_variable cv;
    bool fired = false;
};

