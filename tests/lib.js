// Tiny test helper: test(name, fn), then finish() exits non-zero on failure.
import System from 'system';
import GLib from 'gi://GLib';

let failed = 0, passed = 0;

export function test(name, fn) {
    try {
        fn();
        passed++;
    } catch (e) {
        failed++;
        print(`FAIL ${name}\n  ${e.message}`);
    }
}

export function eq(actual, expected, msg = '') {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b)
        throw new Error(`${msg} expected ${b}, got ${a}`);
}

export function ok(cond, msg = 'assertion failed') {
    if (!cond)
        throw new Error(msg);
}

export function fixture(name) {
    const dir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
    const [, bytes] = GLib.file_get_contents(`${dir}/fixtures/${name}`);
    return new TextDecoder().decode(bytes);
}

export function finish() {
    print(`${passed} passed, ${failed} failed`);
    System.exit(failed ? 1 : 0);
}
