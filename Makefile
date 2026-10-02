UUID = display-rescue@star-barsuk
EXTDIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
ZIPFILE = $(UUID).zip

SCHEMAS = schemas/org.gnome.shell.extensions.display-rescue.gschema.xml
COMPILED_SCHEMAS = schemas/gschemas.compiled

SRC = extension.js displayLogic.js prefs.js metadata.json
SCHEMA_DIR = schemas
TESTS = tests/run.js

.PHONY: build install uninstall enable disable zip test lint ci clean

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

test:
	gjs -m tests/run.js

lint: test
	python3 -c "import json; json.load(open('metadata.json')); print('metadata.json: valid')"
	python3 -c "import xml.dom.minidom; xml.dom.minidom.parse('$(SCHEMAS)'); print('schema xml: valid')"

ci: lint

clean:
	rm -f $(COMPILED_SCHEMAS)
	rm -f $(ZIPFILE)
	rm -rf _zipdir
