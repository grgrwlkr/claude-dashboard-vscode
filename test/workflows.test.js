const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const wf = require('../workflows');
const ix = require('../indexer');

// A scratch tree shaped like ~/.claude/projects. Every test that touches disk
// builds one: the layout is the contract, so a fixture that fakes it flatter
// would pass while the real reader fails.
function tree(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-wf-'));
    const slug = '-Users-x-Develop-demo';
    const session = 'aaaa1111-2222-3333-4444-555566667777';
    const write = (rel, body) => {
        const full = path.join(root, slug, session, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body));
        return full;
    };
    try { return fn({ root, slug, session, write }); } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

const FINAL = {
    runId: 'wf_abc123def-456',
    workflowName: 'review-changes',
    status: 'completed',
    durationMs: 181000,
    agentCount: 2,
    totalTokens: 476865,
    totalToolCalls: 309,
    scriptPath: '/tmp/review-changes-wf_abc123def-456.js',
    phases: [{ title: 'Review', detail: 'one agent per dimension' }],
    workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Review' },
        {
            type: 'workflow_agent', index: 1, label: 'review:bugs', phaseIndex: 1, phaseTitle: 'Review',
            agentId: 'a11111111111111', model: 'claude-opus-5', state: 'done',
            lastToolName: 'StructuredOutput', promptPreview: 'Найди баги…', resultPreview: '{"findings":[]}',
            tokens: 353534, toolCalls: 259, durationMs: 180000,
        },
        {
            type: 'workflow_agent', index: 2, label: 'review:perf', phaseIndex: 1, phaseTitle: 'Review',
            agentId: 'a22222222222222', model: 'claude-opus-5', state: 'error',
            tokens: 123331, toolCalls: 50, durationMs: 44000,
        },
    ],
};

test('readFinal reads the run, its phases and its agents', () => tree(({ write }) => {
    const file = write('workflows/wf_abc123def-456.json', FINAL);
    const final = wf.readFinal(file);

    assert.equal(final.runId, 'wf_abc123def-456');
    assert.equal(final.name, 'review-changes');
    assert.equal(final.status, 'completed');
    assert.deepEqual(final.phases, [{ title: 'Review', detail: 'one agent per dimension' }]);
    assert.equal(final.agents.length, 2);
    assert.equal(final.agents[0].label, 'review:bugs');
    assert.equal(final.agents[0].phase, 'Review');
    assert.equal(final.agents[0].state, 'done');
    assert.equal(final.agents[1].state, 'error');
    assert.equal(final.totals.agents, 2);
    assert.equal(final.totals.toolCalls, 309);
}));

test('readFinal survives a truncated or foreign json', () => tree(({ write }) => {
    assert.equal(wf.readFinal(write('workflows/wf_broken-1.json', '{"runId": "wf_bro')), null);
    // A snapshot from a future client that dropped workflowProgress entirely:
    // the run is still worth showing, it just has no agents to list.
    const thin = wf.readFinal(write('workflows/wf_thin-1.json', { runId: 'wf_thin-1', status: 'killed' }));
    assert.equal(thin.status, 'killed');
    assert.deepEqual(thin.agents, []);
    assert.equal(thin.name, '');
}));

// A killed run counts agents it queued but never named: on live data one snapshot
// claims 74 against 13 listed entries. The list is what a panel can show, so the
// client's own count is kept beside it rather than on top of it.
test('readFinal counts the agents it listed, and keeps the client count apart', () => tree(({ write }) => {
    const final = wf.readFinal(write('workflows/wf_killed-1.json', {
        runId: 'wf_killed-1',
        status: 'killed',
        agentCount: 74,
        workflowProgress: [
            { type: 'workflow_agent', agentId: 'b1', label: 'scan:1', state: 'done' },
            { type: 'workflow_agent', label: 'queued, never started', state: 'start' },
        ],
    }));

    assert.equal(final.totals.agents, 1);
    assert.equal(final.totals.reported, 74);
}));

// The client's own capped preview is 400 characters plus an ellipsis, so cutting
// at 400 and adding one back leaves it byte for byte as it was; anything longer
// is ours to cut, and it says so.
test('readFinal marks a preview it cut itself and leaves a short one alone', () => tree(({ write }) => {
    const final = wf.readFinal(write('workflows/wf_long-1.json', {
        runId: 'wf_long-1',
        workflowProgress: [
            { type: 'workflow_agent', agentId: 'c1', promptPreview: 'x'.repeat(500), resultPreview: 'y'.repeat(400) },
        ],
    }));

    assert.equal(final.agents[0].promptPreview.length, 401);
    assert.ok(final.agents[0].promptPreview.endsWith('…'));
    assert.equal(final.agents[0].resultPreview, 'y'.repeat(400));
}));

test('readFinal ignores an agent entry with no id', () => tree(({ write }) => {
    const final = wf.readFinal(write('workflows/wf_x-1.json', {
        runId: 'wf_x-1',
        workflowProgress: [{ type: 'workflow_agent', label: 'nameless' }],
    }));
    assert.deepEqual(final.agents, []);
}));

// The two fields that only the live side used to have. A snapshot carries both —
// `agentType` on 17 of the 1356 real entries, `lastProgressAt` on all of them —
// so a renderer drawing finished and running agents from one shape gets a value
// for each rather than undefined.
test('readFinal carries the two fields a live agent also has', () => tree(({ write }) => {
    const final = wf.readFinal(write('workflows/wf_type-1.json', {
        runId: 'wf_type-1',
        workflowProgress: [{
            type: 'workflow_agent', agentId: 'd1', state: 'done',
            agentType: 'general-purpose', lastProgressAt: 1785004565521,
        }],
    }));

    assert.equal(final.agents[0].agentType, 'general-purpose');
    assert.equal(final.agents[0].lastActivity, 1785004565521);
    // An entry without them says so with a zero, not with undefined.
    const bare = wf.readFinal(write('workflows/wf_type-2.json', {
        runId: 'wf_type-2',
        workflowProgress: [{ type: 'workflow_agent', agentId: 'd2', state: 'done' }],
    }));
    assert.equal(bare.agents[0].agentType, '');
    assert.equal(bare.agents[0].lastActivity, 0);
}));

test('phasesFromScript pulls the phase titles out of the meta literal', () => {
    const script = `export const meta = {
    name: 'review-changes',
    description: 'Review changed files across dimensions, verify each finding',
    phases: [
        { title: 'Review', detail: 'one agent per dimension' },
        { title: 'Verify' },
    ],
}
phase('Review')
const results = await pipeline(DIMENSIONS, d => agent(d.prompt))`;

    assert.deepEqual(wf.phasesFromScript(script), [
        { title: 'Review', detail: 'one agent per dimension' },
        { title: 'Verify', detail: '' },
    ]);
});

// The workflows Claude Code ships — /code-review and /deep-research — write the
// meta literal as JSON, keys quoted and all on one line. Six of the 64 scripts on
// this machine are theirs, and they are the ones every user has, so a reader that
// only knows bare keys is blank exactly where it matters most.
test('phasesFromScript reads a meta literal whose keys are quoted', () => {
    const script = `export const meta = {
  name: "code-review",
  phases: [{"title":"Scope","detail":"Pin the diff command and the changed files"},{"title":"Find","detail":"One finder per correctness angle"},{"title":"Synthesize"}],
}`;

    assert.deepEqual(wf.phasesFromScript(script), [
        { title: 'Scope', detail: 'Pin the diff command and the changed files' },
        { title: 'Find', detail: 'One finder per correctness angle' },
        { title: 'Synthesize', detail: '' },
    ]);
});

test('phasesFromScript returns nothing rather than guessing', () => {
    assert.deepEqual(wf.phasesFromScript('export const meta = { name: "x" }'), []);
    assert.deepEqual(wf.phasesFromScript(''), []);
    assert.deepEqual(wf.phasesFromScript('phases: [ {title: '), []);
    // A `phases` word outside the meta block must not be mistaken for the real one.
    assert.deepEqual(wf.phasesFromScript('log("phases: [{title: 1}]")'), []);
});

// The whole point of reading `meta` and not the file: a script that declares no
// phases has none, and the first `phases:` its own code happens to log is not a
// substitute. This is the only place the function could have invented a value
// instead of returning nothing.
test('phasesFromScript ignores a phases: line that lives outside the meta literal', () => {
    const script = `export const meta = { name: 'x', description: 'y' }
log("phases: [{title: 'FAKE'}]")`;

    assert.deepEqual(wf.phasesFromScript(script), []);
});

// Counting braces means honouring string literals: a `}` written in prose is a
// character, not the end of the block, and a quote escaped inside a string does
// not end the string.
test('phasesFromScript is not fooled by a brace inside a string in the meta literal', () => {
    const script = `export const meta = {
    name: 'x',
    description: 'it\\'s got a } brace in the prose',
    phases: [{ title: 'Review', detail: 'one agent per dimension' }],
}`;

    assert.deepEqual(wf.phasesFromScript(script), [
        { title: 'Review', detail: 'one agent per dimension' },
    ]);
});

test('phasesFromScript gives up on a meta literal that is never closed', () => {
    assert.deepEqual(wf.phasesFromScript('export const meta = {\n  phases: [{ title: "Review" }],'), []);
});

// `subtitle` ends in `title`, so a key match with no left-hand boundary reads the
// wrong value — and reading the wrong one is worse than reading none.
test('phasesFromScript does not mistake subtitle: for title:', () => {
    const script = "export const meta = { phases: [{ subtitle: 'sub', title: 'real' }] }";

    assert.deepEqual(wf.phasesFromScript(script), [{ title: 'real', detail: '' }]);
});

test('phasesFromScript reads values written in backticks', () => {
    const script = 'export const meta = { phases: [{ title: `Review`, detail: `one agent per dimension` }] }';

    assert.deepEqual(wf.phasesFromScript(script), [
        { title: 'Review', detail: 'one agent per dimension' },
    ]);
});

// Locked in as behaviour, not left as a surprise: a `]` inside a value ends the
// phases array early, and what is left holds no complete entry, so the whole list
// goes rather than half of it. Nothing on this machine writes one — the point is
// that the failure stays empty instead of turning into a guess.
test('phasesFromScript drops the whole list when a value contains a bracket', () => {
    const script = "export const meta = { phases: [{ title: 'A', detail: 'a ] b' }, { title: 'B' }] }";

    assert.deepEqual(wf.phasesFromScript(script), []);
});

// Run directories and snapshots in one call, so a fixture reads like the tree
// it imitates: a finished run has both, a live one has only the directory.
function runFixture({ write }, id, { final = null, journal = [], agents = {}, script = '' } = {}) {
    for (const [agentId, lines] of Object.entries(agents)) {
        write(`subagents/workflows/${id}/agent-${agentId}.jsonl`, lines.join('\n') + '\n');
        write(`subagents/workflows/${id}/agent-${agentId}.meta.json`,
            { agentType: 'workflow-subagent', spawnDepth: 1 });
    }
    if (journal.length) {
        write(`subagents/workflows/${id}/journal.jsonl`,
            journal.map((j) => JSON.stringify(j)).join('\n') + '\n');
    }
    if (script) write(`workflows/scripts/demo-${id}.js`, script);
    if (final) write(`workflows/${id}.json`, final);
}

// The two lines a live agent transcript is read for: the first user record
// carries the prompt, the newest assistant record the model and the tool.
const AGENT_LINES = (id) => [
    JSON.stringify({ type: 'user', promptSource: 'workflow', message: { role: 'user', content: `Задача агента ${id}: проверить фикстуры и вернуть список находок` } }),
    JSON.stringify({
        type: 'assistant', timestamp: '2026-08-09T10:00:00Z',
        message: { model: 'claude-opus-5', usage: { input_tokens: 5, output_tokens: 100 }, content: [{ type: 'tool_use', id: 't1', name: 'Grep' }] },
    }),
];

// The same write, aimed at a second session of the same project: one run leaves
// its directory under one session id and its snapshot under another, and a
// fixture that cannot express that cannot test the merge.
function writeAt({ root, slug }, session, rel, body) {
    const full = path.join(root, slug, session, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body));
    return full;
}

const SECOND = 'bbbb2222-3333-4444-5555-666677778888';

test('scanRuns separates a finished run from a live one and a dead one', () => tree((t) => {
    runFixture(t, 'wf_done-1', { final: { ...FINAL, runId: 'wf_done-1' }, journal: [{ type: 'started', agentId: 'a1' }] });
    runFixture(t, 'wf_live-1', { journal: [{ type: 'started', agentId: 'a1' }] });
    runFixture(t, 'wf_dead-1', { journal: [{ type: 'started', agentId: 'a1' }] });

    // The abandoned one has not been touched in an hour; the live one just was.
    const old = new Date(Date.now() - 3600 * 1000);
    const dead = path.join(t.root, t.slug, t.session, 'subagents/workflows/wf_dead-1');
    for (const f of fs.readdirSync(dead)) fs.utimesSync(path.join(dead, f), old, old);
    fs.utimesSync(dead, old, old);

    const runs = wf.scanRuns({
        root: t.root,
        liveSessions: new Set([t.session]),
        now: Date.now(),
    });
    const by = Object.fromEntries(runs.map((r) => [r.runId, r]));

    assert.equal(by['wf_done-1'].state, 'finished');
    assert.equal(by['wf_done-1'].name, 'review-changes');
    assert.equal(by['wf_done-1'].agents.length, 2);
    assert.equal(by['wf_live-1'].state, 'running');
    assert.equal(by['wf_dead-1'].state, 'abandoned');
    assert.equal(by['wf_live-1'].project, 'demo');
    assert.equal(by['wf_live-1'].sessionId, t.session);
}));

test('outcomeOf reads the states the client actually writes', () => {
    // Observed across 1356 live agent records: done, start, progress, error.
    // "failed" never appears — an icon table keyed on it would paint a crashed
    // agent as a success, which is the one mistake this function exists to stop.
    assert.equal(wf.outcomeOf('done'), 'done');
    assert.equal(wf.outcomeOf('error'), 'failed');
    assert.equal(wf.outcomeOf('failed'), 'failed');
    assert.equal(wf.outcomeOf('start'), 'running');
    assert.equal(wf.outcomeOf('progress'), 'running');
    assert.equal(wf.outcomeOf('running'), 'running');
    assert.equal(wf.outcomeOf(''), 'unknown');
    assert.equal(wf.outcomeOf('some-future-word'), 'unknown');
});

test('a fresh run whose session is gone is abandoned, not running', () => tree((t) => {
    runFixture(t, 'wf_orphan-1', { journal: [{ type: 'started', agentId: 'a1' }] });
    const runs = wf.scanRuns({ root: t.root, liveSessions: new Set(), now: Date.now() });
    assert.equal(runs[0].state, 'abandoned');
}));

test('a snapshot with no run directory is still listed', () => tree((t) => {
    // Seen on the real machine: 73 snapshots against 69 run directories.
    t.write('workflows/wf_lonely-1.json', { ...FINAL, runId: 'wf_lonely-1' });
    const runs = wf.scanRuns({ root: t.root, liveSessions: new Set(), now: Date.now() });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].state, 'finished');
    assert.equal(runs[0].runDir, '');
    // The snapshot is written at the end, so its own timestamps say nothing
    // about the start. Nine such runs on this machine would otherwise claim to
    // have begun the moment they ended, one of them after 53 minutes of work.
    assert.equal(runs[0].startedAt, 0);
}));

test('scanRuns takes the run start from the directory, never from startTime', () => tree((t) => {
    // startTime here is four hours off, the way it is on a third of the real
    // snapshots. The directory is the only honest clock.
    runFixture(t, 'wf_clock-1', {
        final: { ...FINAL, runId: 'wf_clock-1', startTime: Date.now() - 4 * 3600 * 1000 },
        journal: [{ type: 'started', agentId: 'a1' }],
        script: "export const meta = { phases: [{ title: 'Review' }] }",
    });
    const [run] = wf.scanRuns({ root: t.root, liveSessions: new Set(), now: Date.now() });
    const dirBirth = fs.statSync(run.runDir).birthtimeMs || fs.statSync(run.runDir).mtimeMs;
    assert.ok(Math.abs(run.startedAt - dirBirth) < 2000);
    // The script is named <workflow-name>-<runId>.js, and the run id is the tail.
    assert.equal(path.basename(run.scriptPath), 'demo-wf_clock-1.js');
}));

// One run, two session directories: the half with the run directory and the
// script under one session, the snapshot under another. Five such pairs on this
// machine, each matching to about 20 ms at both ends — the same run, not two.
test('two halves of one run in two sessions become one record', () => tree((t) => {
    runFixture(t, 'wf_split-1', {
        journal: [{ type: 'started', agentId: 'a1' }],
        script: "export const meta = { phases: [{ title: 'Review' }] }",
    });
    writeAt(t, SECOND, 'workflows/wf_split-1.json', { ...FINAL, runId: 'wf_split-1' });

    const runs = wf.scanRuns({ root: t.root, liveSessions: new Set(), now: Date.now() });
    assert.equal(runs.length, 1);
    const [run] = runs;
    assert.equal(run.state, 'finished');
    assert.equal(run.name, 'review-changes');
    assert.ok(run.runDir, 'the directory half survives the merge');
    assert.ok(run.jsonPath, 'the snapshot half survives the merge');
    // The script lives beside the directory, not beside the snapshot.
    assert.equal(path.basename(run.scriptPath), 'demo-wf_split-1.js');
    assert.equal(run.sessionId, SECOND);
    assert.deepEqual([...run.sessions].sort(), [SECOND, t.session].sort());
    // Merging hands the run the directory's birth, which the snapshot half alone
    // could not supply.
    assert.ok(run.startedAt > 0);
}));

// wf_00e91f74-a5b on this machine: killed with 7 agents and 1.0M tokens in one
// session, completed with 65 agents and 7.8M in another, and the run directory
// sits beside the killed one. These are two attempts sharing a run id, so
// folding them together would show one run wearing the other's numbers.
test('two snapshots of one run id stay two records', () => tree((t) => {
    runFixture(t, 'wf_twice-1', {
        final: { ...FINAL, runId: 'wf_twice-1', status: 'killed' },
        journal: [{ type: 'started', agentId: 'a1' }],
    });
    writeAt(t, SECOND, 'workflows/wf_twice-1.json', { ...FINAL, runId: 'wf_twice-1', status: 'completed' });

    const runs = wf.scanRuns({ root: t.root, liveSessions: new Set(), now: Date.now() });
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map((r) => r.status).sort(), ['completed', 'killed']);
}));

test('a merged run is live while the session that owns its directory is', () => tree((t) => {
    // The snapshot half is truncated, so the run is not finished and its state
    // falls to liveness. The record is named after the snapshot's session, which
    // is dead; the session doing the work is the one holding the directory, and
    // testing sessionId alone would bury a live run.
    runFixture(t, 'wf_half-1', { journal: [{ type: 'started', agentId: 'a1' }] });
    writeAt(t, SECOND, 'workflows/wf_half-1.json', '{"runId": "wf_half');

    const runs = wf.scanRuns({ root: t.root, liveSessions: new Set([t.session]), now: Date.now() });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].sessionId, SECOND);
    assert.equal(runs[0].state, 'running');
}));

test('outcomeOf calls a working agent inside a run that ended stopped', () => {
    // 28 agents on this machine sit at progress or start inside runs that were
    // killed weeks ago. They are not failures — nothing crashed, the run was cut
    // from outside — and they are certainly not still running.
    assert.equal(wf.outcomeOf('progress', 'finished'), 'stopped');
    assert.equal(wf.outcomeOf('start', 'abandoned'), 'stopped');
    assert.equal(wf.outcomeOf('progress', 'running'), 'running');
    // A terminal word answers for itself, whatever the run went on to do.
    assert.equal(wf.outcomeOf('done', 'abandoned'), 'done');
    assert.equal(wf.outcomeOf('error', 'finished'), 'failed');
    assert.equal(wf.outcomeOf('some-future-word', 'finished'), 'unknown');
    // One argument answers exactly as it did before the second one existed.
    assert.equal(wf.outcomeOf('progress'), 'running');
    assert.equal(wf.outcomeOf('done'), 'done');
});

test('readLive names the agents a running workflow has on disk', () => tree((t) => {
    runFixture(t, 'wf_live-2', {
        journal: [
            { type: 'started', agentId: 'a1' },
            { type: 'started', agentId: 'a2' },
            { type: 'result', agentId: 'a1', result: { ok: true } },
        ],
        agents: { a1: AGENT_LINES('a1'), a2: AGENT_LINES('a2') },
    });
    const dir = path.join(t.root, t.slug, t.session, 'subagents/workflows/wf_live-2');
    const live = wf.readLive(dir);

    assert.equal(live.total, 2);
    assert.equal(live.done, 1);
    const a2 = live.agents.find((a) => a.agentId === 'a2');
    assert.equal(a2.state, 'running');
    assert.equal(a2.model, 'claude-opus-5');
    assert.equal(a2.lastToolName, 'Grep');
    assert.equal(a2.agentType, 'workflow-subagent');
    assert.ok(a2.promptPreview.startsWith('Задача агента a2'));
    assert.equal(a2.label, '');
    assert.equal(live.agents.find((a) => a.agentId === 'a1').state, 'done');
}));

test('readLive degrades on a half-written run directory', () => tree((t) => {
    runFixture(t, 'wf_live-3', { journal: [{ type: 'started', agentId: 'a1' }] });
    const dir = path.join(t.root, t.slug, t.session, 'subagents/workflows/wf_live-3');
    // Journal knows an agent whose transcript has not appeared yet.
    const live = wf.readLive(dir);
    assert.equal(live.total, 1);
    assert.equal(live.agents[0].model, '');
    assert.equal(wf.readLive(path.join(t.root, 'nope')), null);
}));

test('scanRuns fills a running workflow with its live agents', () => tree((t) => {
    runFixture(t, 'wf_live-4', {
        journal: [{ type: 'started', agentId: 'a1' }],
        agents: { a1: AGENT_LINES('a1') },
        script: `export const meta = { name: 'demo', phases: [{ title: 'Scan' }] }`,
    });
    const [run] = wf.scanRuns({ root: t.root, liveSessions: new Set([t.session]), now: Date.now() });
    assert.equal(run.state, 'running');
    assert.equal(run.agents.length, 1);
    assert.equal(run.name, 'demo');
    assert.deepEqual(run.phases, [{ title: 'Scan', detail: '' }]);
}));

// The other direction of the same race: the transcript file exists before the
// journal has written the line that started it. This is the branch the roster
// walks the directory for, and nothing on real data exercises it.
test('readLive counts an agent whose transcript beat the journal', () => tree((t) => {
    runFixture(t, 'wf_live-5', {
        journal: [{ type: 'started', agentId: 'a1' }],
        agents: { a1: AGENT_LINES('a1'), a2: AGENT_LINES('a2') },
    });
    const live = wf.readLive(path.join(t.root, t.slug, t.session, 'subagents/workflows/wf_live-5'));
    assert.equal(live.total, 2);
    assert.equal(live.agents.find((a) => a.agentId === 'a2').state, 'running');
}));

// A finished run answers the same question from its own agents, so a panel does
// not have to ask it differently depending on which state the run is in. A word
// the client invented later is not counted as either outcome.
test('totals.done counts the settled agents of a finished run, crashes included', () => tree((t) => {
    runFixture(t, 'wf_settled-1', {
        final: {
            ...FINAL,
            runId: 'wf_settled-1',
            workflowProgress: [
                ...FINAL.workflowProgress,
                { type: 'workflow_agent', agentId: 'a33333333333333', state: 'some-future-word' },
            ],
        },
    });
    const [run] = wf.scanRuns({ root: t.root, liveSessions: new Set(), now: Date.now() });

    assert.equal(run.totals.agents, 3);
    assert.equal(run.totals.done, 2);
}));

test('snapshotArrived notices a run that just finished', () => tree((t) => {
    runFixture(t, 'wf_fin-1', { journal: [{ type: 'started', agentId: 'a1' }] });
    const [run] = wf.scanRuns({ root: t.root, liveSessions: new Set([t.session]), now: Date.now() });
    assert.equal(wf.snapshotArrived(run), false);
    t.write('workflows/wf_fin-1.json', { ...FINAL, runId: 'wf_fin-1' });
    assert.equal(wf.snapshotArrived(run), true);
}));

// Five runs on this machine write their snapshot into a session other than the
// one holding the run directory. While the run is going that session does not
// exist yet, so no path derived from the run can name it — every session of the
// project has to be asked.
test('snapshotArrived finds a snapshot that landed in a sibling session', () => tree((t) => {
    runFixture(t, 'wf_sib-1', { journal: [{ type: 'started', agentId: 'a1' }] });
    const [run] = wf.scanRuns({ root: t.root, liveSessions: new Set([t.session]), now: Date.now() });
    assert.equal(wf.snapshotArrived(run), false);
    writeAt(t, SECOND, 'workflows/wf_sib-1.json', { ...FINAL, runId: 'wf_sib-1' });
    assert.equal(wf.snapshotArrived(run), true);
}));

// The index the join reads, built over the fixture tree. Its storage goes in a
// scratch directory of its own: refreshIndex writes index.json, and the tree
// under test has to stay exactly what the fixture put in it.
function indexOf(root) {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-idx-'));
    try { return ix.refreshIndex(store, { root }).index; } finally {
        fs.rmSync(store, { recursive: true, force: true });
    }
}

test('withCost prices finished agents from the index', () => tree((t) => {
    runFixture(t, 'wf_paid-1', {
        final: { ...FINAL, runId: 'wf_paid-1' },
        agents: { a11111111111111: AGENT_LINES('a1'), a22222222222222: AGENT_LINES('a2') },
    });
    const index = indexOf(t.root);
    const runs = wf.withCost(
        wf.scanRuns({ root: t.root, liveSessions: new Set(), now: Date.now() }),
        { index },
    );

    const [run] = runs;
    assert.ok(run.totals.cost > 0, 'a finished run is priced');
    assert.ok(run.agents.every((a) => a.cost > 0), 'every agent carries its own price');
    // The lump totalTokens of the snapshot must never become the token figure:
    // it has no split, so it cannot be priced, and it counts a different thing
    // besides. It is not thrown away either — it moves next to ours.
    assert.notEqual(run.totals.tokens, FINAL.totalTokens);
    assert.equal(run.totals.reportedTokens, FINAL.totalTokens);
    assert.equal(run.agents[0].reportedTokens, FINAL.workflowProgress[1].tokens);
    // Ours and only ours in `tokens`, so the run total is the sum of its agents.
    assert.equal(run.totals.tokens, run.agents.reduce((a, x) => a + x.tokens, 0));
    // The counts the scan put there survive the join.
    assert.equal(run.totals.agents, 2);
    assert.equal(run.totals.done, 2);
    // Pricing runs that have already been priced changes nothing — a second
    // pass must not swallow the client's figure into ours or double the money.
    assert.deepEqual(wf.withCost(runs, { index })[0], run);
}));

test('a live run is priced only when the caller asks for it', () => tree((t) => {
    runFixture(t, 'wf_live-6', {
        journal: [{ type: 'started', agentId: 'a1' }],
        agents: { a1: AGENT_LINES('a1') },
    });
    const runs = wf.scanRuns({ root: t.root, liveSessions: new Set([t.session]), now: Date.now() });

    const cheap = wf.withCost(runs, { index: { files: {} } });
    assert.equal(cheap[0].agents[0].cost, 0, 'the fast path prices nothing');
    assert.equal(cheap[0].totals.cost, 0);

    const full = wf.withCost(runs, { index: { files: {} }, live: true });
    assert.ok(full[0].agents[0].tokens > 0, 'the slow path reads the transcript');
    assert.ok(full[0].totals.cost > 0, 'and prices what it read');

    // A live agent has nothing on the client's side of the fence and never will
    // until the snapshot lands, so both its figures start at zero. Pricing the
    // result again must leave that zero alone rather than read our own count
    // into it — the one place where "already priced" cannot be told from
    // "priced at nothing" by truthiness.
    const again = wf.withCost(full, { index: { files: {} }, live: true });
    assert.equal(again[0].agents[0].reportedTokens, 0);
    assert.equal(again[0].totals.reportedTokens, 0);
    assert.deepEqual(again[0], full[0]);
}));

// The index is rebuilt when the dashboard is opened, which can happen in the
// middle of a run: the row it wrote then is a photograph of a file that is still
// growing. Asked for the live price, the transcript answers — otherwise a
// running run's cost freezes at whatever it was when the panel was opened.
test('a running run is priced from its transcript, not from a row written mid-run', () => tree((t) => {
    runFixture(t, 'wf_stale-1', {
        journal: [{ type: 'started', agentId: 'a1' }],
        agents: { a1: AGENT_LINES('a1') },
    });
    const stale = {
        files: {
            '/x.jsonl': {
                agg: {
                    sessions: [{
                        kind: 'workflow', workflowId: 'wf_stale-1', agentId: 'a1', cost: 1e-9, tokens: 1,
                    }],
                },
            },
        },
    };
    const [run] = wf.withCost(
        wf.scanRuns({ root: t.root, liveSessions: new Set([t.session]), now: Date.now() }),
        { index: stale, live: true },
    );

    assert.ok(run.agents[0].tokens > 1, 'the growing transcript answers, not the stale row');
    assert.ok(run.totals.cost > 1e-9);
}));

// A live run does not always own the transcripts of its own agents: a run
// resumed with resumeFromRunId writes into the directory of the attempt before
// it, and an agent that returned from cache leaves nothing here at all. The
// transcript is asked first and the index answers when there is none.
test('a live agent with no transcript here is still priced from the index', () => tree((t) => {
    runFixture(t, 'wf_resume-1', {
        journal: [{ type: 'started', agentId: 'a1' }, { type: 'started', agentId: 'a2' }],
        agents: { a1: AGENT_LINES('a1') },
    });
    const index = {
        files: {
            '/elsewhere.jsonl': {
                agg: {
                    sessions: [{
                        kind: 'workflow', workflowId: 'wf_resume-1', agentId: 'a2',
                        cost: 0.25, tokens: 999,
                    }],
                },
            },
        },
    };

    const [run] = wf.withCost(
        wf.scanRuns({ root: t.root, liveSessions: new Set([t.session]), now: Date.now() }),
        { index, live: true },
    );
    const a1 = run.agents.find((a) => a.agentId === 'a1');
    const a2 = run.agents.find((a) => a.agentId === 'a2');

    assert.ok(a1.cost > 0, 'the agent that is here comes from its transcript');
    assert.equal(a2.cost, 0.25, 'the agent that is not comes from the index');
    assert.equal(a2.tokens, 999);
    assert.equal(run.totals.cost, a1.cost + 0.25);
}));

test('withCost survives an index with no workflow rows', () => tree((t) => {
    runFixture(t, 'wf_nocost-1', { final: { ...FINAL, runId: 'wf_nocost-1' } });
    const runs = wf.withCost(wf.scanRuns({ root: t.root, liveSessions: new Set(), now: Date.now() }), {});

    assert.equal(runs[0].totals.cost, 0);
    assert.equal(runs[0].agents[0].cost, 0);
    // Nothing to price leaves a zero rather than the client's own figure, which
    // measures the agent's context and not what it spent. The figure itself is
    // not lost — it moves to the name that says whose it is.
    assert.equal(runs[0].totals.tokens, 0);
    assert.equal(runs[0].agents[0].tokens, 0);
    assert.equal(runs[0].totals.reportedTokens, FINAL.totalTokens);
    assert.equal(runs[0].agents[0].reportedTokens, FINAL.workflowProgress[1].tokens);
}));

// wf_00e91f74-a5b on this machine: two snapshots under one run id — killed with
// 7 agents, completed with 65 — and one run directory between them, because the
// second attempt wrote into the first one's. The index keys an agent by that
// directory's name, so an agent listed by both attempts answers to both records;
// charging it twice would invent money nobody spent. One agent id really is
// shared there, so this is a live case, not a hypothetical.
test('an agent listed by two attempts of one run is charged once', () => tree((t) => {
    const shared = 'a11111111111111';
    // The directory lives in the second session, and the snapshot without one in
    // the first, so the record that must claim first is *not* the one the scan
    // hands over first. Written the other way round the priority never has to
    // do anything, and a claimOrder reduced to a no-op passes unnoticed — which
    // is what it did until the review reordered it and nothing went red.
    runFixture({ write: (rel, body) => writeAt(t, SECOND, rel, body) }, 'wf_twice-2', {
        final: { ...FINAL, runId: 'wf_twice-2', status: 'killed' },
        agents: {
            [shared]: AGENT_LINES('a1'),
            a22222222222222: AGENT_LINES('a2'),
            a33333333333333: AGENT_LINES('a3'),
            // In the directory, listed by neither attempt.
            a44444444444444: AGENT_LINES('a4'),
        },
    });
    // The second attempt lists the shared agent again plus one of its own, and
    // has no directory: its agents' transcripts are in the first attempt's.
    t.write('workflows/wf_twice-2.json', {
        ...FINAL,
        runId: 'wf_twice-2',
        status: 'completed',
        workflowProgress: [
            { type: 'workflow_agent', agentId: shared, state: 'done', tokens: 1 },
            { type: 'workflow_agent', agentId: 'a33333333333333', state: 'done', tokens: 1 },
        ],
    });

    const index = indexOf(t.root);
    const indexed = [...wf.costIndex(index).values()].reduce((a, r) => a + r.cost, 0);
    assert.ok(indexed > 0);
    const scanned = wf.scanRuns({ root: t.root, liveSessions: new Set(), now: Date.now() });
    assert.equal(scanned.length, 2);

    // Both directions, because which record the scan happens to hand over first
    // is a readdir order this test does not control — and the answer must not
    // depend on it.
    for (const input of [scanned, [...scanned].reverse()]) {
        const runs = wf.withCost(input, { index });

        // Every transcript paid for once, and only once: equality catches a join
        // that drops money just as surely as one that counts it twice. What no
        // attempt listed is in the sum too — beside the prices, not inside them,
        // and on one record of the pair rather than on both.
        assert.equal(runs.reduce((a, r) => a + r.totals.cost + r.totals.unlisted, 0), indexed);
        assert.equal(runs.filter((r) => r.totals.unlisted > 0).length, 1);
        assert.ok(runs.every((r) => r.agents.every((a) => a.cost <= r.totals.cost)));

        // The record holding the directory prices what is in it; the other
        // attempt keeps its own agent and is not charged again for the shared one.
        const owner = runs.find((r) => r.runDir);
        const other = runs.find((r) => !r.runDir);
        assert.ok(owner.agents.every((a) => a.cost > 0));
        assert.equal(other.agents.find((a) => a.agentId === shared).cost, 0);
        assert.ok(other.agents.find((a) => a.agentId === 'a33333333333333').cost > 0);
    }
}));

// A run's price is the sum over the agents it lists, and a directory can hold
// transcripts no snapshot names — 175 of them on this machine, $120.00, and on
// one run nearly as much as the run itself shows. Showing the smaller number
// alone would present it as the whole of what the run spent.
test('a transcript no snapshot lists is reported beside the price, not inside it', () => tree((t) => {
    runFixture(t, 'wf_extra-1', {
        final: {
            ...FINAL,
            runId: 'wf_extra-1',
            workflowProgress: [{ type: 'workflow_agent', agentId: 'a11111111111111', state: 'done' }],
        },
        // Two transcripts in the directory, one agent in the snapshot.
        agents: { a11111111111111: AGENT_LINES('a1'), a99999999999999: AGENT_LINES('a9') },
    });

    const index = indexOf(t.root);
    const [run] = wf.withCost(
        wf.scanRuns({ root: t.root, liveSessions: new Set(), now: Date.now() }),
        { index },
    );
    const indexed = [...wf.costIndex(index).values()].reduce((a, r) => a + r.cost, 0);

    assert.equal(run.agents.length, 1);
    assert.ok(run.totals.cost > 0);
    assert.ok(run.totals.unlisted > 0, 'the transcript nobody listed is still money');
    // Kept apart, and together they account for the whole directory.
    assert.equal(run.totals.cost + run.totals.unlisted, indexed);
    // Nothing left over when every transcript is listed.
    runFixture(t, 'wf_extra-2', {
        final: { ...FINAL, runId: 'wf_extra-2' },
        agents: { a11111111111111: AGENT_LINES('a1'), a22222222222222: AGENT_LINES('a2') },
    });
    const runs = wf.withCost(
        wf.scanRuns({ root: t.root, liveSessions: new Set(), now: Date.now() }),
        { index: indexOf(t.root) },
    );
    assert.equal(runs.find((r) => r.runId === 'wf_extra-2').totals.unlisted, 0);
    // One run id, one bill: the leftovers of a run id go to a single record.
    assert.equal(runs.filter((r) => r.totals.unlisted > 0).length, 1);
}));

test('costIndex keys workflow agents by run and agent, and adds up a repeated pair', () => {
    const row = (over) => ({
        kind: 'workflow', workflowId: 'wf_1', agentId: 'a1',
        cost: 1, tokens: 10, out: 2, msgs: 3, ...over,
    });
    const index = {
        files: {
            '/a.jsonl': { agg: { sessions: [row()] } },
            '/b.jsonl': { agg: { sessions: [row({ cost: 0.5, tokens: 5, out: 1, msgs: 2 })] } },
            // A main session and a plain subagent are not workflow agents, and a
            // transcript with nothing in it is stored with no aggregate at all.
            '/c.jsonl': { agg: { sessions: [row({ kind: 'main', workflowId: '', agentId: '' })] } },
            '/d.jsonl': { agg: { sessions: [row({ kind: 'agent', workflowId: '' })] } },
            '/e.jsonl': { agg: null },
        },
    };

    const map = wf.costIndex(index);
    assert.equal(map.size, 1);
    assert.deepEqual(map.get('wf_1/a1'), { cost: 1.5, tokens: 15, out: 3, msgs: 5 });
    assert.equal(wf.costIndex(null).size, 0);
    assert.equal(wf.costIndex({}).size, 0);
});

// A transcript only ever grows, so what it cost can be added up the same way:
// read what appeared since the last look and add it to what was already counted.
// Reading each live agent's file whole, every minute, is what this replaces —
// hundreds of megabytes a minute under a run with two hundred agents.
test('accrue adds only what grew, and a line cut by the boundary is counted once', () => tree((t) => {
    const [first, second] = AGENT_LINES('a1');
    const file = path.join(t.root, 'agent-grow.jsonl');
    // The file ends mid-record, the way one being written to does.
    fs.writeFileSync(file, `${first}\n${second.slice(0, 40)}`);

    const once = wf.accrue(file, null);
    assert.equal(once.cost, 0, 'the record that is there carries no usage');
    assert.equal(once.size, Buffer.byteLength(`${first}\n`), 'the half-written line is left for next time');

    fs.appendFileSync(file, `${second.slice(40)}\n`);
    const twice = wf.accrue(file, once);

    assert.deepEqual(twice, wf.accrue(file, null), 'two looks add up to exactly what one look sees');
    assert.equal(twice.tokens, 105);
    assert.ok(twice.cost > 0);
    assert.equal(twice.size, fs.statSync(file).size);
}));

test('accrue starts over when the file it was reading shrank', () => tree((t) => {
    const file = path.join(t.root, 'agent-swap.jsonl');
    fs.writeFileSync(file, `${AGENT_LINES('a1').join('\n')}\n`);
    const full = wf.accrue(file, null);
    assert.equal(full.tokens, 105);

    // A shorter file under the same name is a different file: adding to what was
    // counted before would be adding to something that is no longer there.
    fs.writeFileSync(file, `${AGENT_LINES('a2')[1]}\n`);
    const after = wf.accrue(file, full);
    assert.equal(after.tokens, 105, 'counted from zero, not added to the old total');
    assert.equal(after.size, fs.statSync(file).size);

    // A file that is not there at all leaves what was counted alone.
    assert.deepEqual(wf.accrue(path.join(t.root, 'nope.jsonl'), after), after);
}));

// The prompt never changes, and the model and the tool change only when the
// agent writes. A reader looking at the same run every ten seconds hands back
// what it already has, and pays for the head and the tail of a transcript only
// where the file has actually moved.
test('readLive re-reads only the transcripts that grew since it last looked', () => tree((t) => {
    runFixture(t, 'wf_prev-1', {
        journal: [{ type: 'started', agentId: 'a1' }],
        agents: { a1: AGENT_LINES('a1') },
    });
    const dir = path.join(t.root, t.slug, t.session, 'subagents/workflows/wf_prev-1');
    const file = path.join(dir, 'agent-a1.jsonl');

    const fresh = wf.readLive(dir);
    assert.ok(fresh.agents[0].promptPreview.startsWith('Задача агента a1'));
    assert.equal(fresh.agents[0].model, 'claude-opus-5');
    assert.equal(fresh.agents[0].lastActivity, fs.statSync(file).mtimeMs);

    // Values no read of this file could have produced: getting them back proves
    // the file was not read, not merely that the answer happened to match.
    const known = new Map([['a1', {
        ...fresh.agents[0], promptPreview: 'already known', model: 'kept', lastToolName: 'Kept',
    }]]);
    const told = wf.readLive(dir, { known });
    assert.equal(told.agents[0].promptPreview, 'already known');
    assert.equal(told.agents[0].model, 'kept');
    assert.equal(told.agents[0].lastToolName, 'Kept');

    // Once the agent writes, the tail is read again — the prompt is not, since
    // it is the one thing that cannot have changed.
    fs.appendFileSync(file, `${AGENT_LINES('a1')[1]}\n`);
    const moved = wf.readLive(dir, { known });
    assert.equal(moved.agents[0].model, 'claude-opus-5', 'the transcript answers again');
    assert.equal(moved.agents[0].promptPreview, 'already known');
    assert.equal(wf.readLive(dir, { known: new Map() }).agents[0].model, 'claude-opus-5');
}));

test('withCost prices a live agent from what grew since it last looked', () => tree((t) => {
    runFixture(t, 'wf_carry-1', {
        journal: [{ type: 'started', agentId: 'a1' }],
        agents: { a1: AGENT_LINES('a1') },
    });
    const transcript = path.join(t.root, t.slug, t.session, 'subagents/workflows/wf_carry-1/agent-a1.jsonl');
    const scan = () => wf.scanRuns({ root: t.root, liveSessions: new Set([t.session]), now: Date.now() });
    const carried = new Map();
    const price = () => wf.withCost(scan(), { index: { files: {} }, live: true, carried })[0];

    const first = price();
    assert.ok(first.totals.cost > 0, 'the live agent is priced from its transcript');
    assert.equal(carried.get('wf_carry-1/a1').size, fs.statSync(transcript).size,
        'and the file is remembered up to where it was read');

    // Nothing grew, so nothing is read and nothing is counted twice.
    const same = price();
    assert.equal(same.totals.cost, first.totals.cost);
    assert.equal(same.agents[0].tokens, first.agents[0].tokens);

    fs.appendFileSync(transcript, `${AGENT_LINES('a1')[1]}\n`);
    const grown = price();
    assert.equal(grown.agents[0].tokens, first.agents[0].tokens * 2, 'only the new reply is added');
    assert.ok(grown.totals.cost > first.totals.cost);
}));

// Size answers how much has been appended; it cannot answer whether this is the
// same file. A transcript replaced by another one at least as long would be read
// from the middle of a text whose beginning nobody counted — measured at
// $0.02565 against the $0.03765 the file actually holds.
test('accrue starts over when the path stopped pointing at the file it read', () => tree((t) => {
    const file = path.join(t.root, 'agent-swap.jsonl');
    const reply = (out) => JSON.stringify({
        type: 'assistant', timestamp: '2026-08-09T10:00:00Z',
        message: { model: 'claude-opus-5', usage: { input_tokens: 5, output_tokens: out }, content: [] },
    });

    // Replaced in place by a longer file: the inode does not change and neither
    // does the direction of the size, so only the text itself gives it away.
    fs.writeFileSync(file, `${reply(1000)}\n`);
    const half = wf.accrue(file, null);
    fs.writeFileSync(file, `${reply(2000)}\n${reply(3000)}\n`);
    assert.deepEqual(wf.accrue(file, half), wf.accrue(file, null), 'counted whole, not from the middle');

    // Replaced by a file of exactly the same length: nothing grew, so without a
    // second signal nothing would be read at all.
    const now = wf.accrue(file, null);
    fs.writeFileSync(file, `${reply(2000)}\n${reply(9000)}\n`);
    const after = wf.accrue(file, now);
    assert.equal(after.size, fs.statSync(file).size);
    assert.deepEqual(after, wf.accrue(file, null));
    assert.notEqual(after.tokens, now.tokens, 'the swap is noticed at all');

    // Replaced by a shorter one, and by a different inode: both still restart.
    fs.writeFileSync(file, `${reply(10)}\n`);
    assert.deepEqual(wf.accrue(file, after), wf.accrue(file, null));
    const swap = path.join(t.root, 'agent-other.jsonl');
    fs.writeFileSync(swap, `${reply(4000)}\n${reply(4000)}\n`);
    fs.renameSync(swap, file);
    assert.deepEqual(wf.accrue(file, wf.accrue(file, null)), wf.accrue(file, null));
}));

// The shape of the panel is decided here and nowhere else: what hangs under
// what, what a row says, which icon it gets. The provider in extension.js turns
// a node into a TreeItem and makes no decision of its own, which is what keeps
// all of this reachable from a test that never loads vscode.
test('treeNodes groups agents under their phases and sorts live runs first', () => {
    const runs = [
        {
            runId: 'wf_old-1', name: 'old', state: 'finished', status: 'completed', lastActivity: 1000,
            phases: [{ title: 'A' }], totals: { agents: 1, cost: 2 },
            agents: [{ agentId: 'x1', label: 'a:one', phase: 'A', model: 'claude-opus-5', state: 'done', tokens: 10, cost: 2 }],
        },
        {
            runId: 'wf_now-1', name: 'now', state: 'running', lastActivity: 2000,
            phases: [], totals: { agents: 2, done: 1, cost: 0 },
            agents: [
                { agentId: 'y1', label: '', phase: '', model: 'claude-opus-5', state: 'done', promptPreview: 'первый', tokens: 0, cost: 0 },
                { agentId: 'y2', label: '', phase: '', model: 'claude-opus-5', state: 'running', promptPreview: 'второй', tokens: 0, cost: 0 },
            ],
        },
    ];
    const nodes = wf.treeNodes(runs);

    assert.equal(nodes[0].label, 'now', 'the running one comes first');
    assert.equal(nodes[0].kind, 'run');
    assert.equal(nodes[0].children.length, 2, 'no phases means agents hang off the run');
    assert.equal(nodes[0].children[0].kind, 'agent');
    assert.equal(nodes[0].children[0].label, 'первый', 'a live agent is labelled by its prompt');

    const old = nodes[1];
    assert.equal(old.children[0].kind, 'phase');
    assert.equal(old.children[0].label, 'A');
    assert.equal(old.children[0].children[0].label, 'a:one');
});

test('treeNodes marks the three run states apart', () => {
    const base = { phases: [], agents: [], totals: { agents: 0 }, lastActivity: 1 };
    const nodes = wf.treeNodes([
        { ...base, runId: 'wf_a', name: 'a', state: 'running' },
        { ...base, runId: 'wf_b', name: 'b', state: 'finished', status: 'failed' },
        { ...base, runId: 'wf_c', name: 'c', state: 'abandoned' },
    ]);
    assert.deepEqual(nodes.map((n) => n.icon), ['sync~spin', 'error', 'circle-slash']);
});

// Two attempts of one workflow keep one run id on purpose — scanRuns refuses to
// merge their numbers — so the run id cannot be a node id. VS Code keys a row's
// expanded state on that id, and two rows carrying one id are one row.
test('treeNodes gives two attempts of one run id their own node ids', () => {
    const attempt = (session) => ({
        runId: 'wf_twice-1', slug: '-Users-x-Develop-demo', sessionId: session, name: 'twice',
        state: 'finished', status: 'completed', lastActivity: 1,
        phases: [{ title: 'A' }], totals: { agents: 1 },
        agents: [{ agentId: 'x1', label: 'a:one', phase: 'A', model: '', state: 'done', tokens: 0 }],
    });
    const ids = [];
    const walk = (nodes) => { for (const n of nodes) { ids.push(n.id); walk(n.children); } };
    walk(wf.treeNodes([attempt('sess-a'), attempt('sess-b')]));

    assert.equal(ids.length, 6, 'two runs, a phase each, an agent each');
    assert.equal(new Set(ids).size, ids.length, `every node is its own row: ${ids.join(' ')}`);
});

// The reason phases are numbered rather than titled: a script is free to write
// one title twice, and an agent named by it would hang under both — carrying one
// node id twice. A repeated id does not duplicate a row, it stops the view from
// drawing at all, so the first phase to name an agent is the only one that gets it.
test('treeNodes gives an agent to one phase when two phases share a title', () => {
    const [run] = wf.treeNodes([{
        runId: 'wf_dup-1', slug: '-Users-x-Develop-demo', sessionId: 'sess-a', name: 'dup',
        state: 'finished', status: 'completed', lastActivity: 1,
        phases: [{ title: 'A' }, { title: 'A' }], totals: { agents: 1 },
        agents: [{ agentId: 'x1', label: 'a:one', phase: 'A', model: '', state: 'done', tokens: 0 }],
    }]);
    const ids = [];
    const walk = (nodes) => { for (const n of nodes) { ids.push(n.id); walk(n.children); } };
    walk([run]);

    assert.equal(new Set(ids).size, ids.length, `every node is its own row: ${ids.join(' ')}`);
    assert.deepEqual(run.children.map((n) => n.kind), ['phase'], 'the second A holds nobody, so it is not drawn');
    assert.deepEqual(run.children[0].children.map((n) => n.label), ['a:one'], 'and the agent is drawn once');
});

// A phase list is not a partition: the live one is read off the script and the
// final one off the snapshot, so a title can move between them, and an agent
// under a title nobody lists still has to appear somewhere.
test('treeNodes keeps an agent no phase claims, and draws no empty phase', () => {
    const [run] = wf.treeNodes([{
        runId: 'wf_loose-1', name: 'loose', state: 'finished', status: 'completed', lastActivity: 1,
        phases: [{ title: 'A', detail: 'the first one' }, { title: 'B' }],
        totals: { agents: 2 },
        agents: [
            { agentId: 'p1', label: 'a:in-a', phase: 'A', model: '', state: 'done', tokens: 0 },
            { agentId: 'p2', label: 'a:nowhere', phase: 'Gone', model: '', state: 'done', tokens: 0 },
        ],
    }]);

    assert.deepEqual(run.children.map((n) => n.kind), ['phase', 'agent'], 'B holds nobody, so B is not drawn');
    assert.equal(run.children[0].description, 'the first one');
    assert.deepEqual(run.children[0].children.map((n) => n.label), ['a:in-a']);
    assert.equal(run.children[1].label, 'a:nowhere');
});

// The client's own agent count and the list underneath disagree — 74 against 13
// on a killed run here — and a tree showing only the list looks complete without
// being it. A live run has no count of its own yet, so it says nothing.
test('treeNodes shows the client count beside the list when the two disagree', () => {
    const [going, killed] = wf.treeNodes([
        {
            runId: 'wf_killed-1', name: 'killed', state: 'finished', status: 'killed', lastActivity: 2,
            phases: [], totals: { agents: 1, reported: 74 },
            agents: [{ agentId: 'k1', label: 'a:one', phase: '', model: '', state: 'progress', tokens: 0 }],
        },
        {
            runId: 'wf_going-1', name: 'going', state: 'running', lastActivity: 1,
            phases: [], totals: { agents: 3, done: 1, reported: 0 }, agents: [],
        },
    ]);

    assert.match(killed.description, /1 of 74/);
    assert.equal(killed.children[0].icon, 'circle-slash',
        'a working agent of a run that was cut is stopped, not finished and not crashed');
    assert.match(going.description, /1\/3/, 'a live run counts how far it has got instead');
    assert.doesNotMatch(going.description, /of 0/, 'and the client has counted nothing for it yet');
});

// Two surfaces ask the same question of a run — the tree row and the dashboard
// cell — so the answer is written once. The only difference is what a plain
// count means: silence in a tree that lists the agents underneath it, a number
// in a column headed "Agents".
test('countLabel says the two things worth saying about an agent count', () => {
    const listed = (n) => Array.from({ length: n }, (_, i) => ({ agentId: `a${i}` }));
    const killed = { state: 'finished', totals: { agents: 13, reported: 74, done: 13 }, agents: listed(13) };
    const going = { state: 'running', totals: { agents: 5, reported: 0, done: 2 }, agents: listed(2) };
    const clean = { state: 'finished', totals: { agents: 3, reported: 3, done: 3 }, agents: listed(3) };

    assert.equal(wf.countLabel(killed), '13 of 74');
    assert.equal(wf.countLabel(going), '2/5');
    assert.equal(wf.countLabel(clean), '', 'nothing to say where the client and the list agree');
    assert.equal(wf.countLabel(clean, { always: true }), '3');
    // A record the scan did not build: a blank, never a throw and never NaN.
    assert.equal(wf.countLabel({ runId: 'wf_bare-1' }, { always: true }), '0');
});

// The word is the client's own or none at all, and the outcome is the same
// five-word vocabulary an agent answers in — which is what lets one icon table
// and one set of colours serve both.
test('verdictOf reads a run the way its icon does', () => {
    assert.deepEqual(wf.verdictOf({ state: 'running' }), { word: 'running', outcome: 'running' });
    assert.deepEqual(wf.verdictOf({ state: 'abandoned' }), { word: 'no snapshot', outcome: 'stopped' });
    assert.deepEqual(wf.verdictOf({ state: 'finished', status: 'completed' }), { word: 'completed', outcome: 'done' });
    assert.deepEqual(wf.verdictOf({ state: 'finished', status: 'killed' }), { word: 'killed', outcome: 'failed' });
    // A snapshot that carried no status gets no verdict invented for it, and the
    // icon stays the one a run that did not say "completed" has always had.
    assert.deepEqual(wf.verdictOf({ state: 'finished', status: '' }), { word: '', outcome: 'failed' });
    const [a, b, c] = wf.treeNodes([
        { runId: 'wf_a', state: 'running', phases: [], agents: [], totals: {}, lastActivity: 3 },
        { runId: 'wf_b', state: 'finished', status: '', phases: [], agents: [], totals: {}, lastActivity: 2 },
        { runId: 'wf_c', state: 'abandoned', phases: [], agents: [], totals: {}, lastActivity: 1 },
    ]);
    assert.deepEqual([a.icon, b.icon, c.icon], ['sync~spin', 'error', 'circle-slash']);
});

test('agentLabel names an agent that has no label yet by what it was told', () => {
    assert.equal(wf.agentLabel({ agentId: 'a1', label: 'review:bugs', promptPreview: 'найди баги' }), 'review:bugs');
    assert.equal(wf.agentLabel({ agentId: 'a1', label: '', promptPreview: ' найди баги\nвторая строка' }), 'найди баги');
    assert.equal(wf.agentLabel({ agentId: 'abcdef1234', label: '', promptPreview: '' }), 'abcdef12');
});
