# Xbox 下载助手（OpenWrt）

面向 OpenWrt 25.12 的 LuCI 插件。由路由器为选定设备加速 Xbox 下载，设备直接连接 CDN。

**使用说明** [项目 Wiki](https://github.com/Zachery-Liu/luci-app-xboxdownload-openwrt/wiki)

**原版 Xbox 下载助手** [skydevil88/XboxDownload](https://github.com/skydevil88/XboxDownload)

- **按设备加速** · 最多添加 8 台设备，每台可单独选择 IPv6 策略。通过 HTTP 302 将符合规则的下载请求跳转到国内 CDN，也可仅使用 DNS 选点。
- **CDN 测速选点** · 支持在线导入和手动输入节点，显示下载速度、延迟和 TTL。测速后可选用节点，再保存并应用。
- **服务状态与日志** · 在 LuCI 查看加速设备、DNS 回退状态和最近的下载跳转记录。

## 快速开始

1. 从 [GitHub Actions](https://github.com/Zachery-Liu/luci-app-xboxdownload-openwrt/actions/workflows/build-apk.yml) 最新成功构建的 Artifacts 下载并解压，或从 [GitHub Releases](https://github.com/Zachery-Liu/luci-app-xboxdownload-openwrt/releases) 下载已发布的 APK。将 APK 上传到路由器的 `/tmp/`，通过 SSH 运行 `apk add --allow-untrusted /tmp/实际文件名.apk`。
2. 在 LuCI 打开「服务 → Xbox 下载助手」，在「设备」页添加 Xbox，点击页脚的「保存并应用」，再启动服务。建议给 Xbox 配置 DHCP 静态租约，避免换 IP 后加速失效。
3. 在 Xbox 打开「设置 → 常规 → 网络设置 → 高级设置 → DNS 设置」，选择「自动」，并确认主机收到了这台路由器的 DNS。
4. 要手动选节点，可在「测速」页导入并测试节点，点「选用」填入下载线路，再点「保存并应用」使其生效。

要用 cn1、cn2 加速原始 `.com` 下载请求，请选择「DNS + HTTP 302」。该跳转支持 HTTP 下载。仅 DNS 选点时，cn1、cn2 只影响相应的 `.cn` 域名。

设备配置有 MAC 地址时，IPv4 接管也会核对 MAC，避免误加速拿到旧地址的其他设备。如果设备页发现 Xbox 换了 IP，可以编辑设备更新地址。内置 DNS 探针被过滤时，可在服务页填写本网络允许解析、会返回公网 IPv4 的探测域名。

## 界面预览

截图为界面预览，使用示例数据。

### 服务配置

![LuCI 服务页，显示运行状态、路由器 DNS、已选设备和下载线路](docs/screenshots/service.png)

### 节点测速

![LuCI 测速页，显示 CDN 节点的下载速度、延迟和选用按钮](docs/screenshots/speed-test.png)

<details>
<summary>Xbox 实机下载</summary>

![Xbox 下载队列，图中下载速度为 583.85 Mbps](docs/screenshots/xbox-download.jpg)

图中速度为单次下载截图。实际速度随线路、CDN 节点和游戏而变化。

</details>

## 上游与许可证

域名和跳转规则参考[原版 OpenWrt 教程](https://github.com/skydevil88/XboxDownload/blob/master/README_OpenWrt.md)。测速沿用原版样本，微软商店样本由原版网站接口查询。[节点列表](https://github.com/skydevil88/XboxDownload/tree/master/IP)在运行时从 GitHub 或 jsDelivr 获取。

本项目的独立实现采用 [AGPL-3.0-only](LICENSE)。
