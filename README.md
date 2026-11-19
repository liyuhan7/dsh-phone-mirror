# dsh-phone-mirror

[English](README.en.md) | 中文

[![CI](https://github.com/liyuhan7/dsh-phone-mirror/actions/workflows/ci.yml/badge.svg)](https://github.com/liyuhan7/dsh-phone-mirror/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

用 agent 干活的时候，手机就在侧边栏：刷视频、回消息、看通知都不用离开电脑，省掉反复拿起放下的步骤。画面与声音实时转发，鼠标键盘直接操作设备。

两条独立的设备路径：

- **安卓**：scrcpy 5.0.1（H.264 + Opus）加浏览器端 WebCodecs；scrcpy 起不来时自动降级为 `adb screencap` 周期截图。
- **iPhone / iPad（iOS 27+）**：CoreDevice `DisplayService`（HEVC `hvcC` + AAC-ELD 48 kHz 立体声）加隧道 HID 反控，无需越狱，无需在手机端安装 App。

![页面示例](docs/example.png)

## 功能

- **页签常驻右侧栏**：在「+」里添加「手机」页签即可投屏，画面按 contain 比例铺满；收起侧栏或切到别的页签时暂停音视频传输但保留设备连接，切回来从实时关键帧继续；切换 DSH 会话时侧栏展开则手机页签跟随并共用同一条连接；关闭最后一个手机页签才断开连接并释放设备端会话。
- **鼠标键盘反控**：点按、拖拽、滚轮按设备协议回传；键盘按外接键盘逐键转发，iOS 上拼音由手机的输入法组字、数字/空格/回车选字，安卓上中文以剪贴板粘贴注入。
- **声音一起转发**：安卓走 Opus 48 kHz 立体声，iOS 走 AAC-ELD 48 kHz 立体声，经 AudioWorklet 环形缓冲播放；设备或本机不支持时降级为无声会话。
- **解码在 Worker 线程**：拉流、视频解码、绘制与音频解码都在 Worker 内完成，DSH 主线程渲染对话或写文件时面板不跟着卡；拿不到 Worker 时退回主线程。
- **安卓自动降级**：scrcpy 失败后用 `adb screencap` 截图，帧率低但几乎任何能 adb 的设备都能出画面。
- **一根线到无线**：面板底部的「转无线」把连接切到局域网；安卓切 USB 调试到 TCP 并自动连上，iOS 完成无线配对并记住手机地址，拔线后再点「连接」。

## 环境要求

| 项目 | 说明 |
| --- | --- |
| DSH | `>= 0.2.0-rc.1 < 0.3.0` |
| Node.js | 20+，仅首次下载工具与构建时使用 |
| 电脑系统 | Windows 为主要验证平台；macOS / Linux 会下载对应平台的 platform-tools，iOS 还需本机 usbmuxd 可用 |
| 安卓设备 | 开发者选项 → USB 调试已开启并授权；转发声音需要 Android 11+ |
| iPhone / iPad | **iOS 27+**，Windows 已安装 Apple Devices 或 iTunes，手机已开启开发者模式；iOS 运行时随插件提供，无需安装 Python |

各品牌安卓机开启 USB 调试的入口和额外开关见 [docs/debugging.md](docs/debugging.md)。

## 安装

```bash
# npm 包，预构建安装
dsh plugin --profile <profile> add dsh-phone-mirror
# 或从仓库安装
dsh plugin --profile <profile> add "github:liyuhan7/dsh-phone-mirror"
```

首次运行按需自动准备依赖：

- **安卓**：下载 `platform-tools`（约 8 MB）到插件目录，也可手动执行 `npm run fetch:tools`；系统里已有 adb 时在配置里指定 `adbPath` 跳过下载。
- **iOS**：Windows x64 的 iOS 运行时（可移植 Python + `pymobiledevice3` + `PyAV`，压缩后约 100 MB）通过 npm 可选依赖安装。平台包缺失或被跳过时，首次连接会自动从 Release 下载到 `~/.dsh/phone-mirror-ios-runtime/`；两条路都不可用才回退到本机 Python 3.11+ 现场安装。

## 连接设备

### 安卓

1. 打开开发者选项里的 USB 调试，插上数据线，设备弹出「允许 USB 调试吗？」时勾选「始终允许」
2. 重启 DSH，右侧栏点「+」添加「手机」页签
3. 顶部平台选「安卓」，下拉选中设备，点「连接」
4. 想摆脱数据线：点面板底部「转无线」，插件读出设备 WLAN 地址、执行 `adb tcpip 5555` 并自动连上，之后可以拔线

原生 Android 11+ 也可以用「配对」走无线调试：填无线调试页上的配对地址与 6 位配对码，配对成功后插件通过 mDNS 找连接端口并自动连上。

### iPhone / iPad

1. 打开手机「设置 → 隐私与安全性 → 开发者模式」，按提示重启确认
2. 用数据线连接电脑并解锁手机，弹窗点「信任」并输入锁屏密码
3. 右侧栏点「+」添加「手机」页签，顶部平台切到「iOS」，选中 `iPhone` 点「连接」
4. 无线投屏：保持 USB 连接点「转无线」，等提示无线地址已验证后再拔线，选中 `iPhone (Wi-Fi)` 点「连接」。已配对的设备也可以点「手填地址」，输入手机当前的 IPv4 地址试连。

连接前提、键盘输入、工具栏按钮与故障排查见 [docs/ios.md](docs/ios.md)。

**预期输出**：面板出现设备画面，标题行显示 `设备名 · 分辨率 · 实时帧率`，例如 `BKY-W10 · 1048×1600 · 30fps`。

## 使用面板

### 画面与触控

点按、长按、拖拽直接操作设备，滚轮对应设备滚动。画面发黑或发花时点「重建画面」：丢弃解码器并重新拉流，由设备重发关键帧。点「全屏」铺满窗口，全屏时点「退出全屏」返回。

### 键盘与输入法

- **安卓**：点画面接管键盘，Esc 交还焦点。电脑输入法组字完成后，文本通过剪贴板粘贴到手机当前输入框；英文数字逐键注入。
- **iOS**：点画面接管键盘，之后逐键转发给手机。把电脑输入法切到英文，直接敲拼音由手机的输入法组字，候选条显示在手机上，用数字、空格或回车选字；Esc 转发给手机，Ctrl+空格 切换中英；改变手机朝向即交还手机软键盘。

### 工具栏

- 安卓：返回、Home、任务、音量-、音量+、电源、旋转、通知、全屏
- iOS：Home、任务、音量-、音量+、电源、旋转、通知、控制、全屏

按钮语义与 iOS 的下拉手势见 [docs/ios.md](docs/ios.md)。

### 声音与画质

喇叭按钮控制侧栏是否播放设备声音，设备不支持或本机缺少解码器时按钮置灰。画质档位（流畅 720 / 标准 1080 / 高清 1600）只对安卓生效，iOS 按设备原生分辨率出流；切换档位会重连会话。

### 无线连接

- **安卓**：「转无线」把 USB 调试切到 TCP 并自动连上；「配对」用于无线调试；「断开连接」只断开无线通道，不影响 USB 与已建立的会话。
- **iOS**：「转无线」在 USB 连接下完成配对并记住手机地址；拔线后选中 `iPhone (Wi-Fi)` 连接，掉线会在 90 秒内自动重开；「断开连接」停止无线投屏并把该设备移出列表，配对保留。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: dsh-phone-mirror
  config:
    maxSize: 1600
    maxFps: 60
    videoBitRate: 8000000
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `auto` | `auto` 先试 scrcpy（音频失败后改无声再试），仍失败才降级截图 |
| `maxSize` | `1280` | 长边像素上限，可被面板的画质档位覆盖，只对安卓生效 |
| `maxFps` | `60` | 编码帧率上限 |
| `videoBitRate` | `8000000` | 编码码率（bps） |
| `screencapIntervalMs` | `260` | 降级模式的截图间隔 |
| `audio` | `true` | 转发设备声音；设备不支持时下次直接无声开场 |
| `adbPath` | 空 | 自定义 adb 路径，留空用插件自带的 |
| `serverJar` | 空 | 自定义 `scrcpy-server.jar` 路径 |
| `iosWirelessHost` | 空 | 手动指定 iPhone 无线地址（如 `10.4.53.159`），优先于 USB 连接时自动学到的地址；留空则使用自动学习的地址 |

## 常见问题

**`adb devices` 为空，但手机显示已连接**

Windows 把该 USB 接口绑到了厂商驱动（例如华为 HDB）。在设备管理器里手动更新为「Android ADB Interface」，或安装 Google USB Driver 后指定。

**`dsh plugin` 拒绝操作 desktop profile**

desktop profile 由 Electron 应用独占托管。直接编辑该 profile 的 `package.json`，在 `dependencies` 里加 `"dsh-phone-mirror": "link:D:/path/to/dsh-phone-mirror"`，并把插件名加进 `dsh.profile.bundles`，然后执行 `pnpm install`。

**没有声音**

安卓先看喇叭按钮：灰色说明这个会话没拿到音频，查 `/dsh-phone-mirror/api/status` 里的 `session.audio` 与 `session.audioCodec`。iOS 的喇叭按钮置灰表示本机缺少 AAC-ELD 解码器。按钮可用却听不到，检查电脑音量、设备是否静音，以及正在播的 App 是否禁止被捕获。

**iPhone 无线连不上，提示没有收到 RemotePairing 广播**

校园网/企业 AP 常屏蔽客户端之间的组播，而 iOS 的无线发现（以及 Apple Devices 的 Network 发现）都靠 mDNS。插件在 USB 连接期间自动抓包学习手机当前的 Wi-Fi 地址并用 TCP 验证，之后无线连接按学到的地址直连。手机 IP 变化后，可手填 `iosWirelessHost` 覆盖旧地址；也可留空，插回 USB 连一次以刷新自动学习的地址。更多排查见 [docs/ios.md](docs/ios.md)。

**画面发黑，或帧率只有个位数**

安卓上付费视频等 DRM 内容走 `MediaCodec` 的安全通路，只能出黑屏；设备静止时 scrcpy 不产生帧，帧率显示个位数属正常。

## 文档

- [docs/ios.md](docs/ios.md)：iPhone / iPad 的连接、键盘输入、工具栏与故障排查
- [docs/debugging.md](docs/debugging.md)：各品牌安卓机开启 USB 调试
- [THIRD-PARTY.md](THIRD-PARTY.md)：第三方组件与许可

## 许可证

MIT，见 [LICENSE](./LICENSE)；第三方组件见 [THIRD-PARTY.md](./THIRD-PARTY.md)。
