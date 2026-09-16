const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const s = require('../session');
const { costOf, ratesFor, fmtCost } = require('../pricing');

const NOW = Date.parse('2026-08-08T12:00:00Z');

function rec(over = {}) {
    return {
        timestamp: new Date(NOW).toISOString(),
        message: {
            model: 'claude-opus-5',
            usage: {
                input_tokens: 2,
                output_tokens: 700,
                cache_read_input_tokens: 200000,
                cache_creation_input_tokens: 1000,
            },
        },
        effort: 'xhigh',
        advisorModel: 'claude-fable-5',
        gitBranch: 'main',
        ...over,
    };
}

test('slugFor encodes a path the way the client does', () => {
    // Mixed case survives; the hyphen is left alone.
    assert.equal(s.slugFor('/Users/x/Develop/ACME-second-brain'), '-Users-x-Develop-ACME-second-brain');
    // Underscores become hyphens too — an easy detail to get wrong, and the
    // reason this fixture must keep one.
    assert.equal(s.slugFor('/Users/x/Develop/my_service'), '-Users-x-Develop-my-service');
});

test('contextOf sums context from all three parts of usage', () => {
    const ctx = s.contextOf(rec());
    assert.equal(ctx.tokens, 2 + 200000 + 1000);
    assert.equal(ctx.window, 1e6);
    assert.equal(ctx.pct, 20);
    assert.equal(ctx.cachePct, 99);
    assert.equal(ctx.effort, 'xhigh');
    assert.equal(ctx.advisor, 'claude-fable-5');
    assert.equal(ctx.estimated, false);
});

test('contextOf survives a missing record', () => {
    assert.equal(s.contextOf(null), null);
});

test('thinking is read from the setting, never from the last reply', () => {
    // A reply that is a tool call carries no thinking block even while the model
    // is thinking on every turn, so the transcript cannot answer this — and
    // reading it there reported "off" for almost every agentic answer.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-set-'));
    const claude = path.join(dir, '.claude');
    fs.mkdirSync(claude, { recursive: true });
    try {
        // Nothing configured: thinking is on, the way the client ships.
        assert.equal(s.settingsOf(dir).thinking, true);

        fs.writeFileSync(path.join(claude, 'settings.json'),
            JSON.stringify({ alwaysThinkingEnabled: false, showThinkingSummaries: false }));
        const off = s.settingsOf(dir);
        assert.equal(off.thinking, false, 'false is an answer, not a missing value');
        assert.equal(off.thinkingSummaries, false);

        // The nearer file wins, including when it says true over a global false.
        fs.writeFileSync(path.join(claude, 'settings.local.json'),
            JSON.stringify({ alwaysThinkingEnabled: true }));
        const local = s.settingsOf(dir);
        assert.equal(local.thinking, true);
        assert.equal(local.thinkingSummaries, false, 'the key it does not state is left to the file below');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('windowFor: a million on current models, 200k on Haiku, suffix forces it', () => {
    assert.deepEqual(s.windowFor('claude-opus-5'), { tokens: 1e6, estimated: false });
    assert.deepEqual(s.windowFor('claude-sonnet-5'), { tokens: 1e6, estimated: false });
    assert.deepEqual(s.windowFor('claude-fable-5'), { tokens: 1e6, estimated: false });
    assert.deepEqual(s.windowFor('claude-haiku-4-5'), { tokens: 200000, estimated: false });
    assert.deepEqual(s.windowFor('claude-opus-5[1m]'), { tokens: 1e6, estimated: false });
    // An unknown model gets 200k and a flag saying the window was guessed.
    assert.deepEqual(s.windowFor('some-proxy-model'), { tokens: 200000, estimated: true });
});

test('costOf prices all four rates separately', () => {
    // 1M input + 1M output on Opus 5 = $5 + $25.
    assert.equal(costOf('claude-opus-5', { input_tokens: 1e6, output_tokens: 1e6 }), 30);
    // A cache write costs 1.25x input; a read is ten times cheaper.
    assert.equal(costOf('claude-opus-5', { cache_creation_input_tokens: 1e6 }), 6.25);
    assert.equal(costOf('claude-opus-5', { cache_read_input_tokens: 1e6 }), 0.5);
    assert.equal(costOf('claude-opus-5', null), 0);
});

test('costOf knows the different model rates', () => {
    assert.equal(costOf('claude-fable-5', { input_tokens: 1e6 }), 10);
    assert.equal(costOf('claude-sonnet-5', { input_tokens: 1e6 }), 2);
    assert.equal(costOf('claude-haiku-4-5', { input_tokens: 1e6 }), 1);
});

test('an unknown model is priced at Opus rates and flagged as unknown', () => {
    assert.equal(ratesFor('claude-opus-5').known, true);
    assert.equal(ratesFor('gpt-whatever').known, false);
    assert.equal(costOf('gpt-whatever', { input_tokens: 1e6 }), 5);
});

test('the [1m] and -fast suffixes do not change the rate', () => {
    assert.equal(ratesFor('claude-opus-5[1m]').known, true);
    assert.equal(costOf('claude-opus-5[1m]', { input_tokens: 1e6 }), 5);
    assert.equal(costOf('claude-opus-5-fast', { input_tokens: 1e6 }), 5);
});

test('fmtCost does not show $0.00 on sub-cent amounts', () => {
    assert.equal(fmtCost(0), '$0');
    assert.equal(fmtCost(0.004), '<$0.01');
    assert.equal(fmtCost(12.399), '$12.40');
});

test("costSince drops yesterday's records from the same file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-'));
    const file = path.join(dir, 'session.jsonl');
    const yesterday = new Date(NOW - 30 * 3600 * 1000).toISOString();
    fs.writeFileSync(file, [
        JSON.stringify(rec({ timestamp: yesterday })),
        JSON.stringify(rec()),
        'not json — a junk line the parser has to survive',
        '',
    ].join('\n'));

    const one = costOf('claude-opus-5', rec().message.usage);
    assert.ok(Math.abs(s.costSince(file, NOW - 3600 * 1000) - one) < 1e-9);
    assert.ok(Math.abs(s.sessionStats(file).cost - one * 2) < 1e-9);
    fs.rmSync(dir, { recursive: true, force: true });
});

// What fills the context window besides the conversation. The client works these
// out in memory for `/context` and writes none of it down, but the pieces it
// *does* record are enough to weigh several of them: the skill listing, the
// deferred tool names, the agent listing and the MCP instructions all reach the
// transcript as attachments.
//
// They arrive as deltas, and that is the whole difficulty: a listing repeats and
// grows, so adding up every record counts the same skill a dozen times. Summing
// this file's records naively gives ~93k tokens of skills where the client
// reports ~10k. Only the state at the end of the file is in the window.
test('context parts are the state at the end of the file, not the sum of the deltas', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-'));
    const file = path.join(dir, 'session.jsonl');
    const attach = (attachment) => JSON.stringify({ type: 'attachment', attachment });
    fs.writeFileSync(file, [
        // A full listing, then a delta that adds one more skill.
        attach({ type: 'skill_listing', isInitial: true, names: ['a', 'b'], content: 'x'.repeat(800) }),
        attach({ type: 'skill_listing', isInitial: false, names: ['c'], content: 'x'.repeat(400) }),
        // Tools come and go: two added, one taken away.
        attach({ type: 'deferred_tools_delta', addedNames: ['t1', 't2'], addedLines: ['x'.repeat(100), 'x'.repeat(60)] }),
        attach({ type: 'deferred_tools_delta', addedNames: [], addedLines: [], removedNames: ['t2'] }),
        // A second full agent listing replaces the first rather than doubling it.
        attach({ type: 'agent_listing_delta', isInitial: true, addedTypes: ['one'], addedLines: ['x'.repeat(200)] }),
        attach({ type: 'agent_listing_delta', isInitial: true, addedTypes: ['one'], addedLines: ['x'.repeat(200)] }),
        attach({ type: 'mcp_instructions_delta', addedNames: ['srv'], addedBlocks: ['x'.repeat(120)] }),
        '',
    ].join('\n'));

    const parts = s.contextParts(file);
    assert.deepEqual(parts.counts, { skills: 3, tools: 1, agents: 1, mcp: 1 });
    // 800 chars over two skills, plus 400 for the one the delta added, at four
    // characters to a token — the same rate the memory files are weighed with.
    assert.equal(parts.skills, 300);
    assert.equal(parts.tools, 25, 'the removed tool is gone, the kept one is 100 chars');
    assert.equal(parts.agents, 50, 'the repeated listing is one listing, not two');
    assert.equal(parts.mcp, 30);
    fs.rmSync(dir, { recursive: true, force: true });
});

// One file, several contexts. A subagent's records live in the same transcript
// as the main thread's, and they carry their own listings — a fresh `isInitial`
// skill listing from an agent would wipe the state built for this window, and
// its tools would be counted into a window they were never in. `readTail` has
// always skipped these records; this pass had not, which is the same "state at
// the end of the file" trap one level deeper.
test('a subagent’s own listings do not count towards this window', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-'));
    const file = path.join(dir, 'session.jsonl');
    const attach = (attachment, extra = {}) => JSON.stringify({ type: 'attachment', attachment, ...extra });
    fs.writeFileSync(file, [
        attach({ type: 'skill_listing', isInitial: true, names: ['a', 'b'], content: 'x'.repeat(800) }),
        // Everything below belongs to a subagent, by each of the three markers.
        attach({ type: 'skill_listing', isInitial: true, names: ['agent-only'], content: 'x'.repeat(4000) }, { isSidechain: true }),
        attach({ type: 'deferred_tools_delta', addedNames: ['t9'], addedLines: ['x'.repeat(999)] }, { agentId: 'a1' }),
        attach({ type: 'agent_listing_delta', isInitial: true, addedTypes: ['w'], addedLines: ['x'.repeat(999)] }, { workflowId: 'w1' }),
        '',
    ].join('\n'));

    const parts = s.contextParts(file);
    assert.deepEqual(parts.counts, { skills: 2, tools: 0, agents: 0, mcp: 0 });
    assert.equal(parts.skills, 200, 'the main listing survives the agent’s own');
    fs.rmSync(dir, { recursive: true, force: true });
});

// The title is what the terminal tab is named after. It is written as its own
// record and rewritten as a session goes on, so the last one in the file wins —
// and a title the user typed outranks the generated one.
test('titleIn takes the last title written, and a typed one over a generated one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-title-'));
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, [
        JSON.stringify({ type: 'title', sessionId: 'a', aiTitle: 'First guess at the topic' }),
        JSON.stringify(rec()),
        'not json — a junk line the parser has to survive',
        JSON.stringify({ type: 'title', sessionId: 'a', aiTitle: 'What it turned out to be' }),
        JSON.stringify({ type: 'title', sessionId: 'a', customTitle: 'What I called it' }),
    ].join('\n') + '\n');

    assert.equal(s.titleIn(file), 'What I called it');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('titleIn is empty for a transcript with no title and for one that is not there', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-title-none-'));
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, JSON.stringify(rec()) + '\n');

    assert.equal(s.titleIn(file), '');
    assert.equal(s.titleIn(path.join(dir, 'gone.jsonl')), '');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('readTail skips subagent records and takes the most recent one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-'));
    const file = path.join(dir, 'session.jsonl');
    const older = new Date(NOW - 60000).toISOString();
    const sub = rec({ agentId: 'agent_1' });
    sub.message.usage.cache_read_input_tokens = 999999;
    fs.writeFileSync(file, [
        JSON.stringify(rec({ timestamp: older })),
        JSON.stringify(rec()),
        JSON.stringify(sub),
        JSON.stringify(rec({ isSidechain: true })),
    ].join('\n') + '\n');

    const last = s.readTail(file);
    assert.equal(last.agentId, undefined);
    assert.equal(last.isSidechain, undefined);
    assert.equal(s.contextOf(last).tokens, 201002);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('readTail returns null for a missing file', () => {
    assert.equal(s.readTail('/nope/does-not-exist.jsonl'), null);
});

test('findOwnSession does not invent a session when the registry has none', () => {
    // A foreign pid and a non-existent workspace: no fallback should match.
    assert.equal(s.findOwnSession('/nope/not-a-workspace', 999999), null);
});

test('readTail widens the window when one record fills the whole tail', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-'));
    const file = path.join(dir, 'session.jsonl');

    // A real transcript can carry a record of hundreds of kilobytes — a large
    // file write, a long tool result. With a fixed 256 KB window the buffer is
    // then a single truncated line and the context indicator silently vanishes.
    const huge = JSON.stringify({
        timestamp: new Date(NOW - 1000).toISOString(),
        type: 'user',
        message: { role: 'user', content: 'x'.repeat(400 * 1024) },
    });
    fs.writeFileSync(file, [JSON.stringify(rec()), huge, ''].join('\n'));

    const last = s.readTail(file);
    assert.ok(last, 'the record before the huge one must still be found');
    assert.equal(s.contextOf(last).tokens, 201002);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('readTail gives up cleanly on a transcript that has no usage at all', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-'));
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, JSON.stringify({
        timestamp: new Date(NOW).toISOString(), type: 'user',
        message: { role: 'user', content: 'y'.repeat(300 * 1024) },
    }) + '\n');
    assert.equal(s.readTail(file), null);
    fs.rmSync(dir, { recursive: true, force: true });
});

const chainOf = (...pairs) => pairs.map(([scope, data]) => ({
    scope, path: `/fake/${scope}.json`, documented: true, exists: data !== null, data,
}));

test('the settings chain is the documented order, managed first', () => {
    const scopes = s.settingsFiles('/work').map((f) => f.scope);
    assert.deepEqual(scopes, ['managed', 'local', 'project', 'user local', 'user']);
    // Without a workspace there are no project files to read — and asking for
    // `/.claude/settings.json` at the filesystem root is how that used to look.
    assert.deepEqual(s.settingsFiles('').map((f) => f.scope), ['managed', 'user local', 'user']);
    assert.equal(s.settingsFiles('/work').find((f) => f.scope === 'managed').path, s.MANAGED);
    // The one file the precedence list in the docs does not mention.
    assert.equal(s.settingsFiles('/work').find((f) => f.scope === 'user local').documented, false);
});

test('resolveSetting names the file that won and the ones it shadowed', () => {
    const chain = chainOf(
        ['managed', null],
        ['local', { model: 'opus', alwaysThinkingEnabled: false }],
        ['user', { model: 'sonnet', outputStyle: 'Explanatory' }],
    );
    const model = s.resolveSetting(chain, 'model');
    assert.equal(model.value, 'opus');
    assert.equal(model.from, 'local');
    assert.deepEqual(model.alsoIn.map((a) => a.from), ['user']);

    assert.equal(s.resolveSetting(chain, 'outputStyle').from, 'user');
    assert.equal(s.resolveSetting(chain, 'nothingHere'), null);
    // `false` is stated, so it wins; `null` and `undefined` are not.
    assert.equal(s.resolveSetting(chain, 'alwaysThinkingEnabled').value, false);
    assert.equal(s.resolveSetting(chainOf(['user', { x: null }]), 'x'), null);
});

// The one setting that does not travel in a file. The client has no
// `--output-style` flag, so this extension launches a session by putting the
// style in `--settings` JSON — and then read it back out of the settings chain,
// where it had never been written. The pill was blank for every session the
// extension itself had started, which is all of them on this machine, and the
// terminal statusline showed the style all along because the client hands it
// one directly.
test('the style of a session is read from how the session was started', () => {
    const style = (args) => s.styleFromArgs(args);

    // The shape this extension actually produces, as `ps -o args=` prints it.
    assert.equal(style('claude --model opus[1m] --effort max --settings {"outputStyle":"Explanatory"}'), 'Explanatory');
    // Order is not promised, and neither is being last on the line.
    assert.equal(style('claude --settings {"outputStyle":"Concise"} --effort high'), 'Concise');
    // A settings object stating more than the style, and one stating none.
    assert.equal(style('claude --settings {"outputStyle":"Learning","model":"opus"}'), 'Learning');
    assert.equal(style('claude --settings {"model":"opus"}'), '');

    // Nothing to find, and nothing that should throw.
    assert.equal(style('claude --model opus'), '');
    assert.equal(style(''), '');
    assert.equal(style('claude --settings'), '');
    assert.equal(style('claude --settings not-json'), '');
    assert.equal(style('claude --settings {"outputStyle":'), '');
    assert.equal(style(undefined), '');

    // A style named by an argument beats one named by a file, and this is the
    // whole point rather than a tie-break: the client compiles the style into
    // the system prompt at session start, so a file edited since then states
    // what the NEXT session will get, not what this one is running.
    const chain = chainOf(['user', { outputStyle: 'Learning', advisorModel: 'fable' }]);
    assert.equal(s.settingsOf('/work', chain).outputStyle, 'Learning');
    assert.equal(s.settingsOf('/work', chain, 'Explanatory').outputStyle, 'Explanatory');
    // The file still answers when the session was started without one.
    assert.equal(s.settingsOf('/work', chain, '').outputStyle, 'Learning');
    // And nothing else in the answer moves.
    assert.equal(s.settingsOf('/work', chain, 'Explanatory').advisor, 'fable');
});

test('both readers answer from the chain they are given', () => {
    const chain = chainOf(['local', { alwaysThinkingEnabled: false }], ['user', {
        alwaysThinkingEnabled: true, advisorModel: 'fable', showThinkingSummaries: false,
    }]);
    const out = s.settingsOf('/work', chain);
    assert.equal(out.thinking, false, 'the nearer file said false');
    assert.equal(out.thinkingSummaries, false);
    assert.equal(out.advisor, 'fable');

    // Auto-compact off anywhere in the chain means there is no threshold to draw.
    assert.equal(s.autoCompactPct('/work', 200000, chainOf(['user', { autoCompactEnabled: false }])), -1);
    // 200k window, no override: (200000 − 20000 − 13000) / 200000.
    assert.equal(s.autoCompactPct('/work', 200000, chainOf(['user', {}])), 84);
    // A smaller autoCompactWindow moves the threshold down, not the window.
    assert.equal(s.autoCompactPct('/work', 200000, chainOf(['user', { autoCompactWindow: 100000 }])), 34);
});

// A reply written as thinking, text and a tool call is three records, and the
// records of one response carry the same usage — every multi-record response in
// a week of transcripts here does. Summing each of them billed a session two and
// a half times over: $8.53 against $3.40 on 34 records of 15 responses.
test('a response spread over several records is charged once, from its fullest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-'));
    const file = path.join(dir, 'session.jsonl');
    const u = rec().message.usage;
    const part = (id, usage) => JSON.stringify(rec({ requestId: id, message: { model: 'claude-opus-5', usage } }));
    fs.writeFileSync(file, [
        part('req-1', u), part('req-1', u), part('req-1', u),
        part('req-2', { output_tokens: 10 }), part('req-2', { output_tokens: 1000 }),
        '',
    ].join('\n'));

    const both = costOf('claude-opus-5', u) + costOf('claude-opus-5', { output_tokens: 1000 });
    const stats = s.sessionStats(file);
    assert.ok(Math.abs(stats.cost - both) < 1e-9, `cost ${stats.cost}, expected ${both}`);
    assert.equal(stats.messages, 2);
    assert.ok(Math.abs(s.costSince(file, NOW - 3600 * 1000) - both) < 1e-9);
    fs.rmSync(dir, { recursive: true, force: true });
});

test("sessionStats prices an advisor entry without a model at the record's advisor", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-'));
    const file = path.join(dir, 'session.jsonl');
    const u = rec().message.usage;
    const consulted = rec({
        requestId: 'req-1', advisorModel: 'claude-fable-5-1',
        message: { model: 'claude-opus-5', usage: { ...u, iterations: [{ type: 'advisor_message', input_tokens: 1e6 }] } },
    });
    fs.writeFileSync(file, `${JSON.stringify(consulted)}\n`);
    const expected = costOf('claude-opus-5', u) + 10;
    assert.ok(Math.abs(s.sessionStats(file).cost - expected) < 1e-9);
    assert.ok(Math.abs(s.costSince(file, NOW - 3600 * 1000) - expected) < 1e-9);
    fs.rmSync(dir, { recursive: true, force: true });
});

// The user-level entries of the chain follow the home they are given, so a
// test can lay out a home of its own instead of reading the real one.
test('settingsFiles takes a home of its own for the user-level entries', () => {
    const files = s.settingsFiles('/ws', '/h');
    assert.equal(files.find((f) => f.scope === 'user').path, path.join('/h', '.claude', 'settings.json'));
    assert.equal(files.find((f) => f.scope === 'user local').path, path.join('/h', '.claude', 'settings.local.json'));
    assert.equal(files.find((f) => f.scope === 'local').path, path.join('/ws', '.claude', 'settings.local.json'));
});

// The panel on Now lists the neighbours rather than counting them, so this
// answers with the sessions themselves. The registry directory is a parameter
// for the same reason the settings home is: a test must never read the real one.
test('peersOf names the neighbours, and finds the ones below the folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-peers-'));
    const put = (name, session) => fs.writeFileSync(path.join(dir, name), JSON.stringify(session));
    const live = process.pid;
    put('own.json', { sessionId: 'own', pid: live, cwd: '/w', status: 'busy' });
    put('a.json', { sessionId: 'a', pid: live, cwd: '/w', status: 'busy', name: 'the rewrite', entrypoint: 'cli', startedAt: NOW });
    put('b.json', { sessionId: 'b', pid: live, cwd: '/w/.claude/worktrees/x', status: 'idle', entrypoint: 'claude-vscode' });
    put('dead.json', { sessionId: 'dead', pid: 2 ** 30, cwd: '/w', status: 'busy' });
    put('elsewhere.json', { sessionId: 'far', pid: live, cwd: '/other', status: 'idle' });

    const peers = s.peersOf('/w', 'own', dir);
    assert.equal(peers.total, 2, 'the dead one and the one in another folder are not neighbours');
    assert.equal(peers.busy, 1);
    assert.deepEqual(peers.list.map((p) => p.id), ['a', 'b']);
    assert.equal(peers.list[0].name, 'the rewrite');
    assert.equal(peers.list[0].entrypoint, 'cli');
    // A session under the folder says where it is; one in the folder itself has
    // nothing to add.
    assert.equal(peers.list[0].where, '');
    assert.equal(peers.list[1].where, '.claude/worktrees/x');
    fs.rmSync(dir, { recursive: true, force: true });
});

// Since sessions run in the background by default the process that owns one is
// never a child of the shell it is shown in: the daemon owns it, and the shell
// runs `claude attach <id>`. Measured 2026-09-16 on 2.1.273 — every live session
// on the machine had `claude bg-pty-host` for a parent, and the terminals held
// the attach clients. Matched by parent alone, no tab had a session in it.
test('sessionForShell finds a background session through the attach running in the tab', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-attach-'));
    const put = (name, session) => fs.writeFileSync(path.join(dir, name), JSON.stringify(session));
    const live = process.pid;
    put('a.json', { sessionId: 'e37fc57a-2c83-4c0e-bfb9-2cdb4aeeed4a', pid: live, cwd: '/w', kind: 'bg' });
    put('b.json', { sessionId: '2519a4fd-0000-0000-0000-000000000000', pid: live, cwd: '/w', kind: 'bg' });
    const table = [
        { pid: 900, ppid: 3130, command: 'claude attach e37fc57a' },
        { pid: 901, ppid: 3131, command: '/Users/x/.local/bin/claude attach 2519a4fd' },
        { pid: 902, ppid: 3132, command: 'claude agents --model opus[1m]' },
        { pid: 903, ppid: 3133, command: 'vim attach-notes.md' },
    ];
    const at = (shell) => s.sessionForShell(shell, { dir, table });
    assert.equal(at(3130)?.sessionId, 'e37fc57a-2c83-4c0e-bfb9-2cdb4aeeed4a');
    assert.equal(at(3131)?.sessionId, '2519a4fd-0000-0000-0000-000000000000', 'the full path to the binary is the same client');
    // The agent view holds many sessions and says nothing about which one is on
    // screen, so it is no answer rather than a guess.
    assert.equal(at(3132), null);
    assert.equal(at(3133), null, 'a word in a file name is not an attach');
    assert.equal(at(9999), null);
    fs.rmSync(dir, { recursive: true, force: true });
});

// A session found through the tab it is attached in can belong to any folder,
// and its transcript is filed under that folder, not under the window's. Keyed
// by the window, the bar read a file that does not exist and went blank.
test('a session transcript is looked for under the session folder, not the window', () => {
    const session = { sessionId: 'e37fc57a-2c83', cwd: '/Users/x/Develop/SimCity' };
    assert.equal(s.transcriptOf(session, '/Users/x/Develop/claude-statusline-vscode'),
        path.join(s.PROJECTS, '-Users-x-Develop-SimCity', 'e37fc57a-2c83.jsonl'));
    // A registry entry without a cwd still has the window to fall back on.
    assert.equal(s.transcriptOf({ sessionId: 'abc' }, '/w'), path.join(s.PROJECTS, '-w', 'abc.jsonl'));
});

// The window's own session, when no tab names one — the agent view in the
// active terminal, or no terminal at all. A session in a worktree under the
// window's folder is this repository's work too; an exact folder still wins.
test('findOwnSession falls back to a session below the folder when none is in it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-own-'));
    const put = (name, session) => fs.writeFileSync(path.join(dir, name), JSON.stringify(session));
    const live = process.pid;
    put('wt.json', { sessionId: 'worktree', pid: live, cwd: '/w/.claude/worktrees/x', kind: 'bg' });
    put('far.json', { sessionId: 'elsewhere', pid: live, cwd: '/wx', kind: 'bg' });
    const table = [];
    assert.equal(s.findOwnSession('/w', 1, { dir, table })?.sessionId, 'worktree');

    put('exact.json', { sessionId: 'exact', pid: live, cwd: '/w', kind: 'bg' });
    assert.equal(s.findOwnSession('/w', 1, { dir, table })?.sessionId, 'exact', 'the folder itself comes first');
    // `/wx` shares a prefix with `/w` and is not below it.
    assert.equal(s.findOwnSession('/nothing', 1, { dir, table }), null);
    fs.rmSync(dir, { recursive: true, force: true });
});

// With nothing in a tab to say which session the window means, the newest one
// in the folder was taken — and a background session nobody has prompted yet is
// often the newest thing there. Measured 2026-09-16: the COG window picked an
// idle session with no reply in its transcript over one holding 209k of context.
test('the fallback prefers a session that has answered over a newer empty one', () => {
    const working = { sessionId: 'working', cwd: '/nowhere-a', startedAt: '2026-09-16T10:00:00Z' };
    const idle = { sessionId: 'idle', cwd: '/nowhere-b', startedAt: '2026-09-16T12:00:00Z' };
    const answered = (x) => x.sessionId === 'working';
    assert.equal(s.newestWorking([idle, working], answered).sessionId, 'working');
    // When none has answered, the newest still stands rather than nothing.
    assert.equal(s.newestWorking([working, idle], () => false).sessionId, 'idle');
});

// The agent view holds many sessions and says nothing about which one is on
// screen (measured 2026-09-16: no child process, one control socket, no
// `attached` field in `claude agents --json`). A tab running it is recognised so
// the window can say it cannot tell, rather than guess.
test('agentViewIn recognises the agent view running in a tab', () => {
    const table = [
        { pid: 900, ppid: 41463, command: 'claude agents --model opus[1m] --effort high' },
        { pid: 901, ppid: 7017, command: '/Users/x/.local/bin/claude agents' },
        { pid: 902, ppid: 3130, command: 'claude attach e37fc57a' },
        { pid: 903, ppid: 5000, command: 'claude agents --json' },
        { pid: 904, ppid: 5001, command: 'vim agents.md' },
    ];
    assert.equal(s.agentViewIn(41463, { table }), true);
    assert.equal(s.agentViewIn(7017, { table }), true, 'by path as well as by name');
    assert.equal(s.agentViewIn(3130, { table }), false, 'an attach is one session, and says which');
    assert.equal(s.agentViewIn(5000, { table }), false, 'a listing that prints and exits is not a view');
    assert.equal(s.agentViewIn(5001, { table }), false);
    assert.equal(s.agentViewIn(0, { table }), false);
});

// The badge counts the sessions waiting on the reader, read the documented way:
// `claude agents --json`, where `state: blocked` is a background session that
// needs something only you can give, and `status: waiting` is a live process
// holding an open prompt (code.claude.com/docs/en/agent-view, "Read session
// state from a script", checked 2026-09-16). A session that finished its turn is
// `done`, and is not waiting on anyone.
test('waitingCount counts the sessions that need you, once each', () => {
    const entries = [
        { kind: 'background', id: 'a1', sessionId: 'a1-full', state: 'blocked', status: 'idle' },
        { kind: 'background', id: 'b2', sessionId: 'b2-full', state: 'blocked' },
        { kind: 'background', id: 'c3', sessionId: 'c3-full', state: 'done', status: 'idle' },
        { kind: 'background', id: 'd4', sessionId: 'd4-full', state: 'working', status: 'busy' },
        { kind: 'interactive', sessionId: 'e5-full', status: 'waiting', waitingFor: 'permission prompt' },
        { kind: 'interactive', sessionId: 'f6-full', status: 'idle' },
        // Both signals on one session is still one session.
        { kind: 'background', id: 'g7', sessionId: 'g7-full', state: 'blocked', status: 'waiting', waitingFor: 'input needed' },
    ];
    assert.equal(s.waitingCount(entries), 4);
    assert.equal(s.waitingCount([]), 0);
    assert.equal(s.waitingCount(null), null, 'no reading is not zero sessions');
});
