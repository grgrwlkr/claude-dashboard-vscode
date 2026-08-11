const test = require('node:test');
const assert = require('node:assert');
const cs = require('../clientSettings');

const file = (scope, data, documented = true) => ({
    scope, path: `/fake/${scope}.json`, documented, exists: data !== null, data,
});

const REGISTRY = {
    checkedAt: '2026-08-11',
    settings: [
        { key: 'autoCompactEnabled', file: 'settings.json', type: 'boolean', default: 'true', defaultNote: '', description: 'Compact when context fills.', managedOnly: false, since: '' },
        { key: 'autoUpdatesChannel', file: 'settings.json', type: 'string', default: '"latest"', defaultNote: '', description: 'Release channel.', managedOnly: false, since: '' },
        { key: 'cleanupPeriodDays', file: 'settings.json', type: 'number', default: '30', defaultNote: 'days', description: 'Delete old sessions.', managedOnly: false, since: '' },
        { key: 'model', file: 'settings.json', type: '', default: '', defaultNote: '', description: 'Default model.', managedOnly: false, since: '' },
        { key: 'forceWorkspaceDir', file: 'settings.json', type: '', default: '', defaultNote: '', description: 'Pin sessions to a directory.', managedOnly: true, since: '2.1.175' },
        { key: 'env', file: 'settings.json', type: '', default: '', defaultNote: '', description: 'Environment variables.', managedOnly: false, since: '' },
    ],
    globalConfig: [],
    env: [
        { key: 'ANTHROPIC_API_KEY', file: 'env', type: '', default: '', defaultNote: '', description: 'API key.', managedOnly: false, since: '' },
        { key: 'MAX_THINKING_TOKENS', file: 'env', type: '', default: '', defaultNote: '', description: 'Thinking budget.', managedOnly: false, since: '' },
    ],
};

test('the highest file wins, and false is an answer', () => {
    const chain = [
        file('managed', null),
        file('local', { autoCompactEnabled: false }),
        file('user', { autoCompactEnabled: true, model: 'opus' }),
    ];
    const out = cs.clientSettings({ chain, registry: REGISTRY });
    const auto = out.set.find((e) => e.key === 'autoCompactEnabled');

    assert.equal(auto.value, 'false', 'a later `true` won over an earlier `false`');
    assert.equal(auto.from, 'local');
    assert.deepEqual(auto.shadowed.map((s) => [s.from, s.value]), [['user', 'true']]);
});

test('differing from the default is computed, not assumed', () => {
    const chain = [file('user', {
        autoCompactEnabled: true,          // same as the documented default
        autoUpdatesChannel: 'stable',      // differs from "latest"
        cleanupPeriodDays: 30,             // same, and a number
        model: 'opus',                     // no documented default at all
    })];
    const out = cs.clientSettings({ chain, registry: REGISTRY });
    const by = Object.fromEntries(out.set.map((e) => [e.key, e]));

    assert.equal(by.autoCompactEnabled.differs, false);
    assert.equal(by.cleanupPeriodDays.differs, false, 'a number default is quoted in the docs and must still match');
    assert.equal(by.autoUpdatesChannel.differs, true);
    assert.equal(by.model.differs, false, 'no default means nothing to differ from');
    assert.deepEqual(out.differs.map((e) => e.key), ['autoUpdatesChannel']);
});

test('a key the registry never heard of is its own bucket', () => {
    const chain = [file('user', { autoCompactEnabled: true, someBrandNewKey: 'yes' })];
    const out = cs.clientSettings({ chain, registry: REGISTRY });

    assert.deepEqual(out.unknown.map((e) => e.key), ['someBrandNewKey']);
    assert.deepEqual(out.set.map((e) => e.key), ['autoCompactEnabled']);
    assert.equal(out.unknown[0].differs, false, 'an unknown key can never be said to differ');
});

// The reference documents `worktree.baseRef`; the file holds `worktree` with
// the rest inside it. Read literally that object is a key nobody documented,
// which would put a perfectly ordinary setting in the bucket reserved for
// "shipped after this list was written, or misspelled".
test('a key documented one sub-key at a time is still a known key', () => {
    const registry = {
        ...REGISTRY,
        settings: [...REGISTRY.settings,
            { key: 'worktree.baseRef', file: 'settings.json', type: '', default: '', defaultNote: '', description: 'Which ref.', managedOnly: false, since: '' },
            { key: 'worktree.sparsePaths', file: 'settings.json', type: '', default: '', defaultNote: '', description: 'Paths.', managedOnly: false, since: '' },
        ],
    };
    const out = cs.clientSettings({ chain: [file('user', { worktree: { baseRef: 'fresh' } })], registry });
    assert.deepEqual(out.unknown, []);
    assert.equal(out.set[0].key, 'worktree');
    assert.match(out.set[0].description, /worktree\.baseRef, worktree\.sparsePaths/);
});

test('what is documented and absent, managed-only marked as such', () => {
    const out = cs.clientSettings({ chain: [file('user', { model: 'opus' })], registry: REGISTRY });
    const unset = Object.fromEntries(out.unset.map((e) => [e.key, e]));

    assert.ok(!unset.model, 'a key that is set is not also unset');
    assert.ok(unset.autoCompactEnabled);
    assert.equal(unset.forceWorkspaceDir.managedOnly, true);
    assert.equal(unset.forceWorkspaceDir.since, '2.1.175');
});

// The page is a webview in a published extension: whatever it draws is one
// screenshot away from leaving the machine.
// The other half of the same promise. Inside `env` the keys are the user's own,
// and the ones that hold a credential are mostly not named like one — which is
// the case the name test cannot see, on a page that is a webview in a published
// extension.
test('a value shaped like a credential is masked whatever it is filed under', () => {
    const out = cs.clientSettings({
        chain: [file('user', {
            env: {
                GH_PAT: 'ghp_PLANTEDaaaaaaaaaaaaaaaaaaaaaaaa',
                SLACK_BOT: 'xoxb-PLANTED-11111111-aaaaaaaaaaaa',
                SENTRY_DSN: 'https://PLANTEDcafe1234567890abcdef@o1.ingest.sentry.io/42',
                // A bare hex secret, which is how one actually looks — no word
                // in front of it, or the run would not start at a boundary.
                SESSION_HASH: '0123456789abcdef0123456789abcdefcafe',
                CLAUDE_CODE_SESSION_ID: '99ed2bbb-112f-4486-b479-96ce294db365',
                CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '40',
            },
        })],
        registry: REGISTRY,
        hostEnv: {},
    });

    const blob = JSON.stringify(out);
    assert.ok(!blob.includes('PLANTED'), 'a credential-shaped value reached the rendered data');
    assert.ok(!blob.includes('0123456789abcdef'), 'a bare hex secret reached the rendered data');

    const value = (key) => out.env.fromSettings.find((e) => e.key === key).value;
    for (const key of ['GH_PAT', 'SLACK_BOT', 'SENTRY_DSN', 'SESSION_HASH']) {
        assert.equal(value(key), '•••', `${key} carries a credential and none of its letters say so`);
    }
    // A uuid's hyphens break the hex run, which is what keeps the ids that make
    // this tab useful on the page.
    assert.equal(value('CLAUDE_CODE_SESSION_ID'), '99ed2bbb-112f-4486-b479-96ce294db365');
    assert.equal(value('CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS'), '40');
});

// Where the shape gives nothing away, the name is all there is. A Slack webhook
// URL and a Telegram bot token are long mixed-case strings with no issuer
// prefix — no rule over the value can tell them from a build id, so these four
// names are caught by name, bounded so that PATH and PATTERN are not.
test('a credential whose value has no recognisable shape is caught by its name', () => {
    const out = cs.clientSettings({
        chain: [file('user', {
            env: {
                SLACK_WEBHOOK: 'https://hooks.slack.com/services/T00/B00/PLANTEDAbCdEfGhIjKlMnOp',
                TELEGRAM_BOT: '7123456789:PLANTEDqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
                PATH: '/usr/local/bin:/usr/bin',
                PATTERN: '*.jsonl',
            },
        })],
        registry: REGISTRY,
        hostEnv: {},
    });

    assert.ok(!JSON.stringify(out).includes('PLANTED'), 'a credential named plainly reached the page');
    const value = (key) => out.env.fromSettings.find((e) => e.key === key).value;
    assert.equal(value('SLACK_WEBHOOK'), '•••');
    assert.equal(value('TELEGRAM_BOT'), '•••');
    assert.equal(value('PATH'), '/usr/local/bin:/usr/bin', 'PATH is not a credential for containing "pat"');
    assert.equal(value('PATTERN'), '*.jsonl');
});

test('anything whose name reads like a credential is masked', () => {
    const chain = [file('user', {
        apiKeyHelper: '/usr/local/bin/mint-token',
        env: { ANTHROPIC_API_KEY: 'sk-ant-PLANTED', MAX_THINKING_TOKENS: '0' },
    })];
    const out = cs.clientSettings({
        chain,
        registry: REGISTRY,
        hostEnv: { ANTHROPIC_AUTH_TOKEN: 'PLANTED-TOO', CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '40', PATH: '/bin' },
    });

    const blob = JSON.stringify(out);
    assert.ok(!blob.includes('PLANTED'), 'a planted secret reached the rendered data');
    assert.ok(!blob.includes('mint-token'), 'apiKeyHelper is hidden too — the name is the test');

    const envKey = out.env.fromSettings.find((e) => e.key === 'ANTHROPIC_API_KEY');
    assert.equal(envKey.value, '•••');
    assert.equal(envKey.masked, true);
    const budget = out.env.fromSettings.find((e) => e.key === 'MAX_THINKING_TOKENS');
    assert.equal(budget.value, '0', 'a variable that is not a credential is still readable');

    assert.deepEqual(out.env.fromHost.map((e) => [e.key, e.value]), [
        ['ANTHROPIC_AUTH_TOKEN', '•••'],
        ['CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS', '40'],
    ], 'PATH is not ours to show');
});

test('a value too big for a line is counted instead of printed', () => {
    const rules = { allow: Array.from({ length: 40 }, (_, i) => `Bash(cmd${i}:*)`), deny: [] };
    assert.equal(cs.renderValue('permissions', rules).text, '2 keys: allow, deny');
    assert.equal(cs.renderValue('x', [1, 2]).text, '[1,2]');
    assert.equal(cs.renderValue('x', 'a'.repeat(200)).text.endsWith('…'), true);
});

test('the chain is reported whole, including the files that are not there', () => {
    const out = cs.clientSettings({
        chain: [file('managed', null), file('user local', { permissions: {} }, false), file('user', { model: 'opus' })],
        registry: REGISTRY,
    });
    assert.deepEqual(out.chain.map((f) => [f.scope, f.exists, f.keys, f.documented]), [
        ['managed', false, 0, true],
        ['user local', true, 1, false],
        ['user', true, 1, true],
    ]);
});

test('with no registry it still answers the one question it can', () => {
    const out = cs.clientSettings({ chain: [file('user', { model: 'opus' })] });
    assert.deepEqual(out.unknown.map((e) => e.key), ['model']);
    assert.deepEqual(out.unset, []);
    assert.equal(out.counts.documented, 0);
});

// The masking rule reached three lines without one test calling it directly —
// everything went through clientSettings(). Both directions matter here, and the
// second one more: a rule that hides everything passes any test that only checks
// that secrets are hidden, and turns this tab into a wall of dots.
test('a credential is caught by the shape of its value, by its name, or not at all', () => {
    // By shape, under a name that says nothing.
    assert.equal(cs.renderValue('DEPLOY', `ghp_${'a'.repeat(36)}`).masked, true);
    assert.equal(cs.renderValue('DEPLOY', `sk-ant-${'b'.repeat(40)}`).masked, true);
    // By name, where the value gives nothing away.
    assert.equal(cs.renderValue('GH_PAT', 'true').masked, true);
    assert.equal(cs.renderValue('SLACK_WEBHOOK', 'https://hooks.slack.com/services/T/B/x').masked, true);
    // Neither: the ordinary case, and the one that keeps the page worth opening.
    assert.equal(cs.renderValue('DEPLOY', 'true').masked, false);
    assert.equal(cs.renderValue('CLAUDE_CODE_EXECPATH', '/opt/homebrew/bin/claude').masked, false);
    assert.equal(cs.renderValue('MAX_THINKING_TOKENS', '31999').masked, false);
    assert.equal(cs.renderValue('CLAUDE_CODE_SESSION_ID', '99ed2bbb-112f-4486-b479-96ce294db365').masked, false);
});
