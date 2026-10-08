# Publishing PCTV Home

## 1. Push to GitHub

```bash
git remote add origin https://github.com/fragmentedbin/pctv-home.git
git push -u origin main
```

## 2. Make a release

1. Update `version` in `package.json` (e.g. `1.0.1`), then commit.
2. Tag and push:
   ```bash
   git tag v1.0.1
   git push origin v1.0.1
   ```
3. GitHub Actions builds the Windows installers (x64 + arm64) and the macOS DMGs (Apple Silicon + Intel), then creates a **draft release** with all files attached.
4. Open *Releases* on GitHub, check the draft, and click **Publish**.

### How installed copies update themselves

The Windows installer (not the Store build) checks GitHub Releases 45 seconds after it starts and every 6 hours, using `latest.yml` and the `.blockmap` files that the **windows** job uploads next to the `.exe` files (the app downloads only the changed parts). When a newer version is **published** it downloads quietly in the background, then offers **Restart to update** on the TV, on the phone remote (⏻ menu) and in the tray menu. It never restarts by itself; if nobody taps, it installs the next time the app is quit.

- A **draft** release is invisible to the updater: remember to click **Publish**.
- Releases marked *pre-release* are ignored.
- The installer installs for all users (that is what adds the firewall rule), so Windows shows an administrator prompt (UAC) when the update is applied. That prompt can't be clicked from the phone remote, so a PC used as a TV needs a mouse or keyboard nearby for it.
- macOS copies can't replace themselves while the app is only ad-hoc signed. They just show "New version available" and open the download page.
- Microsoft Store copies update through the Store.

## 3. Microsoft Store (free, and works with Smart App Control)

Store apps are signed by Microsoft, so Windows trusts them even with Smart App Control on. Registering as an individual developer is free.

1. Sign up at <https://storedeveloper.microsoft.com> as an **individual** developer.
2. In [Partner Center](https://partner.microsoft.com/dashboard), go to **Apps and games → New product → MSIX or PWA app** and reserve the name **PCTV Home**.
3. Open **Product management → Product identity** and copy:
   - `Package/Identity/Name` → GitHub repository variable **`STORE_IDENTITY_NAME`**
   - `Package/Identity/Publisher` (starts with `CN=`) → repository variable **`STORE_PUBLISHER`**

   Set them under *Settings → Secrets and variables → Actions → Variables*.
4. Run the **Build** workflow manually with **"Also build the Microsoft Store package"** ticked, or push a `v*` tag once the variables exist. Download the `.appx` file from the workflow artifacts.
5. In Partner Center, create a submission:
   - **Packages:** upload the `.appx`.
   - **Properties:** category *Entertainment*; privacy policy URL `https://github.com/fragmentedbin/pctv-home/blob/main/PRIVACY.md`.
   - **Store listing:** use `docs/images/*.jpg` as screenshots, and copy the description from the README.
   - **Submission options → restricted capabilities:** explain `runFullTrust`: *"Desktop app (Electron). It runs a local web server for the phone remote, sends keyboard and mouse input to control the TV screen, and starts Chrome/Edge to play streaming services."*
6. Submit. Certification usually takes 1–3 days.

To build it locally instead: `npm run dist:store -- -c.appx.identityName=… -c.appx.publisher="CN=…"`.

## 4. macOS signing (optional, paid)

Without an Apple Developer ID, the DMG is ad-hoc signed and users have to click **Open Anyway** once. If you join the Apple Developer Program later, add these repository **secrets** and the workflow will sign and notarize automatically:

| Secret | Value |
|---|---|
| `MAC_CERT_P12_BASE64` | Developer ID Application certificate (.p12), base64-encoded |
| `MAC_CERT_PASSWORD` | Password of that .p12 |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | Your 10-character Team ID |

## 5. Windows installer signing (optional)

The `.exe` from GitHub Releases is unsigned. SmartScreen warns about it, and Smart App Control blocks it, which is why the Store version is the recommended download. If you get a code-signing certificate later, add a signing step to the `windows` job in `.github/workflows/build.yml` (electron-builder reads `CSC_LINK` / `CSC_KEY_PASSWORD` for a .pfx certificate).

## 6. Supporter unlock codes ("pay what you want")

Copies that aren't unlocked show a small click-through note on the TV after a grace period (7 days or 15 launches) and, at most every 3 days, a support prompt on the phone remote. A signed unlock code removes both for good. Codes are checked offline, so there's no server to run.

**One-time setup**

```bash
node scripts/gen-keys.js --write
```

This writes `keys/private.pem` (git-ignored) and puts the public key in `src/server/lib/supporter/config.js`. Commit `config.js`, **never** the `keys/` folder. Back up `private.pem` somewhere safe: without it you can't make codes for this public key. While `PUBLIC_KEY_PEM` is `null`, all supporter features are off.

Also set `SUPPORT_URL` in the same file to your payment page. The phone opens it with `?did=<device id>` added.

**Issuing a code** (after someone pays and sends you their device ID from the phone remote's ⏻ menu):

```bash
node scripts/issue-code.js --did 7F3A-91C2-0B4D-E6A8-55D1 --id ORDER-123 --amt 25000
```

Send them the printed code; they paste it on the phone in ⏻ → Support PCTV Home.

**Testing:** `PCTV_FORCE_WATERMARK=1` shows the TV note right away, `PCTV_FORCE_NAG=1` shows the phone prompt on every connection, and `PCTV_WATERMARK_MOVE_MS=20000` moves the note every 20 s.

## Regenerating icons

Edit `assets/brand/logo.svg` (app icon) or `assets/brand/glyph.svg` (menu bar icon), then run:

```bash
pip install playwright pillow && playwright install chromium
python3 scripts/make-icons.py
```
