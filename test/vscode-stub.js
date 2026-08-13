// A stand-in for the `vscode` module, enough of it to run activate() under
// `node --test`. Only what extension.js touches is implemented; anything it
// starts using and this does not have will fail loudly rather than silently.

const fs = require('node:fs');

const items = [];
const panels = [];
const errors = [];
const warnings = [];
const updates = [];
const commands = new Map();
const executed = [];
const installed = new Map();
const terminals = [];
const views = new Map();
const listeners = { config: [], window: [], integration: [], ended: [], closed: [], activeTerminal: [] };
let settings = {};
let saveTarget;
let nextPid;

const disposable = () => ({ dispose() {} });
// A real subscription stops being called once disposed, and code that disposes
// its listeners is exactly what a stub handing out no-op disposables cannot
// check.
const subscribe = (list, cb) => {
    list.push(cb);
    return { dispose() { const at = list.indexOf(cb); if (at !== -1) list.splice(at, 1); } };
};

const vscode = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class { constructor(id) { this.id = id; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    TreeItem: class {
        constructor(label, collapsibleState) {
            this.label = label;
            this.collapsibleState = collapsibleState;
        }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    EventEmitter: class {
        constructor() {
            this.listeners = [];
            this.event = (cb) => { this.listeners.push(cb); return disposable(); };
        }

        fire(value) { for (const cb of this.listeners) cb(value); }
    },
    Uri: {
        file: (fsPath) => ({ fsPath, scheme: 'file' }),
        joinPath: (uri, ...parts) => ({ fsPath: [uri.fsPath, ...parts].join('/'), scheme: 'file' }),
    },
    MarkdownString: class {
        constructor(value = '', supportThemeIcons = false) {
            this.value = value;
            this.supportThemeIcons = supportThemeIcons;
        }

        appendMarkdown(text) { this.value += text; return this; }
    },
    ProgressLocation: { Notification: 15 },
    ViewColumn: { Active: -1 },
    window: {
        createStatusBarItem(id, alignment, priority) {
            const item = {
                id, alignment, priority, name: '', command: '', text: '',
                tooltip: null, backgroundColor: undefined, visible: false, disposed: false,
                show() { this.visible = true; },
                hide() { this.visible = false; },
                dispose() { this.disposed = true; items.splice(items.indexOf(this), 1); },
            };
            items.push(item);
            return item;
        },
        onDidChangeWindowState(cb) { listeners.window.push(cb); return disposable(); },
        // A terminal as the extension uses it: what it was created with, whether
        // it was shown, and what was run in it. The three terminal events are
        // driven by the helpers below, so a test can play the shell's half.
        activeTerminal: undefined,
        onDidChangeActiveTerminal: (cb) => subscribe(listeners.activeTerminal, cb),
        createTerminal(options) {
            const terminal = {
                options,
                name: options.name,
                shown: 0,
                sent: [],
                executed: [],
                disposed: false,
                shellIntegration: undefined,
                // The real one resolves once the process is up, and a caller
                // subscribes to it as the terminal is created — so the pid has
                // to be decided before that, with `__nextTerminalPid`.
                processId: Promise.resolve(nextPid),
                show() { this.shown++; },
                sendText(text) { this.sent.push(text); },
                dispose() {
                    this.disposed = true;
                    for (const cb of [...listeners.closed]) cb(this);
                },
            };
            terminals.push(terminal);
            return terminal;
        },
        onDidChangeTerminalShellIntegration: (cb) => subscribe(listeners.integration, cb),
        onDidEndTerminalShellExecution: (cb) => subscribe(listeners.ended, cb),
        onDidCloseTerminal: (cb) => subscribe(listeners.closed, cb),
        createTreeView(id, opts) { views.set(id, opts.treeDataProvider); return disposable(); },
        showQuickPick: async () => undefined,
        showInformationMessage: async () => undefined,
        showWarningMessage: async (message) => { warnings.push(message); },
        showTextDocument: async () => undefined,
        showSaveDialog: async () => saveTarget,
        withProgress: async (_opts, task) => task({ report() {} }),
        createWebviewPanel() {
            // The panel records what the extension posts back and hands over the
            // listener, so a test can play the webview's half of the exchange.
            const panel = {
                // The real panel reports whether the tab is on screen; the timed
                // refresh reads it to leave a hidden page alone.
                visible: true,
                webview: {
                    html: '',
                    posted: [],
                    onDidReceiveMessage(cb) { panel.__receive = cb; },
                    postMessage(msg) { panel.webview.posted.push(msg); return Promise.resolve(true); },
                },
                onDidDispose(cb) { panel.__dispose = cb; },
                // The editor fires this whenever the tab is shown or hidden; a
                // test drives it by flipping `visible` and calling __viewState.
                onDidChangeViewState(cb) { panel.__viewState = cb; },
                reveal() {},
                dispose() { if (panel.__dispose) panel.__dispose(); },
            };
            panels.push(panel);
            return panel;
        },
        showErrorMessage: async (message) => { errors.push(message); },
    },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    workspace: {
        workspaceFolders: undefined,
        getConfiguration: () => ({
            get: (key) => settings[key],
            // Writes are recorded rather than applied: what matters in a test is
            // which key went into which scope, not that a file changed.
            update: async (key, value, target) => { updates.push({ key, value, target }); settings[key] = value; },
        }),
        onDidChangeConfiguration(cb) { listeners.config.push(cb); return disposable(); },
        // The real one rejects on a file that is not there, and a caller that
        // does not expect it ends the command in an unhandled rejection. A stub
        // that opens anything would let that ship.
        openTextDocument: async (uri) => {
            if (!fs.existsSync(uri.fsPath)) throw new Error(`Unable to resolve non-existing file '${uri.fsPath}'`);
            return { uri };
        },
    },
    commands: {
        registerCommand(id, fn) { commands.set(id, fn); return disposable(); },
        // Recorded rather than dispatched: these go to VS Code's own commands,
        // which no stub can run. What a test can check is that the right one was
        // asked for, with the right argument.
        executeCommand: async (id, ...args) => { executed.push({ id, args }); },
    },
    extensions: {
        getExtension: (id) => installed.get(id),
    },
    env: { clipboard: { writeText: async () => {} } },
};

// --- helpers for the tests --------------------------------------------------

vscode.__items = items;
vscode.__panels = panels;
vscode.__errors = errors;
vscode.__warnings = warnings;
vscode.__updates = updates;
vscode.__commands = commands;
vscode.__executed = executed;
vscode.__terminals = terminals;
vscode.__views = views;
// Another extension as VS Code hands it over. Only `extensionUri` is used here —
// the tab icon is looked for inside it.
vscode.__installExtension = (id, extensionPath) => {
    installed.set(id, { id, extensionUri: { fsPath: extensionPath, scheme: 'file' } });
};
// The shell's half of a terminal's life, in the order a real one goes through
// it: integration appears, a command ends with a status.
vscode.__shellIntegrationArrives = (terminal) => {
    terminal.shellIntegration = { executeCommand: (line) => terminal.executed.push(line) };
    for (const cb of [...listeners.integration]) cb({ terminal, shellIntegration: terminal.shellIntegration });
};
vscode.__shellExecutionEnds = (terminal, commandLine, exitCode = 0) => {
    for (const cb of [...listeners.ended]) cb({ terminal, execution: { commandLine: { value: commandLine } }, exitCode });
};
// The pid the next terminal's shell will report, which is what ties a tab to a
// session. Set before opening one: the pid is subscribed to at creation.
vscode.__nextTerminalPid = (pid) => { nextPid = pid; };
vscode.__activateTerminal = (terminal) => {
    vscode.window.activeTerminal = terminal;
    for (const cb of [...listeners.activeTerminal]) cb(terminal);
};
vscode.__setSettings = (next) => { settings = next; };
vscode.__setSaveTarget = (uri) => { saveTarget = uri; };
vscode.__setWorkspace = (folder) => {
    vscode.workspace.workspaceFolders = folder ? [{ uri: { fsPath: folder } }] : undefined;
};
vscode.__changeConfiguration = (key) => {
    // A real event answers per key. Without an argument every key matches, which
    // is what the older callers expect; with one, only that key does — the
    // difference a listener that re-arms a timer on one setting depends on.
    for (const cb of listeners.config) {
        cb({ affectsConfiguration: (asked) => (key ? String(key).startsWith(asked) : true) });
    }
};
vscode.__focusWindow = (focused = true) => {
    for (const cb of listeners.window) cb({ focused });
};
vscode.__reset = () => {
    items.length = 0;
    panels.length = 0;
    errors.length = 0;
    warnings.length = 0;
    updates.length = 0;
    commands.clear();
    executed.length = 0;
    installed.clear();
    terminals.length = 0;
    views.clear();
    listeners.config.length = 0;
    listeners.window.length = 0;
    listeners.integration.length = 0;
    listeners.ended.length = 0;
    listeners.closed.length = 0;
    listeners.activeTerminal.length = 0;
    vscode.window.activeTerminal = undefined;
    settings = {};
    saveTarget = undefined;
    nextPid = undefined;
    vscode.workspace.workspaceFolders = undefined;
};

module.exports = vscode;
