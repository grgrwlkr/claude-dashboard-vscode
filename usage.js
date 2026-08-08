// Account limits and pace. No dependency on vscode here, so this runs under
// plain node in tests.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CACHE = path.join(HOME, '.claude', 'statusline-usage.json');
const STAMP = CACHE + '.stamp';
const CREDS = path.join(HOME, '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

const WEEK = 604800;
const STAMP_TTL = 60;
const CACHE_TTL = 1800;

// The 30-minute / 2% floor matches statusline.sh: in the first minutes of a
// window any spend extrapolates to catastrophe, and percent arrives floored.
const DRY_MIN_ELAPSED = 1800;
const DRY_MIN_PCT = 2;

const BAR_WIDTH = 6;

function mtime(file) {
    try { return Math.floor(fs.statSync(file).mtimeMs / 1000); } catch { return 0; }
}

function parseToken(raw) {
    try { return JSON.parse(raw)?.claudeAiOauth?.accessToken || null; } catch { return null; }
}

// Same places statusline.sh looks: Keychain first, then the credentials file.
function readToken() {
    return new Promise((resolve) => {
        execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
            { timeout: 5000 }, (err, stdout) => {
                if (!err) {
                    const tok = parseToken(stdout);
                    if (tok) return resolve(tok);
                }
                try { resolve(parseToken(fs.readFileSync(CREDS, 'utf8'))); } catch { resolve(null); }
            });
    });
}

// Same cache and same protocol as statusline.sh: the stamp is touched BEFORE the
// request so parallel sessions do not stampede, and the write is atomic.
async function refreshUsage() {
    const token = await readToken();
    if (!token) return false;
    let res;
    try {
        res = await fetch(USAGE_URL, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'anthropic-beta': 'oauth-2025-04-20',
                'Content-Type': 'application/json',
            },
            signal: AbortSignal.timeout(8000),
        });
    } catch { return false; }
    if (!res.ok) return false;
    const body = await res.text();
    try {
        if (!JSON.parse(body).limits) return false;
    } catch { return false; }
    const tmp = `${CACHE}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, CACHE);
        return true;
    } catch {
        try { fs.unlinkSync(tmp); } catch { /* already gone */ }
        return false;
    }
}

function touchStamp() {
    try { fs.writeFileSync(STAMP, ''); return true; } catch { return false; }
}

function stampExpired(now) {
    return now - mtime(STAMP) >= STAMP_TTL;
}

function readCache(now) {
    if (now - mtime(CACHE) >= CACHE_TTL) return null;
    try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return null; }
}

function isoToTs(iso) {
    if (!iso) return 0;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

function limitsOf(payload) {
    const rows = Array.isArray(payload?.limits) ? payload.limits : [];
    const norm = (row) => row && {
        pct: Math.floor(row.percent ?? 0),
        reset: isoToTs(row.resets_at),
        scope: row.scope?.model?.display_name || null,
    };
    return {
        session: norm(rows.find((r) => r.kind === 'session')),
        weekly: norm(rows.find((r) => r.kind === 'weekly_all')),
        scoped: rows
            .filter((r) => r.kind === 'weekly_scoped' && r.scope?.model?.display_name)
            .map(norm),
    };
}

// Window start = resets_at - 7d. The API does not report started_at, but the
// reset time is stable between refreshes, so the window is fixed, not rolling.
function pace(weekly, now) {
    if (!weekly || weekly.reset <= 0) return null;
    const elapsed = Math.min(WEEK, Math.max(0, WEEK - (weekly.reset - now)));
    const plan = Math.floor((elapsed * 100) / WEEK);
    let dry = null;
    if (elapsed >= DRY_MIN_ELAPSED && weekly.pct >= DRY_MIN_PCT) {
        const ts = now + Math.floor((elapsed * (100 - weekly.pct)) / weekly.pct);
        if (ts < weekly.reset) dry = ts;
    }
    return { elapsed, plan, dry };
}

const pad2 = (n) => String(n).padStart(2, '0');

const sameDay = (a, b) => a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();

// Hours, not HH:MM. percent arrives as an integer and the forecast scales with
// (100-p)/p, so a single unit of rounding moves the answer by hours. The tilde
// says exactly that.
function fmtDry(ts, nowMs = Date.now()) {
    const d = new Date(ts * 1000);
    const hour = `~${pad2(d.getHours())}h`;
    return sameDay(d, new Date(nowMs)) ? hour : `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} ${hour}`;
}

function fmtLeft(ts, now) {
    const diff = ts - now;
    if (diff <= 0) return 'now';
    const d = Math.floor(diff / 86400);
    const h = Math.floor((diff % 86400) / 3600);
    const m = Math.floor((diff % 3600) / 60);
    if (d > 0) return `${d}d${h}h`;
    if (h > 0) return `${h}h${m}m`;
    return `${m}m`;
}

function fmtAbs(ts, nowMs = Date.now()) {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    return sameDay(d, new Date(nowMs)) ? hm : `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} ${hm}`;
}

// Fact and plan in one bar: cells beyond the plan are spend ahead of schedule.
function bar(fact, plan) {
    const f = Math.min(BAR_WIDTH, Math.max(0, Math.ceil((fact * BAR_WIDTH) / 100)));
    const p = Math.min(BAR_WIDTH, Math.max(0, Math.round((plan * BAR_WIDTH) / 100)));
    let out = '';
    for (let i = 0; i < BAR_WIDTH; i++) {
        if (i < f && i >= p) out += '▓';
        else if (i < f) out += '▒';
        else if (i < p) out += '·';
        else out += '░';
    }
    return out;
}

function barText(weekly, pc, nowMs = Date.now()) {
    let text = `✻ 7d ${weekly.pct}%`;
    if (pc) text += ` ${bar(weekly.pct, pc.plan)}`;
    if (pc?.dry) text += ` dry ${fmtDry(pc.dry, nowMs)}`;
    return text;
}

module.exports = {
    CACHE, STAMP, WEEK, STAMP_TTL, CACHE_TTL, BAR_WIDTH,
    mtime, parseToken, readToken, refreshUsage, touchStamp, stampExpired, readCache,
    isoToTs, limitsOf, pace, fmtDry, fmtLeft, fmtAbs, bar, barText,
};
