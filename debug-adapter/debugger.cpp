// debugger.cpp

#include "debugger.h"

#include <cstdio>
#include <iostream>
#include <thread>
#include <filesystem>
#include <winerror.h>
#include <map>
#include <string>
#include <set>
#include <regex>
#include <bitset>

#define STATUS_WX86_BREAKPOINT 0x4000001FL
#define STATUS_WX86_SINGLE_STEP 0x4000001EL

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
        // Optionally handle debugger output here
        printf("%s", Text);
        return S_OK;
    }
};

MyOutputCallbacks outputCallbacks;

Debugger::Debugger(const EventHandler &handler) : onEvent(handler), eventCallbacks(nullptr), shouldExit(false) {}

Debugger::~Debugger()
{
    exit();
    hasExited.wait();
    uninitialize();
}

void Debugger::initialize()
{
    HRESULT hr;
    hr = DebugCreate(__uuidof(IDebugClient), (void **)&debugClient);
    if (FAILED(hr)) {
        printf("DebugCreate failed: 0x%08X\n", hr);
        return;
    }

    hr = debugClient->QueryInterface(__uuidof(IDebugControl3), (void **)&debugControl);
    hr = debugClient->QueryInterface(__uuidof(IDebugSymbols), (void **)&debugSymbols);
    hr = debugClient->QueryInterface(__uuidof(IDebugRegisters), (void **)&debugRegisters);
    hr = debugClient->QueryInterface(__uuidof(IDebugSystemObjects), (void **)&debugSystemObjects);
    hr = debugClient->QueryInterface(__uuidof(IDebugDataSpaces), (void **)&debugDataSpaces);

    debugClient->SetOutputCallbacks(&outputCallbacks);

    // Initialize event callbacks
    eventCallbacks = new MyDebugEventCallbacks(this, debugControl);
    hr = debugClient->SetEventCallbacks(eventCallbacks);

    DEBUG_EXCEPTION_FILTER_PARAMETERS params;
    ULONG code = STATUS_WX86_SINGLE_STEP;
    hr = debugControl->GetExceptionFilterParameters(1, &code, NULL, &params);

    params.ExceptionCode = STATUS_WX86_SINGLE_STEP;
    params.ContinueOption = DEBUG_FILTER_GO_NOT_HANDLED;
    hr = debugControl->SetExceptionFilterParameters(1, &params);

    params.ExceptionCode = STATUS_SINGLE_STEP;
    params.ContinueOption = DEBUG_FILTER_GO_NOT_HANDLED;
    hr = debugControl->SetExceptionFilterParameters(1, &params);

    hr = debugControl->GetExceptionFilterParameters(1, &code, NULL, &params);
}

void Debugger::uninitialize()
{
    if (eventCallbacks) {
        debugClient->SetEventCallbacks(nullptr);
        eventCallbacks->Release();
        eventCallbacks = nullptr;
    }

    if (debugClient) {
        debugClient->EndSession(DEBUG_END_ACTIVE_TERMINATE);
    }

    // Clear previous breakpoints
    // for (auto &bp : breakpoints) {
    //     if (bp.second) {
    //         HRESULT hr = debugControl->RemoveBreakpoint(bp.second);
    //         if (FAILED(hr)) {
    //             printf("IDebugControl3::RemoveBreakpoint failed: 0x%08X\n", hr);
    //         }
    //     }
    // }
    breakpoints.clear();

    if (debugDataSpaces) {
        debugDataSpaces->Release();
        debugDataSpaces = nullptr;
    }

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

    hr = debugControl->WaitForEvent(0, INFINITE);
    // hr = debugControl->SetEffectiveProcessorType(IMAGE_FILE_MACHINE_I386);
    //  Set symbol path as needed
    std::string programDirectory = std::filesystem::path(program).parent_path().string();
    hr = debugSymbols->SetSymbolPath(programDirectory.c_str());
    hr = debugSymbols->Reload("/f /i");
    hr = debugControl->Execute(DEBUG_OUTCTL_THIS_CLIENT, "sxe *", DEBUG_EXECUTE_DEFAULT);
    hr = debugControl->Execute(DEBUG_OUTCTL_THIS_CLIENT, "sxe 0x4000001E", DEBUG_EXECUTE_DEFAULT);
    hr = debugControl->Execute(DEBUG_OUTCTL_THIS_CLIENT, "sxe 0x80000004", DEBUG_EXECUTE_DEFAULT);
    hr = debugControl->Execute(DEBUG_OUTCTL_THIS_CLIENT, ".eff x86", DEBUG_EXECUTE_DEFAULT);

    // hr = debugControl->Execute(DEBUG_OUTCTL_THIS_CLIENT, "l-t", DEBUG_EXECUTE_DEFAULT);

    // hr = debugControl->SetExecutionStatus(DEBUG_STATUS_GO);
    // const char *sourceFile = "c:\\Users\\grigo\\Desktop\\vscode-mock-debug\\sampleWorkspace\\test.asm";
    // ULONG64 offset;
    // hr = debugSymbols->GetOffsetByLine(static_cast<ULONG>(24), sourceFile, &offset);

    // Wait for initial breakpoint
    waitForEvent.fire();
}

void Debugger::waitForInitialization() { hasInitialized.wait(); }

void Debugger::configurationDone() { run(); }

void Debugger::run()
{
    std::lock_guard<std::mutex> lock(debugMutex);
    if (debugControl) {
        HRESULT hr = debugControl->SetExecutionStatus(DEBUG_STATUS_GO);
        if (FAILED(hr)) {
            printf("SetExecutionStatus(GO) failed: 0x%08X\n", hr);
        } else {
            waitForEvent.fire();
        }
    }
}

void Debugger::pause()
{
    std::lock_guard<std::mutex> lock(debugMutex);
    if (debugControl) {
        HRESULT hr = debugControl->SetInterrupt(DEBUG_INTERRUPT_ACTIVE);
        if (FAILED(hr)) {
        }
    }
}

int Debugger::getCurrentLineNumber()
{
    ULONG64 offset;
    HRESULT hr = debugRegisters->GetInstructionOffset(&offset);

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
        // HRESULT hr = debugControl->Execute(DEBUG_OUTCTL_THIS_CLIENT, // Output control, sends output to the current
        // client
        //                             "p",                      // The command to step over
        //                             DEBUG_EXECUTE_DEFAULT     // Execute options
        // );
        HRESULT hr = debugControl->SetExecutionStatus(DEBUG_STATUS_STEP_OVER);
        if (FAILED(hr)) {
            printf("SetExecutionStatus(STEP_OVER) failed: 0x%08X\n", hr);
        } else {
            waitForEvent.fire();
        }
    }
}

void Debugger::stepInto()
{
    std::lock_guard<std::mutex> lock(debugMutex);
    if (debugControl) {
        HRESULT hr = debugControl->SetExecutionStatus(DEBUG_STATUS_STEP_INTO);
        if (FAILED(hr)) {
            printf("SetExecutionStatus(STEP_INTO) failed: 0x%08X\n", hr);
        } else {
            waitForEvent.fire();
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
    if (FAILED(hr)) {
        printf("SetExecutionStatus(GO) failed: 0x%08X\n", hr);
    } else {
        waitForEvent.fire();
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

    // Define the main 32-bit registers we are interested in
    const std::set<std::string> main32BitRegisters = {"eax", "ebx", "ecx", "edx", "esi", "edi", "ebp", "esp", "cs", "ds", "ss"};

    for (ULONG i = 0; i < numRegisters; ++i) {
        char name[64];
        hr = debugRegisters->GetDescription(i, name, sizeof(name), nullptr, nullptr);

        if (SUCCEEDED(hr) && main32BitRegisters.count(name) > 0) {
            DEBUG_VALUE value = {};
            hr = debugRegisters->GetValue(i, &value);
            if (SUCCEEDED(hr) && value.Type == DEBUG_VALUE_INT32) {
                char buffer[128];
                sprintf_s(buffer, "%s = 0x%lx", name, value.I32);
                registers.push_back(buffer);
            }
        }
    }

    return registers;
}

std::map<std::string, std::string> Debugger::getEflags()
{
    std::map<std::string, std::string> eflagsMap;
    DEBUG_VALUE eflagsValue;

    if (!debugControl) {
        return eflagsMap;
    }

    HRESULT hr = debugControl->Evaluate("efl", DEBUG_VALUE_INT32, &eflagsValue, nullptr);
    if (FAILED(hr) || eflagsValue.Type != DEBUG_VALUE_INT32) {
        printf("Evaluate('eflags') failed or returned unsupported type: 0x%08X\n", hr);
        return eflagsMap;
    }

    uint32_t eflags = eflagsValue.I32;

    // Decode the main bits in the EFLAGS register
    eflagsMap["CF"] = (eflags & (1 << 0)) ? "1" : "0";
    eflagsMap["OF"] = (eflags & (1 << 11)) ? "1" : "0";
    eflagsMap["SF"] = (eflags & (1 << 7)) ? "1" : "0";
    eflagsMap["ZF"] = (eflags & (1 << 6)) ? "1" : "0";
    eflagsMap["DF"] = (eflags & (1 << 10)) ? "1" : "0";
    eflagsMap["IF"] = (eflags & (1 << 9)) ? "1" : "0";

    return eflagsMap;
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

std::vector<Debugger::StackEntry> Debugger::getStackContents()
{
    std::vector<StackEntry> stackContents;

    std::lock_guard<std::mutex> lock(debugMutex);
    if (!debugControl || !debugDataSpaces) {
        return stackContents;
    }

    ULONG64 sp = 0;
    HRESULT hr = debugRegisters->GetStackOffset(&sp);
    if (FAILED(hr)) {
        printf("GetStackOffset failed: 0x%08X\n", hr);
        return stackContents;
    }

    ULONG64 address = sp;
    // stack unwinding to get all return addresses (EIP values)
    std::vector<ULONG64> ebpArray;
    std::vector<ULONG64> eipArray;
    DEBUG_STACK_FRAME frames[100];
    ULONG filled = 0;
    ULONG64 firstFrameAddress = 0;
    hr = debugControl->GetStackTrace(0, 0, 0, frames, 100, &filled);

    for (ULONG i = 0; i < filled; ++i) {
        ebpArray.push_back(frames[i].FrameOffset); // Collect EBP
        if (frames[i].ReturnOffset != 0) {
            eipArray.push_back(frames[i].ReturnOffset); // Collect EIP
        }
        char symbolBuffer[1024] = {0};
        ULONG64 displacement = 0;
        hr = debugSymbols->GetNameByOffset(frames[i].InstructionOffset, symbolBuffer, sizeof(symbolBuffer), NULL,
                                           &displacement);

        std::string symbolName(symbolBuffer);

        if (symbolName.find("start") != std::string::npos) {
            firstFrameAddress = frames[i].FrameOffset;
            break;
        }
        // if there's no start function - show all stack
        firstFrameAddress = frames[i].FrameOffset;
    }

    ULONG64 numEntries;
    if (firstFrameAddress < address) {
        numEntries = 1;
    } else {
        numEntries = (firstFrameAddress - address) / sizeof(ULONG32) + 2;
    }

    ULONG bytesRead = 0;
    std::vector<ULONG32> stackData{};
    stackData.resize(numEntries);

    hr = debugDataSpaces->ReadVirtual(address, stackData.data(), static_cast<ULONG>(stackData.size() * sizeof(ULONG32)), &bytesRead);
    if (FAILED(hr)) {
        printf("ReadVirtual failed: 0x%08X\n", hr);
        return stackContents;
    }

    for (int i = 0; i < numEntries; ++i) {
        StackEntry entry;
        char addrStr[128];
        ULONG64 currentAddress = address + i * sizeof(ULONG32);

        // Determine the base annotation for the address based on known stack structure
        if (std::find(ebpArray.begin(), ebpArray.end(), currentAddress) != ebpArray.end()) {
            sprintf_s(addrStr, "Saved EBP            -> 0x%08x", static_cast<ULONG32>(address + i * sizeof(ULONG32)));
        } else if (std::find(eipArray.begin(), eipArray.end(), stackData[i]) != eipArray.end()) {
            sprintf_s(addrStr, "Return Address (EIP) -> 0x%08x", static_cast<ULONG32>(address + i * sizeof(ULONG32)));
        } else {
            sprintf_s(addrStr, "Argument/Local Var   -> 0x%08x", static_cast<ULONG32>(address + i * sizeof(ULONG32)));
        }

        // Format value
        char valStr[128];
        sprintf_s(valStr, "0x%08x", stackData[i]);

        // Try to get the symbol name for the value (only for eip)
        if (std::find(eipArray.begin(), eipArray.end(), stackData[i]) != eipArray.end()) {
            char symbolName[256];
            ULONG64 displacement = 0;
            hr = debugSymbols->GetNameByOffset(stackData[i], symbolName, sizeof(symbolName), nullptr, &displacement);

            if (SUCCEEDED(hr)) {
                sprintf_s(valStr + strlen(valStr), sizeof(valStr) - strlen(valStr), " | Symbol %s+0x%llx", symbolName,
                          displacement);
            }
        }

        entry.value = valStr;
        entry.address = addrStr;

        stackContents.push_back(entry);
    }

    return stackContents;
}

std::string parseArrayExpressionParameters(const std::string &expression, std::string &dataType, std::string &varName,
                                           size_t &numElements, char &format)
{
    // Determine data type prefix and variable name
    size_t start = 0;
    if (expression.find("by(") == 0) {
        dataType = "by";
        start = 3;
    } else if (expression.find("wo(") == 0) {
        dataType = "wo";
        start = 3;
    } else if (expression.find("dwo(") == 0) {
        dataType = "dwo";
        start = 4;
    } else {
        return "<Invalid data type prefix>";
    }

    // Find variable name within parentheses
    size_t end = expression.find(')', start);
    if (end == std::string::npos) {
        return "<Invalid format: missing closing parenthesis>";
    }
    varName = expression.substr(start, end - start);

    // Check for additional parameters after the closing parenthesis
    size_t paramStart = end + 1;
    if (paramStart < expression.size() && expression[paramStart] == ',') {
        // Parse the first optional parameter (count or format)
        paramStart++;
        while (paramStart < expression.size() && isspace(expression[paramStart]))
            paramStart++;

        if (isdigit(expression[paramStart])) {
            numElements = std::stoi(expression.substr(paramStart));
        } else if (expression[paramStart] == 'b' || expression[paramStart] == 'd' || expression[paramStart] == 'h' ||
                   expression[paramStart] == 'c' || expression[paramStart] == 'u') {
            format = expression[paramStart];
            paramStart++;
        } else {
            return "<Invalid parameter format>";
        }

        // Parse the second optional parameter (format) if present
        size_t nextComma = expression.find(',', paramStart);
        if (nextComma != std::string::npos) {
            paramStart = nextComma + 1;
            while (paramStart < expression.size() && isspace(expression[paramStart]))
                paramStart++;

            if (isdigit(expression[paramStart])) {
                numElements = std::stoi(expression.substr(paramStart));
            } else if (expression[paramStart] == 'b' || expression[paramStart] == 'd' ||
                       expression[paramStart] == 'h' || expression[paramStart] == 'c' ||
                       expression[paramStart] == 'u') {
                format = expression[paramStart];
                paramStart++;
            } else {
                return "<Invalid parameter format>";
            }
        }
    }

    return "";
}

std::string parseExpressionParameters(const std::string &expression, std::string &varName, char &format)
{
    format = 'h';

    // Find the position of the comma, which separates varname and format
    size_t commaPos = expression.find(',');
    if (commaPos == std::string::npos) {
        // No comma found, assume the whole expression is the variable name
        varName = expression;
        return ""; // Success with default format
    }

    // Extract the variable name (part before the comma)
    varName = expression.substr(0, commaPos);
    varName.erase(varName.find_last_not_of(" \t\n\r\f\v") + 1); // Trim trailing whitespace

    // Extract and validate the format type (part after the comma)
    size_t formatStart = commaPos + 1;
    while (formatStart < expression.size() && isspace(expression[formatStart])) {
        ++formatStart; // Skip leading whitespace after comma
    }

    if (formatStart < expression.size()) {
        char specifiedFormat = expression[formatStart];
        if (specifiedFormat == 'b' || specifiedFormat == 'd' || specifiedFormat == 'h' || specifiedFormat == 'c' ||
            specifiedFormat == 'u') {
            format = specifiedFormat; // Valid format specified
        } else {
            return "<Invalid format type>"; // Invalid format type specified
        }
    }

    return ""; // Indicate success by returning an empty string
}

std::string formatMemoryValue(size_t elementSize, const std::vector<uint8_t> &memoryData, int index, char format)
{
    char buffer[64];

    if (elementSize == 1) {
        uint8_t byteValue = memoryData[index];
        if (format == 'h') {
            sprintf_s(buffer, sizeof(buffer), "0x%02x", byteValue);
        } else if (format == 'd') {
            sprintf_s(buffer, sizeof(buffer), "%d", (int8_t)byteValue);
        } else if (format == 'u') {
            sprintf_s(buffer, sizeof(buffer), "%u", byteValue);
        } else if (format == 'b') {
            std::string binaryStr = std::bitset<8>(byteValue).to_string();
            binaryStr.insert(4, " "); // Group bits into nibbles (4 bits)
            sprintf_s(buffer, sizeof(buffer), "%s", binaryStr.c_str());
        } else if (format == 'c') {
            if (isprint(byteValue)) {
                sprintf_s(buffer, sizeof(buffer), "'%c'", byteValue);
            } else {
                sprintf_s(buffer, sizeof(buffer), "0x%02x", byteValue);
            }
        }
    } else if (elementSize == 2) {
        uint16_t wordValue = *reinterpret_cast<const uint16_t *>(&memoryData[index * 2]);
        if (format == 'h') {
            sprintf_s(buffer, sizeof(buffer), "0x%04x", wordValue);
        } else if (format == 'd') {
            sprintf_s(buffer, sizeof(buffer), "%d", (int16_t)wordValue);
        } else if (format == 'u') {
            sprintf_s(buffer, sizeof(buffer), "%u", wordValue);
        } else if (format == 'b') {
            std::string binaryStr = std::bitset<16>(wordValue).to_string();
            for (int j = 12; j > 0; j -= 4) { // Group bits into nibbles (4 bits)
                binaryStr.insert(j, " ");
            }
            sprintf_s(buffer, sizeof(buffer), "0b%s", binaryStr.c_str());
        }
    } else if (elementSize == 4) {
        uint32_t dwordValue = *reinterpret_cast<const uint32_t *>(&memoryData[index * 4]);
        if (format == 'h') {
            sprintf_s(buffer, sizeof(buffer), "0x%08x", dwordValue);
        } else if (format == 'd') {
            sprintf_s(buffer, sizeof(buffer), "%d", (int32_t)dwordValue);
        } else if (format == 'u') {
            sprintf_s(buffer, sizeof(buffer), "%u", dwordValue);
        } else if (format == 'b') {
            std::string binaryStr = std::bitset<32>(dwordValue).to_string();
            for (int j = 24; j > 0; j -= 8) { // Group bits into bytes (8 bits)
                binaryStr.insert(j, " ");
            }
            sprintf_s(buffer, sizeof(buffer), "0b%s", binaryStr.c_str());
        }
    } else {
        return "<Invalid data type>";
    }

    return std::string(buffer);
}

std::string Debugger::evaluateExpression(const std::string &expression)
{
    std::lock_guard<std::mutex> lock(debugMutex);
    HRESULT hr;
    hr = debugControl->Execute(DEBUG_OUTCTL_THIS_CLIENT, "n 10", DEBUG_EXECUTE_DEFAULT);
    hr = debugControl->SetExpressionSyntax(DEBUG_EXPR_MASM);

    std::string dataType, varName;
    size_t numElements = 0;
    char format = 0;

    std::string parseError = parseArrayExpressionParameters(expression, dataType, varName, numElements, format);

    if (parseError.empty()) {
        if (!format) {
            format = 'h';
        }
        bool printArray = true;
        if (!numElements) {
            numElements = 1;
            printArray = false;
        }

        size_t elementSize;
        if (dataType == "by") {
            elementSize = 1; // byte
        } else if (dataType == "wo") {
            elementSize = 2; // word (2 bytes)
        } else if (dataType == "dwo") {
            elementSize = 4; // double word (4 bytes)
        } else {
            return "<Invalid data type prefix>";
        }

        if (format == 'c' && dataType != "by") {
            return "<Char format (c) can only be applied to bytes (by)>";
        }

        DEBUG_VALUE baseValue;
        hr = debugControl->Evaluate(varName.c_str(), DEBUG_VALUE_INVALID, &baseValue, nullptr);

        if (FAILED(hr) || baseValue.Type != DEBUG_VALUE_INT64) {
            return "<Invalid base address for variable>";
        }
        ULONG64 baseAddress = baseValue.I64;

        std::vector<uint8_t> memoryData(numElements * elementSize);
        ULONG bytesRead = 0;
        hr = debugDataSpaces->ReadVirtual(baseAddress, memoryData.data(), static_cast<ULONG>(numElements * elementSize), &bytesRead);
        if (FAILED(hr) || bytesRead < numElements * elementSize) {
            return "<Failed to read memory>";
        }

        std::string result = "";
        if (printArray) {
            result = "{ ";
        }

        for (int i = 0; i < numElements; ++i) {
            result += formatMemoryValue(elementSize, memoryData, i, format);
            if (i < numElements - 1) {
                result += ", ";
            }
        }
        if (printArray) {
            result += " }";
        }
        return result;
    }

    parseError = parseExpressionParameters(expression, varName, format);
    if (parseError.empty()) {
        DEBUG_VALUE value = {};
        hr = debugControl->Evaluate(varName.c_str(), DEBUG_VALUE_INVALID, &value, nullptr);
        if (FAILED(hr)) {
            return "<Invalid expression>";
        }

        // if (format == 'c') {
        //     return "Char format (c) can't be applied";
        // }

        char buffer[128];
        if (format == 'h') {
            sprintf_s(buffer, sizeof(buffer), "0x%08x", value.I32);
        } else if (format == 'd') {
            sprintf_s(buffer, sizeof(buffer), "%d", (int)value.I32);
        } else if (format == 'u') {
            sprintf_s(buffer, sizeof(buffer), "%u", value.I32);
        } else if (format == 'b') {
            std::string binaryStr = std::bitset<32>(value.I32).to_string();
            for (int j = 24; j > 0; j -= 8) { // Group bits into bytes (8 bits)
                binaryStr.insert(j, " ");
            }
            sprintf_s(buffer, sizeof(buffer), "0b%s", binaryStr.c_str());
        } else if (format == 'c') {
            if (value.I8 == value.I32) {
                if (isprint(value.I8)) {
                    sprintf_s(buffer, sizeof(buffer), "'%c'", value.I8);
                } else {
                    sprintf_s(buffer, sizeof(buffer), "0x%02x", value.I8);
                }
            } else {
                sprintf_s(buffer, sizeof(buffer), "Value is outside of char range");
            }
        }
        std::string result = "";
        result += buffer;
        return result;
    }

    // Standard single expression evaluation if no special format is matched
    DEBUG_VALUE value = {};
    hr = debugControl->Evaluate(expression.c_str(), DEBUG_VALUE_INVALID, &value, nullptr);
    if (FAILED(hr)) {
        return "<Invalid expression>";
    }

    char buffer[128];
    if (value.Type == DEBUG_VALUE_INT64) {
        sprintf_s(buffer, sizeof(buffer), "0x%llx", value.I64);
    } else if (value.Type == DEBUG_VALUE_INT32) {
        sprintf_s(buffer, sizeof(buffer), "0x%lx", value.I32);
    } else {
        sprintf_s(buffer, sizeof(buffer), "<unsupported type>");
    }

    return buffer;
}

std::string Debugger::evaluateVariable(const std::string &variableName)
{
    std::lock_guard<std::mutex> lock(debugMutex);

    ULONG typeId;

    std::string result = "";

    // Get the address of the variable
    ULONG64 offset = 0;
    HRESULT hr = debugSymbols->GetOffsetByName(variableName.c_str(), &offset);
    if (SUCCEEDED(hr)) {
        // Add the address to the result string
        char addressStr[64];
        sprintf_s(addressStr, "Address: 0x%08x", static_cast<ULONG32>(offset));
        result += addressStr;

        // Determine the type size
        ULONG typeSize = 0;
        ULONG64 moduleBase;
        hr = debugSymbols->GetSymbolTypeId(variableName.c_str(), &typeId, &moduleBase);
        hr = debugSymbols->GetTypeSize(moduleBase, typeId, &typeSize);
        if (FAILED(hr) || typeSize == 0) {
            return result;
        }
        // Allocate a buffer to read the value
        std::vector<uint8_t> buffer(typeSize);
        ULONG bytesRead = 0;
        hr = debugDataSpaces->ReadVirtual(offset, buffer.data(), typeSize, &bytesRead);
        if (SUCCEEDED(hr) && bytesRead == typeSize) {
            char valueStr[128] = {};

            if (typeSize == sizeof(uint64_t)) {
                uint64_t value = *reinterpret_cast<uint64_t *>(buffer.data());
                sprintf_s(valueStr, "Value: 0x%016llx", value);
            } else if (typeSize == sizeof(uint32_t)) {
                uint32_t value = *reinterpret_cast<uint32_t *>(buffer.data());
                sprintf_s(valueStr, "Value: 0x%08x", value);
            } else if (typeSize == sizeof(uint16_t)) {
                uint16_t value = *reinterpret_cast<uint16_t *>(buffer.data());
                sprintf_s(valueStr, "Value: 0x%04x", value);
            } else if (typeSize == sizeof(uint8_t)) {
                uint8_t value = *reinterpret_cast<uint8_t *>(buffer.data());
                sprintf_s(valueStr, "Value: 0x%02x", value);
            } else {
                sprintf_s(valueStr, "Value: <unsupported type size>");
            }

            result += ", ";
            result += valueStr;
        } else {
            result += ", <Error reading memory>";
        }
        return result;
    }

    ULONG numRegisters = 0;
    hr = debugRegisters->GetNumberRegisters(&numRegisters);
    if (FAILED(hr)) {
        printf("GetNumberRegisters failed: 0x%08X\n", hr);
        return "<Error getting registers>";
    }

    std::map<std::string, ULONG> registerMap;
    for (ULONG i = 0; i < numRegisters; ++i) {
        char name[64];
        hr = debugRegisters->GetDescription(i, name, sizeof(name), nullptr, nullptr);
        if (SUCCEEDED(hr)) {
            std::string regName(name);
            std::transform(regName.begin(), regName.end(), regName.begin(), [](char c){ return static_cast<char>(::tolower(c));} );
            registerMap[regName] = i;
        }
    }

    std::string lowerRegisterName = variableName;
    std::transform(lowerRegisterName.begin(), lowerRegisterName.end(), lowerRegisterName.begin(),[](char c){ return static_cast<char>(::tolower(c));} );

    auto it = registerMap.find(lowerRegisterName);
    if (it != registerMap.end()) {
        DEBUG_VALUE value = {};
        hr = debugRegisters->GetValue(it->second, &value);
        if (SUCCEEDED(hr)) {
            char buffer[128];
            if (value.Type == DEBUG_VALUE_INT64) {
                sprintf_s(buffer, "0x%llx", value.I64);
            } else if (value.Type == DEBUG_VALUE_INT32) {
                sprintf_s(buffer, "0x%lx", value.I32);
            } else {
                sprintf_s(buffer, "<unsupported type>");
            }
            return buffer;
        } else {
            return "<Error getting register value>";
        }
    } else {
        return "";
    }
}

Debugger::ExceptionInfo Debugger::getExceptionInfo(dap::integer /*threadId*/)
{
    std::lock_guard<std::mutex> lock(debugMutex);
    ExceptionInfo info;

    info.exceptionId = "0x" + lastExceptionInfo.exceptionId;
    info.description = lastExceptionInfo.description;
    info.breakMode = "unhandled";

    dap::ExceptionDetails details;
    details.message = lastExceptionInfo.description;
    details.typeName = "Exception";
    details.fullTypeName = "Exception";
    details.evaluateName = "";
    details.stackTrace = "";

    info.details = details;

    return info;
}

void Debugger::exit()
{
    {
        std::lock_guard<std::mutex> lock(debugMutex);
        shouldExit = true;
        waitForEvent.fire();
        if (debugControl) {
            debugControl->SetInterrupt(DEBUG_INTERRUPT_ACTIVE);
        }
    }
}

void Debugger::eventLoop()
{
    HRESULT hr = S_OK;
    while (!shouldExit) {
        waitForEvent.wait();
        waitForEvent.reset();

        // if the debugger is already stopped WaitForEvent will wait for the next event
        if (shouldExit) {
            break;
        }

        hr = debugControl->WaitForEvent(0, INFINITE);
        ULONG eventType;
        ULONG processId, threadId;
        char description[256];
        ULONG descriptionUsed;
        EXCEPTION_RECORD64 exceptionRecord;

        debugControl->GetLastEventInformation(&eventType, &processId, &threadId, &exceptionRecord,
                                              sizeof(exceptionRecord), nullptr, description, sizeof(description),
                                              &descriptionUsed);

        eventsHandledCnt += 1;
        if (eventsHandledCnt == 1) {
            hasInitialized.fire();
        }

        if (eventType == DEBUG_EVENT_BREAKPOINT) {
            lastLineBreak = getCurrentLineNumber();
        }
        if (eventType == 0) {
            // stepped over or stepped in
            int currentLineNumber = getCurrentLineNumber();
            if (currentLineNumber == lastLineBreak) {
                hr = debugControl->SetExecutionStatus(DEBUG_STATUS_STEP_OVER);
                waitForEvent.fire();
            } else {
                onEvent(EventType::Stepped);
                lastLineBreak = currentLineNumber;
            }
        }

        if (hr == S_OK) {
            // Event handled in callbacks
        } else if (hr == S_FALSE) {
            // Wait timed out, continue processing
            continue;
        } else if (FAILED(hr)) {
            printf("WaitForEvent failed: 0x%08X\n", hr);
            break;
        }
    }
    hasExited.fire();
}

Debugger::MyDebugEventCallbacks::MyDebugEventCallbacks(Debugger *dbg, IDebugControl3 *debugControl)
    : m_refCount(1), debugger(dbg), debugControl(debugControl)
{
}

STDMETHODIMP Debugger::MyDebugEventCallbacks::QueryInterface(REFIID InterfaceId, PVOID *Interface)
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

STDMETHODIMP_(ULONG) Debugger::MyDebugEventCallbacks::AddRef() { return InterlockedIncrement(&m_refCount); }

STDMETHODIMP_(ULONG) Debugger::MyDebugEventCallbacks::Release()
{
    ULONG count = InterlockedDecrement(&m_refCount);
    if (count == 0)
        delete this;
    return count;
}

// IDebugEventCallbacks methods
STDMETHODIMP Debugger::MyDebugEventCallbacks::GetInterestMask(PULONG Mask)
{
    *Mask = DEBUG_EVENT_BREAKPOINT | DEBUG_EVENT_EXCEPTION | DEBUG_EVENT_EXIT_PROCESS;
    return S_OK;
}

STDMETHODIMP Debugger::MyDebugEventCallbacks::Breakpoint(PDEBUG_BREAKPOINT /*Bp*/)
{
    debugger->onEvent(EventType::BreakpointHit);
    return DEBUG_STATUS_BREAK;
}

STDMETHODIMP Debugger::MyDebugEventCallbacks::Exception(PEXCEPTION_RECORD64 Exception, ULONG /*FirstChance*/)
{
    ULONG eventType;
    ULONG processId, threadId;
    char description[256];
    ULONG descriptionUsed;
    EXCEPTION_RECORD64 exceptionRecord;

    debugControl->GetLastEventInformation(&eventType, &processId, &threadId, &exceptionRecord, sizeof(exceptionRecord),
                                          nullptr, description, sizeof(description), &descriptionUsed);

    // Store exception info
    debugger->lastExceptionInfo.exceptionId = std::to_string(Exception->ExceptionCode);
    debugger->lastExceptionInfo.description = description;
    if (Exception->ExceptionCode == DBG_CONTROL_C || Exception->ExceptionCode == STATUS_BREAKPOINT) {
        if (first1) {
            first1 = false;
        } else {
            debugger->onEvent(EventType::Paused);
        }
    } else if (Exception->ExceptionCode == STATUS_WX86_BREAKPOINT) {
        if (first2) {
            first2 = false;
        } else {
            debugger->onEvent(EventType::Exception);
        }
    } else {
        debugger->onEvent(EventType::Exception);
    }
    return DEBUG_STATUS_BREAK;
}

STDMETHODIMP Debugger::MyDebugEventCallbacks::ExitProcess(ULONG /*ExitCode*/)
{
    {
        std::lock_guard<std::mutex> lock(debugger->debugMutex);
        debugger->shouldExit = true;
    }
    debugger->onEvent(EventType::Exited);
    return DEBUG_STATUS_BREAK;
}

// Other event methods returning DEBUG_STATUS_NO_CHANGE
STDMETHODIMP Debugger::MyDebugEventCallbacks::CreateThread(ULONG64 /*Handle*/, ULONG64 /*DataOffset*/,
                                                           ULONG64 /*StartOffset*/)
{
    return DEBUG_STATUS_NO_CHANGE;
}

STDMETHODIMP Debugger::MyDebugEventCallbacks::ExitThread(ULONG /*ExitCode*/) { return DEBUG_STATUS_NO_CHANGE; }

STDMETHODIMP Debugger::MyDebugEventCallbacks::LoadModule(ULONG64 /*ImageFileHandle*/, ULONG64 /*BaseOffset*/,
                                                         ULONG /*ModuleSize*/, PCSTR /*ModuleName*/,
                                                         PCSTR /*ImageName*/, ULONG /*CheckSum*/,
                                                         ULONG /*TimeDateStamp*/)
{
    return DEBUG_STATUS_NO_CHANGE;
}

STDMETHODIMP Debugger::MyDebugEventCallbacks::UnloadModule(PCSTR /*ImageBaseName*/, ULONG64 /*BaseOffset*/)
{
    return DEBUG_STATUS_NO_CHANGE;
}

STDMETHODIMP Debugger::MyDebugEventCallbacks::SystemError(ULONG /*Error*/, ULONG /*Level*/)
{
    return DEBUG_STATUS_NO_CHANGE;
}

STDMETHODIMP Debugger::MyDebugEventCallbacks::SessionStatus(ULONG /*Status*/) { return DEBUG_STATUS_NO_CHANGE; }

STDMETHODIMP Debugger::MyDebugEventCallbacks::ChangeDebuggeeState(ULONG /*Flags*/, ULONG64 /*Argument*/)
{
    return DEBUG_STATUS_NO_CHANGE;
}

STDMETHODIMP Debugger::MyDebugEventCallbacks::ChangeEngineState(ULONG /*Flags*/, ULONG64 /*Argument*/)
{
    return DEBUG_STATUS_NO_CHANGE;
}

STDMETHODIMP Debugger::MyDebugEventCallbacks::ChangeSymbolState(ULONG /*Flags*/, ULONG64 /*Argument*/)
{
    return DEBUG_STATUS_NO_CHANGE;
}

STDMETHODIMP Debugger::MyDebugEventCallbacks::CreateProcess(ULONG64 /*ImageFileHandle*/, ULONG64 /*Handle*/,
                                                            ULONG64 /*BaseOffset*/, ULONG /*ModuleSize*/,
                                                            PCSTR /*ModuleName*/, PCSTR /*ImageName*/,
                                                            ULONG /*CheckSum*/, ULONG /*TimeDateStamp*/,
                                                            ULONG64 /*InitialThreadHandle*/,
                                                            ULONG64 /*ThreadDataOffset*/, ULONG64 /*StartOffset*/)
{
    return DEBUG_STATUS_NO_CHANGE;
}
