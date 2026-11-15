# Development and installation

## Source changes

- Edit renderer code in `src/renderer/`, then run `npm run build:renderer`.
  `meter-renderer.js` is the generated bundle; include it with renderer changes.
- Run `npm test` after source changes. Tests use temporary directories for settings and usage data.
- Keep local transcripts, installation manifests, backups and capture output outside the repository.
- The runtime uses Node.js built-ins and the bundled ASAR engine. No `npm install` is needed.

## Installation

Use Node.js 22.4 or later. Python is optional for attachment analysis.
Run installation commands only when installation or updating the local client is requested.

```sh
node cli.js check
node cli.js install
node cli.js status
```

Pass `--path "<path-to-app.asar>"` for a custom installation.
The installer records backup paths and checksums in the local state directory.
Check `asarPatched` and `liveWindow.active` in the status output separately:
a disk patch does not by itself confirm that the running window loaded it.

Keep Antigravity running when using CDP hot injection. Do not terminate the host
from an agent session inside Antigravity. If the archive is locked, report the
write failure and let the user close the client before retrying.

Other commands:

- `node cli.js live`: inject into the running window without patching the archive.
- `node cli.js watch`: run a zero-patch background watcher that auto-attaches to Antigravity windows via CDP and exits when the client closes (`node cli.js stop-watch` stops an active watcher).
- `node cli.js restore`: restore the recorded backup.

## UI translation

Translate visible text in `src/renderer/template.html` and the renderer JavaScript
modules. Keep DOM IDs, selectors, event handlers and data structures intact.
Build the renderer and run tests before installing the translated version.
