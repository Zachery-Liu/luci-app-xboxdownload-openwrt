#!/bin/sh
set -eu

# Use the host apk binary from the OpenWrt 25.12 SDK.
apk_tool=${1:?Usage: sh package/build.sh /path/to/host/bin/apk}
if [ "$(id -u)" -ne 0 ]; then
	if command -v fakeroot >/dev/null 2>&1; then
		exec fakeroot sh "$0" "$@"
	fi
	echo 'Run the build under fakeroot or in a disposable Linux environment as root.' >&2
	exit 1
fi
project=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
name=luci-app-xboxdownload-openwrt
version=1.0.0-r1
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

mkdir -p "$project/dist" "$stage/lib/apk/packages" "$stage/lib/upgrade/keep.d"
cp -R "$project/package/root/." "$stage/"

# LuCI's resource version tracks LuCI itself. Give plugin assets fresh URLs when their content changes.
resources="$stage/www/luci-static/resources"
assets=xboxdownload_openwrt
asset_hash=$(cd "$resources" && sha256sum "view/$assets.js" "$assets"/*.js "$assets/style.css" | sha256sum)
asset_path="${assets}_$(printf '%s' "$asset_hash" | cut -c1-12)"
sed -e "s/'require $assets\./'require $asset_path./" -e "s|'$assets/|'$asset_path/|" \
	"$resources/view/$assets.js" > "$resources/view/$asset_path.js"
rm "$resources/view/$assets.js"
mv "$resources/$assets" "$resources/$asset_path"
sed -i "s/\"path\": \"$assets\"/\"path\": \"$asset_path\"/" \
	"$stage/usr/share/luci/menu.d/luci-app-$assets.json"

find "$stage" -type d -exec chmod 0755 {} +
find "$stage" -type f -exec chmod 0644 {} +
chmod 0755 "$stage/etc/init.d/xboxdownload_openwrt" "$stage/usr/libexec/rpcd/xboxdownload_openwrt" \
	"$stage/usr/share/xboxdownload_openwrt/http/cgi-bin/redirect" "$stage/usr/share/xboxdownload_openwrt/supervise"

printf '%s\n' /etc/config/xboxdownload_openwrt > "$stage/lib/upgrade/keep.d/$name"
metadata="$stage/lib/apk/packages/$name"
printf '%s\n' /etc/config/xboxdownload_openwrt > "$metadata.conffiles"
printf '/etc/config/xboxdownload_openwrt %s\n' "$(sha256sum "$stage/etc/config/xboxdownload_openwrt" | cut -d ' ' -f 1)" > "$metadata.conffiles_static"
(cd "$stage" && find etc usr www lib/upgrade -type f -printf '/%p\n' | LC_ALL=C sort) > "$metadata.list"

"$apk_tool" mkpkg \
	--info "name:$name" --info "version:$version" --info arch:noarch \
	--info 'description:Lightweight Xbox Live CDN redirects and speed tests' \
	--info 'depends:luci-base dnsmasq uhttpd firewall4 curl ca-bundle uclient-fetch' \
	--script "post-install:$project/package/post-install" \
	--script "pre-upgrade:$project/package/pre-upgrade" \
	--script "post-upgrade:$project/package/post-install" \
	--script "pre-deinstall:$project/package/pre-deinstall" \
	--script "post-deinstall:$project/package/post-install" \
	--files "$stage" --output "$project/dist/$name-$version.apk"

wc -c "$project/dist/$name-$version.apk"
