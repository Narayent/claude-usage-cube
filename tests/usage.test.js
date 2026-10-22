import {parseOAuth, parseStatusLine, effectivePercent, toUnixSeconds} from '../claude-usage-cube@local/usage.js';
import {test, eq, ok, fixture, finish} from './lib.js';

const T_2026_02_06_22 = 1770415200; // 2026-02-06T22:00:00Z

test('toUnixSeconds: ISO, ISO with micros, epoch s, epoch ms, numeric string, junk', () => {
    eq(toUnixSeconds('2026-02-06T22:00:00+00:00'), T_2026_02_06_22);
    eq(toUnixSeconds('2026-02-06T22:00:00.012122+00:00'), T_2026_02_06_22);
    eq(toUnixSeconds('2026-02-06T23:00:00+01:00'), T_2026_02_06_22);
    eq(toUnixSeconds(T_2026_02_06_22), T_2026_02_06_22);
    eq(toUnixSeconds(T_2026_02_06_22 * 1000), T_2026_02_06_22);
    eq(toUnixSeconds(String(T_2026_02_06_22)), T_2026_02_06_22);
    eq(toUnixSeconds('tomorrow'), null);
    eq(toUnixSeconds(null), null);
    eq(toUnixSeconds(''), null);
});

test('oauth: live response', () => {
    const u = parseOAuth(fixture('live.json'));
    eq(u.error, null);
    eq(u.source, 'oauth');
    ok(typeof u.percent === 'number' && u.percent >= 0 && u.percent <= 100, 'percent in range');
    ok(u.resetsAt > 1.7e9, 'resetsAt parsed');
    ok(u.sevenDay && typeof u.sevenDay.percent === 'number', 'seven day present');
});

test('oauth: normal, extra keys ignored', () => {
    const u = parseOAuth(fixture('normal.json'));
    eq([u.percent, u.resetsAt, u.error], [42, T_2026_02_06_22, null]);
    eq(u.sevenDay.percent, 17.5);
});

test('oauth: null resets_at and null seven_day', () => {
    const u = parseOAuth(fixture('nulls.json'));
    eq([u.percent, u.resetsAt, u.sevenDay, u.error], [0, null, null, null]);
});

test('oauth: five_hour null means no active session -> 0 %', () => {
    const u = parseOAuth(fixture('five_hour_null.json'));
    eq([u.percent, u.resetsAt, u.error], [0, null, null]);
    eq(u.sevenDay.percent, 40);
});

test('oauth: missing five_hour falls back to limits[session]', () => {
    const u = parseOAuth(fixture('missing_five_hour.json'));
    eq([u.percent, u.error], [63, null]);
    eq(u.resetsAt, toUnixSeconds('2026-10-22T15:10:00Z'));
});

test('oauth: wrong types -> schema error, no throw', () => {
    const u = parseOAuth(fixture('wrong_types.json'));
    eq([u.percent, u.error], [null, 'schema']);
});

test('oauth: garbage / empty / array -> schema error', () => {
    for (const text of [fixture('garbage.txt'), '', '[]', 'null', '42'])
        eq(parseOAuth(text).error, 'schema', JSON.stringify(text));
});

test('statusline: epoch timestamps, fresh', () => {
    const u = parseStatusLine(fixture('statusline_epoch.json'), 1770400000 + 60);
    eq([u.percent, u.resetsAt, u.stale, u.error, u.source], [88, T_2026_02_06_22, false, null, 'statusline']);
    eq(u.sevenDay.percent, 30);
});

test('statusline: ISO timestamps', () => {
    const u = parseStatusLine(fixture('statusline_iso.json'), 1770400000);
    eq([u.percent, u.resetsAt, u.stale, u.sevenDay], [12.5, T_2026_02_06_22, false, null]);
});

test('statusline: older than 5 h is stale', () => {
    const u = parseStatusLine(fixture('statusline_epoch.json'), 1770400000 + 5 * 3600 + 1);
    eq([u.percent, u.stale], [88, true]);
});

test('statusline: missing rate_limits / garbage -> schema error', () => {
    eq(parseStatusLine(fixture('statusline_empty.json')).error, 'schema');
    eq(parseStatusLine(fixture('garbage.txt')).error, 'schema');
});

test('effectivePercent: drops to 0 after reset', () => {
    const u = parseOAuth(fixture('normal.json'));
    eq(effectivePercent(u, T_2026_02_06_22 - 1), 42);
    eq(effectivePercent(u, T_2026_02_06_22), 0);
    eq(effectivePercent(parseOAuth('garbage')), null);
});

finish();
