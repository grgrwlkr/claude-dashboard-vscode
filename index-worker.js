// The index, built on a thread of its own.
//
// Reading a gigabyte of transcripts takes seconds, and on the extension host's
// thread those are seconds in which nothing else in the editor answers — the
// progress notification included, so the one thing on screen saying the work is
// still going could not repaint. Here the reading blocks a thread nobody is
// waiting on, and `parentPort` carries how far it has got.
//
// The index is written to disk by `refreshIndex` itself; the main thread reads
// it back rather than being handed three megabytes through a message.

const { parentPort, workerData } = require('worker_threads');
const ix = require('./indexer');

try {
    const { stats } = ix.refreshIndex(workerData.storageDir, {
        root: workerData.root,
        onProgress: (done, total) => parentPort.postMessage({ type: 'progress', done, total }),
    });
    parentPort.postMessage({ type: 'done', stats });
} catch (e) {
    parentPort.postMessage({ type: 'error', message: String((e && e.message) || e) });
}
