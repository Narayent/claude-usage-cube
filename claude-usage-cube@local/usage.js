// Data sources. Parsers are pure and never throw; they return a Usage object:
//   {percent, resetsAt, sevenDay, source, error, stale}
// percent: 0-100 or null, resetsAt: unix seconds or null,
// sevenDay: {percent, resetsAt} or null,
// error: null | 'auth' | 'rate' | 'server' | 'network' | 'schema' | 'missing'.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const STALE_AFTER = 5 * 3600; // seconds

const decoder = new TextDecoder();

function result(source, fields = {}) {
    return {percent: null, resetsAt: null, sevenDay: null, source, error: null, stale: false, ...fields};
}

function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function toPercent(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ISO 8601 string (with or without fractional seconds) or epoch seconds/ms -> unix seconds.
export function toUnixSeconds(v) {
    if (typeof v === 'number' && Number.isFinite(v))
        return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
    if (typeof v !== 'string' || v === '')
        return null;
    if (/^\d+(\.\d+)?$/.test(v))
        return toUnixSeconds(Number(v));
    const dt = GLib.DateTime.new_from_iso8601(v, GLib.TimeZone.new_utc());
    return dt ? dt.to_unix() : null;
}

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

export function parseOAuth(text) {
    const json = parseJson(text);
    if (!isObject(json))
        return result('oauth', {error: 'schema'});

    let percent = null, resetsAt = null;
    if (isObject(json.five_hour)) {
        percent = toPercent(json.five_hour.utilization);
        resetsAt = toUnixSeconds(json.five_hour.resets_at);
    } else if (Array.isArray(json.limits)) {
        const session = json.limits.find(l => isObject(l) && l.kind === 'session');
        if (session) {
            percent = toPercent(session.percent);
            resetsAt = toUnixSeconds(session.resets_at);
        }
    }

    let sevenDay = null;
    if (isObject(json.seven_day) && toPercent(json.seven_day.utilization) !== null) {
        sevenDay = {
            percent: json.seven_day.utilization,
            resetsAt: toUnixSeconds(json.seven_day.resets_at),
        };
    }

    // five_hour: null with no session limit means "no active session" when the
    // rest of the payload looks right; treat that as 0 % rather than unknown.
    if (percent === null && json.five_hour === null && sevenDay)
        percent = 0;

    return result('oauth', {percent, resetsAt, sevenDay, error: percent === null ? 'schema' : null});
}

// Cache file written by scripts/statusline-mirror.sh: {"updated_at": <epoch>, "rate_limits": {...}}
export function parseStatusLine(text, now = GLib.get_real_time() / 1e6) {
    const json = parseJson(text);
    const limits = isObject(json) ? json.rate_limits : undefined;
    if (!isObject(limits) || !isObject(limits.five_hour))
        return result('statusline', {error: 'schema'});

    const percent = toPercent(limits.five_hour.used_percentage);
    let sevenDay = null;
    if (isObject(limits.seven_day) && toPercent(limits.seven_day.used_percentage) !== null) {
        sevenDay = {
            percent: limits.seven_day.used_percentage,
            resetsAt: toUnixSeconds(limits.seven_day.resets_at),
        };
    }
    const updatedAt = toUnixSeconds(json.updated_at);

    return result('statusline', {
        percent,
        resetsAt: toUnixSeconds(limits.five_hour.resets_at),
        sevenDay,
        stale: updatedAt === null || now - updatedAt > STALE_AFTER,
        error: percent === null ? 'schema' : null,
    });
}

// After the window resets, usage is 0 until the next poll says otherwise.
export function effectivePercent(usage, now = GLib.get_real_time() / 1e6) {
    if (usage.percent === null)
        return null;
    if (usage.resetsAt !== null && now >= usage.resetsAt)
        return 0;
    return usage.percent;
}

function loadFile(path, cancellable) {
    const file = Gio.File.new_for_path(path);
    return new Promise((resolve, reject) => {
        file.load_contents_async(cancellable, (f, res) => {
            try {
                const [, bytes] = f.load_contents_finish(res);
                resolve(decoder.decode(bytes));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export function credentialsPath() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
}

export function statusFilePath() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-usage-cube', 'usage.json']);
}

// Reads the token fresh each call; it is never stored or logged.
async function readToken(cancellable) {
    const json = parseJson(await loadFile(credentialsPath(), cancellable));
    const token = json?.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token ? token : null;
}

export async function fetchOAuth(session, cancellable, userAgent) {
    let token;
    try {
        token = await readToken(cancellable);
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            throw e;
        token = null;
    }
    if (!token)
        return result('oauth', {error: 'auth'});

    const msg = Soup.Message.new('GET', USAGE_URL);
    msg.request_headers.append('Authorization', `Bearer ${token}`);
    msg.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
    msg.request_headers.append('User-Agent', userAgent);
    msg.request_headers.append('Accept', 'application/json');
    token = null;

    let bytes;
    try {
        bytes = await new Promise((resolve, reject) => {
            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
                try {
                    resolve(s.send_and_read_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            throw e;
        return result('oauth', {error: 'network'});
    }

    // status_code, not get_status(): the latter throws for codes missing from Soup.Status (e.g. 429).
    const status = msg.status_code;
    if (status === 401 || status === 403)
        return result('oauth', {error: 'auth'});
    if (status === 429) {
        const retryAfter = Number.parseInt(msg.response_headers.get_one('retry-after') ?? '', 10);
        return result('oauth', {error: 'rate', retryAfter: Number.isFinite(retryAfter) ? retryAfter : null});
    }
    if (status >= 500)
        return result('oauth', {error: 'server'});
    if (status !== 200)
        return result('oauth', {error: 'schema'});

    return parseOAuth(decoder.decode(bytes.get_data() ?? new Uint8Array()));
}

// Last good OAuth result, so re-enabling (e.g. after unlocking the screen) doesn't
// cost a request. Format: {"fetchedAt": <unix s>, "usage": <Usage>}.
export function cachePath() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-usage-cube', 'oauth.json']);
}

export async function loadCache(cancellable) {
    try {
        const json = parseJson(await loadFile(cachePath(), cancellable));
        const usage = json?.usage;
        if (!isObject(usage) || toPercent(usage.percent) === null || typeof json.fetchedAt !== 'number')
            return null;
        return {fetchedAt: json.fetchedAt, usage: result('oauth', {...usage, error: null, stale: false})};
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            throw e;
        return null;
    }
}

// Creates ~/.cache/claude-usage-cube if needed. Failures other than cancel are
// ignored: they resurface when the file inside is used.
export function ensureCacheDir(cancellable) {
    const dir = Gio.File.new_for_path(GLib.path_get_dirname(cachePath()));
    return new Promise((resolve, reject) => {
        dir.make_directory_async(GLib.PRIORITY_DEFAULT, cancellable, (d, res) => {
            try {
                d.make_directory_finish(res);
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    reject(e);
                    return;
                }
            }
            resolve();
        });
    });
}

export async function saveCache(usage, fetchedAt, cancellable) {
    const file = Gio.File.new_for_path(cachePath());
    const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify({fetchedAt, usage})));
    await ensureCacheDir(cancellable);
    await new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION,
            cancellable, (f, res) => {
                try {
                    f.replace_contents_finish(res);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
    });
}

export async function readStatusFile(cancellable) {
    try {
        return parseStatusLine(await loadFile(statusFilePath(), cancellable));
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            throw e;
        return result('statusline', {error: 'missing'});
    }
}
