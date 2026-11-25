#!/bin/sh
set -eu

apk_tool=${1:?Usage: APK_SIGNING_KEY=... sh package/sign-release.sh /path/to/host/bin/apk package.apk}
package=${2:?Provide the APK file to sign}
if [ -z "${APK_SIGNING_KEY:-}" ]; then
	printf '%s\n' 'Missing APK_SIGNING_KEY in the release environment.' >&2
	exit 1
fi
signing_pem=$APK_SIGNING_KEY
unset APK_SIGNING_KEY

public_key=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)/xboxdownload-openwrt-release.pem
package_dir=$(CDPATH='' cd -- "$(dirname "$package")" && pwd)
package="$package_dir/$(basename "$package")"
umask 077
work=$(mktemp -d "$package_dir/.sign-release.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
trap 'exit 1' HUP INT TERM
mkdir "$work/keys"
cp "$public_key" "$work/keys/"
cp "$package" "$work/signed.apk"
printf '%s\n' "$signing_pem" > "$work/private.pem"
unset signing_pem

# The input from the build job is unsigned. The output must verify with the project key.
"$apk_tool" adbsign --allow-untrusted --reset-signatures --sign-key "$work/private.pem" "$work/signed.apk"
"$apk_tool" verify --keys-dir "$work/keys" "$work/signed.apk"
chmod 0644 "$work/signed.apk"
mv -f "$work/signed.apk" "$package"
