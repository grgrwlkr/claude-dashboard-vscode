const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Run separately from the dependency-free suite: `node --test test/packaging.js`
// needs the same @vscode/vsce installation or npm cache as the packaging job.
// --no-install prevents a test run from downloading tools behind the caller's back.
const files = execFileSync('npx', ['--no-install', '@vscode/vsce', 'ls', '--no-dependencies'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
}).trim().split(/\r?\n/);

test('the VSIX excludes repository instructions and their archives', () => {
    const instructions = files.filter((file) =>
        /(^|\/)(AGENTS\.md|CLAUDE\.md)$/.test(file)
        || /^(\.agents|\.codex|\.claude)\//.test(file));
    assert.deepStrictEqual(instructions, []);
});

test('the VSIX keeps the extension runtime and the assets its editor loads', () => {
    const required = [
        'package.json', 'extension.js', 'usage.js', 'session.js', 'indexer.js',
        'index-worker.js', 'pricing.js', 'history.js', 'system.js', 'segments.js',
        'status.js', 'workflows.js', 'clientSettings.js', 'settingsDocs.js',
        'dashboard.js', 'dashboard.css', 'claude-settings-registry.json',
        'media/icon.png', 'media/icon.svg', 'media/bar-icon.svg',
        'media/open-claude-dark.svg', 'media/open-claude-light.svg',
        'README.md', 'CHANGELOG.md', 'LICENSE',
    ];
    assert.deepStrictEqual(required.filter((file) => !files.includes(file)), []);
});
