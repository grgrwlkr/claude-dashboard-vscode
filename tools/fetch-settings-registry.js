#!/usr/bin/env node
// Refresh claude-settings-registry.json from the documentation.
//
//   node tools/fetch-settings-registry.js            # write the snapshot
//   node tools/fetch-settings-registry.js --dry-run  # print what would change
//
// The extension runs the same parser at runtime when the network toggle is on,
// so this script exists to keep an offline machine from shipping with nothing:
// the committed snapshot is what a user sees before, and instead of, any fetch.

const fs = require('node:fs');
const path = require('node:path');
const { buildRegistry } = require('../settingsDocs');

const SOURCE = {
    settings: 'https://code.claude.com/docs/en/settings.md',
    env: 'https://code.claude.com/docs/en/env-vars.md',
};
const OUT = path.join(__dirname, '..', 'claude-settings-registry.json');

async function text(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.text();
}

async function main() {
    const [settingsMd, envMd] = await Promise.all([text(SOURCE.settings), text(SOURCE.env)]);
    const registry = buildRegistry({
        settingsMd,
        envMd,
        source: SOURCE,
        checkedAt: new Date().toISOString().slice(0, 10),
    });
    const body = `${JSON.stringify(registry, null, 2)}\n`;

    let before = null;
    try { before = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* first run */ }
    const count = (r) => (r ? `${r.settings.length} settings, ${r.globalConfig.length} global, ${r.env.length} env` : 'nothing');
    console.log(`was: ${count(before)}`);
    console.log(`now: ${count(registry)} (checked ${registry.checkedAt})`);
    if (before) {
        for (const group of ['settings', 'globalConfig', 'env']) {
            const had = new Set(before[group].map((e) => e.key));
            const has = new Set(registry[group].map((e) => e.key));
            const added = [...has].filter((k) => !had.has(k));
            const gone = [...had].filter((k) => !has.has(k));
            if (added.length) console.log(`  + ${group}: ${added.join(', ')}`);
            if (gone.length) console.log(`  − ${group}: ${gone.join(', ')}`);
        }
    }
    if (process.argv.includes('--dry-run')) return;
    fs.writeFileSync(OUT, body);
    console.log(`wrote ${OUT}`);
}

main().catch((err) => {
    console.error(String(err && err.message ? err.message : err));
    process.exit(1);
});
