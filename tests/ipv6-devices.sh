#!/bin/sh
# Run as root with OPENWRT_ROOTFS set to a Linux-compatible OpenWrt rootfs archive.
set -eu

: "${OPENWRT_ROOTFS:?Set OPENWRT_ROOTFS to the OpenWrt rootfs archive}"
if [ "${1:-}" != isolated ]; then
	exec unshare -n sh "$0" isolated
fi

lab=$(mktemp -d)
root="$lab/root"
children=
trap 'if [ -n "$children" ]; then kill $children 2>/dev/null || true; fi; wait || true; rm -rf "$lab"' EXIT
mkdir "$root"
tar -xzf "$OPENWRT_ROOTFS" -C "$root"
mkdir -p "$root/tmp/lock" "$root/tmp/run/xboxdownload_openwrt" "$root/dev"
[ -c "$root/dev/null" ] || mknod "$root/dev/null" c 1 3
[ -c "$root/dev/urandom" ] || mknod "$root/dev/urandom" c 1 9
cp -R package/root/. "$root/"
chmod +x "$root/usr/share/xboxdownload_openwrt/supervise" "$root/usr/share/xboxdownload_openwrt/http/cgi-bin/redirect" "$root/usr/libexec/rpcd/xboxdownload_openwrt"

ip link set lo up
ip link add br-xbtest type bridge mcast_snooping 0
ip link set br-xbtest up
ip address add 192.0.2.1/24 dev br-xbtest
ip -6 address add fe80::1/64 dev br-xbtest nodad
ip -6 address add fd10::1/64 dev br-xbtest nodad
ip -6 address add 2001:db8:1::1/64 dev br-xbtest nodad

uci_test() {
	chroot "$root" uci -q "$@"
}

rpc() {
	chroot "$root" /usr/libexec/rpcd/xboxdownload_openwrt call "$1"
}

cat >> "$root/lib/functions/network.sh" <<'EOF'
network_get_ipaddr() { export "$1=192.0.2.1"; }
network_get_device() { export "$1=br-xbtest"; }
EOF
printf '#!/bin/sh\nexit 0\n' > "$root/tmp/test-init"
chmod +x "$root/tmp/test-init"
sed -i 's|^INIT=.*|INIT=/tmp/test-init|' "$root/usr/libexec/rpcd/xboxdownload_openwrt"

sed -i '/option ipv6_devices/d' "$root/etc/config/xboxdownload_openwrt"
uci_test set xboxdownload_openwrt.main.client=192.0.2.2,192.0.2.3
uci_test set xboxdownload_openwrt.main.ipv6_dns=1
uci_test set xboxdownload_openwrt.main.ipv6_block=0
uci_test set xboxdownload_openwrt.main.ipv6_block_ip=192.0.2.2
uci_test set xboxdownload_openwrt.main.ipv6_block_mac=02:00:00:00:00:56
uci_test add_list dhcp.lan.dns=fd10::99
uci_test commit
rpc status </dev/null | python3 -c '
import json, sys
s = json.load(sys.stdin)
assert s["ipv6_devices"] == "192.0.2.2/02:00:00:00:00:56/dns,192.0.2.3//system", s
assert {"fe80::1", "fd10::1", "2001:db8:1::1"} <= set(s["lan_ipv6_dns"].split()), s
assert s["lan_advertised_dns"] == "fd10::99", s
'

python3 - <<'PY' > "$lab/multi.json"
import json
ips = ["192.0.2." + str(i) for i in range(2, 10)]
policies = ["dns", "system", "dns", "block", "dns", "system", "block", "dns"]
rows = [f"{ip}/{'' if mode == 'system' else f'02:00:00:00:0A:{i:02X}'}/{mode}"
        for i, (ip, mode) in enumerate(zip(ips, policies))]
print(json.dumps(dict(client=",".join(ips), main_ip="203.0.113.20", legacy_ip="",
                      enabled=0, extra=json.dumps(dict(ipv6_devices=",".join(rows))))))
PY
rpc configure < "$lab/multi.json" | python3 -c 'import json, sys; assert not json.load(sys.stdin)["error"]'
rpc status </dev/null | python3 -c '
import json, sys
cfg = json.load(open(sys.argv[1]))
status = json.load(sys.stdin)
assert status["client"] == cfg["client"] and status["ipv6_devices"] == json.loads(cfg["extra"])["ipv6_devices"], status
' "$lab/multi.json"
for kind in duplicate unselected too_many; do
	python3 - "$kind" "$lab/multi.json" <<'PY' | rpc configure > "$lab/error.json"
import json, sys
kind, path = sys.argv[1:]
cfg = json.load(open(path))
extra = json.loads(cfg["extra"])
if kind == "duplicate":
    extra["ipv6_devices"] = extra["ipv6_devices"].replace("00:0A:02", "00:0a:00")
elif kind == "unselected":
    extra["ipv6_devices"] = extra["ipv6_devices"].replace("192.0.2.2/", "192.0.2.20/")
else:
    cfg["client"] += ",192.0.2.10"
cfg["extra"] = json.dumps(extra)
print(json.dumps(cfg))
PY
	python3 - "$kind" "$lab/error.json" <<'PY'
import json, sys
expected = {"duplicate": "ipv6_mac_duplicate", "unselected": "ipv6_device", "too_many": "client"}
result = json.load(open(sys.argv[2]))
assert result["error"] == expected[sys.argv[1]], result
PY
done

printf '%s\n' '{"client":"","main_ip":"","legacy_ip":"","enabled":0,"extra":"{\"ipv6_devices\":\"\"}"}' |
	rpc configure | python3 -c 'import json, sys; assert not json.load(sys.stdin)["error"]'
[ "$(uci_test get xboxdownload_openwrt.main.ipv6_devices)" = none ]
rpc status </dev/null | python3 -c 'import json, sys; assert json.load(sys.stdin)["ipv6_devices"] == ""'

create_client() {
	name=$1
	host=$2
	mac=$3
	unshare -n sh -c 'touch "$1"; exec sleep 90' sh "$lab/$name" &
	pid=$!
	children="$children $pid"
	for attempt in 1 2 3 4 5 6 7 8 9 10; do
		[ ! -e "$lab/$name" ] || break
		sleep 0.1
	done
	ip link add "$name" type veth peer name peer
	ip link set peer netns "$pid"
	ip link set "$name" master br-xbtest
	ip link set "$name" up
	nsenter -t "$pid" -n ip link set lo up
	nsenter -t "$pid" -n ip link set peer address "$mac"
	nsenter -t "$pid" -n ip link set peer up
	nsenter -t "$pid" -n ip address add "192.0.2.$host/24" dev peer
	nsenter -t "$pid" -n ip route add default via 192.0.2.1 dev peer
	nsenter -t "$pid" -n ip -6 address add "fe80::$host/64" dev peer nodad
	nsenter -t "$pid" -n ip -6 address add "fd10::$host/64" dev peer nodad
	nsenter -t "$pid" -n ip -6 address add "2001:db8:1::$host/64" dev peer nodad
	nsenter -t "$pid" -n ip -6 route add default via fe80::1 dev peer
}

create_client xbox 2 02:00:00:00:00:56
xbox=$pid
create_client other 3 02:00:00:00:00:55
other=$pid
create_client second 4 02:00:00:00:00:54
second=$pid
create_client blocked 5 02:00:00:00:00:53
blocked=$pid
sysctl -qw net.ipv6.conf.all.forwarding=1
unshare -n sh -c 'touch "$1"; exec sleep 90' sh "$lab/upstream" &
upstream=$!
children="$children $upstream"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
	[ ! -e "$lab/upstream" ] || break
	sleep 0.1
done
ip link add wan type veth peer name upstream
ip link set upstream netns "$upstream"
ip link set wan up
ip -6 address add 2001:db8:2::1/64 dev wan nodad
nsenter -t "$upstream" -n ip link set upstream up
nsenter -t "$upstream" -n ip -6 address add 2001:db8:2::2/64 dev upstream nodad
nsenter -t "$upstream" -n ip -6 route add 2001:db8:1::/64 via 2001:db8:2::1 dev upstream

cat > "$root/tmp/generate.sh" <<'EOF'
set -e
. /lib/functions.sh
. /etc/init.d/xboxdownload_openwrt
load_settings
mode=redirect
enabled=1
lan_dev=br-xbtest
lan_ip=192.0.2.1
client=192.0.2.2,192.0.2.4,192.0.2.5,192.0.2.3
ipv6_devices=192.0.2.2/02:00:00:00:00:56/dns,192.0.2.4/02:00:00:00:00:54/dns,192.0.2.5/02:00:00:00:00:53/block,192.0.2.3//system
main_ip=203.0.113.20
legacy_ip=2001:db8:3::10
[ "$(validate_settings)" = ipv6_cdn ]
legacy_ip=203.0.113.10
app_ip=2001:db8:3::20
[ "$(validate_settings)" = ipv6_cdn ]
app_ip=
validate_settings
filter_aaaa=1
[ "$(validate_settings)" = ipv6_filter ]
filter_aaaa=0
write_dns > "$RUNDIR/dnsmasq.conf"
write_firewall > "$RUNDIR/rules.nft"
nft -c -f "$RUNDIR/rules.nft"
echo dual-stack-test > "$RUNDIR/instance"
EOF
chroot "$root" sh /tmp/generate.sh

chroot "$root" /usr/sbin/dnsmasq -k -C /dev/null --no-resolv --interface=br-xbtest --bind-interfaces \
	--local=/com/net/ --host-record=www.microsoft.com,203.0.113.40 \
	--host-record=ordinary.test,203.0.113.40,2001:db8:4::40 \
	--host-record=assets1.xboxlive.com,203.0.113.50,2001:db8:4::50 \
	--host-record=assets1.xboxlive.cn,203.0.113.60,2001:db8:4::60 --pid-file=/tmp/system-dns.pid &
children="$children $!"
sleep 0.5
chroot "$root" /usr/share/xboxdownload_openwrt/supervise dual-stack-test 192.0.2.1 redirect '' '[fe80::1%br-xbtest]:15353' &
supervisor=$!
children="$children $supervisor"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
	[ ! -s "$root/tmp/run/xboxdownload_openwrt/ready" ] || break
	kill -0 "$supervisor" 2>/dev/null || break
	sleep 0.5
done
if [ ! -s "$root/tmp/run/xboxdownload_openwrt/ready" ]; then
	cat "$root/tmp/run/xboxdownload_openwrt/error" >&2
	exit 1
fi

expect() {
	expected=$1
	client=$2
	shift 2
	actual=$(nsenter -t "$client" -n dig +tries=1 +time=2 +short "$@")
	if [ "$actual" != "$expected" ]; then
		printf 'Expected <%s>, got <%s> for %s\n' "$expected" "$actual" "$*" >&2
		exit 1
	fi
}

expect 192.0.0.8 "$xbox" @192.0.2.1 assets1.xboxlive.com A
expect 192.0.0.8 "$xbox" @fe80::1%peer assets1.xboxlive.com A
expect 192.0.0.8 "$xbox" @fd10::1 assets1.xboxlive.com A +tcp
expect '' "$xbox" @2001:db8:1::1 assets1.xboxlive.com AAAA
expect '0 0 80 assets1.xboxlive.com.' "$xbox" @fd10::1 assets-srvs.xboxlive.com SRV +tcp
expect 203.0.113.20 "$xbox" @fd10::1 assets1.xboxlive.cn A
expect '' "$xbox" @fd10::1 assets1.xboxlive.cn AAAA
expect '' "$xbox" @fd10::1 dlassets.xboxlive.cn AAAA
expect 192.0.0.8 "$second" @fe80::1%peer assets1.xboxlive.com A
expect 192.0.0.8 "$second" @fd10::1 assets1.xboxlive.com A +tcp
expect 2001:db8:4::40 "$second" @fd10::1 ordinary.test AAAA
expect 192.0.0.8 "$blocked" @192.0.2.1 assets1.xboxlive.com A
expect 192.0.0.8 "$other" @192.0.2.1 assets1.xboxlive.com A
nsenter -t "$xbox" -n ip link set peer address 02:00:00:00:00:67
ip neigh replace 192.0.2.2 lladdr 02:00:00:00:00:67 nud permanent dev br-xbtest
expect 203.0.113.50 "$xbox" -b '192.0.2.2#52982' @192.0.2.1 assets1.xboxlive.com A
expect 203.0.113.50 "$xbox" -b '192.0.2.2#52983' @192.0.2.1 assets1.xboxlive.com A +tcp
nsenter -t "$xbox" -n ip link set peer address 02:00:00:00:00:56
ip neigh replace 192.0.2.2 lladdr 02:00:00:00:00:56 nud permanent dev br-xbtest
expect 192.0.0.8 "$xbox" -b '192.0.2.2#52984' @192.0.2.1 assets1.xboxlive.com A
echo 'PASS: IPv4 DNS bypasses the plugin when the saved address has a different MAC'
if nsenter -t "$blocked" -n dig +tries=1 +time=1 @fd10::1 ordinary.test A >/dev/null 2>&1 ||
	nsenter -t "$blocked" -n ping -6 -c 1 -W 1 2001:db8:2::2 >/dev/null 2>&1; then
	echo 'IPv6 blocking failed for the selected device' >&2
	exit 1
fi
nsenter -t "$blocked" -n ping -6 -c 1 -W 2 fd10::1 >/dev/null
for peer in "$xbox" "$second" "$other"; do
	nsenter -t "$peer" -n ping -6 -c 1 -W 2 2001:db8:2::2 >/dev/null
done
expect 2001:db8:4::40 "$xbox" @fd10::1 ordinary.test AAAA +tcp
expect 2001:db8:4::40 "$xbox" @192.0.2.1 ordinary.test AAAA
expect 2001:db8:4::50 "$other" @fd10::1 assets1.xboxlive.com AAAA
expect 192.0.0.8 "$xbox" -b 'fd10::2#52981' @fd10::1 assets1.xboxlive.com A
nsenter -t "$xbox" -n curl --noproxy '*' -sS -I --max-time 4 \
	--resolve assets1.xboxlive.com:80:192.0.0.8 http://assets1.xboxlive.com/game |
	grep -qi '^Location: http://assets1.xboxlive.cn/game'
if nsenter -t "$other" -n dig +tries=1 +time=1 @fd10::1 -p 15353 ordinary.test A >/dev/null 2>&1; then
	echo 'The system-mode device reached the private DNS port' >&2
	exit 1
fi

kill "$supervisor"
wait "$supervisor"
expect 203.0.113.50 "$second" @fd10::1 assets1.xboxlive.com A
expect 203.0.113.40 "$blocked" @fd10::1 ordinary.test A
nsenter -t "$blocked" -n ping -6 -c 1 -W 2 2001:db8:2::2 >/dev/null
expect 203.0.113.50 "$xbox" -b 'fd10::2#52981' @fd10::1 assets1.xboxlive.com A
echo missing-ipv6 > "$root/tmp/run/xboxdownload_openwrt/instance"
if chroot "$root" /usr/share/xboxdownload_openwrt/supervise missing-ipv6 192.0.2.1 redirect '' '[::1]:15354'; then
	echo 'IPv6 DNS health check unexpectedly passed' >&2
	exit 1
fi
[ ! -e "$root/tmp/run/xboxdownload_openwrt/ready" ]
if chroot "$root" nft list table inet xboxdownload_openwrt_ipv6 >/dev/null 2>&1; then
	echo 'IPv6 rules remained after a failed startup' >&2
	exit 1
fi
expect 203.0.113.50 "$xbox" @fd10::1 assets1.xboxlive.com A
echo 'PASS: mixed per-device IPv6 policies, IPv4 acceleration, and startup/stop fallback'
