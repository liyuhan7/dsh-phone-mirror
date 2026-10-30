# 第三方组件

本仓库的 MIT 许可只覆盖插件自身代码（`lib/`、`scripts/`）。以下第三方组件各自遵循其原始许可。

## scrcpy-server.jar

- 来源：[Genymobile/scrcpy](https://github.com/Genymobile/scrcpy) 的 release 产物 `scrcpy-server-<version>`
- 许可：Apache License 2.0
- 用途：在设备上执行，负责屏幕采集、H.264 编码与控制事件注入
- 本仓库随 `tools/scrcpy-server.jar` 分发该二进制文件，未做任何修改
- 许可全文：<https://www.apache.org/licenses/LICENSE-2.0>

未包含该二进制也可使用：把 `serverJar` 配置项指向任意同版本的 `scrcpy-server` 文件，或把 `tools/scrcpy-server.jar`
替换为你自己下载的版本。注意服务端版本必须与 `lib/session.js` 中的 `SCRCPY_VERSION` 一致，否则服务端会拒绝启动。

## Android SDK Platform-Tools（`adb`）

- 来源：Google 官方发布地址，由 `scripts/fetch-tools.mjs` 在安装时下载
- 许可：Android SDK License（Google）
- 仓库**不**分发该目录，`tools/platform-tools/` 已在 `.gitignore` 中排除

## 控制协议

`lib/protocol.js` 的字节布局与 `lib/session.js` 的 socket 协议实现参考 scrcpy 的公开协议文档与源码，
属于对协议规范的独立实现，未复制其 C 源码。
