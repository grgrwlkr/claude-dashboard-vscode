// A stand-in for the `vscode` module, enough of it to run activate() under
// `node --test`. Only what extension.js touches is implemented; anything it
// starts using and this does not have will fail loudly rather than silently.

const fs = require('node:fs');

const items = [];
const panels = [];
const errors = [];
const updates = [];
const commands = new Map();
const views = new Map();
const listeners = { config: [], window: [] };
let settings = {};
let saveTarget;

const disposable = () => ({ dispose() {} });

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
    Uri: { file: (fsPath) => ({ fsPath, scheme: 'file' }) },
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
        createTreeView(id, opts) { views.set(id, opts.treeDataProvider); return disposable(); },
        showQuickPick: async () => undefined,
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
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
    },
    env: { clipboard: { writeText: async () => {} } },
};

// --- helpers for the tests --------------------------------------------------

vscode.__items = items;
vscode.__panels = panels;
vscode.__errors = errors;
vscode.__updates = updates;
vscode.__commands = commands;
vscode.__views = views;
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
    updates.length = 0;
    commands.clear();
    views.clear();
    listeners.config.length = 0;
    listeners.window.length = 0;
    settings = {};
    saveTarget = undefined;
    vscode.workspace.workspaceFolders = undefined;
};

module.exports = vscode;
