const test = require('node:test');
const assert = require('node:assert');
const d = require('../settingsDocs');
const snapshot = require('../claude-settings-registry.json');

// A page shaped like the real one, small enough to read. Every quirk here was
// taken from the live document: the default written as a sentence, a version
// gate, the managed-only marker, links in prose, and a table that is not the
// one we want sitting above the one we do.
const PAGE = `# Claude Code settings

## Settings files

### Invalid entries in managed settings

| Key | Behavior |
| :-- | :------- |
| \`availableModels\` | Enforced as an empty allowlist. |

### Available settings

| Key | Description | Example |
| :-- | :---------- | :------ |
| \`cleanupPeriodDays\` | **Default**: \`30\` days, minimum \`1\`. Claude Code deletes [session files](/docs/en/claude-directory) older than this. | \`20\` |
| \`autoCompactEnabled\` | **Default**: \`true\`. Compact the conversation when context fills. | \`false\` |
| \`forceWorkspaceDir\` | (Managed settings only) Pin sessions to a directory. Requires Claude Code v2.1.175 or later | \`"~/src"\` |
| \`model\` | Override the default model. \`--model\` overrides this for one session | \`"opus"\` |
| a stray prose row | that starts without a key | |

### Worktree settings

| Key | Description |
| :-- | :---------- |
| \`worktree.baseRef\` | Which ref new worktrees branch from. |

### Global config settings

| Key | Description |
| :-- | :---------- |
| \`autoConnectIde\` | **Default**: \`false\`. Connect to a running IDE. |
`;

const ENV_PAGE = `# Environment variables

## Variables

| Variable | Purpose |
| :------- | :------ |
| \`ANTHROPIC_API_KEY\` | API key sent as the \`X-Api-Key\` header. |
| \`MAX_THINKING_TOKENS\` | Fixed token budget for extended thinking. |
`;

// The settings page was a table until 2026-08; it is now one section per key,
// with the facts in bullets under a prose paragraph. Every shape here is taken
// from the live document: a default written as a bare value, one written as a
// sentence with no value at all, a scope that makes the key managed-only, a
// scope that puts the key in a different file, and a version gate.
const REF_PAGE = `# Claude Code settings reference

## All settings

| Key | Description | Topic | Scope |
| :-- | :---------- | :---- | :---- |
| [\`cleanupPeriodDays\`](#cleanupperioddays) | Delete old session files | Memory and context | Any file |

## Memory and context

### \`cleanupPeriodDays\`

How long Claude Code keeps [session files](/docs/en/claude-directory) before deleting them.

* **Scope**: [\`Any file\`](#scopes)
* **Type**: number of days, minimum \`1\`
* **Default**: \`30\`

### \`forceWorkspaceDir\`

Pin sessions to a directory. Requires Claude Code v2.1.175 or later.

* **Scope**: [\`Managed\`](#scopes)
* **Type**: string
* **Default**: unset, so sessions run where they are launched

## Agents, sessions, and worktrees

### \`worktree.baseRef\`

Which ref new worktrees branch from.

* **Scope**: [\`Any file\`](#scopes)
* **Type**: string
* **Default**: \`"HEAD"\`

## Global config settings

### \`autoConnectIde\`

Connect to a running IDE automatically.

* **Scope**: [\`Global config\`](#scopes)
* **Type**: Boolean
* **Default**: \`false\`
`;

test('a cell keeps an escaped pipe, and the row loses its rails', () => {
    assert.deepEqual(d.splitRow('| a | b \\| c | d |'), ['a', 'b | c', 'd']);
});

test('a section stops at the next heading of its level', () => {
    const lines = d.sectionLines(REF_PAGE, 'Memory and context');
    assert.ok(lines.some((l) => l.includes('cleanupPeriodDays')));
    assert.ok(!lines.some((l) => l.includes('autoConnectIde')), 'ran past its own section');
});

test('a heading that is not there yields nothing, rather than the whole page', () => {
    assert.deepEqual(d.sectionLines(REF_PAGE, 'Available settings'), []);
});

// A key documented without a `**Default**` bullet has no default, and saying
// its type is "string" because the value looks like one would be a guess. The
// tab has to tell "no default" from "defaults to empty".
test('a key with no default bullet keeps both fields empty', () => {
    const page = REF_PAGE + `
### \`model\`

Override the default model.

* **Scope**: [\`Any file\`](#scopes)
`;
    const entry = d.parseSettingsDoc(page).find((e) => e.key === 'model');
    assert.equal(entry.default, '');
    assert.equal(entry.type, '');
    assert.equal(entry.defaultNote, '');
});

// The page opens with an `All settings` table that links to every key. It
// carries no default, no type and no scope — reading it would double every
// entry and halve what each one says.
test('the index table at the top of the page is not read as entries', () => {
    const entries = d.parseSettingsDoc(REF_PAGE);
    assert.equal(entries.filter((e) => e.key === 'cleanupPeriodDays').length, 1);
    assert.ok(!entries.some((e) => e.key.includes('](')), 'read a link cell as a key');
    assert.ok(entries.some((e) => e.key === 'worktree.baseRef'), 'worktree keys live in settings.json too');
});

// The failure this guards against is the one that cannot be seen: a docs
// restructure drops the per-key sections, everything comes back empty, and the
// tab reports that nothing can be configured — which reads exactly like a
// machine with nothing configured.
test('a restructured page fails loudly instead of yielding an empty registry', () => {
    const flattened = REF_PAGE.replace(/^### /gm, '#### ');
    assert.throws(
        () => d.buildRegistry({ settingsMd: flattened, envMd: ENV_PAGE }),
        /settings table yielded 0 rows/,
    );
    assert.throws(
        () => d.buildRegistry({ settingsMd: REF_PAGE, envMd: '# nothing here' }),
        /env table yielded 0 rows/,
    );
});

// The snapshot ships inside the .vsix and is what every offline machine sees.
// A broken one is invisible until someone opens the tab.
test('the committed snapshot is a whole registry', () => {
    assert.match(snapshot.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(snapshot.settings.length > 100, `only ${snapshot.settings.length} settings`);
    assert.ok(snapshot.env.length > 200, `only ${snapshot.env.length} variables`);
    for (const entry of [...snapshot.settings, ...snapshot.globalConfig, ...snapshot.env]) {
        assert.ok(entry.key, 'an entry with no key');
        assert.ok(entry.description, `${entry.key} has no description`);
        assert.ok(!entry.description.includes(']('), `${entry.key} kept a markdown link`);
    }
    // Keys everyone has an opinion about, with the defaults the docs state.
    const byKey = Object.fromEntries(snapshot.settings.map((e) => [e.key, e]));
    assert.equal(byKey.autoCompactEnabled.default, 'true');
    assert.equal(byKey.cleanupPeriodDays.default, '30');
    assert.ok(byKey.env, 'the env block is itself a documented setting');
});


test('the reference page yields one entry per key section', () => {
    const settings = d.parseSettingsDoc(REF_PAGE);
    const keys = settings.map((e) => e.key);
    assert.deepEqual(keys.sort(), ['cleanupPeriodDays', 'forceWorkspaceDir', 'worktree.baseRef']);
    // The `All settings` index table lists every key too; counting it as well
    // would double each entry.
    assert.equal(settings.filter((e) => e.key === 'cleanupPeriodDays').length, 1);
});

test('an entry carries the facts from its bullets, not from prose', () => {
    const byKey = Object.fromEntries(d.parseSettingsDoc(REF_PAGE).map((e) => [e.key, e]));

    const cleanup = byKey.cleanupPeriodDays;
    assert.equal(cleanup.default, '30');
    assert.equal(cleanup.type, 'number of days, minimum `1`');
    assert.equal(cleanup.file, 'settings.json');
    assert.equal(cleanup.managedOnly, false);
    assert.ok(cleanup.description.startsWith('How long Claude Code keeps session files'), cleanup.description);

    // A default written as a sentence has no value to show, so the sentence is
    // the note and the value stays empty rather than becoming the word "unset".
    const forced = byKey.forceWorkspaceDir;
    assert.equal(forced.default, '');
    assert.equal(forced.defaultNote, 'unset, so sessions run where they are launched');
    assert.equal(forced.managedOnly, true);
    assert.equal(forced.since, '2.1.175');
});

test('a global-config key is filed where it actually goes', () => {
    const settings = d.parseSettingsDoc(REF_PAGE);
    assert.ok(!settings.some((e) => e.key === 'autoConnectIde'), 'global config key filed as a settings.json key');
    const globalConfig = d.parseGlobalConfigDoc(REF_PAGE);
    assert.deepEqual(globalConfig.map((e) => e.key), ['autoConnectIde']);
    assert.equal(globalConfig[0].file, '~/.claude.json');
    assert.equal(globalConfig[0].default, 'false');
});
