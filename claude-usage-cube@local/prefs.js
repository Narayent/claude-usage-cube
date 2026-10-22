import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SOURCES = [
    ['auto', 'Automatic', 'OAuth API, falling back to the status-line file'],
    ['oauth', 'OAuth API only', 'Uses your Claude Code login'],
    ['statusline', 'Status line only', 'Needs scripts/statusline-mirror.sh set up'],
];

const POSITIONS = [
    ['left', 'Left'],
    ['center', 'Center'],
    ['right', 'Right'],
];

// Keep a ComboRow and a string setting with <choices> in sync both ways.
// choices: [[value, label, subtitle?], ...]
function bindChoice(window, settings, key, row, choices) {
    row.model = Gtk.StringList.new(choices.map(([, label]) => label));
    const sync = () => {
        const i = choices.findIndex(([value]) => value === settings.get_string(key));
        row.selected = Math.max(i, 0);
        if (choices[row.selected][2])
            row.subtitle = choices[row.selected][2];
    };
    sync();
    const id = settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => {
        const value = choices[row.selected][0];
        if (settings.get_string(key) !== value)
            settings.set_string(key, value);
    });
    window.connect('close-request', () => settings.disconnect(id));
}

export default class ClaudeUsageCubePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // keep alive as long as the window

        const page = new Adw.PreferencesPage();
        window.add(page);

        const general = new Adw.PreferencesGroup({title: 'Updates'});
        page.add(general);

        const interval = new Adw.SpinRow({
            title: 'Check every',
            subtitle: 'Seconds between usage checks (60–3600)',
            adjustment: new Gtk.Adjustment({lower: 60, upper: 3600, step_increment: 30, page_increment: 300}),
        });
        settings.bind('poll-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        general.add(interval);

        const source = new Adw.ComboRow({title: 'Data source'});
        bindChoice(window, settings, 'data-source', source, SOURCES);
        general.add(source);

        const display = new Adw.PreferencesGroup({title: 'Display'});
        page.add(display);

        const position = new Adw.ComboRow({title: 'Position', subtitle: 'Side of the top bar'});
        bindChoice(window, settings, 'panel-position', position, POSITIONS);
        display.add(position);

        const percent = new Adw.SwitchRow({
            title: 'Show percentage',
            subtitle: 'Show the number next to the cube',
        });
        settings.bind('show-percent', percent, 'active', Gio.SettingsBindFlags.DEFAULT);
        display.add(percent);
    }
}
