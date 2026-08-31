const test = require('node:test');
const assert = require('node:assert');

const term = require('../terminal');

// The client's own JSON, trimmed to the fields these tests speak about. Shape
// and field names are the documented status-line contract, not a guess.
const client = (over = {}) => ({
    session_id: 'abc123',
    transcript_path: '/tmp/nowhere/abc123.jsonl',
    version: '2.1.245',
    model: { id: 'claude-opus-5[1m]', display_name: 'Opus' },
    workspace: { current_dir: '/w', project_dir: '/w', git_worktree: 'master' },
    output_style: { name: 'Proactive' },
    thinking: { enabled: true },
    effort: { level: 'xhigh' },
    context_window: {
        total_input_tokens: 100000,
        context_window_size: 1000000,
        used_percentage: 10,
        current_usage: { input_tokens: 20000, cache_read_input_tokens: 70000, cache_creation_input_tokens: 10000 },
    },
    cost: {
        total_cost_usd: 12.5,
        total_duration_ms: 7200000,
        total_api_duration_ms: 1800000,
        total_lines_added: 156,
        total_lines_removed: 23,
    },
    rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
        seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
    },
    ...over,
});

test('the context fields come from the client, so no transcript is opened', () => {
    const d = term.clientData(client(), 1738400000);
    // The transcript path in the fixture does not exist: reading it would throw
    // or yield null, and both would show up as an empty ctx.
    assert.equal(d.ctx.tokens, 100000);
    assert.equal(d.ctx.window, 1000000);
    assert.equal(d.ctx.pct, 10);
    assert.equal(d.ctx.model, 'claude-opus-5[1m]');
    assert.equal(d.ctx.effort, 'xhigh');
    assert.equal(d.ctx.branch, 'master');
    assert.equal(d.ctx.estimated, false);
});

test('the cache share is floored the way the extension floors it', () => {
    const d = term.clientData(client(), 1738400000);
    // 70000 of 100000 — and cachePct is a share of what is in the window, not
    // of the window's size.
    assert.equal(d.ctx.cachePct, 70);
});

test('a window with nothing in it reports no cache share rather than zero', () => {
    const d = term.clientData(client({
        context_window: { total_input_tokens: 0, context_window_size: 200000, used_percentage: 0, current_usage: {} },
    }), 1738400000);
    // -1 is what `pct()` in segments.js reads as "nothing to say"; 0 would print
    // "cache 0%" on a window that has not been used yet.
    assert.equal(d.ctx.cachePct, -1);
});

test('a limit percentage is not read a point low by binary rounding', () => {
    // The client multiplies its own fraction by 100, and 0.29 * 100 is
    // 28.999999999999996 in IEEE754 — a bare floor turns 29% into 28%. The same
    // three values bit statusline.sh, which is where the epsilon comes from.
    for (const [raw, want] of [[28.999999999999996, 29], [56.99999999999999, 57], [57.99999999999999, 58]]) {
        const d = term.clientData(client({
            rate_limits: { seven_day: { used_percentage: raw, resets_at: 1738857600 } },
        }), 1738400000);
        assert.equal(d.weekly.pct, want, `${raw} should read as ${want}%`);
    }
});

test('a fractional percentage is floored rather than rounded up', () => {
    const d = term.clientData(client(), 1738400000);
    // 41.2 is 41% used, not 42%: the bar must not claim spend that has not
    // happened.
    assert.equal(d.weekly.pct, 41);
    assert.equal(d.session.pct, 23);
});

test('both limit windows carry the reset the client reported', () => {
    const d = term.clientData(client(), 1738400000);
    assert.equal(d.weekly.reset, 1738857600);
    assert.equal(d.session.reset, 1738425600);
});

test('the pace and the bar are computed from the client limits', () => {
    const now = 1738857600 - 3 * 24 * 3600; // three days left in the week
    const d = term.clientData(client(), now);
    assert.ok(d.pace, 'a pace is forecast once the window has a reset');
    assert.equal(d.pace.plan, 57); // four of seven days elapsed
    assert.equal(d.pace.settled, true);
    assert.ok(d.bar.length > 0, 'the bar is drawn whenever there is a pace');
});

test('a session with no limits yet forecasts nothing instead of guessing', () => {
    const d = term.clientData(client({ rate_limits: {} }), 1738400000);
    assert.equal(d.weekly, null);
    assert.equal(d.session, null);
    assert.equal(d.pace, null);
    assert.equal(d.bar, '');
});

test('the money fields come from the cost block the client reports', () => {
    const d = term.clientData(client(), 1738400000);
    assert.equal(d.stats.cost, 12.5);
    assert.equal(d.stats.added, 156);
    assert.equal(d.stats.removed, 23);
    assert.equal(d.stats.durationMs, 7200000);
    // Two hours of wall clock against $12.50.
    assert.equal(d.stats.burn, 6.25);
    // Half an hour of API time in two hours of session.
    assert.equal(d.stats.apiPct, 25);
});

test('a session too short to divide reports no burn rate', () => {
    const d = term.clientData(client({
        cost: { total_cost_usd: 0.4, total_duration_ms: 30000, total_api_duration_ms: 12000 },
    }), 1738400000);
    // Under a minute the rate is noise: $0.40 in thirty seconds extrapolates to
    // $48/h and says nothing. statusline.sh uses the same one-minute floor.
    assert.equal(d.stats.burn, null);
});

test('the client settings reach the fields that print them', () => {
    const d = term.clientData(client(), 1738400000);
    assert.equal(d.settings.thinking, true);
    assert.equal(d.settings.outputStyle, 'Proactive');
    assert.equal(d.version.current, '2.1.245');
});

test('a payload with nothing in it yields a shape rather than a crash', () => {
    // Fields are null before the first reply completes, and the whole object can
    // be bare on the very first run of a session.
    const d = term.clientData({}, 1738400000);
    assert.equal(d.ctx, null);
    assert.equal(d.weekly, null);
    assert.equal(d.stats, null);
    assert.equal(d.now, 1738400000);
});

// --- what the terminal entry is allowed to drag in ------------------------

test('the terminal entry pulls in neither the dashboard nor the workflow tree', () => {
    // What the status line costs is what it loads, and it runs on every refresh.
    // Measured by running the entry and asking Node what ended up in the module
    // cache — a text scan for `require` cannot tell a top-level import from one
    // inside a branch the status line never takes.
    const { execFileSync } = require('node:child_process');
    const path = require('node:path');
    const root = path.join(__dirname, '..');
    const loaded = execFileSync(process.execPath, ['-e', `
        process.argv[1] = ${JSON.stringify(path.join(root, 'bin', 'statusline.js'))};
        const seen = () => Object.keys(require.cache).filter((f) => f.startsWith(${JSON.stringify(root)}));
        require(process.argv[1]);
        process.stdout.write(seen().join('\\n'));
    `], { input: '{}', encoding: 'utf8', cwd: root });

    const names = loaded.split('\n').map((f) => f.replace(`${root}/`, ''));
    for (const heavy of ['dashboard.js', 'workflows.js', 'indexer.js', 'history.js', 'clientSettings.js']) {
        assert.ok(!names.includes(heavy), `${heavy} is loaded by the status line: ${names.join(', ')}`);
    }
    assert.ok(names.includes('terminal.js'), 'and the entry did load, so the check means something');
});

test('the model name and the token label are read from pricing', () => {
    // One definition each: the bar, the page and the terminal must spell a model
    // the same way, and `dashboard.js` is not a place the terminal can reach.
    const pricing = require('../pricing');
    assert.equal(typeof pricing.shortModel, 'function');
    assert.equal(typeof pricing.tokenLabel, 'function');
    assert.equal(pricing.shortModel('claude-opus-5'), 'opus 5');
    assert.equal(pricing.shortModel('claude-haiku-4-5'), 'haiku 4.5');
    assert.equal(pricing.tokenLabel(294000), '294k');
    assert.equal(pricing.tokenLabel(2000000), '2M');
    assert.equal(pricing.tokenLabel(1500000), '1.5M');
});

// --- the ANSI half -------------------------------------------------------

const seg = require('../segments');
const registry = seg.fields({ tok: (n) => `${Math.round(n / 1000)}k`, shortModel: (m) => m.replace(/^claude-/, '') });

const ESC = '\u001b[';
const RESET = '\u001b[0m';

// A week loud enough to paint, everything else as it comes.
const loudWeek = (over = {}) => client({
    rate_limits: { seven_day: { used_percentage: 91, resets_at: 1738857600 } },
    ...over,
});

test('a segment whose fields all came back empty is not printed at all', () => {
    // An empty line in a terminal status line is not invisible the way a hidden
    // status-bar item is: it takes a row and pushes the prompt up.
    const lines = term.renderLines(['{weekly}', '[~{cost}]'], term.clientData({}, 0), registry, { colour: false });
    assert.deepEqual(lines, []);
});

test('each template becomes its own line, in the order they were written', () => {
    const d = term.clientData(client(), 1738400000);
    const lines = term.renderLines(['✻ 7d {weekly}', '▤ {ctx}'], d, registry, { colour: false });
    assert.deepEqual(lines, ['✻ 7d 41%', '▤ 10%']);
});

test('a share past the alarm threshold is painted, and the paint is closed', () => {
    const d = term.clientData(loudWeek(), 1738400000);
    const [line] = term.renderLines(['7d {weekly}'], d, registry, { colour: true });
    assert.ok(line.startsWith(ESC), 'the line opens with an escape');
    // Without the reset the prompt drawn after it inherits the colour, and the
    // whole terminal stays red until something else resets it.
    assert.ok(line.endsWith(RESET), 'and closes with a reset');
    assert.ok(line.includes('91%'));
});

test('a quiet share is left unpainted rather than painted a third colour', () => {
    const d = term.clientData(client({
        rate_limits: { seven_day: { used_percentage: 12, resets_at: 1738857600 } },
    }), 1738400000);
    const [line] = term.renderLines(['7d {weekly}'], d, registry, { colour: true });
    assert.ok(!line.includes(ESC), 'nothing to warn about, nothing to paint');
});

test('colour is dropped entirely when the caller asks for none', () => {
    const d = term.clientData(loudWeek(), 1738400000);
    const [line] = term.renderLines(['7d {weekly}'], d, registry, { colour: false });
    assert.equal(line, '7d 91%');
});

test('a segment mixing a loud limit with a quiet context takes the loud one', () => {
    const d = term.clientData(loudWeek(), 1738400000);
    const [loud] = term.renderLines(['{weekly} {ctx}'], d, registry, { colour: true });
    const [quiet] = term.renderLines(['{ctx}'], d, registry, { colour: true });
    assert.ok(loud.includes(ESC), 'the week is alarming and the segment says so');
    assert.ok(!quiet.includes(ESC), 'the context alone is not');
});

test('a codicon in a template is dropped rather than printed as source', () => {
    // The default segments carry `$(gear)`, which the status bar renders as an
    // icon and a terminal renders as the four characters `$(ge`… — and the same
    // goes for any template written for the bar and reused here.
    const d = term.clientData(client(), 1738400000);
    const [line] = term.renderLines(['$(gear) 7d {weekly}'], d, registry, { colour: false });
    assert.equal(line, '7d 41%');
});

test('an escaped dollar survives, because it is not a codicon', () => {
    const d = term.clientData(client(), 1738400000);
    const [line] = term.renderLines(['cost $12 {weekly}'], d, registry, { colour: false });
    assert.equal(line, 'cost $12 41%');
});

test('a segment that is nothing but a codicon prints no line at all', () => {
    const d = term.clientData(client(), 1738400000);
    assert.deepEqual(term.renderLines(['$(gear)'], d, registry, { colour: false }), []);
});

test('the two tones are told apart by the escape they carry', () => {
    const warn = term.paint('x', 'warn');
    const alarm = term.paint('x', 'alarm');
    assert.notEqual(warn, alarm);
    assert.ok(warn.includes('x') && alarm.includes('x'));
    // No tone is no escape, not a default colour: the terminal's own foreground
    // is what the rest of the prompt is drawn in.
    assert.equal(term.paint('x', null), 'x');
});

// --- linking the terminal status line to the client ----------------------
//
// The toggle writes one key of `~/.claude/settings.json`, a file the client
// itself writes to and an hourly job replicates to three machines. Every test
// here runs against a temp directory: nothing may touch the real home.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-link-'));

test('the command it writes decides on the fallback before reading stdin', () => {
    const cmd = term.commandFor({ dir: '/some/dir with space/statusline' });
    // `A && node B || C` eats stdin in B before falling through to C: a stale
    // copy that exits non-zero then hands C an empty stream. The `if` form makes
    // the choice first and execs once.
    assert.ok(!cmd.includes('||'), 'no || fallthrough after a command that reads stdin');
    assert.match(cmd, /^S=/, 'the script is resolved first, then chosen between');
    assert.match(cmd, /if \[ -f "\$S" \]/);
    assert.match(cmd, /command -v node/, 'a machine without node in a non-interactive PATH falls back too');
    assert.match(cmd, /exec node/);
    assert.match(cmd, /exec .*statusline\.sh/);
    // "Application Support" has a space in it, and single quotes are what makes
    // a path safe: inside double quotes `$(...)` and backticks still execute.
    assert.match(cmd, /'[^']*dir with space[^']*'/);
});

test('the written command runs as a shell command', () => {
    const { execFileSync } = require('node:child_process');
    const dir = tmpHome();
    // Nothing installed there, so this exercises the fallback branch with a
    // stand-in for the old script.
    const sh = path.join(dir, 'statusline.sh');
    fs.writeFileSync(sh, '#!/bin/sh\ncat >/dev/null\necho fallback-ran\n');
    fs.chmodSync(sh, 0o755);
    const cmd = term.commandFor({ dir: path.join(dir, 'missing'), fallback: sh });
    const out = execFileSync('sh', ['-c', cmd], { input: '{}', encoding: 'utf8' });
    assert.equal(out.trim(), 'fallback-ran');
});

test('the state of the key says whether it is ours, someone else\'s, or unset', () => {
    assert.equal(term.statusLineState({}), 'none');
    assert.equal(term.statusLineState({ statusLine: { type: 'command', command: '~/.claude/statusline.sh' } }), 'other');
    assert.equal(term.statusLineState({ statusLine: { type: 'command', command: term.commandFor() } }), 'ours');
});

test('the command finds the installed plugin by its highest version', () => {
    // The plugin cache is versioned — `cache/<marketplace>/<plugin>/6.3.0/` —
    // so a path written once goes stale on the next plugin update. The command
    // resolves the version every time it runs instead.
    const cmd = term.commandFor();
    assert.match(cmd, /plugins\/cache\/dashnlines\/dashnlines/);
    assert.match(cmd, /sort -V/, 'versions sort by number, not lexically: 6.10.0 beats 6.3.0');
    assert.match(cmd, /tail -1/);
});

test('the command still runs when no plugin is installed', () => {
    const { execFileSync } = require('node:child_process');
    const dir = tmpHome();
    const sh = path.join(dir, 'statusline.sh');
    fs.writeFileSync(sh, '#!/bin/sh\ncat >/dev/null\necho fell-back\n');
    fs.chmodSync(sh, 0o755);
    // An empty plugin cache, so this exercises the fallback branch whether or
    // not the plugin happens to be installed on the machine running the tests.
    const out = execFileSync('sh', ['-c', term.commandFor({ fallback: sh, pluginRoot: path.join(dir, 'no-plugins') })], { input: '{}', encoding: 'utf8' });
    assert.equal(out.trim(), 'fell-back');
});

test('linking keeps every other setting byte for byte', () => {
    const dir = tmpHome();
    const p = path.join(dir, 'settings.json');
    const before = { env: { A: '1' }, model: 'opus', permissions: { allow: ['Bash'] } };
    fs.writeFileSync(p, `${JSON.stringify(before, null, 2)}\n`);
    term.linkStatusLine(p);
    const after = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.deepEqual(after.env, before.env);
    assert.equal(after.model, before.model);
    assert.deepEqual(after.permissions, before.permissions);
    assert.equal(after.statusLine.type, 'command');
    assert.match(after.statusLine.command, /exec node/);
});

test('linking carries over the padding and refresh the user already chose', () => {
    const dir = tmpHome();
    const p = path.join(dir, 'settings.json');
    fs.writeFileSync(p, JSON.stringify({
        statusLine: { type: 'command', command: '~/.claude/statusline.sh', padding: 2, refreshInterval: 5 },
    }, null, 2));
    term.linkStatusLine(p);
    const after = JSON.parse(fs.readFileSync(p, 'utf8'));
    // Changing the refresh cadence is not part of what the toggle promises.
    assert.equal(after.statusLine.padding, 2);
    assert.equal(after.statusLine.refreshInterval, 5);
});

test('linking leaves a backup of the file it first rewrote', () => {
    const dir = tmpHome();
    const p = path.join(dir, 'settings.json');
    const original = `${JSON.stringify({ model: 'opus' }, null, 2)}\n`;
    fs.writeFileSync(p, original);
    term.linkStatusLine(p);
    assert.equal(fs.readFileSync(`${p}.claude-dashboard.bak`, 'utf8'), original);
});

test('unlinking puts back what was there before', () => {
    const dir = tmpHome();
    const p = path.join(dir, 'settings.json');
    const mine = { type: 'command', command: '~/.claude/statusline.sh', padding: 0, refreshInterval: 5 };
    fs.writeFileSync(p, JSON.stringify({ statusLine: mine }, null, 2));
    const saved = term.linkStatusLine(p);
    assert.deepEqual(saved, mine, 'linking hands back what it replaced');
    term.unlinkStatusLine(p, saved);
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')).statusLine, mine);
});

test('unlinking removes the key when there was none to begin with', () => {
    const dir = tmpHome();
    const p = path.join(dir, 'settings.json');
    fs.writeFileSync(p, JSON.stringify({ model: 'opus' }, null, 2));
    const saved = term.linkStatusLine(p);
    assert.equal(saved, null, 'nothing was replaced');
    term.unlinkStatusLine(p, saved);
    const after = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.ok(!('statusLine' in after), 'the key is gone, not set to null');
    assert.equal(after.model, 'opus');
});

test('unlinking keeps a hand-edited command instead of clobbering it', () => {
    const dir = tmpHome();
    const p = path.join(dir, 'settings.json');
    fs.writeFileSync(p, JSON.stringify({ model: 'opus' }, null, 2));
    const saved = term.linkStatusLine(p);
    // The user edited the command by hand after switching the toggle on.
    const edited = { type: 'command', command: 'my-own-script.sh' };
    fs.writeFileSync(p, JSON.stringify({ model: 'opus', statusLine: edited }, null, 2));
    term.unlinkStatusLine(p, saved);
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')).statusLine, edited);
});

test('the client writing the file between render and click is not clobbered', () => {
    const dir = tmpHome();
    const p = path.join(dir, 'settings.json');
    fs.writeFileSync(p, JSON.stringify({ model: 'opus' }, null, 2));
    // What `/model` does while the panel sits open.
    fs.writeFileSync(p, JSON.stringify({ model: 'fable', effortLevel: 'xhigh' }, null, 2));
    term.linkStatusLine(p);
    const after = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(after.model, 'fable', 'the file is read inside the write, not before it');
    assert.equal(after.effortLevel, 'xhigh');
});

test('a path carrying shell metacharacters cannot execute anything', () => {
    const { execFileSync } = require('node:child_process');
    const dir = tmpHome();
    const witness = path.join(dir, 'witness');
    // A directory name is not user input today, but it is interpolated into a
    // shell command, and inside double quotes `$(...)` and backticks run.
    const evil = path.join(dir, `x$(touch ${witness})y`);
    const sh = path.join(dir, 'fallback.sh');
    fs.writeFileSync(sh, '#!/bin/sh\ncat >/dev/null\necho ok\n');
    fs.chmodSync(sh, 0o755);
    const cmd = term.commandFor({ dir: evil, fallback: sh });
    execFileSync('sh', ['-c', cmd], { input: '{}', encoding: 'utf8' });
    assert.ok(!fs.existsSync(witness), 'the substitution in the path was executed');
});

test('a quote in the path does not break out of the command', () => {
    const dir = tmpHome();
    const cmd = term.commandFor({ dir: path.join(dir, "it's here") });
    const { execFileSync } = require('node:child_process');
    // Nothing to assert about the output; a broken quoting makes `sh -c` exit
    // non-zero with a syntax error, and execFileSync throws on that.
    const sh = path.join(dir, 'f.sh');
    fs.writeFileSync(sh, '#!/bin/sh\ncat >/dev/null\n');
    fs.chmodSync(sh, 0o755);
    execFileSync('sh', ['-c', term.commandFor({ dir: path.join(dir, "it's here"), fallback: sh })], { input: '{}' });
    assert.ok(cmd.length > 0);
});

test('writing the settings file does not widen its permissions', () => {
    const dir = tmpHome();
    const p = path.join(dir, 'settings.json');
    fs.writeFileSync(p, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-secret' } }, null, 2));
    fs.chmodSync(p, 0o600);
    term.linkStatusLine(p);
    // The client keeps this file owner-only, and it carries an `env` block that
    // routinely holds tokens. A default-mode write would leave it 0644.
    assert.equal(fs.statSync(p).mode & 0o777, 0o600, 'the mode survived the rewrite');
});

test('the backup is no more readable than the file it copies', () => {
    const dir = tmpHome();
    const p = path.join(dir, 'settings.json');
    fs.writeFileSync(p, JSON.stringify({ env: { TOKEN: 'x' } }, null, 2));
    fs.chmodSync(p, 0o600);
    term.linkStatusLine(p);
    const mode = fs.statSync(`${p}.claude-dashboard.bak`).mode & 0o777;
    assert.ok((mode & 0o077) === 0, `the backup is group/other readable: ${mode.toString(8)}`);
});

// --- collecting the same state from disk ---------------------------------
//
// The status line is handed its numbers on stdin; the dashboard has to read
// them, the way the extension's slow tick does.

test('the disk collector answers with limits even when no session is named', () => {
    const d = term.collectFromDisk({ now: 1738400000, sessionId: null, cwd: '/nowhere' });
    // The limit cache is shared with statusline.sh and may or may not exist on
    // the machine running the tests; the shape is what is asserted.
    assert.ok('weekly' in d && 'session' in d && 'pace' in d);
    assert.equal(d.ctx, null, 'no session named, no context to report');
    assert.equal(d.stats, null);
    assert.equal(d.now, 1738400000);
});

test('a session whose transcript is missing degrades instead of throwing', () => {
    const d = term.collectFromDisk({
        now: 1738400000,
        sessionId: 'no-such-session-0000',
        cwd: '/nowhere/at/all',
        today: false,
    });
    assert.equal(d.ctx, null);
    assert.equal(d.stats, null);
});

test('the collector skips the walk over every project when told to', () => {
    // `costToday` opens every project directory on the machine. A caller that
    // does not print the figure should not pay for it.
    const started = Date.now();
    term.collectFromDisk({ now: 1738400000, sessionId: null, cwd: '/nowhere', today: false });
    assert.ok(Date.now() - started < 2000, 'skipping the walk is what makes this fast');
});

test('a session is found by its id even when run from another directory', () => {
    // The dashboard is run from wherever the user happens to be — /tmp, another
    // repository — while the transcript lives under the slug of the directory
    // the session was started in. The id is unique across all of them.
    const home = tmpHome();
    const projects = path.join(home, '.claude', 'projects', '-Users-someone-elsewhere');
    fs.mkdirSync(projects, { recursive: true });
    const id = 'find-me-by-id-0001';
    fs.writeFileSync(path.join(projects, `${id}.jsonl`), '');
    const found = term.findTranscript(id, { projects: path.join(home, '.claude', 'projects') });
    assert.equal(found, path.join(projects, `${id}.jsonl`));
});

test('looking for a session that is nowhere answers null rather than throwing', () => {
    const home = tmpHome();
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    assert.equal(term.findTranscript('nope', { projects: path.join(home, '.claude', 'projects') }), null);
    // And a projects directory that does not exist at all.
    assert.equal(term.findTranscript('nope', { projects: path.join(home, 'missing') }), null);
});

test('the disk collector uses the weighted plan the extension uses', () => {
    // `pace()` takes the hourly profile as its third argument; without it the
    // plan is the share of the week elapsed. The dashboard reads the same
    // globalStorage the extension writes, so it has no excuse for the linear
    // one — and two surfaces disagreeing about `{drift}` is the whole reason
    // the profile exists.
    const d = term.collectFromDisk({ now: 1738400000, sessionId: null, cwd: '/nowhere', today: false });
    // With no history on the machine running the tests, weighted equals linear;
    // what is asserted is that the field is carried at all.
    if (d.pace) assert.ok('planW' in d.pace, 'planW reaches the dashboard');
});
