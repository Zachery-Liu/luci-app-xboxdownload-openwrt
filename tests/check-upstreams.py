"""Read current upstream versions and probe the actual CDN samples used by rpcd."""
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
RPC = ROOT / "package/root/usr/libexec/rpcd/xboxdownload_openwrt"
BUILD = ROOT / ".github/workflows/build-apk.yml"
OPENWRT_INDEX = "https://downloads.openwrt.org/releases/"
APP_HOSTS = {"dl.delivery.mp.microsoft.com", "tlu.dl.delivery.mp.microsoft.com",
             "1d.tlu.dl.delivery.mp.microsoft.com"}


def curl_data(url, limit, headers=()):
    return subprocess.check_output(
        ["curl", "-q", "-fsS", "--proto", "=https", "--noproxy", "*",
         "--connect-timeout", "5", "--max-time", "20", "--max-filesize", str(limit),
         *headers, url], timeout=25
    )


class ReleaseIndex(HTMLParser):
    def __init__(self):
        super().__init__()
        self.versions = set()

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href") or ""
            match = re.fullmatch(r"(?:/releases/)?(\d+)\.(\d+)\.(\d+)/?", href)
            if match:
                self.versions.add(tuple(map(int, match.groups())))


def openwrt():
    text = BUILD.read_text()
    versions = set(re.findall(r"downloads\.openwrt\.org/releases/(\d+\.\d+\.\d+)/", text))
    if len(versions) != 1:
        raise ValueError(f"Expected one consistent pinned OpenWrt version, found {versions}")
    pinned = tuple(map(int, versions.pop().split(".")))
    parser = ReleaseIndex()
    parser.feed(curl_data(OPENWRT_INDEX, 2 * 1024 * 1024).decode())
    if not parser.versions:
        raise ValueError("No stable versions found in OpenWrt release index")
    latest = max(parser.versions)
    current_series = max((v for v in parser.versions if v[:2] == pinned[:2]), default=None)
    show = lambda v: ".".join(map(str, v)) if v else "not found"
    print(f"Pinned: {show(pinned)}; latest stable: {show(latest)}; current series: {show(current_series)}")
    if latest > pinned:
        print(f"::warning::OpenWrt {show(latest)} available; review both rootfs archives, ImageBuilder and SHA256 values.")
    elif pinned not in parser.versions:
        raise ValueError("Pinned version is missing from the release index")
    else:
        print("OpenWrt pin is current.")


def static_samples(source):
    # Parse literal host/path assignments from the probe() group cases.
    # Fail explicitly if source layout changes so checks cannot silently disappear.
    body = source.split("\nprobe() {", 1)[1]
    groups = list(re.finditer(r"(?m)^\t\t(main|legacy|global|ps|ns|ea|app)\)", body))
    if {m.group(1) for m in groups} != {"main", "legacy", "global", "ps", "ns", "ea", "app"}:
        raise ValueError("Unexpected probe group layout")
    samples = []
    for i, match in enumerate(groups):
        name = match.group(1)
        if name == "app":
            continue
        block = body[match.end():groups[i + 1].start()]
        hosts = re.findall(r"\bhost=([a-z0-9.-]+)(?=[\s;])", block)
        paths = re.findall(r"\bpath=(/[^\s;]+)", block)
        if len(hosts) != 1 or not paths:
            raise ValueError(f"Cannot identify sample URLs for {name}")
        for j, path in enumerate(paths, 1):
            samples.append((f"{name}-{j}", f"http://{hosts[0]}{path}",
                            "XboxDownload/Nintendo NX" if name == "ns" else "XboxDownload"))
    return samples


def app_sample(source):
    urls = re.findall(r"https://xbox\.skydevil\.xyz/Game/GetAppPackage\?WuCategoryId=[0-9a-f-]+", source)
    if len(urls) != 1:
        raise ValueError("Cannot identify app sample API")
    data = json.loads(curl_data(urls[0], 131072, [
        "-A", "XboxDownload", "-H", "X-Organization: XboxDownload", "-H", "X-Author: Devil"
    ]))
    url = data["data"][0]["url"]
    if not isinstance(url, str) or any(c.isspace() or ord(c) < 32 for c in url):
        raise ValueError("Invalid sample URL")
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or parsed.netloc not in APP_HOSTS or not parsed.path:
        raise ValueError("Unapproved sample host")
    return "app", url, "XboxDownload"


def probe(label, url, agent):
    # A small bounded Range request tests resource availability, not throughput.
    # Never follow redirects or print dynamic app URLs containing query parameters.
    proc = subprocess.run([
        "curl", "-q", "-s", "--proto", "=http,https", "--noproxy", "*",
        "--connect-timeout", "5", "--max-time", "12", "--max-filesize", "65536",
        "--range", "0-65535", "-A", agent, "-o", "/dev/null",
        "-w", "%{http_code} %{size_download}", url
    ], capture_output=True, text=True, timeout=16)
    fields = proc.stdout.split()
    code, size = (fields + ["0", "0"])[:2]
    ok = proc.returncode == 0 and code in ("200", "206") and float(size) > 0
    print(f"{label}: HTTP {code}, received {size} bytes, curl exit {proc.returncode}")
    if not ok:
        print(f"::warning::{label} sample unavailable or Range request not honored from this runner.")
    return ok


def cdn():
    source = RPC.read_text()
    samples = static_samples(source)
    print(f"Checking {len(samples)} static sample resources")
    failed = False
    try:
        samples.append(app_sample(source))
    except (ValueError, TypeError, KeyError, IndexError, subprocess.SubprocessError):
        print("::warning::Microsoft Store sample API did not return an approved sample URL.")
        failed = True
    for label, url, agent in samples:
        try:
            if not probe(label, url, agent):
                failed = True
        except (ValueError, subprocess.SubprocessError):
            print(f"::warning::{label} probe failed.")
            failed = True
    if failed:
        sys.exit("Some CDN samples could not be verified from this GitHub runner; review before changing runtime URLs.")


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("openwrt", "cdn", "validate"):
        sys.exit("Usage: check-upstreams.py openwrt|cdn|validate")
    if sys.argv[1] == "validate":
        print(*[label for label, _, _ in static_samples(RPC.read_text())], sep="\n")
    else:
        {"openwrt": openwrt, "cdn": cdn}[sys.argv[1]]()
