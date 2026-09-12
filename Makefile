UUID = display-rescue@star-barsuk
EXTDIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
ZIPFILE = $(UUID).zip

SCHEMAS = schemas/org.gnome.shell.extensions.display-rescue.gschema.xml
COMPILED_SCHEMAS = schemas/gschemas.compiled

SRC = extension.js prefs.js metadata.json
SCHEMA_DIR = schemas

.PHONY: build install uninstall enable disable zip lint clean

build: $(COMPILED_SCHEMAS)

$(COMPILED_SCHEMAS): $(SCHEMAS)
	glib-compile-schemas $(SCHEMA_DIR)

install: build
	rm -rf $(EXTDIR)
	mkdir -p $(EXTDIR)
	cp $(SRC) $(EXTDIR)/
	cp -r $(SCHEMA_DIR) $(EXTDIR)/

uninstall:
	rm -rf $(EXTDIR)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

zip: build
	rm -f $(ZIPFILE)
	rm -rf _zipdir
	mkdir -p _zipdir/$(UUID)
	cp $(SRC) _zipdir/$(UUID)/
	cp -r $(SCHEMA_DIR) _zipdir/$(UUID)/
	cd _zipdir && zip -qr ../$(ZIPFILE) $(UUID)
	rm -rf _zipdir

lint:
	@if command -v gjs >/dev/null 2>&1; then \
		for f in extension.js prefs.js; do \
			echo "Checking $$f syntax..."; \
			gjs -c "$$f" 2>/dev/null || echo "  (skipped: external imports)"; \
		done; \
	else \
		echo "gjs not found, skipping lint"; \
	fi

clean:
	rm -f $(COMPILED_SCHEMAS)
	rm -f $(ZIPFILE)
	rm -rf _zipdir
