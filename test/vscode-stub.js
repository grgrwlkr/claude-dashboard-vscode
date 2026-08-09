// A stand-in for the `vscode` module, enough of it to run activate() under
// `node --test`. Only what extension.js touches is implemented; anything it
// starts using and this does not have will fail loudly rather than silently.

const items = [];
const commands = new Map();
const listeners = { config: [], window: [] };
let settings = {};

const disposable = () => ({ dispose() {} });

const vscode = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class { constructor(id) { this.id = id; } },
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
        showQuickPick: async () => undefined,
        showInformationMessage: async () => undefined,
        withProgress: async (_opts, task) => task({ report() {} }),
        createWebviewPanel: () => ({ webview: { html: '', onDidReceiveMessage() {} }, onDidDispose() {}, reveal() {} }),
    },
    workspace: {
        workspaceFolders: undefined,
        getConfiguration: () => ({ get: (key) => settings[key] }),
        onDidChangeConfiguration(cb) { listeners.config.push(cb); return disposable(); },
    },
    commands: {
        registerCommand(id, fn) { commands.set(id, fn); return disposable(); },
    },
    env: { clipboard: { writeText: async () => {} } },
};

// --- helpers for the tests --------------------------------------------------

vscode.__items = items;
vscode.__commands = commands;
vscode.__setSettings = (next) => { settings = next; };
vscode.__setWorkspace = (folder) => {
    vscode.workspace.workspaceFolders = folder ? [{ uri: { fsPath: folder } }] : undefined;
};
vscode.__changeConfiguration = () => {
    for (const cb of listeners.config) cb({ affectsConfiguration: () => true });
};
vscode.__reset = () => {
    items.length = 0;
    commands.clear();
    listeners.config.length = 0;
    listeners.window.length = 0;
    settings = {};
    vscode.workspace.workspaceFolders = undefined;
};

module.exports = vscode;
