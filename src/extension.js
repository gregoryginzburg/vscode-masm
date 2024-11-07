const path = require('path');
const vscode = require('vscode');
const { exec } = require('child_process');
const {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} = require('vscode-languageclient/node');

let client;
const lastModifiedMap = new Map(); // Stores last modified timestamps for files
let masmTerminal = null;

function activate(context) {
  // Server module path
  const serverModule = context.asAbsolutePath(path.join('src', 'server.js'));

  // Server options
  const serverOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc }
  };

  // Client options
  const clientOptions = {
    documentSelector: [{ scheme: 'file', language: 'masm' }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/.clientrc')
    }
  };

  // Create the language client and start it
  client = new LanguageClient(
    'masmLanguageServer',
    'MASM Language Server',
    serverOptions,
    clientOptions
  );

  client.start();

  // Register the individual commands
  const runCommand = vscode.commands.registerCommand('extension.runMasmFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active MASM file to run!');
      return;
    }

    const document = editor.document;
    if (document.languageId !== 'masm') {
      vscode.window.showErrorMessage('The current file is not a MASM file!');
      return;
    }

    // Save the file before running
    await document.save();

    // Get the file path and replace the extension with .exe for the output file
    const filePath = document.fileName;
    const outputFilePath = filePath.replace(path.extname(filePath), '.exe');

    // Check if the file has been modified since the last build
    const fileStats = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    const lastModified = fileStats.mtime;

    if (lastModifiedMap.has(filePath) && lastModifiedMap.get(filePath) === lastModified) {
      vscode.window.showInformationMessage('No changes detected. Using existing executable.');
      // executeTerminal(outputFilePath);
      executeExternalConsole(outputFilePath);
    } else {
      lastModifiedMap.set(filePath, lastModified);

      // Find and execute the build task ("Link")
      try {
        const tasks = await vscode.tasks.fetchTasks();
        const linkTask = tasks.find(task => task.name === 'Link');

        if (linkTask) {
          // Execute the task and listen for its completion
          const taskExecution = await vscode.tasks.executeTask(linkTask);

          const disposable = vscode.tasks.onDidEndTaskProcess((event) => {
            if (event.execution === taskExecution) {
              if (event.exitCode === 0) {
                vscode.window.showInformationMessage('Link task executed successfully!');
                // executeTerminal(outputFilePath);
                executeExternalConsole(outputFilePath);
              } else {
                vscode.window.showErrorMessage('Link task failed. Please check the output for details.');
              }
              disposable.dispose(); // Dispose of the listener once handled
            }
          });
        } else {
          vscode.window.showErrorMessage('Link task not found!');
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Error fetching or executing tasks: ${error}`);
      }
    }
  });

  // Register the Debug command
  const debugCommand = vscode.commands.registerCommand('extension.debugMasmFile', async () => {
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

    // Get the file path and replace the extension with .exe for the output file
    const filePath = document.fileName;
    const outputFilePath = filePath.replace(path.extname(filePath), '.exe');

    // Check if the file has been modified since the last build
    const fileStats = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    const lastModified = fileStats.mtime;

    if (lastModifiedMap.has(filePath) && lastModifiedMap.get(filePath) === lastModified) {
      vscode.window.showInformationMessage('No changes detected. Using existing executable.');
      launchDebugger(outputFilePath);
    } else {
      lastModifiedMap.set(filePath, lastModified);

      // Find and execute the build task ("Link")
      try {
        const tasks = await vscode.tasks.fetchTasks();
        const linkTask = tasks.find(task => task.name === 'Link');

        if (linkTask) {
          // Execute the task and listen for its completion
          const taskExecution = await vscode.tasks.executeTask(linkTask);

          const disposable = vscode.tasks.onDidEndTaskProcess((event) => {
            if (event.execution === taskExecution) {
              if (event.exitCode === 0) {
                vscode.window.showInformationMessage('Link task executed successfully!');
                launchDebugger(outputFilePath);
              } else {
                vscode.window.showErrorMessage('Link task failed. Please check the output for details.');
              }
              disposable.dispose(); // Dispose of the listener once handled
            }
          });
        } else {
          vscode.window.showErrorMessage('Link task not found!');
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Error fetching or executing tasks: ${error}`);
      }
    }
  });

  // Helper function to execute the terminal
  function executeTerminal(executablePath) {
    // Check if the terminal already exists and is still active
    if (!masmTerminal || masmTerminal.exitStatus) {
      masmTerminal = vscode.window.createTerminal({
        name: 'Run MASM',
        shellPath: 'cmd.exe', // Use CMD as the shell
        shellArgs: ['/K'],    // Keep the terminal open after the command runs
        cwd: path.dirname(executablePath)
      });
    } else {
      // If the terminal is active, just change its working directory
      // masmTerminal.sendText(`cd /d "${path.dirname(executablePath)}"`);
    }

    // Run the executable in the terminal
    masmTerminal.sendText(`"${executablePath}"`);
    masmTerminal.show();
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



  // Helper function to launch the debugger
  function launchDebugger(executablePath) {
    vscode.debug.startDebugging(undefined, {
      name: "Debug MASM Program",
      type: "masm",
      request: "launch",
      program: executablePath,
      args: [],
      stopOnEntry: true,
      debugServer: 19021,
      // preLaunchTask: "Link"
    }).then(
      success => {
        if (!success) {
          vscode.window.showErrorMessage('Failed to start the debugger.');
        }
      },
      err => {
        vscode.window.showErrorMessage(`Debugging failed: ${err.message}`);
      }
    );
  }


  const runCodeAnalysisCommand = vscode.commands.registerCommand('extension.runCodeAnalysis', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active MASM file!');
        return;
    }

    if (editor.document.languageId !== 'masm') {
        vscode.window.showErrorMessage('The current file is not a MASM file!');
        return;
    }

    // Send a custom request to the server
    client.sendRequest('custom/runCodeAnalysis', { uri: editor.document.uri.toString() });
});

  // Add to context subscriptions
  context.subscriptions.push(client);
  context.subscriptions.push(runCommand);
  context.subscriptions.push(debugCommand);
  context.subscriptions.push(runCodeAnalysisCommand);
}

function deactivate() {
  if (!client) {
    return undefined;
  }
  return client.stop();
}

module.exports = {
  activate,
  deactivate
};
