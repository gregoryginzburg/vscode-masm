#include "debugger.h"

#include <cstdio>
#include <iostream>
#include <thread>
#include <filesystem>
#include <winerror.h>
// #include <ntstatus.h>
#define STATUS_WX86_BREAKPOINT 0x4000001FL

class MyOutputCallbacks : public IDebugOutputCallbacks {
public:
    STDMETHOD(QueryInterface)
    (REFIID /*InterfaceId*/, PVOID * /*Interface*/) { return S_OK; }
    STDMETHOD_(ULONG, AddRef)
    () { return 1; }
    STDMETHOD_(ULONG, Release)
    () { return 1; }
    STDMETHOD(Output)
    (ULONG /*Mask*/, PCSTR Text)
    {
        // printf("%s", Text);
        return S_OK;
    }
};

MyOutputCallbacks outputCallbacks;

class MyDebugEventCallbacks : public IDebugEventCallbacks {
public:
    // Constructor
    MyDebugEventCallbacks() : m_refCount(1) {}

    // Destructor
    virtual ~MyDebugEventCallbacks() {}

    // IUnknown methods
    STDMETHOD(QueryInterface)(REFIID InterfaceId, PVOID *Interface)
    {
        if (InterfaceId == __uuidof(IUnknown) || InterfaceId == __uuidof(IDebugEventCallbacks)) {
            *Interface = static_cast<IDebugEventCallbacks *>(this);
            AddRef();
            return S_OK;
        } else {
            *Interface = nullptr;
            return E_NOINTERFACE;
        }
    }

    STDMETHOD_(ULONG, AddRef)() { return InterlockedIncrement(&m_refCount); }

    STDMETHOD_(ULONG, Release)()
    {
        ULONG count = InterlockedDecrement(&m_refCount);
        if (count == 0)
            delete this;
        return count;
    }

    // IDebugEventCallbacks methods
    STDMETHOD(GetInterestMask)(PULONG Mask)
    {
        *Mask = DEBUG_EVENT_EXIT_PROCESS;
        return S_OK;
    }

    STDMETHOD(ExitProcess)(ULONG /*ExitCode*/)
    {
        // Return DEBUG_STATUS_BREAK to cause the debugger to break into the target
        return DEBUG_STATUS_BREAK;
    }

    // Other event methods can return DEBUG_STATUS_NO_CHANGE
    STDMETHOD(Breakpoint)(PDEBUG_BREAKPOINT /*Bp*/) { return DEBUG_STATUS_NO_CHANGE; }
    STDMETHOD(Exception)(PEXCEPTION_RECORD64 /*Exception*/, ULONG /*FirstChance*/) { return DEBUG_STATUS_NO_CHANGE; }
    STDMETHOD(CreateThread)(ULONG64 /*Handle*/, ULONG64 /*DataOffset*/, ULONG64 /*StartOffset*/)
    {
        return DEBUG_STATUS_NO_CHANGE;
    }
    STDMETHOD(ExitThread)(ULONG /*ExitCode*/) { return DEBUG_STATUS_NO_CHANGE; }
    STDMETHOD(CreateProcess)
    (ULONG64 /*ImageFileHandle*/, ULONG64 /*Handle*/, ULONG64 /*BaseOffset*/, ULONG /*ModuleSize*/,
     PCSTR /*ModuleName*/, PCSTR /*ImageName*/, ULONG /*CheckSum*/, ULONG /*TimeDateStamp*/,
     ULONG64 /*InitialThreadHandle*/, ULONG64 /*ThreadDataOffset*/, ULONG64 /*StartOffset*/)
    {
        return DEBUG_STATUS_NO_CHANGE;
    }
    STDMETHOD(LoadModule)
    (ULONG64 /*ImageFileHandle*/, ULONG64 /*BaseOffset*/, ULONG /*ModuleSize*/, PCSTR /*ModuleName*/,
     PCSTR /*ImageName*/, ULONG /*CheckSum*/, ULONG /*TimeDateStamp*/)
    {
        return DEBUG_STATUS_NO_CHANGE;
    }
    STDMETHOD(UnloadModule)(PCSTR /*ImageBaseName*/, ULONG64 /*BaseOffset*/) { return DEBUG_STATUS_NO_CHANGE; }
    STDMETHOD(SystemError)(ULONG /*Error*/, ULONG /*Level*/) { return DEBUG_STATUS_NO_CHANGE; }
    STDMETHOD(SessionStatus)(ULONG /*Status*/) { return DEBUG_STATUS_NO_CHANGE; }
    STDMETHOD(ChangeDebuggeeState)(ULONG /*Flags*/, ULONG64 /*Argument*/) { return DEBUG_STATUS_NO_CHANGE; }
    STDMETHOD(ChangeEngineState)(ULONG /*Flags*/, ULONG64 /*Argument*/) { return DEBUG_STATUS_NO_CHANGE; }
    STDMETHOD(ChangeSymbolState)(ULONG /*Flags*/, ULONG64 /*Argument*/) { return DEBUG_STATUS_NO_CHANGE; }

private:
    ULONG m_refCount;
};

MyDebugEventCallbacks eventCallbacks;

Debugger::Debugger(const EventHandler &handler) : onEvent(handler) {}

Debugger::~Debugger()
{
    exit();
    hasExited.wait();
    uninitialize();
}

void Debugger::initialize()
{
    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr)) {
        printf("CoInitializeEx failed: 0x%08X\n", hr);
        return;
    }

    hr = DebugCreate(__uuidof(IDebugClient), (void **)&debugClient);
    if (FAILED(hr)) {
        printf("DebugCreate failed: 0x%08X\n", hr);
        return;
    }

    hr = debugClient->QueryInterface(__uuidof(IDebugControl), (void **)&debugControl);
    hr = debugClient->QueryInterface(__uuidof(IDebugSymbols), (void **)&debugSymbols);
    hr = debugClient->QueryInterface(__uuidof(IDebugRegisters), (void **)&debugRegisters);
    hr = debugClient->QueryInterface(__uuidof(IDebugSystemObjects), (void **)&debugSystemObjects);

    debugClient->SetOutputCallbacks(&outputCallbacks);
    debugClient->SetEventCallbacks(&eventCallbacks);
}

void Debugger::uninitialize()
{
    if (debugClient) {
        debugClient->EndSession(DEBUG_END_ACTIVE_TERMINATE);
    }

    // Clear previous breakpoints
    for (auto &bp : breakpoints) {
        if (bp.second) {
            HRESULT hr = debugControl->RemoveBreakpoint(bp.second);
            if (FAILED(hr)) {
                printf("IDebugControl::RemoveBreakpoint failed: 0x%08X\n", hr);
            }
        }
    }
    breakpoints.clear();

    if (debugSystemObjects) {
        debugSystemObjects->Release();
        debugSystemObjects = nullptr;
    }
    if (debugRegisters) {
        debugRegisters->Release();
        debugRegisters = nullptr;
    }
    if (debugSymbols) {
        debugSymbols->SetSymbolPath("");
        debugSymbols->Release();
        debugSymbols = nullptr;
    }
    if (debugControl) {
        debugControl->Release();
        debugControl = nullptr;
    }
    if (debugClient) {
        debugClient->Release();
        debugClient = nullptr;
    }

    CoUninitialize();
}

void Debugger::launch(const std::string &program, const std::string &args)
{
    std::lock_guard<std::mutex> lock(debugMutex);
    initialize();

    std::string command = "\"" + program + "\" " + args;

    HRESULT hr = debugControl->SetEngineOptions(DEBUG_ENGOPT_INITIAL_BREAK);

    hr = debugClient->CreateProcess(NULL, const_cast<char *>(command.c_str()), DEBUG_PROCESS | CREATE_NEW_CONSOLE);

    if (FAILED(hr)) {
        printf("CreateProcess failed: 0x%08X\n", hr);
        return;
    }
    //
    // Wait for initial breakpoint
    // hr = debugControl->SetExecutionStatus(DEBUG_STATUS_GO);
    hr = debugControl->WaitForEvent(0, INFINITE);

    if (FAILED(hr)) {
        printf("WaitForEvent failed: 0x%08X\n", hr);
        return;
    }

    // hr = debugControl->SetEffectiveProcessorType(IMAGE_FILE_MACHINE_I386);
    //  Set symbol path as needed
    std::string programDirectory = std::filesystem::path(program).parent_path().string();
    hr = debugSymbols->SetSymbolPath(programDirectory.c_str());
    hr = debugSymbols->Reload("/f /i");
    // hr = debugControl->Execute(DEBUG_OUTCTL_THIS_CLIENT, "l-t", DEBUG_EXECUTE_DEFAULT);

    // hr = debugControl->SetExecutionStatus(DEBUG_STATUS_GO);
    // const char *sourceFile = "c:\\Users\\grigo\\Desktop\\vscode-mock-debug\\sampleWorkspace\\test.asm";
    // ULONG64 offset;
    // hr = debugSymbols->GetOffsetByLine(static_cast<ULONG>(24), sourceFile, &offset);

    hasInitialized.fire();
}

void Debugger::waitForInitialization() { hasInitialized.wait(); }

// void Debugger::waitForConfigurationDone()
// {
//     configurationDoneEvent.wait();
// }

void Debugger::configurationDone() { run(); }

void Debugger::run()
{
    std::lock_guard<std::mutex> lock(debugMutex);
    if (debugControl) {
        HRESULT hr = debugControl->SetExecutionStatus(DEBUG_STATUS_GO);
        isStopped = false;
        needToWaitForEvent.fire();
        if (FAILED(hr)) {
            printf("SetExecutionStatus(GO) failed: 0x%08X\n", hr);
        }
    }
}

void Debugger::pause()
{
    std::lock_guard<std::mutex> lock(debugMutex);
    if (debugControl) {
        HRESULT hr = debugControl->SetInterrupt(DEBUG_INTERRUPT_ACTIVE);
        isStopped = false;
        needToWaitForEvent.fire();
        if (FAILED(hr)) {
            printf("SetInterrupt failed: 0x%08X\n", hr);
        }
    }
}

int Debugger::getCurrentLineNumber()
{
    // Get the current instruction pointer (offset)
    ULONG64 offset;
    HRESULT hr = debugRegisters->GetInstructionOffset(&offset);

    // Retrieve the line information by offset
    ULONG lineNumber;
    char fileName[MAX_PATH];
    ULONG fileNameSize;

    hr = debugSymbols->GetLineByOffset(offset, &lineNumber, fileName, sizeof(fileName), &fileNameSize, nullptr);

    return lineNumber;
}

void Debugger::stepOver()
{
    std::lock_guard<std::mutex> lock(debugMutex);
    if (debugControl) {
        HRESULT hr = debugControl->SetExecutionStatus(DEBUG_STATUS_STEP_OVER);
        isStopped = false;
        needToWaitForEvent.fire();
        if (FAILED(hr)) {
            printf("SetExecutionStatus(STEP_OVER) failed: 0x%08X\n", hr);
        }
    }
}

void Debugger::stepInto()
{
    std::lock_guard<std::mutex> lock(debugMutex);
    if (debugControl) {
        HRESULT hr = debugControl->SetExecutionStatus(DEBUG_STATUS_STEP_INTO);
        isStopped = false;
        needToWaitForEvent.fire();
        if (FAILED(hr)) {
            printf("SetExecutionStatus(STEP_INTO) failed: 0x%08X\n", hr);
        }
    }
}

void Debugger::stepOut()
{
    std::lock_guard<std::mutex> lock(debugMutex);
    if (!debugControl)
        return;

    // Get the return address of the current stack frame
    DEBUG_STACK_FRAME frames[1];
    ULONG filled = 0;
    HRESULT hr = debugControl->GetStackTrace(0, 0, 0, frames, 1, &filled);
    if (FAILED(hr) || filled == 0) {
        printf("GetStackTrace failed: 0x%08X\n", hr);
        return;
    }

    ULONG64 returnOffset = frames[0].ReturnOffset;

    // Set a temporary breakpoint at the return address
    IDebugBreakpoint *bp = nullptr;
    hr = debugControl->AddBreakpoint(DEBUG_BREAKPOINT_CODE, DEBUG_ANY_ID, &bp);
    if (FAILED(hr)) {
        printf("AddBreakpoint failed: 0x%08X\n", hr);
        return;
    }

    bp->SetOffset(returnOffset);
    bp->AddFlags(DEBUG_BREAKPOINT_ONE_SHOT);
    bp->SetFlags(DEBUG_BREAKPOINT_ENABLED);

    // Continue execution
    hr = debugControl->SetExecutionStatus(DEBUG_STATUS_GO);
    isStopped = false;
    needToWaitForEvent.fire();
    if (FAILED(hr)) {
        printf("SetExecutionStatus(GO) failed: 0x%08X\n", hr);
    }
}

void Debugger::setBreakpoints(const std::string &sourceFile, const std::vector<dap::integer> &lines)
{
    std::lock_guard<std::mutex> lock(debugMutex);
    if (!debugControl || !debugSymbols) {
        return;
    }

    for (dap::integer line : lines) {
        ULONG64 offset = 0;
        HRESULT hr = debugSymbols->GetOffsetByLine(static_cast<ULONG>(line), sourceFile.c_str(), &offset);
        if (SUCCEEDED(hr)) {
            IDebugBreakpoint *bp = nullptr;
            hr = debugControl->AddBreakpoint(DEBUG_BREAKPOINT_CODE, DEBUG_ANY_ID, &bp);
            if (SUCCEEDED(hr)) {
                bp->SetOffset(offset);
                bp->SetFlags(DEBUG_BREAKPOINT_ENABLED);
                breakpoints[offset] = bp;
            }
        } else {
            // printf("GetOffsetByLine failed for line %d: 0x%08X\n", static_cast<int>(line), hr);
        }
    }
}

std::vector<std::string> Debugger::getRegisters()
{
    std::vector<std::string> registers;

    std::lock_guard<std::mutex> lock(debugMutex);
    if (!debugRegisters) {
        return registers;
    }

    ULONG numRegisters = 0;
    HRESULT hr = debugRegisters->GetNumberRegisters(&numRegisters);
    if (FAILED(hr)) {
        printf("GetNumberRegisters failed: 0x%08X\n", hr);
        return registers;
    }

    for (ULONG i = 0; i < numRegisters; ++i) {
        char name[64];
        hr = debugRegisters->GetDescription(i, name, sizeof(name), nullptr, nullptr);
        if (SUCCEEDED(hr)) {
            DEBUG_VALUE value = {};
            hr = debugRegisters->GetValue(i, &value);
            if (SUCCEEDED(hr)) {
                char buffer[128];
                if (value.Type == DEBUG_VALUE_INT64) {
                    sprintf_s(buffer, "%s = 0x%llx", name, value.I64);
                } else if (value.Type == DEBUG_VALUE_INT32) {
                    sprintf_s(buffer, "%s = 0x%lx", name, value.I32);
                } else {
                    sprintf_s(buffer, "%s = <unsupported type>", name);
                }
                registers.push_back(buffer);
            }
        }
    }

    return registers;
}

void Debugger::selectApplicationThread()
{
    HRESULT hr;
    ULONG numThreads = 0;
    hr = debugSystemObjects->GetNumberThreads(&numThreads);

    std::vector<ULONG> threadIds(numThreads);
    hr = debugSystemObjects->GetThreadIdsByIndex(0, numThreads, threadIds.data(), nullptr);
    if (FAILED(hr)) {
        printf("GetThreadIdsByIndex failed: 0x%08X\n", hr);
        return;
    }

    for (ULONG i = 0; i < numThreads; ++i) {
        hr = debugSystemObjects->SetCurrentThreadId(threadIds[i]);
        if (FAILED(hr)) {
            continue;
        }

        break;
    }
}

std::vector<dap::StackFrame> Debugger::getCallStack()
{
    std::vector<dap::StackFrame> stackFrames;

    std::lock_guard<std::mutex> lock(debugMutex);
    if (!debugControl || !debugSymbols) {
        return stackFrames;
    }

    // needed for pause to work correctly
    // without it the stack looks like this
    // ntdll!DbgBreakPoint (Unknown Source:0)
    // ntdll!DbgUiRemoteBreakin (Unknown Source:0)
    // ntdll!RtlUserThreadStart (Unknown Source:0)
    selectApplicationThread();

    DEBUG_STACK_FRAME frames[100];
    ULONG filled = 0;
    HRESULT hr = debugControl->GetStackTrace(0, 0, 0, frames, 100, &filled);
    if (FAILED(hr)) {
        printf("GetStackTrace failed: 0x%08X\n", hr);
        return stackFrames;
    }

    for (ULONG i = 0; i < filled; ++i) {
        dap::StackFrame frame;
        frame.id = frames[i].InstructionOffset;

        char funcName[256];
        hr = debugSymbols->GetNameByOffset(frames[i].InstructionOffset, funcName, sizeof(funcName), nullptr, nullptr);

        if (SUCCEEDED(hr)) {
            ULONG line = 0;
            char fileName[MAX_PATH] = {};

            frame.name = dap::string(funcName);

            hr = debugSymbols->GetLineByOffset(frames[i].InstructionOffset, &line, fileName, sizeof(fileName), nullptr,
                                               nullptr);
            if (SUCCEEDED(hr)) {
                frame.line = line;
                frame.column = 1;
                frame.source = dap::Source();
                frame.source->name = fileName;
                frame.source->path = fileName;
            }

            stackFrames.push_back(frame);
        } else {
            stackFrames.push_back(frame);
        }
    }

    return stackFrames;
}

void Debugger::exit()
{
    {
        std::lock_guard<std::mutex> lock(debugMutex);
        shouldExit = true;
        needToWaitForEvent.fire();
        if (debugControl) {
            debugControl->SetInterrupt(DEBUG_INTERRUPT_ACTIVE);
        }
    }
}

void Debugger::eventLoop()
{
    HRESULT hr = S_OK;
    while (!shouldExit) {
        needToWaitForEvent.wait();
        needToWaitForEvent.reset();
        // If the debuggee is running, wait for events
        bool localIsStopped = false;
        {
            std::lock_guard<std::mutex> lock(debugMutex);
            localIsStopped = isStopped;
        }

        if (!localIsStopped) {

            // returns E_FAIL when the debuggee has exited, TODO: check for it?
            hr = debugControl->WaitForEvent(0, INFINITE);
            if (hr == S_OK) {
                std::lock_guard<std::mutex> lock(debugMutex);
                // Breakpoint hit or paused
                bool wasStopped = false;
                wasStopped = isStopped;
                isStopped = true;
                if (!wasStopped) {
                    ULONG eventType;
                    ULONG processId, threadId;
                    char description[256];
                    ULONG descriptionUsed;
                    EXCEPTION_RECORD64 exceptionRecord;

                    hr = debugControl->GetLastEventInformation(&eventType, &processId, &threadId, &exceptionRecord,
                                                               sizeof(exceptionRecord), nullptr, description,
                                                               sizeof(description), &descriptionUsed);

                    if (SUCCEEDED(hr)) {
                        if (eventType == DEBUG_EVENT_EXCEPTION) {
                            if (exceptionRecord.ExceptionCode == STATUS_WX86_BREAKPOINT) {
                                hr = debugControl->SetExecutionStatus(DEBUG_STATUS_GO);
                                isStopped = false;
                                needToWaitForEvent.fire();
                            } else if (exceptionRecord.ExceptionCode == DBG_CONTROL_C ||
                                       exceptionRecord.ExceptionCode == STATUS_BREAKPOINT) {
                                // This exception was caused by a user-initiated pause
                                onEvent(EventType::Paused);
                                isStopped = true;
                            } else {
                                onEvent(EventType::Exception);
                                isStopped = true;
                            }
                        } else if (eventType == DEBUG_EVENT_BREAKPOINT) {
                            // printf("Break reason: Breakpoint\n");
                            // printf("%s\n", description);
                            onEvent(EventType::BreakpointHit);
                            lastLineBreak = getCurrentLineNumber();
                        } else if (eventType == DEBUG_EVENT_EXIT_PROCESS) {
                            onEvent(EventType::Exited);
                            break;
                        } else {
                            // stepped over or stepped in
                            int currentLineNumber = getCurrentLineNumber();
                            if (currentLineNumber == lastLineBreak) {
                                isStopped = false;
                                hr = debugControl->SetExecutionStatus(DEBUG_STATUS_STEP_OVER);
                                needToWaitForEvent.fire();
                            } else {
                                // printf("%s\n", description);
                                onEvent(EventType::Stepped);
                                isStopped = true;
                                lastLineBreak = currentLineNumber;
                            }
                        }

                        // Only send StoppedEvent when state changes to stopped
                    }
                }
            } else if (hr == S_FALSE) {
                // Wait timed out, continue processing
                continue;
            } else if (FAILED(hr)) {
                // Error occurred
                // printf("WaitForEvent failed: 0x%08X\n", hr);
                break;
            }
        } else {

            break;
        }
    }
    onEvent(EventType::Exited);
    hasExited.fire();
}
