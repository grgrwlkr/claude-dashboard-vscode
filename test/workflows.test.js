const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const wf = require('../workflows');

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
