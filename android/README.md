# RacingAgents Android app

Pixel-side client for the Phase 1 PoC: continuous on-device Japanese speech
recognition, sending only finalized text segments to the Mac server over
Tailscale, plus an "AI解析" button that triggers and polls the server's
`codex exec` analysis.

## Requirements

- Android Studio (Koala or newer) or a JDK 17+/Gradle 8.x command-line
  toolchain.
- A physical Pixel (or any device with Google's on-device Japanese speech
  recognition) running Android 12 (API 31) or newer. The emulator does not
  support on-device `SpeechRecognizer`.

## Gradle wrapper note

This checkout does **not** include `gradle/wrapper/gradle-wrapper.jar` or
`gradle/wrapper/gradle-wrapper.properties` (the properties file could not be
written by the tooling that generated this project). Before using `./gradlew`,
run once from `android/`:

```
gradle wrapper --gradle-version 8.7
```

(with any system-installed Gradle 8.x). This generates both files. The wrapper
distribution settings that were intended are preserved in
`gradle/wrapper/wrapper.properties.tmp` — you can also just rename that file to
`gradle-wrapper.properties` and separately fetch `gradle-wrapper.jar` from a
matching Gradle distribution.

Alternatively, skip the wrapper entirely and build with a system-installed
Gradle 8.x directly:

```
gradle :app:assembleDebug
```

## Build

```
cd android
./gradlew :app:assembleDebug   # after generating the wrapper, see above
# or
gradle :app:assembleDebug
```

Run unit tests (SegmentQueue seq/backoff logic, DTO JSON round-trips):

```
gradle :app:testDebugUnitTest
```

## Permissions to grant on first run

- **Microphone** (`RECORD_AUDIO`) — required for speech recognition; the app
  requests it on launch.
- **Notifications** (`POST_NOTIFICATIONS`, Android 13+) — required so the
  foreground listening service can show its ongoing notification.
- No other runtime permissions are needed. `INTERNET` and the
  `FOREGROUND_SERVICE*` permissions are normal/install-time and granted
  automatically.

## Setting the server URL

1. Set up the Mac server and Tailscale per the top-level plan (`server/`
   README / scripts).
2. Open the app, tap the gear icon (settings sheet), and enter:
   - **サーバーURL**: `http://<mac-magicdns-name>.<tailnet>.ts.net:8787` (a
     100.x IP also works, but then the network security config in
     `app/src/main/res/xml/network_security_config.xml` needs that literal IP
     added — see the comment in that file).
   - **APIキー**: the shared `X-Api-Key` secret configured on the server.
3. Tap Start to begin a session and continuous listening; tap Stop to end.
   Finalized segments are queued and sent to the server automatically (with
   backoff/retry if offline); the status chip shows 送信待ちN件 while segments
   are pending.
4. Tap "AI解析" to request an analysis of the current session; the bottom
   sheet polls the server and shows 要約/解釈/アドバイス/返答案 once done, with
   a copy button and a raw-JSON toggle.

## Known gaps / manual verification needed

- The restart-beep mute (Settings toggle, default off) mutes/unmutes
  `STREAM_NOTIFICATION` around `startListening()`; whether this actually
  suppresses the recognizer's beep is device/OEM-dependent and needs manual
  verification on the target Pixel, per the plan's early-risk list.
- Long-duration (~5+ minutes) continuous recognition, screen-off survival,
  and airplane-mode/offline-queue behavior are not covered by automated tests
  and need manual, on-device verification (see the plan's "検証" section).
- `SpeechRecognizer`/foreground-service behavior cannot be unit tested on the
  JVM; only `SegmentQueue` core logic and DTO serialization have automated
  tests (`app/src/test/`).
