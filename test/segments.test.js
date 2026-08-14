const test = require('node:test');
const assert = require('node:assert');
const seg = require('../segments');
const u = require('../usage');
const s = require('../session');
const { fmtCost } = require('../pricing');

const NOW = Math.floor(Date.parse('2026-08-09T12:00:00Z') / 1000);

const registry = seg.fields({
    fmtCost,
    fmtDry: (ts) => u.fmtDry(ts, NOW * 1000),
    fmtLeft: u.fmtLeft,
    fmtAbs: (ts) => u.fmtAbs(ts, NOW * 1000),
    fmtDuration: s.fmtDuration,
    tok: (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`),
    shortModel: (m) => m.replace(/^claude-/, ''),
});

const data = {
    now: NOW,
    weekly: { pct: 33, reset: NOW + 3 * 86400 },
    session: { pct: 12, reset: NOW + 3600 },
    scoped: [{ scope: 'Opus', pct: 84 }, { scope: 'Fable', pct: 20 }],
    // `settled` is what pace() decides: past the first half hour and 2%, the
    // window can be compared against its plan at all.
    pace: { plan: 40, dry: NOW + 86400, dryAt: NOW + 86400, settled: true },
    bar: '▒▒▒░░░░',
    ctx: { pct: 29, tokens: 294000, window: 1e6, cachePct: 91, model: 'claude-opus-5', effort: 'xhigh', thinking: true, branch: 'master', estimated: false },
    compactPct: 87,
    settings: { advisor: 'claude-fable-5', outputStyle: 'default' },
    version: { current: '2.1.226', latest: '' },
    stats: { cost: 114.29, burn: 5.18, messages: 163, durationMs: 39 * 60000, apiPct: 61, added: 640, removed: 120 },
    todayUsd: 42.5,
    peers: { total: 2, busy: 1 },
    todo: { done: 3, total: 6, active: 'writing the parser' },
    machine: { jobs: 1, sessions: 9, openTasks: 25 },
};

test('the default segments draw the limits, the context, the spend and the work', () => {
    const [limits, ctx, money, work] = seg.DEFAULT_SEGMENTS.map((t) => seg.renderSegment(t, data, registry));
    // The forecast is formatted in local time, so the expectation is built the
    // same way rather than pinned to the author's timezone. drift rides along
    // with the percentage: 33% spent against 40% elapsed is 7% under plan.
    assert.equal(limits.text, `✻ 7d 33% -7% ▒▒▒░░░░ dry ${u.fmtDry(data.pace.dry, NOW * 1000)}`);
    assert.equal(ctx.text, '▤ 29% 294k/1.0M');
    assert.equal(money.text, '~$114.29 $5.18/h');
    assert.equal(work.text, '⧉ 2 ▸ 3/6');
});

test('an optional group disappears whole when its field has nothing to say', () => {
    // No forecast yet: the words "dry" and the date must both go, and the rest
    // of the segment must survive.
    // Settled, so the drift is still stated — what is missing here is only the
    // forecast, which is the group under test.
    const early = { ...data, pace: { plan: 3, dry: null, dryAt: null, settled: true } };
    const r = seg.renderSegment(seg.DEFAULT_SEGMENTS[0], early, registry);
    assert.equal(r.text, '✻ 7d 33% +30% ▒▒▒░░░░');
    assert.equal(r.visible, true);
});

test('a segment with nothing filled in is hidden rather than shown as punctuation', () => {
    const empty = seg.renderSegment('[⧉ {peers}][ ▸ {todo}]', { ...data, peers: null, todo: null }, registry);
    assert.equal(empty.text, '');
    assert.equal(empty.visible, false);

    // Literal text with no placeholders at all is the user's own decoration and
    // always stays.
    const literal = seg.renderSegment('claude', {}, registry);
    assert.equal(literal.visible, true);
});

test('a segment reports the topics it touched, in the order they appear', () => {
    const r = seg.renderSegment('{ctx} · {weekly} · {cost}', data, registry);
    assert.deepEqual(r.topics, ['context', 'limits', 'money']);
    assert.equal(r.text, '29% · 33% · $114.29');
});

test('an unknown placeholder is left visible instead of silently eaten', () => {
    const r = seg.renderSegment('{weekly} {nonsense}', data, registry);
    assert.equal(r.text, '33% {nonsense}');
});

test('a backslash escapes the template syntax', () => {
    const r = seg.renderSegment('\\{weekly\\} is \\[literal\\] {weekly}', data, registry);
    assert.equal(r.text, '{weekly} is [literal] 33%');
});

test('scoped takes every per-model window, or one by name', () => {
    assert.equal(registry.scoped.get(data), 'opus 84% fable 20%');
    assert.equal(registry.scoped.get(data, 'Opus'), '84%');
    assert.equal(registry.scoped.get(data, 'opus'), '84%');
    assert.equal(registry.scoped.get(data, 'haiku'), '');
});

test('drift says which side of the plan the pace is on', () => {
    const settled = (over) => ({ ...data, ...over, pace: { ...data.pace, ...over.pace } });
    assert.equal(registry.drift.get(data), '-7%');
    assert.equal(registry.drift.get(settled({ weekly: { pct: 55 }, pace: { plan: 40 } })), '+15%');
    assert.equal(registry.drift.get(settled({ weekly: { pct: 40 }, pace: { plan: 40 } })), '0%');
    assert.equal(registry.drift.get({}), '');
    // A window too young to judge: the plan is 0% and every percent spent would
    // read as ahead of schedule, so the field says nothing at all.
    assert.equal(registry.drift.get({ ...data, weekly: { pct: 1 }, pace: { plan: 0, settled: false } }), '');
});

// The bar said "thinking" only when the last reply happened to carry a thinking
// block. Most agentic replies are tool calls and carry none, so the word was
// missing while the model was thinking on every turn.
test('thinking follows the setting, not whatever the last reply looked like', () => {
    const thinkingOn = { ...data, settings: { thinking: true } };
    const thinkingOff = { ...data, settings: { thinking: false } };
    assert.equal(registry.thinking.get(thinkingOn), 'thinking');
    assert.equal(registry.thinking.get(thinkingOff), '');
    // A transcript that carried a thinking block does not turn it on by itself.
    assert.equal(registry.thinking.get({ ctx: { thinking: true }, settings: { thinking: false } }), '');
});

test('every field survives an empty data object', () => {
    for (const [name, field] of Object.entries(registry)) {
        const value = field.get({}, '');
        assert.equal(typeof value, 'string', `${name} must return a string`);
        assert.equal(value, '', `${name} must be empty when there is no data`);
    }
});

test('every field declares a known topic and a doc line', () => {
    for (const [name, field] of Object.entries(registry)) {
        assert.ok(seg.TOPICS.includes(field.topic), `${name} has topic ${field.topic}`);
        assert.ok(field.doc && field.doc.length > 8, `${name} needs a doc line`);
    }
});

test('every preset is a complete bar built from placeholders that exist', () => {
    assert.ok(seg.PRESETS.length >= 4, 'a menu of one is not a menu');
    const ids = seg.PRESETS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, 'preset ids must be unique');

    for (const preset of seg.PRESETS) {
        assert.ok(preset.name && preset.about, `${preset.id} needs a name and a description`);
        assert.ok(preset.segments.length > 0, `${preset.id} has no segments`);
        for (const template of preset.segments) {
            // A typo here ships a bar with a literal {plcaeholder} in it, and
            // nothing else in the code would notice.
            for (const [, name] of template.matchAll(seg.NAME_RE)) {
                assert.ok(registry[name], `${preset.id} uses unknown placeholder {${name}}`);
            }
            // Every line must survive being rendered against real data, and a
            // line built only of literals is a decoration, not a preset.
            const out = seg.renderSegment(template, data, registry);
            assert.equal(typeof out.text, 'string');
            assert.ok(out.placeholders > 0, `${preset.id}: "${template}" carries no data at all`);
        }
    }
});

test('the default preset is the default bar, not a copy that can drift', () => {
    const first = seg.PRESETS[0];
    assert.equal(first.id, 'default');
    assert.equal(first.segments, seg.DEFAULT_SEGMENTS);
});

// It is the default bar with one placeholder swapped, and the four lines it
// does not touch are the default's own array — so a change to the default
// reaches it instead of leaving a stale copy behind.
test('Default + forecast differs from the default in exactly one line', () => {
    const preset = seg.PRESETS.find((p) => p.id === 'default-forecast');
    assert.equal(preset.segments.length, seg.DEFAULT_SEGMENTS.length);
    assert.deepEqual(preset.segments.slice(1), seg.DEFAULT_SEGMENTS.slice(1));
    assert.notEqual(preset.segments[0], seg.DEFAULT_SEGMENTS[0]);
    assert.ok(preset.segments[0].includes('{dryAt}'), 'the forecast is the unconditional one');
    assert.ok(!preset.segments[0].includes('{dry}') || preset.segments[0].includes('{dryAt}'));

    // With a forecast that lands after the reset, the default says nothing and
    // this one still names the day — the whole reason it exists.
    const afterReset = { ...data, pace: { plan: 60, dry: null, dryAt: NOW + 5 * 86400 } };
    assert.ok(!seg.renderSegment(seg.DEFAULT_SEGMENTS[0], afterReset, registry).text.includes('dry'));
    assert.ok(seg.renderSegment(preset.segments[0], afterReset, registry).text.includes('dry'));
});

test('a preset says something on a machine with data, and nothing on an empty one', () => {
    for (const preset of seg.PRESETS) {
        const shown = preset.segments
            .map((t) => seg.renderSegment(t, data, registry))
            .filter((o) => o.visible);
        assert.ok(shown.length > 0, `${preset.id} draws nothing even with full data`);

        // With no data at all every segment hides itself rather than leaving
        // punctuation stranded in the bar.
        for (const template of preset.segments) {
            assert.equal(seg.renderSegment(template, {}, registry).visible, false,
                `${preset.id}: "${template}" shows itself with nothing to say`);
        }
    }
});

test('usedFields reports only what the templates actually ask for', () => {
    const used = seg.usedFields(['{weekly} {bogus}', '[{jobs}]'], registry);
    assert.deepEqual([...used].sort(), ['jobs', 'weekly']);
});

test('workflow fields describe the run that is going right now', () => {
    // The done count is read off `totals.done` rather than counted here: what
    // makes an agent settled — finished, crashed, or cut off with the run — is
    // decided in workflows.js and tested there, and a second reading of the
    // state words in the string builder is how the two drift apart.
    const wfData = {
        ...data,
        workflows: {
            active: [{
                runId: 'wf_1', name: 'review-changes', state: 'running',
                startedAt: Date.now() - 720000,
                agents: [{ state: 'done' }, { state: 'progress' }, { state: 'progress' }],
                totals: { agents: 3, done: 1, cost: 1.5 },
            }],
        },
    };

    assert.equal(registry.wfName.get(wfData), 'review-changes');
    assert.equal(registry.wfAgents.get(wfData), '1/3');
    assert.equal(registry.wfElapsed.get(wfData), '12m');
    assert.equal(registry.wfCost.get(wfData), '$1.50');
    assert.equal(registry.wfRuns.get(wfData), '');
    assert.equal(registry.wfName.topic, 'workflow');
});

test('workflow fields say nothing when no run is going', () => {
    for (const name of ['wfName', 'wfAgents', 'wfElapsed', 'wfCost', 'wfRuns']) {
        assert.equal(registry[name].get({ workflows: { active: [] } }), '');
        assert.equal(registry[name].get({}), '');
    }
});

test('a run with no done count of its own says nothing rather than "undefined/3"', () => {
    const run = { name: 'x', agents: [{}, {}], totals: { agents: 2 }, startedAt: Date.now() };
    assert.equal(registry.wfAgents.get({ workflows: { active: [run] } }), '');
});

test('the workflow segment hides itself with nothing to report', () => {
    const template = seg.DEFAULT_SEGMENTS[4];
    assert.equal(seg.renderSegment(template, { workflows: { active: [] } }, registry).visible, false);
});

test('the run to talk about is the one that started last', () => {
    const run = (name, ago) => ({
        name, state: 'running', agents: [], totals: { agents: 0, done: 0 },
        startedAt: Date.now() - ago,
    });
    const active = [run('older', 600000), run('newest', 5000), run('old', 60000)];
    assert.equal(registry.wfName.get({ workflows: { active } }), 'newest');
    assert.equal(registry.wfRuns.get({ workflows: { active } }), '3');
});

test('zero and negative readings count as nothing to say', () => {
    const quiet = { ...data, stats: { cost: 0, burn: -1, apiPct: -1, added: 0, removed: 0, messages: 0, durationMs: 0 } };
    assert.equal(registry.cost.get(quiet), '');
    assert.equal(registry.burn.get(quiet), '');
    assert.equal(registry.apiShare.get(quiet), '');
    assert.equal(registry.added.get(quiet), '');
    assert.equal(seg.renderSegment('[~{cost}][ {burn}/h]', quiet, registry).visible, false);
});

// A preset's prose is printed through esc(), so markdown in it is drawn as
// markdown source. It looked like nothing until the Settings tab put those
// descriptions in cards, where a stray backtick is the most visible character
// on the page.
test('preset prose is plain text, not markdown', () => {
    for (const preset of seg.PRESETS) {
        assert.ok(!/[`*_]/.test(preset.about), `${preset.id}: markdown in its description`);
        assert.ok(!/[`*_]/.test(preset.name), `${preset.id}: markdown in its name`);
    }
});
