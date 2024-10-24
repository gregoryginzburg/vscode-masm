const {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    CompletionItemKind,
    DiagnosticSeverity
} = require('vscode-languageserver/node');
const { TextDocument } = require('vscode-languageserver-textdocument');

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
    { name: 'POP', detail: 'Pop from Stack', documentation: 'Pops operand from the stack.' }
];

const registers = [
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

// Listen to document events
documents.listen(connection);
connection.listen();
