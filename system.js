// Everything about the Claude Code installation that is not usage: what is
// configured, what is running, what is on disk, what changed in the client.
//
// All of it is read from `~/.claude` and `~/.claude.json`, which belong to the
// client — this module only reads. Nothing here writes into that tree, and two
// things are never read at all: `.credentials.json`, and the `authToken` an IDE
// lock carries. No dependency on vscode, so `node --test` covers it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const ROOT = path.join(HOME, '.claude');
const CONFIG = path.join(HOME, '.claude.json');

// Roughly four characters to a token for English prose with markdown in it.
// Wrong in the third digit, right in the first — which is all a "what do my
// instructions cost" figure needs.
const CHARS_PER_TOKEN = 4;

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function statOf(file) {
    try { return fs.statSync(file); } catch { return null; }
}

function alive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

// Timestamps come both ways in this tree: epoch milliseconds in the session
// registry, ISO strings in job state. One reader for both.
function asTime(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return Date.parse(value) || 0;
    return 0;
}

const listDir = (dir) => {
    try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
};

/**
 * Settings as the client resolves them: the first file in the chain that has a
 * key wins. The chain is walked here rather than trusting one file, because the
 * value that matters is the one in force, not the one written down globally.
 */
function settingsChain(workspace, root = ROOT) {
    const files = [
        workspace && path.join(workspace, '.claude', 'settings.local.json'),
        workspace && path.join(workspace, '.claude', 'settings.json'),
        path.join(root, 'settings.local.json'),
        path.join(root, 'settings.json'),
    ].filter(Boolean);
    return files.map((file) => ({ file, cfg: readJson(file) })).filter((e) => e.cfg);
}

const SETTING_KEYS = [
    'model', 'effortLevel', 'advisorModel', 'outputStyle', 'language', 'theme',
    'alwaysThinkingEnabled', 'showThinkingSummaries', 'autoCompactEnabled', 'autoCompactWindow',
    'autoMemoryEnabled', 'enableWorkflows', 'workflowSizeGuideline', 'editorMode',
    'autoUpdatesChannel', 'verbose', 'todoFeatureEnabled', 'statusLine',
];

function settingsOf(workspace, root = ROOT) {
    const chain = settingsChain(workspace, root);
    const out = {};
    for (const key of SETTING_KEYS) {
        for (const { file, cfg } of chain) {
            if (cfg[key] !== undefined && cfg[key] !== null) {
                const value = typeof cfg[key] === 'object' ? JSON.stringify(cfg[key]) : cfg[key];
                out[key] = { value, from: path.basename(path.dirname(file)) === '.claude'
                    ? shortPath(file) : shortPath(file) };
                break;
            }
        }
    }
    // env is a map rather than a scalar: worth showing whole, since a stray
    // variable here changes behaviour in every session on the machine.
    const env = {};
    for (const { cfg } of chain.slice().reverse()) Object.assign(env, cfg.env || {});
    return { values: out, env };
}

function shortPath(file) {
    return file.startsWith(HOME) ? `~${file.slice(HOME.length)}` : file;
}

/** Hooks, flattened from the nested shape settings.json stores them in. */
function hooksOf(workspace, root = ROOT) {
    const out = [];
    for (const { file, cfg } of settingsChain(workspace, root)) {
        for (const [event, entries] of Object.entries(cfg.hooks || {})) {
            for (const entry of (Array.isArray(entries) ? entries : [])) {
                for (const hook of (entry.hooks || [])) {
                    out.push({
                        event,
                        matcher: entry.matcher || '*',
                        kind: hook.type || 'command',
                        // A prompt hook carries its whole prompt; only the shape
                        // of it is interesting in a list, so it is cut short.
                        command: (hook.command || hook.prompt || '').slice(0, 160),
                        from: shortPath(file),
                    });
                }
            }
        }
    }
    return out;
}

/** Permission rules, with the file each came from. */
function permissionsOf(workspace, root = ROOT) {
    const out = [];
    for (const { file, cfg } of settingsChain(workspace, root)) {
        for (const mode of ['allow', 'ask', 'deny']) {
            for (const rule of (cfg.permissions || {})[mode] || []) {
                out.push({ mode, rule, from: shortPath(file) });
            }
        }
    }
    return out;
}

/**
 * MCP servers, with the scope they are registered in. User scope lives in
 * `~/.claude.json`; project scope in the same file under the project's own
 * entry, which is why a server can be present on the machine and still be
 * invisible in the repository next door.
 */
function mcpServers(config = readJson(CONFIG)) {
    const out = [];
    const describe = (name, def, scope, project) => ({
        name,
        scope,
        project: project ? shortPath(project) : '',
        transport: def && def.type ? def.type : (def && def.url ? 'http' : 'stdio'),
        // A command line can carry a token in an argument; the binary alone is
        // what identifies the server, so that is all that is kept.
        command: def && def.command ? path.basename(def.command) : (def && def.url ? hostOf(def.url) : ''),
    });
    for (const [name, def] of Object.entries((config && config.mcpServers) || {})) {
        out.push(describe(name, def, 'user'));
    }
    for (const [project, entry] of Object.entries((config && config.projects) || {})) {
        for (const [name, def] of Object.entries((entry && entry.mcpServers) || {})) {
            out.push(describe(name, def, 'project', project));
        }
    }
    return out;
}

function hostOf(url) {
    try { return new URL(url).host; } catch { return ''; }
}

/**
 * Installed plugins and what each one brings. The components are counted from
 * the plugin's own directory rather than from a manifest: a marketplace entry
 * says what the plugin claims, the directory says what it actually ships.
 */
function plugins(root = ROOT, config = readJson(path.join(root, 'settings.json'))) {
    const enabled = (config && config.enabledPlugins) || {};
    const cache = path.join(root, 'plugins', 'cache');
    const out = new Map();

    for (const market of listDir(cache)) {
        if (!market.isDirectory() || market.name.startsWith('temp_subdir_')) continue;
        for (const plugin of listDir(path.join(cache, market.name))) {
            if (!plugin.isDirectory()) continue;
            const versions = listDir(path.join(cache, market.name, plugin.name))
                .filter((d) => d.isDirectory());
            // Several copies of one plugin sit side by side — an update adds a
            // directory rather than replacing one. They are named by version
            // where the plugin publishes one and by a content hash where it does
            // not, so the newest is picked by version when that is possible and
            // by mtime otherwise.
            const dirs = versions.map((v) => {
                const dir = path.join(cache, market.name, plugin.name, v.name);
                const st = statOf(dir);
                return { dir, name: v.name, at: st ? st.mtimeMs : 0 };
            }).sort((a, b) => {
                const semver = /^\d+\.\d+\.\d+$/;
                if (semver.test(a.name) && semver.test(b.name)) return compareVersions(b.name, a.name);
                return b.at - a.at;
            });
            const key = `${plugin.name}@${market.name}`;
            out.set(key, {
                name: plugin.name,
                marketplace: market.name,
                enabled: enabled[key] === true,
                version: dirs[0] ? dirs[0].name : '',
                copies: dirs.length,
                components: dirs[0] ? componentsOf(dirs[0].dir) : emptyComponents(),
            });
        }
    }

    // A plugin enabled in settings but absent from the cache is a broken
    // reference, and that is worth showing rather than silently dropping.
    for (const key of Object.keys(enabled)) {
        if (out.has(key)) continue;
        const [name, marketplace = ''] = key.split('@');
        out.set(key, {
            name, marketplace, enabled: enabled[key] === true,
            copies: 0, components: emptyComponents(), missing: true,
        });
    }
    return [...out.values()];
}

const emptyComponents = () => ({ skills: [], agents: [], commands: [], hooks: 0, mcp: [] });

function componentsOf(dir) {
    const c = emptyComponents();
    c.skills = listDir(path.join(dir, 'skills')).filter((e) => e.isDirectory()).map((e) => e.name);
    c.agents = listDir(path.join(dir, 'agents'))
        .filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name.replace(/\.md$/, ''));
    c.commands = listDir(path.join(dir, 'commands'))
        .filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name.replace(/\.md$/, ''));
    const hooks = readJson(path.join(dir, 'hooks', 'hooks.json'));
    c.hooks = hooks ? Object.values(hooks.hooks || hooks).flat().length : 0;
    const mcp = readJson(path.join(dir, '.mcp.json'));
    c.mcp = mcp ? Object.keys(mcp.mcpServers || {}) : [];
    return c;
}

/**
 * Background jobs. Each one keeps its state, the tokens it burned and a working
 * directory that nothing ever cleans up — which is how a single job comes to
 * hold hundreds of megabytes long after it finished.
 */
function jobs(root = ROOT, { withSizes = true } = {}) {
    const dir = path.join(root, 'jobs');
    const out = [];
    for (const entry of listDir(dir)) {
        if (!entry.isDirectory()) continue;
        const jobDir = path.join(dir, entry.name);
        const state = readJson(path.join(jobDir, 'state.json'));
        if (!state) continue;
        const timeline = statOf(path.join(jobDir, 'timeline.jsonl'));
        out.push({
            id: entry.name,
            name: state.name || '',
            state: state.state || '',
            detail: (state.detail || '').slice(0, 200),
            tokens: state.tokens || 0,
            cliVersion: state.cliVersion || '',
            cwd: state.cwd ? shortPath(state.cwd) : '',
            sessionId: state.sessionId || state.resumeSessionId || '',
            children: (state.children || []).length,
            at: asTime(state.updatedAt) || asTime(state.createdAt) || (timeline ? timeline.mtimeMs : 0),
            bytes: withSizes ? dirSize(jobDir) : 0,
            // The scratch directory is the part that is pure leftovers.
            tmpBytes: withSizes ? dirSize(path.join(jobDir, 'tmp')) : 0,
        });
    }
    return out.sort((a, b) => b.at - a.at);
}

/**
 * What is running right now: sessions in the registry whose process is alive,
 * the IDE windows attached, and the daemon's own workers. Three sources because
 * each knows something the others do not — a daemon worker has no registry
 * entry, and an IDE lock survives the window that made it.
 */
function live(root = ROOT) {
    const sessions = [];
    for (const entry of listDir(path.join(root, 'sessions'))) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const s = readJson(path.join(root, 'sessions', entry.name));
        if (!s || !s.sessionId || !s.pid) continue;
        sessions.push({
            id: s.sessionId,
            pid: s.pid,
            alive: alive(s.pid),
            cwd: s.cwd ? shortPath(s.cwd) : '',
            entrypoint: s.entrypoint || '',
            status: s.status || '',
            name: s.name || '',
            version: s.version || '',
            startedAt: asTime(s.startedAt) || asTime(s.procStart),
        });
    }

    const ide = [];
    for (const entry of listDir(path.join(root, 'ide'))) {
        if (!entry.isFile() || !entry.name.endsWith('.lock')) continue;
        const lock = readJson(path.join(root, 'ide', entry.name));
        if (!lock) continue;
        // Never the authToken this file also carries.
        ide.push({
            pid: lock.pid || Number(entry.name.replace('.lock', '')) || 0,
            alive: alive(lock.pid),
            name: lock.ideName || '',
            transport: lock.transport || '',
            folders: (lock.workspaceFolders || []).map(shortPath),
        });
    }

    const roster = readJson(path.join(root, 'daemon', 'roster.json')) || {};
    const workers = Object.entries(roster.workers || {}).map(([short, w]) => ({
        short,
        pid: w.pid || 0,
        alive: alive(w.pid),
        sessionId: w.sessionId || '',
        cwd: w.cwd ? shortPath(w.cwd) : '',
        cliVersion: w.cliVersion || '',
        startedAt: asTime(w.startedAt),
    }));

    return {
        sessions: sessions.sort((a, b) => b.startedAt - a.startedAt),
        ide,
        daemon: {
            supervisorPid: roster.supervisorPid || 0,
            alive: roster.supervisorPid ? alive(roster.supervisorPid) : false,
            workers,
        },
    };
}

/** Todo lists, per session, with whatever is still open in them. */
function tasks(root = ROOT, sessionProjects = {}) {
    const dir = path.join(root, 'tasks');
    const out = [];
    for (const entry of listDir(dir)) {
        if (!entry.isDirectory()) continue;
        const items = [];
        let at = 0;
        for (const file of listDir(path.join(dir, entry.name))) {
            if (!file.isFile() || !file.name.endsWith('.json')) continue;
            const full = path.join(dir, entry.name, file.name);
            const t = readJson(full);
            if (!t || !t.status) continue;
            const st = statOf(full);
            if (st && st.mtimeMs > at) at = st.mtimeMs;
            items.push({ subject: t.subject || t.activeForm || '', status: t.status });
        }
        if (items.length === 0) continue;
        const done = items.filter((t) => t.status === 'completed').length;
        out.push({
            session: entry.name,
            project: sessionProjects[entry.name] || '',
            at,
            total: items.length,
            done,
            open: items.filter((t) => t.status !== 'completed').map((t) => t.subject).slice(0, 8),
        });
    }
    return out.sort((a, b) => b.at - a.at);
}

// Recursive size of a directory. Cheap enough per job, expensive over the whole
// tree — which is why the disk figures are cached rather than computed on
// every dashboard open.
function dirSize(dir) {
    let total = 0;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) total += dirSize(full);
        else if (entry.isFile()) {
            const st = statOf(full);
            if (st) total += st.size;
        }
    }
    return total;
}

// Directories that regenerate themselves if deleted, and those that do not.
// Nothing here deletes anything; the label is what turns a number into a
// decision.
const REGENERABLE = new Set(['plugins', 'cache', 'telemetry', 'shell-snapshots', 'paste-cache', 'statsig']);
const IRREPLACEABLE = new Set(['projects', 'file-history', 'history.jsonl', 'CLAUDE.md', 'rules', 'settings.json']);

function disk(root = ROOT, known = null) {
    const dirs = [];
    let total = 0;
    for (const entry of listDir(root)) {
        const full = path.join(root, entry.name);
        const bytes = entry.isDirectory() ? dirSize(full) : (statOf(full) || { size: 0 }).size;
        if (bytes === 0) continue;
        total += bytes;
        dirs.push({
            name: entry.name,
            bytes,
            kind: REGENERABLE.has(entry.name) ? 'regenerable'
                : IRREPLACEABLE.has(entry.name) ? 'keep' : 'mixed',
        });
    }
    dirs.sort((a, b) => b.bytes - a.bytes);

    // The named suspects: one job's scratch directory and the marketplace clones
    // an interrupted plugin update leaves behind. Both are pure leftovers, and
    // both are invisible in a per-directory total.
    const hogs = [];
    for (const job of (known || jobs(root))) {
        if (job.tmpBytes > 50e6) {
            hogs.push({ path: `jobs/${job.id}/tmp`, bytes: job.tmpBytes, note: `scratch of "${job.name || job.id}" (${job.state || 'unknown'})` });
        }
    }
    const cache = path.join(root, 'plugins', 'cache');
    let temps = 0;
    let tempBytes = 0;
    // Every plugin update adds a directory beside the old one instead of
    // replacing it, so the copies pile up silently — counted here as one line
    // rather than thirty.
    let stale = 0;
    let staleBytes = 0;
    for (const entry of listDir(cache)) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('temp_subdir_')) {
            temps++;
            tempBytes += dirSize(path.join(cache, entry.name));
            continue;
        }
        for (const plugin of listDir(path.join(cache, entry.name))) {
            if (!plugin.isDirectory()) continue;
            const dir = path.join(cache, entry.name, plugin.name);
            const copies = listDir(dir).filter((d) => d.isDirectory())
                .map((d) => ({ name: d.name, bytes: dirSize(path.join(dir, d.name)) }));
            if (copies.length < 2) continue;
            // Everything but the largest-versioned copy is what an update left.
            const sorted = copies.slice().sort((a, b) => {
                const semver = /^\d+\.\d+\.\d+$/;
                if (semver.test(a.name) && semver.test(b.name)) return compareVersions(b.name, a.name);
                const sa = statOf(path.join(dir, a.name));
                const sb = statOf(path.join(dir, b.name));
                return (sb ? sb.mtimeMs : 0) - (sa ? sa.mtimeMs : 0);
            });
            stale += sorted.length - 1;
            staleBytes += sorted.slice(1).reduce((a, c) => a + c.bytes, 0);
        }
    }
    if (temps > 0) {
        hogs.push({
            path: 'plugins/cache/temp_subdir_*',
            bytes: tempBytes,
            note: `${temps} abandoned marketplace ${temps === 1 ? 'clone' : 'clones'}`,
        });
    }
    if (stale > 0) {
        hogs.push({
            path: 'plugins/cache/*/*/<old versions>',
            bytes: staleBytes,
            note: `${stale} superseded plugin ${stale === 1 ? 'copy' : 'copies'}`,
        });
    }
    hogs.sort((a, b) => b.bytes - a.bytes);
    return { total, dirs, hogs };
}

/**
 * What the instruction layer costs. Every one of these files is read into the
 * prompt of every session that matches its scope, so their size is a per-request
 * tax — the one number in this dashboard the user can act on directly by
 * deleting a paragraph.
 */
// The transcript directory a project's files live under, by the same rule
// session.js uses: every non-alphanumeric character becomes a dash. Duplicated
// rather than imported because system.js reads ~/.claude and session.js reads a
// session — neither is the other's dependency — and the rule is one line that
// has not changed since the client shipped it.
/**
 * What is installed against what the machine already knows is available.
 *
 * Both halves are on disk: `installed_plugins.json` says which version is in
 * use and when it was put there, and each marketplace is a **local clone**
 * under `plugins/marketplaces/`, so the version a plugin declares upstream can
 * be read without asking anyone. What cannot be known offline is whether that
 * clone is itself behind — hence the freshness date, which is the honest half
 * of an update check that makes no request.
 *
 * A manifest that declares no version is reported as declaring none. Most of
 * them do not, and inventing "up to date" from a missing field would be the one
 * wrong answer here.
 */
function pluginUpdates(root = ROOT) {
    const markets = readJson(path.join(root, 'plugins', 'known_marketplaces.json')) || {};
    const installed = (readJson(path.join(root, 'plugins', 'installed_plugins.json')) || {}).plugins || {};
    const rows = [];
    for (const [key, entries] of Object.entries(installed)) {
        const [name, marketplace] = String(key).split('@');
        const list = Array.isArray(entries) ? entries : [entries];
        const first = list[0] || {};
        const market = markets[marketplace] || null;
        const manifest = market && market.installLocation
            ? readJson(path.join(market.installLocation, 'plugins', name, '.claude-plugin', 'plugin.json'))
            : null;
        rows.push({
            name,
            marketplace,
            installed: first.version || '',
            installedAt: Date.parse(first.lastUpdated || first.installedAt || '') || 0,
            available: manifest ? (manifest.version || '') : '',
            declared: Boolean(manifest && manifest.version),
            repo: market && market.source ? market.source.repo || '' : '',
            marketUpdated: market ? Date.parse(market.lastUpdated || '') || 0 : 0,
        });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
}

const slugFor = (dir) => String(dir).replace(/[^a-zA-Z0-9]/g, '-');
const slugsOf = (projects) => projects.map(slugFor);

// How much of a file the page carries. Enough to read a rule without leaving
// the dashboard; past it, the file itself is one click away and the page does
// not grow by a megabyte because someone pasted a corpus into a memory note.
const MEMORY_CHARS = 60 * 1024;

function contextBudget(root = ROOT, projects = [], slugs = []) {
    const files = [];
    const addFile = (file, scope, kind = 'instructions') => {
        const st = statOf(file);
        if (!st || !st.isFile()) return;
        // The text travels with the row so the page can show it without a round
        // trip — a static page is one that still works when its script does not.
        let text = '';
        try { text = fs.readFileSync(file, 'utf8').slice(0, MEMORY_CHARS); } catch { text = ''; }
        files.push({
            path: shortPath(file), abs: file, scope, kind, bytes: st.size,
            tokens: Math.round(st.size / CHARS_PER_TOKEN),
            mtime: st.mtimeMs || 0,
            text,
            clipped: st.size > MEMORY_CHARS,
        });
    };

    // Scope order, which is the order the client layers them in: what applies
    // everywhere, then what applies to the repository you are in. The exact
    // concatenation inside one scope belongs to the client and is not claimed
    // here.
    addFile(path.join(root, 'CLAUDE.md'), 'global');
    for (const entry of listDir(path.join(root, 'rules'))) {
        if (entry.isFile() && entry.name.endsWith('.md')) addFile(path.join(root, 'rules', entry.name), 'global');
    }
    for (const project of projects) {
        addFile(path.join(project, 'CLAUDE.md'), 'project');
        addFile(path.join(project, 'AGENTS.md'), 'project');
    }
    // Auto-memory: what the client wrote about this repository itself. It loads
    // exactly like the files above and was the one layer this never counted.
    for (const slug of slugs) {
        const dir = path.join(root, 'projects', slug, 'memory');
        for (const entry of listDir(dir)) {
            if (entry.isFile() && entry.name.endsWith('.md')) addFile(path.join(dir, entry.name), 'memory', 'memory');
        }
    }
    const globalTokens = files.filter((f) => f.scope === 'global').reduce((a, f) => a + f.tokens, 0);
    const ORDER = { global: 0, project: 1, memory: 2 };
    return {
        files: files.sort((a, b) => ORDER[a.scope] - ORDER[b.scope] || b.bytes - a.bytes),
        globalTokens,
    };
}

/**
 * The client's own changelog, already on disk because the client fetches it.
 * Split into versions, newest first, so the dashboard can show only what landed
 * after the version currently running.
 */
function changelog(root = ROOT, sinceVersion = '', override = '') {
    // `override` is the full upstream file when the user has allowed the fetch;
    // without it the client's own cache is the source, which lags a release by
    // up to a day and covers only a little history.
    let text = override;
    if (!text) {
        try { text = fs.readFileSync(path.join(root, 'cache', 'changelog.md'), 'utf8'); } catch { return []; }
    }
    const out = [];
    let current = null;
    for (const line of text.split('\n')) {
        const m = /^##\s+(\d+\.\d+\.\d+)\s*$/.exec(line);
        if (m) {
            current = { version: m[1], entries: [] };
            out.push(current);
            continue;
        }
        if (!current) continue;
        const item = line.replace(/^\s*[-*]\s*/, '').trim();
        if (item) current.entries.push(item);
    }
    if (!sinceVersion) return out;
    const newer = [];
    for (const release of out) {
        if (compareVersions(release.version, sinceVersion) <= 0) break;
        newer.push(release);
    }
    return newer;
}

function compareVersions(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
}

/**
 * Per-project numbers the client keeps for itself in `~/.claude.json`: the last
 * session's cost and duration, lines written, and the frame rate of its own
 * terminal UI. Nothing else reads these.
 */
function projectMetrics(config = readJson(CONFIG)) {
    const out = [];
    for (const [dir, p] of Object.entries((config && config.projects) || {})) {
        if (!p || typeof p !== 'object') continue;
        out.push({
            path: shortPath(dir),
            name: path.basename(dir),
            lastCost: p.lastCost || 0,
            lastDuration: p.lastDuration || 0,
            apiDuration: p.lastAPIDuration || 0,
            added: p.lastLinesAdded || 0,
            removed: p.lastLinesRemoved || 0,
            webSearches: p.lastTotalWebSearchRequests || 0,
            fps: p.lastFpsAverage || 0,
            fpsLow: p.lastFpsLow1Pct || 0,
            trusted: p.hasTrustDialogAccepted === true,
            allowedTools: (p.allowedTools || []).length,
            mcpServers: Object.keys(p.mcpServers || {}).length,
            startedAt: asTime(p.lastStartTime),
        });
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * The typed-prompt log, in aggregate only. The file holds the text of every
 * prompt ever typed on this machine, across every project; counts and dates are
 * all this returns, and the text never leaves the function.
 */
function promptLog(root = ROOT) {
    let text;
    try { text = fs.readFileSync(path.join(root, 'history.jsonl'), 'utf8'); } catch { return null; }
    const byDay = {};
    const byProject = {};
    let count = 0;
    let pasted = 0;
    let first = 0;
    let last = 0;
    for (const line of text.split('\n')) {
        if (!line || line[0] !== '{') continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        count++;
        const at = Number(r.timestamp) || Date.parse(r.timestamp) || 0;
        if (at) {
            if (!first || at < first) first = at;
            if (at > last) last = at;
            const d = new Date(at);
            const p = (n) => String(n).padStart(2, '0');
            const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
            byDay[key] = (byDay[key] || 0) + 1;
        }
        if (r.project) {
            const name = path.basename(r.project);
            byProject[name] = (byProject[name] || 0) + 1;
        }
        if (r.pastedContents && Object.keys(r.pastedContents).length > 0) pasted++;
    }
    return { count, pasted, byDay, byProject, first, last };
}

/** Client versions installed side by side, and which one a session would use. */
function versions(currentVersion = '') {
    const dir = path.join(HOME, '.local', 'share', 'claude', 'versions');
    const found = [];
    for (const entry of listDir(dir)) {
        if (!/^\d+\.\d+\.\d+$/.test(entry.name)) continue;
        const st = statOf(path.join(dir, entry.name));
        found.push({ version: entry.name, at: st ? st.mtimeMs : 0, bytes: st ? st.size : 0 });
    }
    found.sort((a, b) => compareVersions(b.version, a.version));
    const latest = found.length ? found[0].version : '';
    return {
        current: currentVersion,
        latest,
        waiting: Boolean(currentVersion && latest && compareVersions(latest, currentVersion) > 0),
        installed: found,
    };
}

// The version of the client that wrote the most recent transcript record — the
// registry does not always carry one, and a stale number here would make the
// changelog show releases that are already running.
function runningVersion(root = ROOT) {
    let best = '';
    let bestAt = 0;
    for (const entry of listDir(path.join(root, 'sessions'))) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const s = readJson(path.join(root, 'sessions', entry.name));
        if (!s || !s.version) continue;
        const at = asTime(s.startedAt);
        if (at >= bestAt) { bestAt = at; best = s.version; }
    }
    return best;
}

/**
 * One call for everything the Setup section shows. `withDisk` is separate
 * because walking three gigabytes of transcripts and plugin caches takes
 * seconds — the caller caches the result and refreshes it on demand.
 */
function snapshot({ root = ROOT, workspace = '', projects = [], sessionProjects = {}, withDisk = true, changelogText = '' } = {}) {
    const config = readJson(CONFIG);
    const current = runningVersion(root);
    // Sized once and handed to disk(), rather than walking every job twice.
    const jobRows = jobs(root, { withSizes: withDisk });
    return {
        at: Date.now(),
        versions: versions(current),
        settings: settingsOf(workspace, root),
        hooks: hooksOf(workspace, root),
        permissions: permissionsOf(workspace, root),
        mcp: mcpServers(config),
        plugins: plugins(root),
        jobs: jobRows,
        live: live(root),
        tasks: tasks(root, sessionProjects),
        disk: withDisk ? disk(root, jobRows) : null,
        context: contextBudget(root, projects, slugsOf(projects)),
        pluginUpdates: pluginUpdates(root),
        changelog: changelog(root, current, changelogText),
        projects: projectMetrics(config),
        prompts: promptLog(root),
    };
}

module.exports = {
    ROOT, CONFIG, CHARS_PER_TOKEN,
    settingsChain, settingsOf, hooksOf, permissionsOf, mcpServers, plugins, componentsOf,
    jobs, live, tasks, disk, dirSize, contextBudget, changelog, compareVersions, pluginUpdates,
    projectMetrics, promptLog, versions, runningVersion, snapshot, shortPath,
};
