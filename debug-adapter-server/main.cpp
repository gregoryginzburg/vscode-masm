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
#include <fstream>

// #define USE_SERVER_MODE
#define LOG_TO_FILE "C:\\Users\\grigo\\Documents\\masm\\log.txt" // TODO: remove in release

namespace dap {

class MyLaunchRequest : public LaunchRequest {
public:
    // The program executable path.
    dap::string program;

    // Command line arguments for the program.
    optional<array<string>> args;
};

DAP_STRUCT_TYPEINFO_EXT(MyLaunchRequest, LaunchRequest, "launch", DAP_FIELD(program, "program"),
                        DAP_FIELD(args, "args"));

} // namespace dap

static std::function<void(Debugger::Event)> createDebuggerEventHandler(const std::shared_ptr<dap::Session> &session,
                                                                           const std::shared_ptr<SessionState> &state)
{
    return [session, state](Debugger::Event event) {
        switch (event.type) {
        case Debugger::EventType::BreakpointHit: {
            dap::StoppedEvent stoppedEvent;
            stoppedEvent.threadId = 1;
            stoppedEvent.reason = "breakpoint";
            std::cout << "Sent breakpoint hit event" << std::endl;
            session->send(stoppedEvent);
            break;
        }
        case Debugger::EventType::Stepped: {
            dap::StoppedEvent stoppedEvent;
            stoppedEvent.threadId = 1;
            stoppedEvent.reason = "step";
            session->send(stoppedEvent);
            break;
        }
        case Debugger::EventType::Paused: {
            dap::StoppedEvent stoppedEvent;
            stoppedEvent.threadId = 1;
            stoppedEvent.reason = "pause";
            session->send(stoppedEvent);
            break;
        }
        case Debugger::EventType::Exited: {
            dap::TerminatedEvent terminatedEvent;
            session->send(terminatedEvent);
            dap::ExitedEvent exitedEvent;
            session->send(exitedEvent);

            {
                std::lock_guard<std::mutex> lock(state->mutex);
                state->terminate = true;
            }
            state->cv.notify_one();
            break;
        }
        case Debugger::EventType::Exception: {
            dap::StoppedEvent stoppedEvent;
            stoppedEvent.threadId = 1;
            stoppedEvent.reason = "exception";
            stoppedEvent.description = event.description;
            stoppedEvent.allThreadsStopped = true;
            session->send(stoppedEvent);
        }
        }
    };
}

static void setupSessionHandlers(const std::shared_ptr<dap::Session> &session,
                                 const std::shared_ptr<SessionState> &state, const std::shared_ptr<Debugger> &debugger)
{

    session->onError([&](const char *msg) {
        printf("Session error: %s\n", msg);
        {
            std::lock_guard<std::mutex> lock(state->mutex);
            state->terminate = true;
        }
        state->cv.notify_one();
    });

    // Register DAP handlers
    session->registerHandler([&](const dap::InitializeRequest &) {
        std::cout << "Enter InitializeRequest" << std::endl;
        dap::InitializeResponse response;
        response.supportsConfigurationDoneRequest = true;
        response.supportsEvaluateForHovers = true;
        response.supportsExceptionInfoRequest = true;

        std::cout << "Exit InitializeRequest\n" << std::endl;
        return response;
    });

    session->registerHandler([&](const dap::MyLaunchRequest &request) {
        std::cout << "Enter LaunchRequest" << std::endl;
        // Start the program
        std::string program = request.program;
        std::string args = "";
        if (request.args.has_value()) {
            for (const auto &arg : request.args.value()) {
                args += arg + " ";
            }
        }
        // debugger->waitForConfigurationDone();
        // Start the debugger in a new thread
        std::thread([debugger, program, args]() {
            debugger->launch(program, args);
            debugger->eventLoop();
        }).detach();

        // Wait for the debugger to initialize
        debugger->waitForInitialization();
        session->send(dap::InitializedEvent());

        return dap::LaunchResponse();
    });

    session->registerHandler([&](const dap::ConfigurationDoneRequest &) {
        std::cout << "Enter ConfigurationDoneRequest" << std::endl;
        debugger->configurationDone();
        std::cout << "Exit ConfigurationDoneRequest\n" << std::endl;
        return dap::ConfigurationDoneResponse();
    });

    session->registerHandler([&](const dap::SetBreakpointsRequest &request) {
        std::cout << "Enter SetBreakpointsRequest" << std::endl;
        std::vector<dap::integer> lines;
        for (const auto &bp : request.breakpoints.value({})) {
            lines.push_back(bp.line);
        }

        if (debugger) {
            debugger->setBreakpoints(request.source.path.value(""), lines);
        }

        dap::SetBreakpointsResponse response;
        for (const auto &line : lines) {
            dap::Breakpoint breakpoint;
            breakpoint.verified = true;
            breakpoint.line = line;
            response.breakpoints.push_back(breakpoint);
        }
        std::cout << "Exit SetBreakpointsRequest\n" << std::endl;
        return response;
    });

    session->registerHandler([&](const dap::ThreadsRequest &) {
        std::cout << "Enter ThreadsRequest" << std::endl;
        dap::ThreadsResponse response;
        dap::Thread thread;
        thread.id = 1;
        thread.name = "Main Thread";
        response.threads.push_back(thread);
        std::cout << "Exit ThreadsRequest\n" << std::endl;
        return response;
    });

    session->registerHandler([&](const dap::StackTraceRequest &) {
        std::cout << "Enter StackTraceRequest" << std::endl;
        dap::StackTraceResponse response;
        if (debugger) {
            response.stackFrames = debugger->getCallStack();
        }
        std::cout << "Exit StackTraceRequest\n" << std::endl;
        return response;
    });

    session->registerHandler([&](const dap::ScopesRequest &) {
        std::cout << "Enter ScopesRequest" << std::endl;
        dap::ScopesResponse response;

        dap::Scope registersScope;
        registersScope.name = "Registers";
        registersScope.variablesReference = 1;
        registersScope.presentationHint = "registers";
        response.scopes.push_back(registersScope);

        dap::Scope stackScope;
        stackScope.name = "Stack";
        stackScope.variablesReference = 2;
        stackScope.presentationHint = "locals";
        response.scopes.push_back(stackScope);
        std::cout << "Exit ScopesRequest\n" << std::endl;
        return response;
    });

    session->registerHandler([&](const dap::VariablesRequest &request) {
        std::cout << "Enter VariablesRequest" << std::endl;
        dap::VariablesResponse response;
        if (debugger) {
            if (request.variablesReference == 1) { // Registers
                auto regs = debugger->getRegisters();
                for (const auto &reg : regs) {
                    dap::Variable var;
                    size_t eqPos = reg.find('=');
                    if (eqPos != std::string::npos) {
                        var.name = reg.substr(0, eqPos - 1);
                        var.value = reg.substr(eqPos + 2);
                    } else {
                        var.name = reg;
                        var.value = "<unknown>";
                    }
                    dap::VariablePresentationHint hint;
                    hint.attributes = dap::array<dap::string>{"readOnly"};
                    hint.kind = "property";
                    var.presentationHint = hint;
                    response.variables.push_back(var);
                }
                dap::Variable var;
                var.name = "EFLAGS";
                var.variablesReference = 3;
                dap::VariablePresentationHint hint;
                hint.attributes = dap::array<dap::string>{"readOnly"};
                hint.kind = "property";
                var.presentationHint = hint;
                response.variables.push_back(var);
            } else if (request.variablesReference == 2) { // Stack
                auto stackContents = debugger->getStackContents();
                for (const auto &entry : stackContents) {
                    dap::Variable var;
                    var.name = entry.address;
                    var.value = entry.value;
                    dap::VariablePresentationHint hint;
                    hint.attributes = dap::array<dap::string>{"readOnly"};
                    hint.kind = "method";
                    var.presentationHint = hint;
                    response.variables.push_back(var);
                }
            } else if (request.variablesReference == 3) { // EFLAGS
                auto eflags = debugger->getEflags();
                for (const auto &flag : eflags) {
                    dap::Variable var;
                    var.name = flag.first;
                    var.value = flag.second;
                    dap::VariablePresentationHint hint;
                    hint.attributes = dap::array<dap::string>{"readOnly"};
                    hint.kind = "property";
                    var.presentationHint = hint;
                    response.variables.push_back(var);
                }
            }
        }
        std::cout << "Exit VariablesRequest\n" << std::endl;
        return response;
    });

    session->registerHandler([&](const dap::EvaluateRequest &request) {
        std::cout << "Enter evaluate request: " << request.context.value("") << std::endl;
        dap::ResponseOrError<dap::EvaluateResponse> response;
        std::string expr = request.expression;
        std::string context = request.context.value("");

        if (context == "hover") {
            std::string value = debugger->evaluateVariable(expr);
            if (!value.empty()) {
                response.response.result = value;
            } else {
                response.error = "Don't send a response to avoid empty box";
            }
            return response;
        } else if (context == "watch" || context == "repl") {
            // For watch and repl, evaluate the expression normally
            std::string value = debugger->evaluateExpression(expr);
            response.response.result = value;
        } else {
            response.response.result = "<Unsupported context>";
        }
        return response;
    });

    session->registerHandler([&](const dap::ExceptionInfoRequest &request) {
        dap::ExceptionInfoResponse response;
        if (debugger) {
            auto exceptionInfo = debugger->getExceptionInfo(request.threadId);
            response.exceptionId = exceptionInfo.exceptionId;
            response.description = exceptionInfo.description;
            response.breakMode = exceptionInfo.breakMode;
            response.details = exceptionInfo.details;
        }
        return response;
    });

    session->registerHandler([&](const dap::ContinueRequest &) {
        std::cout << "Enter ContinueRequest" << std::endl;
        if (debugger) {
            debugger->run();
        }
        dap::ContinueResponse response;
        response.allThreadsContinued = true;
        std::cout << "Exit ContinueRequest\n" << std::endl;
        return response;
    });

    session->registerHandler([&](const dap::PauseRequest &) {
        std::cout << "Enter PauseRequest" << std::endl;
        if (debugger) {
            debugger->pause();
        }
        std::cout << "Exit PauseRequest\n" << std::endl;
        return dap::PauseResponse();
    });

    session->registerHandler([&](const dap::NextRequest &) {
        std::cout << "Enter NextRequest" << std::endl;
        if (debugger) {
            debugger->stepOver();
        }
        std::cout << "Exit NextRequest\n" << std::endl;
        return dap::NextResponse();
    });

    session->registerHandler([&](const dap::StepInRequest &) {
        std::cout << "Enter StepInRequest" << std::endl;
        if (debugger) {
            debugger->stepInto();
        }
        std::cout << "Exit StepInRequest\n" << std::endl;
        return dap::StepInResponse();
    });

    session->registerHandler([&](const dap::StepOutRequest &) {
        std::cout << "Enter StepOutRequest" << std::endl;
        if (debugger) {
            debugger->stepOut();
        }
        std::cout << "Exit StepOutRequest\n" << std::endl;
        return dap::StepOutResponse();
    });

    session->registerHandler([&](const dap::DisconnectRequest &) {
        std::cout << "Enter DisconnectRequest" << std::endl;
        // Signal termination

        debugger->exit();
        {
            std::lock_guard<std::mutex> lock(state->mutex);
            state->terminate = true;
        }
        state->cv.notify_one();
        std::cout << "Exit DisconnectRequest\n" << std::endl;
        return dap::DisconnectResponse();
    });
}

#ifdef USE_SERVER_MODE
static int runServerMode(int port)
{
    auto server = dap::net::Server::create();

    auto onClientConnected = [port](const std::shared_ptr<dap::ReaderWriter> &socket) {
        auto uniqueSession = dap::Session::create();
        std::shared_ptr<dap::Session> session = std::move(uniqueSession);

        session->setOnInvalidData(dap::kClose);

        auto state = std::make_shared<SessionState>();
        std::shared_ptr<Debugger> debugger;

        auto handler = createDebuggerEventHandler(session, state);
        debugger = std::make_shared<Debugger>(handler);
        setupSessionHandlers(session, state, debugger);

        session->bind(socket);

        // Wait for termination
        std::unique_lock<std::mutex> lock(state->mutex);
        state->cv.wait(lock, [&] { return state->terminate; });
        std::cerr << "Client disconnected, server closing connection\n";
    };

    auto onError = [](const char *msg) { std::cerr << "Server error: " << msg << "\n"; };

    server->start(port, onClientConnected, onError);

    std::mutex m;
    std::condition_variable cv;
    std::unique_lock<std::mutex> lock(m);
    cv.wait(lock);

    return 0;
}
#else
static int runStdioMode()
{
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    std::shared_ptr<dap::Writer> log;
#    ifdef LOG_TO_FILE
    log = dap::file(LOG_TO_FILE);
#    endif

    auto uniqueSession = dap::Session::create();
    std::shared_ptr<dap::Session> session = std::move(uniqueSession);
    session->setOnInvalidData(dap::kClose);

    auto state = std::make_shared<SessionState>();
    std::shared_ptr<Debugger> debugger;

    auto handler = createDebuggerEventHandler(session, state);
    debugger = std::make_shared<Debugger>(handler);
    setupSessionHandlers(session, state, debugger);

    std::ofstream errorFile("C:\\Users\\grigo\\Documents\\masm\\error_log.txt", std::ios::out | std::ios::app); // TODO: remove in release
    // Redirect std::cerr to the file
    std::cerr.rdbuf(errorFile.rdbuf());

    std::shared_ptr<dap::Reader> in = dap::file(stdin, false);
    std::shared_ptr<dap::Writer> out = dap::file(stdout, false);
    if (log) {
        session->bind(spy(in, log), spy(out, log));
    } else {
        session->bind(in, out);
    }

    std::unique_lock<std::mutex> lock(state->mutex);
    state->cv.wait(lock, [&] { return state->terminate; });
    std::cerr << "Closing session\n";
    return 0;
}
#endif

int main() {
#ifdef USE_SERVER_MODE
    constexpr int kPort = 19021;
    return runServerMode(kPort);
#else
    return runStdioMode();
#endif
}
