# Aside iOS app

Native SwiftUI app that connects an iPhone (and optionally Meta Ray-Ban Smart Glasses) to a VisionClaude Gateway server, so you can talk to Claude with vision context. The user-facing brand is **Aside**; the project / bundle id (`com.claudevision.app`) keep the original name because the Meta DAT SDK registration is tied to it.

## Prerequisites

- macOS with **Xcode 15+** (free from the Mac App Store).
- A physical **iPhone running iOS 17+** — Simulator has no camera, mic, or Bluetooth, so this app cannot run there.
- **XcodeGen** to (re)generate the Xcode project from `project.yml`:
  ```
  brew install xcodegen
  ```
- An Apple ID. **Free works for personal sideload**; the paid Apple Developer Program ($99/year) is only needed for TestFlight or App Store distribution.
- A running VisionClaude Gateway you can reach from the phone (LAN IP, or HTTPS via Plesk like `https://ai.datafeed.cloud`). Configure host/port/token in the in-app Settings tab.
- For Meta Ray-Ban support: the **Meta AI app** installed on the iPhone with your glasses already paired and registered.

## Quick install (free Apple ID sideload)

1. Plug the iPhone into the Mac with a USB-C cable, unlock the phone, tap **Trust** if prompted.
2. From this directory:
   ```
   xcodegen generate
   open ClaudeVision.xcodeproj
   ```
3. In Xcode, select the **ClaudeVision** target → **Signing & Capabilities**.
   - Tick **Automatically manage signing**.
   - Set **Team** to your Apple ID's *Personal Team*. (If it doesn't appear, **Xcode → Settings → Accounts** → add your Apple ID first.)
4. Top of the Xcode window: select your physical iPhone as the run destination (not a simulator).
5. Press ⌘R. Xcode will build, install, and launch the app on the phone.
6. First launch: on the iPhone, **Settings → General → VPN & Device Management → [your Apple ID] → Trust** to allow the developer profile. Then re-open the app.
7. In the app's Settings tab, point it at your Gateway (host + port + token).

**Lifespan note (free Apple ID only):** apps installed this way stop working after **7 days**. To refresh, plug back in and ⌘R again — same procedure. With a paid Developer Program account the build is good for **1 year** without refresh.

## Adding the Meta Ray-Ban glasses

After the app is running and the glasses are paired with the Meta AI app:

1. In Aside's Settings → **Ray-Ban Setup**, follow the on-screen steps.
2. Tap **Camera Source → Meta Ray-Ban**.
3. Tap **Connect** — you may be redirected to the Meta AI app to approve; tap Allow.
4. The glasses' camera feed will appear in the preview. Audio (mic + speakers) is handled by iOS Bluetooth routing — select the glasses as the active audio device in Control Centre.

## TestFlight (later, if you want to share with others)

Requires the paid Apple Developer Program. Skipping detailed steps here; the top-level workflow is:

1. Enrol at https://developer.apple.com/programs/.
2. Set `DEVELOPMENT_TEAM` in `project.yml` to your 10-character Team ID, run `xcodegen generate`.
3. Register the app at https://appstoreconnect.apple.com/ → My Apps → +.
4. In Xcode: **Product → Archive** (with "Any iOS Device" as destination).
5. Xcode Organizer → **Distribute App → TestFlight & App Store** → upload.
6. App Store Connect → TestFlight tab → add internal testers.

## Replacing the app icon

The current icon set lives at `ClaudeVision/Assets.xcassets/AppIcon.appiconset/`. Drop in a new 1024×1024 PNG (no transparency, no rounded corners — iOS adds them) and Xcode will generate the smaller sizes automatically. Tools like https://www.appicon.co/ can produce the full set from one source PNG.

## What stays "ClaudeVision" under the hood (and why)

These are internal identifiers and changing them would break the Meta SDK registration and orphan existing settings — leave alone:

- `PRODUCT_BUNDLE_IDENTIFIER` (`com.claudevision.app`) — Meta SDK `MetaAppID` / `ClientToken` in Info.plist are registered against it.
- URL scheme `claudevision://` — used by Meta SDK for `AppLinkURLScheme`.
- Swift struct names (`ClaudeVisionApp`, `ClaudeBridge`, etc.) — code-internal only.
- UserDefaults keys prefixed `VisionClaude_` — renaming would lose previously saved settings.

User-visible branding lives in `Info.plist` → `CFBundleDisplayName` (`Aside`) and the privacy usage strings.
