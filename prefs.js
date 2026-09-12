import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class DisplayRescuePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({
            title: 'Hotkeys',
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: 'Display modes',
            description: 'Blind-safe shortcuts. Mirror and Join mirror Ubuntu Settings calls.',
        });
        page.add(group);

        this._addKeybindingRow(window, group, settings, 'mirror', 'Mirror displays');
        this._addKeybindingRow(window, group, settings, 'join', 'Join displays');
        this._addKeybindingRow(window, group, settings, 'reset', 'Reset to 1080p mirror');
    }

    _addKeybindingRow(window, group, settings, key, title) {
        const row = new Adw.ActionRow({title});
        const button = new Gtk.Button({
            label: this._formatAccel(settings.get_strv(key)),
            valign: Gtk.Align.CENTER,
        });
        button.add_css_class('flat');
        button.connect('clicked', () => {
            this._showCaptureDialog(window, settings, key, title, button);
        });
        row.add_suffix(button);
        row.activatable_widget = button;
        group.add(row);
    }

    _showCaptureDialog(window, settings, key, title, button) {
        const dialog = new Adw.MessageDialog({
            transient_for: window,
            modal: true,
            heading: `Set ${title}`,
            body: 'Press a key combination, Esc to cancel, Backspace to clear',
        });
        dialog.add_response('cancel', 'Cancel');

        const keyController = new Gtk.EventControllerKey();
        dialog.add_controller(keyController);
        keyController.connect('key-pressed', (_ctrl, keyval, _keycode, state) => {
            if (keyval === Gdk.KEY_Escape) {
                dialog.close();
                return true;
            }
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            if (keyval === Gdk.KEY_BackSpace && mods === 0) {
                settings.set_strv(key, []);
                button.set_label(this._formatAccel([]));
                dialog.close();
                return true;
            }
            if (!Gtk.accelerator_valid(keyval, mods))
                return true;
            const accel = Gtk.accelerator_name(keyval, mods);
            settings.set_strv(key, [accel]);
            button.set_label(this._formatAccel([accel]));
            dialog.close();
            return true;
        });
        dialog.connect('response', () => dialog.close());
        dialog.present();
    }

    _formatAccel(strv) {
        if (!strv || strv.length === 0)
            return 'Disabled';
        try {
            const [ok, keyval, mods] = Gtk.accelerator_parse(strv[0]);
            if (ok && keyval !== 0)
                return Gtk.accelerator_get_label(keyval, mods);
        } catch (e) {
            log(`Failed to parse accelerator "${strv[0]}": ${e.message}`);
        }
        return strv[0];
    }
}
