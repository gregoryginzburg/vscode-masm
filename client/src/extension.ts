import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import * as vscode from 'vscode';
import { workspace, ExtensionContext, tasks, Task, TaskScope } from 'vscode';

import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

const defaultBuildTaskDefinition = {
  type: 'masmbuild',
  label: 'Build',
  files: ['${workspaceFolder}\\${fileBasenameNoExtension}.asm'],
  output: '${workspaceFolder}\\${fileBasenameNoExtension}.exe',
  compilerArgs: [
    "/c",
    "/coff",
    "/Zi",
    "/Fl",
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
  program: '${workspaceFolder}/${fileBasenameNoExtension}.exe',
};

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
 * (B) Actually build up the multiline ShellExecution for compile+link,
 *     using user/workspace settings for compilerPath, linkerPath, etc.
 */
function createRealShellExecution(def: MasmbuildTaskDefinition): vscode.ShellExecution {
  // 1) Get user/workspace settings
  const config = vscode.workspace.getConfiguration('masm');
  const compilerPath = config.get<string>('compilerPath', 'ml.exe');
  const linkerPath = config.get<string>('linkerPath', 'link.exe');
  const includePaths = config.get<string[]>('includePaths', []);
  const libPaths = config.get<string[]>('libPaths', []);


  // 2) Validate required fields
  if (!def.files || def.files.length === 0) {
    throw new Error('MASM build task: "files" must be a non-empty array.');
  }
  if (!def.output || !def.output.trim()) {
    throw new Error('MASM build task: "output" must be a valid string.');
  }

  const compilerArgs = def.compilerArgs || [];
  const linkerArgs = def.linkerArgs || [];

  // 3) Build compile commands
  const includeFlags = includePaths.map(dir => `/I "${dir}"`);
  const libFlags = libPaths.map(dir => `/LIBPATH:"${dir}"`);
  const compileLines: string[] = [];

  for (const asmFile of def.files) {
    const cmd = `"${compilerPath}" /c ${includeFlags.join(' ')} ${compilerArgs.join(' ')} "${asmFile}"`;
    compileLines.push(cmd);
  }

  // 4) Build link command
  //    For each .asm file, we produce a .obj filename
  const objFiles = def.files.map(asm => {
    const base = path.basename(asm, path.extname(asm));
    return `"${path.join(path.dirname(asm), base + '.obj')}"`;
  });
  const linkLine = `"${linkerPath}" ${objFiles.join(' ')} ${libFlags.join(' ')} /OUT:"${def.output}" ${linkerArgs.join(' ')}`;

  // 5) Multi-line shell script
  const shellCmd = compileLines.join(' && ') + ' && ' + linkLine;

  // Return a ShellExecution that runs them in sequence
  return new vscode.ShellExecution(shellCmd);
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

  const document = editor.document;
  if (document.languageId !== 'masm') {
    vscode.window.showErrorMessage('The current file is not a MASM file!');
    return;
  }

  // Save the file before running
  await document.save();

  await ensureTasksJsonExists();

  const buildTaskLabel = 'Build';
  const masmTasks = await vscode.tasks.fetchTasks({ type: 'masmbuild' });
  let buildTask = masmTasks.find(t => t.name === buildTaskLabel);

  if (!buildTask) {
    const definition: MasmbuildTaskDefinition = defaultBuildTaskDefinition;

    buildTask = new vscode.Task(
      definition,
      vscode.TaskScope.Workspace,        // or TaskScope.Global
      buildTaskLabel,                    // name/label
      'masmbuild',                       // source
      createRealShellExecution(definition)
    );
  }
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
  if (exitCode !== 0) {
    vscode.window.showErrorMessage(`Build failed with exit code ${exitCode}.`);
    return;
  }

  const filePath = document.fileName;
  const outputFilePath = filePath.replace(path.extname(filePath), '.exe');
  executeExternalConsole(outputFilePath);

}

function executeExternalConsole(executablePath) {
  // Use child_process to open a new command prompt and run the executable
  const command = `start cmd.exe /V:ON /C "${executablePath} & echo. & echo. & echo ------------------ & echo (program exited with code: !ERRORLEVEL!) & <nul set /p=Press any key to close this window . . . & pause >nul"`;


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

  const document = editor.document;
  if (document.languageId !== 'masm') {
    vscode.window.showErrorMessage('The current file is not a MASM file!');
    return;
  }

  // Save the file before debugging
  await document.save();

  await ensureTasksJsonExists();

  const buildTaskLabel = 'Build';
  const masmTasks = await vscode.tasks.fetchTasks({ type: 'masmbuild' });
  let buildTask = masmTasks.find(t => t.name === buildTaskLabel);

  if (!buildTask) {
    const definition: MasmbuildTaskDefinition = defaultBuildTaskDefinition;

    buildTask = new vscode.Task(
      definition,
      vscode.TaskScope.Workspace,        // or TaskScope.Global
      buildTaskLabel,                    // name/label
      'masmbuild',                       // source
      createRealShellExecution(definition)
    );
  }

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
  if (exitCode !== 0) {
    vscode.window.showErrorMessage(`Build failed with exit code ${exitCode}. Aborting debug.`);
    return;
  }

  vscode.debug.startDebugging(undefined, defaultDebugConfig);
}


export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}