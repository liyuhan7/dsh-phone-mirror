import base64
from pathlib import Path
import sys
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
        attempted = []

        async def connect(_udid, host, _port, **opts):
            self.assertFalse(opts["autopair"])
            attempted.append(host)
            return host

        class Tunnel:
            def __init__(self, provider_factory):
                self.provider_factory = provider_factory

            async def aopen(self):
                provider = await self.provider_factory()
                if provider.service == "192.0.2.2":
                    raise TimeoutError()
                return "connected RSD"

        original_connect = bridge.tunnel_service.create_connection
        with (
            patch.object(sys, "platform", "win32"),
            patch("ifaddr.get_adapters", return_value=[SimpleNamespace(ips=ips)]),
            patch.object(bridge.pmd_pair_records, "get_local_pairing_record", return_value={"peer_alt_irk": key}),
            patch.object(bridge, "browse_remotepairing", AsyncMock(return_value=answers)),
            patch.object(bridge.tunnel_service, "create_core_device_tunnel_service_using_remotepairing", connect),
            patch.object(bridge.userspace_tunnel, "UserspaceRsdTunnel", Tunnel),
        ):
            rsd, _ = await bridge._open_remote_tunnel("test")
        self.assertEqual(rsd, "connected RSD")
        self.assertEqual(attempted, ["192.0.2.2", "fe80::2%10"])
        self.assertIs(bridge.tunnel_service.create_connection, original_connect)

    async def test_browse_again_after_a_silent_mdns_round(self):
        key = bytes(range(16))
        answer = ServiceInstance("phone", None, 49152, [Address("192.0.2.2", "LAN")], {
            "identifier": "phone", "authTag": base64.b64encode(compute_auth_tag(key, "phone")).decode(),
        })

        class Tunnel:
            def __init__(self, provider_factory):
                self.provider_factory = provider_factory

            async def aopen(self):
                await self.provider_factory()
                return "connected RSD"

        browse = AsyncMock(side_effect=[[], [answer]])
        with (
            patch.object(bridge.pmd_pair_records, "get_local_pairing_record", return_value={"peer_alt_irk": key}),
            patch.object(bridge, "browse_remotepairing", browse),
            patch.object(bridge.tunnel_service, "create_core_device_tunnel_service_using_remotepairing",
                         AsyncMock(return_value="service")),
            patch.object(bridge.userspace_tunnel, "UserspaceRsdTunnel", Tunnel),
        ):
            rsd, _ = await bridge._open_remote_tunnel("test")
        self.assertEqual(rsd, "connected RSD")
        self.assertEqual(browse.await_count, 2)

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
        class Tunnel:
            def __init__(self, provider_factory):
                self.provider_factory = provider_factory

            async def aopen(self):
                await self.provider_factory()
                return "connected RSD"

        browse = AsyncMock(return_value=[])
        connect = AsyncMock(return_value="service")
        with (
            patch.object(bridge.pmd_pair_records, "get_local_pairing_record", return_value={"peer_alt_irk": bytes(16)}),
            patch.object(bridge, "browse_remotepairing", browse),
            patch.object(bridge.tunnel_service, "create_core_device_tunnel_service_using_remotepairing", connect),
            patch.object(bridge.userspace_tunnel, "UserspaceRsdTunnel", Tunnel),
        ):
            rsd, _ = await bridge._open_remote_tunnel("test", "10.4.53.159")
        self.assertEqual(rsd, "connected RSD")
        self.assertEqual(connect.await_args.args[1:3], ("10.4.53.159", bridge._REMOTE_PAIRING_PORT))
        browse.assert_not_awaited()

    async def test_stale_pinned_address_falls_back_to_browse(self):
        key = bytes(range(16))
        answer = ServiceInstance("phone", None, 49152, [Address("192.0.2.2", "LAN")], {
            "identifier": "phone", "authTag": base64.b64encode(compute_auth_tag(key, "phone")).decode(),
        })
        class Tunnel:
            def __init__(self, provider_factory):
                self.provider_factory = provider_factory

            async def aopen(self):
                provider = await self.provider_factory()
                if provider.service == "10.9.9.9":
                    raise TimeoutError()
                return "connected RSD"

        with (
            patch.object(bridge.pmd_pair_records, "get_local_pairing_record", return_value={"peer_alt_irk": key}),
            patch.object(bridge, "browse_remotepairing", AsyncMock(return_value=[answer])),
            patch.object(bridge.tunnel_service, "create_core_device_tunnel_service_using_remotepairing",
                         AsyncMock(side_effect=lambda _u, host, _p, **kw: host)),
            patch.object(bridge.userspace_tunnel, "UserspaceRsdTunnel", Tunnel),
        ):
            rsd, _ = await bridge._open_remote_tunnel("test", "10.9.9.9")
        self.assertEqual(rsd, "connected RSD")


if __name__ == "__main__":
    unittest.main()
