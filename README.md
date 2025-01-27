# MASM Language VSCode Support

MASM Language VSCode Support provides syntax highlighting, IntelliSense, debugging, and build automation for the Microsoft Macro Assembler (MASM) in Visual Studio Code.

> [!NOTE]
> **Extension in Development**  
> This MASM Language VSCode Support extension is currently under development and provides a limited feature set. Please note the following constraints:  
> - **Directives**: Only a small subset of basic MASM directives are supported.  
> - **Preprocessor**: Features like macros and `include` files are not yet implemented.  
> - **Instructions**: The linter supports only a limited set of MASM instructions at this time.  


## Features

- **Syntax Highlighting**: Adds rich syntax highlighting for MASM `.asm` and `.masm` files.
- **Code Completion**: Provides IntelliSense for MASM instructions and registers.
- **Hover Documentation**: Displays detailed information about MASM instructions and registers on hover.
- **Diagnostics**: Identifies and highlights errors or warnings in your assembly code.
- **Build and Run**: Compile and run MASM programs directly from the editor.
- **Debugging**: Includes a built-in debugger for running MASM programs with breakpoints.


### **Syntax Highlighting and IntelliSense**
![Syntax Highlighting and IntelliSense](/assets/syntax-highlighting-intelliSense.gif)


### **Diagnostics**
![Diagnostics](/assets/diagnostics.gif)


### **Debugging**
![Debugging](/assets/debugging.gif)


## Requirements
- **Windows Operating System**: This extension works only on 64-bit windows.
- **Microsoft Macro Assembler (MASM)**: Ensure `ml.exe` and `link.exe` are installed and the path to them is specified in `masm.compilerPath` and `masm.linkerPath` extension settings.
- **PowerShell**: Used for building and running tasks.

## Extension Settings

This extension contributes the following settings:

- `masmLanguageServer.secondaryLabelSeverity`: Set severity level for secondary diagnostics labels (`information` or `hint`).
- `masmLanguageServer.enableDiagnostics`: Enable or disable diagnostics.
- `masm.compilerPath`: Path to the MASM compiler (`ml.exe`).
- `masm.linkerPath`: Path to the MASM linker (`link.exe`).
- `masm.includePaths`: List of include directories for the compiler.
- `masm.libPaths`: List of library directories for the linker.

## Commands

- **Run MASM File** (`Ctrl+F5`): Compile and run the active MASM file.
- **Debug MASM File** (`F5`): Compile and debug the active MASM file.

## Keybindings

- **Ctrl+F5**: Run MASM file.
- **F5**: Debug MASM file.

## Known Issues

- The debugger currently supports only console applications.

## Release Notes

### 1.0.0

- Initial release.

---

## Contributing

We welcome contributions! Feel free to submit issues or pull requests at [GitHub Repository](https://github.com/gregoryginzburg/vscode-masm).

## For More Information

- [MASM Documentation](https://docs.microsoft.com/en-us/cpp/assembler/masm/)