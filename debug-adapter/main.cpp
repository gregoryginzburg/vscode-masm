#include "dap/io.h"
#include "dap/network.h"
#include "dap/protocol.h"
#include "dap/session.h"
#include "dap/typeof.h"

#include <Windows.h>
#include <DbgEng.h>

#include <condition_variable>
#include <cstdio>
#include <mutex>
#include <unordered_map>
#include <vector>
#include <thread>
#include <string>
#include <memory>
#include <functional>

#define USE_SERVER_MODE

// // If true, the launch request should launch the program without enabling debugging.
//   optional<boolean> noDebug;

//   // The program executable path.
//   optional<string> program;

//   // Command line arguments for the program.
//   optional<array<string>> args;

//   // Whether to stop at the entry point of the program.
//   optional<boolean> stopOnEntry;

namespace dap
{

    class MyLaunchRequest : public LaunchRequest
    {
    public:
        // The program executable path.
        dap::string program;

        // Command line arguments for the program.
        optional<array<string>> args;

        // Whether to stop at the entry point of the program.
        optional<boolean> stopOnEntry;
    };

    DAP_STRUCT_TYPEINFO_EXT(MyLaunchRequest,
                            LaunchRequest,
                            "launch",
                            DAP_FIELD(program, "program"), DAP_FIELD(args, "args"), DAP_FIELD(stopOnEntry, "stopOnEntry"));

} // namespace dap

class Debugger
{
public:
    enum class Event
    {
        BreakpointHit,
        Stepped,
        Paused,
        Exited
    };

    using EventHandler = std::function<void(Event)>;

    Debugger(const EventHandler &handler);
    ~Debugger();

    void launch(const std::string &program, const std::string &args);
    void attach(DWORD processId);

    void run();
    void pause();
    void stepOver();
    void stepInto();
    void stepOut();
    void setBreakpoints(const std::string &sourceFile, const std::vector<dap::integer> &lines);

    std::vector<std::string> getRegisters();
    int64_t currentLine();
    std::string currentSourceFile();
    std::vector<dap::StackFrame> getCallStack();

private:
    void initialize();
    void uninitialize();
    void waitForEvent();

    EventHandler onEvent;
    std::mutex mutex;

    // DbgEng interfaces
    IDebugClient *debugClient = nullptr;
    IDebugControl *debugControl = nullptr;
    IDebugSymbols *debugSymbols = nullptr;
    IDebugRegisters *debugRegisters = nullptr;
    IDebugSystemObjects *debugSystemObjects = nullptr;

    // Breakpoints
    std::unordered_map<ULONG64, IDebugBreakpoint *> breakpoints;

    // Current execution info
    ULONG currentThreadId = 0;
    ULONG64 currentInstructionOffset = 0;
};

Debugger::Debugger(const EventHandler &handler) : onEvent(handler)
{
    initialize();
}

Debugger::~Debugger()
{
    uninitialize();
}

void Debugger::initialize()
{
    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr))
    {
        printf("CoInitializeEx failed: 0x%08X\n", hr);
        return;
    }

    hr = DebugCreate(__uuidof(IDebugClient), (void **)&debugClient);
    if (FAILED(hr))
    {
        printf("DebugCreate failed: 0x%08X\n", hr);
        return;
    }

    hr = debugClient->QueryInterface(__uuidof(IDebugControl), (void **)&debugControl);
    hr = debugClient->QueryInterface(__uuidof(IDebugSymbols), (void **)&debugSymbols);
    hr = debugClient->QueryInterface(__uuidof(IDebugRegisters), (void **)&debugRegisters);
    hr = debugClient->QueryInterface(__uuidof(IDebugSystemObjects), (void **)&debugSystemObjects);

    // Set event callbacks if necessary
}

void Debugger::uninitialize()
{
    // Clear previous breakpoints
    for (auto &bp : breakpoints)
    {
        HRESULT hr = debugControl->RemoveBreakpoint(bp.second);
        if (FAILED(hr))
        {
            printf("IDebugControl::RemoveBreakpoint failed: 0x%08X\n", hr);
        }
    }
    breakpoints.clear();

    if (debugSystemObjects)
    {
        debugSystemObjects->Release();
        debugSystemObjects = nullptr;
    }
    if (debugRegisters)
    {
        debugRegisters->Release();
        debugRegisters = nullptr;
    }
    if (debugSymbols)
    {
        debugSymbols->Release();
        debugSymbols = nullptr;
    }
    if (debugControl)
    {
        debugControl->Release();
        debugControl = nullptr;
    }
    if (debugClient)
    {
        debugClient->EndSession(DEBUG_END_ACTIVE_TERMINATE);
        debugClient->Release();
        debugClient = nullptr;
    }

    CoUninitialize();
}

void Debugger::launch(const std::string &program, const std::string &args)
{
    std::unique_lock<std::mutex> lock(mutex);

    std::string command = "\"" + program + "\" " + args;

    HRESULT hr = debugClient->CreateProcess(
        NULL,
        const_cast<char *>(command.c_str()),
        DEBUG_PROCESS);

    // TODO
    hr = debugControl->WaitForEvent(DEBUG_WAIT_DEFAULT, INFINITE);

    debugSymbols->SetSymbolPath("C:\\Users\\grigo\\Desktop\\vscode-mock-debug\\sampleWorkspace");
    hr = debugSymbols->Reload("/f");

    if (FAILED(hr))
    {
        printf("CreateProcess failed: 0x%08X\n", hr);
        return;
    }

    

    // Start a thread to wait for events
    std::thread([this]()
                { this->waitForEvent(); })
        .detach();
}

void Debugger::attach(DWORD processId)
{
    std::unique_lock<std::mutex> lock(mutex);

    HRESULT hr = debugClient->AttachProcess(
        0, // Server
        processId,
        DEBUG_ATTACH_DEFAULT);

    if (FAILED(hr))
    {
        printf("AttachProcess failed: 0x%08X\n", hr);
        return;
    }

    // Start a thread to wait for events
    std::thread([this]()
                { this->waitForEvent(); })
        .detach();
}

void Debugger::run()
{
    std::unique_lock<std::mutex> lock(mutex);
    HRESULT hr = debugControl->SetExecutionStatus(DEBUG_STATUS_GO);
    if (FAILED(hr))
    {
        printf("SetExecutionStatus(GO) failed: 0x%08X\n", hr);
    }
}

void Debugger::pause()
{
    std::unique_lock<std::mutex> lock(mutex);
    HRESULT hr = debugControl->SetInterrupt(DEBUG_INTERRUPT_ACTIVE);
    if (FAILED(hr))
    {
        printf("SetInterrupt failed: 0x%08X\n", hr);
    }
}

void Debugger::stepOver()
{
    std::unique_lock<std::mutex> lock(mutex);
    HRESULT hr = debugControl->SetExecutionStatus(DEBUG_STATUS_STEP_OVER);
    if (FAILED(hr))
    {
        printf("SetExecutionStatus(STEP_OVER) failed: 0x%08X\n", hr);
    }
}

void Debugger::stepInto()
{
    std::unique_lock<std::mutex> lock(mutex);
    HRESULT hr = debugControl->SetExecutionStatus(DEBUG_STATUS_STEP_INTO);
    if (FAILED(hr))
    {
        printf("SetExecutionStatus(STEP_INTO) failed: 0x%08X\n", hr);
    }
}

void Debugger::stepOut()
{
    std::unique_lock<std::mutex> lock(mutex);
    HRESULT hr = debugControl->SetExecutionStatus(DEBUG_STATUS_STEP_BRANCH);
    if (FAILED(hr))
    {
        printf("SetExecutionStatus(STEP_OUT) failed: 0x%08X\n", hr);
    }
}

void Debugger::setBreakpoints(const std::string &sourceFile, const std::vector<dap::integer> &lines)
{
    std::unique_lock<std::mutex> lock(mutex);

    // Clear previous breakpoints
    for (auto &bp : breakpoints)
    {
        HRESULT hr = debugControl->RemoveBreakpoint(bp.second);
        if (FAILED(hr))
        {
            printf("IDebugControl::RemoveBreakpoint failed: 0x%08X\n", hr);
        }
    }
    breakpoints.clear();

    for (dap::integer line : lines)
    {
        ULONG64 offset = 0;
        HRESULT hr = debugSymbols->GetOffsetByLine(static_cast<ULONG>(line), sourceFile.c_str(), &offset);
        if (SUCCEEDED(hr))
        {
            IDebugBreakpoint *bp = nullptr;
            hr = debugControl->AddBreakpoint(DEBUG_BREAKPOINT_CODE, DEBUG_ANY_ID, &bp);
            if (SUCCEEDED(hr))
            {
                bp->SetOffset(offset);
                bp->SetFlags(DEBUG_BREAKPOINT_ENABLED);
                breakpoints[offset] = bp;
            }
        }
        else
        {
            printf("GetOffsetByLine failed for line %d: 0x%08X\n", static_cast<int>(line), hr);
        }
    }
}

std::vector<std::string> Debugger::getRegisters()
{
    std::unique_lock<std::mutex> lock(mutex);

    std::vector<std::string> registers;

    ULONG numRegisters = 0;
    HRESULT hr = debugRegisters->GetNumberRegisters(&numRegisters);
    if (FAILED(hr))
    {
        printf("GetNumberRegisters failed: 0x%08X\n", hr);
        return registers;
    }

    for (ULONG i = 0; i < numRegisters; ++i)
    {
        char name[64];
        hr = debugRegisters->GetDescription(i, name, sizeof(name), nullptr, nullptr);
        if (SUCCEEDED(hr))
        {
            DEBUG_VALUE value = {};
            hr = debugRegisters->GetValue(i, &value);
            if (SUCCEEDED(hr))
            {
                char buffer[128];
                if (value.Type == DEBUG_VALUE_INT64)
                {
                    sprintf_s(buffer, "%s = 0x%llx", name, value.I64);
                }
                else if (value.Type == DEBUG_VALUE_INT32)
                {
                    sprintf_s(buffer, "%s = 0x%lx", name, value.I32);
                }
                else
                {
                    sprintf_s(buffer, "%s = <unsupported type>", name);
                }
                registers.push_back(buffer);
            }
        }
    }

    return registers;
}

int64_t Debugger::currentLine()
{
    std::unique_lock<std::mutex> lock(mutex);

    ULONG line = 0;
    char fileName[MAX_PATH] = {};
    ULONG64 displacement = 0;

    HRESULT hr = debugSymbols->GetLineByOffset(currentInstructionOffset, &line, fileName, sizeof(fileName), nullptr, &displacement);
    if (FAILED(hr))
    {
        printf("GetLineByOffset failed: 0x%08X\n", hr);
        return -1;
    }

    return line;
}

std::string Debugger::currentSourceFile()
{
    std::unique_lock<std::mutex> lock(mutex);

    ULONG line = 0;
    char fileName[MAX_PATH] = {};
    ULONG64 displacement = 0;

    HRESULT hr = debugSymbols->GetLineByOffset(currentInstructionOffset, &line, fileName, sizeof(fileName), nullptr, &displacement);
    if (FAILED(hr))
    {
        printf("GetLineByOffset failed: 0x%08X\n", hr);
        return "";
    }

    return std::string(fileName);
}

std::vector<dap::StackFrame> Debugger::getCallStack()
{
    std::unique_lock<std::mutex> lock(mutex);

    std::vector<dap::StackFrame> stackFrames;

    DEBUG_STACK_FRAME frames[100];
    ULONG filled = 0;
    HRESULT hr = debugControl->GetStackTrace(0, 0, 0, frames, 100, &filled);
    if (FAILED(hr))
    {
        printf("GetStackTrace failed: 0x%08X\n", hr);
    }

    for (ULONG i = 0; i < filled; ++i)
    {
        dap::StackFrame frame;
        frame.id = frames[i].InstructionOffset;

        ULONG line = 0;
        char fileName[MAX_PATH] = {};
        ULONG64 displacement = 0;

        ULONG64 functionOffset = 0;
        hr = debugSymbols->GetOffsetByName("test!start", &functionOffset);
        hr = debugSymbols->GetLineByOffset(functionOffset, &line, fileName, sizeof(fileName), nullptr, &displacement);
        hr = debugSymbols->GetLineByOffset(frames[i].InstructionOffset, &line, fileName, sizeof(fileName), nullptr, &displacement);
        if (SUCCEEDED(hr))
        {
            frame.line = line;
            frame.column = 1;
            frame.source = dap::Source();
            frame.source->name = fileName;
            frame.source->path = fileName;

            char symbolName[256] = {};
            ULONG64 symbolDisplacement = 0;

            hr = debugSymbols->GetNameByOffset(frames[i].InstructionOffset, symbolName, sizeof(symbolName), nullptr, &symbolDisplacement);
            if (SUCCEEDED(hr))
            {
                frame.name = symbolName;
            }
            else
            {
                frame.name = "<unknown>";
            }

            stackFrames.push_back(frame);
        }
    }

    return stackFrames;
}

void Debugger::waitForEvent()
{
    while (true)
    {
        HRESULT hr = debugControl->WaitForEvent(0, INFINITE);
        if (hr == S_OK)
        {
            // Update current instruction offset
            debugSystemObjects->GetCurrentThreadId(&currentThreadId);
            debugRegisters->GetInstructionOffset(&currentInstructionOffset);

            // Handle event
            ULONG execStatus = 0;
            hr = debugControl->GetExecutionStatus(&execStatus);
            if (FAILED(hr))
            {
                printf("GetExecutionStatus failed: 0x%08X\n", hr);
                continue;
            }

            if (execStatus == DEBUG_STATUS_BREAK)
            {
                // Breakpoint hit or paused
                onEvent(Event::BreakpointHit);
            }
            else if (execStatus == DEBUG_STATUS_NO_DEBUGGEE)
            {
                // Debuggee exited
                onEvent(Event::Exited);
                break;
            }
        }
        else
        {
            // Error or debuggee exited
            onEvent(Event::Exited);
            break;
        }
    }
}

class Event
{
public:
    // wait() blocks until the event is fired.
    void wait();

    // fire() sets signals the event, and unblocks any calls to wait().
    void fire();

private:
    std::mutex mutex;
    std::condition_variable cv;
    bool fired = false;
};

void Event::wait()
{
    std::unique_lock<std::mutex> lock(mutex);
    cv.wait(lock, [&]
            { return fired; });
}

void Event::fire()
{
    std::unique_lock<std::mutex> lock(mutex);
    fired = true;
    cv.notify_all();
}

// Structure to hold session state
struct SessionState
{
    Event configured;
    Event terminate;
};

#ifdef USE_SERVER_MODE

int main(int, char *[])
{
    constexpr int kPort = 19021;

    auto onClientConnected =
        [&](const std::shared_ptr<dap::ReaderWriter> &socket)
    {
        SessionState state;
        auto session = dap::Session::create();
        session->setOnInvalidData(dap::kClose);
        

        // Debugger event handler
        Debugger debugger([&](Debugger::Event event)
                          {
                          switch (event) {
                          case Debugger::Event::BreakpointHit:
                          case Debugger::Event::Stepped:
                          case Debugger::Event::Paused: {
                              dap::StoppedEvent stoppedEvent;
                              stoppedEvent.threadId = 1;
                              stoppedEvent.reason = "breakpoint";
                              session->send(stoppedEvent);
                              break;
                          }
                          case Debugger::Event::Exited: {
                              dap::ExitedEvent exitedEvent;
                              session->send(exitedEvent);

                              state.terminate.fire();
                              break;
                          }
                          } });

        session->onError([&](const char *msg)
                         {
                         printf("Session error: %s\n", msg);
                         state.terminate.fire(); });

        session->registerHandler([&](const dap::InitializeRequest &)
                                 {
                                 dap::InitializeResponse response;
                                 response.supportsConfigurationDoneRequest = true;
                                 return response; });

        session->registerSentHandler([&](const dap::ResponseOrError<dap::InitializeResponse> &)
                                     { session->send(dap::InitializedEvent()); });

        session->registerHandler([&](const dap::MyLaunchRequest &request)
                                 {
                                 // Start the program
                                 std::string program = request.program;
                                 // TODO: add args
                                 std::string args = "";

                                 debugger.launch(program, args);

                                 return dap::LaunchResponse(); });

        session->registerHandler([&](const dap::ConfigurationDoneRequest &)
                                 {
                                //  state.configured.fire();
                                 return dap::ConfigurationDoneResponse(); });

        session->registerHandler([&](const dap::SetBreakpointsRequest &request)
                                 {
                                 std::vector<dap::integer> lines;
                                 for (const auto& bp : request.breakpoints.value({})) {
                                     lines.push_back(bp.line);
                                 }

                                 debugger.setBreakpoints(request.source.path.value(""), lines);

                                 dap::SetBreakpointsResponse response;
                                 for (const auto& line : lines) {
                                     dap::Breakpoint breakpoint;
                                     breakpoint.verified = true;
                                     breakpoint.line = line;
                                     response.breakpoints.push_back(breakpoint);
                                 }
                                 return response; });

        session->registerHandler([&](const dap::ThreadsRequest &)
                                 {
                                 dap::ThreadsResponse response;
                                 dap::Thread thread;
                                 thread.id = 1;
                                 thread.name = "Main Thread";
                                 response.threads.push_back(thread);
                                 return response; });

        session->registerHandler([&]([[maybe_unused]] const dap::StackTraceRequest &request)
                                 {
                                 dap::StackTraceResponse response;
                                 response.stackFrames = debugger.getCallStack();
                                 return response; });

        session->registerHandler([&]([[maybe_unused]] const dap::ScopesRequest &request)
                                 {
                                 dap::ScopesResponse response;
                                 dap::Scope scope;
                                 scope.name = "Registers";
                                 scope.variablesReference = 1;
                                 scope.presentationHint = "registers";
                                 response.scopes.push_back(scope);
                                 return response; });

        session->registerHandler([&]([[maybe_unused]] const dap::VariablesRequest &request)
                                 {
                                 dap::VariablesResponse response;
                                 auto regs = debugger.getRegisters();
                                 for (const auto& reg : regs) {
                                     dap::Variable var;
                                     var.name = reg.substr(0, reg.find('=') - 1);
                                     var.value = reg.substr(reg.find('=') + 2);
                                     response.variables.push_back(var);
                                 }
                                 return response; });

        session->registerHandler([&](const dap::ContinueRequest &)
                                 {
                                 debugger.run();
                                 dap::ContinueResponse response;
                                 response.allThreadsContinued = true;
                                 return response; });

        session->registerHandler([&](const dap::PauseRequest &)
                                 {
                                 debugger.pause();
                                 return dap::PauseResponse(); });

        session->registerHandler([&](const dap::NextRequest &)
                                 {
                                 debugger.stepOver();
                                 return dap::NextResponse(); });

        session->registerHandler([&](const dap::StepInRequest &)
                                 {
                                 debugger.stepInto();
                                 return dap::StepInResponse(); });

        session->registerHandler([&](const dap::StepOutRequest &)
                                 {
                                 debugger.stepOut();
                                 return dap::StepOutResponse(); });

        session->registerHandler([&](const dap::DisconnectRequest &)
                                 {
                                     state.terminate.fire();
                                 return dap::DisconnectResponse(); });

        // Wait for configuration done
        // state.configured.wait();

        session->bind(socket);

        // Wait for termination
        state.terminate.wait();
        printf("Server closing connection\n");
    };

    // Error handler
    auto onError = [&](const char *msg)
    { printf("Server error: %s\n", msg); };

    // Create the network server
    auto server = dap::net::Server::create();
    server->start(kPort, onClientConnected, onError);

    // Keep the server running indefinitely
    std::mutex mutex;
    std::condition_variable cv;
    std::unique_lock<std::mutex> lock(mutex);
    cv.wait(lock);

    return 0;
}

#else

int main(/* int argc, char *argv[] */)
{
    // Initialize DAP session
    auto session = dap::Session::create();

    SessionState state;
    setupSessionHandlers(session, state);

    // Bind session to stdin and stdout
    session->bind(dap::file(stdin, false), dap::file(stdout, false));

    // Wait for configuration
    {
        std::unique_lock<std::mutex> lock(state.cv_m);
        state.cv.wait(lock, [&]
                      { return state.configured || state.terminateRequested; });
    }

    if (state.terminateRequested)
    {
        return 0;
    }

    // Send thread started event
    dap::ThreadEvent threadStartedEvent;
    threadStartedEvent.reason = "started";
    threadStartedEvent.threadId = 1;
    session->send(threadStartedEvent);

    // Keep the main thread alive until termination
    {
        std::unique_lock<std::mutex> lock(state.cv_m);
        state.cv.wait(lock, [&]
                      { return state.terminateRequested; });
    }

    return 0;
}

#endif
