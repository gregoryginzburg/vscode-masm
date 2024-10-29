#include "debugger.h"
#include "event.h"
#include "session_state.h"

#include "dap/io.h"
#include "dap/network.h"
#include "dap/protocol.h"
#include "dap/session.h"
#include "dap/typeof.h"

#include <chrono>
#include <cstdio>
#include <memory>
#include <string>
#include <thread>
#include <iostream>
#include <fcntl.h> // _O_BINARY
#include <io.h>    // _setmode

#define USE_SERVER_MODE
#define LOG_TO_FILE "C:\\Users\\grigo\\Documents\\masm\\log.txt"

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

    DAP_STRUCT_TYPEINFO_EXT(
        MyLaunchRequest,
        LaunchRequest,
        "launch",
        DAP_FIELD(program, "program"),
        DAP_FIELD(args, "args"),
        DAP_FIELD(stopOnEntry, "stopOnEntry"));

} // namespace dap

#ifdef USE_SERVER_MODE
int main(int, char *[])
{
    constexpr int kPort = 19021;

    // Callback handler for a socket connection to the server
    auto onClientConnected = [&](const std::shared_ptr<dap::ReaderWriter> &socket)
    {
        auto session = dap::Session::create();

        // Set the session to close on invalid data
        session->setOnInvalidData(dap::kClose);

        // Signal used to terminate the server session when a DisconnectRequest
        // is made by the client.
        SessionState state;

        // Shared pointer to Debugger instance
        std::shared_ptr<Debugger> debugger;

        // Event handler for Debugger events
        auto debuggerEventHandler = [&session, &state](Debugger::Event event)
        {
            switch (event)
            {
            case Debugger::Event::BreakpointHit:
            case Debugger::Event::Stepped:
            case Debugger::Event::Paused:
            {
                dap::StoppedEvent stoppedEvent;
                stoppedEvent.threadId = 1;
                stoppedEvent.reason = "breakpoint";
                session->send(stoppedEvent);
                break;
            }
            case Debugger::Event::Exited:
            {
                dap::ExitedEvent exitedEvent;
                session->send(exitedEvent);

                {
                    std::lock_guard<std::mutex> lock(state.mutex);
                    state.terminate = true;
                }
                state.cv.notify_one();
                break;
            }
            }
        };

        session->onError([&](const char *msg)
                         {
                printf("Session error: %s\n", msg);
                {
                    std::lock_guard<std::mutex> lock(state.mutex);
                    state.terminate = true;
                }
                state.cv.notify_one(); });

        // Register DAP handlers
        session->registerHandler([&](const dap::InitializeRequest &)
                                 {
                std::cout << "Enter InitializeRequest" << std::endl;
                dap::InitializeResponse response;
                response.supportsConfigurationDoneRequest = true;
                std::cout << "Exit InitializeRequest\n" << std::endl;
                return response; });

        session->registerSentHandler([&](const dap::ResponseOrError<dap::InitializeResponse> &)
                                     {
                std::cout << "Enter InitializeResponse" << std::endl;
                std::cout << "Exit InitializeResponse\n" << std::endl;
                session->send(dap::InitializedEvent()); });

        session->registerHandler([&](const dap::MyLaunchRequest &request)
                                 {
                std::cout << "Enter LaunchRequest" << std::endl;
                // Start the program
                std::string program = request.program;
                std::string args = "";
                if (request.args.has_value()) {
                    for (const auto& arg : request.args.value()) {
                        args += arg + " ";
                    }
                }

                // Create the Debugger instance
                debugger = std::make_shared<Debugger>(debuggerEventHandler);

                // Start the debugger in a new thread
                std::thread([debugger, program, args]() {
                    debugger->launch(program, args);
                    debugger->eventLoop();
                }).detach();

                // Wait for the debugger to initialize
                // debugger->getInitializationFuture().wait();

                std::cout << "Exit InitializeRequest\n" << std::endl;
                return dap::LaunchResponse(); });

        session->registerHandler([&](const dap::ConfigurationDoneRequest &)
                                 {
                std::cout << "Enter ConfigurationDoneRequest" << std::endl;
                debugger->configurationDone();
                std::cout << "Exit ConfigurationDoneRequest\n" << std::endl;
                return dap::ConfigurationDoneResponse(); });

        session->registerHandler([&](const dap::SetBreakpointsRequest &request)
                                 {
                std::cout << "Enter SetBreakpointsRequest" << std::endl;
                std::vector<dap::integer> lines;
                for (const auto& bp : request.breakpoints.value({})) {
                    lines.push_back(bp.line);
                }

                if (debugger) {
                    debugger->setBreakpoints(request.source.path.value(""), lines);
                }

                dap::SetBreakpointsResponse response;
                for (const auto& line : lines) {
                    dap::Breakpoint breakpoint;
                    breakpoint.verified = true;
                    breakpoint.line = line;
                    response.breakpoints.push_back(breakpoint);
                }
                std::cout << "Exit SetBreakpointsRequest\n" << std::endl;
                return response; });

        session->registerHandler([&](const dap::ThreadsRequest &)
                                 {
                std::cout << "Enter ThreadsRequest" << std::endl;
                dap::ThreadsResponse response;
                dap::Thread thread;
                thread.id = 1;
                thread.name = "Main Thread";
                response.threads.push_back(thread);
                std::cout << "Exit ThreadsRequest\n" << std::endl;
                return response; });

        session->registerHandler([&](const dap::StackTraceRequest &)
                                 {
                std::cout << "Enter StackTraceRequest" << std::endl;
                dap::StackTraceResponse response;
                if (debugger) {
                    response.stackFrames = debugger->getCallStack();
                }
                std::cout << "Exit StackTraceRequest\n" << std::endl;
                return response; });

        session->registerHandler([&](const dap::ScopesRequest &)
                                 {
                std::cout << "Enter ScopesRequest" << std::endl;
                dap::ScopesResponse response;
                dap::Scope scope;
                scope.name = "Registers";
                scope.variablesReference = 1;
                scope.presentationHint = "registers";
                response.scopes.push_back(scope);
                std::cout << "Exit ScopesRequest\n" << std::endl;
                return response; });

        session->registerHandler([&](const dap::VariablesRequest &)
                                 {
                std::cout << "Enter VariablesRequest" << std::endl;
                dap::VariablesResponse response;
                if (debugger) {
                    auto regs = debugger->getRegisters();
                    for (const auto& reg : regs) {
                        dap::Variable var;
                        size_t eqPos = reg.find('=');
                        if (eqPos != std::string::npos) {
                            var.name = reg.substr(0, eqPos - 1);
                            var.value = reg.substr(eqPos + 2);
                        } else {
                            var.name = reg;
                            var.value = "<unknown>";
                        }
                        response.variables.push_back(var);
                    }
                }
                std::cout << "Exit VariablesRequest\n" << std::endl;
                return response; });

        session->registerHandler([&](const dap::ContinueRequest &)
                                 {
                std::cout << "Enter ContinueRequest" << std::endl;
                if (debugger) {
                    debugger->run();
                }
                dap::ContinueResponse response;
                response.allThreadsContinued = true;
                std::cout << "Exit ContinueRequest\n" << std::endl;
                return response; });

        session->registerHandler([&](const dap::PauseRequest &)
                                 {
                std::cout << "Enter PauseRequest" << std::endl;
                if (debugger) {
                    debugger->pause();
                }
                std::cout << "Exit PauseRequest\n" << std::endl;
                return dap::PauseResponse(); });

        session->registerHandler([&](const dap::NextRequest &)
                                 {
                std::cout << "Enter NextRequest" << std::endl;
                if (debugger) {
                    debugger->stepOver();
                }
                std::cout << "Exit NextRequest\n" << std::endl;
                return dap::NextResponse(); });

        session->registerHandler([&](const dap::StepInRequest &)
                                 {
                std::cout << "Enter StepInRequest" << std::endl;
                if (debugger) {
                    debugger->stepInto();
                }
                std::cout << "Exit StepInRequest\n" << std::endl;
                return dap::StepInResponse(); });

        session->registerHandler([&](const dap::StepOutRequest &)
                                 {
                std::cout << "Enter StepOutRequest" << std::endl;
                if (debugger) {
                    debugger->stepOut();
                }
                std::cout << "Exit StepOutRequest\n" << std::endl;
                return dap::StepOutResponse(); });

        session->registerHandler([&](const dap::DisconnectRequest &)
                                 {
                std::cout << "Enter DisconnectRequest" << std::endl;
                if (debugger) {
                    debugger->exit();
                }
                // Signal termination
                {
                    std::lock_guard<std::mutex> lock(state.mutex);
                    state.terminate = true;
                }
                state.cv.notify_one();
                std::cout << "Exit DisconnectRequest\n" << std::endl;
                return dap::DisconnectResponse(); });

        session->bind(socket);

        // Wait for the client to disconnect before releasing the session and disconnecting the socket
        std::unique_lock<std::mutex> lock(state.mutex);
        state.cv.wait(lock, [&]
                      { return state.terminate; });
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
int main()
{
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    std::shared_ptr<dap::Writer> log;
#ifdef LOG_TO_FILE
    log = dap::file(LOG_TO_FILE);
    // freopen("C:\\Users\\grigo\\Documents\\masm\\log2.txt", "w", stdout);
#endif
    auto session = dap::Session::create();

    // Set the session to close on invalid data
    session->setOnInvalidData(dap::kClose);

    // Signal used to terminate the server session when a DisconnectRequest
    // is made by the client.
    SessionState state;

    // Shared pointer to Debugger instance
    std::shared_ptr<Debugger> debugger;

    // Event handler for Debugger events
    auto debuggerEventHandler = [&session, &state](Debugger::Event event)
    {
        switch (event)
        {
        case Debugger::Event::BreakpointHit:
        case Debugger::Event::Stepped:
        case Debugger::Event::Paused:
        {
            dap::StoppedEvent stoppedEvent;
            stoppedEvent.threadId = 1;
            stoppedEvent.reason = "breakpoint";
            session->send(stoppedEvent);
            break;
        }
        case Debugger::Event::Exited:
        {
            dap::ExitedEvent exitedEvent;
            session->send(exitedEvent);

            {
                std::lock_guard<std::mutex> lock(state.mutex);
                state.terminate = true;
            }
            state.cv.notify_one();
            break;
        }
        }
    };

    session->onError([&](const char *msg)
                     {
                // printf("Session error: %s\n", msg);
                {
                    std::lock_guard<std::mutex> lock(state.mutex);
                    state.terminate = true;
                }
                state.cv.notify_one(); });

    // Register DAP handlers
    session->registerHandler([&](const dap::InitializeRequest &)
                             {
                // std::cout << "Enter InitializeRequest" << std::endl;
                dap::InitializeResponse response;
                response.supportsConfigurationDoneRequest = true;
                // std::cout << "Exit InitializeRequest\n" << std::endl;
                return response; });

    session->registerSentHandler([&](const dap::ResponseOrError<dap::InitializeResponse> &)
                                 {
                // std::cout << "Enter InitializeResponse" << std::endl;
                // std::cout << "Exit InitializeResponse\n" << std::endl;
                session->send(dap::InitializedEvent()); });

    session->registerHandler([&](const dap::MyLaunchRequest &request)
                             {
                // std::cout << "Enter LaunchRequest" << std::endl;
                // Start the program
                std::string program = request.program;
                std::string args = "";
                if (request.args.has_value()) {
                    for (const auto& arg : request.args.value()) {
                        args += arg + " ";
                    }
                }

                // Create the Debugger instance
                debugger = std::make_shared<Debugger>(debuggerEventHandler);

                // Start the debugger in a new thread
                std::thread([debugger, program, args]() {
                    debugger->launch(program, args);
                    debugger->eventLoop();
                }).detach();

                // Wait for the debugger to initialize
                // debugger->getInitializationFuture().wait();

                // std::cout << "Exit InitializeRequest\n" << std::endl;
                return dap::LaunchResponse(); });

    session->registerHandler([&](const dap::ConfigurationDoneRequest &)
                             {
                // std::cout << "Enter ConfigurationDoneRequest" << std::endl;
                debugger->configurationDone();
                // std::cout << "Exit ConfigurationDoneRequest\n" << std::endl;
                return dap::ConfigurationDoneResponse(); });

    session->registerHandler([&](const dap::SetBreakpointsRequest &request)
                             {
                // std::cout << "Enter SetBreakpointsRequest" << std::endl;
                std::vector<dap::integer> lines;
                for (const auto& bp : request.breakpoints.value({})) {
                    lines.push_back(bp.line);
                }

                if (debugger) {
                    debugger->setBreakpoints(request.source.path.value(""), lines);
                }

                dap::SetBreakpointsResponse response;
                for (const auto& line : lines) {
                    dap::Breakpoint breakpoint;
                    breakpoint.verified = true;
                    breakpoint.line = line;
                    response.breakpoints.push_back(breakpoint);
                }
                // std::cout << "Exit SetBreakpointsRequest\n" << std::endl;
                return response; });

    session->registerHandler([&](const dap::ThreadsRequest &)
                             {
                // std::cout << "Enter ThreadsRequest" << std::endl;
                dap::ThreadsResponse response;
                dap::Thread thread;
                thread.id = 1;
                thread.name = "Main Thread";
                response.threads.push_back(thread);
                // std::cout << "Exit ThreadsRequest\n" << std::endl;
                return response; });

    session->registerHandler([&](const dap::StackTraceRequest &)
                             {
                // std::cout << "Enter StackTraceRequest" << std::endl;
                dap::StackTraceResponse response;
                if (debugger) {
                    response.stackFrames = debugger->getCallStack();
                }
                // std::cout << "Exit StackTraceRequest\n" << std::endl;
                return response; });

    session->registerHandler([&](const dap::ScopesRequest &)
                             {
                // std::cout << "Enter ScopesRequest" << std::endl;
                dap::ScopesResponse response;
                dap::Scope scope;
                scope.name = "Registers";
                scope.variablesReference = 1;
                scope.presentationHint = "registers";
                response.scopes.push_back(scope);
                // std::cout << "Exit ScopesRequest\n" << std::endl;
                return response; });

    session->registerHandler([&](const dap::VariablesRequest &)
                             {
                // std::cout << "Enter VariablesRequest" << std::endl;
                dap::VariablesResponse response;
                if (debugger) {
                    auto regs = debugger->getRegisters();
                    for (const auto& reg : regs) {
                        dap::Variable var;
                        size_t eqPos = reg.find('=');
                        if (eqPos != std::string::npos) {
                            var.name = reg.substr(0, eqPos - 1);
                            var.value = reg.substr(eqPos + 2);
                        } else {
                            var.name = reg;
                            var.value = "<unknown>";
                        }
                        response.variables.push_back(var);
                    }
                }
                // std::cout << "Exit VariablesRequest\n" << std::endl;
                return response; });

    session->registerHandler([&](const dap::ContinueRequest &)
                             {
                // std::cout << "Enter ContinueRequest" << std::endl;
                if (debugger) {
                    debugger->run();
                }
                dap::ContinueResponse response;
                response.allThreadsContinued = true;
                // std::cout << "Exit ContinueRequest\n" << std::endl;
                return response; });

    session->registerHandler([&](const dap::PauseRequest &)
                             {
                // std::cout << "Enter PauseRequest" << std::endl;
                if (debugger) {
                    debugger->pause();
                }
                // std::cout << "Exit PauseRequest\n" << std::endl;
                return dap::PauseResponse(); });

    session->registerHandler([&](const dap::NextRequest &)
                             {
                // std::cout << "Enter NextRequest" << std::endl;
                if (debugger) {
                    debugger->stepOver();
                }
                // std::cout << "Exit NextRequest\n" << std::endl;
                return dap::NextResponse(); });

    session->registerHandler([&](const dap::StepInRequest &)
                             {
                // std::cout << "Enter StepInRequest" << std::endl;
                if (debugger) {
                    debugger->stepInto();
                }
                // std::cout << "Exit StepInRequest\n" << std::endl;
                return dap::StepInResponse(); });

    session->registerHandler([&](const dap::StepOutRequest &)
                             {
                // std::cout << "Enter StepOutRequest" << std::endl;
                if (debugger) {
                    debugger->stepOut();
                }
                // std::cout << "Exit StepOutRequest\n" << std::endl;
                return dap::StepOutResponse(); });

    session->registerHandler([&](const dap::DisconnectRequest &)
                             {
                // std::cout << "Enter DisconnectRequest" << std::endl;
                if (debugger) {
                    debugger->exit();
                }
                // Signal termination
                {
                    std::lock_guard<std::mutex> lock(state.mutex);
                    state.terminate = true;
                }
                state.cv.notify_one();
                // std::cout << "Exit DisconnectRequest\n" << std::endl;
                return dap::DisconnectResponse(); });

    std::shared_ptr<dap::Reader> in = dap::file(stdin, false);
    std::shared_ptr<dap::Writer> out = dap::file(stdout, false);
    if (log)
    {
        session->bind(spy(in, log), spy(out, log));
    }
    else
    {
        session->bind(in, out);
    }
    // Wait for the client to disconnect before releasing the session and disconnecting the socket
    std::unique_lock<std::mutex> lock(state.mutex);
    state.cv.wait(lock, [&]
                  { return state.terminate; });
    // printf("Server closing connection\n");
}

#endif
