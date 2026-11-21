#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""
dsh-phone-mirror iOS sidecar bridge.

Wraps pymobiledevice3's CoreDevice ScreenStreamServer in a standalone process:
  - Prefers local / .plist.tmp pairing records when Windows AMDS leaves stale .plist files
  - Supplies a cross-platform PyAV AAC-ELD -> s16le 48kHz stereo PCM decoder
  - Auto-mounts the Developer Disk Image (Cryptex1 / Personalized DDI) when needed
  - Supports both USB (usbmux) and Wi-Fi (RemotePairing) userspace tunnels without admin rights
  - Supports promptless USB-to-Wi-Fi RemotePairing bootstrap (`pair-wireless` subcommand)
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import ipaddress
import json
import logging
import os
import plistlib
import shutil
import socket
import urllib.parse
import struct
import sys
import tempfile
import time
from collections import Counter
from functools import partial
from pathlib import Path
from typing import Any, Optional


def _ensure_writable_home() -> Path:
    """Ensure pymobiledevice3's home folder (~/.pymobiledevice3) is writable;
    fall back to a plugin-local home if the OS user profile is restricted."""
    here = Path(__file__).resolve().parent
    candidates = [
        here.parent / ".tmp" / "home",
        Path.home(),
    ]
    chosen: Optional[Path] = None
    for base in candidates:
        target = base / ".pymobiledevice3"
        try:
            if not target.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            probe = target / ".write_probe"
            probe.write_bytes(b"ok")
            chosen = base
            break
        except Exception:
            continue

    if chosen is None:
        for base in candidates:
            if (base / ".pymobiledevice3").is_dir():
                chosen = base
                break
    if chosen is None:
        chosen = candidates[0]

    # Sync any existing .plist records between the candidates so neither path misses records.
    dst_dir = chosen / ".pymobiledevice3"
    for src_base in candidates:
        src_dir = src_base / ".pymobiledevice3"
        if src_dir == dst_dir or not src_dir.is_dir():
            continue
        with contextlib.suppress(Exception):
            for plist_file in src_dir.glob("*.plist"):
                dst_file = dst_dir / plist_file.name
                if not dst_file.exists():
                    shutil.copy2(plist_file, dst_file)

    os.environ["USERPROFILE"] = str(chosen)
    os.environ["HOME"] = str(chosen)
    os.environ["TEMP"] = str(chosen)
    os.environ["TMP"] = str(chosen)
    os.environ["TMPDIR"] = str(chosen)
    tempfile.tempdir = str(chosen)
    return dst_dir


_PMD_HOME = _ensure_writable_home()

import av  # noqa: E402
import pymobiledevice3.common as pmd_common  # noqa: E402
import pymobiledevice3.lockdown as pmd_lockdown  # noqa: E402
import pymobiledevice3.pair_records as pmd_pair_records  # noqa: E402
import pymobiledevice3.remote.core_device.screen_stream as pmd_screen_stream  # noqa: E402
from pymobiledevice3.bonjour import browse_remotepairing  # noqa: E402
from pymobiledevice3.exceptions import (  # noqa: E402
    ConnectionTerminatedError,
    DeviceNotFoundError,
    InvalidServiceError,
    MuxException,
    NotPairedError,
    PasswordRequiredError,
    RemotePairingCompletedError,
    UserspaceTunnelUnavailableError,
)
from pymobiledevice3.lockdown import create_using_usbmux  # noqa: E402
from pymobiledevice3.remote import tunnel_service, userspace_tunnel  # noqa: E402
from pymobiledevice3.remote.core_device.display_service import DisplayService  # noqa: E402
from pymobiledevice3.remote.core_device.device_info import DeviceInfoService  # noqa: E402
from pymobiledevice3.remote.core_device import hid_service as hs  # noqa: E402
from pymobiledevice3.remote.core_device.hid_service import (  # noqa: E402
    DIGITIZER_SURFACE_TOUCHSCREEN_GESTURE,
    HID_BUTTON_STATE_DOWN,
    HID_BUTTON_STATE_UP,
    build_digitizer_report,
)

# 注册虚拟键盘后的挂载等待：0.12s 足够，缩短切回键盘时的首键延迟。
hs.KEYBOARD_ATTACH_SETTLE_SECONDS = 0.12
from pymobiledevice3.remote.core_device.screen_stream import (  # noqa: E402
    ScreenStreamServer,
    hevc_decoder_configuration_record,
)
from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService  # noqa: E402
from pymobiledevice3.remote.tunnel_service import RemotePairingLockdownService  # noqa: E402
from pymobiledevice3.services.amfi import AmfiService  # noqa: E402
from pymobiledevice3.services.mobile_image_mounter import auto_mount  # noqa: E402

pmd_common._HOMEFOLDER = _PMD_HOME


async def _watch_stdin(stop: asyncio.Event) -> None:
    """Node 父进程写入 quit（或关闭 stdin）时请求退出，让 serve() 走正常清理。"""
    loop = asyncio.get_running_loop()
    while True:
        try:
            line = await loop.run_in_executor(None, sys.stdin.readline)
        except Exception:
            stop.set()
            return
        if not line or line.strip().lower() in {"quit", "exit"}:
            stop.set()
            return


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


_orig_get_preferred_pair_record = pmd_pair_records.get_preferred_pair_record


async def _patched_get_preferred_pair_record(
    identifier: str, pairing_records_cache_folder: Path, usbmux_address: Optional[str] = None
) -> Optional[dict[str, Any]]:
    local = pmd_pair_records.get_local_pairing_record(identifier, pairing_records_cache_folder)
    if local is not None:
        return local
    with contextlib.suppress(Exception):
        lockdown_dir = pmd_pair_records.OSUTILS.pair_record_path
        tmp_path = lockdown_dir / f"{identifier}.plist.tmp"
        std_path = lockdown_dir / f"{identifier}.plist"
        if tmp_path.exists():
            if not std_path.exists() or tmp_path.stat().st_mtime >= std_path.stat().st_mtime:
                record = plistlib.loads(tmp_path.read_bytes())
                with contextlib.suppress(Exception):
                    (pairing_records_cache_folder / f"{identifier}.plist").write_bytes(tmp_path.read_bytes())
                return record
    return await _orig_get_preferred_pair_record(
        identifier, pairing_records_cache_folder, usbmux_address=usbmux_address
    )


pmd_pair_records.get_preferred_pair_record = _patched_get_preferred_pair_record
pmd_lockdown.get_preferred_pair_record = _patched_get_preferred_pair_record


# CoreDevice 音频是 AAC-ELD 48 kHz 立体声、每包 480 样本；上游 ASC 记录的是
# 512 样本（frameLengthFlag=0），直接解码会拒帧或错位，这里改为 480 样本的 ASC。
ELD_ASC_48K_STEREO_480 = bytes.fromhex("f8e65000")


class PyAVAACELDDecoder:
    """Decode single AAC-ELD access units (48 kHz stereo, 480 frames/packet) into
    interleaved signed 16-bit little-endian stereo PCM bytes using PyAV/FFmpeg."""

    def __init__(self, magic_cookie: bytes = ELD_ASC_48K_STEREO_480) -> None:
        self._ctx = self._open_decoder()
        self._resampler = av.AudioResampler(format="s16", layout="stereo", rate=48000)

    @staticmethod
    def _open_decoder() -> av.CodecContext:
        ctx = av.CodecContext.create("aac", "r")
        ctx.extradata = ELD_ASC_48K_STEREO_480
        ctx.sample_rate = 48000
        ctx.open()
        return ctx

    def decode(self, au: bytes) -> bytes:
        # 静音时设备只发 4 字节空包，按帧解码会触发上游的重建风暴。
        if len(au) < 16:
            return b""
        out = bytearray()
        try:
            for frame in self._ctx.decode(av.Packet(au)):
                for resampled in self._resampler.resample(frame):
                    # s16 plane 按对齐补零，只取有效样本以保持 10 ms 时间轴。
                    raw = bytes(resampled.planes[0])
                    out.extend(raw[: resampled.samples * 4])
        except Exception:
            # 坏包就地重建解码器并丢弃该帧，不向上抛。
            self._reset()
            return b""
        return bytes(out)

    def _reset(self) -> None:
        # CodecContext 没有 close()，换新实例交给 GC。
        self._ctx = self._open_decoder()
        self._resampler = av.AudioResampler(format="s16", layout="stereo", rate=48000)


pmd_screen_stream.AACELDDecoder = PyAVAACELDDecoder  # type: ignore[misc]
pmd_screen_stream.AAC_ELD_ASC_48K_STEREO_480 = ELD_ASC_48K_STEREO_480  # type: ignore[attr-defined]
ScreenStreamServer._missing_audio_deps = staticmethod(lambda: [])  # type: ignore[method-assign]


def _aac_eld_supported() -> bool:
    """本机 FFmpeg 是否能解 CoreDevice 的 AAC-ELD（AOT 39，480 样本/帧）。"""
    try:
        PyAVAACELDDecoder._open_decoder()
        return True
    except Exception:
        return False


async def _ensure_usb_pairing(lockdown) -> None:
    if lockdown.paired:
        return
    previous = lockdown.pair_record
    try:
        await lockdown.pair()
    except MuxException as exc:
        # PMD 先写本地记录，再交给 usbmuxd；AMDS 拒绝自己的副本时仍须向设备验证。
        if (sys.platform != "win32" or "SavePairRecord request:" not in str(exc)
                or "'Number': 183}" not in str(exc)
                or not lockdown.pair_record or lockdown.pair_record is previous):
            raise
    if not await lockdown.validate_pairing():
        raise NotPairedError("iPhone 未接受此电脑的 USB 信任记录")


def _remote_addresses(answer):
    if sys.platform != "win32":
        return [address.full_ip for address in answer.addresses]

    ipv4 = [address.ip for address in answer.addresses if ":" not in address.ip]
    ipv6 = []
    lan_scopes = _lan_ipv6_scopes(ipv4)
    for address in answer.addresses:
        if ":" not in address.ip:
            continue
        if not ipaddress.ip_address(address.ip).is_link_local:
            ipv6.append(address.ip)
            continue
        # PMD may guess a VPN adapter for fe80::/64. Prefer the LAN inferred from the phone's A record.
        scopes = lan_scopes
        if not scopes and address.iface:
            with contextlib.suppress(OSError):
                scopes = [socket.if_nametoindex(address.iface)]
        ipv6.extend(f"{address.ip}%{scope}" for scope in scopes)
    return ipv4 + ipv6


def _lan_ipv6_scopes(ipv4):
    import ifaddr

    matches = []
    for adapter in ifaddr.get_adapters():
        scopes = {addr.ip[2] for addr in adapter.ips if addr.is_IPv6 and addr.ip[2]}
        for addr in adapter.ips:
            if addr.is_IPv4 and any(ipaddress.ip_address(ip) in ipaddress.ip_network(
                f"{addr.ip}/{addr.network_prefix}", strict=False
            ) for ip in ipv4):
                matches.extend((addr.network_prefix, scope) for scope in sorted(scopes))
    return list(dict.fromkeys(scope for _, scope in sorted(matches, reverse=True)))


# 无线发现与建隧道的总窗口，覆盖多轮 mDNS 查询。
_TUNNEL_WINDOW = 20.0
_BROWSE_WINDOW = 4.0
# RemotePairing 端口固定，禁组播的网络可以直接按 IP 连。
_REMOTE_PAIRING_PORT = 49152
# 手填地址直连未知设备时占位的哨兵 UDID；配对完成后换成真实 UDID。
MANUAL_UDID = "manual"


def _adopt_manual_record(real_udid: str) -> None:
    """把配对落在哨兵名下的记录换成真实 UDID，后续连接才能按 UDID 找到它。"""
    source = _PMD_HOME / f"remote_{MANUAL_UDID}.plist"
    if not source.is_file() or not real_udid or real_udid == MANUAL_UDID:
        return
    with contextlib.suppress(Exception):
        source.replace(_PMD_HOME / f"remote_{real_udid}.plist")


def _pinned_endpoints(address: str) -> list[tuple[str, int]]:
    """把配置里的无线地址解析成 endpoint，允许 ``192.168.1.5`` 或 ``192.168.1.5:49152``。"""
    address = address.strip()
    if not address:
        return []
    host, _, port = address.rpartition(":")
    if host and port.isdigit():
        return [(host, int(port))]
    return [(address, _REMOTE_PAIRING_PORT)]



async def _attempt_remote_endpoint(udid: str, host: str, port: int, timeout: float, autopair: bool = False):
    """连一个 RemotePairing 地址并建 RSD 隧道；失败抛出带阶段信息的 OSError。

    ``autopair`` 用于尚未配对的新设备：由设备弹窗确认后建立配对记录。
    """
    stage = "TCP 建连"

    class StagedService(tunnel_service.RemotePairingTunnelService):
        async def _attempt_pair_verify(self):
            nonlocal stage
            stage = "RemotePairing 初始握手"
            return await super()._attempt_pair_verify()

        async def _validate_pairing(self):
            nonlocal stage
            stage = "RemotePairing 配对验证"
            return await super()._validate_pairing()

    service: Any = None

    async def open_service():
        nonlocal stage
        candidate = StagedService(udid, host, port, connect_timeout=6.0)
        try:
            await candidate.connect(autopair=autopair)
        except RemotePairingCompletedError:
            # 设备确认信任后配对完成会断开这条连接，按新记录重连一次。
            await candidate.close()
            candidate = StagedService(udid, host, port, connect_timeout=6.0)
            await candidate.connect(autopair=False)
        except BaseException:
            with contextlib.suppress(Exception):
                await candidate.close()
            raise
        return candidate

    async def remote_provider():
        nonlocal service, stage
        service = await open_service()
        stage = "建立 TCP/RSD 隧道"
        return userspace_tunnel.TunnelProvider(service)

    tunnel = userspace_tunnel.UserspaceRsdTunnel(provider_factory=remote_provider)
    try:
        async with asyncio.timeout(timeout):
            return await tunnel.aopen(), tunnel
    except (OSError, ConnectionTerminatedError, asyncio.IncompleteReadError) as exc:
        with contextlib.suppress(Exception):
            await tunnel.aclose()
        if service is not None:
            with contextlib.suppress(Exception):
                await service.close()
        raise OSError(f"{stage}失败（{host}:{port}）：{str(exc) or type(exc).__name__}") from exc
    except BaseException:
        with contextlib.suppress(Exception):
            await tunnel.aclose()
        if service is not None:
            with contextlib.suppress(Exception):
                await service.close()
        raise


async def _open_remote_tunnel(udid: str, pinned_address: str = ""):
    record = pmd_pair_records.get_local_pairing_record(
        pmd_pair_records.get_remote_pairing_record_filename(udid), _PMD_HOME
    )
    irk = (record or {}).get(tunnel_service.PEER_ALT_IRK_KEY)
    # 手填地址允许直连尚未配对的设备：配对校验失败时由手机弹窗确认后补建记录。
    can_pair = bool(pinned_address)
    if not record and not can_pair:
        raise UserspaceTunnelUnavailableError("无可用的无线配对记录，请插线后点「转无线」")
    can_browse = isinstance(irk, bytes) and len(irk) == 16
    if not can_browse and not pinned_address:
        raise UserspaceTunnelUnavailableError("无线记录缺少发现密钥，请手填地址或通过 USB 重新配对")

    loop = asyncio.get_running_loop()
    deadline = loop.time() + _TUNNEL_WINDOW
    # PMD 11.58 的 listener TCP 是同步连接，外层 asyncio.timeout 无法中断它。
    original_connect = tunnel_service.create_connection
    tunnel_service.create_connection = partial(original_connect, timeout=2.5)
    attempted: list[str] = []
    failures: dict[str, str] = {}
    answers = 0
    try:
        for host, port in _pinned_endpoints(pinned_address):
            remaining = deadline - loop.time()
            if remaining <= 0:
                break
            attempted.append(f"{host}:{port}")
            # 首次无线配对要等用户在手机上点「信任」，给足等待时间。
            budget = 90.0 if (can_pair and not record) else min(6.0, remaining)
            if can_pair and not record:
                _emit({"type": "stage", "message": f"正在向 {host} 发起配对，请在手机上解锁并点「信任」…"})
            try:
                return await _attempt_remote_endpoint(
                    udid, host, port, budget, autopair=can_pair,
                )
            except OSError as exc:
                failures[f"{host}:{port}"] = str(exc)
        while can_browse and loop.time() < deadline:
            started = loop.time()
            endpoints = {}
            seen = 0
            window = max(1.0, min(_BROWSE_WINDOW, deadline - started))
            for answer in await browse_remotepairing(timeout=window):
                seen += 1
                if tunnel_service._match_remote_pair_record(answer, {udid: irk}) == udid:
                    endpoints.update(dict.fromkeys((host, answer.port) for host in _remote_addresses(answer)))
            answers = max(answers, seen)
            for host, port in endpoints:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    break
                endpoint = f"{host}:{port}"
                if endpoint not in attempted:
                    attempted.append(endpoint)
                try:
                    return await _attempt_remote_endpoint(udid, host, port, min(6.0, remaining))
                except OSError as exc:
                    failures[endpoint] = str(exc)
            # 浏览立即返回但没有答案时退出，避免空转。
            if not endpoints and loop.time() - started < 0.5:
                await asyncio.sleep(0.5)
    finally:
        tunnel_service.create_connection = original_connect

    if not attempted:
        if pinned_address:
            raise DeviceNotFoundError(
                udid, f"配置的无线地址 {pinned_address} 不可用，且无线网络上没有收到 RemotePairing 广播",
            )
        if not answers:
            raise DeviceNotFoundError(
                udid,
                "无线网络上没有收到任何 RemotePairing 广播（mDNS 查询无应答）："
                "确认 iPhone 与电脑在同一局域网、手机已解锁，电脑没开 VPN，防火墙没拦截组播。"
                "禁组播的校园网请在插件设置里填「iPhone 无线地址」按 IP 直连",
            )
        raise DeviceNotFoundError(
            udid,
            f"收到 {answers} 条无线广播但没有一条对得上本机配对记录：插线后点一次「转无线」重建配对",
        )
    advice = "；若手机 IP 变了，插回 USB 连一次（或点「转无线」）即可自动更新" if pinned_address else ""
    raise OSError(
        f"{'；'.join(list(failures.values())[:4]) or 'RemotePairing 连接超时'}"
        f"（{len(attempted)} 个地址均失败：{'、'.join(attempted[:4])}{advice}）"
    )


async def _open_rsd(udid: str, wireless: bool, pinned_address: str = "") -> tuple[RemoteServiceDiscoveryService, Any, str]:
    """Open a userspace RSD tunnel over USB or RemotePairing Wi-Fi."""
    if not wireless:
        try:
            lockdown = await create_using_usbmux(serial=udid, autopair=False)
        except PasswordRequiredError as exc:
            raise RuntimeError("请先解锁 iPhone，再点击连接") from exc
        except NotPairedError as exc:
            raise RuntimeError("尚未信任此电脑：请解锁 iPhone，在弹窗中点击「信任」并输入锁屏密码") from exc

        try:
            await _ensure_usb_pairing(lockdown)
            dev_mode = await lockdown.get_developer_mode_status()
            if not dev_mode:
                with contextlib.suppress(Exception):
                    await AmfiService(lockdown).reveal_developer_mode_option_in_ui()
                raise RuntimeError(
                    "iPhone 尚未开启开发者模式：请打开手机「设置 → 隐私与安全性 → 开发者模式」并重启确认"
                )
            device_name = lockdown.short_info.get("DeviceName") or "iPhone"
        finally:
            await lockdown.close()

        tunnel = userspace_tunnel.UserspaceRsdTunnel(
            serial=udid, remotepairing_fallback=True, remotepairing=False
        )
        rsd = await tunnel.aopen()
        return rsd, tunnel, device_name

    try:
        rsd, tunnel = await _open_remote_tunnel(udid, pinned_address)
        return rsd, tunnel, "iPhone (Wi-Fi)"
    except (UserspaceTunnelUnavailableError, DeviceNotFoundError, OSError) as remote_error:
        # Apple Devices can also publish a trusted Wi-Fi device through usbmux.
        # Explicitly require Network here: plugged-in USB must never pass a Wi-Fi test.
        async def network_provider():
            lockdown = await create_using_usbmux(serial=udid, autopair=False, connection_type="Network")
            try:
                if not lockdown.paired:
                    raise NotPairedError("Apple Devices 未建立受信任的 Wi-Fi 会话")
                proxy = await tunnel_service.CoreDeviceTunnelProxy.create(lockdown)
                return userspace_tunnel.TunnelProvider(proxy, lockdown)
            except BaseException:
                await lockdown.close()
                raise

        try:
            tunnel = userspace_tunnel.UserspaceRsdTunnel(provider_factory=network_provider)
            rsd = await tunnel.aopen()
            return rsd, tunnel, "iPhone (Wi-Fi)"
        except Exception as network_error:
            raise RuntimeError(
                f"无线连接失败。请确认 iPhone 已解锁、与电脑处于同一局域网。"
                f"RemotePairing：{remote_error}；Apple Devices Wi-Fi：{network_error}"
            ) from network_error


async def _ensure_ddi_mounted(rsd: RemoteServiceDiscoveryService) -> None:
    services = rsd.peer_info.get("Services", {})
    if DisplayService.SERVICE_NAME in services:
        return
    _emit({"type": "stage", "message": "正在挂载 iOS 开发者镜像（首次或重启后需数秒）…"})
    try:
        await auto_mount(rsd)
    except Exception as exc:
        # On slow networks cryptexd can finish mounting right around the 60s mark;
        # callers re-open the RSD tunnel afterwards to refresh the service table.
        logging.getLogger(__name__).warning("auto_mount raised %s; will re-check services", exc)


def _frame_src_ipv4(frame: bytes) -> Optional[str]:
    """以太网帧里 IPv4 包的源地址；非 IPv4 或帧太短返回 None。"""
    if len(frame) < 34 or struct.unpack("!H", frame[12:14])[0] != 0x0800:
        return None
    payload = frame[14:]
    if len(payload) < 20 or (payload[0] >> 4) != 4:
        return None
    return socket.inet_ntoa(payload[12:16])


def _local_ipv4s() -> set[str]:
    """本机所有 IPv4 地址：学习手机地址时把它们从候选里剔除。"""
    with contextlib.suppress(Exception):
        import ifaddr
        return {addr.ip for adapter in ifaddr.get_adapters() for addr in adapter.ips if addr.is_IPv4}
    return set()


def _local_ipv4_networks() -> list:
    """本机各接口的 IPv4 网段：直连的手机地址必须落在其中之一。

    手机开热点时是路由器，bridge 接口上出站包混着它转发的流量，源地址是远端
    服务器；只有与本机同网段的源才可能是手机自己的地址。
    """
    networks = []
    with contextlib.suppress(Exception):
        import ifaddr
        for adapter in ifaddr.get_adapters():
            for addr in adapter.ips:
                if addr.is_IPv4:
                    networks.append(ipaddress.ip_network(f"{addr.ip}/{addr.network_prefix}", strict=False))
    return networks


def _dominant_wireless_candidates(src_counts: dict[str, int], exclude: set[str]) -> list[str]:
    """按出现次数降序给出可用的源地址候选，剔除本机/环回/链路本地。"""
    def usable(ip: str) -> bool:
        return ip not in exclude and not ip.startswith(("127.", "0.", "169.254."))

    return [ip for ip, _ in sorted(src_counts.items(), key=lambda item: -item[1]) if usable(ip)]


async def _screen_is_active(rsd) -> bool:
    """主屏背光是否亮着。判断不出来时按「亮着」处理——宁可多重建一次也别永久卡死。"""
    try:
        from pymobiledevice3.remote.core_device.device_info import DeviceInfoService
        service = DeviceInfoService(rsd)
        await service.connect()
        try:
            info = await service.get_display_info()
        finally:
            with contextlib.suppress(Exception):
                await service.close()
        for display in (info.get("current") or {}).get("displays", []):
            if display.get("external"):
                continue
            return str(display.get("backlightState", "")).lower() not in ("off", "sleep")
    except Exception:
        return True
    return True


async def _learn_wireless_address(lockdown, seconds: float = 6.0) -> Optional[tuple[str, int]]:
    """通过手机 Wi-Fi 出站包学习地址；是否可认证由独立的无线验证决定。"""
    from pymobiledevice3.services.pcapd import PcapdService

    counts: Counter[str] = Counter()
    try:
        async with PcapdService(lockdown) as pcap:
            # 个人热点模式下手机流量走 bridge/ap 接口，不在 en 上，抓全部接口再自己筛。
            stream = pcap.watch()

            async def pump():
                async for packet in stream:
                    frame = bytes(packet.data)
                    src = _frame_src_ipv4(frame)
                    # 出站包才算手机地址；接收包源地址是服务器，蜂窝接口的源也不是 Wi-Fi 地址。
                    if (
                        src
                        and packet.io == 1
                        and getattr(packet, "interface_name", "en") in ("en", "bridge", "ap")
                    ):
                        counts[src] += 1

            try:
                await asyncio.wait_for(pump(), timeout=seconds)
            except asyncio.TimeoutError:
                pass
            finally:
                with contextlib.suppress(Exception):
                    await stream.aclose()
    except Exception:
        return None
    exclude = _local_ipv4s() | {"0.0.0.0"}
    networks = _local_ipv4_networks()
    # 转发的流量源是远端服务器；只有与本机同网段的源才可能是手机自己的地址。
    candidates = [
        ip for ip in _dominant_wireless_candidates(counts, exclude)
        if not networks or any(ipaddress.ip_address(ip) in net for net in networks)
    ]
    if candidates:
        return candidates[0], _REMOTE_PAIRING_PORT
    return None


async def _discover_wireless_address(udid: str) -> Optional[tuple[str, int]]:
    """用 mDNS 广播按配对记录匹配手机；热点和普通局域网用它兜底。

    校园网常禁组播导致这条路不通，所以只在抓包学不到地址时调用。
    """
    record = pmd_pair_records.get_local_pairing_record(
        pmd_pair_records.get_remote_pairing_record_filename(udid), _PMD_HOME
    )
    irk = (record or {}).get(tunnel_service.PEER_ALT_IRK_KEY)
    if not isinstance(irk, bytes) or len(irk) != 16:
        return None
    with contextlib.suppress(Exception):
        for answer in await browse_remotepairing(timeout=_BROWSE_WINDOW):
            if tunnel_service._match_remote_pair_record(answer, {udid: irk}) != udid:
                continue
            for host in _remote_addresses(answer):
                if ":" not in host:
                    return host, answer.port
    return None


async def _verify_wireless_address(udid: str, address: str) -> tuple[bool, str]:
    """只有无线认证及 RSD 均通过，才允许提示拔线。"""
    try:
        host, port = _pinned_endpoints(address)[0]
        rsd, tunnel = await _attempt_remote_endpoint(udid, host, port, 6.0, autopair=True)
        try:
            await rsd.close()
        finally:
            await tunnel.aclose()
        return True, ""
    except Exception as exc:
        return False, str(exc) or type(exc).__name__


async def cmd_pair_wireless(udid: str, host: str = "") -> int:
    try:
        lockdown = await create_using_usbmux(serial=udid, autopair=False, connection_type="USB")
    except Exception as exc:
        _emit({"type": "error", "message": f"需要通过 USB 连接并解锁的 iPhone 才能配置无线连接：{exc}"})
        return 1

    try:
        await _ensure_usb_pairing(lockdown)
        with contextlib.suppress(Exception):
            await lockdown.set_enable_wifi_connections(True)
        service = await RemotePairingLockdownService.create(lockdown)
        try:
            try:
                await service.connect(autopair=True)
            except RemotePairingCompletedError:
                await service.close()
                service = await RemotePairingLockdownService.create(lockdown)
                await service.connect(autopair=False)
            if not hasattr(service, "client_cip"):
                raise NotPairedError("USB RemotePairing 验证未通过，未建立无线配对")
        finally:
            await service.close()

        # Copy remote_<udid>.plist to ~/.pymobiledevice3 as well so all tools find it.
        real_home_pmd = Path(os.path.expanduser("~")) / ".pymobiledevice3"
        with contextlib.suppress(Exception):
            for rec in _PMD_HOME.glob("remote_*.plist"):
                real_home_pmd.mkdir(parents=True, exist_ok=True)
                dst = real_home_pmd / rec.name
                if dst != rec:
                    shutil.copy2(rec, dst)

        _emit({"type": "stage", "message": "正在读取手机 Wi-Fi 地址（约 6 秒）…"})
        learned = await _learn_wireless_address(lockdown) or await _discover_wireless_address(udid)
        address = host.strip() or (learned[0] if learned else "")
        ready, error = await _verify_wireless_address(udid, address) if address else (False, "未读取到手机当前 Wi-Fi 地址")
        _emit({
            "type": "paired", "udid": udid, "serial": f"wifi:{udid}",
            "directReady": ready, "wirelessError": error,
            **({"wirelessHost": learned[0]} if learned else {}),
        })
        return 0
    except PasswordRequiredError:
        _emit({"type": "error", "message": "请解锁 iPhone，保持 USB 连接后再点「转无线」"})
        return 1
    except InvalidServiceError:
        try:
            await lockdown.set_enable_wifi_connections(True)
        except Exception as exc:
            _emit({"type": "error", "message": f"设备不支持 RemotePairing，且无法开启 Apple Devices Wi-Fi：{exc}"})
            return 1
        _emit({"type": "paired", "udid": udid, "serial": f"wifi:{udid}"})
        return 0
    except Exception as exc:
        _emit({"type": "error", "message": f"无线配对失败：{exc}"})
        return 1
    finally:
        await lockdown.close()


def _clean_message(text: str) -> str:
    """错误信息里可能带协议原始字节，去掉不可打印字符并截断，避免界面上出现乱码。"""
    cleaned = "".join(ch for ch in str(text) if ch.isprintable() or ch in " \n\t")
    return " ".join(cleaned.split())[:300] or "连接失败"


def _scroll_chunks(dx: int, dy: int) -> list[tuple[int, int]]:
    """把一次合并后的增量拆成 int8 范围内的若干段，超出的量不丢失。"""
    chunks = []
    while dx or dy:
        chunk_x = max(-127, min(127, dx))
        chunk_y = max(-127, min(127, dy))
        chunks.append((chunk_x, chunk_y))
        dx, dy = dx - chunk_x, dy - chunk_y
    return chunks


def _scroll_report(dx: int, dy: int, phase: int, momentum: int = 0) -> bytes:
    """21 字节 Scroll 报告：ID 7，阶段、增量、16.16 加速度与 48 位时间戳。"""
    timestamp = time.monotonic_ns() & ((1 << 48) - 1)
    return (
        bytes([7, phase, momentum]) + struct.pack("<bb", dx, dy)
        + struct.pack("<ii", dx * 65536, dy * 65536)
        + timestamp.to_bytes(6, "little") + b"\x00\x00"
    )


class _CorsWriter:
    """代理 StreamWriter：在首个 HTTP 响应头里补 CORS，允许浏览器引擎
    Worker 跨端口直读本进程的流响应；其余调用原样转发。"""

    __slots__ = ("_inner", "_head_done")

    def __init__(self, inner: asyncio.StreamWriter) -> None:
        self._inner = inner
        self._head_done = False

    def write(self, data: bytes) -> None:
        if not self._head_done:
            self._head_done = True
            if data[:8] == b"HTTP/1.1":
                head, sep, rest = data.partition(b"\r\n\r\n")
                if sep:
                    return self._inner.write(head + b"\r\nAccess-Control-Allow-Origin: *" + sep + rest)
        return self._inner.write(data)

    def __getattr__(self, name: str):
        return getattr(self._inner, name)


class MirrorScreenStreamServer(ScreenStreamServer):
    _scroll_active = False
    _scroll_end_handle = None
    # 键盘走独立 UHS 连接：点画面时只关这一条，触摸那条完全不受影响。
    _kb_uhs = None
    # 上一次的朝向（currentDeviceOrientation + currentDeviceNonFlatOrientation）；None 表示还没收到过。
    _orientation = None
    # 朝向监听任务：朝向变化时交还输入法。
    _motion_task = None
    # 上次确认 HID 链路健康的时刻（loop.time）；0 表示尚未探过。
    _hid_ok_at = 0.0

    async def _hid_alive(self) -> bool:
        """一次真实 RPC 探活：HID 发送本身不等响应，死链必须靠请求-响应探出来。"""
        uhs = self._uhs
        if uhs is None:
            return True
        try:
            await asyncio.wait_for(uhs.list_connected_services(), 0.8)
            return True
        except Exception:
            return False

    async def _ensure_hid_ready(self) -> None:
        """链路闲置一段时间后先探活再发输入，死链当场重建。

        send_report 是发射后不管：写进断掉的连接不会抛错，只会静默丢报告，
        表现就是「画面正常但点击无效」。只有 list_connected_services 这种
        等响应的调用能探出死链。
        """
        loop = asyncio.get_running_loop()
        if loop.time() - self._hid_ok_at < 1.5:
            return
        self._hid_ok_at = loop.time()
        if not await self._hid_alive():
            logging.warning("hid link dead (ping failed), rebuilding")
            async with self._hid_lock:
                await self._reset_hid()

    def _refuse_request(self, headers):
        """桌面端页面与 sidecar 同机不同端口，跨源读取会被上游的同源检查拦下。

        上游规则只放行 Origin 与 Host 完全相同的请求（防 DNS rebinding）。
        这里额外放行回环来源，让 DSH 页面能直连视频流；其余来源、以及设置
        密码时的凭据校验，全部沿用上游行为。
        """
        origin = headers.get("origin")
        if origin not in (None, "null"):
            try:
                host = (urllib.parse.urlsplit(origin).hostname or "").lower()
            except ValueError:
                host = ""
            if host in ("127.0.0.1", "localhost", "::1"):
                return super()._refuse_request({**headers, "origin": None})
        return super()._refuse_request(headers)

    async def _handle_http(self, reader, writer) -> None:
        await super()._handle_http(reader, _CorsWriter(writer))

    async def _ensure_keyboard(self) -> None:
        """在独立连接上注册宿主虚拟键盘。

        按键逐键交给手机输入法处理：拼音在手机上组字、候选条显示在手机上，
        用电脑键盘的数字/空格/回车选字；软键盘由外接键盘规则收起。
        注册在独立连接上，注销时只关这一条。
        """
        if self._motion_task is None or self._motion_task.done():
            self._motion_task = asyncio.create_task(self._watch_orientation())
        if self._kb_service_id is not None:
            return
        async with self._hid_lock:
            if self._kb_service_id is not None:
                return
            if self._kb_uhs is None:
                uhs = hs.UniversalHIDServiceService(self._rsd)
                await uhs.connect()
                self._kb_uhs = uhs
            self._kb_service_id = await self._kb_uhs.create_keyboard_service()

    async def _detach_keyboard(self) -> None:
        """注销宿主键盘，把软键盘还给手机。

        关闭键盘连接即注销键盘；键盘消失后 iOS 把软键盘还给当前输入框。
        触摸走另一条连接，不受影响。关闭后预连下一条连接，省掉下次打字的握手。
        """
        if self._kb_service_id is None:
            return
        async with self._hid_lock:
            if self._kb_service_id is None:
                return
            self._kb_service_id = None
            uhs, self._kb_uhs = self._kb_uhs, None
        if uhs is not None:
            with contextlib.suppress(Exception):
                await uhs.close()
        asyncio.create_task(self._warm_keyboard_link())

    async def _warm_keyboard_link(self) -> None:
        """后台先连好键盘用的 UHS 连接（不注册键盘），缩短下一次打字的首键延迟。"""
        try:
            async with self._hid_lock:
                if self._kb_uhs is not None or self._kb_service_id is not None:
                    return
                uhs = hs.UniversalHIDServiceService(self._rsd)
                await uhs.connect()
                self._kb_uhs = uhs
        except Exception:
            logging.debug("keyboard link warm-up failed", exc_info=True)

    async def _reset_hid(self) -> None:
        """重建 HID 连接。

        网络抖动会掐断这条连接，而 _ensure_hid 只在字段为空时重连；
        不主动清空就会让之后的点击、滚轮全部静默失败，直到整场重连。
        """
        uhs, self._uhs = self._uhs, None
        indigo, self._indigo = self._indigo, None
        self._touch_service_id = None
        self._scroll_active = False
        for service in (uhs, indigo):
            if service is not None:
                with contextlib.suppress(Exception):
                    await service.close()

    async def _handle_touch(self, body: bytes) -> tuple[int, bytes]:
        await self._ensure_hid_ready()
        try:
            return await super()._handle_touch(body)
        except Exception:
            logging.info("touch send failed, rebuilding HID link", exc_info=True)
            async with self._hid_lock:
                await self._reset_hid()
            return await super()._handle_touch(body)

    async def _send_scroll(self, scroll: dict[str, Any]) -> None:
        # 客户端 dy 为「向上为正」（scrcpy 习惯），设备 HID 增量方向与之相反，
        # 因此取反；一格滚轮（客户端 1 单位）放大约 36 个设备增量。
        scale = 36
        dx = -max(-127, min(127, round(float(scroll.get("dx", 0)) * scale)))
        dy = -max(-127, min(127, round(float(scroll.get("dy", 0)) * scale)))
        if dx == 0 and dy == 0:
            return
        pointer = build_digitizer_report(
            round(float(scroll.get("x", 0.5)) * 65536),
            round(float(scroll.get("y", 0.5)) * 65536),
        )
        await self._ensure_hid_ready()
        await self._ensure_hid()
        service = DIGITIZER_SURFACE_TOUCHSCREEN_GESTURE
        # 持续手势：首个增量走 mayBegin+began，后续增量走 changed，停止 120ms 后发 ended；
        # 不发 momentum，滚轮停下即停住。
        phase = 0x02 if self._scroll_active else 0x01
        reports = [pointer] if self._scroll_active else [
            pointer,
            _scroll_report(0, 0, 0x80),
        ]
        for index, (chunk_x, chunk_y) in enumerate(_scroll_chunks(dx, dy)):
            reports.append(_scroll_report(chunk_x, chunk_y, 0x02 if index else phase))
        try:
            async with self._hid_lock:
                for report in reports:
                    await self._uhs.send_report(service, report)
                self._scroll_active = True
        except Exception:
            logging.info("scroll send failed, rebuilding HID link", exc_info=True)
            async with self._hid_lock:
                await self._reset_hid()
            raise
        self._schedule_scroll_end()

    def _schedule_scroll_end(self) -> None:
        if self._scroll_end_handle is not None:
            self._scroll_end_handle.cancel()
        loop = asyncio.get_running_loop()
        self._scroll_end_handle = loop.call_later(0.12, self._scroll_end)

    def _scroll_end(self) -> None:
        self._scroll_end_handle = None

        async def close() -> None:
            async with self._hid_lock:
                if not self._scroll_active or self._uhs is None:
                    return
                try:
                    await self._uhs.send_report(
                        DIGITIZER_SURFACE_TOUCHSCREEN_GESTURE, _scroll_report(0, 0, 0x04)
                    )
                except Exception:
                    logging.debug("scroll end failed", exc_info=True)
                finally:
                    self._scroll_active = False

        asyncio.create_task(close())

    async def _watch_orientation(self) -> None:
        """跟随 displayinfoupdates 推送，手机朝向变化时把键盘交还给手机输入法。

        只对朝向变化生效：拿起、转方向、在桌面上转身都会触发，纯平移不会。
        """
        try:
            async with DeviceInfoService(self._rsd) as service:
                async for element in service.display_info_updates():
                    orientation = (element or {}).get("orientation")
                    if isinstance(orientation, dict) and self._on_orientation(orientation):
                        await self._detach_keyboard()
        except asyncio.CancelledError:
            raise
        except Exception:
            logging.debug("orientation watcher stopped", exc_info=True)

    def _on_orientation(self, orientation: dict[str, Any]) -> bool:
        """记录朝向；返回 True 表示朝向变了（手机被拿起或转动过）。"""
        current = orientation.get("currentDeviceOrientation")
        if not isinstance(current, str):
            return False
        # 两个字段一起比较：平放时 currentDeviceOrientation 恒为 faceUp，
        # nonFlat 反映桌面上的转动。
        state = (current, orientation.get("currentDeviceNonFlatOrientation"))
        previous = self._orientation
        self._orientation = state
        return previous is not None and previous != state

    async def _stop_hid(self) -> None:
        self._scroll_active = False
        if self._motion_task is not None:
            self._motion_task.cancel()
            self._motion_task = None
        if self._scroll_end_handle is not None:
            self._scroll_end_handle.cancel()
            self._scroll_end_handle = None
        # 一并关掉键盘连接，避免设备上残留已注册的键盘。
        async with self._hid_lock:
            self._kb_service_id = None
            kb_uhs, self._kb_uhs = self._kb_uhs, None
        if kb_uhs is not None:
            with contextlib.suppress(Exception):
                await kb_uhs.close()
        await super()._stop_hid()

    async def _handle_key(self, body: bytes) -> tuple[int, bytes]:
        try:
            data = json.loads(body)
            recents = data.get("recents") is True
            scroll = data.get("scroll")
        except (ValueError, AttributeError):
            recents = False
            scroll = None
        if isinstance(scroll, dict):
            await self._send_scroll(scroll)
            return 200, b"ok"
        if recents:
            # App 切换器 = 连按两次 Home（Consumer 页 0x0C / 用法 0x40）。
            await self._ensure_hid()
            indigo = self._indigo
            for _ in range(2):
                await indigo.send_button(0x0C, 0x40, HID_BUTTON_STATE_DOWN)
                await asyncio.sleep(0.06)
                await indigo.send_button(0x0C, 0x40, HID_BUTTON_STATE_UP)
                await asyncio.sleep(0.12)
            return 200, b"ok"
        # 普通按键：键盘在独立连接上（见 _ensure_keyboard），点过画面后首键会重新注册。
        try:
            usages = [int(value) for value in json.loads(body).get("usages", [])]
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            return 400, f"invalid key request: {exc}".encode()
        try:
            await self._ensure_keyboard()
        except Exception:
            logging.warning("keyboard attach failed", exc_info=True)
            return 503, b"keyboard unavailable"
        if self._kb_uhs is None or self._kb_service_id is None:
            return 503, b"keyboard unavailable"
        try:
            await self._kb_uhs.send_keyboard(self._kb_service_id, usages)
        except Exception:
            # 键盘连接同样可能被网络抖动掐断，重建一次再发。
            logging.info("keyboard send failed, rebuilding link", exc_info=True)
            await self._detach_keyboard()
            await self._ensure_keyboard()
            if self._kb_uhs is None or self._kb_service_id is None:
                return 503, b"keyboard unavailable"
            await self._kb_uhs.send_keyboard(self._kb_service_id, usages)
        return 200, b"ok"


async def cmd_serve(udid: str, port: int, wireless: bool, host: str = "") -> int:
    stack_ctx = None
    rsd: Optional[RemoteServiceDiscoveryService] = None
    try:
        rsd, stack_ctx, device_name = await _open_rsd(udid, wireless, host)
        # 手填地址直连未知设备时用哨兵 udid；配对完成后按真实 UDID 落盘并沿用。
        if wireless and udid == MANUAL_UDID:
            real_udid = getattr(rsd, "udid", "")
            if real_udid and real_udid != MANUAL_UDID:
                _adopt_manual_record(real_udid)
                udid = real_udid
        if DisplayService.SERVICE_NAME not in rsd.peer_info.get("Services", {}):
            await _ensure_ddi_mounted(rsd)
            with contextlib.suppress(Exception):
                await rsd.close()
            if stack_ctx is not None:
                with contextlib.suppress(Exception):
                    await stack_ctx.aclose()
            rsd, stack_ctx, device_name = await _open_rsd(udid, wireless, host)

        version_str = str(rsd.product_version)
        major = int(version_str.split(".")[0]) if version_str and version_str[0].isdigit() else 0
        if major < 27:
            _emit({
                "type": "error",
                "message": f"当前设备系统为 iOS {version_str}，CoreDevice 实时画面流需要 iOS 27 及以上版本",
            })
            return 1

        server = MirrorScreenStreamServer(
            rsd,
            bind="127.0.0.1",
            http_port=port,
            audio_default_on=True,
            # 关闭 pmd 的 motion-IDR 周期关键帧：屏幕持续运动时这些关键帧会把设备编码器压停，
            # 画面随即冻结。分辨率收缩由前端的补偿逻辑恢复。
            motion_idr=False,
        )

        serve_task = asyncio.create_task(server.serve())
        deadline = asyncio.get_running_loop().time() + 28.0
        while not server._stream_ready.is_set():
            if serve_task.done():
                exc = serve_task.exception()
                raise exc if exc else RuntimeError("ScreenStreamServer 提前退出")
            if asyncio.get_running_loop().time() > deadline:
                raise RuntimeError("等待 iPhone 画面流就绪超时，请确认手机没有打开相机或通话")
            await asyncio.sleep(0.05)

        width, height = server._display_size or (1170, 2532)
        description = None
        if server._codec_string and server._vps_nal and server._sps_nal and server._pps_nal:
            hvcc = hevc_decoder_configuration_record(server._vps_nal, server._sps_nal, server._pps_nal)
            description = base64.b64encode(hvcc).decode()
        _emit({
            "type": "ready",
            "port": port,
            "udid": udid,
            "deviceName": device_name,
            "productVersion": version_str,
            "codec": server._codec_string,
            "description": description,
            "screen": {"width": width, "height": height, "rotation": server._display_rotation},
            "connection": "wifi" if wireless else "usb",
            "audio": _aac_eld_supported(),
        })
        # HID 预热放到就绪之后，不阻塞首帧。
        async def warm_hid() -> None:
            with contextlib.suppress(Exception):
                await server._ensure_hid()

        hid_warm = asyncio.create_task(warm_hid())

        # USB 会话期间学习手机 Wi-Fi 地址，供拔线后的无线直连使用。
        async def report_wireless_address() -> None:
            with contextlib.suppress(Exception):
                address_lockdown = await create_using_usbmux(serial=udid, autopair=False)
                try:
                    learned = await _learn_wireless_address(address_lockdown) or await _discover_wireless_address(udid)
                finally:
                    with contextlib.suppress(Exception):
                        await address_lockdown.close()
                if learned:
                    _emit({"type": "wireless-address", "udid": udid, "host": learned[0], "port": learned[1]})

        if not wireless:
            asyncio.create_task(report_wireless_address())
        if os.environ.get("PHONE_MIRROR_STDIN_QUIT") != "1" or sys.stdin is None:
            await serve_task
            hid_warm.cancel()
            return 0

        stop = asyncio.Event()
        stdin_task = asyncio.create_task(_watch_stdin(stop))
        stop_wait = asyncio.create_task(stop.wait())

        # pmd 自带停滞看门狗，但用完重启次数后会永久放弃，界面就停在最后一帧。
        # 这里把它升级成会话重启：退出进程，宿主按无线恢复逻辑重新建会话。
        async def watch_stream_stall() -> str:
            loop = asyncio.get_running_loop()
            limit = getattr(pmd_screen_stream, "_MAX_STALL_RESTARTS", 3)
            next_screen_check = 0.0
            while True:
                await asyncio.sleep(3)
                if server._active_service is None:
                    continue
                idle = loop.time() - getattr(server, "_last_good_au_t", loop.time())
                if idle < 12 or getattr(server, "_consecutive_restarts", 0) < limit:
                    continue
                if loop.time() < next_screen_check:
                    continue
                next_screen_check = loop.time() + 30
                screen_active = await _screen_is_active(server._rsd)
                if not screen_active:
                    continue
                # 判别：让编码器回一个 IDR。活着的编码器即使画面静止也会应答。
                with contextlib.suppress(Exception):
                    server._request_recovery_idr(reason="stall-watchdog")
                await asyncio.sleep(5)
                if loop.time() - getattr(server, "_last_good_au_t", 0.0) < 8:
                    continue
                return f"画面流停滞 {idle:.0f} 秒且自动重启无效，正在重连"

        stall_task = asyncio.create_task(watch_stream_stall())
        try:
            done, _ = await asyncio.wait(
                {serve_task, stop_wait, stall_task}, return_when=asyncio.FIRST_COMPLETED
            )
            if serve_task in done:
                exc = serve_task.exception()
                if exc:
                    raise exc
            if stall_task in done and not stop.is_set():
                raise RuntimeError(stall_task.result())
        finally:
            stall_task.cancel()
            hid_warm.cancel()
            stop_wait.cancel()
            stdin_task.cancel()
            serve_task.cancel()
            with contextlib.suppress(BaseException):
                await serve_task
        return 0
    except Exception as exc:
        _emit({"type": "error", "message": _clean_message(exc)})
        return 1
    finally:
        if rsd is not None:
            with contextlib.suppress(Exception):
                await rsd.close()
        if stack_ctx is not None:
            with contextlib.suppress(Exception):
                await stack_ctx.aclose()


def main() -> int:
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    parser = argparse.ArgumentParser(description="dsh-phone-mirror iOS bridge")
    sub = parser.add_subparsers(dest="command", required=True)

    serve_p = sub.add_parser("serve")
    serve_p.add_argument("--udid", required=True)
    serve_p.add_argument("--port", type=int, required=True)
    serve_p.add_argument("--wireless", action="store_true")
    serve_p.add_argument("--host", default="")

    pair_p = sub.add_parser("pair-wireless")
    pair_p.add_argument("--udid", required=True)
    pair_p.add_argument("--host", default="")

    args = parser.parse_args()
    if args.command == "pair-wireless":
        return asyncio.run(cmd_pair_wireless(args.udid, args.host))
    return asyncio.run(cmd_serve(args.udid, args.port, args.wireless, args.host))


if __name__ == "__main__":
    raise SystemExit(main())
