import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { exec } from 'child_process';
import * as vscode from 'vscode';
import { workspace, ExtensionContext, tasks, Task, DiagnosticSeverity, ConfigurationTarget, TaskScope } from 'vscode';

import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;
// let diagnosticCollection: vscode.DiagnosticCollection;

const defaultBuildTaskDefinition = {
  type: 'masmbuild',
  label: 'Build',
  files: ['${file}'],
  output: '${fileDirname}/${fileBasenameNoExtension}.exe',
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


const defaultDebugConfig: vscode.DebugConfiguration = {
  type: 'masmdbg',
  request: 'launch',
  name: 'Debug MASM Program',
  // By default, use the workspaceFolder + fileBasenameNoExtension.exe
  // This matches the default "output" from our tasks.json
  // program: '${workspaceFolder}/${fileBasenameNoExtension}.exe',
};

const openSettingsItem: vscode.MessageItem = { title: "Open Settings" };
const reportIssueItem: vscode.MessageItem = { title: "Report Issue" };
const repoIssuesUrl = 'https://t.me/gregory_ginzburg';

// const COMPILER_DIAGNOSTIC_SOURCE = 'masm-compiler';

export function activate(context: ExtensionContext) {
  // The server is implemented in node
  const serverModule = context.asAbsolutePath(path.join('lsp-server', 'out', 'server.js'));

  const masmLintExePath = context.asAbsolutePath(
    path.join('bin', 'masmlint.exe')
  );
  // The debug options for the server
  // --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
  let debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  let serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions
    }
  };

  // Options to control the language client
  let clientOptions: LanguageClientOptions = {
    // Register the server for plain text documents
    documentSelector: [{ scheme: 'file', language: 'masm' }],
    initializationOptions: {
      masmLintExePath: masmLintExePath
    },
    synchronize: {
      // Notify the server about file changes to '.clientrc files contained in the workspace
      fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
    }
  };

  // Create the language client and start the client.
  client = new LanguageClient(
    'masmLanguageServer',
    'MASM Language Server',
    serverOptions,
    clientOptions
  );

  // Start the client. This will also launch the server
  client.start();


  // --------------------------------------------------------------
  //  Register the masmbuild Task Provider
  // --------------------------------------------------------------
  const masmBuildTaskProvider = tasks.registerTaskProvider('masmbuild', {
    provideTasks: () => {
      return [];
    },

    /**
     * resolveTask():
     * Called by VS Code if it needs to quickly get a single task without calling provideTasks().
     * For example, if a user references a "masmbuild" task in tasks.json and runs it directly.
     */
    resolveTask(_task: Task): Task | undefined {
      // 1) Ensure this is actually a "masmbuild" definition
      const definition = _task.definition as MasmbuildTaskDefinition;
      if (!definition.files || !definition.output) {
        // If required fields are missing, show an error and return undefined
        vscode.window.showErrorMessage(
          'MASM build task must have "files" (array) and "output" (string).'
        );
        return undefined;
      }

      // 2) Try building the final ShellExecution with the user's definition
      let shellExec: vscode.ShellExecution;
      try {
        shellExec = createRealShellExecution(definition);
      } catch (err: any) {
        vscode.window.showErrorMessage(`MASM build task error: ${err.message}`);
        return undefined;
      }

      // 3) Create a new Task that uses this shell execution
      const resolvedTask = new vscode.Task(
        definition,
        _task.scope ?? vscode.TaskScope.Workspace,
        _task.name,
        _task.source,
        shellExec,
        _task.problemMatchers
      );
      return resolvedTask;
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('extension.runMasmFile', runMasmFile)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('extension.debugMasmFile', debugMasmFile)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('masm.toggleDiagnostics', toggleDiagnostics)
  );

  context.subscriptions.push(masmBuildTaskProvider);
}


/**
 * Our custom task definition for "masmbuild".
 * Extends vscode.TaskDefinition so VS Code can read/write tasks.json fields like "files", "output", etc.
 */
interface MasmbuildTaskDefinition extends vscode.TaskDefinition {
  /**
   * The .asm files to compile.
   */
  files: string[];

  /**
   * The output .exe name.
   */
  output: string;

  /**
   * Optional: extra compiler arguments.
   */
  compilerArgs?: string[];

  /**
   * Optional: extra linker arguments.
   */
  linkerArgs?: string[];
}


/**
 * Проверяет, запущен ли процесс с заданным именем исполняемого файла в Windows.
 * @param executableName Имя файла, например "myprogram.exe"
 * @returns Promise, который разрешается в true, если процесс найден, иначе false.
 */
function isProcessRunning(executableName: string): Promise<boolean> {
  return new Promise((resolve) => {
    // /NH - без заголовка, /FI - фильтр
    const command = `tasklist /NH /FI "IMAGENAME eq ${executableName}"`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error checking tasklist: ${error.message}`);
        resolve(false);
        return;
      }
      if (stderr) {
        console.warn(`Stderr checking tasklist: ${stderr}`);
      }
      // Если stdout содержит имя процесса, значит он запущен
      resolve(stdout.toLowerCase().includes(executableName.toLowerCase()));
    });
  });
}



/**
 * (B) Actually build up the multiline ShellExecution for compile+link,
 *     using user/workspace settings for compilerPath, linkerPath, etc.
 */
export function createRealShellExecution(def: MasmbuildTaskDefinition): vscode.ShellExecution {
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
  function ensureFullPath(dir: string) {
    return path.isAbsolute(dir) ? dir : path.join(workspaceFolderPath, dir);
  }
  function ensureFullPaths(dirs: string[]) {
    return dirs.map(dir => ensureFullPath(dir));
  }

  // 1) Get user/workspace settings
  const config = vscode.workspace.getConfiguration('masm');
  const compilerPath = ensureFullPath(config.get<string>('compilerPath', 'ml.exe'));
  const linkerPath = ensureFullPath(config.get<string>('linkerPath', 'link.exe'));
  const includePaths = ensureFullPaths(config.get<string[]>('includePaths', []));
  const libPaths = ensureFullPaths(config.get<string[]>('libPaths', []));

  // 2) Validate required fields
  if (!def.files || def.files.length === 0) {
    throw new Error('MASM build task: "files" must be a non-empty array.');
  }
  if (!def.output || !def.output.trim()) {
    throw new Error('MASM build task: "output" must be a valid string.');
  }

  // Expand variables in each array element & string
  const expandedFiles = ensureFullPaths(def.files.map(f =>
    substituteVSCodeVariables(f, editor, workspaceFolder)
  ));

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
    batchContent += `cd "${folderPath}"\r\n`
    batchContent += `"${compilerPath}" /c ${includeFlags} ${compilerArgs.join(' ')} "${asmFile}"\r\n`;
    batchContent += `if errorlevel 1 goto errasm\r\n\r\n`;
  }

  batchContent += `cd "${workspaceFolderPath}"\r\n`

  // Now link all .obj
  const objFiles = expandedFiles.map(asm => {
    const baseName = path.basename(asm, path.extname(asm));
    const objFile = path.join(path.dirname(asm), baseName + '.obj');
    return `"${objFile}"`;
  });

  batchContent += `echo.\r\n`
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
  (def as any)._tempBatFilePath = batFilePath;

  return shellExec;
}
/**
 * Ensures that .vscode/tasks.json exists, creating it if necessary
 * with a single default masmbuild task labeled "Build".
 */
async function ensureTasksJsonExists(): Promise<void> {
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
async function runMasmFile(): Promise<void> {
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

  // --- Check for linter errors BEFORE building ---
  const diagnostics = vscode.languages.getDiagnostics(document.uri);
  const hasLinterErrors = diagnostics.some(d => d.severity === DiagnosticSeverity.Error);

  await ensureTasksJsonExists();

  const buildTaskLabel = 'Build';
  const masmTasks = await vscode.tasks.fetchTasks({ type: 'masmbuild' });
  let buildTask = masmTasks.find(t => t.name === buildTaskLabel);

  let definition: MasmbuildTaskDefinition = undefined;
  if (!buildTask) {
    definition = defaultBuildTaskDefinition;
  } else {
    definition = buildTask.definition as MasmbuildTaskDefinition;
  }

  // --- Проверка, не запущен ли уже исполняемый файл ---
  try {
    const outputFilePath = ensureFullPath(substituteVSCodeVariables(definition.output, editor, workspaceFolder));
    const executableName = path.basename(outputFilePath);

    if (await isProcessRunning(executableName)) {
      vscode.window.showErrorMessage(
        `Cannot start build: The output file '${executableName}' is already running. Please close the existing console window and try again.`, { modal: true }
      );
      return;
    }
  } catch (e) {
    console.error("Error preparing for process check:", e);
  }

  buildTask = new vscode.Task(
    definition,
    vscode.TaskScope.Workspace,        // or TaskScope.Global
    buildTaskLabel,                    // name/label
    'masmbuild',                       // source
    createRealShellExecution(definition)
  );
  const buildExecution = await vscode.tasks.executeTask(buildTask);

  // 2) Wait for the build to complete
  //    We'll wrap the event-based callback in a Promise
  const buildFinished = new Promise<number>((resolve) => {
    const dispose = vscode.tasks.onDidEndTaskProcess((e) => {
      // Compare 'e.execution' with our 'buildExecution'
      if (e.execution === buildExecution) {
        dispose.dispose(); // Unsubscribe from the event
        resolve(e.exitCode ?? -1);  // Return the exit code
      }
    });
  });

  // 3) If exit code is 0, start running
  const exitCode = await buildFinished;

  // Now that the build is done, delete the .bat file (if it was set)
  const def = definition as any;
  if (def._tempBatFilePath) {
    try {
      fs.unlinkSync(def._tempBatFilePath);
    } catch (err) {
      console.warn(`Failed to delete temp .bat file: ${err}`);
    }
  }

  // --- Check for linter errors AFTER build completion ---
  if (hasLinterErrors) {
    const message = `Cannot Run MASM File: Errors detected. You can disable diagnostics using 'Open Settings' to run anyway and report the issue using 'Report Issue'.`;

    // Показываем сообщение с кнопками
    vscode.window.showErrorMessage(message, openSettingsItem, reportIssueItem)
      .then(selection => {
        // Обрабатываем нажатие кнопки
        if (selection === openSettingsItem) {
          // Открываем настройки с фильтром по ID вашей настройки
          vscode.commands.executeCommand('workbench.action.openSettings', 'masmLanguageServer.enableDiagnostics');
        } else if (selection === reportIssueItem) {
          // Открываем URL для баг-репортов во внешнем браузере
          vscode.env.openExternal(vscode.Uri.parse(repoIssuesUrl));
        }
        // Если пользователь закрыл уведомление (selection === undefined), ничего не делаем
      });
    return; // Прервать выполнение runMasmFile
  }

  if (exitCode !== 0) {
    vscode.window.showErrorMessage(`Build failed with exit code ${exitCode}.`);
    return;
  }

  let workspaceFolderPath = workspaceFolder.uri.fsPath;
  function ensureFullPath(dir: string) {
    return path.isAbsolute(dir) ? dir : path.join(workspaceFolderPath, dir);
  }
  const outputFilePath = ensureFullPath(substituteVSCodeVariables(definition.output, editor, workspaceFolder));
  executeExternalConsole(outputFilePath);
}

function executeExternalConsole(executablePath) {
  // Use child_process to open a new command prompt and run the executable
  const command = `start cmd.exe /V:ON /C ""${executablePath}" & echo. & echo. & echo ------------------ & echo (program exited with code: !ERRORLEVEL!) & <nul set /p=Press any key to close this window . . . & pause >nul"`;


  exec(command, (error, stdout, stderr) => {
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
async function debugMasmFile(): Promise<void> {
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

  // --- Check for linter errors BEFORE building ---
  const diagnostics = vscode.languages.getDiagnostics(document.uri);
  const hasLinterErrors = diagnostics.some(d => d.severity === DiagnosticSeverity.Error);

  await ensureTasksJsonExists();

  const buildTaskLabel = 'Build';
  const masmTasks = await vscode.tasks.fetchTasks({ type: 'masmbuild' });
  let buildTask = masmTasks.find(t => t.name === buildTaskLabel);

  let definition: MasmbuildTaskDefinition = undefined;
  if (!buildTask) {
    definition = defaultBuildTaskDefinition;
  } else {
    definition = buildTask.definition as MasmbuildTaskDefinition;
  }

  // --- Проверка, не запущен ли уже исполняемый файл ---
  try {
    const outputFilePath = ensureFullPath(substituteVSCodeVariables(definition.output, editor, workspaceFolder));
    const executableName = path.basename(outputFilePath);

    if (await isProcessRunning(executableName)) {
      vscode.window.showErrorMessage(
        `Cannot start build: The output file '${executableName}' is already running. Please close the existing console window and try again.`, { modal: true }
      );
      return;
    }
  } catch (e) {
    console.error("Error preparing for process check:", e);
  }

  buildTask = new vscode.Task(
    definition,
    vscode.TaskScope.Workspace,        // or TaskScope.Global
    buildTaskLabel,                    // name/label
    'masmbuild',                       // source
    createRealShellExecution(definition)
  );

  // 1) Kick off the build
  const buildExecution = await vscode.tasks.executeTask(buildTask);

  // 2) Wait for the build to complete
  //    We'll wrap the event-based callback in a Promise
  const buildFinished = new Promise<number>((resolve) => {
    const dispose = vscode.tasks.onDidEndTaskProcess((e) => {
      // Compare 'e.execution' with our 'buildExecution'
      if (e.execution === buildExecution) {
        dispose.dispose(); // Unsubscribe from the event
        resolve(e.exitCode ?? -1);  // Return the exit code
      }
    });
  });

  // 3) If exit code is 0, start debugging
  const exitCode = await buildFinished;

  const def = definition as any;
  if (def._tempBatFilePath) {
    try {
      fs.unlinkSync(def._tempBatFilePath);
    } catch (err) {
      console.warn(`Failed to delete temp .bat file: ${err}`);
    }
  }

  // --- Check for linter errors AFTER build completion ---
  if (hasLinterErrors) {
    const message = `Cannot Debug MASM File: Errors detected. You can disable diagnostics using 'Open Settings' to run anyway and report the issue using 'Report Issue'.`;

    // Показываем сообщение с кнопками
    vscode.window.showErrorMessage(message, openSettingsItem, reportIssueItem)
      .then(selection => {
        // Обрабатываем нажатие кнопки
        if (selection === openSettingsItem) {
          // Открываем настройки с фильтром по ID вашей настройки
          vscode.commands.executeCommand('workbench.action.openSettings', 'masmLanguageServer.enableDiagnostics');
        } else if (selection === reportIssueItem) {
          // Открываем URL для баг-репортов во внешнем браузере
          vscode.env.openExternal(vscode.Uri.parse(repoIssuesUrl));
        }
        // Если пользователь закрыл уведомление (selection === undefined), ничего не делаем
      });
    return; // Прервать выполнение runMasmFile
  }

  if (exitCode !== 0) {
    vscode.window.showErrorMessage(`Build failed with exit code ${exitCode}. Aborting debug.`);
    return;
  }

  let debugConfig = defaultDebugConfig;
  let workspaceFolderPath = workspaceFolder.uri.fsPath;
  function ensureFullPath(dir: string) {
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
export function substituteVSCodeVariables(
  input: string,
  editor?: vscode.TextEditor,
  workspaceFolder?: vscode.WorkspaceFolder
): string {
  // 1) Initialize some “global” values:
  const userHome = os.homedir();
  const execPath = process.execPath; // location of Code.exe (or code binary)

  // 2) If no workspaceFolder is provided, try the first one
  if (!workspaceFolder && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    workspaceFolder = vscode.workspace.workspaceFolders[0];
  }

  // 3) Gather file-specific info if editor/document is available
  const doc = editor?.document;
  let file: string | undefined;
  let fileDirname: string | undefined;
  let fileBasename: string | undefined;
  let fileExtname: string | undefined;
  let fileBasenameNoExtension: string | undefined;
  let fileWorkspaceFolder: string | undefined;
  let relativeFile: string | undefined;
  let relativeFileDirname: string | undefined;
  let lineNumber: string | undefined;
  let selectedText: string | undefined;

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
  const substitutions: Record<string, string> = {
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


async function toggleDiagnostics(): Promise<void> {
  const config = vscode.workspace.getConfiguration('masmLanguageServer');
  const currentSetting = config.get<boolean>('enableDiagnostics');
  const newValue = !currentSetting;

  try {
    // Определяем, куда записывать настройку: в Workspace, если открыта папка, иначе в User (Global)
    const target = vscode.workspace.workspaceFolders
      ? ConfigurationTarget.Workspace
      : ConfigurationTarget.Global;

    await config.update('enableDiagnostics', newValue, target);

    // Показываем сообщение пользователю
    vscode.window.showInformationMessage(`MASM Diagnostics ${newValue ? 'Enabled' : 'Disabled'}.`);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to toggle MASM diagnostics: ${error}`);
    console.error("Error updating MASM diagnostics setting:", error);
  }
}

// // Вывод диагностики компилятора в UI
// // Нужен доступ к stdout терминала, это сложно (нужен CustomExecution)
// interface ParsedDiagnostic {
//   uri: vscode.Uri;
//   diagnostic: vscode.Diagnostic;
// }

// /**
//  * Парсит вывод компилятора MASM из строки.
//  * @param output Строка с выводом stdout и stderr компилятора.
//  * @returns Массив разобранных объектов диагностики.
//  */
// function parseCompilerOutput(output: string): ParsedDiagnostic[] {
//   const diagnostics: ParsedDiagnostic[] = [];
//   // Регулярки для удаления ненужных строк
//   const copyrightLineRegex = /^ Microsoft \(R\) Macro Assembler Version .*$/m;
//   const copyrightLineRegex2 = /^Copyright \(C\) Microsoft Corp .*$/m;
//   const assemblingLineRegex = /^ Assembling: .*$/m;
//   const changingDirRegex = /^ Changing directory to: .*$/m; // Удаляем вывод cd
//   const compilingLineRegex = /^ Compiling.*: .*$/m; // Удаляем вывод echo Compiling
//   const linkingLineRegex = /^ Linking to output .*$/m; // Удаляем вывод echo Linking
//   const buildMarkerRegex = /^--- (Starting|Finished) Build.*---$/m; // Удаляем наши маркеры
//   const emptyLineRegex = /^\s*$/gm; // Для удаления пустых строк

//   // Очищаем вывод от информационных сообщений и пустых строк
//   const cleanedOutput = output
//       .replace(copyrightLineRegex, '')
//       .replace(copyrightLineRegex2, '')
//       .replace(assemblingLineRegex, '')
//       .replace(changingDirRegex, '')
//       .replace(compilingLineRegex, '')
//       .replace(linkingLineRegex, '')
//       .replace(buildMarkerRegex, '')
//       .replace(emptyLineRegex, '\n') // Заменяем пустые строки на одну новую строку для split
//       .trim(); // Убираем пробелы в начале и конце

//   // Разделяем на строки и фильтруем пустые еще раз на всякий случай
//   const lines = cleanedOutput.split(/\r?\n/).filter(line => line.trim() !== '');
//   // Регулярное выражение для разбора строки ошибки/предупреждения
//   const errorRegex = /^([^()]+)\((\d+)\)\s*:\s*(error|warning)\s+([A-Z]\d+):\s*(.*)$/;

//   console.log(`Parsing ${lines.length} cleaned lines of compiler output.`); // Отладка

//   for (const line of lines) {
//       const match = line.match(errorRegex); // trim() не нужен, т.к. уже почистили
//       if (match) {
//           const fullPath = match[1].trim(); // Путь к файлу
//           const lineNumber = parseInt(match[2], 10) - 1; // Номер строки (0-based)
//           const severityType = match[3].toLowerCase(); // 'error' или 'warning'
//           const errorCode = match[4]; // Код ошибки (Axxxx)
//           const message = match[5].trim(); // Сообщение

//           // Преобразуем severity
//           const severity = severityType === 'error'
//               ? vscode.DiagnosticSeverity.Error
//               : vscode.DiagnosticSeverity.Warning;

//           try {
//               // Создаем Uri файла
//               const fileUri = vscode.Uri.file(fullPath);

//               // Создаем Range (подсветка всей строки, начиная с первого символа)
//               // Для более точного range нужен доступ к содержимому файла,
//               // но для подсветки строки этого достаточно.
//               const range = new vscode.Range(lineNumber, 0, lineNumber, Number.MAX_VALUE); // От 0 до конца строки

//               // Создаем объект Diagnostic
//               const diagnostic: vscode.Diagnostic = {
//                   severity,
//                   range,
//                   message: `[${errorCode}] ${message}`, // Добавляем код ошибки в сообщение
//                   source: COMPILER_DIAGNOSTIC_SOURCE // Устанавливаем источник
//               };
//               diagnostics.push({ uri: fileUri, diagnostic });
//                console.log(`Parsed diagnostic: ${fileUri.fsPath}(${lineNumber + 1}) - ${message}`); // Отладка
//           } catch (uriError) {
//               console.error(`Failed to create URI for path: "${fullPath}". Error: ${uriError}`); // Отладка URI
//           }

//       } else { // Логируем только непустые нераспарсенные строки
//            console.log(`MASM output line not parsed: "${line}"`); // Отладка
//       }
//   }
//   console.log(`Finished parsing. Found ${diagnostics.length} diagnostics.`); // Отладка
//   return diagnostics;
// }


// /**
//  * Обрабатывает результат завершенной задачи сборки MASM.
//  * Читает лог, парсит ошибки, обновляет диагностику и удаляет временные файлы.
//  * @param logFilePath Путь к временному лог-файлу.
//  * @param batFilePath Путь к временному bat-файлу.
//  * @param compiledFileUris Массив URI скомпилированных файлов.
//  */
// function processBuildResult(logFilePath: string | undefined, batFilePath: string | undefined, compiledFileUris: Uri[]): void {
//   let outputLog = '';
//   if (logFilePath && fs.existsSync(logFilePath)) {
//       try {
//           outputLog = fs.readFileSync(logFilePath, 'utf8');
//           console.log(`Read log file (${logFilePath}), content length: ${outputLog.length}`);
//       } catch (readErr) { console.error(`Failed to read log file ${logFilePath}: ${readErr}`); }
//   } else if (logFilePath) { console.warn(`Log file not found: ${logFilePath}`);}
//   else { console.error("Log file path is missing."); }

//   // --- Очистка временных файлов ---
//   if (logFilePath) { try { fs.unlinkSync(logFilePath); console.log(`Deleted log file: ${logFilePath}`); } catch (err) { console.warn(`Failed to delete log file ${logFilePath}: ${err}`) } }
//   if (batFilePath) { try { fs.unlinkSync(batFilePath); console.log(`Deleted bat file: ${batFilePath}`); } catch (err) { console.warn(`Failed to delete bat file ${batFilePath}: ${err}`) } }
//   // --------------------------------

//   // --- Парсинг и обновление диагностики ---
//   const parsedCompilerDiagnostics = parseCompilerOutput(outputLog);
//   const newCompilerDiagsMap = new Map<string, vscode.Diagnostic[]>();
//   parsedCompilerDiagnostics.forEach(item => {
//       const uriString = item.uri.toString();
//       if (!newCompilerDiagsMap.has(uriString)) newCompilerDiagsMap.set(uriString, []);
//       newCompilerDiagsMap.get(uriString)!.push(item.diagnostic);
//   });

//   // --- Объединяем и Устанавливаем Диагностику ---
//   compiledFileUris.forEach(uri => {
//       const uriString = uri.toString();
//       // Получаем текущие линтерные + возможно старые компиляторные (которые не были очищены, если файл не компилировался)
//       const currentDiags = diagnosticCollection.get(uri) || [];
//       const linterDiags = currentDiags.filter(d => d.source !== COMPILER_DIAGNOSTIC_SOURCE); // Гарантированно берем только линтер
//       const compilerDiags = newCompilerDiagsMap.get(uriString) || []; // Новые от компилятора
//       const finalDiagnostics = [...linterDiags, ...compilerDiags];
//       diagnosticCollection.set(uri, finalDiagnostics);
//       console.log(`Set ${finalDiagnostics.length} diagnostics for compiled file ${uri.fsPath}`);
//   });
//   // Обрабатываем "новые" файлы из диагностики компилятора
//   newCompilerDiagsMap.forEach((compilerDiags, uriString) => {
//       const uri = vscode.Uri.parse(uriString);
//       if (!compiledFileUris.some(cU => cU.toString() === uriString)) { // Если не было в списке компилируемых
//           const currentDiags = diagnosticCollection.get(uri) || [];
//           const linterDiags = currentDiags.filter(d => d.source !== COMPILER_DIAGNOSTIC_SOURCE);
//           const finalDiagnostics = [...linterDiags, ...compilerDiags];
//           diagnosticCollection.set(uri, finalDiagnostics);
//           console.log(`Set ${finalDiagnostics.length} diagnostics for newly added ${uri.fsPath}`);
//       }
//   });
//   // ----------------------------------------
// }


export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}