# dsh-phone-mirror

把安卓手机或平板投到 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）右侧栏，并用鼠标键盘直接反控。

画面链路是 scrcpy 的内核：手机端用 `scrcpy-server` 硬件编码 H.264，**不需要 root、不需要在手机上装 App**；
浏览器端用 WebCodecs 解码到 canvas。典型 60fps、延迟在几十毫秒量级，能正常刷列表、看视频、点按钮。

```
┌─ DSH 右侧栏 ─────────────────┐         ┌─ 手机 ─────────────┐
│ WebCodecs 解码 → canvas       │ ←H.264─ │ scrcpy-server      │
│ 鼠标/键盘 → scrcpy 控制包      │ ─touch→ │ (注入触控/按键)     │
└──────────┬───────────────────┘         └────────────────────┘
           │ 宿主插件：adb、推 jar、反向隧道、帧中继
```

## 功能

- 侧栏「手机」页签，画面即点即控，可全屏
- 鼠标点按 / 拖拽 / 滚轮，键盘输入，返回 / Home / 任务 / 电源 / 旋转 / 通知栏
- 画质档位：流畅（长边 720）/ 标准（1080）/ 高清（1600）
- 设备选择、无线调试地址直连
- scrcpy 起不来时自动降级到 `adb screencap` 截图模式（帧率低，但几乎任何设备都能出画面）
- 音频可选（默认关，见下方限制）

## 环境要求

- Windows（当前只在 Windows 上验证；`adb` 与路径处理是跨平台的）
- DSH `>= 0.2.0-rc.1`
- 安卓 5.0+，或 HarmonyOS 4.x（**HarmonyOS NEXT / 5.x 没有 adb，不可用**）
- 手机/平板已开启「开发者选项 → USB 调试」，并允许过电脑的调试授权

## 安装

```bash
# 1. 拉取插件（任选其一）
dsh plugin --profile <你的 profile> add "link:/path/to/dsh-phone-mirror"
dsh plugin --profile <你的 profile> add "github:<you>/dsh-phone-mirror"

# 2. 首次使用需要下载 adb 与 scrcpy-server（约 9MB）
cd <插件目录>
npm run fetch:tools
```

`tools/platform-tools/` 是下载产物，不进仓库；已有系统 adb 时可在配置里指定 `adbPath` 跳过下载。

安装后重启 DSH，右侧栏点「+」添加「手机」页签。

## 使用

1. 插上数据线，手机弹出「允许 USB 调试吗？」时勾选「始终允许」
2. 面板里选中设备，点「连接」
3. 鼠标直接操作；标题行会显示当前分辨率和帧率

无线调试：先在手机「开发人员选项 → 无线调试」里配对，然后在下方的输入框填 `192.168.x.x:端口` 点连接。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: dsh-phone-mirror
  config:
    audio: false          # 音频转发，默认关
    maxSize: 1600         # 画面长边像素；越小越流畅
    maxFps: 60
    videoBitRate: 8000000 # 8 Mbps
    mode: auto            # auto | scrcpy | screencap
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `auto` | `auto` 先试 scrcpy（失败重试一次），仍失败才降级截图 |
| `maxSize` | `1280` | 长边像素上限，可被面板的画质档位覆盖 |
| `maxFps` | `60` | 编码帧率上限 |
| `videoBitRate` | `8000000` | 编码码率（bps） |
| `audio` | `false` | 是否转发设备音频 |
| `screencapIntervalMs` | `260` | 降级模式的截图间隔 |
| `adbPath` | 空 | 自定义 adb 路径，留空用插件自带的 |
| `serverJar` | 空 | 自定义 scrcpy-server.jar 路径 |

## 已知限制

- **音频**：需要 Android 11+，且很多 App 会声明自己不可被捕获（鸿蒙上基本拿不到）。音频只走 `audio:true`，默认关闭。
- **DRM 内容**：付费视频类 App 通常输出黑屏，这是 `MediaCodec` 的安全视频通路，不是插件问题。
- **无线调试**：部分华为/荣耀机型没有「无线调试」入口，只能用 USB。
- **仅本机同源**：宿主的 HTTP 接口只接受 `127.0.0.1` 同源请求，不做公网暴露。

## 排障

**电脑完全不认设备**（`adb devices` 为空，但手机显示「USB 调试已连接」）
多为 Windows 把接口绑到了厂商驱动（华为 HDB 的接口 GUID 与 adb 不同）。可在设备管理器里把该 WinUSB 接口手动更新为「Android ADB Interface」，或安装 Google USB Driver 后指定安装。

**会话降级成截图模式**
`/dsh-phone-mirror/api/status` 的 `session.mode` 会显示 `screencap`，`session.lastError` 带失败原因。常见原因是 `/data/local/tmp` 里的 jar 被清理（插件每次启动都会重推，一般自愈）或上一个会话的编码器尚未释放（auto 模式会自动重试）。

**画面卡**
先降画质档位；仍卡就看标题行帧率是否明显低于 60。宿主侧 `counters` 能区分「设备没出帧」和「没送到浏览器」。

## 目录结构

```
lib/index.js        宿主插件：路由、会话生命周期、帧中继
lib/session.js      scrcpy 会话（H.264/控制 socket）与截图兜底会话
lib/protocol.js     scrcpy 控制协议序列化
lib/adb.js          adb 封装
lib/client.js       浏览器端面板源码
lib/client.bundle.js 由 npm run build 生成，勿手改
scripts/            构建与工具下载
tools/              scrcpy-server.jar（platform-tools 为下载产物）
```

## 开发

```bash
npm run build        # 重新生成 client.bundle.js
npm run check        # 语法检查 + 校验 bundle 是否过期
```

## 许可

插件代码 MIT。`tools/scrcpy-server.jar` 来自 [Genymobile/scrcpy](https://github.com/Genymobile/scrcpy)（Apache-2.0），
`platform-tools` 由脚本从 Google 官方地址下载，仓库不分发。详见 [THIRD-PARTY.md](./THIRD-PARTY.md)。
