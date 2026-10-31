# 开启 USB 调试

插件靠 adb 连接设备：`adb devices` 里状态是 `device` 才能投屏，`unauthorized` 或空列表都说明调试没开好。各品牌入口位置不同，个别系统还有额外开关，不开会出现「有画面但点不动」。

## 通用步骤

1. 打开开发者选项：设置 → 关于手机 → 连续点「版本号」7 次，直到提示已进入开发者模式
2. 打开 USB 调试：设置 → 系统（或「系统和更新」「其他设置」）→ 开发者选项 → USB 调试
3. 插上数据线，设备弹出「允许 USB 调试吗？」时勾选「始终允许」并确定
4. 电脑执行 `adb devices`，看到 `<序列号>\tdevice` 即可

```bash
# 插件自带的 adb，在插件目录下执行
tools/platform-tools/adb.exe devices
```

## 各品牌入口

| 品牌 / 系统 | 开发者选项入口 | 开发者选项位置 | 额外开关 |
| --- | --- | --- | --- |
| 原生 Android / Pixel | 设置 → 关于手机 → 连点「版本号」7 次 | 设置 → 系统 → 开发者选项 | — |
| 小米 / Redmi / POCO（HyperOS、MIUI） | 设置 → 我的设备 → 全部参数与信息 → 连点「OS 版本」或「MIUI 版本」7 次 | 设置 → 更多设置 → 开发者选项 | **USB 调试（安全设置）**、USB 安装 |
| 华为（HarmonyOS 4.x 及以下） | 设置 → 关于手机 → 连点「HarmonyOS 版本」7 次 | 设置 → 系统和更新 → 开发人员选项 | **「仅充电」模式下允许 ADB 调试** |
| 华为（HarmonyOS 5 及以上） | 同上，确认后设备会重启一次 | 设置 → 系统 → 开发者选项 | 同上 |
| 荣耀（MagicOS） | 设置 → 关于手机 → 连点「版本号」7 次 | 设置 → 系统和更新 → 开发人员选项 | 「仅充电」模式下允许 ADB 调试；HDB 连接开关 |
| OPPO / 一加 / realme（ColorOS 12–16） | 设置 → 关于本机 → 版本信息 → 连点「版本号」7 次 | ColorOS 14.1–16：设置 → 系统与更新 → 开发者选项；ColorOS 12–14：设置 → 其他设置 / 系统设置 → 开发者选项 | **禁止权限监控** |
| vivo / iQOO（OriginOS、Funtouch） | 设置 → 系统管理 → 关于手机 → 连点「软件版本号」7 次 | 设置 → 系统管理 → 开发者选项 | USB 调试（安全设置）、USB 模拟点击（视版本） |
| 三星（One UI） | 设置 → 关于手机 → 软件信息 → 连点「版本号」7 次 | 设置 → 开发者选项 | Windows 端需装 Samsung USB Driver |
| 魅族（Flyme） | 设置 → 关于手机 → 连点「版本号」7 次 | 设置 → 开发者选项 | 关闭「Flyme 支付保护」（adb 权限受限时） |

## 和本插件有关的三个开关

**小米系的「USB 调试（安全设置）」**
和普通「USB 调试」是两个开关。只开前者，adb 能连、画面能看，但注入点击和按键会报 `SecurityException: Injecting to another application requires INJECT_EVENTS permission`。开启它需要登录小米账号并插入 SIM 卡，这是系统限制；开过一次后可以拔卡。

**OPPO 系的「权限监控」**
同样会拦住注入操作，需要在开发者选项里关闭它。ColorOS 16 起中文界面把这个选项藏了起来，临时把系统语言切成 English 会显示为 `Disable system optimization`。

**华为 / 荣耀的「仅充电」模式下允许 ADB 调试**
不开的话，拔掉数据线或设备进入睡眠后连接会断，投屏表现为突然掉线、面板一直重连。

## 无线连接

面板底部有三个按钮：转无线、配对、断开连接。

**转无线**

1. 用数据线连上设备，`adb devices` 里能看到它
2. 点「转无线」：插件读出设备的 WLAN 地址，执行 `adb tcpip 5555` 并自动 `adb connect`
3. 提示「已切到无线」后就可以拔线，设备列表里会多出 `<IP>:5555`，选它再点「连接」即可投屏

设备必须和电脑在同一个局域网内。校园网、访客 Wi-Fi、公司网络常做设备隔离，两边互相 ping 不通时无线连接会超时，换到同一台路由器下再试。

平板锁屏时授权弹窗弹不出来，无线连接会一直停在 `offline`。插件在切换前会先点亮并解锁屏幕；如果仍然连不上，解锁平板后再点一次「转无线」。

**配对（原生 Android 11 及以上）**

1. 开发者选项 → 无线调试 → 使用配对码配对设备，记下 IP、配对端口和 6 位配对码
2. 点「配对」，填入配对地址（`IP:配对端口`）和配对码
3. 配对成功后插件用 mDNS 找连接端口并自动连上；查不到时会提示把无线调试页面上的 `IP:连接端口` 填进来再点「连接」

**断开连接**

只断开电脑与平板之间的无线通道，USB 连接和已建立的会话不受影响。关闭页签、收起侧栏、切换页签都不会断开连接。断开后旧地址不能再用，需要无线时再点一次「转无线」。

华为 HarmonyOS 4.x 的开发者选项里没有「无线调试」入口，只能用「转无线」；这条路径依赖 `adb tcpip`，不需要配对。

## 连不上时按顺序排查

- `adb devices` 显示 `unauthorized`：设备上看不到授权弹窗，去开发者选项点「撤销 USB 调试授权」，重新插线并解锁屏幕
- 列表为空，设备只充电：换一根支持数据传输的线，或换电脑上的 USB 口
- 弹窗始终不出现：部分系统在锁屏或未解锁时不弹窗；先解锁再插线
- Windows 设备管理器里有黄色感叹号：接口被厂商驱动占用，改成「Android ADB Interface」，或安装 Google USB Driver
- 开机后失效：部分系统重启会重置授权，重新插线确认即可

## 参考

- Android 官方：配置设备上的开发者选项 <https://developer.android.com/studio/debug/dev-options>
- 小米：如何打开 USB 调试选项 <https://www.mi.com/tw/support/article/KA-17744/>
- 华为：如何开启和关闭开发人员选项 <https://consumer.huawei.com/cn/support/content/zh-cn02842747/>
- 华为：USB 调试开关打不开 <https://consumer.huawei.com/cn/support/content/zh-cn00407281/>
- 荣耀：无法通过 USB 数据线连接电脑 <https://www.honor.com/cn/support/content/zh-cn15808494/>
- OPPO：How to Enable USB Debugging <https://support.oppo.com/au/answer/?aid=neu9332>
- vivo：USB 调试开启方法（官方客服页）
- 三星：Turn on Developer Options <https://www.samsung.com/uk/support/mobile-devices/how-do-i-turn-on-the-developer-options-menu-on-my-samsung-galaxy-device/>
