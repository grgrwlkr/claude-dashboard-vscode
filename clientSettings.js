// What Claude Code has been told, against what it can be told.
//
// Three questions, and only the first is answerable from this machine alone:
// what is set, what could be set, and what differs from the default. The second
// and third need the documented registry (settingsDocs.js), so everything here
// takes a registry and degrades to the first question when it is empty.
//
// Four buckets, not three. `unknown` — set, but the registry has never heard of
// the key — is what keeps the tab honest between a release that adds a setting
// and the day the registry catches up. Without it a new setting reads as a typo,
// or worse, silently vanishes from a page that claims to list everything.
//
// No dependency on vscode.

const { resolveSetting } = require('./session');

// A value is hidden when its name says it carries a credential. This errs
// towards hiding: `apiKeyHelper` holds a command rather than a key and is
// hidden anyway, because the page is a webview in a published extension and a
// screenshot of it travels further than the person taking it expects.
// `pat` and `bot` are bounded by a non-letter on each side, or they would take
// PATH, PATTERN and anything ending in -bot with them. `_` is not a letter, so
// GH_PAT and TELEGRAM_BOT still match, which is the point: they are the names
// that carry a credential whose value has no recognisable shape at all — a
// Slack webhook URL and a Telegram token are long mixed-case strings with no
// issuer prefix, and nothing but the name can catch them.
const SECRET = /key|token|secret|password|credential|auth|webhook|dsn|(?:^|[^a-z])pat(?:[^a-z]|$)|(?:^|[^a-z])bot(?:[^a-z]|$)/i;

// The name is not the only witness, and inside `env` it is the weaker one: the
// keys there are the user's own, and `GH_PAT`, `GITLAB_PAT`, `SLACK_BOT` and
// `SENTRY_DSN` all read as innocent while holding the thing this masking exists
// for. So a value that is shaped like a credential is hidden whatever it is
// filed under. Only unmistakable shapes are listed — an issuer's own prefix, a
// JWT, a credential inside a URL, or a long unbroken hex string. A UUID does
// not match (its hyphens break the run), which keeps the session ids on the
// page where they are useful.
const SECRET_VALUE = new RegExp([
    'sk-ant-[A-Za-z0-9_-]{8,}',
    'gh[pousr]_[A-Za-z0-9]{16,}',
    'github_pat_[A-Za-z0-9_]{16,}',
    'xox[baprs]-[A-Za-z0-9-]{10,}',
    'AKIA[0-9A-Z]{16}',
    'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}',
    // A credential in front of a host: `//user:pass@` and the passwordless
    // `//<key>@` a Sentry DSN uses. Bounded below so `//me@example` is not it.
    '//[^/\\s:@]{3,}:[^/\\s@]{3,}@',
    '//[A-Za-z0-9_.-]{16,}@',
    // Long unbroken hex, but only if it is actually mixed: `'a'.repeat(200)` is
    // hex by the letter and a credential by no other measure. This does hide a
    // 40-character git SHA, which is a deliberate trade rather than an oversight:
    // one cannot reach this tab — `fromHost` admits only the client's own
    // prefixes, and a commit hash has no business in its settings — while the
    // secrets shaped exactly like it are common. A short SHA does not match.
    '\\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{32,}\\b',
].join('|'));

const MAX_INLINE = 120;

function isSecret(key) {
    return SECRET.test(key);
}

function looksSecret(value) {
    return typeof value === 'string' && SECRET_VALUE.test(value);
}

// The name alone over-fires: `MAX_THINKING_TOKENS` is a budget, `TTL_MS` on an
// api-key helper is a duration, and hiding those makes the tab useless for the
// numbers people actually want to check. A credential is never a bare number,
// so the value settles it — and everything else under a credential-shaped name
// stays hidden, including paths and objects.
function shouldMask(key, value) {
    if (looksSecret(value)) return true;
    if (!isSecret(key)) return false;
    if (typeof value === 'number' || typeof value === 'boolean') return false;
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return false;
    return true;
}

// Masking by the name of the key it is filed under is not enough: the whole
// `env` block is filed under `env`, which reads innocent, and a short one
// serialises inline with the token inside it. So a container is redacted
// through before it is printed, at any depth.
function redact(value, seen) {
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return '…';
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => redact(v, seen));
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = shouldMask(key, v) ? '•••' : redact(v, seen);
    return out;
}

/**
 * A value as one short line. Objects are the reason this exists: `permissions`
 * is hundreds of lines on this machine and would be the whole page.
 */
function renderValue(key, value) {
    if (shouldMask(key, value)) return { text: '•••', masked: true };
    if (value === null || value === undefined) return { text: '—', masked: false };
    if (typeof value === 'string') {
        return { text: value.length > MAX_INLINE ? `${value.slice(0, MAX_INLINE)}…` : value, masked: false };
    }
    if (typeof value !== 'object') return { text: String(value), masked: false };

    const safe = redact(value, new Set());
    const json = JSON.stringify(safe);
    const masked = json !== JSON.stringify(value);
    if (json.length <= MAX_INLINE) return { text: json, masked };
    if (Array.isArray(value)) {
        return { text: `${value.length} ${value.length === 1 ? 'entry' : 'entries'}`, masked };
    }
    const keys = Object.keys(value);
    return { text: `${keys.length} ${keys.length === 1 ? 'key' : 'keys'}: ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? '…' : ''}`, masked };
}

// The docs write a default the way JSON writes it — `true`, `30`, `"latest"` —
// so one comparison covers every type without knowing which one it is.
function sameAsDefault(value, def) {
    if (!def) return false;
    try { return JSON.stringify(value) === def; } catch { return false; }
}

function indexRegistry(registry) {
    const out = new Map();
    for (const group of ['settings', 'globalConfig', 'env']) {
        for (const entry of (registry && registry[group]) || []) {
            if (!out.has(entry.key)) out.set(entry.key, entry);
        }
    }
    // The reference documents `worktree.baseRef`; a settings file holds
    // `worktree` with the rest inside it. Without this the object reads as a key
    // nobody has heard of, which is the one thing the unknown bucket is supposed
    // to mean something by.
    const containers = new Map();
    for (const key of [...out.keys()]) {
        const dot = key.indexOf('.');
        if (dot <= 0) continue;
        const head = key.slice(0, dot);
        if (out.has(head)) continue;
        if (!containers.has(head)) containers.set(head, []);
        containers.get(head).push(key.slice(dot + 1));
    }
    for (const [head, children] of containers) {
        out.set(head, {
            key: head,
            file: out.get(`${head}.${children[0]}`).file,
            type: 'object',
            default: '',
            defaultNote: '',
            description: `Documented one key at a time: ${children.sort().map((c) => `${head}.${c}`).join(', ')}.`,
            managedOnly: false,
            since: '',
        });
    }
    return out;
}

function entryFor(chain, key, known) {
    const at = resolveSetting(chain, key);
    const value = at ? at.value : undefined;
    const rendered = renderValue(key, value);
    const def = known ? known.default : '';
    return {
        key,
        value: rendered.text,
        masked: rendered.masked,
        from: at ? at.from : '',
        path: at ? at.path : '',
        // Every other file that states the same key. A setting that looks wrong
        // is usually a setting that is right in a file further down the chain.
        shadowed: at ? at.alsoIn.map((s) => ({ from: s.from, path: s.path, value: renderValue(key, s.value).text })) : [],
        known: Boolean(known),
        default: def,
        defaultNote: known ? known.defaultNote : '',
        differs: Boolean(def) && !sameAsDefault(value, def),
        description: known ? known.description : '',
        since: known ? known.since : '',
        managedOnly: known ? known.managedOnly : false,
        file: known ? known.file : '',
    };
}

/**
 * @param {object[]} chain    session.settingsChain(workspace)
 * @param {object}   registry the parsed documentation, or {}
 * @param {object}   hostEnv  process.env of the extension host — a hint, not truth
 */
function clientSettings({ chain = [], registry = {}, hostEnv = {} } = {}) {
    const known = indexRegistry(registry);
    const present = new Set();
    for (const file of chain) {
        if (!file.data) continue;
        for (const key of Object.keys(file.data)) present.add(key);
    }

    const set = [];
    const unknown = [];
    for (const key of [...present].sort()) {
        const entry = entryFor(chain, key, known.get(key));
        (entry.known ? set : unknown).push(entry);
    }
    const differs = set.filter((e) => e.differs);

    // What is documented and absent. Managed-only keys are in here too, flagged:
    // they are real settings, and knowing you cannot set one is worth as much as
    // knowing you have not.
    const unset = [];
    for (const entry of (registry.settings || [])) {
        if (present.has(entry.key)) continue;
        unset.push({
            key: entry.key,
            default: entry.default,
            defaultNote: entry.defaultNote,
            description: entry.description,
            since: entry.since,
            managedOnly: entry.managedOnly,
            file: entry.file,
        });
    }

    // The env block of the winning settings file. The docs do not say object
    // values merge across scopes, so the winner is shown whole and the files it
    // shadowed are named rather than silently folded in.
    const envAt = resolveSetting(chain, 'env');
    const fromSettings = [];
    if (envAt && envAt.value && typeof envAt.value === 'object') {
        for (const [key, value] of Object.entries(envAt.value).sort()) {
            const rendered = renderValue(key, value);
            const doc = known.get(key);
            fromSettings.push({
                key,
                value: rendered.text,
                masked: rendered.masked,
                from: envAt.from,
                path: envAt.path,
                known: Boolean(doc),
                description: doc ? doc.description : '',
            });
        }
    }

    // The extension host's own environment. This is genuinely a different thing
    // from what a session sees: VS Code launched from the Dock inherits launchd's
    // environment, a terminal session inherits the shell profile, and the two
    // disagree often enough that presenting this as "your settings" would lie.
    const fromHost = [];
    for (const key of Object.keys(hostEnv).sort()) {
        if (!/^(CLAUDE|ANTHROPIC|AWS_BEARER_TOKEN|DISABLE_|MAX_THINKING|OTEL_|VERTEX|CLOUD_ML)/.test(key)) continue;
        const rendered = renderValue(key, hostEnv[key]);
        const doc = known.get(key);
        fromHost.push({
            key,
            value: rendered.text,
            masked: rendered.masked,
            known: Boolean(doc),
            description: doc ? doc.description : '',
        });
    }

    return {
        checkedAt: registry.checkedAt || '',
        chain: chain.map((f) => ({
            scope: f.scope,
            path: f.path,
            documented: f.documented,
            exists: f.exists,
            keys: f.data ? Object.keys(f.data).length : 0,
        })),
        set,
        unknown,
        differs,
        unset,
        env: { fromSettings, fromHost, shadowed: envAt ? envAt.alsoIn.map((s) => s.path) : [] },
        counts: {
            set: set.length,
            unknown: unknown.length,
            differs: differs.length,
            unset: unset.length,
            documented: (registry.settings || []).length,
            variables: (registry.env || []).length,
        },
    };
}

module.exports = { clientSettings, renderValue, sameAsDefault, isSecret, shouldMask, indexRegistry };
