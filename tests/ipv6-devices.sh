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
sed -i 's/sleep 30 /sleep 1 /' "$root/usr/share/xboxdownload_openwrt/supervise"

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
network_get_subnets() {
	[ ! -e /tmp/no-lan-subnet ] || return 1
	export "$1=192.0.2.1/24 198.51.100.129/25 10.11.12.0/31"
}
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
print(json.dumps(dict(client=",".join(ips), main_ip="93.184.216.20", legacy_ip="",
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

assert_rpc_error() {
	printf '%s\n' "$3" | rpc "$2" | python3 -c '
import json, sys
result = json.load(sys.stdin)
assert result["error"] == sys.argv[1], result
' "$1"
}

assert_rpc_error '' validate_addresses '{"kind":"nodes","addresses":"93.184.216.20\n2606:4700::1111\n192.0.0.9\n2001:1::3"}'
for node in 192.0.0.8 192.0.2.1 198.18.0.1 203.0.113.1 100.64.0.1 8.8.8.08 2001:db8::1 3fff::1 2001:2::1 2002::1 2001::::1 2606:1::2::3; do
	assert_rpc_error cdn validate_addresses "{\"kind\":\"nodes\",\"addresses\":\"$node\"}"
	assert_rpc_error cdn probe "{\"group\":\"main\",\"ip\":\"$node\"}"
done
assert_rpc_error cdn configure '{"main_ip":"198.18.0.1","enabled":0}'

assert_rpc_error cdn_family configure '{"main_ip":"2606:4700::1111","enabled":0}'
assert_rpc_error cdn_family probe '{"group":"main","ip":"2606:4700::1111"}'
assert_rpc_error cdn_family probe '{"group":"legacy","family":6}'
assert_rpc_error '' configure '{"enabled":0,"client":"192.0.2.2,192.0.2.3","extra":"{\"ipv6_devices\":\"192.0.2.2/02:00:00:00:00:56/dns,192.0.2.3/02:00:00:00:00:55/block\",\"device_routes\":\"192.0.2.2/0/198.51.100.2///2606:4700::1111/////,192.0.2.3/0//93.184.216.30///////\"}"}'
rpc status </dev/null | python3 -c '
import json, sys
data = json.load(sys.stdin)
assert data["device_routes"] == "192.0.2.2/0/198.51.100.2///2606:4700::1111/////,192.0.2.3/0//93.184.216.30///////", data
'
assert_rpc_error device_routes configure '{"extra":"{\"device_routes\":\"192.0.2.4/0//93.184.216.30///////\"}"}'
assert_rpc_error cdn_family configure '{"extra":"{\"device_routes\":\"192.0.2.2/0//2606:4700::1111///////\"}"}'
assert_rpc_error ipv6_cdn configure '{"extra":"{\"device_routes\":\"192.0.2.3/0////2606:4700::1111/////\"}"}'
assert_rpc_error ipv6_filter configure '{"extra":"{\"device_routes\":\"192.0.2.2/1//93.184.216.30///////\"}"}'
assert_rpc_error '' configure '{"client":"","main_ip":"","legacy_ip":"","enabled":0,"extra":"{\"ipv6_devices\":\"\",\"device_routes\":\"\"}"}'
echo 'PASS: custom device routes round-trip and reject incompatible or unselected rows'

cat > "$root/usr/bin/curl" <<'EOF'
#!/bin/sh
[ ! -e /tmp/stale-list ] || exit 1
range=
max=
while [ "$1" != -o ]; do
	case "$1" in
		--range) range=$2; shift ;;
		--max-filesize) max=$2; shift ;;
	esac
	shift
done
case "$3" in
	-w)
		printf '%s %s\n' "$range" "$max" > /tmp/probe-limit
		if [ -e /tmp/connect-metrics ]; then
			printf '206|93.184.216.20|0.007|524288|1048576|0.004\n'
		elif [ -e /tmp/probe-no-connection ]; then
			printf '000||0.000|0|0|0.002\n'
			exit 7
		else
			printf '206|198.18.0.1|0.001|1024|1024|0.000\n'
		fi
		;;
	*AkamaiV6.txt)
		printf 'AkamaiV6\n2606:4700::1111 (Global)\n2001:db8::1 (Documentation)\n2606:1::2::3 (Malformed)\n8.8.8.8 (Wrong family)\n' > "$2"
		;;
	*XboxCn1.txt)
		printf 'XboxCn1\n93.184.216.20 (Global)\n93.184.216.20 (Duplicate)\n192.0.0.8 (Dummy)\n198.18.0.1 (Benchmark)\n2606:4700::1111 (Wrong family)\n' > "$2"
		;;
esac
EOF
chmod +x "$root/usr/bin/curl"
assert_rpc_error cdn probe '{"group":"main"}'
[ "$(cat "$root/tmp/probe-limit")" = '0-52428799 52428800' ]
assert_rpc_error cdn probe '{"group":"main","sample":1,"max_bytes":0}'
[ "$(cat "$root/tmp/probe-limit")" = '0-1048575 1048576' ]
printf '%s\n' '{"group":"main","sample":1,"max_bytes":951424}' | rpc probe | python3 -c '
import json, sys
assert json.load(sys.stdin) == {"error": "cdn", "bytes": "1024"}
'
[ "$(cat "$root/tmp/probe-limit")" = '0-951423 951424' ]
assert_rpc_error invalid probe '{"group":"main","max_bytes":-1}'
echo 'PASS: probe uses the remaining byte budget and reports bytes even for a rejected result'
touch "$root/tmp/connect-metrics"
sample_url='http://dl.delivery.mp.microsoft.com/sample?token=fixture'
printf '%s\n%s\n' "$(date +%s)" "$sample_url" > "$root/tmp/run/xboxdownload_openwrt/app-sample-v2"
printf '%s\n' '{"group":"app","sample":1}' | rpc probe | python3 -c '
import hashlib, json, sys
data = json.load(sys.stdin)
assert data["namelookup"] == "0.004" and data["connect"] == "0.007", data
assert data["sample_id"] == hashlib.sha256(sys.argv[1].encode()).hexdigest(), data
assert sys.argv[1] not in json.dumps(data), data
' "$sample_url"
rm "$root/tmp/connect-metrics"
touch "$root/tmp/probe-no-connection"
printf '%s\n' '{"group":"main"}' | rpc probe | python3 -c '
import json, sys
data = json.load(sys.stdin)
assert data["exit"] == 7 and data["ip"] == "" and data["bytes"] == "0", data
assert data["connect"] == "0.000" and data["namelookup"] == "0.002", data
'
rm "$root/tmp/probe-no-connection"
echo 'PASS: probes return separate DNS and TCP timing and identify an app sample by its digest'
assert_nodes() {
	printf '{"source":"%s"}\n' "$1" | rpc import_nodes | python3 -c '
import json, sys
result = json.load(sys.stdin)
assert result["nodes"].splitlines() == [sys.argv[1] + "\tGlobal"], result
assert result["origin"] == sys.argv[2], result
' "$2" "$3"
}
assert_nodes cn1 93.184.216.20 github
assert_nodes akamai6 2606:4700::1111 github
touch "$root/tmp/stale-list"
cache="$root/tmp/run/xboxdownload_openwrt/nodes/XboxCn1.tsv"
printf '198.18.0.1\tOld invalid entry\n' >> "$cache"
assert_nodes cn1 93.184.216.20 stale
printf '198.18.0.1\tOld invalid entry\n' > "$cache"
assert_rpc_error import import_nodes '{"source":"cn1"}'
echo 'PASS: manual addresses, probes, configuration, imports and cached lists enforce the same CDN policy'

for address in 192.0.2.20 198.51.100.130 10.11.12.1; do
	assert_rpc_error '' validate_addresses "{\"kind\":\"client\",\"addresses\":\"$address\"}"
done
for address in 192.0.2.0 192.0.2.255 192.0.2.1 198.51.100.129 198.51.100.1 10.11.12.0 192.168.1.3; do
	assert_rpc_error client_subnet validate_addresses "{\"kind\":\"client\",\"addresses\":\"$address\"}"
	assert_rpc_error client_subnet configure "{\"client\":\"$address\",\"enabled\":0}"
done
touch "$root/tmp/no-lan-subnet"
assert_rpc_error lan_subnet validate_addresses '{"kind":"client","addresses":"192.0.2.2"}'
assert_rpc_error lan_subnet configure '{"client":"192.0.2.2","enabled":0}'
uci_test set xboxdownload_openwrt.main.client=192.168.1.3
uci_test set xboxdownload_openwrt.main.main_ip=198.18.0.1
uci_test commit xboxdownload_openwrt
assert_rpc_error '' configure '{"enabled":0}'
rm "$root/tmp/no-lan-subnet"
assert_rpc_error client_subnet configure '{"enabled":1}'
assert_rpc_error cdn configure '{"client":"192.0.2.2","enabled":1}'
assert_rpc_error '' configure '{"client":"","main_ip":"","enabled":0}'
echo 'PASS: LAN aliases, broadcast, /31, and unavailable or renumbered LANs are handled consistently'

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
lan_subnets=192.0.2.1/24
client=192.0.2.2,192.0.2.4,192.0.2.5,192.0.2.3
ipv6_devices=192.0.2.2/02:00:00:00:00:56/dns,192.0.2.4/02:00:00:00:00:54/dns,192.0.2.5/02:00:00:00:00:53/block,192.0.2.3//system
device_routes=192.0.2.4/0/198.51.100.2///2606:4700::1111/////,192.0.2.5/0//93.184.216.30///////
log_mode=all
uci -q set "xboxdownload_openwrt.main.client=$client"
uci -q set "xboxdownload_openwrt.main.ipv6_devices=$ipv6_devices"
uci -q set "xboxdownload_openwrt.main.log_mode=$log_mode"
uci -q commit xboxdownload_openwrt
main_ip=93.184.216.20
legacy_ip=2606:4700::1111
[ "$(validate_settings)" = cdn_family ]
legacy_ip=93.184.216.10
validate_settings
filter_aaaa=1
validate_settings
prepare_https_origins
grep -qx 'assets1.xboxlive.com 192.0.0.8 93.184.216.50' "$HTTPS_ORIGINS"
grep -qx 'dlassets.xboxlive.com 198.19.83.11 93.184.216.51' "$HTTPS_ORIGINS"
write_dns > "$RUNDIR/dnsmasq.conf"
prepare_dns_profiles
write_firewall > "$RUNDIR/rules.nft"
write_firewall bypass > "$RUNDIR/bypass.nft"
nft -c -f "$RUNDIR/rules.nft"
nft -c -f "$RUNDIR/bypass.nft"
echo dual-stack-test > "$RUNDIR/instance"
EOF
mkdir -p "$root/var/run/ubus"
chroot "$root" /sbin/ubusd &
children="$children $!"
chroot "$root" /sbin/logd -S 64 &
children="$children $!"
for attempt in $(seq 1 25); do
	if chroot "$root" ubus list log 2>/dev/null | grep -qx log && [ -S "$root/dev/log" ]; then break; fi
	sleep 0.2
done
chroot "$root" ubus list log | grep -qx log
[ -S "$root/dev/log" ]
ip address add 198.51.100.2/32 dev lo
chroot "$root" /usr/sbin/dnsmasq -k -C /dev/null --no-resolv --listen-address=198.51.100.2 --bind-interfaces \
	--host-record=www.microsoft.com,93.184.216.41 --host-record=ordinary.test,93.184.216.41,2001:db8:4::41 \
	--pid-file=/tmp/custom-dns.pid &
custom_dns=$!
children="$children $custom_dns"
chroot "$root" /usr/sbin/dnsmasq -k -C /dev/null --no-resolv --interface=br-xbtest --except-interface=lo --bind-interfaces \
	--log-queries=extra --log-facility=local5 \
	--local=/com/net/ --host-record=www.microsoft.com,93.184.216.40 \
	--host-record=ordinary.test,93.184.216.40,2001:db8:4::40 \
	--host-record=assets1.xboxlive.com,93.184.216.50,2001:db8:4::50 \
	--host-record=dlassets.xboxlive.com,93.184.216.51 \
	--host-record=assets1.xboxlive.cn,93.184.216.60,2001:db8:4::60 --pid-file=/tmp/system-dns.pid &
children="$children $!"
sleep 0.5
chroot "$root" sh /tmp/generate.sh
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
nsenter -t "$xbox" -n dig +tries=1 +time=2 +noall +answer @192.0.2.1 assets1.xboxlive.com A |
	awk '$2 == 0 && $4 == "A" && $5 == "192.0.0.8" { found=1 } END { exit !found }'
expect 192.0.0.8 "$xbox" @fe80::1%peer assets1.xboxlive.com A
expect 192.0.0.8 "$xbox" @fd10::1 assets1.xboxlive.com A +tcp
expect '' "$xbox" @2001:db8:1::1 assets1.xboxlive.com AAAA
expect '0 0 80 assets1.xboxlive.com.' "$xbox" @fd10::1 assets-srvs.xboxlive.com SRV +tcp
expect 93.184.216.20 "$xbox" @fd10::1 assets1.xboxlive.cn A
expect '' "$xbox" @fd10::1 assets1.xboxlive.cn AAAA
expect '' "$xbox" @fd10::1 dlassets.xboxlive.cn AAAA
expect 2606:4700::1111 "$second" @fe80::1%peer assets1.xboxlive.com AAAA
expect 2001:db8:4::41 "$second" @fd10::1 ordinary.test AAAA
expect 93.184.216.41 "$second" @192.0.2.1 ordinary.test A +tcp
expect 2606:4700::1111 "$second" @fd10::1 assets1.xboxlive.com AAAA +tcp
expect 93.184.216.30 "$blocked" @192.0.2.1 assets1.xboxlive.cn A
expect '' "$other" @192.0.2.1 ordinary.test AAAA
echo 'PASS: an IPv6 CDN and a separate upstream are isolated from the blocked and default devices'
expect 192.0.0.8 "$blocked" @192.0.2.1 assets1.xboxlive.com A
expect 192.0.0.8 "$other" @192.0.2.1 assets1.xboxlive.com A
expect 198.19.83.11 "$xbox" @192.0.2.1 dlassets.xboxlive.com A
nsenter -t "$xbox" -n ip link set peer address 02:00:00:00:00:67
ip neigh replace 192.0.2.2 lladdr 02:00:00:00:00:67 nud permanent dev br-xbtest
expect 93.184.216.50 "$xbox" -b '192.0.2.2#52982' @192.0.2.1 assets1.xboxlive.com A
expect 93.184.216.50 "$xbox" -b '192.0.2.2#52983' @192.0.2.1 assets1.xboxlive.com A +tcp
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
rpc status </dev/null | python3 -c '
import json, sys
rows = [row.split("\t", 3)[1:] for row in json.load(sys.stdin)["log"].splitlines()]
queries = {(kind, addr.split("%", 1)[0], detail) for kind, addr, detail in rows if kind.startswith("DNS ")}
assert ("DNS A", "192.0.2.2", "assets1.xboxlive.com") in queries, rows
assert ("DNS A", "fe80::2", "assets1.xboxlive.com") in queries, rows
assert ("DNS SRV", "fd10::2", "assets-srvs.xboxlive.com") in queries, rows
assert ("DNS AAAA", "2001:db8:1::2", "assets1.xboxlive.com") in queries, rows
assert ("DNS AAAA", "fd10::4", "ordinary.test") in queries, rows
assert not any(addr in {"fd10::3", "fe80::1", "fd10::1", "::1"} for _, addr, _ in queries), rows
assert any(kind == "HTTP 302" and addr == "192.0.2.2" for kind, addr, _ in rows), rows
'
rpc clear_logs </dev/null | python3 -c 'import json, sys; assert not json.load(sys.stdin)["error"]'
rpc status </dev/null | python3 -c 'import json, sys; assert not json.load(sys.stdin)["log"]'
echo 'PASS: DNS query logs include selected IPv4 and IPv6 clients and exclude other IPv6 sources'
if nsenter -t "$other" -n dig +tries=1 +time=1 @fd10::1 -p 15353 ordinary.test A >/dev/null 2>&1; then
	echo 'The system-mode device reached the private DNS port' >&2
	exit 1
fi

run="$root/tmp/run/xboxdownload_openwrt"
resolver_pid=$(cat "$run/dnsmasq.pid")
# Break only the supervisor's TCP probe to the local IPv6 listener.
chroot "$root" nft -f - <<'EOF'
table inet dns_probe_fault {
	chain output {
		type filter hook output priority 0; policy accept;
		ip6 daddr fe80::1 tcp dport 15353 drop
	}
}
EOF
for attempt in $(seq 1 100); do
	[ "$(cat "$run/upstream-state")" != dns_unavailable ] || break
	sleep 0.2
done
[ "$(cat "$run/upstream-state")" = dns_unavailable ]
[ ! -e "$run/ready" ]
expect 93.184.216.50 "$xbox" @192.0.2.1 assets1.xboxlive.com A
expect 93.184.216.50 "$xbox" @fd10::1 assets1.xboxlive.com A +tcp
nsenter -t "$blocked" -n ping -6 -c 1 -W 2 2001:db8:2::2 >/dev/null
if nsenter -t "$xbox" -n dig +tries=1 +time=1 @fd10::1 -p 15353 ordinary.test A >/dev/null 2>&1; then
	echo 'The private IPv6 DNS port was reachable while interception was paused' >&2
	exit 1
fi
chroot "$root" nft delete table inet dns_probe_fault
for attempt in $(seq 1 100); do
	[ ! -s "$run/ready" ] || break
	sleep 0.2
done
[ "$(cat "$run/ready")" = dual-stack-test ]
[ "$(cat "$run/upstream-state")" = normal ]
[ "$(cat "$run/dnsmasq.pid")" = "$resolver_pid" ]
expect 192.0.0.8 "$xbox" @192.0.2.1 assets1.xboxlive.com A
expect 192.0.0.8 "$xbox" @fd10::1 assets1.xboxlive.com A +tcp
echo 'PASS: a runtime IPv6 TCP probe failure pauses interception until local DNS recovers'

ip address add 192.0.0.8/32 dev lo
ip address add 93.184.216.50/32 dev lo
sysctl -qw net.ipv4.ip_forward=1
ip address add 198.51.100.129/30 dev wan
nsenter -t "$upstream" -n ip address add 198.51.100.130/30 dev upstream
nsenter -t "$upstream" -n ip link set lo up
nsenter -t "$upstream" -n ip address add 93.184.216.51/32 dev lo
nsenter -t "$upstream" -n ip route add 192.0.2.0/24 via 198.51.100.129
ip route add 93.184.216.51/32 via 198.51.100.130
nsenter -t "$xbox" -n curl --noproxy '*' -sS -I --max-time 4 \
	--resolve dlassets.xboxlive.com:80:198.19.83.11 http://dlassets.xboxlive.com/game |
	grep -qi '^Location: http://dlassets.xboxlive.cn/game'
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=dlassets.xboxlive.com \
	-addext subjectAltName=DNS:dlassets.xboxlive.com -keyout "$lab/tls.key" -out "$lab/tls.pem" >/dev/null 2>&1
nsenter -t "$upstream" -n openssl s_server -quiet -www -accept 93.184.216.51:443 \
	-key "$lab/tls.key" -cert "$lab/tls.pem" >/dev/null 2>&1 &
children="$children $!"
for attempt in $(seq 1 25); do
	if nsenter -t "$upstream" -n ss -H -4 -ltn 'sport = :443' | grep -Fq '93.184.216.51:443'; then break; fi
	sleep 0.2
done
[ "$(nsenter -t "$xbox" -n curl --noproxy '*' -fsS -o /dev/null --max-time 4 --cacert "$lab/tls.pem" \
	--resolve dlassets.xboxlive.com:443:198.19.83.11 --write-out '%{http_code}' https://dlassets.xboxlive.com/)" = 200 ]
echo 'PASS: the same redirected hostname reaches its original TLS server on port 443 with certificate verification'
printf 'download from system DNS origin\n' > "$lab/game"
python3 -m http.server 80 --bind 0.0.0.0 --directory "$lab" >/dev/null 2>&1 &
children="$children $!"
for attempt in $(seq 1 25); do
	if ss -H -4 -ltn 'sport = :80' | grep -Fq '0.0.0.0:80'; then break; fi
	sleep 0.2
done
ss -H -4 -ltn 'sport = :80' | grep -Fq '0.0.0.0:80'
chroot "$root" nft -f - <<'EOF'
table ip http_probe {
	chain input {
		type filter hook input priority 0; policy accept;
		iifname "br-xbtest" ip saddr 192.0.2.2 tcp dport 18080 ct zone 53980 ct status dnat counter
	}
}
EOF
expect_http() {
	nsenter -t "$xbox" -n python3 - "$1" <<'PY'
import socket
import struct
import sys

with socket.socket() as connection:
    connection.settimeout(3)
    connection.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
    connection.bind(('192.0.2.2', 52985))
    try:
        connection.connect(('192.0.0.8', 80))
    except OSError as error:
        raise RuntimeError(f'Could not connect for the expected HTTP {sys.argv[1]} response') from error
    connection.sendall(b'HEAD / HTTP/1.1\r\nHost: assets1.xboxlive.com\r\nConnection: close\r\n\r\n')
    with connection.makefile('rb') as response:
        status = response.readline().split()
        assert status[1] == sys.argv[1].encode(), status
PY
}
expect_http 302
chroot "$root" nft list chain ip http_probe input | grep -Eq 'counter packets [1-9]'

# Keep the same caching resolver running on the client across plugin shutdown.
nsenter -t "$xbox" -n chroot "$root" /usr/sbin/dnsmasq -k -C /dev/null \
	--no-resolv --no-hosts --listen-address=127.0.0.1 --bind-interfaces --port=15553 \
	--cache-size=64 --server=192.0.2.1#53 --pid-file=/tmp/client-dns.pid &
children="$children $!"
for attempt in $(seq 1 25); do
	if nsenter -t "$xbox" -n ss -H -ulpn 'sport = :15553' | grep -q dnsmasq; then break; fi
	sleep 0.2
done
expect_zero_ttl() {
	nsenter -t "$xbox" -n dig +tries=1 +time=2 +noall +answer @127.0.0.1 -p 15553 "$1" A |
		awk -v ip="$2" '$2 == 0 && $4 == "A" && $5 == ip { found=1 } END { exit !found }'
}
expect_zero_ttl assets1.xboxlive.com 192.0.0.8
expect_zero_ttl assets1.xboxlive.cn 93.184.216.20
expect '' "$xbox" @127.0.0.1 -p 15553 assets1.xboxlive.com AAAA
kill "$supervisor"
wait "$supervisor"
expect 93.184.216.50 "$xbox" @127.0.0.1 -p 15553 assets1.xboxlive.com A
expect 93.184.216.60 "$xbox" @127.0.0.1 -p 15553 assets1.xboxlive.cn A
expect 2001:db8:4::50 "$xbox" @127.0.0.1 -p 15553 assets1.xboxlive.com AAAA
origin=$(nsenter -t "$xbox" -n dig +tries=1 +time=2 +short @127.0.0.1 -p 15553 assets1.xboxlive.com A)
nsenter -t "$xbox" -n curl --noproxy '*' -fsS --max-time 4 \
	--resolve "assets1.xboxlive.com:80:$origin" http://assets1.xboxlive.com/game > "$lab/download"
cmp "$lab/game" "$lab/download"
echo 'PASS: a client DNS cache uses the system answers immediately after stop and a new download succeeds'
expect_http 200
echo 'PASS: a reused HTTP source port reaches the original destination after interception stops'
expect 93.184.216.50 "$second" @fd10::1 assets1.xboxlive.com A
expect 93.184.216.40 "$blocked" @fd10::1 ordinary.test A
nsenter -t "$blocked" -n ping -6 -c 1 -W 2 2001:db8:2::2 >/dev/null
expect 93.184.216.50 "$xbox" -b 'fd10::2#52981' @fd10::1 assets1.xboxlive.com A
echo missing-ipv6 > "$root/tmp/run/xboxdownload_openwrt/instance"
if chroot "$root" /usr/share/xboxdownload_openwrt/supervise missing-ipv6 192.0.2.1 redirect '' '[::1]:15499'; then
	echo 'IPv6 DNS health check unexpectedly passed' >&2
	exit 1
fi
[ ! -e "$root/tmp/run/xboxdownload_openwrt/ready" ]
if chroot "$root" nft list table inet xboxdownload_openwrt_ipv6 >/dev/null 2>&1; then
	echo 'IPv6 rules remained after a failed startup' >&2
	exit 1
fi
expect 93.184.216.50 "$xbox" @fd10::1 assets1.xboxlive.com A
echo 'PASS: mixed per-device IPv6 policies, IPv4 acceleration, and startup/stop fallback'
