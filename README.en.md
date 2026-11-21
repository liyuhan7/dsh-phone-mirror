# dsh-phone-mirror

English | [中文](README.md)

[![CI](https://github.com/liyuhan7/dsh-phone-mirror/actions/workflows/ci.yml/badge.svg)](https://github.com/liyuhan7/dsh-phone-mirror/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

While your agent works, your phone lives in the sidebar: watch a video, reply to messages, check notifications without leaving the desktop. Video and audio stream live, and the mouse and keyboard drive the device.

Two independent device paths:

- **Android**: scrcpy 5.0.1 (H.264 + Opus) plus browser-side WebCodecs, with automatic `adb screencap` polling when scrcpy cannot start.
- **iPhone / iPad (iOS 27+)**: CoreDevice `DisplayService` (HEVC `hvcC` + AAC-ELD 48 kHz stereo) plus tunnel HID remote control — no jailbreak and no app installed on the phone.

![Page example](docs/example.png)

## Features

- **A tab in the right sidebar**: add the "手机" tab from the sidebar's "+" and the screen appears, scaled to fit; collapsing the sidebar or switching to another tab pauses audio/video delivery but keeps the device session, and returning resumes from a live keyframe; switching DSH conversations follows the phone tab when the sidebar is open and shares the same connection; closing the last phone tab disconnects and releases the device-side session.
- **Mouse and keyboard control**: clicks, drags and wheel scrolling go over the device protocol; the keyboard is forwarded key by key like an external one — on iOS the pinyin is composed by the phone's own input method and picked with digits, space or enter, while on Android Chinese text is injected through the clipboard.
- **Audio forwarding**: Opus 48 kHz stereo on Android and AAC-ELD 48 kHz stereo on iOS, played through an AudioWorklet ring buffer; devices or hosts without the codec fall back to a silent session.
- **Decoding on a worker thread**: the stream, video decoding, drawing and audio decoding all run in a Worker, so DSH spending the main thread on chat rendering or file writes does not stall the panel; without a Worker it falls back to the main thread.
- **Android fallback**: when scrcpy cannot start, the plugin polls `adb screencap` instead, which is slow but works on almost any device adb can reach.
- **From cable to Wi-Fi**: the panel's "转无线" moves the connection onto the LAN; Android switches USB debugging to TCP and connects automatically, iOS pairs for wireless and remembers the phone's address so you only unplug and press Connect.

## Requirements

| Item | Notes |
| --- | --- |
| DSH | `>= 0.2.0-rc.1 < 0.3.0` |
| Node.js | 20+, only for the first tool download and for building |
| Host OS | Windows is the primary tested platform; macOS / Linux download their own platform-tools, and iOS also needs a working usbmuxd |
| Android device | Developer options → USB debugging enabled and authorized; audio forwarding needs Android 11+ |
| iPhone / iPad | **iOS 27+**, Apple Devices or iTunes installed on Windows, Developer Mode enabled; the iOS runtime ships with the plugin, so no Python install is needed |

Per-brand USB debugging instructions: [docs/debugging.md](docs/debugging.md) (Chinese).

## Install

```bash
# npm package, prebuilt install
dsh plugin --profile <profile> add dsh-phone-mirror
# or straight from the repository
dsh plugin --profile <profile> add "github:liyuhan7/dsh-phone-mirror"
```

Dependencies are prepared on first use:

- **Android**: `platform-tools` (about 8 MB) is downloaded into the plugin directory; run `npm run fetch:tools` to do it by hand, or point `adbPath` at an existing adb.
- **iOS**: the Windows x64 iOS runtime (portable Python plus `pymobiledevice3` and `PyAV`, about 100 MB compressed) is installed through an npm optional dependency. When that package is missing or skipped, the first connection downloads it from the Release into `~/.dsh/phone-mirror-ios-runtime/`; only when both fail does the plugin fall back to a local Python 3.11+ install.

## Connecting a device

### Android

1. Enable USB debugging under Developer options, plug in the cable, and accept "Allow USB debugging" with "Always allow" checked
2. Restart DSH and add the "手机" tab from the right sidebar's "+"
3. Pick "安卓" as the platform, select the device and press "连接"
4. To drop the cable, press "转无线": the plugin reads the device's WLAN address, runs `adb tcpip 5555` and connects automatically

On native Android 11+ you can also use "配对" with the pairing address and 6-digit code shown on the wireless debugging page; the plugin then finds the connect port over mDNS.

### iPhone / iPad

1. Turn on "设置 → 隐私与安全性 → 开发者模式", then reboot and confirm
2. Connect the cable, unlock the phone, and trust the computer with the passcode
3. Add the "手机" tab, switch the platform to "iOS", select `iPhone` and press "连接"; the first connection prepares the Python dependencies and mounts the Developer Disk Image, so keep the phone unlocked
4. For wireless: keep the USB cable connected and press "转无线". Wait for the wireless address to be verified before unplugging, then select `iPhone (Wi-Fi)` and press "连接". You can also press "手填地址" and dial the phone's current IPv4 directly; a device that was never paired shows a Trust prompt on the phone and pairs itself once confirmed. With a personal hotspot, just join the hotspot from the computer — the plugin learns the hotspot address on its own.

Prerequisites, keyboard input, toolbar actions and troubleshooting are documented in [docs/ios.md](docs/ios.md) (Chinese).

**Expected result**: the panel shows the device screen and the caption reads `device · resolution · live fps`, for example `BKY-W10 · 1048×1600 · 30fps`.

## Using the panel

### Picture and touch

Click, long-press and drag operate the device, and the wheel scrolls it. If the picture is corrupted or black, press "重建画面": the decoder is dropped and the stream re-attached so the device sends a fresh keyframe. "全屏" fills the window; press "退出全屏" to leave it.

### Keyboard and input method

- **Android**: click the picture to capture the keyboard; Esc releases focus. A composed input-method result is pasted into the device's focused field through the clipboard, while ASCII characters are injected key by key.
- **iOS**: click the picture to capture the keyboard, then just type. Set the computer input method to English and type pinyin — the phone's own input method composes it, the candidate bar stays on the phone, and digits, space or enter pick a candidate. Esc is forwarded to the phone, Ctrl+Space switches the phone's language, and rotating the phone hands the on-screen keyboard back.

### Toolbar

- Android: 返回, Home, 任务, 音量-, 音量+, 电源, 旋转, 通知, 全屏
- iOS: Home, 任务, 音量-, 音量+, 电源, 旋转, 通知, 控制, 全屏

Button semantics and the iOS pull-down gestures are described in [docs/ios.md](docs/ios.md).

### Audio and quality

The speaker button controls whether the sidebar plays device audio; it is disabled when the device or the host cannot provide audio. The quality presets (流畅 720 / 标准 1080 / 高清 1600) apply to Android only — iOS streams at the device's native resolution — and changing a preset reconnects the session.

### Wireless

- **Android**: "转无线" switches USB debugging to TCP and connects; "配对" handles wireless debugging; "断开连接" drops only the wireless link and leaves USB and any live session alone.
- **iOS**: "转无线" pairs over USB and remembers the phone's address; after unplugging, connect to `iPhone (Wi-Fi)`, and a dropped link reopens automatically within 90 seconds. "断开连接" stops the wireless mirroring and removes the entry from the list while keeping the pairing.

## Configuration

Override in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-phone-mirror
  config:
    maxSize: 1600
    maxFps: 60
    videoBitRate: 8000000
```

| Field | Default | Description |
| --- | --- | --- |
| `mode` | `auto` | `auto` tries scrcpy first (retrying without audio), then falls back to screencap |
| `maxSize` | `1280` | Long-edge pixel cap, overridden by the panel preset; Android only |
| `maxFps` | `60` | Encoder frame rate cap |
| `videoBitRate` | `8000000` | Encoder bit rate in bps |
| `screencapIntervalMs` | `260` | Frame interval in the screencap fallback |
| `audio` | `true` | Forward device audio; unsupported devices start silent next time |
| `adbPath` | empty | Custom adb path, the bundled one when empty |
| `serverJar` | empty | Custom `scrcpy-server.jar` path |
| `iosWirelessHost` | empty | Manual iPhone wireless address (e.g. `10.4.53.159`), which overrides the address learned over USB. Leave empty to use the learned address. |

## FAQ

**`adb devices` is empty although the phone says it is connected**

Windows bound the USB interface to a vendor driver (Huawei HDB, for instance). In Device Manager, update that interface to "Android ADB Interface", or install Google USB Driver and point it there.

**`dsh plugin` refuses to touch the desktop profile**

The desktop profile is owned by the Electron app. Edit that profile's `package.json` directly: add `"dsh-phone-mirror": "link:D:/path/to/dsh-phone-mirror"` to `dependencies`, add the plugin name to `dsh.profile.bundles`, then run `pnpm install`.

**No sound**

Check the speaker button first. On Android, grey means the session never got audio — see `session.audio` and `session.audioCodec` at `/dsh-phone-mirror/api/status`; on iOS it means the host lacks an AAC-ELD decoder. If the button is enabled but you hear nothing, check the computer volume, the device volume, and whether the playing app forbids capture.

**iPhone wireless connect fails with "no RemotePairing broadcast"**

Campus and enterprise APs often block multicast between clients, and iOS wireless discovery — plus the Apple Devices Network path — is mDNS, so both go deaf. The plugin learns the phone's Wi-Fi address from its own outbound traffic while it is connected over USB, falling back to an mDNS match against the pairing record when nothing is captured; wireless connections dial the learned address directly. When the phone’s IP changes, set `iosWirelessHost` to override the old address, or leave it empty and connect over USB once to refresh the learned address. See [docs/ios.md](docs/ios.md) for more.

**Black picture, or a single-digit frame rate**

On Android, DRM content (paid video apps) goes through `MediaCodec`'s secure path and can only render black; when the device screen is static, scrcpy produces no frames, so a single-digit rate is expected.

## Documentation

- [docs/ios.md](docs/ios.md): connecting and using an iPhone / iPad, toolbar, troubleshooting (Chinese)
- [docs/debugging.md](docs/debugging.md): enabling USB debugging on Android brands (Chinese)
- [THIRD-PARTY.md](THIRD-PARTY.md): third-party components and licenses (Chinese)

## License

MIT, see [LICENSE](./LICENSE); third-party components in [THIRD-PARTY.md](./THIRD-PARTY.md).
