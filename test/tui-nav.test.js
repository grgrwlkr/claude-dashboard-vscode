const test = require('node:test');
const assert = require('node:assert');

const tui = require('../tui');

const vis = tui.visibleLength;

test('the map has the same six sections the page has, in the same order', () => {
    const ids = tui.SECTIONS.map((s) => s.id);
    assert.deepEqual(ids, ['now', 'spend', 'work', 'efficiency', 'setup', 'machine']);
});

test('every tab of the page is accounted for, present or named as absent', () => {
    // 24 tabs on the page. A tab a terminal cannot draw — an editor, a form —
    // is still listed, and says so when opened, rather than quietly missing.
    const all = tui.SECTIONS.flatMap((s) => s.tabs);
    assert.equal(all.length, 24, `${all.length} tabs, the page has 24`);
    for (const tab of all) {
        assert.equal(typeof tab.id, 'string');
        assert.equal(typeof tab.title, 'string');
    }
    assert.equal(new Set(all.map((t) => t.id)).size, 24, 'the ids are unique');
});

test('the section bar marks the section you are in', () => {
    const bar = tui.sectionBar(1, 90, false);
    for (const s of tui.SECTIONS) assert.ok(bar.includes(s.title), `${s.title} is missing`);
    assert.ok(bar.includes('[Spend]'), `the second section reads as active: ${bar}`);
    assert.ok(vis(bar) <= 90);
});

test('the tab bar shows only the tabs of the section you are in', () => {
    const bar = tui.tabBarFor(1, 0, 90, false);
    assert.ok(bar.includes('Overview'), 'a tab of Spend');
    assert.ok(!bar.includes('Skills'), 'and none of Work');
    assert.ok(bar.includes('[Overview]'), 'the first tab reads as active');
});

test('a section holding one tab draws no tab bar at all', () => {
    // `Now` is one tab. A bar with a single entry is a row spent saying nothing.
    assert.equal(tui.tabBarFor(0, 0, 90, false), '');
});

test('Tab walks the sections and wraps, keeping the tab index in range', () => {
    assert.deepEqual(tui.moveSection({ section: 0, tab: 0 }, 'next'), { section: 1, tab: 0 });
    assert.deepEqual(tui.moveSection({ section: 5, tab: 3 }, 'next'), { section: 0, tab: 0 });
    assert.deepEqual(tui.moveSection({ section: 0, tab: 0 }, 'prev'), { section: 5, tab: 0 });
    // Coming from a section with more tabs than the next one has.
    assert.deepEqual(tui.moveSection({ section: 4, tab: 5 }, 'next'), { section: 5, tab: 0 });
});

test('the arrows walk the tabs of the section, wrapping inside it', () => {
    assert.deepEqual(tui.moveTab({ section: 1, tab: 0 }, 'right'), { section: 1, tab: 1 });
    assert.deepEqual(tui.moveTab({ section: 1, tab: 3 }, 'right'), { section: 1, tab: 0 });
    assert.deepEqual(tui.moveTab({ section: 1, tab: 0 }, 'left'), { section: 1, tab: 3 });
    // A digit picks a tab of this section; one past the end changes nothing.
    assert.deepEqual(tui.moveTab({ section: 1, tab: 0 }, '3'), { section: 1, tab: 2 });
    assert.deepEqual(tui.moveTab({ section: 1, tab: 2 }, '9'), { section: 1, tab: 2 });
});

test('the current tab is looked up by where you are', () => {
    assert.equal(tui.tabAt({ section: 0, tab: 0 }).id, 'now');
    assert.equal(tui.tabAt({ section: 1, tab: 2 }).id, 'projects');
    assert.equal(tui.tabAt({ section: 5, tab: 3 }).id, 'disk');
    // Out of range answers the first tab rather than throwing.
    assert.equal(tui.tabAt({ section: 99, tab: 99 }).id, 'now');
});

// --- the body of every tab ------------------------------------------------

const helpers = {
    fmtCost: (n) => `~$${n.toFixed(2)}`,
    tok: (n) => `${Math.round(n / 1000)}k`,
    fmtLeft: () => '2h',
    fmtAbs: () => 'Mon 07:45',
    fmtDuration: (ms) => `${Math.round(ms / 3600000)}h`,
    shortModel: (m) => m.replace(/^claude-/, ''),
};

const bucket = (rows) => Object.fromEntries(rows.map((r) => [r[0], r[1]]));
const summary = {
    days: bucket([['2026-08-25', { cost: 12.5, tokens: 1e6 }]]),
    models: bucket([['claude-opus-5', { cost: 100, tokens: 2e6 }]]),
    branches: bucket([['master', { cost: 9, tokens: 4e5 }]]),
    skills: bucket([['release', { cost: 2, tokens: 1e5, count: 3 }]]),
    agents: bucket([['collector', { cost: 4.5, tokens: 3e5, count: 12 }]]),
    tools: bucket([['Bash', { count: 900, tokens: 2e5 }]]),
    files: bucket([['tui.js', { count: 40, tokens: 1e5 }]]),
    sessions: bucket([['abc', { cost: 3, tokens: 2e5, project: 'repo' }]]),
    projects: bucket([['claude-statusline', { cost: 40, tokens: 8e5 }]]),
    efforts: bucket([['xhigh', { cost: 30, tokens: 6e5, count: 200 }]]),
    friction: bucket([['edit-retry', { count: 7 }]]),
    prompts: bucket([['long', { count: 40 }]]),
    hours: bucket([['14', { cost: 5, tokens: 1e5 }]]),
};

test('every one of the 24 tabs draws something rather than nothing', () => {
    for (let s = 0; s < tui.SECTIONS.length; s++) {
        for (let t = 0; t < tui.SECTIONS[s].tabs.length; t++) {
            const tab = tui.SECTIONS[s].tabs[t];
            const body = tui.bodyFor(tab.id, { summary, helpers, width: 90, colour: false, sections: [], d: {} });
            assert.ok(Array.isArray(body), `${tab.id} returned no body`);
            assert.ok(body.join('').trim().length > 0, `${tab.id} drew only blanks`);
            for (const line of body) {
                assert.ok(vis(line) <= 90, `${tab.id} ran to ${vis(line)}: ${line.slice(0, 40)}`);
            }
        }
    }
});

test('a tab backed by a bucket shows what is in it', () => {
    const ctx = { summary, helpers, width: 90, colour: false, sections: [], d: {} };
    assert.match(tui.bodyFor('projects', ctx).join('\n'), /claude-statusline/);
    assert.match(tui.bodyFor('branches', ctx).join('\n'), /master/);
    assert.match(tui.bodyFor('skills', ctx).join('\n'), /release/);
    assert.match(tui.bodyFor('tools', ctx).join('\n'), /Bash/);
    assert.match(tui.bodyFor('files', ctx).join('\n'), /tui\.js/);
    assert.match(tui.bodyFor('agents', ctx).join('\n'), /collector/);
    assert.match(tui.bodyFor('models', ctx).join('\n'), /opus 5/);
    assert.match(tui.bodyFor('models', ctx).join('\n'), /xhigh/, 'effort sits with the models');
});

test('a tab the terminal cannot draw says where it lives instead', () => {
    const ctx = { summary, helpers, width: 90, colour: false, sections: [], d: {} };
    // Settings and Launch are an editor and a form. Pretending they are missing
    // data would send someone looking for an index that is already there.
    for (const id of ['settings', 'launch']) {
        const text = tui.bodyFor(id, ctx).join('\n');
        assert.match(text, /editor|VS Code|extension/i, `${id} does not say where to find it: ${text}`);
    }
});

test('an empty index leaves every tab saying so, not crashing', () => {
    const ctx = { summary: {}, helpers, width: 90, colour: false, sections: [], d: {} };
    for (const s of tui.SECTIONS) {
        for (const tab of s.tabs) {
            const body = tui.bodyFor(tab.id, ctx);
            assert.ok(body.join('').trim().length > 0, `${tab.id} drew nothing on an empty index`);
        }
    }
});

test('the synthetic record is left out of every model breakdown', () => {
    // `<synthetic>` is what the client writes in place of a reply that never
    // came. It reaches counters of messages; it is not a model and belongs in
    // no list of them.
    const withSynthetic = {
        models: {
            'claude-opus-5': { cost: 100, tokens: 2e6 },
            '<synthetic>': { cost: 0, tokens: 0 },
        },
    };
    const ctx = { summary: withSynthetic, helpers, width: 90, colour: false, sections: [], d: {} };
    for (const id of ['overview', 'models']) {
        const text = tui.bodyFor(id, ctx).join('\n');
        assert.ok(!text.includes('synthetic'), `${id} lists it: ${text}`);
        assert.match(text, /opus 5/, `${id} still lists the real models`);
    }
});
