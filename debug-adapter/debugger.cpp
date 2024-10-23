#include "debugger.h"

#include <cstdio>

Debugger::Debugger(const EventHandler &handler)
    : onEvent(handler)
{
}

Debugger::~Debugger()
{
    exit();
    // Ensure that the event loop has exited before uninitializing
    std::unique_lock<std::mutex> lock(commandMutex);
    commandCV.wait(lock, [this]
                   { return shouldExit; });
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
}

void Debugger::uninitialize()
{
    // Clear previous breakpoints
    // for (auto& bp : breakpoints) {
    //     if (bp.second) {
    //         HRESULT hr = debugControl->RemoveBreakpoint(bp.second);
    //         if (FAILED(hr)) {
    //             printf("IDebugControl::RemoveBreakpoint failed: 0x%08X\n", hr);
    //         }
    //         bp.second->Release();
    //     }
    // }
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
    initialize();

    std::string command = "\"" + program + "\" " + args;

    HRESULT hr = debugClient->CreateProcess(
        NULL,
        const_cast<char *>(command.c_str()),
        DEBUG_PROCESS);

    if (FAILED(hr))
    {
        printf("CreateProcess failed: 0x%08X\n", hr);
        return;
    }
    hr = debugControl->SetEngineOptions(DEBUG_ENGOPT_INITIAL_BREAK);

    // Optionally set symbol path
    hr = debugControl->WaitForEvent(0, INFINITE);
    hr = debugControl->SetEffectiveProcessorType(IMAGE_FILE_MACHINE_I386);
    // TODO
    debugSymbols->SetSymbolPath("C:\\Users\\grigo\\Desktop\\vscode-mock-debug\\sampleWorkspace");
    hr = debugSymbols->Reload("/f");
    hr = debugControl->Execute(DEBUG_OUTCTL_THIS_CLIENT, "l-t", DEBUG_EXECUTE_DEFAULT);
    // run();
}

void Debugger::attach(DWORD processId)
{
    initialize();

    HRESULT hr = debugClient->AttachProcess(
        0, // Server
        processId,
        DEBUG_ATTACH_DEFAULT);

    if (FAILED(hr))
    {
        printf("AttachProcess failed: 0x%08X\n", hr);
        return;
    }
}

void Debugger::configurationDone()
{
    // TODO
    run();
}

void Debugger::run()
{
    // Queue the run command
    {
        std::lock_guard<std::mutex> lock(commandMutex);
        commandQueue.push({CommandType::Run});
    }
    commandCV.notify_one();

    // Interrupt WaitForEvent
    {
        std::lock_guard<std::mutex> lock(debugControlMutex);
        if (debugControl)
        {
            debugControl->SetInterrupt(DEBUG_INTERRUPT_ACTIVE);
        }
    }
}

void Debugger::pause()
{
    {
        std::lock_guard<std::mutex> lock(commandMutex);
        commandQueue.push({CommandType::Pause});
    }
    commandCV.notify_one();

    // Interrupt WaitForEvent
    {
        std::lock_guard<std::mutex> lock(debugControlMutex);
        if (debugControl)
        {
            debugControl->SetInterrupt(DEBUG_INTERRUPT_ACTIVE);
        }
    }
}

void Debugger::stepOver()
{
    {
        std::lock_guard<std::mutex> lock(commandMutex);
        commandQueue.push({CommandType::StepOver});
    }
    commandCV.notify_one();

    // Interrupt WaitForEvent
    {
        std::lock_guard<std::mutex> lock(debugControlMutex);
        if (debugControl)
        {
            debugControl->SetInterrupt(DEBUG_INTERRUPT_ACTIVE);
        }
    }
}

void Debugger::stepInto()
{
    {
        std::lock_guard<std::mutex> lock(commandMutex);
        commandQueue.push({CommandType::StepInto});
    }
    commandCV.notify_one();

    {
        std::lock_guard<std::mutex> lock(debugControlMutex);
        if (debugControl)
        {
            debugControl->SetInterrupt(DEBUG_INTERRUPT_ACTIVE);
        }
    }
}

void Debugger::stepOut()
{
    {
        std::lock_guard<std::mutex> lock(commandMutex);
        commandQueue.push({CommandType::StepOut});
    }
    commandCV.notify_one();

    {
        std::lock_guard<std::mutex> lock(debugControlMutex);
        if (debugControl)
        {
            debugControl->SetInterrupt(DEBUG_INTERRUPT_ACTIVE);
        }
    }
}

void Debugger::setBreakpoints(const std::string &sourceFile, const std::vector<dap::integer> &lines)
{
    {
        std::lock_guard<std::mutex> lock(commandMutex);
        commandQueue.push({CommandType::SetBreakpoints, std::make_any<std::pair<std::string, std::vector<dap::integer>>>(sourceFile, lines)});
    }
    commandCV.notify_one();

    {
        std::lock_guard<std::mutex> lock(debugControlMutex);
        if (debugControl)
        {
            debugControl->SetInterrupt(DEBUG_INTERRUPT_ACTIVE);
        }
    }
}

std::vector<std::string> Debugger::getRegisters()
{
    Command cmd;
    cmd.type = CommandType::GetRegisters;
    std::promise<std::any> promise;
    cmd.promise = std::move(promise);
    std::future<std::any> future = cmd.promise.get_future();

    {
        std::lock_guard<std::mutex> lock(commandMutex);
        commandQueue.push(std::move(cmd));
    }
    commandCV.notify_one();

    {
        std::lock_guard<std::mutex> lock(debugControlMutex);
        if (debugControl)
        {
            debugControl->SetInterrupt(DEBUG_INTERRUPT_ACTIVE);
        }
    }

    // Wait for the result
    return std::any_cast<std::vector<std::string>>(future.get());
}

std::vector<dap::StackFrame> Debugger::getCallStack()
{
    Command cmd;
    cmd.type = CommandType::GetCallStack;
    std::promise<std::any> promise;
    cmd.promise = std::move(promise);
    std::future<std::any> future = cmd.promise.get_future();

    {
        std::lock_guard<std::mutex> lock(commandMutex);
        commandQueue.push(std::move(cmd));
    }
    commandCV.notify_one();

    {
        std::lock_guard<std::mutex> lock(debugControlMutex);
        if (debugControl)
        {
            debugControl->SetInterrupt(DEBUG_INTERRUPT_ACTIVE);
        }
    }

    // Wait for the result
    return std::any_cast<std::vector<dap::StackFrame>>(future.get());
}

void Debugger::exit()
{
    {
        std::lock_guard<std::mutex> lock(commandMutex);
        commandQueue.push({CommandType::Exit});
    }
    commandCV.notify_one();

    // Interrupt WaitForEvent
    {
        std::lock_guard<std::mutex> lock(debugControlMutex);
        if (debugControl)
        {
            debugControl->SetInterrupt(DEBUG_INTERRUPT_ACTIVE);
        }
    }
}

void Debugger::eventLoop()
{
    bool isStopped = false;

    while (true)
    {
        HRESULT hr = S_OK;

        // Wait for an event or an interrupt
        {
            std::lock_guard<std::mutex> lock(debugControlMutex);
            if (debugControl)
            {
                hr = debugControl->WaitForEvent(0, INFINITE); // Wait indefinitely
            }
            else
            {
                hr = E_FAIL;
            }
        }

        if (shouldExit)
        {
            break;
        }

        if (hr == S_OK)
        {
            // Handle debugger event
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
            ULONG eventType = 0;
            ULONG processId = 0;
            ULONG threadId;
            hr = debugControl->GetLastEventInformation(&eventType, &processId, &threadId,
                                                       nullptr,
                                                       0,
                                                       nullptr,
                                                       nullptr,
                                                       0,
                                                       nullptr);

            if (execStatus == DEBUG_STATUS_BREAK)
            {
                // Breakpoint hit or paused
                if (!isStopped)
                {
                    // Only send StoppedEvent when state changes to stopped
                    onEvent(Event::BreakpointHit);
                    isStopped = true;
                }
            }
            else if (execStatus == DEBUG_STATUS_NO_DEBUGGEE)
            {
                // Debuggee exited
                onEvent(Event::Exited);
                shouldExit = true;
                break;
            }
        }
        else if (hr == E_PENDING)
        {
            // Interrupt occurred
            // Continue to process commands
        }
        else
        {
            // Error or debuggee exited
            onEvent(Event::Exited);
            shouldExit = true;
            break;
        }

        // Process commands
        bool commandProcessed = false;
        while (true)
        {
            Command cmd;
            {
                std::unique_lock<std::mutex> lock(commandMutex);
                if (commandQueue.empty())
                {
                    if (isStopped)
                    {
                        // Wait for commands if stopped
                        commandCV.wait(lock, [this]
                                       { return !commandQueue.empty() || shouldExit; });
                    }
                    else
                    {
                        // No commands and not stopped, break to continue WaitForEvent
                        break;
                    }
                    if (commandQueue.empty() && shouldExit)
                    {
                        break;
                    }
                }

                if (!commandQueue.empty())
                {
                    cmd = std::move(commandQueue.front());
                    commandQueue.pop();
                    commandProcessed = true;
                }
                else
                {
                    continue;
                }
            }

            // Process the command
            switch (cmd.type)
            {
            case CommandType::Run:
            {
                hr = debugControl->SetExecutionStatus(DEBUG_STATUS_GO);
                if (FAILED(hr))
                {
                    printf("SetExecutionStatus(GO) failed: 0x%08X\n", hr);
                }
                else
                {
                    isStopped = false;
                }
                break;
            }
            case CommandType::Pause:
            {
                hr = debugControl->SetInterrupt(DEBUG_INTERRUPT_ACTIVE);
                if (FAILED(hr))
                {
                    printf("SetInterrupt failed: 0x%08X\n", hr);
                }
                break;
            }
            case CommandType::StepOver:
            {
                hr = debugControl->SetExecutionStatus(DEBUG_STATUS_STEP_OVER);
                if (FAILED(hr))
                {
                    printf("SetExecutionStatus(STEP_OVER) failed: 0x%08X\n", hr);
                }
                else
                {
                    isStopped = false;
                }
                break;
            }
            case CommandType::StepInto:
            {
                hr = debugControl->SetExecutionStatus(DEBUG_STATUS_STEP_INTO);
                if (FAILED(hr))
                {
                    printf("SetExecutionStatus(STEP_INTO) failed: 0x%08X\n", hr);
                }
                else
                {
                    isStopped = false;
                }
                break;
            }
            case CommandType::StepOut:
            {
                // Get the return address of the current stack frame
                DEBUG_STACK_FRAME frames[1];
                ULONG filled = 0;
                hr = debugControl->GetStackTrace(0, 0, 0, frames, 1, &filled);
                if (FAILED(hr) || filled == 0)
                {
                    printf("GetStackTrace failed: 0x%08X\n", hr);
                    break;
                }

                ULONG64 returnOffset = frames[0].ReturnOffset;

                // Set a temporary breakpoint at the return address
                IDebugBreakpoint *bp = nullptr;
                hr = debugControl->AddBreakpoint(DEBUG_BREAKPOINT_CODE, DEBUG_ANY_ID, &bp);
                if (FAILED(hr))
                {
                    printf("AddBreakpoint failed: 0x%08X\n", hr);
                    break;
                }

                bp->SetOffset(returnOffset);
                bp->AddFlags(DEBUG_BREAKPOINT_ONE_SHOT);
                bp->SetFlags(DEBUG_BREAKPOINT_ENABLED);

                // Get breakpoint ID
                ULONG bpId = 0;
                hr = bp->GetId(&bpId);
                if (FAILED(hr))
                {
                    printf("GetId failed: 0x%08X\n", hr);
                    break;
                }

                // Store the breakpoint ID
                // this->stepOutBpId = bpId;

                // Continue execution
                hr = debugControl->SetExecutionStatus(DEBUG_STATUS_GO);
                if (FAILED(hr))
                {
                    printf("SetExecutionStatus(GO) failed: 0x%08X\n", hr);
                }
                else
                {
                    isStopped = false;
                }
                break;
                break;
            }
            case CommandType::SetBreakpoints:
            {
                // Handle setting breakpoints
                // No change to isStopped
                auto data = std::any_cast<std::pair<std::string, std::vector<dap::integer>>>(cmd.data);
                const std::string &sourceFile = data.first;
                const std::vector<dap::integer> &lines = data.second;

                // Clear previous breakpoints
                for (auto &bp : breakpoints)
                {
                    if (bp.second)
                    {
                        hr = debugControl->RemoveBreakpoint(bp.second);
                        if (FAILED(hr))
                        {
                            printf("IDebugControl::RemoveBreakpoint failed: 0x%08X\n", hr);
                        }
                        // bp.second->Release();
                    }
                }
                breakpoints.clear();

                for (dap::integer line : lines)
                {
                    ULONG64 offset = 0;
                    hr = debugSymbols->GetOffsetByLine(static_cast<ULONG>(line), sourceFile.c_str(), &offset);
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
                break;
            }
            case CommandType::GetRegisters:
            {
                // Handle getting registers
                // No change to isStopped
                std::vector<std::string> registers;

                ULONG numRegisters = 0;
                hr = debugRegisters->GetNumberRegisters(&numRegisters);
                if (FAILED(hr))
                {
                    printf("GetNumberRegisters failed: 0x%08X\n", hr);
                    cmd.promise.set_value(registers);
                    break;
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

                cmd.promise.set_value(registers);
                break;
            }
            case CommandType::GetCallStack:
            {
                // Handle getting call stack
                // No change to isStopped
                std::vector<dap::StackFrame> stackFrames;

                DEBUG_STACK_FRAME frames[100];
                ULONG filled = 0;
                hr = debugControl->GetStackTrace(0, 0, 0, frames, 100, &filled);
                if (FAILED(hr))
                {
                    printf("GetStackTrace failed: 0x%08X\n", hr);
                    cmd.promise.set_value(stackFrames);
                    break;
                }

                for (ULONG i = 0; i < filled; ++i)
                {
                    dap::StackFrame frame;
                    frame.id = frames[i].InstructionOffset;

                    char funcName[256];
                    hr = debugSymbols->GetNameByOffset(frames[i].InstructionOffset, funcName, sizeof(funcName), nullptr, nullptr);

                    if (SUCCEEDED(hr))
                    {
                        ULONG line = 0;
                        char fileName[MAX_PATH] = {};

                        // ULONG64 funcOffset = 0;
                        // hr = debugSymbols->GetOffsetByName(funcName, &funcOffset);
                        // ULONG64 instructionOffset = 0;
                        // hr = debugRegisters->GetInstructionOffset(&instructionOffset);
                        hr = debugSymbols->GetLineByOffset(frames[i].InstructionOffset, &line, fileName, sizeof(fileName), nullptr, nullptr);
                        if (SUCCEEDED(hr))
                        {
                            frame.name = dap::string(funcName);
                            frame.line = line;
                            frame.column = 1;
                            frame.source = dap::Source();
                            frame.source->name = fileName;
                            frame.source->path = fileName;
                        }

                        stackFrames.push_back(frame);
                    }
                    else
                    {
                        stackFrames.push_back(frame);
                    }
                }

                cmd.promise.set_value(stackFrames);
                break;
            }
            case CommandType::Exit:
            {
                shouldExit = true;
                // Notify destructor that eventLoop has exited
                {
                    std::lock_guard<std::mutex> lock(commandMutex);
                    commandCV.notify_all();
                }
                return;
            }
            }
        }

        if (shouldExit)
        {
            break;
        }

        if (!commandProcessed && isStopped)
        {
            // If no command was processed and we're stopped, wait for commands
            std::unique_lock<std::mutex> lock(commandMutex);
            commandCV.wait(lock, [this]
                           { return !commandQueue.empty() || shouldExit; });
            if (shouldExit)
            {
                break;
            }
        }
    }
}
