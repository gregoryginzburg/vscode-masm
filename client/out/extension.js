"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.createRealShellExecution = createRealShellExecution;
exports.substituteVSCodeVariables = substituteVSCodeVariables;
exports.deactivate = deactivate;
const path = require("path");
const fs = require("fs");
const os = require("os");
const child_process_1 = require("child_process");
const vscode = require("vscode");
const vscode_1 = require("vscode");
const node_1 = require("vscode-languageclient/node");
let client;
const defaultBuildTaskDefinition = {
    type: 'masmbuild',
    label: 'Build',
    files: ['${file}'],
    output: '${fileBasenameNoExtension}.exe',
    compilerArgs: [
        "/c",
        "/coff",
        "/Zi",
        "/Fl",
        "/W3"
    ],
    linkerArgs: [
        "/SUBSYSTEM:CONSOLE",
        "/DEBUG",
        "/MACHINE:X86",
    ]
};
const defaultDebugConfig = {
    type: 'masmdbg',
    request: 'launch',
    name: 'Debug MASM Program',
    // By default, use the workspaceFolder + fileBasenameNoExtension.exe
    // This matches the default "output" from our tasks.json
    // program: '${workspaceFolder}/${fileBasenameNoExtension}.exe',
};
function activate(context) {
    // The server is implemented in node
    const serverModule = context.asAbsolutePath(path.join('lsp-server', 'out', 'server.js'));
    const masmLintExePath = context.asAbsolutePath(path.join('bin', 'masmlint.exe'));
    // The debug options for the server
    // --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
    let debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };
    // If the extension is launched in debug mode then the debug server options are used
    // Otherwise the run options are used
    let serverOptions = {
        run: { module: serverModule, transport: node_1.TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: node_1.TransportKind.ipc,
            options: debugOptions
        }
    };
    // Options to control the language client
    let clientOptions = {
        // Register the server for plain text documents
        documentSelector: [{ scheme: 'file', language: 'masm' }],
        initializationOptions: {
            masmLintExePath: masmLintExePath
        },
        synchronize: {
            // Notify the server about file changes to '.clientrc files contained in the workspace
            fileEvents: vscode_1.workspace.createFileSystemWatcher('**/.clientrc')
        }
    };
    // Create the language client and start the client.
    client = new node_1.LanguageClient('masmLanguageServer', 'MASM Language Server', serverOptions, clientOptions);
    // Start the client. This will also launch the server
    client.start();
    // --------------------------------------------------------------
    //  Register the masmbuild Task Provider
    // --------------------------------------------------------------
    const masmBuildTaskProvider = vscode_1.tasks.registerTaskProvider('masmbuild', {
        provideTasks: () => {
            return [];
        },
        /**
         * resolveTask():
         * Called by VS Code if it needs to quickly get a single task without calling provideTasks().
         * For example, if a user references a "masmbuild" task in tasks.json and runs it directly.
         */
        resolveTask(_task) {
            // 1) Ensure this is actually a "masmbuild" definition
            const definition = _task.definition;
            if (!definition.files || !definition.output) {
                // If required fields are missing, show an error and return undefined
                vscode.window.showErrorMessage('MASM build task must have "files" (array) and "output" (string).');
                return undefined;
            }
            // 2) Try building the final ShellExecution with the user's definition
            let shellExec;
            try {
                shellExec = createRealShellExecution(definition);
            }
            catch (err) {
                vscode.window.showErrorMessage(`MASM build task error: ${err.message}`);
                return undefined;
            }
            // 3) Create a new Task that uses this shell execution
            const resolvedTask = new vscode.Task(definition, _task.scope ?? vscode.TaskScope.Workspace, _task.name, _task.source, shellExec, _task.problemMatchers);
            return resolvedTask;
        }
    });
    context.subscriptions.push(vscode.commands.registerCommand('extension.runMasmFile', runMasmFile));
    context.subscriptions.push(vscode.commands.registerCommand('extension.debugMasmFile', debugMasmFile));
    context.subscriptions.push(masmBuildTaskProvider);
}
/**
 * (B) Actually build up the multiline ShellExecution for compile+link,
 *     using user/workspace settings for compilerPath, linkerPath, etc.
 */
function createRealShellExecution(def) {
    // Get the active editor & workspace folder
    const editor = vscode.window.activeTextEditor;
    const workspaceFolder = vscode.workspace.workspaceFolders
        ? vscode.workspace.workspaceFolders[0]
        : undefined;
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
    }
    let workspaceFolderPath = workspaceFolder.uri.fsPath;
    function ensureFullPath(dir) {
        return path.isAbsolute(dir) ? dir : path.join(workspaceFolderPath, dir);
    }
    function ensureFullPaths(dirs) {
        return dirs.map(dir => ensureFullPath(dir));
    }
    // 1) Get user/workspace settings
    const config = vscode.workspace.getConfiguration('masm');
    const compilerPath = ensureFullPath(config.get('compilerPath', 'ml.exe'));
    const linkerPath = ensureFullPath(config.get('linkerPath', 'link.exe'));
    const includePaths = ensureFullPaths(config.get('includePaths', []));
    const libPaths = ensureFullPaths(config.get('libPaths', []));
    // 2) Validate required fields
    if (!def.files || def.files.length === 0) {
        throw new Error('MASM build task: "files" must be a non-empty array.');
    }
    if (!def.output || !def.output.trim()) {
        throw new Error('MASM build task: "output" must be a valid string.');
    }
    // Expand variables in each array element & string
    const expandedFiles = ensureFullPaths(def.files.map(f => substituteVSCodeVariables(f, editor, workspaceFolder)));
    const expandedOutput = substituteVSCodeVariables(def.output, editor, workspaceFolder);
    const compilerArgs = def.compilerArgs || [];
    const linkerArgs = def.linkerArgs || [];
    // Build up the flags
    const includeFlags = includePaths
        .map(dir => `/I "${dir}"`)
        .join(' ');
    const libFlags = libPaths
        .map(dir => `/LIBPATH:"${dir}"`)
        .join(' ');
    // 3) Build the .bat script contents
    //    We’ll do:
    //    1) ml.exe /c for each .asm file
    //    2) link.exe all resulting .obj files
    //    3) exit /B %errorlevel%
    let batchContent = '@echo off\r\n';
    batchContent += 'setlocal enabledelayedexpansion\r\n\r\n';
    // For each ASM file, compile it
    for (const asmFile of expandedFiles) {
        let folderPath = path.dirname(asmFile);
        batchContent += `cd "${folderPath}"\r\n`;
        batchContent += `"${compilerPath}" /c ${includeFlags} ${compilerArgs.join(' ')} "${asmFile}"\r\n`;
        batchContent += `if errorlevel 1 goto errasm\r\n\r\n`;
    }
    batchContent += `cd "${workspaceFolderPath}"\r\n`;
    // Now link all .obj
    const objFiles = expandedFiles.map(asm => {
        const baseName = path.basename(asm, path.extname(asm));
        const objFile = path.join(path.dirname(asm), baseName + '.obj');
        return `"${objFile}"`;
    });
    batchContent += `echo.\r\n`;
    batchContent += `echo Linking to output ${expandedOutput}\r\n`;
    batchContent += `"${linkerPath}" ${objFiles.join(' ')} ${libFlags} /OUT:"${expandedOutput}" ${linkerArgs.join(' ')}\r\n`;
    batchContent += `if errorlevel 1 goto errlink\r\n\r\n`;
    // Finally, exit with success
    batchContent += `echo Build completed successfully!\r\n`;
    batchContent += `goto TheEnd\r\n\r\n`;
    batchContent += `:errlink\r\n`;
    batchContent += `echo Linker error -- code %errorlevel%\r\n`;
    batchContent += `goto TheEnd\r\n\r\n`;
    batchContent += `:errasm\r\n`;
    batchContent += `echo Assembler error -- code %errorlevel%\r\n`;
    batchContent += `goto TheEnd\r\n\r\n`;
    batchContent += `:TheEnd\r\n`;
    batchContent += `exit /B %errorlevel%\r\n`;
    // 4) Write the .bat file to a temp folder
    const tempFolder = os.tmpdir();
    const batFileName = `masmbuild_${Date.now()}.bat`;
    const batFilePath = path.join(tempFolder, batFileName);
    fs.writeFileSync(batFilePath, batchContent, { encoding: 'utf8' });
    // 5) Create a ShellExecution that runs this .bat
    const shellExec = new vscode.ShellExecution(`"${batFilePath}"`);
    // 6) Store the batFilePath somewhere so we can delete it
    //    after the task completes in onDidEndTaskProcess.
    //    For example, you could attach it to the definition or a global variable:
    def._tempBatFilePath = batFilePath;
    return shellExec;
}
/**
 * Ensures that .vscode/tasks.json exists, creating it if necessary
 * with a single default masmbuild task labeled "Build".
 */
async function ensureTasksJsonExists() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open to create tasks.json in.');
        return;
    }
    const vscodeFolderPath = path.join(workspaceFolder.uri.fsPath, '.vscode');
    const tasksJsonPath = path.join(vscodeFolderPath, 'tasks.json');
    if (!fs.existsSync(tasksJsonPath)) {
        // Create a default tasks.json
        const defaultTasksJson = {
            version: '2.0.0',
            tasks: [
                defaultBuildTaskDefinition
            ]
        };
        // Make sure .vscode folder exists
        if (!fs.existsSync(vscodeFolderPath)) {
            fs.mkdirSync(vscodeFolderPath);
        }
        // Write out the file
        fs.writeFileSync(tasksJsonPath, JSON.stringify(defaultTasksJson, null, 2));
        vscode.window.showInformationMessage(`Created default tasks.json at: ${tasksJsonPath}`);
    }
}
/**
 * Command: "extension.runMasmFile"
 * - Ensures tasks.json exists
 * - Finds the "Build" masmbuild task
 * - Executes the build task to build the currently open .asm file
 */
async function runMasmFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active MASM file to debug!');
        return;
    }
    const workspaceFolder = vscode.workspace.workspaceFolders
        ? vscode.workspace.workspaceFolders[0]
        : undefined;
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
    }
    const document = editor.document;
    if (document.languageId !== 'masm') {
        vscode.window.showErrorMessage('The current file is not a MASM file!');
        return;
    }
    // Save all files before running
    const openDocuments = vscode.workspace.textDocuments;
    for (const document of openDocuments) {
        if (document.isDirty) { // Only save if the document has unsaved changes
            await document.save();
        }
    }
    await ensureTasksJsonExists();
    const buildTaskLabel = 'Build';
    const masmTasks = await vscode.tasks.fetchTasks({ type: 'masmbuild' });
    let buildTask = masmTasks.find(t => t.name === buildTaskLabel);
    let definition = undefined;
    if (!buildTask) {
        definition = defaultBuildTaskDefinition;
    }
    else {
        definition = buildTask.definition;
    }
    buildTask = new vscode.Task(definition, vscode.TaskScope.Workspace, // or TaskScope.Global
    buildTaskLabel, // name/label
    'masmbuild', // source
    createRealShellExecution(definition));
    const buildExecution = await vscode.tasks.executeTask(buildTask);
    // 2) Wait for the build to complete
    //    We'll wrap the event-based callback in a Promise
    const buildFinished = new Promise((resolve) => {
        const dispose = vscode.tasks.onDidEndTaskProcess((e) => {
            // Compare 'e.execution' with our 'buildExecution'
            if (e.execution === buildExecution) {
                dispose.dispose(); // Unsubscribe from the event
                resolve(e.exitCode ?? -1); // Return the exit code
            }
        });
    });
    // 3) If exit code is 0, start running
    const exitCode = await buildFinished;
    // Now that the build is done, delete the .bat file (if it was set)
    const def = definition;
    if (def._tempBatFilePath) {
        try {
            fs.unlinkSync(def._tempBatFilePath);
        }
        catch (err) {
            console.warn(`Failed to delete temp .bat file: ${err}`);
        }
    }
    if (exitCode !== 0) {
        vscode.window.showErrorMessage(`Build failed with exit code ${exitCode}.`);
        return;
    }
    let workspaceFolderPath = workspaceFolder.uri.fsPath;
    function ensureFullPath(dir) {
        return path.isAbsolute(dir) ? dir : path.join(workspaceFolderPath, dir);
    }
    const outputFilePath = ensureFullPath(substituteVSCodeVariables(definition.output, editor, workspaceFolder));
    executeExternalConsole(outputFilePath);
}
function executeExternalConsole(executablePath) {
    // Use child_process to open a new command prompt and run the executable
    const command = `start cmd.exe /V:ON /C ""${executablePath}" & echo. & echo. & echo ------------------ & echo (program exited with code: !ERRORLEVEL!) & <nul set /p=Press any key to close this window . . . & pause >nul"`;
    (0, child_process_1.exec)(command, (error, stdout, stderr) => {
        if (error) {
            vscode.window.showErrorMessage(`Error running executable: ${error.message}`);
            return;
        }
        if (stderr) {
            vscode.window.showWarningMessage(`Executable output: ${stderr}`);
        }
        console.log(stdout);
    });
}
/**
 * Command: "extension.debugMasmFile"
 * - Ensures tasks.json exists
 * - Finds the "Build" task and executes it
 * - Then starts a debug session using the "masmdbg" configuration
 */
async function debugMasmFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active MASM file to debug!');
        return;
    }
    const workspaceFolder = vscode.workspace.workspaceFolders
        ? vscode.workspace.workspaceFolders[0]
        : undefined;
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
    }
    const document = editor.document;
    if (document.languageId !== 'masm') {
        vscode.window.showErrorMessage('The current file is not a MASM file!');
        return;
    }
    // Save all files before running
    const openDocuments = vscode.workspace.textDocuments;
    for (const document of openDocuments) {
        if (document.isDirty) { // Only save if the document has unsaved changes
            await document.save();
        }
    }
    await ensureTasksJsonExists();
    const buildTaskLabel = 'Build';
    const masmTasks = await vscode.tasks.fetchTasks({ type: 'masmbuild' });
    let buildTask = masmTasks.find(t => t.name === buildTaskLabel);
    let definition = undefined;
    if (!buildTask) {
        definition = defaultBuildTaskDefinition;
    }
    else {
        definition = buildTask.definition;
    }
    buildTask = new vscode.Task(definition, vscode.TaskScope.Workspace, // or TaskScope.Global
    buildTaskLabel, // name/label
    'masmbuild', // source
    createRealShellExecution(definition));
    // 1) Kick off the build
    const buildExecution = await vscode.tasks.executeTask(buildTask);
    // 2) Wait for the build to complete
    //    We'll wrap the event-based callback in a Promise
    const buildFinished = new Promise((resolve) => {
        const dispose = vscode.tasks.onDidEndTaskProcess((e) => {
            // Compare 'e.execution' with our 'buildExecution'
            if (e.execution === buildExecution) {
                dispose.dispose(); // Unsubscribe from the event
                resolve(e.exitCode ?? -1); // Return the exit code
            }
        });
    });
    // 3) If exit code is 0, start debugging
    const exitCode = await buildFinished;
    const def = definition;
    if (def._tempBatFilePath) {
        try {
            fs.unlinkSync(def._tempBatFilePath);
        }
        catch (err) {
            console.warn(`Failed to delete temp .bat file: ${err}`);
        }
    }
    if (exitCode !== 0) {
        vscode.window.showErrorMessage(`Build failed with exit code ${exitCode}. Aborting debug.`);
        return;
    }
    let debugConfig = defaultDebugConfig;
    let workspaceFolderPath = workspaceFolder.uri.fsPath;
    function ensureFullPath(dir) {
        return path.isAbsolute(dir) ? dir : path.join(workspaceFolderPath, dir);
    }
    debugConfig.program = ensureFullPath(substituteVSCodeVariables(definition.output, editor, workspaceFolder));
    vscode.debug.startDebugging(undefined, defaultDebugConfig);
}
/**
 * Expand common VS Code variables in a string, like:
 *   - ${workspaceFolder}
 *   - ${file}
 *   - ${fileBasenameNoExtension}
 *   - ...
 *
 * @param input A string containing the variables to be substituted
 * @param editor The active text editor (if relevant to your substitution)
 * @param workspaceFolder The workspace folder (if available)
 * @returns The input string with recognized variables replaced
 */
function substituteVSCodeVariables(input, editor, workspaceFolder) {
    // 1) Initialize some “global” values:
    const userHome = os.homedir();
    const execPath = process.execPath; // location of Code.exe (or code binary)
    // 2) If no workspaceFolder is provided, try the first one
    if (!workspaceFolder && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        workspaceFolder = vscode.workspace.workspaceFolders[0];
    }
    // 3) Gather file-specific info if editor/document is available
    const doc = editor?.document;
    let file;
    let fileDirname;
    let fileBasename;
    let fileExtname;
    let fileBasenameNoExtension;
    let fileWorkspaceFolder;
    let relativeFile;
    let relativeFileDirname;
    let lineNumber;
    let selectedText;
    if (doc?.uri?.scheme === 'file') {
        file = doc.uri.fsPath;
        fileDirname = path.dirname(file);
        fileBasename = path.basename(file);
        fileExtname = path.extname(file);
        fileBasenameNoExtension = path.basename(file, fileExtname || undefined);
        // If we know the workspace folder, find relative path
        if (workspaceFolder) {
            const wkFolderPath = workspaceFolder.uri.fsPath;
            fileWorkspaceFolder = wkFolderPath; // e.g. /home/user/workspace
            if (file.startsWith(wkFolderPath)) {
                // substring after the workspace path
                const rel = path.relative(wkFolderPath, file); // e.g. folder/file.ext
                relativeFile = rel;
                relativeFileDirname = path.dirname(rel); // e.g. folder
            }
        }
        // Cursor line number
        if (editor?.selection) {
            lineNumber = `${editor.selection.active.line + 1}`;
        }
        // Selected text
        if (editor?.selection && !editor.selection.isEmpty) {
            selectedText = doc.getText(editor.selection);
        }
    }
    // 4) Expand workspace folder variables
    const resolvedWorkspaceFolder = workspaceFolder?.uri.fsPath || '';
    const workspaceFolderBasename = workspaceFolder
        ? path.basename(workspaceFolder.uri.fsPath)
        : '';
    // 5) Create a map of the variable expansions
    const substitutions = {
        '${userHome}': userHome,
        '${execPath}': execPath,
        '${workspaceFolder}': resolvedWorkspaceFolder,
        '${workspaceFolderBasename}': workspaceFolderBasename,
        '${file}': file || '',
        '${fileWorkspaceFolder}': fileWorkspaceFolder || '',
        '${fileDirname}': fileDirname || '',
        '${fileBasename}': fileBasename || '',
        '${fileExtname}': fileExtname || '',
        '${fileBasenameNoExtension}': fileBasenameNoExtension || '',
        '${relativeFile}': relativeFile || '',
        '${relativeFileDirname}': relativeFileDirname || '',
        '${lineNumber}': lineNumber || '',
        '${selectedText}': selectedText || '',
        // Path separator
        '${pathSeparator}': path.sep
    };
    // 6) Perform the substitutions
    let output = input;
    for (const [variable, value] of Object.entries(substitutions)) {
        // Replace all occurrences of the variable
        output = output.split(variable).join(value);
    }
    return output;
}
function deactivate() {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
//# sourceMappingURL=extension.js.map