# Gamescan Desktop Client

Scans Rocket League and Fortnite replay files, parses kills/damage/goals/etc, and syncs them to your Gamescan dashboard every 60 seconds.

## Build installer (one click)

Double-click **`build.bat`** — it will:
1. Check Node.js is installed
2. Run `npm install`
3. Bundle all JS into `bundled/` (single files)
4. Package the NSIS installer via electron-builder
5. Open the `dist/` folder when done

## Setup (dev)

```bash
cd gamescan-client
npm install
npm start        # bundles then launches
```

## Manual build

```bash
npm run build:win
```
Produces `dist/Gamescan-Setup-1.0.0.exe` — NSIS installer with custom branding.

## Auto-update setup

1. Create a GitHub repo called `gamescan-client`
2. In `package.json`, set `build.publish.owner` to your GitHub username
3. Push a release tagged `v1.0.1` — the app will detect it on next launch and show the update banner

## WordPress endpoint

The app POSTs to `/wp-json/gamescan/v1/match`. Add this to `gamescan-functions.php`:

```php
add_action('rest_api_init', function() {
    register_rest_route('gamescan/v1', '/match', [
        'methods'             => 'POST',
        'callback'            => 'gamescan_receive_match',
        'permission_callback' => function() {
            return current_user_can('read');
        },
    ]);
    register_rest_route('gamescan/v1', '/ping', [
        'methods'             => 'GET',
        'callback'            => fn() => new WP_REST_Response(['ok' => true]),
        'permission_callback' => function() { return current_user_can('read'); },
    ]);
});

function gamescan_receive_match(WP_REST_Request $req) {
    $uid  = get_current_user_id();
    $data = $req->get_json_params();

    // Append to match log
    $log = get_user_meta($uid, 'gamescan_match_log', true) ?: [];
    $log[] = array_merge($data, ['received_at' => current_time('mysql')]);
    update_user_meta($uid, 'gamescan_match_log', $log);

    return new WP_REST_Response(['saved' => true], 200);
}
```

## Assets required

Place these in `gamescan-client/assets/`:
- `icon.ico` — app icon (256×256)
- `tray.ico` — tray icon (16×16 or 32×32)
- `license.txt` — installer licence text
- `installer-sidebar.bmp` — 164×314px sidebar image for NSIS installer

## File structure

```
src/                        ← edit these
  main.js                   — Electron main process, tray, IPC, auto-updater
  preload.js                — Secure IPC bridge
  api.js                    — WordPress REST API client
  scanner/
    scanner.js              — File watcher + 60s interval scheduler
    rl-parser.js            — Rocket League .replay binary parser
    fn-parser.js            — Fortnite .replay binary parser
  renderer/
    index.html              — App UI
    app.js                  — Renderer logic

scripts/
  bundle.js                 — esbuild bundler (src/ → bundled/)

bundled/                    ← auto-generated, do not edit
  main.js                   — all main-process code in one file
  preload.js
  renderer/
    index.html              — index.html with app.js inlined

build.bat                   — one-click build tool (Windows)
```
