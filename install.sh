#!/bin/sh
set -eu

separator() {
	printf '%s\n' '============================================================'
}

step() {
	stage=$2
	printf '\n[%s] %s\n' "$1" "$stage"
}

passed() {
	printf '  [通过] %s\n' "$*"
}

fail() {
	printf '\n[安装失败 · %s]\n%s\n' "$stage" "$*" >&2
	separator >&2
	exit 1
}

download() (
	# OpenWrt includes uclient-fetch on devices without curl.
	ulimit -f 4096
	if [ "$downloader" = curl ]; then
		curl -q --fail --silent --show-error --location --max-redirs 5 \
			--proto '=https' --proto-redir '=https' --connect-timeout 8 \
			--max-time 90 --output "$1" "$2"
	else
		uclient-fetch --timeout=30 -O "$1" "$2"
	fi
)

hash_matches() {
	local actual
	actual=$(sha256sum < "$1") && [ "${actual%% *}" = "$2" ]
}

installed_version() {
	LC_ALL=C apk query --from installed --fields version "$1" 2>/dev/null | sed -n 's/^Version: //p'
}

install_main() {
	name=luci-app-xboxdownload-openwrt
	repo=Zachery-Liu/$name
	project_url="https://github.com/$repo"
	key=xboxdownload-openwrt-release.pem
	key_hash=254bc5e11df38adc01e958a0616b08609f56000cf226ead656f4b9cbc353ae40
	keys_dir=/etc/apk/keys
	trusted_key="$keys_dir/$key"

	separator
	printf '%s\n' 'Xbox 下载助手（OpenWrt）安装程序' '作者  Zachery Liu' "项目地址  $project_url"
	separator

	step 1/5 '检查安装环境'
	[ "$(id -u)" = 0 ] || fail '请在路由器上使用 root 执行。'
	passed '运行权限 root'
	[ -r /etc/openwrt_release ] && command -v apk >/dev/null 2>&1 &&
		command -v jsonfilter >/dev/null 2>&1 || fail '需要使用 APK 包管理器的 OpenWrt。'
	apk_version=$(apk --version) || fail '无法读取 apk 版本。'
	passed "OpenWrt，$apk_version"
	if command -v curl >/dev/null 2>&1; then
		downloader=curl
	elif command -v uclient-fetch >/dev/null 2>&1; then
		downloader=uclient-fetch
	else
		fail '需要 curl 或 uclient-fetch。'
	fi
	passed "下载工具 $downloader"

	umask 077
	work=$(mktemp -d /tmp/xboxdownload-install.XXXXXX) || fail '无法创建临时目录。'
	key_tmp=
	trap 'rm -rf "$work"; [ -z "$key_tmp" ] || rm -f "$key_tmp"' EXIT
	trap 'exit 1' HUP INT TERM
	mkdir "$work/keys" || fail '无法创建公钥临时目录。'
	passed '临时目录可写'

	step 2/5 '查询 GitHub 正式版本'
	metadata="$work/release.json"
	download "$metadata" "https://api.github.com/repos/$repo/releases/latest" ||
		fail '无法获取 GitHub 发布信息。'
	assets=$(jsonfilter -i "$metadata" -e '@.assets[@.state="uploaded"].name') ||
		fail '无法读取发布附件。'
	printf '%s\n' "$assets" | grep -Fxq "$key" ||
		fail '当前正式版本尚未提供签名安装包，请查看项目 Releases。'
	file=$(printf '%s\n' "$assets" | LC_ALL=C grep -E "^$name-[0-9]+\.[0-9]+\.[0-9]+-r[0-9]+\.apk$") ||
		fail '发布中找不到安装包。'
	case "$file" in *[!A-Za-z0-9.-]*) fail '发布中存在多个安装包。' ;; esac
	version=${file#"$name"-}
	version=${version%.apk}
	tag=$(jsonfilter -i "$metadata" -e '@.tag_name') || fail '无法读取发布标签。'
	[ "$tag" = "v${version%-r*}" ] || [ "$tag" = "v$version" ] ||
		fail '发布标签与安装包版本不一致。'
	digest=$(jsonfilter -i "$metadata" -e "@.assets[@.name=\"$file\"].digest") ||
		fail '无法读取安装包校验值。'
	checksum=${digest#sha256:}
	case "$checksum" in ''|*[!0-9a-f]*) fail '安装包校验值有误。' ;; esac
	[ "${#checksum}" = 64 ] && [ "$digest" = "sha256:$checksum" ] ||
		fail '安装包校验值有误。'
	passed "发布标签 $tag 与安装包版本匹配"

	current=$(installed_version "$name")
	if [ -n "$current" ] && [ "$(apk version -t "$current" "$version")" = '>' ]; then
		printf '已安装较新的版本 %s。\n' "$current"
		separator
		return
	fi

	step 3/5 "下载并校验发布文件 $version"
	base="$project_url/releases/download/$tag"
	artifact="$work/$file"
	download "$work/keys/$key" "$base/$key" || fail '公钥下载失败。'
	hash_matches "$work/keys/$key" "$key_hash" || fail '项目公钥的 SHA-256 不匹配。'
	passed '项目公钥 SHA-256'
	download "$artifact" "$base/$file" || fail 'APK 下载失败。'
	hash_matches "$artifact" "$checksum" || fail 'APK 的 SHA-256 校验失败。'
	passed 'APK 文件 SHA-256'

	step 4/5 '验证签名和安装条件'
	if ! signature=$(apk --keys-dir "$work/keys" verify "$artifact" 2>&1); then
		printf '%s\n' "$signature" >&2
		fail 'APK 签名验证失败。'
	fi
	passed 'APK 项目签名'
	info=$(LC_ALL=C apk --keys-dir "$work/keys" adbdump "$artifact") ||
		fail '无法读取 APK 信息。'
	fields=$(printf '%s\n' "$info" | awk '
		/^info:$/ { inside=1; next }
		/^[^ ]/ { inside=0 }
		inside && /^  name: / { name=$2 }
		inside && /^  version: / { version=$2 }
		inside && /^  arch: / { arch=$2 }
		END { print name, version, arch }
	')
	[ "$fields" = "$name $version noarch" ] || fail 'APK 的包名、版本或架构与发布信息不一致。'
	passed '包名、版本和架构匹配（noarch）'
	needed_bytes=$(printf '%s\n' "$info" | awk '/^  installed-size: [0-9]+$/ { print $2; exit }')
	free_kib=$(df -Pk /usr 2>/dev/null | awk 'NR == 2 && $4 ~ /^[0-9]+$/ { print $4 }')
	if [ -n "$needed_bytes" ] && [ -n "$free_kib" ]; then
		needed_kib=$(((needed_bytes + 1023) / 1024))
		[ "$needed_kib" -le "$free_kib" ] ||
			fail "安装分区空间不足，剩余 $free_kib KiB，插件需要 $needed_kib KiB。"
		passed "安装分区剩余 $free_kib KiB，插件需要 $needed_kib KiB"
	else
		printf '%s\n' '  [提示] 无法读取安装分区空间，交由 apk 检查。'
	fi

	step 5/5 '安装 APK'
	mkdir -p "$keys_dir" || fail '无法创建系统公钥目录。'
	if [ -e "$trusted_key" ] || [ -L "$trusted_key" ]; then
		hash_matches "$trusted_key" "$key_hash" || fail "现有公钥内容不同，请检查 $trusted_key。"
	else
		key_tmp=$(mktemp "$keys_dir/.xboxdownload-key.XXXXXX") || fail '无法写入项目公钥。'
		cp "$work/keys/$key" "$key_tmp" && chmod 0644 "$key_tmp" && mv -f "$key_tmp" "$trusted_key" ||
			fail '无法导入项目公钥。'
	fi
	apk --wait 15 add "$artifact" || fail 'APK 安装失败，请查看上方的 apk 输出。'
	[ "$(installed_version "$name")" = "$version" ] || fail '无法确认已安装的版本。'
	passed "已核对安装版本 $version"

	printf '\n'
	separator
	printf '%s\n' "安装完成  $version" 'LuCI 入口  服务 → Xbox 下载助手' "使用文档  $project_url/wiki"
	separator
}

install_main
