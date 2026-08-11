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

test('a cell keeps an escaped pipe, and the row loses its rails', () => {
    assert.deepEqual(d.splitRow('| a | b \\| c | d |'), ['a', 'b | c', 'd']);
});

test('a section stops at the next heading of its level', () => {
    const lines = d.sectionLines(PAGE, 'Available settings');
    assert.ok(lines.some((l) => l.includes('cleanupPeriodDays')));
    assert.ok(!lines.some((l) => l.includes('worktree.baseRef')), 'ran past its own section');
});

test('a heading that is not there yields nothing, rather than the whole page', () => {
    assert.deepEqual(d.sectionLines(PAGE, 'Settings reference'), []);
});

test('the default is a sentence, and comes out as value plus note', () => {
    const byKey = Object.fromEntries(d.parseSettingsDoc(PAGE).map((e) => [e.key, e]));

    assert.equal(byKey.cleanupPeriodDays.default, '30');
    assert.equal(byKey.cleanupPeriodDays.type, 'number');
    assert.equal(byKey.cleanupPeriodDays.defaultNote, 'days, minimum `1`');
    // The description must not open with the tail of the default sentence.
    assert.match(byKey.cleanupPeriodDays.description, /^Claude Code deletes/);
    // A link is unfollowable in a table cell, so only its text survives.
    assert.match(byKey.cleanupPeriodDays.description, /session files older than this/);

    assert.equal(byKey.autoCompactEnabled.type, 'boolean');
    assert.equal(byKey.model.default, '', 'no documented default is not a default of ""');
    assert.equal(byKey.model.type, '');
});

test('managed-only and the version gate are read off the row', () => {
    const forced = d.parseSettingsDoc(PAGE).find((e) => e.key === 'forceWorkspaceDir');
    assert.equal(forced.managedOnly, true);
    assert.equal(forced.since, '2.1.175');
    assert.ok(!forced.description.includes('Managed settings only'));
});

test('the table above the one we want is not read', () => {
    const keys = d.parseSettingsDoc(PAGE).map((e) => e.key);
    // `availableModels` appears only in the invalid-entries table.
    assert.ok(!keys.includes('availableModels'), 'read a neighbouring table');
    assert.ok(!keys.some((k) => k.includes('stray')), 'read a row with no key');
    assert.ok(keys.includes('worktree.baseRef'), 'worktree keys live in settings.json too');
});

test('global config is a different file, and says so', () => {
    const [entry] = d.parseGlobalConfigDoc(PAGE);
    assert.equal(entry.key, 'autoConnectIde');
    assert.equal(entry.file, '~/.claude.json');
    assert.equal(d.parseSettingsDoc(PAGE).find((e) => e.key === 'autoConnectIde'), undefined);
});

// The failure this guards against is the one that cannot be seen: a docs
// restructure renames the heading, every table comes back empty, and the tab
// reports that nothing can be configured — which reads exactly like a machine
// with nothing configured.
test('a renamed heading fails loudly instead of yielding an empty registry', () => {
    const renamed = PAGE.replace('### Available settings', '### Settings reference');
    assert.throws(
        () => d.buildRegistry({ settingsMd: renamed, envMd: ENV_PAGE }),
        /settings table yielded 1 rows/,
    );
    assert.throws(
        () => d.buildRegistry({ settingsMd: PAGE, envMd: '# nothing here' }),
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
