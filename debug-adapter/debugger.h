#pragma once

#include <windows.h>
#include <dbgeng.h>
#include <functional>
#include <vector>
#include <string>
#include <mutex>
#include <condition_variable>
#include <unordered_map>
#include "dap/protocol.h"
#include "event.h"

class Debugger
{
public:
    enum class EventType
    {
        BreakpointHit,
        Stepped,
        Paused,
        Exited,
        Exception
    };

    using EventHandler = std::function<void(EventType)>;

    Debugger(const EventHandler& handler);
    ~Debugger();

    void launch(const std::string& program, const std::string& args);
    void configurationDone();
    void run();
    void pause();
    void stepOver();
    void stepInto();
    void stepOut();
    void setBreakpoints(const std::string& sourceFile, const std::vector<dap::integer>& lines);
    std::vector<std::string> getRegisters();
    std::vector<dap::StackFrame> getCallStack();
    void exit();
    void eventLoop();
    void waitForInitialization();
    // void waitForConfigurationDone();

private:
    void initialize();
    void uninitialize();
    int getCurrentLineNumber();

    // Synchronization primitives
    std::mutex debugMutex;
    Event hasExited;
    Event hasInitialized;
    // Event configurationDoneEvent;
    bool isStopped = true;
    bool shouldExit = false;
    int lastLineBreak = -1;


    // Debugger interfaces
    IDebugClient* debugClient = nullptr;
    IDebugControl* debugControl = nullptr;
    IDebugSymbols* debugSymbols = nullptr;
    IDebugRegisters* debugRegisters = nullptr;
    IDebugSystemObjects* debugSystemObjects = nullptr;

    // Breakpoints
    std::unordered_map<ULONG64, IDebugBreakpoint*> breakpoints;

    // Other variables
    EventHandler onEvent;
};
