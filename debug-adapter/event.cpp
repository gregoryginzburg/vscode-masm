#include "event.h"

void Event::wait()
{
    std::unique_lock<std::mutex> lock(mutex);
    cv.wait(lock, [&] { return fired; });
}

void Event::fire()
{
    std::unique_lock<std::mutex> lock(mutex);
    fired = true;
    cv.notify_all();
}

void Event::reset()
{
    std::unique_lock<std::mutex> lock(mutex);
    fired = false;
}
