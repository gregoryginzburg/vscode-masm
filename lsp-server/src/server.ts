/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
    createConnection,
    TextDocuments,
    Diagnostic,
    DiagnosticSeverity,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    TextDocumentSyncKind,
    InitializeResult,
    DocumentDiagnosticReportKind,
    type DocumentDiagnosticReport,
    Hover,
    HoverParams,
    Position
} from 'vscode-languageserver/node';

import {
    TextDocument
} from 'vscode-languageserver-textdocument';

import { exec } from 'child_process';
import { URI } from 'vscode-uri';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;
let masmLintPath: string;

connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;

    // Does the client support the `workspace/configuration` request?
    // If not, we fall back using global settings.
    hasConfigurationCapability = !!(
        capabilities.workspace && !!capabilities.workspace.configuration
    );
    hasWorkspaceFolderCapability = !!(
        capabilities.workspace && !!capabilities.workspace.workspaceFolders
    );
    hasDiagnosticRelatedInformationCapability = !!(
        capabilities.textDocument &&
        capabilities.textDocument.publishDiagnostics &&
        capabilities.textDocument.publishDiagnostics.relatedInformation
    );
    if (params.initializationOptions && params.initializationOptions.masmLintExePath) {
        masmLintPath = params.initializationOptions.masmLintExePath;
    } else {
        masmLintPath = 'masmlint.exe'; // fallback
    }

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
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
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(_event => {
            connection.console.log('Workspace folder change event received.');
        });
    }
});

// The example settings
interface MasmServerSettings {
    secondaryLabelSeverity: 'information' | 'hint';
    enableDiagnostics: boolean;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: MasmServerSettings = {
    secondaryLabelSeverity: 'information',
    enableDiagnostics: true
};
// Global settings (used if the client does NOT support workspace/configuration)
let globalSettings: MasmServerSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings = new Map<string, Thenable<MasmServerSettings>>();

connection.onDidChangeConfiguration(change => {
    if (hasConfigurationCapability) {
        // Reset all cached document settings
        documentSettings.clear();
    } else {
        // Fallback: read from the changed settings or use defaults
        globalSettings = (change.settings.masmLanguageServer || defaultSettings);
    }
    // Refresh the diagnostics since the `maxNumberOfProblems` could have changed.
    // We could optimize things here and re-fetch the setting first can compare it
    // to the existing setting, but this is out of scope for this example.
    connection.languages.diagnostics.refresh();
});

function getDocumentSettings(resource: string): Thenable<MasmServerSettings> {
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

const directives = [
    { name: '.CODE', detail: 'Code segment directive', documentation: 'Specifies the beginning of a code segment.' },
    { name: '.DATA', detail: 'Data segment directive', documentation: 'Specifies the beginning of a data segment.' },
    { name: '.STACK', detail: 'Stack segment directive', documentation: 'Specifies the beginning of a stack segment.' },
    { name: 'DB', detail: 'Define Byte', documentation: 'Defines one or more bytes.' },
    { name: 'DW', detail: 'Define Word', documentation: 'Defines one or more words.' },
    { name: 'DD', detail: 'Define Doubleword', documentation: 'Defines one or more doublewords.' },
    { name: 'DQ', detail: 'Define Quadword', documentation: 'Defines one or more quadwords.' },
    { name: 'ELSE', detail: 'Else directive', documentation: 'Specifies an alternate block of code for conditional assembly.' },
    { name: 'ELSEIF', detail: 'Elseif directive', documentation: 'Specifies an alternate condition in conditional assembly.' },
    { name: 'END', detail: 'End directive', documentation: 'Marks the end of a file.' },
    { name: 'ENDIF', detail: 'Endif directive', documentation: 'Ends a conditional assembly block.' },
    { name: 'ENDM', detail: 'End macro', documentation: 'Ends a macro definition.' },
    { name: 'ENDP', detail: 'End procedure', documentation: 'Ends a procedure definition.' },
    { name: 'ENDS', detail: 'End structure', documentation: 'Ends a structure definition.' },
    { name: 'EQU', detail: 'Equate directive', documentation: 'Assigns a constant value to a symbol.' },
    { name: 'FOR', detail: 'For loop', documentation: 'Starts a for loop in assembly.' },
    { name: 'FORC', detail: 'For each character loop', documentation: 'Starts a loop iterating over characters.' },
    { name: 'IF', detail: 'If directive', documentation: 'Begins a conditional assembly block.' },
    { name: 'IFE', detail: 'If equal directive', documentation: 'Conditional assembly if equal.' },
    { name: 'IFB', detail: 'If binary directive', documentation: 'Conditional assembly for binary values.' },
    { name: 'IFNB', detail: 'If not binary directive', documentation: 'Conditional assembly for non-binary values.' },
    { name: 'IFDIF', detail: 'If different directive', documentation: 'Conditional assembly if different.' },
    { name: 'IFDIFI', detail: 'If difference immediate directive', documentation: 'Conditional assembly if immediate difference.' },
    { name: 'IFIDN', detail: 'If identical directive', documentation: 'Conditional assembly if identical.' },
    { name: 'IFIDNI', detail: 'If not identical directive', documentation: 'Conditional assembly if not identical.' },
    { name: 'LOCAL', detail: 'Local directive', documentation: 'Declares a local variable or label.' },
    { name: 'MACRO', detail: 'Macro definition', documentation: 'Starts a macro definition.' },
    { name: 'PROC', detail: 'Procedure definition', documentation: 'Starts a procedure definition.' },
    { name: 'STRUC', detail: 'Structure definition', documentation: 'Starts a structure definition.' },
    { name: 'RECORD', detail: 'Record definition', documentation: 'Starts a record definition.' },
    { name: 'REPEAT', detail: 'Repeat directive', documentation: 'Starts a repeat loop.' },
    { name: 'INCLUDE', detail: 'Include directive', documentation: 'Includes another file.' }
];

const operators = [
    { name: 'SHL', detail: 'Shift left operator', documentation: 'Shifts bits to the left.' },
    { name: 'SHR', detail: 'Shift right operator', documentation: 'Shifts bits to the right.' },
    { name: 'PTR', detail: 'Pointer operator', documentation: 'Specifies a pointer type.' },
    { name: 'TYPE', detail: 'Type operator', documentation: 'Specifies a type.' },
    { name: 'SIZE', detail: 'Size operator', documentation: 'Returns the size of a data type or structure.' },
    { name: 'SIZEOF', detail: 'Sizeof operator', documentation: 'Returns the size of a type or object.' },
    { name: 'LENGTH', detail: 'Length operator', documentation: 'Returns the length of a data structure.' },
    { name: 'LENGTHOF', detail: 'Lengthof operator', documentation: 'Returns the length of a type.' },
    { name: 'WIDTH', detail: 'Width operator', documentation: 'Returns the width of a type.' },
    { name: 'MASK', detail: 'Mask operator', documentation: 'Applies a bitmask.' },
    { name: 'OFFSET', detail: 'Offset operator', documentation: 'Returns the offset of a member within a structure.' },
    { name: 'DUP', detail: 'Duplicate operator', documentation: 'Duplicates a value or structure.' }
];

const types = [
    { name: 'BYTE', detail: '8-bit data type', documentation: 'Represents an 8-bit value.' },
    { name: 'WORD', detail: '16-bit data type', documentation: 'Represents a 16-bit value.' },
    { name: 'DWORD', detail: '32-bit data type', documentation: 'Represents a 32-bit value.' },
    { name: 'QWORD', detail: '64-bit data type', documentation: 'Represents a 64-bit value.' }
];


// Called when the client *pulls* for diagnostics
connection.languages.diagnostics.on(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (document !== undefined) {
        const settings = await getDocumentSettings(document.uri);

        if (!settings.enableDiagnostics) {
            return {
                kind: DocumentDiagnosticReportKind.Full,
                items: []
            } satisfies DocumentDiagnosticReport;
        }

        return {
            kind: DocumentDiagnosticReportKind.Full,
            items: await validateTextDocument(document)
        } satisfies DocumentDiagnosticReport;
    } else {
        // We don't know the document. We can either try to read it from disk
        // or we don't report problems for it.
        return {
            kind: DocumentDiagnosticReportKind.Full,
            items: []
        } satisfies DocumentDiagnosticReport;
    }
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
// documents.onDidChangeContent(change => {
//     validateTextDocument(change.document);
// });

async function validateTextDocument(textDocument: TextDocument): Promise<Diagnostic[]> {
    const settings = await getDocumentSettings(textDocument.uri);

    if (!settings.enableDiagnostics) {
        return [];
    }

    // Our “secondary labels” can be either Information or Hint
    const secondarySeverity =
        settings.secondaryLabelSeverity === 'hint'
            ? DiagnosticSeverity.Hint
            : DiagnosticSeverity.Information;

    const filePath = URI.parse(textDocument.uri).fsPath;
    return new Promise<Diagnostic[]>((resolve) => {
        const diagnostics: Diagnostic[] = [];

        // Adjust the path to your masmlint tool if needed
        const childProcess = exec(
            `"${masmLintPath}" --json --stdin "${filePath}"`,
            (error, stdout, stderr) => {
                if (error) {
                    console.error(`Error executing linter: ${error}`);
                    // Return whatever we have so far (possibly empty)
                    return resolve(diagnostics);
                }

                try {
                    const output = JSON.parse(stdout);

                    for (const diag of output) {
                        // Convert primary severity
                        const diagnostic: Diagnostic = {
                            severity:
                                diag.severity === 'Error'
                                    ? DiagnosticSeverity.Error
                                    : diag.severity === 'Warning'
                                        ? DiagnosticSeverity.Warning
                                        : DiagnosticSeverity.Information,
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
                            source: '',
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
                            const relatedInfoDiagnostic: Diagnostic = {
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
                } catch (e) {
                    console.error(`Error parsing JSON output: ${e}`);
                    console.error(`Stdout: ${stdout}`);
                    console.error(`Stderr: ${stderr}`);
                }

                resolve(diagnostics);
            }
        );

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
connection.onCompletion(
    (_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
        // Combine instructions + registers into a single list
        const instrCompletions: CompletionItem[] = instructions.map(instr => ({
            label: instr.name,
            kind: CompletionItemKind.Keyword,
            documentation: instr.documentation
        }));
        const registerCompletions: CompletionItem[] = registers.map(reg => ({
            label: reg.name,
            kind: CompletionItemKind.Variable,
            documentation: reg.documentation
        }));
        const directiveCompletions: CompletionItem[] = directives.map(dir => ({
            label: dir.name,
            kind: CompletionItemKind.Keyword,
            documentation: dir.documentation
        }));
        const operatorCompletions: CompletionItem[] = operators.map(op => ({
            label: op.name,
            kind: CompletionItemKind.Operator,
            documentation: op.documentation
        }));
        const typeCompletions: CompletionItem[] = types.map(typ => ({
            label: typ.name,
            kind: CompletionItemKind.TypeParameter,
            documentation: typ.documentation
        }));

        return instrCompletions.concat(registerCompletions, directiveCompletions, operatorCompletions, typeCompletions);
    }
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
    (item: CompletionItem): CompletionItem => {
        return item;
    }
);


// -------------------------- Hover Provider --------------------------

connection.onHover((params: HoverParams): Hover | null => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return null;
    }

    const word = getWordAtPosition(document, params.position);
    if (!word) {
        return null;
    }

    const found = [...instructions, ...registers, ...directives, ...operators, ...types].find(
        (entry) => entry.name.toUpperCase() === word.toUpperCase()
    );

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
// Helper: extract word at the given position
function getWordAtPosition(document: TextDocument, position: Position): string | null {
    const text = document.getText();
    const offset = document.offsetAt(position);
    // Include `.` for .CODE and .DATA
    const pattern = /[\w\.]+/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (start <= offset && offset <= end) {
            return match[0];
        }
    }
    return null;
}

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();