// debugger.h

#pragma once

#include <windows.h>
#include <dbgeng.h>
#include <string>
#include <vector>
#include <mutex>
#include <functional>
#include <unordered_map>
#include "dap/protocol.h"
#include "event.h"
#include <map>


class Debugger {
public:
    enum class EventType { BreakpointHit, Stepped, Paused, Exited, Exception };

    struct Event {
        Event(EventType type) : type(type) {}
        Event(EventType type, std::string description) : type(type), description(description) {}
        EventType type;
        std::string description;
    };

    struct StackEntry {
        std::string address;
        std::string value;
    };

    struct ExceptionInfo {
        std::string exceptionId;
        std::string description;
        std::string breakMode; // Typically 'always', 'unhandled', or 'userUnhandled'
        dap::ExceptionDetails details;
    };

    using EventHandler = std::function<void(Event)>;

    Debugger(const EventHandler &handler);
    ~Debugger();

    void launch(const std::string &program, const std::string &args);
    void waitForInitialization();
    void configurationDone();
    void run();
    void pause();
    void stepOver();
    void stepInto();
    void stepOut();
    void setBreakpoints(const std::string &sourceFile, const std::vector<dap::integer> &lines);
    std::vector<std::string> getRegisters();
    std::vector<std::pair<std::string, std::string>> getEflags();
    std::vector<StackEntry> getStackContents();
    std::vector<dap::StackFrame> getCallStack();
    std::string evaluateExpression(const std::string &expression);
    std::string evaluateVariable(const std::string &variableName);
    ExceptionInfo getExceptionInfo(dap::integer threadId);
    ExceptionInfo lastExceptionInfo;
    void exit();
    void eventLoop();

private:
    void initialize();
    void uninitialize();
    int getCurrentLineNumber();
    void selectApplicationThread();

    // Event callback class
    class MyDebugEventCallbacks : public DebugBaseEventCallbacks {
    public:
        MyDebugEventCallbacks(Debugger *dbg, IDebugControl3 *debugControl);
        virtual ~MyDebugEventCallbacks() {}

        // IUnknown methods
        STDMETHOD(QueryInterface)(REFIID InterfaceId, PVOID *Interface);
        STDMETHOD_(ULONG, AddRef)();
        STDMETHOD_(ULONG, Release)();

        // IDebugEventCallbacks methods
        STDMETHOD(GetInterestMask)(PULONG Mask);
        STDMETHOD(Breakpoint)(PDEBUG_BREAKPOINT Bp);
        STDMETHOD(Exception)(PEXCEPTION_RECORD64 Exception, ULONG FirstChance);
        STDMETHOD(ExitProcess)(ULONG ExitCode);

        // Other event methods returning DEBUG_STATUS_NO_CHANGE
        STDMETHOD(CreateThread)(ULONG64 Handle, ULONG64 DataOffset, ULONG64 StartOffset);
        STDMETHOD(ExitThread)(ULONG ExitCode);
        STDMETHOD(LoadModule)
        (ULONG64 ImageFileHandle, ULONG64 BaseOffset, ULONG ModuleSize, PCSTR ModuleName, PCSTR ImageName,
         ULONG CheckSum, ULONG TimeDateStamp);
        STDMETHOD(UnloadModule)(PCSTR ImageBaseName, ULONG64 BaseOffset);
        STDMETHOD(SystemError)(ULONG Error, ULONG Level);
        STDMETHOD(SessionStatus)(ULONG Status);
        STDMETHOD(ChangeDebuggeeState)(ULONG Flags, ULONG64 Argument);
        STDMETHOD(ChangeEngineState)(ULONG Flags, ULONG64 Argument);
        STDMETHOD(ChangeSymbolState)(ULONG Flags, ULONG64 Argument);
        STDMETHOD(CreateProcess)
        (ULONG64 ImageFileHandle, ULONG64 Handle, ULONG64 BaseOffset, ULONG ModuleSize, PCSTR ModuleName,
         PCSTR ImageName, ULONG CheckSum, ULONG TimeDateStamp, ULONG64 InitialThreadHandle, ULONG64 ThreadDataOffset,
         ULONG64 StartOffset);

    private:
        bool first1 = true;
        bool first2 = true;
        ULONG m_refCount;
        Debugger *debugger;
        IDebugControl3 *debugControl = nullptr;
    };

    // COM interfaces
    IDebugClient *debugClient = nullptr;
    IDebugControl3 *debugControl = nullptr;
    IDebugSymbols *debugSymbols = nullptr;
    IDebugRegisters *debugRegisters = nullptr;
    IDebugSystemObjects *debugSystemObjects = nullptr;
    IDebugDataSpaces *debugDataSpaces = nullptr;
    MyDebugEventCallbacks *eventCallbacks = nullptr;

    std::unordered_map<ULONG64, IDebugBreakpoint *> breakpoints;
    std::mutex debugMutex;

    std::string programDirectory;

    // Event signaling
    ::Event hasInitialized;
    ::Event hasExited;
    ::Event waitForEvent;
    int eventsHandledCnt = 0;

    int lastLineBreak = -1;

    // Event handler
    EventHandler onEvent;

    // Flags
    bool shouldExit = false;
};
