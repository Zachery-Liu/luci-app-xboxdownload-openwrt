#!/bin/sh
# Run as root on Linux with an OpenWrt rootfs including dnsmasq, uhttpd and nft.
# OPENWRT_ROOTFS=/path/to/openwrt-root.tar.gz sh tests/reliability.sh
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
cp -R package/root/. "$root/"
run="$root/tmp/run/xboxdownload_openwrt"
data="$root/usr/share/xboxdownload_openwrt"
rpc="$root/usr/libexec/rpcd/xboxdownload_openwrt"
mkdir -p "$run" "$root/tmp/lock" "$root/dev"
[ -c "$root/dev/null" ] || mknod "$root/dev/null" c 1 3
[ -c "$root/dev/urandom" ] || mknod "$root/dev/urandom" c 1 9
chmod +x "$data/supervise" "$data/http/cgi-bin/redirect" "$rpc"
# Shorten only the periodic interval in this isolated copy.
sed -i 's/sleep 30 \&/sleep 1 \&/' "$data/supervise"

ip link set lo up
ip addr add 192.0.2.1/24 dev lo
ip addr add 192.0.2.9/24 dev lo
chroot "$root" sh -ec '
	. /lib/functions.sh
	. /etc/init.d/xboxdownload_openwrt
	load_settings
	lan_ip=192.0.2.1
	lan_dev=lo
	client=192.0.2.2
	upstream=192.0.2.9
	ipv6_devices=
	write_dns > "$RUNDIR/dnsmasq.conf"
	write_firewall > "$RUNDIR/rules.nft"
'

wait_value() {
	for attempt in $(seq 1 100); do
		if [ "$(cat "$1" 2>/dev/null || true)" = "$2" ]; then return 0; fi
		sleep 0.2
	done
	printf 'Expected %s in %s\n' "$2" "$1" >&2
	if [ -r "$run/error" ]; then cat "$run/error" >&2; fi
	return 1
}

launch_dns() {
	local host_record="www.microsoft.com,$2"
	chroot "$root" /usr/sbin/dnsmasq -k -C /dev/null --no-resolv --bind-interfaces \
		--listen-address="$1" --local=/com/net/ --address="/ordinary.test/$2" \
		--host-record="$host_record" \
		--host-record=assets1.xboxlive.com,203.0.113.70 --host-record=dlassets.xboxlive.com,203.0.113.71 \
		--pid-file="/tmp/upstream-$1.pid" &
	dns=$!
	children="$children $dns"
	sleep 0.2
}

launch_supervisor() {
	printf '%s\n' "$1" > "$run/instance"
	chroot "$root" "$DATA_PATH/supervise" "$1" 192.0.2.1 redirect 192.0.2.9 '' "${2:-}" &
	supervisor=$!
	children="$children $supervisor"
}

assert_rules_removed() {
	[ ! -e "$run/ready" ]
	rules=$(chroot "$root" nft list tables)
	! printf '%s\n' "$rules" | grep -Fq 'xboxdownload_openwrt'
}

DATA_PATH=/usr/share/xboxdownload_openwrt
launch_dns 192.0.2.1 203.0.113.10
chroot "$root" /usr/sbin/dnsmasq -k -C /dev/null --no-resolv --bind-interfaces \
	--listen-address=192.0.2.9 --local=/com/net/ --server=/ordinary.test/192.0.2.99 \
	--pid-file=/tmp/nxdomain-only.pid &
negative_dns=$!
children="$children $negative_dns"
sleep 0.2
launch_supervisor nxdomain-only
wait_value "$run/ready" nxdomain-only
wait_value "$run/upstream-state" fallback
query() { dig +short +tries=1 +time=2 @127.0.0.1 -p 15353 "$1"; }
[ "$(query fallback.ordinary.test)" = 203.0.113.10 ]
[ "$(query assets1.xboxlive.com)" = 192.0.0.8 ]
kill "$supervisor" "$negative_dns"
wait "$supervisor"
wait "$negative_dns"
echo 'PASS: local NXDOMAIN responses alone cannot keep DNS on the broken upstream'

chroot "$root" /usr/sbin/dnsmasq -k -C /dev/null --no-resolv --bind-interfaces \
	--listen-address=192.0.2.9 --local=/com/net/ \
	--host-record=probe.example.test,203.0.113.20 --address=/ordinary.test/203.0.113.20 \
	--pid-file=/tmp/custom-probe.pid &
custom_dns=$!
children="$children $custom_dns"
sleep 0.2
launch_supervisor custom-probe probe.example.test
wait_value "$run/ready" custom-probe
[ "$(query custom.ordinary.test)" = 203.0.113.20 ]
kill "$supervisor" "$custom_dns"
wait "$supervisor"
wait "$custom_dns"
echo 'PASS: a custom hostname works when the default DNS probe names are blocked'

launch_dns 192.0.2.9 203.0.113.20
preferred_dns=$dns
cp "$data/domains" "$lab/domains"
sed -i 's/\(assets1.xboxlive.com \)assets1.xboxlive.cn/\1wrong.invalid/' "$data/domains"
launch_supervisor bad-redirect
if wait "$supervisor"; then echo 'Invalid redirect started successfully' >&2; exit 1; fi
wait_value "$run/error" 'Could not verify HTTP 302 redirects'
assert_rules_removed
cp "$lab/domains" "$data/domains"

launch_supervisor healthy-redirect
wait_value "$run/ready" healthy-redirect
resolver_pid=$(cat "$run/dnsmasq.pid")
[ "$(query first.ordinary.test)" = 203.0.113.20 ]
kill "$preferred_dns"
wait "$preferred_dns"
wait_value "$run/upstream-state" fallback
[ "$(query second.ordinary.test)" = 203.0.113.10 ]
launch_dns 192.0.2.9 203.0.113.20
wait_value "$run/upstream-state" normal
[ "$(query third.ordinary.test)" = 203.0.113.20 ]
[ "$(cat "$run/dnsmasq.pid")" = "$resolver_pid" ]
[ "$(query assets1.xboxlive.com)" = 192.0.0.8 ]
echo 'PASS: DNS fails over and switches back while system DNS remains healthy'

# Keep uhttpd serving its static health file, but break the real redirect.
sed -i 's/"$target" "$REQUEST_URI"$/"$target" "${REQUEST_URI%%\\?*}"/' "$data/http/cgi-bin/redirect"
curl -fsS --noproxy '*' http://192.0.2.1:18080/health.txt | grep -Fxq xboxdownload-openwrt
wait_value "$run/error" 'Could not verify HTTP 302 redirects'
assert_rules_removed
wait "$supervisor" || true
echo 'PASS: incorrect startup redirect and runtime query loss both restore system DNS'

chroot "$root" sh -ec '
	. /lib/functions.sh
	. /etc/init.d/xboxdownload_openwrt
	load_settings
	mode=dns
	lan_ip=192.0.2.1
	main_ip=203.0.113.80
	legacy_ip=203.0.113.81
	global_ip=
	write_dns > "$RUNDIR/dnsmasq.conf"
'
chroot "$root" /usr/sbin/dnsmasq -k -C /tmp/run/xboxdownload_openwrt/dnsmasq.conf &
dns_only=$!
children="$children $dns_only"
sleep 0.2
[ "$(query assets1.xboxlive.cn)" = 203.0.113.80 ]
[ "$(query dlassets.xboxlive.cn)" = 203.0.113.81 ]
[ "$(query assets1.xboxlive.com)" = 203.0.113.70 ]
[ "$(query dlassets.xboxlive.com)" = 203.0.113.71 ]
kill "$dns_only"
wait "$dns_only"
echo 'PASS: DNS-only mode applies CN nodes to CN hostnames and forwards COM hostnames'

# Run the real rpcd configuration logic and UCI, using an init fixture to emulate procd outcomes.
sed -i 's@^INIT=.*@INIT=/tmp/test-init@; s@^\. /lib/functions/network.sh$@. /tmp/test-network@' "$rpc"
cat > "$root/tmp/test-network" <<'EOF'
network_get_ipaddr() { lan_ip=192.0.2.1; }
network_get_device() { lan_dev=lo; }
EOF
cat > "$root/tmp/test-init" <<'EOF'
#!/bin/sh
set -eu
. /usr/share/xboxdownload_openwrt/common.sh
rm -f "$RUNDIR/ready" "$RUNDIR/error"
if [ "$1" = stop ]; then
	if [ -e /tmp/stop-fails ]; then exit 1; fi
	rm -f "$RUNDIR/instance"
	clear_rules
	exit
fi
case "$(uci -q get xboxdownload_openwrt.main.main_ip)" in
	203.0.113.31)
		printf 'bad-start\n' > "$RUNDIR/instance"
		printf 'stale-ready\n' > "$RUNDIR/ready"
		printf '%s\n' "$HTTP_HEALTH_ERROR" > "$RUNDIR/error"
		;;
	*)
		printf 'old-configuration\n' > "$RUNDIR/instance"
		if [ -e /tmp/rollback-fails ]; then
			printf 'DNS startup failed\n' > "$RUNDIR/error"
		else
			printf 'old-configuration\n' > "$RUNDIR/ready"
		fi
		;;
esac
EOF
chmod +x "$root/tmp/test-init"
chroot "$root" uci set xboxdownload_openwrt.main.ipv6_devices=none
chroot "$root" uci set xboxdownload_openwrt.main.enabled=1
chroot "$root" uci set xboxdownload_openwrt.main.client=192.0.2.2
chroot "$root" uci set xboxdownload_openwrt.main.main_ip=203.0.113.30
chroot "$root" uci commit xboxdownload_openwrt

configure() {
	printf '{"enabled":%s,"client":"192.0.2.2","main_ip":"203.0.113.31","legacy_ip":""}\n' "$1" |
		chroot "$root" /usr/libexec/rpcd/xboxdownload_openwrt call configure |
		python3 -c 'import json, sys; print(json.load(sys.stdin)["error"])'
}

[ "$(configure 1)" = http_redirect ]
wait_value "$run/ready" old-configuration
[ "$(chroot "$root" uci get xboxdownload_openwrt.main.main_ip)" = 203.0.113.30 ]
touch "$root/tmp/stop-fails"
[ "$(configure 0)" = stop ]
wait_value "$run/ready" old-configuration
rm "$root/tmp/stop-fails"
touch "$root/tmp/rollback-fails"
[ "$(configure 1)" = rollback ]
assert_rules_removed
wait_value "$run/error" 'Could not restore previous settings or service'
touch "$root/tmp/stop-fails"
[ "$(configure 1)" = rollback_rules ]
echo 'PASS: rollback checks readiness, handles stop failures and reports failed recovery'

rm "$root/tmp/stop-fails" "$root/tmp/rollback-fails"
printf '%s\n' '{"main_ip":"203.0.113.55","enabled":0}' |
	chroot "$root" /usr/libexec/rpcd/xboxdownload_openwrt call configure |
	python3 -c 'import json,sys; assert json.load(sys.stdin)["error"] == ""'
printf '%s\n' '{"extra":"{\"log_mode\":\"all\"}"}' |
	chroot "$root" /usr/libexec/rpcd/xboxdownload_openwrt call configure |
	python3 -c 'import json,sys; assert json.load(sys.stdin)["error"] == ""'
[ "$(chroot "$root" uci -q get xboxdownload_openwrt.main.main_ip)" = 203.0.113.55 ]
[ "$(chroot "$root" uci -q get xboxdownload_openwrt.main.log_mode)" = all ]
[ "$(chroot "$root" uci -q get xboxdownload_openwrt.main.enabled)" = 0 ]
echo 'PASS: a log-only configuration update preserves the selected CDN and service state'
