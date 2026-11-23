#!/bin/sh
set -eu

: "${OPENWRT_ROOTFS:?Set OPENWRT_ROOTFS to the OpenWrt rootfs archive}"
: "${APK_TOOL:?Set APK_TOOL to the host OpenWrt apk executable}"
if [ "${2:-}" != isolated ]; then
	exec unshare -n sh "$0" "$1" isolated
fi

lab=$(mktemp -d)
trap 'rm -rf "$lab"' EXIT
root="$lab/root"
mkdir "$root" "$lab/curl"
tar -xzf "$OPENWRT_ROOTFS" -C "$root"
mkdir -p "$root/dev" "$root/tmp/run" "$root/tmp/lock"
[ -c "$root/dev/null" ] || mknod "$root/dev/null" c 1 3
cp "$1" "$root/tmp/package.apk"
# The offline install does not exercise the curl-dependent speed test.
"$APK_TOOL" mkpkg --info name:curl --info version:999-r0 --info arch:noarch \
	--files "$lab/curl" --output "$root/tmp/curl-fixture.apk"
chroot "$root" apk add --no-network --allow-untrusted /tmp/curl-fixture.apk /tmp/package.apk

[ "$(stat -c '%u:%g %a' "$root/etc/config/xboxdownload_openwrt")" = '0:0 644' ]
for path in etc/init.d/xboxdownload_openwrt usr/libexec/rpcd/xboxdownload_openwrt \
	usr/share/xboxdownload_openwrt/supervise usr/share/xboxdownload_openwrt/http/cgi-bin/redirect; do
	[ "$(stat -c '%u:%g %a' "$root/$path")" = '0:0 755' ]
done
echo 'PASS: installed APK configuration and executables have root ownership and expected modes'

cp package/post-install "$root/tmp/post-install"
chroot "$root" uci set xboxdownload_openwrt.main.log_mode=all
chroot "$root" uci commit xboxdownload_openwrt
chown 65534:65534 "$root/etc/config/xboxdownload_openwrt"
chroot "$root" sh /tmp/post-install
[ "$(stat -c '%u:%g' "$root/etc/config/xboxdownload_openwrt")" = '0:0' ]
[ "$(chroot "$root" uci get xboxdownload_openwrt.main.log_mode)" = all ]
echo 'PASS: the install/upgrade hook repairs ownership of a retained configuration'

cp package/pre-deinstall "$root/tmp/pre-deinstall"
cp package/post-deinstall "$root/tmp/post-deinstall"
mv "$root/etc/init.d/xboxdownload_openwrt" "$root/tmp/real-init"
cat > "$root/etc/init.d/xboxdownload_openwrt" <<'EOF'
#!/bin/sh
[ "$1" != disable ] || touch /tmp/disabled
exit 0
EOF
chmod +x "$root/etc/init.d/xboxdownload_openwrt"
nft add table ip xboxdownload_openwrt
nft add table inet xboxdownload_openwrt_ipv6
if chroot "$root" sh /tmp/pre-deinstall; then
	echo 'Pre-deinstall accepted rules left behind by the init script' >&2
	exit 1
fi
[ ! -e "$root/tmp/disabled" ]
chroot "$root" sh /tmp/post-deinstall
rules=$(nft list tables)
! printf '%s\n' "$rules" | grep -Fq xboxdownload_openwrt
mv "$root/tmp/real-init" "$root/etc/init.d/xboxdownload_openwrt"
chroot "$root" apk del --no-network luci-app-xboxdownload-openwrt
echo 'PASS: uninstall detects surviving rules and the post-deinstall hook retries cleanup'
