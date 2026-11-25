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
source="$lab/source"
name=luci-app-xboxdownload-openwrt
version=999.0.0-r0
filename="$name-$version.apk"
mkdir -p "$root" "$lab/curl" "$source/docs/assets"
tar -xzf "$OPENWRT_ROOTFS" -C "$root"
mkdir -p "$root/tmp/run" "$root/tmp/lock"
[ -c "$root/dev/null" ] || mknod "$root/dev/null" c 1 3
cp "$1" "$root/tmp/installed.apk"
"$APK_TOOL" mkpkg --info name:curl --info version:999-r0 --info arch:noarch \
	--files "$lab/curl" --output "$root/tmp/curl-fixture.apk"
chroot "$root" apk add --no-network --allow-untrusted /tmp/curl-fixture.apk /tmp/installed.apk
chroot "$root" uci set xboxdownload_openwrt.main.log_mode=all
chroot "$root" uci commit xboxdownload_openwrt

cp -R package "$source/"
cp docs/assets/logo.svg "$source/docs/assets/"
fixture_key="$source/package/xboxdownload-openwrt-release.pem"
openssl genpkey -algorithm RSA -out "$lab/key.pem" -pkeyopt rsa_keygen_bits:2048 2>"$lab/openssl.log"
openssl pkey -in "$lab/key.pem" -pubout -out "$fixture_key"
data=/usr/share/xboxdownload_openwrt
cp "$fixture_key" "$root$data/release-keys/"
sh "$source/package/build.sh" "$APK_TOOL" "$version"
unsigned="$source/dist/$filename"
cp "$unsigned" "$lab/$filename"
APK_SIGNING_KEY=$(cat "$lab/key.pem") sh "$source/package/sign-release.sh" "$APK_TOOL" "$lab/$filename"

# Keep GitHub release metadata and APK responses local. Exercise the real RPC worker, parser, and apk.
cat > "$root/usr/bin/curl" <<'EOF'
#!/bin/sh
while [ "$#" -gt 2 ]; do
	case "$1" in --output|-O) output=$2 ;; esac
	shift
done
[ "$1" = "$output" ] || exit 1
case "$2" in
	https://api.github.com/repos/Zachery-Liu/luci-app-xboxdownload-openwrt/releases/latest)
		cp /tmp/release.json "$output" ;;
	https://github.com/Zachery-Liu/luci-app-xboxdownload-openwrt/releases/download/v999.0.0/luci-app-xboxdownload-openwrt-999.0.0-r0.apk)
		cp /tmp/remote.apk "$output" ;;
	https://github.com/Zachery-Liu/luci-app-xboxdownload-openwrt/releases/download/v999.0.0/xboxdownload-openwrt-release.pem)
		cp /tmp/remote.pem "$output" ;;
	*) exit 1 ;;
esac
EOF
chmod +x "$root/usr/bin/curl"

rpc() {
	chroot "$root" /usr/libexec/rpcd/xboxdownload_openwrt call "$1"
}

release() {
	cp "$1" "$root/tmp/remote.apk"
	size=$(wc -c < "$1")
	printf '{"tag_name":"v999.0.0","body":"## 更新内容\\n- 修复示例","draft":false,"prerelease":false,"assets":[{"name":"%s","size":%s,"digest":"sha256:%s","state":"uploaded"},{"name":"xboxdownload-openwrt-release.pem","state":"uploaded"}]}\n' \
		"$filename" "$size" "$2" > "$root/tmp/release.json"
}

verify_phase() {
	expected=$1
	for attempt in $(seq 1 30); do
		response=$(rpc update_status)
		if printf '%s\n' "$response" | grep -Eq "\"phase\": *\"$expected\""; then return; fi
		[ "$attempt" != 30 ] || break
		sleep 1
	done
	printf 'Expected %s, got %s\n' "$expected" "$response" >&2
	exit 1
}

start() {
	printf '{"version":"%s"}\n' "$version" | rpc update_start | grep -Eq '"error": *""'
}

release "$unsigned" "$(printf '%064d' 0)"
check_response=$(rpc update_check)
printf '%s\n' "$check_response" | grep -Eq '"available": *true'
printf '%s\n' "$check_response" | grep -Fq '## 更新内容\n- 修复示例'
printf '%s\n' "$check_response" | grep -Eq '"checked_at": *"[1-9][0-9]*"'
rpc update_status | grep -Eq '"installed_at": *"[1-9][0-9]*"'
mv "$root/tmp/release.json" "$root/tmp/release-fixture.json"
printf '1\n' > "$root/etc/xboxdownload_openwrt/checked-at"
check_response=$(rpc update_check)
printf '%s\n' "$check_response" | grep -Eq '"error": *"network"'
printf '%s\n' "$check_response" | grep -Eq '"checked_at": *"[1-9][0-9]+"'
mv "$root/tmp/release-fixture.json" "$root/tmp/release.json"
start
verify_phase failed
printf '%s\n' "$response" | grep -Eq '"error": *"integrity"'
release "$unsigned" "$(sha256sum "$unsigned" | cut -d ' ' -f1)"
start
verify_phase failed
printf '%s\n' "$response" | grep -Eq '"error": *"signature"'
printf '%s\n' "$response" | grep -Eq '"log": *".*signature'
release "$lab/$filename" "$(sha256sum "$lab/$filename" | cut -d ' ' -f1)"
start
verify_phase 'done'
printf '%s\n' "$response" | grep -Eq '"current": *"999\.0\.0-r0"'
printf '%s\n' "$response" | grep -Fq 'Upgrading luci-app-xboxdownload-openwrt'
[ "$(chroot "$root" uci get xboxdownload_openwrt.main.log_mode)" = all ]
rpc update_check | grep -Eq '"available": *false'
echo 'PASS: online update rejects bad hashes and unsigned APKs, installs a signed newer version and retains UCI settings'

# Start with the plugin removed and use the stock download tool entry point.
chroot "$root" apk --repositories-file /dev/null --no-network del "$name"
for file in "$root"/etc/apk/repositories.d/*.list "$root/etc/apk/repositories"; do
	[ ! -f "$file" ] || : > "$file"
done
mv -f "$root/usr/bin/curl" "$root/bin/uclient-fetch"
fixture_hash=$(sha256sum "$fixture_key" | cut -d ' ' -f1)
production_hash=$(sha256sum package/xboxdownload-openwrt-release.pem | cut -d ' ' -f1)
grep -Fxq "	key_hash=$production_hash" install.sh
sed "s/$production_hash/$fixture_hash/" install.sh > "$root/tmp/install.sh"
trusted_key="$root/etc/apk/keys/xboxdownload-openwrt-release.pem"
cp package/xboxdownload-openwrt-release.pem "$root/tmp/remote.pem"
if chroot "$root" sh /tmp/install.sh > "$lab/install.log" 2>&1; then
	echo 'The installer accepted a different key' >&2
	exit 1
fi
grep -Fq '项目公钥的 SHA-256 不匹配' "$lab/install.log"
grep -Fxq "[安装失败 · 下载并校验发布文件 $version]" "$lab/install.log"
[ ! -e "$trusted_key" ]
cp "$fixture_key" "$root/tmp/remote.pem"
release "$unsigned" "$(sha256sum "$unsigned" | cut -d ' ' -f1)"
if chroot "$root" sh /tmp/install.sh > "$lab/install.log" 2>&1; then
	echo 'The installer accepted an unsigned package' >&2
	exit 1
fi
grep -Fq 'APK 签名验证失败' "$lab/install.log"
[ ! -e "$trusted_key" ]
release "$lab/$filename" "$(sha256sum "$lab/$filename" | cut -d ' ' -f1)"
# The isolated rootfs has no mount table. Simulate both free-space results.
df_path=$(chroot "$root" sh -c 'command -v df')
rm -f "$root$df_path"
cat > "$root$df_path" <<'EOF'
#!/bin/sh
available=1048576
[ ! -f /tmp/space-limited ] || available=0
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf 'overlay 1048576 0 %s 0%% /\n' "$available"
EOF
chmod +x "$root$df_path"
touch "$root/tmp/space-limited"
if chroot "$root" sh /tmp/install.sh > "$lab/install.log" 2>&1; then
	echo 'The installer accepted insufficient disk space' >&2
	exit 1
fi
grep -Fq '安装分区空间不足，剩余 0 KiB' "$lab/install.log"
[ ! -e "$trusted_key" ]
rm -f "$root/tmp/space-limited"
chroot "$root" sh /tmp/install.sh > "$lab/install.log"
cat "$lab/install.log"
grep -Fxq '  [通过] 下载工具 uclient-fetch' "$lab/install.log"
grep -Fxq '  [通过] APK 项目签名' "$lab/install.log"
grep -Fq '  [通过] 安装分区剩余 1048576 KiB' "$lab/install.log"
grep -Fxq '[5/5] 安装 APK' "$lab/install.log"
grep -Fxq "安装完成  $version" "$lab/install.log"
cmp "$trusted_key" "$fixture_key"
rpc update_status | grep -Eq '"current": *"999\.0\.0-r0"'
echo 'PASS: first-install script checks the pinned key and installs a verified APK without curl or an existing project key'
