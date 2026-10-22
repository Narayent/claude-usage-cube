UUID     := claude-usage-cube@local
DEST     := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SHELL_MAJOR := $(shell gnome-shell --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')
# Nested shell's D-Bus address, so `make enable`/`disable` can reach it.
NESTED_BUS  := $(XDG_RUNTIME_DIR)/claude-usage-cube-nested.bus
NESTED_LOG  := $(XDG_RUNTIME_DIR)/claude-usage-cube-nested.log

.PHONY: test install uninstall pack nested enable disable cycle logs nested-logs

test:
	gjs -m tests/color.test.js
	gjs -m tests/usage.test.js

install:
	rm -rf $(DEST)
	mkdir -p $(DEST)
	cp -r $(UUID)/. $(DEST)/
	glib-compile-schemas $(DEST)/schemas
	@echo "Installed to $(DEST). In your real session, log out and back in to load changes."

uninstall:
	rm -rf $(DEST)

pack:
	gnome-extensions pack $(UUID) --extra-source=usage.js --extra-source=color.js --force

# GNOME 49+ uses the mutter devkit (sudo dnf install mutter-devkit); older shells use --nested.
nested:
	@if [ $(SHELL_MAJOR) -ge 49 ]; then flag=--devkit; else flag=--nested; fi; \
	MUTTER_DEBUG_DUMMY_MODE_SPECS=1600x900 dbus-run-session -- sh -c \
	  "echo \$$DBUS_SESSION_BUS_ADDRESS > $(NESTED_BUS); exec gnome-shell $$flag --wayland" \
	  2>&1 | tee $(NESTED_LOG)

enable:
	DBUS_SESSION_BUS_ADDRESS=$$(cat $(NESTED_BUS)) gnome-extensions enable $(UUID)

disable:
	DBUS_SESSION_BUS_ADDRESS=$$(cat $(NESTED_BUS)) gnome-extensions disable $(UUID)

# Toggle the extension in the nested shell a few times to check teardown.
cycle:
	@for i in 1 2 3 4 5; do $(MAKE) -s disable; sleep 1; $(MAKE) -s enable; sleep 2; done

nested-logs:
	grep -E 'claude-usage-cube|JS ERROR|JS WARNING|CRITICAL' $(NESTED_LOG) | grep -v 'requested by'

logs:
	journalctl -f -o cat /usr/bin/gnome-shell | grep --line-buffered claude-usage-cube
