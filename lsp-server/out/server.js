"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
const node_1 = require("vscode-languageserver/node");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
const child_process_1 = require("child_process");
const vscode_uri_1 = require("vscode-uri");
// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = (0, node_1.createConnection)(node_1.ProposedFeatures.all);
// Create a simple text document manager.
const documents = new node_1.TextDocuments(vscode_languageserver_textdocument_1.TextDocument);
let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;
let masmLintPath;
connection.onInitialize((params) => {
    const capabilities = params.capabilities;
    // Does the client support the `workspace/configuration` request?
    // If not, we fall back using global settings.
    hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration);
    hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders);
    hasDiagnosticRelatedInformationCapability = !!(capabilities.textDocument &&
        capabilities.textDocument.publishDiagnostics &&
        capabilities.textDocument.publishDiagnostics.relatedInformation);
    if (params.initializationOptions && params.initializationOptions.masmLintExePath) {
        masmLintPath = params.initializationOptions.masmLintExePath;
    }
    else {
        masmLintPath = 'masmlint.exe'; // fallback
    }
    const result = {
        capabilities: {
            textDocumentSync: node_1.TextDocumentSyncKind.Incremental,
            // Tell the client that this server supports code completion.
            completionProvider: {
                resolveProvider: true
            },
            hoverProvider: true,
            diagnosticProvider: {
                interFileDependencies: false,
                workspaceDiagnostics: false
            }
        }
    };
    if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
            workspaceFolders: {
                supported: true
            }
        };
    }
    return result;
});
connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        // Register for all configuration changes.
        connection.client.register(node_1.DidChangeConfigurationNotification.type, undefined);
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(_event => {
            connection.console.log('Workspace folder change event received.');
        });
    }
});
// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings = {
    secondaryLabelSeverity: 'information',
    enableDiagnostics: true
};
// Global settings (used if the client does NOT support workspace/configuration)
let globalSettings = defaultSettings;
// Cache the settings of all open documents
const documentSettings = new Map();
connection.onDidChangeConfiguration(change => {
    if (hasConfigurationCapability) {
        // Reset all cached document settings
        documentSettings.clear();
    }
    else {
        // Fallback: read from the changed settings or use defaults
        globalSettings = (change.settings.masmLanguageServer || defaultSettings);
    }
    // Refresh the diagnostics since the `maxNumberOfProblems` could have changed.
    // We could optimize things here and re-fetch the setting first can compare it
    // to the existing setting, but this is out of scope for this example.
    connection.languages.diagnostics.refresh();
});
function getDocumentSettings(resource) {
    if (!hasConfigurationCapability) {
        return Promise.resolve(globalSettings);
    }
    let result = documentSettings.get(resource);
    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: resource,
            section: 'masmLanguageServer'
        });
        documentSettings.set(resource, result);
    }
    return result;
}
// Only keep settings for open documents
documents.onDidClose(e => {
    documentSettings.delete(e.document.uri);
});
// -------------------------- MASM data for completion & hover --------------------------
const instructions = [
    { name: 'ADC', detail: 'Add with Carry', documentation: 'Adds the source operand and the carry flag to the destination operand.' },
    { name: 'ADD', detail: 'Addition', documentation: 'Adds source to destination.' },
    { name: 'AND', detail: 'Logical AND', documentation: 'Performs a bitwise AND operation between source and destination.' },
    { name: 'CALL', detail: 'Call Procedure', documentation: 'Calls a procedure.' },
    { name: 'CBW', detail: 'Convert Byte to Word', documentation: 'Converts a signed byte to a signed word.' },
    { name: 'CDQ', detail: 'Convert Double to Quad', documentation: 'Converts a signed doubleword to a signed quadword.' },
    { name: 'CMP', detail: 'Compare', documentation: 'Compares two operands.' },
    { name: 'CWD', detail: 'Convert Word to Doubleword', documentation: 'Converts a signed word to a signed doubleword.' },
    { name: 'DEC', detail: 'Decrement', documentation: 'Decrements operand by 1.' },
    { name: 'DIV', detail: 'Unsigned Division', documentation: 'Divides unsigned integers.' },
    { name: 'IDIV', detail: 'Signed Division', documentation: 'Divides signed integers.' },
    { name: 'IMUL', detail: 'Signed Multiplication', documentation: 'Multiplies signed integers.' },
    { name: 'INC', detail: 'Increment', documentation: 'Increments operand by 1.' },
    { name: 'JA', detail: 'Jump if Above', documentation: 'Jump if the destination is strictly greater than the source (unsigned comparison).' },
    { name: 'JAE', detail: 'Jump if Above or Equal', documentation: 'Jump if the destination is greater than or equal to the source (unsigned comparison).' },
    { name: 'JB', detail: 'Jump if Below', documentation: 'Jump if the destination is strictly less than the source (unsigned comparison).' },
    { name: 'JBE', detail: 'Jump if Below or Equal', documentation: 'Jump if the destination is less than or equal to the source (unsigned comparison).' },
    { name: 'JC', detail: 'Jump if Carry', documentation: 'Jump if the carry flag is set.' },
    { name: 'JE', detail: 'Jump if Equal', documentation: 'Jump if zero flag is set.' },
    { name: 'JECXZ', detail: 'Jump if ECX is Zero', documentation: 'Jump if ECX register equals zero.' },
    { name: 'JG', detail: 'Jump if Greater', documentation: 'Jump if the destination is strictly greater than the source (signed comparison).' },
    { name: 'JGE', detail: 'Jump if Greater or Equal', documentation: 'Jump if the destination is greater than or equal to the source (signed comparison).' },
    { name: 'JL', detail: 'Jump if Less', documentation: 'Jump if the destination is strictly less than the source (signed comparison).' },
    { name: 'JLE', detail: 'Jump if Less or Equal', documentation: 'Jump if the destination is less than or equal to the source (signed comparison).' },
    { name: 'JMP', detail: 'Jump', documentation: 'Unconditional jump to a label.' },
    { name: 'JNC', detail: 'Jump if No Carry', documentation: 'Jump if the carry flag is not set.' },
    { name: 'JNE', detail: 'Jump if Not Equal', documentation: 'Jump if zero flag is not set.' },
    { name: 'JNZ', detail: 'Jump if Not Zero', documentation: 'Jump if zero flag is not set.' },
    { name: 'JZ', detail: 'Jump if Zero', documentation: 'Jump if zero flag is set.' },
    { name: 'LEA', detail: 'Load Effective Address', documentation: 'Loads the effective address of the source operand into the destination.' },
    { name: 'LOOP', detail: 'Loop', documentation: 'Decrements ECX and jumps if ECX is not zero.' },
    { name: 'MOV', detail: 'Move', documentation: 'Moves data from source to destination.' },
    { name: 'MOVSX', detail: 'Move with Sign Extension', documentation: 'Moves data with sign extension from source to destination.' },
    { name: 'MOVZX', detail: 'Move with Zero Extension', documentation: 'Moves data with zero extension from source to destination.' },
    { name: 'MUL', detail: 'Multiplication', documentation: 'Multiplies unsigned integers.' },
    { name: 'NEG', detail: 'Negate', documentation: 'Negates the operand (two’s complement).' },
    { name: 'NOT', detail: 'Bitwise NOT', documentation: 'Inverts all the bits in the operand.' },
    { name: 'OR', detail: 'Logical OR', documentation: 'Performs a bitwise OR operation between source and destination.' },
    { name: 'POP', detail: 'Pop from Stack', documentation: 'Pops operand from the stack.' },
    { name: 'POPFD', detail: 'Pop Flags', documentation: 'Pops the top of the stack into the EFLAGS register.' },
    { name: 'PUSH', detail: 'Push onto Stack', documentation: 'Pushes operand onto the stack.' },
    { name: 'PUSHFD', detail: 'Push Flags', documentation: 'Pushes the EFLAGS register onto the stack.' },
    { name: 'RCL', detail: 'Rotate through Carry Left', documentation: 'Rotates bits to the left through the carry flag.' },
    { name: 'RCR', detail: 'Rotate through Carry Right', documentation: 'Rotates bits to the right through the carry flag.' },
    { name: 'RET', detail: 'Return', documentation: 'Returns from a procedure.' },
    { name: 'ROL', detail: 'Rotate Left', documentation: 'Rotates bits to the left.' },
    { name: 'ROR', detail: 'Rotate Right', documentation: 'Rotates bits to the right.' },
    { name: 'SBB', detail: 'Subtract with Borrow', documentation: 'Subtracts source and the carry flag from the destination.' },
    { name: 'SHL', detail: 'Shift Left', documentation: 'Shifts bits to the left.' },
    { name: 'SHR', detail: 'Shift Right', documentation: 'Shifts bits to the right.' },
    { name: 'SUB', detail: 'Subtraction', documentation: 'Subtracts source from destination.' },
    { name: 'TEST', detail: 'Logical Compare', documentation: 'Performs a bitwise AND operation between two operands, updating flags but not storing the result.' },
    { name: 'XCHG', detail: 'Exchange', documentation: 'Exchanges the values of the source and destination operands.' },
    { name: 'XOR', detail: 'Logical Exclusive OR', documentation: 'Performs a bitwise XOR operation between source and destination.' },
    { name: 'INCHAR', detail: 'Input Character', documentation: 'Reads a character from input.' },
    { name: 'ININT', detail: 'Input Integer', documentation: 'Reads an integer from input.' },
    { name: 'EXIT', detail: 'Exit Program', documentation: 'Terminates the program.' },
    { name: 'OUTI', detail: 'Output Integer', documentation: 'Outputs an integer to the console.' },
    { name: 'OUTU', detail: 'Output Unsigned Integer', documentation: 'Outputs an unsigned integer to the console.' },
    { name: 'OUTSTR', detail: 'Output String', documentation: 'Outputs a string to the console.' },
    { name: 'OUTCHAR', detail: 'Output Character', documentation: 'Outputs a character to the console.' },
    { name: 'NEWLINE', detail: 'New Line', documentation: 'Prints a newline character.' }
];
const registers = [
    // ```masm\nmov eax, ebx\n``` - syntax highlthing works here
    { name: 'EAX', detail: 'Accumulator Register', documentation: 'General-purpose accumulator register.' },
    { name: 'EBX', detail: 'Base Register', documentation: 'General-purpose base register.' },
    { name: 'ECX', detail: 'Counter Register', documentation: 'General-purpose counter register.' },
    { name: 'EDX', detail: 'Data Register', documentation: 'General-purpose data register.' },
    { name: 'EAX', detail: 'Accumulator Register', documentation: 'General-purpose accumulator register.' },
    { name: 'EBX', detail: 'Base Register', documentation: 'General-purpose base register.' },
    { name: 'ECX', detail: 'Counter Register', documentation: 'General-purpose counter register.' },
    { name: 'EDX', detail: 'Data Register', documentation: 'General-purpose data register.' },
    { name: 'ESI', detail: 'Source Index', documentation: 'Source index for string operations.' },
    { name: 'EDI', detail: 'Destination Index', documentation: 'Destination index for string operations.' },
    { name: 'EBP', detail: 'Base Pointer', documentation: 'Pointer to base of the stack.' },
    { name: 'ESP', detail: 'Stack Pointer', documentation: 'Pointer to top of the stack.' },
    { name: 'AX', detail: '16-bit Accumulator', documentation: 'Lower 16 bits of EAX.' },
    { name: 'BX', detail: '16-bit Base Register', documentation: 'Lower 16 bits of EBX.' },
    { name: 'CX', detail: '16-bit Counter', documentation: 'Lower 16 bits of ECX.' },
    { name: 'DX', detail: '16-bit Data Register', documentation: 'Lower 16 bits of EDX.' },
    { name: 'SI', detail: 'Source Index', documentation: '16-bit version of ESI.' },
    { name: 'DI', detail: 'Destination Index', documentation: '16-bit version of EDI.' },
    { name: 'BP', detail: 'Base Pointer', documentation: '16-bit version of EBP.' },
    { name: 'SP', detail: 'Stack Pointer', documentation: '16-bit version of ESP.' },
    { name: 'AL', detail: 'Lower 8 bits of EAX', documentation: '8-bit version of EAX (low byte).' },
    { name: 'BL', detail: 'Lower 8 bits of EBX', documentation: '8-bit version of EBX (low byte).' },
    { name: 'CL', detail: 'Lower 8 bits of ECX', documentation: '8-bit version of ECX (low byte).' },
    { name: 'DL', detail: 'Lower 8 bits of EDX', documentation: '8-bit version of EDX (low byte).' },
    { name: 'AH', detail: 'Higher 8 bits of EAX', documentation: '8-bit version of EAX (high byte).' },
    { name: 'BH', detail: 'Higher 8 bits of EBX', documentation: '8-bit version of EBX (high byte).' },
    { name: 'CH', detail: 'Higher 8 bits of ECX', documentation: '8-bit version of ECX (high byte).' },
    { name: 'DH', detail: 'Higher 8 bits of EDX', documentation: '8-bit version of EDX (high byte).' },
    { name: 'CS', detail: 'Code Segment', documentation: 'Code segment register.' },
    { name: 'DS', detail: 'Data Segment', documentation: 'Data segment register.' },
    { name: 'ES', detail: 'Extra Segment', documentation: 'Extra segment register.' },
    { name: 'FS', detail: 'FS Segment', documentation: 'FS segment register.' },
    { name: 'GS', detail: 'GS Segment', documentation: 'GS segment register.' },
    { name: 'SS', detail: 'Stack Segment', documentation: 'Stack segment register.' }
];
// Called when the client *pulls* for diagnostics
connection.languages.diagnostics.on(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (document !== undefined) {
        const settings = await getDocumentSettings(document.uri);
        if (!settings.enableDiagnostics) {
            return {
                kind: node_1.DocumentDiagnosticReportKind.Full,
                items: []
            };
        }
        return {
            kind: node_1.DocumentDiagnosticReportKind.Full,
            items: await validateTextDocument(document)
        };
    }
    else {
        // We don't know the document. We can either try to read it from disk
        // or we don't report problems for it.
        return {
            kind: node_1.DocumentDiagnosticReportKind.Full,
            items: []
        };
    }
});
// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
    validateTextDocument(change.document);
});
async function validateTextDocument(textDocument) {
    const settings = await getDocumentSettings(textDocument.uri);
    if (!settings.enableDiagnostics) {
        return [];
    }
    // Our “secondary labels” can be either Information or Hint
    const secondarySeverity = settings.secondaryLabelSeverity === 'hint'
        ? node_1.DiagnosticSeverity.Hint
        : node_1.DiagnosticSeverity.Information;
    const filePath = vscode_uri_1.URI.parse(textDocument.uri).fsPath;
    return new Promise((resolve) => {
        const diagnostics = [];
        // Adjust the path to your masmlint tool if needed
        const childProcess = (0, child_process_1.exec)(`"${masmLintPath}" --json --stdin "${filePath}"`, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error executing linter: ${error}`);
                // Return whatever we have so far (possibly empty)
                return resolve(diagnostics);
            }
            try {
                const output = JSON.parse(stdout);
                for (const diag of output) {
                    // Convert primary severity
                    const diagnostic = {
                        severity: diag.severity === 'Error'
                            ? node_1.DiagnosticSeverity.Error
                            : diag.severity === 'Warning'
                                ? node_1.DiagnosticSeverity.Warning
                                : node_1.DiagnosticSeverity.Information,
                        range: {
                            start: {
                                line: diag.primaryLabel.span.start.line,
                                character: diag.primaryLabel.span.start.character
                            },
                            end: {
                                line: diag.primaryLabel.span.end.line,
                                character: diag.primaryLabel.span.end.character
                            }
                        },
                        message: diag.message,
                        source: 'masmlint',
                        relatedInformation: []
                    };
                    // Append primary label message if it exists
                    if (diag.primaryLabel.message) {
                        diagnostic.message += `\n${diag.primaryLabel.message}`;
                    }
                    // Append note if it exists
                    if (diag.note_message) {
                        diagnostic.message += `\nnote: ${diag.note_message}`;
                    }
                    // Handle secondary labels
                    for (const secondaryLabel of diag.secondaryLabels) {
                        const relatedInfoDiagnostic = {
                            severity: secondarySeverity,
                            range: {
                                start: {
                                    line: secondaryLabel.span.start.line,
                                    character: secondaryLabel.span.start.character
                                },
                                end: {
                                    line: secondaryLabel.span.end.line,
                                    character: secondaryLabel.span.end.character
                                }
                            },
                            message: secondaryLabel.message,
                            source: 'masmlint',
                            relatedInformation: [
                                {
                                    location: {
                                        uri: textDocument.uri,
                                        range: diagnostic.range
                                    },
                                    message: 'Original error'
                                }
                            ]
                        };
                        diagnostics.push(relatedInfoDiagnostic);
                        // Also attach related info to the primary diagnostic
                        diagnostic.relatedInformation?.push({
                            location: {
                                uri: textDocument.uri,
                                range: relatedInfoDiagnostic.range
                            },
                            message: secondaryLabel.message
                        });
                    }
                    diagnostics.push(diagnostic);
                }
            }
            catch (e) {
                console.error(`Error parsing JSON output: ${e}`);
                console.error(`Stdout: ${stdout}`);
                console.error(`Stderr: ${stderr}`);
            }
            resolve(diagnostics);
        });
        // Send the document text to the linter via stdin
        if (childProcess.stdin) {
            childProcess.stdin.write(textDocument.getText());
            childProcess.stdin.end();
        }
    });
}
connection.onDidChangeWatchedFiles(_change => {
    // Monitored files have change in VSCode
    connection.console.log('We received a file change event');
});
// This handler provides the initial list of the completion items.
connection.onCompletion((_textDocumentPosition) => {
    // Combine instructions + registers into a single list
    const instrCompletions = instructions.map(instr => ({
        label: instr.name,
        kind: node_1.CompletionItemKind.Keyword,
        documentation: instr.documentation
    }));
    const registerCompletions = registers.map(reg => ({
        label: reg.name,
        kind: node_1.CompletionItemKind.Variable,
        documentation: reg.documentation
    }));
    return instrCompletions.concat(registerCompletions);
});
// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item) => {
    return item;
});
// -------------------------- Hover Provider --------------------------
connection.onHover((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return null;
    }
    const word = getWordAtPosition(document, params.position);
    if (!word) {
        return null;
    }
    const found = [...instructions, ...registers].find((entry) => entry.name.toUpperCase() === word.toUpperCase());
    if (!found) {
        return null;
    }
    return {
        contents: {
            kind: 'markdown',
            value: `**${found.name}**\n\n${found.documentation}`
        }
    };
});
// Helper: extract word at cursor
function getWordAtPosition(document, position) {
    const text = document.getText();
    const offset = document.offsetAt(position);
    let start = offset;
    let end = offset;
    while (start > 0 && /\w/.test(text.charAt(start - 1))) {
        start--;
    }
    while (end < text.length && /\w/.test(text.charAt(end))) {
        end++;
    }
    if (start === end) {
        return null;
    }
    return text.substring(start, end);
}
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);
// Listen on the connection
connection.listen();
//# sourceMappingURL=server.js.map