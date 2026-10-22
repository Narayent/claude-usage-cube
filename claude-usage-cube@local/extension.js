import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {percentToRgb} from './color.js';
import {
    fetchOAuth, readStatusFile, effectivePercent, statusFilePath, loadCache, saveCache, ensureCacheDir,
    STALE_AFTER,
} from './usage.js';

const MAX_BACKOFF = 15 * 60; // seconds
const FILE_DEBOUNCE = 2;     // seconds; status-line writes come in bursts
const CUBE_RADIUS = 4 / 14; // corner radius as a fraction of the side; side = CSS width

const ERROR_TEXT = {
    auth: 'Not signed in — run `claude` and log in',
    rate: 'Rate limited, backing off',
    server: 'Server error, backing off',
    network: 'Network error',
    schema: 'Unexpected response',
    missing: 'No status-line data yet',
};

function log(msg) {
    console.log(`[claude-usage-cube] ${msg}`);
}

function now() {
    return Math.floor(GLib.get_real_time() / 1e6);
}

function formatTime(unix) {
    const dt = GLib.DateTime.new_from_unix_local(unix);
    const today = GLib.DateTime.new_now_local();
    const sameDay = dt.get_day_of_year() === today.get_day_of_year() && dt.get_year() === today.get_year();
    return dt.format(sameDay ? '%H:%M' : '%a %H:%M');
}

function formatDuration(seconds) {
    const m = Math.max(0, Math.ceil(seconds / 60));
    const d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60), min = m % 60;
    if (d > 0)
        return `${d} d ${h} h`;
    return h > 0 ? `${h} h ${min} m` : `${min} m`;
}

export default class ClaudeUsageCubeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._cancellable = new Gio.Cancellable();
        this._session = null; // created on first OAuth request
        this._userAgent = `claude-usage-cube/${this.metadata['version-name'] ?? '0'}`;

        this._usage = null;       // last good Usage
        this._lastGoodAt = 0;     // unix seconds
        this._error = null;       // error of the most recent attempt
        this._failures = 0;       // consecutive 429/5xx, for backoff
        this._inFlight = false;
        this._pollId = 0;
        this._resetId = 0;
        this._tickId = 0;
        this._fileId = 0;
        this._monitor = null;
        this._monitorId = 0;
        this._cubeKey = '';

        this._buildIndicator();

        this._settingsIds = [
            this._settings.connect('changed::poll-interval', () => this._schedule(this._interval())),
            this._settings.connect('changed::show-percent', () => this._updateUI()),
            this._settings.connect('changed::panel-position', () => {
                this._destroyIndicator();
                this._buildIndicator();
                this._updateUI();
            }),
            this._settings.connect('changed::data-source', () => {
                this._setupMonitor();
                this._refresh();
            }),
        ];

        this._setupMonitor();
        this._updateUI();
        this._start();
    }

    disable() {
        this._cancellable.cancel();
        this._session?.abort();

        for (const id of [this._pollId, this._resetId, this._tickId]) {
            if (id)
                GLib.Source.remove(id);
        }
        this._pollId = this._resetId = this._tickId = 0;

        this._teardownMonitor();
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._settingsIds = null;

        this._destroyIndicator();

        this._session = null;
        this._cancellable = null;
        this._settings = null;
        this._usage = null;
    }

    _buildIndicator() {
        this._indicator = new PanelMenu.Button(0.5, 'Claude usage', false);

        const box = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        // Drawn with cairo rather than CSS so the square lands exactly on the
        // device-pixel grid and stays crisp at any scale.
        this._cubeRgb = percentToRgb(null);
        this._cube = new St.DrawingArea({
            style_class: 'claude-usage-cube',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._cube.connect('repaint', area => this._drawCube(area));
        this._label = new St.Label({
            style_class: 'claude-usage-cube-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._cube);
        box.add_child(this._label);
        this._indicator.add_child(box);

        const menu = this._indicator.menu;
        const info = () => {
            const item = new PopupMenu.PopupMenuItem('', {reactive: false});
            menu.addMenuItem(item);
            return item;
        };
        this._items = {
            session: info(),
            reset: info(),
            week: info(),
            source: info(),
            updated: info(),
        };
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Refresh now', () => this._refresh());
        menu.addAction('Settings', () => this.openPreferences());

        // Keep the countdown fresh only while the menu is visible.
        menu.connect('open-state-changed', (_menu, open) => {
            if (this._tickId) {
                GLib.Source.remove(this._tickId);
                this._tickId = 0;
            }
            if (!open)
                return;
            this._updateMenu();
            this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
                this._updateMenu();
                return GLib.SOURCE_CONTINUE;
            });
        });

        // Left: right after Activities. Center: right after the clock (-1 appends).
        // Right: leftmost of the status icons.
        const side = this._settings.get_string('panel-position');
        const index = {left: 1, center: -1}[side] ?? 0;
        Main.panel.addToStatusArea(this.uuid, this._indicator, index, side);
    }

    _destroyIndicator() {
        if (this._tickId) {
            GLib.Source.remove(this._tickId);
            this._tickId = 0;
        }
        this._indicator.destroy();
        this._indicator = null;
        this._cube = this._label = null;
        this._items = null;
        this._cubeKey = '';
    }

    // Show the cached result right away and only hit the API once it is older than the poll interval.
    async _start() {
        const cancellable = this._cancellable;
        let cached = null;
        if (this._settings.get_string('data-source') !== 'statusline') {
            try {
                cached = await loadCache(cancellable);
            } catch {
                return; // cancelled: disabled while loading
            }
        }
        if (cancellable.is_cancelled())
            return;

        const age = cached ? now() - cached.fetchedAt : Infinity;
        if (cached && age < STALE_AFTER) {
            this._usage = cached.usage;
            this._lastGoodAt = cached.fetchedAt;
            this._scheduleReset();
            this._updateUI();
        }
        if (age < this._interval())
            this._schedule(this._interval() - age);
        else
            this._refresh();
    }

    _drawCube(area) {
        const cr = area.get_context();
        // The area is exactly the cube (size from CSS, which includes the UI scale).
        const [w, h] = area.get_surface_size();
        const s = Math.min(w, h), r = s * CUBE_RADIUS;
        const x = (w - s) / 2, y = (h - s) / 2;

        cr.newSubPath();
        cr.arc(x + s - r, y + r, r, -Math.PI / 2, 0);
        cr.arc(x + s - r, y + s - r, r, 0, Math.PI / 2);
        cr.arc(x + r, y + s - r, r, Math.PI / 2, Math.PI);
        cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
        cr.closePath();
        const [red, green, blue] = this._cubeRgb;
        cr.setSourceRGB(red / 255, green / 255, blue / 255);
        cr.fill();
        cr.$dispose();
    }

    _interval() {
        return Math.max(60, this._settings.get_uint('poll-interval'));
    }

    _schedule(seconds) {
        if (this._pollId)
            GLib.Source.remove(this._pollId);
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._pollId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Show 0 % the moment the window resets, then ask for fresh data.
    _scheduleReset() {
        if (this._resetId) {
            GLib.Source.remove(this._resetId);
            this._resetId = 0;
        }
        const resetsAt = this._usage?.resetsAt;
        if (!resetsAt || resetsAt <= now())
            return;
        this._resetId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, resetsAt - now() + 1, () => {
            this._resetId = 0;
            this._updateUI();
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refresh({fileOnly = false} = {}) {
        if (this._inFlight)
            return;
        this._inFlight = true;

        const cancellable = this._cancellable;
        const source = this._settings.get_string('data-source');
        let usage = null, oauthError = null, retryAfter = null;
        try {
            if (source !== 'statusline' && !fileOnly) {
                this._session ??= new Soup.Session({timeout: 30});
                usage = await fetchOAuth(this._session, cancellable, this._userAgent);
                oauthError = usage.error;
                retryAfter = usage.retryAfter ?? null;
                if (!usage.error) {
                    saveCache(usage, now(), cancellable).catch(e => {
                        if (!cancellable.is_cancelled())
                            log(`could not write cache: ${e.message}`);
                    });
                }
            }
            if (source === 'statusline' || (source === 'auto' && (fileOnly || usage.error))) {
                const fromFile = await readStatusFile(cancellable);
                if (!fromFile.error || !usage)
                    usage = fromFile;
            }
        } catch (e) {
            if (!cancellable.is_cancelled())
                console.error(`[claude-usage-cube] refresh failed: ${e.message}`);
        }
        if (cancellable.is_cancelled())
            return; // disabled while waiting
        this._inFlight = false;

        // Backoff follows the OAuth endpoint only, even if the file fallback succeeded.
        let delay = this._interval();
        if (oauthError === 'rate' || oauthError === 'server') {
            this._failures++;
            delay = Math.max(delay, Math.min(delay * 2 ** this._failures, MAX_BACKOFF), retryAfter ?? 0);
        } else if (!fileOnly) {
            this._failures = 0;
        }
        if (!fileOnly)
            this._schedule(delay);
        if (!usage)
            return;

        if (usage.error !== this._error && usage.error)
            log(`${usage.source}: ${usage.error}`);
        this._error = usage.error;

        if (!usage.error) {
            this._usage = usage;
            this._lastGoodAt = now();
        } else if (usage.error === 'auth') {
            this._usage = null; // don't keep showing a number we can no longer verify
        }

        this._scheduleReset();
        this._updateUI();
    }

    async _setupMonitor() {
        this._teardownMonitor();
        if (this._settings.get_string('data-source') === 'oauth')
            return;

        // GLib polls every few seconds for a missing parent directory, so make sure it exists.
        const cancellable = this._cancellable;
        try {
            await ensureCacheDir(cancellable);
        } catch {
            return; // cancelled
        }
        if (cancellable.is_cancelled() || this._monitor ||
            this._settings.get_string('data-source') === 'oauth')
            return; // disabled, already set up by a later call, or source changed meanwhile

        const file = Gio.File.new_for_path(statusFilePath());
        this._monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitorId = this._monitor.connect('changed', (_m, _f, _o, event) => {
            if (event !== Gio.FileMonitorEvent.CHANGES_DONE_HINT && event !== Gio.FileMonitorEvent.CREATED)
                return;
            // In auto mode the file only matters while OAuth is failing.
            if (this._settings.get_string('data-source') !== 'statusline' && this._usage?.source === 'oauth')
                return;
            if (this._fileId)
                return; // a read is already queued
            this._fileId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, FILE_DEBOUNCE, () => {
                this._fileId = 0;
                this._refresh({fileOnly: true});
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _teardownMonitor() {
        if (this._fileId) {
            GLib.Source.remove(this._fileId);
            this._fileId = 0;
        }
        if (!this._monitor)
            return;
        this._monitor.disconnect(this._monitorId);
        this._monitor.cancel();
        this._monitor = null;
        this._monitorId = 0;
    }

    // Cube and label always; the menu only while someone can see it.
    _updateUI() {
        if (!this._indicator)
            return;
        const percent = this._usage ? effectivePercent(this._usage) : null;

        const rgb = percentToRgb(percent);
        const key = rgb.map(Math.round).join();
        if (key !== this._cubeKey) {
            this._cubeKey = key;
            this._cubeRgb = rgb;
            this._cube.queue_repaint();
        }
        this._label.visible = this._settings.get_boolean('show-percent');
        if (this._label.visible)
            this._label.text = percent === null ? '–' : `${Math.round(percent)} %`;

        if (this._indicator.menu.isOpen)
            this._updateMenu();
    }

    _updateMenu() {
        const u = this._usage;
        const percent = u ? effectivePercent(u) : null;
        const stale = u && (u.stale || this._error !== null || now() - this._lastGoodAt > STALE_AFTER);
        const items = this._items;
        if (percent === null) {
            const err = this._error ? ERROR_TEXT[this._error] ?? this._error : 'Loading…';
            items.session.label.text = this._error === 'auth' ? `5-hour session: ! ${err}` : `5-hour session: unknown (${err})`;
            items.reset.visible = items.week.visible = items.source.visible = items.updated.visible = false;
            return;
        }

        items.session.label.text = `5-hour session: ${Math.round(percent)} %`;

        items.reset.visible = !!u.resetsAt;
        if (u.resetsAt) {
            items.reset.label.text = u.resetsAt > now()
                ? `Resets in ${formatDuration(u.resetsAt - now())} (at ${formatTime(u.resetsAt)})`
                : 'Window has reset';
        }

        items.week.visible = !!u.sevenDay;
        if (u.sevenDay) {
            const at = u.sevenDay.resetsAt ? ` · resets ${formatTime(u.sevenDay.resetsAt)}` : '';
            items.week.label.text = `7-day: ${Math.round(u.sevenDay.percent)} %${at}`;
        }

        items.source.visible = true;
        items.source.label.text = `Source: ${u.source === 'oauth' ? 'OAuth API' : 'status line'}`;

        items.updated.visible = true;
        const err = this._error ? ` — ${ERROR_TEXT[this._error] ?? this._error}` : '';
        items.updated.label.text = `Updated ${formatTime(this._lastGoodAt)}${stale ? ' (stale)' : ''}${err}`;
    }
}
