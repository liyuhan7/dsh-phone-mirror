import asyncio
import base64
from pathlib import Path
import plistlib
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
import ios_bridge as bridge
from pymobiledevice3.bonjour import Address, ServiceInstance
from pymobiledevice3.remote.siphash import compute_auth_tag


class WirelessTests(unittest.IsolatedAsyncioTestCase):
    async def test_amds_collision_requires_validating_new_local_record(self):
        error = bridge.MuxException("usbmuxd rejected the SavePairRecord request: {'MessageType': 'Result', 'Number': 183}")
        lockdown = SimpleNamespace(paired=False, pair_record=None, validate_pairing=AsyncMock(return_value=True))

        async def pair():
            lockdown.pair_record = {"HostID": "new"}
            raise error

        lockdown.pair = pair
        with patch.object(sys, "platform", "win32"):
            await bridge._ensure_usb_pairing(lockdown)
            lockdown.validate_pairing.assert_awaited_once()
            lockdown.validate_pairing.return_value = False
            with self.assertRaises(bridge.NotPairedError):
                await bridge._ensure_usb_pairing(lockdown)
            lockdown.pair = AsyncMock(side_effect=error)
            with self.assertRaises(bridge.MuxException):
                await bridge._ensure_usb_pairing(lockdown)
            self.assertEqual(lockdown.validate_pairing.await_count, 2)

    async def test_retry_full_tunnel_on_matched_windows_ipv6_address(self):
        key = bytes(range(16))
        tag = base64.b64encode(compute_auth_tag(key, "phone")).decode()
        answers = [
            ServiceInstance("other", None, 49152, [Address("192.0.2.9", "LAN")], {
                "identifier": "other", "authTag": tag,
            }),
            ServiceInstance("phone", None, 49152, [Address("fe80::2", "VPN"), Address("192.0.2.2", "LAN")], {
                "identifier": "phone", "authTag": tag,
            }),
        ]
        ips = [
            SimpleNamespace(ip="192.0.2.1", network_prefix=24, is_IPv4=True, is_IPv6=False),
            SimpleNamespace(ip=("fe80::1", 0, 10), is_IPv4=False, is_IPv6=True),
        ]
        tunnel = object()
        attempt = AsyncMock(side_effect=[OSError("TCP 建连失败"), ("connected RSD", tunnel)])
        original_connect = bridge.tunnel_service.create_connection
        with (
            patch.object(sys, "platform", "win32"),
            patch("ifaddr.get_adapters", return_value=[SimpleNamespace(ips=ips)]),
            patch.object(bridge.pmd_pair_records, "get_local_pairing_record", return_value={"peer_alt_irk": key}),
            patch.object(bridge, "browse_remotepairing", AsyncMock(return_value=answers)),
            patch.object(bridge, "_attempt_remote_endpoint", attempt),
        ):
            rsd, actual_tunnel = await bridge._open_remote_tunnel("test")
        self.assertEqual(rsd, "connected RSD")
        self.assertIs(actual_tunnel, tunnel)
        self.assertEqual([call.args[1:3] for call in attempt.await_args_list],
                         [("192.0.2.2", 49152), ("fe80::2%10", 49152)])
        self.assertIs(bridge.tunnel_service.create_connection, original_connect)

    async def test_browse_again_after_a_silent_mdns_round(self):
        key = bytes(range(16))
        answer = ServiceInstance("phone", None, 49152, [Address("192.0.2.2", "LAN")], {
            "identifier": "phone", "authTag": base64.b64encode(compute_auth_tag(key, "phone")).decode(),
        })
        browse = AsyncMock(side_effect=[[], [answer]])
        attempt = AsyncMock(return_value=("connected RSD", object()))
        with (
            patch.object(bridge.pmd_pair_records, "get_local_pairing_record", return_value={"peer_alt_irk": key}),
            patch.object(bridge, "browse_remotepairing", browse),
            patch.object(bridge, "_attempt_remote_endpoint", attempt),
        ):
            rsd, _ = await bridge._open_remote_tunnel("test")
        self.assertEqual(rsd, "connected RSD")
        self.assertEqual(browse.await_count, 2)
        self.assertEqual(attempt.await_args.args[:3], ("test", "192.0.2.2", 49152))

    async def test_silent_mdns_reports_network_cause(self):
        with (
            patch.object(bridge.pmd_pair_records, "get_local_pairing_record", return_value={"peer_alt_irk": bytes(16)}),
            patch.object(bridge, "browse_remotepairing", AsyncMock(return_value=[])),
            patch.object(bridge, "_TUNNEL_WINDOW", 0.6),
        ):
            with self.assertRaises(bridge.DeviceNotFoundError) as caught:
                await bridge._open_remote_tunnel("test")
        self.assertIn("没有收到任何 RemotePairing 广播", str(caught.exception))

    def test_dominant_wireless_candidates_filters_local_and_orders_by_count(self):
        counts = {"10.4.53.159": 150, "10.4.69.251": 60, "43.137.20.225": 80, "127.0.0.1": 5, "169.254.3.4": 2, "0.0.0.0": 9}
        exclude = {"10.4.69.251", "0.0.0.0"}
        self.assertEqual(
            bridge._dominant_wireless_candidates(counts, exclude),
            ["10.4.53.159", "43.137.20.225"],
        )

    def test_frame_src_ipv4_extracts_phone_address(self):
        import socket as _socket
        header = bytes([0x45, 0x00, 0x00, 0x1c, 0x00, 0x00, 0x00, 0x00, 0x40, 0x06, 0x00, 0x00])
        payload = header + _socket.inet_aton('10.4.53.159') + _socket.inet_aton('43.137.20.225')
        frame = bytes([255]) * 6 + bytes.fromhex('b83c282b5c87') + bytes([0x08, 0x00]) + payload
        self.assertEqual(bridge._frame_src_ipv4(frame), '10.4.53.159')
        self.assertIsNone(bridge._frame_src_ipv4(frame[:10]))
        arp = frame[:12] + bytes([0x08, 0x06]) + payload
        self.assertIsNone(bridge._frame_src_ipv4(arp))

    async def test_pinned_address_connects_without_browsing(self):
        for record in ({"peer_alt_irk": bytes(16)}, {"HostID": "paired-without-irk"}):
            with self.subTest(record=record):
                browse = AsyncMock(return_value=[])
                tunnel = object()
                attempt = AsyncMock(return_value=("connected RSD", tunnel))
                with (
                    patch.object(bridge.pmd_pair_records, "get_local_pairing_record", return_value=record),
                    patch.object(bridge, "browse_remotepairing", browse),
                    patch.object(bridge, "_attempt_remote_endpoint", attempt),
                ):
                    rsd, actual_tunnel = await bridge._open_remote_tunnel("test", "10.4.53.159")
                self.assertEqual(rsd, "connected RSD")
                self.assertIs(actual_tunnel, tunnel)
                attempt.assert_awaited_once()
                self.assertEqual(attempt.await_args.args[:3], ("test", "10.4.53.159", bridge._REMOTE_PAIRING_PORT))
                browse.assert_not_awaited()

    async def test_stale_pinned_address_falls_back_to_browse(self):
        key = bytes(range(16))
        answer = ServiceInstance("phone", None, 49152, [Address("192.0.2.2", "LAN")], {
            "identifier": "phone", "authTag": base64.b64encode(compute_auth_tag(key, "phone")).decode(),
        })
        attempt = AsyncMock(side_effect=[OSError("TCP 建连失败"), ("connected RSD", object())])
        with (
            patch.object(bridge.pmd_pair_records, "get_local_pairing_record", return_value={"peer_alt_irk": key}),
            patch.object(bridge, "browse_remotepairing", AsyncMock(return_value=[answer])),
            patch.object(bridge, "_attempt_remote_endpoint", attempt),
        ):
            rsd, _ = await bridge._open_remote_tunnel("test", "10.9.9.9")
        self.assertEqual(rsd, "connected RSD")
        self.assertEqual([call.args[1:3] for call in attempt.await_args_list],
                         [("10.9.9.9", bridge._REMOTE_PAIRING_PORT), ("192.0.2.2", 49152)])

    async def test_remote_endpoint_reports_stage_and_closes_resources(self):
        for failure, stage in (
            ("tcp", "TCP 建连"),
            ("handshake", "RemotePairing 初始握手"),
            ("pairing", "RemotePairing 配对验证"),
            ("tunnel", "建立 TCP/RSD 隧道"),
        ):
            with self.subTest(failure=failure):
                error = OSError("connection failed")
                closed = AsyncMock()
                connected = AsyncMock()

                class Service:
                    def __init__(self, *args, **kwargs):
                        self.args = args
                        self.kwargs = kwargs

                    async def connect(self, **kwargs):
                        await connected(**kwargs)
                        if failure == "tcp":
                            raise error
                        await self._attempt_pair_verify()
                        await self._validate_pairing()

                    async def _attempt_pair_verify(self):
                        if failure == "handshake":
                            raise error

                    async def _validate_pairing(self):
                        if failure == "pairing":
                            raise error

                    close = closed

                tunnel = SimpleNamespace(aclose=AsyncMock())

                async def open_tunnel():
                    await tunnel.provider_factory()
                    raise error

                tunnel.aopen = AsyncMock(side_effect=open_tunnel)

                def make_tunnel(*, provider_factory):
                    tunnel.provider_factory = provider_factory
                    return tunnel

                with (
                    patch.object(bridge.tunnel_service, "RemotePairingTunnelService", Service),
                    patch.object(bridge.userspace_tunnel, "UserspaceRsdTunnel", side_effect=make_tunnel),
                    patch.object(bridge.userspace_tunnel, "TunnelProvider") as provider,
                ):
                    with self.assertRaises(OSError) as caught:
                        await bridge._attempt_remote_endpoint("test", "192.0.2.2", 49152, 1.0)
                self.assertEqual(str(caught.exception), f"{stage}失败（192.0.2.2:49152）：connection failed")
                self.assertIs(caught.exception.__cause__, error)
                connected.assert_awaited_once_with(autopair=False)
                tunnel.aclose.assert_awaited_once()
                closed.assert_awaited_once()
                if failure == "tunnel":
                    service = provider.call_args.args[0]
                    self.assertIsInstance(service, Service)
                    self.assertEqual(service.args, ("test", "192.0.2.2", 49152))
                    self.assertEqual(service.kwargs, {"connect_timeout": 6.0})
                else:
                    provider.assert_not_called()

    async def test_remote_endpoint_unexpected_failure_closes_resources(self):
        service = SimpleNamespace(connect=AsyncMock(), close=AsyncMock())
        error = RuntimeError("unexpected tunnel failure")
        tunnel = SimpleNamespace(aclose=AsyncMock(side_effect=OSError("cleanup failed")))

        class Service:
            def __new__(cls, *args, **kwargs):
                return service

        async def open_tunnel():
            await tunnel.provider_factory()
            raise error

        tunnel.aopen = AsyncMock(side_effect=open_tunnel)

        def make_tunnel(*, provider_factory):
            tunnel.provider_factory = provider_factory
            return tunnel

        with (
            patch.object(bridge.tunnel_service, "RemotePairingTunnelService", Service),
            patch.object(bridge.userspace_tunnel, "UserspaceRsdTunnel", side_effect=make_tunnel),
        ):
            with self.assertRaises(RuntimeError) as caught:
                await bridge._attempt_remote_endpoint("test", "192.0.2.2", 49152, 1.0)
        self.assertIs(caught.exception, error)
        tunnel.aclose.assert_awaited_once()
        service.close.assert_awaited_once()

    async def test_usb_pairing_without_authenticated_session_is_not_success(self):
        lockdown = SimpleNamespace(set_enable_wifi_connections=AsyncMock(), close=AsyncMock())
        service = SimpleNamespace(connect=AsyncMock(), close=AsyncMock())
        messages = []
        with (
            patch.object(bridge, "create_using_usbmux", AsyncMock(return_value=lockdown)),
            patch.object(bridge, "_ensure_usb_pairing", AsyncMock()),
            patch.object(bridge.RemotePairingLockdownService, "create", AsyncMock(return_value=service)),
            patch.object(bridge, "_emit", side_effect=messages.append),
            patch.object(bridge, "_learn_wireless_address", AsyncMock()) as learn,
        ):
            self.assertEqual(await bridge.cmd_pair_wireless("test"), 1)
        self.assertEqual(messages[-1]["type"], "error")
        self.assertIn("验证未通过", messages[-1]["message"])
        learn.assert_not_awaited()
        service.close.assert_awaited_once()
        lockdown.close.assert_awaited_once()

    async def test_hid_reset_drops_dead_links_so_they_rebuild(self):
        uhs = SimpleNamespace(close=AsyncMock())
        indigo = SimpleNamespace(close=AsyncMock())
        holder = SimpleNamespace(
            _uhs=uhs, _indigo=indigo, _touch_service_id=257, _scroll_active=True,
        )
        await bridge.MirrorScreenStreamServer._reset_hid(holder)
        self.assertIsNone(holder._uhs)
        self.assertIsNone(holder._indigo)
        self.assertIsNone(holder._touch_service_id)
        self.assertFalse(holder._scroll_active)
        uhs.close.assert_awaited_once()
        indigo.close.assert_awaited_once()

    async def test_manual_address_pairs_device_without_any_record(self):
        rsd, tunnel = SimpleNamespace(), SimpleNamespace()
        attempt = AsyncMock(return_value=(rsd, tunnel))
        with (
            patch.object(bridge.pmd_pair_records, "get_local_pairing_record", return_value=None),
            patch.object(bridge, "_attempt_remote_endpoint", attempt),
        ):
            self.assertEqual(await bridge._open_remote_tunnel("test", "192.0.2.2", explicit_host=True), (rsd, tunnel))
        attempt.assert_awaited_once_with("test", "192.0.2.2", bridge._REMOTE_PAIRING_PORT, 45.0, autopair=True)

    async def test_manual_address_tries_existing_records_at_the_typed_ip_only(self):
        rsd, tunnel = object(), object()
        attempt = AsyncMock(side_effect=[OSError("RemotePairing 配对验证失败"), (rsd, tunnel)])
        with (
            patch.object(bridge.pmd_pair_records, "iter_remote_paired_identifiers", return_value=iter(["other", "real"])),
            patch.object(bridge, "_attempt_remote_endpoint", attempt),
        ):
            self.assertEqual(
                await bridge._open_remote_tunnel(bridge.MANUAL_UDID, "192.0.2.2", explicit_host=True), (rsd, tunnel),
            )
        self.assertEqual([call.args[:3] for call in attempt.await_args_list], [
            ("other", "192.0.2.2", 49152), ("real", "192.0.2.2", 49152),
        ])
        self.assertTrue(all(call.kwargs == {"adopt_record": True} for call in attempt.await_args_list))

    async def test_explicit_address_failure_does_not_switch_endpoints(self):
        with (
            patch.object(bridge.pmd_pair_records, "get_local_pairing_record", return_value={"peer_alt_irk": bytes(16)}),
            patch.object(bridge, "browse_remotepairing", AsyncMock()) as browse,
            patch.object(bridge, "create_using_usbmux", AsyncMock()) as mux,
            patch.object(bridge, "_attempt_remote_endpoint", AsyncMock(side_effect=OSError("TCP 建连失败"))) as attempt,
        ):
            with self.assertRaisesRegex(RuntimeError, r"192\.0\.2\.2:49152"):
                await bridge._open_rsd("test", True, "192.0.2.2", explicit_host=True)
        attempt.assert_awaited_once()
        self.assertEqual(attempt.await_args.args[:3], ("test", "192.0.2.2", 49152))
        browse.assert_not_awaited()
        mux.assert_not_awaited()

    async def test_manual_address_uses_peer_identity_and_upstream_pairing(self):
        protocol = bridge.tunnel_service.RemotePairingProtocol
        manual_service = bridge.tunnel_service.RemotePairingManualPairingService
        peer_id = "pairing-identifier"
        real_udid = "00008120-REAL"

        async def handshake(service):
            service.handshake_info = {"peerDeviceInfo": {"identifier": peer_id}}

        for initial_record in (False, True):
            with self.subTest(initial_record=initial_record), TemporaryDirectory() as tmp:
                home = Path(tmp)
                record = {"private_key": bytes(32)}
                record_bytes = plistlib.dumps(record)
                handshake_record = home / f"remote_{peer_id}.plist"
                if initial_record:
                    handshake_record.write_bytes(record_bytes)

                async def verify(service):
                    return service.pair_record == record

                async def pair(service):
                    self.assertEqual(service.remote_identifier, peer_id)
                    service.pair_record_path.write_bytes(record_bytes)

                def init_keys(service):
                    service.client_cip = object()

                rsd = SimpleNamespace(udid=real_udid)

                def make_tunnel(*, provider_factory):
                    async def open_tunnel():
                        await provider_factory()
                        return rsd
                    return SimpleNamespace(aopen=open_tunnel, aclose=AsyncMock())

                with (
                    patch.object(bridge, "_PMD_HOME", home),
                    patch.object(bridge.tunnel_service, "create_pairing_records_cache_folder", return_value=home),
                    patch.object(manual_service, "open_stream", AsyncMock()) as tcp,
                    patch.object(manual_service, "close", AsyncMock()),
                    patch.object(protocol, "_attempt_pair_verify", handshake),
                    patch.object(protocol, "_validate_pairing", verify),
                    patch.object(protocol, "_pair", autospec=True, side_effect=pair) as pair_mock,
                    patch.object(protocol, "_init_client_server_main_encryption_keys", init_keys),
                    patch.object(bridge, "_emit"),
                    patch.object(bridge.userspace_tunnel, "UserspaceRsdTunnel", side_effect=make_tunnel),
                    patch.object(bridge.userspace_tunnel, "TunnelProvider") as provider,
                ):
                    result, _ = await bridge._attempt_remote_endpoint(
                        bridge.MANUAL_UDID, "192.0.2.2", 49152, 1.0, autopair=True,
                    )
                    self.assertIs(result, rsd)
                    self.assertEqual(tcp.await_count, 1 if initial_record else 2)
                    self.assertEqual(pair_mock.await_count, 0 if initial_record else 1)
                    provider.assert_called_once()
                    self.assertFalse(handshake_record.exists())
                    self.assertEqual((home / f"remote_{real_udid}.plist").read_bytes(), record_bytes)
                    # 后续会话直接按设备列表里的真实 UDID 读取配对记录。
                    self.assertEqual(manual_service(real_udid, "192.0.2.2", 49152).pair_record, record)

    async def test_learning_uses_outgoing_phone_packets_without_tcp_probe(self):
        import socket
        def packet(ip, direction, iface="en"):
            frame = bytes(12) + b"\x08\x00" + b"\x45" + bytes(11) + socket.inet_aton(ip) + bytes(4)
            return SimpleNamespace(data=frame, io=direction, interface_name=iface)

        class Capture:
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                pass
            async def watch(self, **kwargs):
                for _ in range(10):
                    yield packet("203.0.113.9", 16)
                # 蜂窝接口的出站源是蜂窝地址，不能当 Wi-Fi 地址学。
                yield packet("10.17.83.53", 1, "pdp_ip")
                # 个人热点模式下手机地址出现在 bridge 接口。
                yield packet("192.0.2.2", 1, "bridge")

        with (
            patch("pymobiledevice3.services.pcapd.PcapdService", return_value=Capture()),
            patch.object(bridge, "_local_ipv4s", return_value=set()),
            patch.object(bridge, "_local_ipv4_networks", return_value=[]),
            patch.object(bridge, "_discover_wireless_address", AsyncMock(return_value=("198.51.100.7", 49152))) as fallback,
        ):
            self.assertEqual(await bridge._learn_wireless_address(None), ("192.0.2.2", 49152))
            fallback.assert_not_awaited()

    async def test_pair_wireless_falls_back_to_mdns_when_nothing_captured(self):
        lockdown = SimpleNamespace(set_enable_wifi_connections=AsyncMock(), close=AsyncMock())
        service = SimpleNamespace(connect=AsyncMock(), close=AsyncMock(), client_cip=object())

        async def fake_verify(_udid, address):
            return address == "198.51.100.7", ""

        with (
            patch.object(bridge, "create_using_usbmux", AsyncMock(return_value=lockdown)),
            patch.object(bridge, "_ensure_usb_pairing", AsyncMock()),
            patch.object(bridge.RemotePairingLockdownService, "create", AsyncMock(return_value=service)),
            patch.object(bridge, "_emit"),
            patch.object(bridge, "_learn_wireless_address", AsyncMock(return_value=None)),
            patch.object(bridge, "_discover_wireless_address", AsyncMock(return_value=("198.51.100.7", 49152))) as discover,
            patch.object(bridge, "_verify_wireless_address", side_effect=fake_verify) as verify,
        ):
            result = await bridge.cmd_pair_wireless("test")
        self.assertEqual(result, 0)
        discover.assert_awaited_once_with("test")
        verify.assert_awaited_once_with("test", "198.51.100.7")

    async def test_discover_wireless_address_matches_record_and_prefers_ipv4(self):
        key = bytes(range(16))
        answer = ServiceInstance("phone", None, 49152, [Address("198.51.100.7", "LAN")], {
            "identifier": "phone",
            "authTag": base64.b64encode(compute_auth_tag(key, "phone")).decode(),
        })
        with (
            patch.object(bridge.pmd_pair_records, "get_local_pairing_record", return_value={"peer_alt_irk": key}),
            patch.object(bridge, "browse_remotepairing", AsyncMock(return_value=[answer])),
        ):
            self.assertEqual(await bridge._discover_wireless_address("phone"), ("198.51.100.7", 49152))
        other = ServiceInstance("other", None, 49152, [Address("203.0.113.1", "LAN")], {
            "identifier": "other",
            "authTag": base64.b64encode(compute_auth_tag(bytes(16), "other")).decode(),
        })
        with (
            patch.object(bridge.pmd_pair_records, "get_local_pairing_record", return_value={"peer_alt_irk": key}),
            patch.object(bridge, "browse_remotepairing", AsyncMock(return_value=[other])),
        ):
            self.assertIsNone(await bridge._discover_wireless_address("phone"))

    async def test_loopback_origin_allowed_but_foreign_origin_refused(self):
        server = object.__new__(bridge.MirrorScreenStreamServer)
        server._password = None
        # DSH 页面与 sidecar 同机不同端口：浏览器会带自己的 Origin。
        for origin in ("http://127.0.0.1:43120", "http://localhost:43120"):
            self.assertIsNone(server._refuse_request({"origin": origin, "host": "127.0.0.1:49152"}))
        # 其它来源仍按上游的防 DNS rebinding 规则拒绝。
        refused = server._refuse_request({"origin": "http://evil.example.com", "host": "127.0.0.1:49152"})
        self.assertIsNotNone(refused)
        self.assertIn(b"403", refused)

    async def test_input_kick_verifies_hid_link_in_background(self):
        from types import MethodType

        def server(**fields):
            holder = SimpleNamespace(
                _indigo=None, _touch_service_id=257, _scroll_active=False,
                _hid_ok_at=0.0, _hid_check=None, _hid_lock=asyncio.Lock(), **fields,
            )
            holder._hid_verify = MethodType(bridge.MirrorScreenStreamServer._hid_verify, holder)
            holder._reset_hid = MethodType(bridge.MirrorScreenStreamServer._reset_hid, holder)
            return holder

        async def dead_ping():
            raise asyncio.TimeoutError()

        # 死链：探活失败后丢弃，交回 _ensure_hid 现场重建。
        holder = server(_uhs=SimpleNamespace(
            list_connected_services=AsyncMock(side_effect=dead_ping), close=AsyncMock(),
        ))
        await bridge.MirrorScreenStreamServer._hid_verify(holder)
        self.assertIsNone(holder._uhs)

        # 健康链路不做重建。
        healthy = server(_uhs=SimpleNamespace(list_connected_services=AsyncMock(return_value={})))
        await bridge.MirrorScreenStreamServer._hid_verify(healthy)
        self.assertIsNotNone(healthy._uhs)

        # 2 秒内复用探活结果，连续输入不会每次都探。
        again = server(_uhs=SimpleNamespace(list_connected_services=AsyncMock(return_value={})))
        again._hid_ok_at = asyncio.get_running_loop().time()
        bridge.MirrorScreenStreamServer._hid_kick(again)
        self.assertIsNone(again._hid_check)
        again._uhs.list_connected_services.assert_not_awaited()

    async def test_touch_and_scroll_entry_points_resolve_all_methods(self):
        """触摸与滚轮入口引用的 self.* 方法都必须能在类或父类上解析：
        入口抛 AttributeError 时 worker 只记日志、不回 HTTP 响应。"""
        import inspect
        import re

        cls = bridge.MirrorScreenStreamServer
        for entry in (cls._handle_touch, cls._send_scroll):
            source = inspect.getsource(entry)
            for name in re.findall(r"self\.(_\w+)\(", source):
                resolved = hasattr(cls, name) or hasattr(bridge.ScreenStreamServer, name)
                self.assertTrue(
                    resolved, f"{entry.__name__} 引用了不存在的方法 self.{name}()"
                )

    async def test_verify_wireless_address_requires_rsd_and_closes_it(self):
        rsd = SimpleNamespace(close=AsyncMock())
        tunnel = SimpleNamespace(aclose=AsyncMock())
        attempt = AsyncMock(return_value=(rsd, tunnel))
        with patch.object(bridge, "_attempt_remote_endpoint", attempt):
            self.assertEqual(await bridge._verify_wireless_address("test", "192.0.2.2"), (True, ""))
        attempt.assert_awaited_once_with("test", "192.0.2.2", bridge._REMOTE_PAIRING_PORT, 6.0)
        rsd.close.assert_awaited_once()
        tunnel.aclose.assert_awaited_once()

    async def test_verify_wireless_address_failure_returns_false(self):
        for failure in ("connect", "rsd_close", "tunnel_close"):
            with self.subTest(failure=failure):
                error = OSError(failure)
                rsd = SimpleNamespace(close=AsyncMock(side_effect=error if failure == "rsd_close" else None))
                tunnel = SimpleNamespace(aclose=AsyncMock(side_effect=error if failure == "tunnel_close" else None))
                attempt = AsyncMock(return_value=(rsd, tunnel), side_effect=error if failure == "connect" else None)
                with patch.object(bridge, "_attempt_remote_endpoint", attempt):
                    self.assertEqual(await bridge._verify_wireless_address("test", "192.0.2.2"), (False, failure))
                if failure == "connect":
                    rsd.close.assert_not_awaited()
                    tunnel.aclose.assert_not_awaited()
                else:
                    rsd.close.assert_awaited_once()
                    tunnel.aclose.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
