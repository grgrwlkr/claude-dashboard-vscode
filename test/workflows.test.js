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
