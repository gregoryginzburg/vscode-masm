#pragma once

#include "dap/protocol.h"
#include "dap/session.h"

#include <Windows.h>
#include <DbgEng.h>

#include <any>
#include <condition_variable>
#include <functional>
#include <future>
#include <mutex>
#include <queue>
#include <string>
#include <unordered_map>
#include <vector>

class Debugger {
public:
    enum class Event {
        BreakpointHit,
        Stepped,
        Paused,
        Exited
    };

    using EventHandler = std::function<void(Event)>;

    Debugger(const EventHandler& handler);
    ~Debugger();

    void launch(const std::string& program, const std::string& args);
    void attach(DWORD processId);
    void configurationDone();

    // Control methods that queue commands
    void run();
    void pause();
    void stepOver();
    void stepInto();
    void stepOut();
    void setBreakpoints(const std::string& sourceFile, const std::vector<dap::integer>& lines);

    // Methods to get debugger information
    std::vector<std::string> getRegisters();
    std::vector<dap::StackFrame> getCallStack();

    // Start the event loop; must be called from the same thread that initializes DbgEng
    void eventLoop();

    // Signal the debugger to exit
    void exit();

private:
    void initialize();
    void uninitialize();

    // Command types
    enum class CommandType {
        Run,
        Pause,
        StepOver,
        StepInto,
        StepOut,
        SetBreakpoints,
        GetRegisters,
        GetCallStack,
        Exit
    };

    // Command structure
    struct Command {
        CommandType type;
        std::any data;
        std::promise<std::any> promise;
    };

    // Thread-safe command queue
    std::queue<Command> commandQueue;
    std::mutex commandMutex;
    std::condition_variable commandCV;
    bool shouldExit = false;

    // Event handler
    EventHandler onEvent;

    // DbgEng interfaces
    IDebugClient* debugClient = nullptr;
    IDebugControl* debugControl = nullptr;
    IDebugSymbols* debugSymbols = nullptr;
    IDebugRegisters* debugRegisters = nullptr;
    IDebugSystemObjects* debugSystemObjects = nullptr;

    // Mutex to protect access to debugControl
    std::mutex debugControlMutex;

    // Breakpoints
    std::unordered_map<ULONG64, IDebugBreakpoint*> breakpoints;

    // Current execution info
    ULONG currentThreadId = 0;
    ULONG64 currentInstructionOffset = 0;
};

