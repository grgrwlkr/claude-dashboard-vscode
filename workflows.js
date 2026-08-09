// Workflow runs, read from the two trees Claude Code writes them to.
//
// A finished run leaves one snapshot: <session>/workflows/wf_<runId>.json, written
// once when the run ends. A live run leaves nothing there — only the journal and
// the agent transcripts under <session>/subagents/workflows/wf_<runId>/. Both are
// undocumented internals of a client that ships almost daily, so every field here
// is optional and a parse failure yields nothing rather than a wrong number.
//
// No dependency on vscode: the roots are parameters, so this runs under plain node.

const fs = require('fs');
const path = require('path');

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// One entry of workflowProgress, in the shape the rest of the extension uses.
// `state` is the client's own word for it — done, failed, running — and is passed
// through rather than mapped, so a state we have never seen still displays.
function agentOf(entry) {
    if (!entry || entry.type !== 'workflow_agent' || !entry.agentId) return null;
    return {
        agentId: String(entry.agentId),
        label: entry.label || '',
        phase: entry.phaseTitle || '',
        model: entry.model || '',
        state: entry.state || '',
        tokens: entry.tokens || 0,
        toolCalls: entry.toolCalls || 0,
        durationMs: entry.durationMs || 0,
        lastToolName: entry.lastToolName || '',
        promptPreview: entry.promptPreview || '',
        resultPreview: entry.resultPreview || '',
    };
}

/**
 * The final snapshot of one run. Returns null only when the file cannot be read
 * or parsed at all — a snapshot missing half its fields still describes a run,
 * and hiding it would lose the record entirely.
 */
function readFinal(jsonPath) {
    const raw = readJson(jsonPath);
    if (!raw || typeof raw !== 'object') return null;

    const progress = Array.isArray(raw.workflowProgress) ? raw.workflowProgress : [];
    const agents = progress.map(agentOf).filter(Boolean);
    const phases = (Array.isArray(raw.phases) ? raw.phases : [])
        .filter((p) => p && p.title)
        .map((p) => ({ title: String(p.title), detail: p.detail ? String(p.detail) : '' }));

    return {
        runId: raw.runId || path.basename(jsonPath, '.json'),
        name: raw.workflowName || '',
        status: raw.status || '',
        durationMs: raw.durationMs || 0,
        phases,
        agents,
        scriptPath: raw.scriptPath || '',
        totals: {
            agents: raw.agentCount || agents.length,
            tokens: raw.totalTokens || 0,
            toolCalls: raw.totalToolCalls || 0,
        },
    };
}

module.exports = { readFinal };
