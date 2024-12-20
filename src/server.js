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
// add more details?
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

// Listen to document events
documents.listen(connection);
connection.listen();
