const {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    CompletionItemKind,
    DiagnosticSeverity
} = require('vscode-languageserver/node');
const { TextDocument } = require('vscode-languageserver-textdocument');
const { exec } = require('child_process');
const { URI } = require('vscode-uri')

// Create a connection for the server
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager
const documents = new TextDocuments(TextDocument);

// MASM Instructions and Registers
const instructions = [
    { name: 'MOV', detail: 'Move data', documentation: 'Moves data from source to destination.' },
    { name: 'ADD', detail: 'Addition', documentation: 'Adds source to destination.' },
    { name: 'SUB', detail: 'Subtraction', documentation: 'Subtracts source from destination.' },
    { name: 'MUL', detail: 'Multiplication', documentation: 'Multiplies unsigned integers.' },
    { name: 'DIV', detail: 'Division', documentation: 'Divides unsigned integers.' },
    { name: 'INC', detail: 'Increment', documentation: 'Increments operand by 1.' },
    { name: 'DEC', detail: 'Decrement', documentation: 'Decrements operand by 1.' },
    { name: 'CMP', detail: 'Compare', documentation: 'Compares two operands.' },
    { name: 'JMP', detail: 'Jump', documentation: 'Unconditional jump to a label.' },
    { name: 'JE', detail: 'Jump if Equal', documentation: 'Jump if zero flag is set.' },
    { name: 'CALL', detail: 'Call Procedure', documentation: 'Calls a procedure.' },
    { name: 'RET', detail: 'Return', documentation: 'Returns from a procedure.' },
    { name: 'PUSH', detail: 'Push onto Stack', documentation: 'Pushes operand onto the stack.' },
    { name: 'POP', detail: 'Pop from Stack', documentation: 'Pops operand from the stack.' },
    { name: 'JGE', detail: 'Jump if Greater or Equal', documentation: 'Jump if the destination is greater than or equal to the source.' },
    { name: 'NEG', detail: 'Negate', documentation: 'Negates the operand (two’s complement).' }
];

const registers = [
    // ```masm\nmov eax, ebx\n``` - syntax highlthing works here
    { name: 'EAX', detail: 'Accumulator Register', documentation: 'General-purpose accumulator register.\n' },
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

// Initialize the server
connection.onInitialize(() => {
    return {
        capabilities: {
            textDocumentSync: documents.syncKind,
            hoverProvider: true,
            completionProvider: {
                resolveProvider: true
            }
        }
    };
});

// Handle completion requests
connection.onCompletion(() => {
    return instructions.map(instr => ({
        label: instr.name,
        kind: CompletionItemKind.Keyword,
        documentation: instr.documentation
    })).concat(
        registers.map(reg => ({
            label: reg.name,
            kind: CompletionItemKind.Variable,
            documentation: reg.documentation
        }))
    );
});

// Provide hover information
connection.onHover(({ textDocument, position }) => {
    const document = documents.get(textDocument.uri);
    if (!document) {
        return null;
    }

    const word = getWordAtPosition(document, position);
    if (word) {
        const item = [...instructions, ...registers].find(i => i.name === word.toUpperCase());
        if (item) {
            return {
                contents: { kind: 'markdown', value: `**${item.name}**\n\n${item.documentation}` }
            };
        }
    }
    return null;
});

// Handle completion item resolve requests
connection.onCompletionResolve((item) => {
    return item; // Return the item as is for now; you can extend this later if needed.
});

// Helper function to get the word at a given position
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

    return start === end ? null : text.substring(start, end);
}


function validateTextDocument(textDocument) {
    const filePath = URI.parse(textDocument.uri).fsPath
    // TODO: change location is release
    const childProcess = exec(`C:\\Users\\grigo\\Documents\\MasmLint\\bin\\masmlint_dbg.exe  --json --stdin "${filePath}"`, (error, stdout, stderr) => {
        let diagnostics = [];

        if (error) {
            console.error(`Error executing linter: ${error}`);
            return;
        }

        try {
            const output = JSON.parse(stdout);

            for (const diag of output) {
                const diagnostic = {
                    severity: diag.severity === 'Error' ? DiagnosticSeverity.Error :
                        diag.severity === 'Warning' ? DiagnosticSeverity.Warning :
                            DiagnosticSeverity.Information,
                    range: {
                        start: { line: diag.primaryLabel.span.start.line, character: diag.primaryLabel.span.start.character },
                        end: { line: diag.primaryLabel.span.end.line, character: diag.primaryLabel.span.end.character }
                    },
                    message: diag.message,
                    source: '',
                    relatedInformation: []
                };

                // Append primary label message if it exists
                if (diag.primaryLabel.message && diag.primaryLabel.message !== '') {
                    diagnostic.message += `\n${diag.primaryLabel.message}`;
                }

                // append note message if it exists
                if (diag.note_message && diag.note_message !== '') {
                    diagnostic.message += `\nnote: ${diag.note_message}`;
                }

                // Handle secondary labels
                for (const secondaryLabel of diag.secondaryLabels) {
                    const relatedInfoDiagnostic = {
                        severity: DiagnosticSeverity.Information,
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
                        source: '',
                        relatedInformation: [{
                            location: {
                                uri: textDocument.uri, // TODO: fix this to work in several files
                                range: diagnostic.range
                            },
                            message: "original error"
                        }]
                    };

                    diagnostics.push(relatedInfoDiagnostic);

                    const relatedInfo = {
                        location: {
                            uri: textDocument.uri, // TODO: fix this to work in several files
                            range: {
                                start: {
                                    line: secondaryLabel.span.start.line,
                                    character: secondaryLabel.span.start.character
                                },
                                end: {
                                    line: secondaryLabel.span.end.line,
                                    character: secondaryLabel.span.end.character
                                }
                            }
                        },
                        message: secondaryLabel.message
                    };
                    diagnostic.relatedInformation.push(relatedInfo);
                }

                diagnostics.push(diagnostic);
            }
        } catch (e) {
            console.error(`Error parsing JSON output: ${e}`);
            console.error(`Stdout: ${stdout}`);
            console.error(`Stderr: ${stderr}`);
            return;
        }

        connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
    });

    // Write the document content to stdin
    childProcess.stdin.write(textDocument.getText());
    childProcess.stdin.end();
}


//     // Write the document content to stdin
//     childProcess.stdin.write(textDocument.getText());
//     childProcess.stdin.end();

//     // const text = textDocument.getText();
//     // const lines = text.split(/\r?\n/g);
//     // for (let i = 0; i < lines.length; i++) {
//     //     const line = lines[i];
//     //     const index = line.indexOf('.DATA');
//     //     if (index >= 0) {
//     //         const diagnostic = {
//     //             severity: DiagnosticSeverity.Error,
//     //             range: {
//     //                 start: { line: i, character: index },
//     //                 end: { line: i, character: index + 5 }
//     //             },
//     //             message: "Mock error: Found the word 'error'",
//     //             source: 'Mock Linter'
//     //         };
//     //         diagnostics.push(diagnostic);
//     //     }
//     // }
//     // // console.log(diagnostics);
//     // connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });


// Listen for document changes to trigger validation
documents.onDidChangeContent(change => {
    validateTextDocument(change.document);
});

// Also validate documents when they are first opened
documents.onDidOpen(event => {
    validateTextDocument(event.document);
});

// Handle the custom request from the client to run code analysis
connection.onRequest('custom/runCodeAnalysis', (params) => {
    const uri = params.uri;
    const document = documents.get(uri);
    if (document) {
        validateTextDocument(document);
    }
});

// Listen to document events
documents.listen(connection);
connection.listen();
