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
            agentId: 'a22222222222222', model: 'claude-opus-5', state: 'failed',
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
    assert.equal(final.agents[1].state, 'failed');
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

test('readFinal ignores an agent entry with no id', () => tree(({ write }) => {
    const final = wf.readFinal(write('workflows/wf_x-1.json', {
        runId: 'wf_x-1',
        workflowProgress: [{ type: 'workflow_agent', label: 'nameless' }],
    }));
    assert.deepEqual(final.agents, []);
}));
