# XboxDownload-OpenWrt

一个面向 **OpenWrt 25.12 / LuCI** 的轻量插件，提供「服务」和「测速」。接管指定设备发到路由器的 IPv4 DNS 请求，也可为选中的 Xbox 接管 IPv6 DNS。默认用 dnsmasq 和 uhttpd 将 Xbox 下载 HTTP 请求跳到国内 CDN，设备直连 CDN 下载。也可以切换为仅 DNS 选点。

**原版 Xbox 下载助手（电脑端）** [skydevil88/XboxDownload](https://github.com/skydevil88/XboxDownload)

## 安装与使用

按下文构建后，将 `dist/` 生成的 APK 上传到路由器的 `/tmp`，然后通过 SSH 安装或升级。命令中的文件名对应 0.8.0-r7，可按实际构建版本修改。依赖从路由器配置的软件源获取。

```sh
apk add --allow-untrusted /tmp/luci-app-xboxdownload-openwrt-0.8.0-r7.apk
```

1. 刷新 LuCI，进入「服务 → Xbox 下载助手」。
2. 在「加速设备」列表中选 Xbox 或其他局域网设备，页面显示设备名、IPv4 和 MAC。路由器还没发现的设备可手动输入 IPv4，最多 8 台。规则按保存的 IPv4 生效，建议在 DHCP 中给设备保留地址。首测可填入 Windows 客户端已确认有效的 Xbox cn1 节点。
3. 让设备使用路由器的 DNS。新安装默认选中「保留 IPv6，接管 DNS」，保存前核对 Xbox 的 MAC。点击「保存并启动」，暂停再继续一次下载，查看最近日志。高级设置里可以指定上游 DNS、Xbox COM、微软商店、PlayStation、Switch、EA 和战网国际服节点，以及对所选设备启用 AAAA 过滤。
4. 「测速」页支持 [原项目七组 IP](https://github.com/skydevil88/XboxDownload/tree/master/IP)。默认优先从 GitHub 导入，失败时尝试 jsDelivr，也可直接选择 jsDelivr。进入测速页、切换节点组或渠道，或者点击「重新导入」，会重新请求列表。联网失败时使用 `/tmp/run/xboxdownload_openwrt/nodes/` 的上次成功列表，重启后清除。
5. Akamai IPv4、优选 IPv4 和 IPv6 按地区筛选，Xbox cn1、cn2、Xbox 应用和 PlayStation 按运营商筛选。每组都可以搜索位置或 IP，可勾选本页或全选筛选结果。开始测速后按每批 24 个连续执行，每次只测一个节点。支持双击单测、手动添加、测试默认节点和停止测速。默认沿用原版的样本上限和超时，国内组 50 MiB，Akamai 组 30 MiB，默认 3 秒。可以改用 1、8 或 32 MiB 样本。测速数据边收边丢弃，结果显示实收量及超时前的有效速度。延迟优先显示 ICMP 往返时间，ICMP 无响应时显示 TCP 连接时间。测速成功后可点「应用」保存到对应 CDN 组。读回配置确认成功后，按钮会根据服务状态显示「已应用」或「已保存」。
6. 点击「停止」移除插件规则。卸载可用 `apk del luci-app-xboxdownload-openwrt`。

## DNS、日志与资源用量

- DNS 命中配置的 CDN 域名时返回所选 IP。HTTP 302 域名返回专用地址 `192.0.0.8`，由 OpenWrt 将该地址的 HTTP 请求交给 uhttpd，再跳到对应 CDN。使用 302 模式时，设备到该地址的流量需要经过这台 OpenWrt。仅 DNS 模式只要求设备向这台 OpenWrt 查询 DNS。
- HTTP 302 模式把四个 Xbox 下载发现 SRV 名称导向 `assets1.xboxlive.com:80`，同时处理 [上游列出的四个备用 CDN 域名](https://github.com/skydevil88/XboxDownload/issues/156)。由路由器执行 HTTP 跳转的域名只使用本地 DNS 应答，避免这些域名的 AAAA 查询绕回上游。
- 插件先验证独立 DNS 和当前模式所需的 HTTP 监听，再接管查询。监听进程退出时撤下规则，设备恢复使用系统 DNS。HTTP 转发只匹配专用地址，路由器原有的 HTTP 管理地址继续由现有服务处理。
- 在「仅 DNS 选点」模式，插件只启动独立 dnsmasq，使用内部端口 15353。默认模式另启动轻量 uhttpd，使用 18080。插件用每次生成的新域名验证转发，正常 DNS 应答和 NXDOMAIN 都计为成功。当前上游连续失效时，插件会验证并切到可用的另一条上游，保留下载域名的本地应答和 HTTP 跳转。服务页会显示回退状态和重试入口。
- 选用 IPv6 节点需要路由器和设备都能访问 IPv6，并让设备使用路由器的 DNS。开启 AAAA 过滤时需要先清除已配置的 IPv6 CDN 节点。
- 「保留 IPv6，接管 DNS」按所选 Xbox 的 MAC 接管其发给路由器的 IPv6 TCP/UDP 53 查询，并与 IPv4 入口共用下载规则。启用 IPv4 节点的下载域名使用 A 记录，普通域名正常转发。此模式需要关闭「过滤已选设备的 AAAA 应答」。
- 服务页显示路由器默认 IPv6 路由及所选 Xbox 的 IPv6 邻居记录。邻居记录能帮助判断设备是否获址，公网连通性以实际连接为准。
- 「关闭所选 Xbox 的公网 IPv6」默认关闭。保存并启动后，插件按所选设备的 MAC 拒绝发往路由器 IPv6 DNS 的 TCP/UDP 53 和经路由器转发的全球单播 IPv6 流量。Xbox 的局域网邻居发现仍可使用。其他设备继续使用原有 IPv6。OpenWrt 需要是该 Xbox 的 IPv6 网关，并且能看到它的 MAC。
- 开启上述选项后，让 Xbox 使用路由器的 IPv4 DNS，才能命中 SRV 和 HTTP 302 规则。如果 Xbox COM、cn1 或 cn2 已固定为 IPv6 节点，请先切回 IPv4 或自动解析。启用了硬件流量卸载且 Xbox 已在下载时，保存后重连 Xbox 网络再验证，以建立新的连接。
- 默认只记录 302，可以开启 DNS 查询日志或关闭记录。页面最多显示 32 条，使用 OpenWrt 系统日志的环形缓冲。设备下方显示这批日志中最近的 302 命中时间和域名。它表示请求已经跳转，实际提速可在 Xbox 下载时查看。「清空插件日志」同时清除命中提示。跳转路径可选显示，查询参数会省略。
- cn1 的「测速设置」可选 Xbox 测试文件、《光环无限》《极限竞速：地平线 5》和《战争机器 5》。每个节点按这次选中的一个样本测试，切换样本时独立显示相应结果。
- 切换到 Akamai 节点组时默认使用 Xbox COM 样本。微软商店样本暂不可用时，本轮仅测 Ping，下次开始测速会重新请求样本。
- 测速按可用带宽下载，数据边收边丢弃。样本大小和超时限制的是每次测速的数据量和持续时间。
- 从旧包升级时，安装脚本会迁移原配置到 `/etc/config/xboxdownload_openwrt`。

## 上游来源

感谢 skydevil88 维护 Xbox 下载助手。本项目是面向 OpenWrt 的独立实现，包括 LuCI 界面、按设备的双栈 DNS 分流、HTTP 302 服务、健康检查和 DNS 回退。 [原版 Windows 客户端与源码](https://github.com/skydevil88/XboxDownload)

- **域名与跳转规则。** 参考原版 OpenWrt 教程的下载域名和跳转规则。主下载指向 `assets1.xboxlive.cn`，旧游戏下载指向 `dlassets.xboxlive.cn`。备用 CDN 和 SRV 发现规则也来自上游教程。 [原版 OpenWrt 教程](https://github.com/skydevil88/XboxDownload/blob/master/README_OpenWrt.md)
- **测速样本。** 沿用原版选用的测试文件链接和 30/50 MiB 样本档位。测速由路由器发起，使用本机 curl 读取下载样本。 [原版测速逻辑](https://github.com/skydevil88/XboxDownload/blob/master/XboxDownload/ViewModels/SpeedTestViewModel.cs)
- **在线节点列表。** 路由器运行时从上游的 `IP/` 目录读取节点与地区数据，可选择 GitHub 或 jsDelivr。仓库和安装包都不内置上游节点列表。 [上游 IP 数据](https://github.com/skydevil88/XboxDownload/tree/master/IP)
- **微软商店测速。** 通过原版网站的接口取得样本下载链接。接口暂不可用时，本轮只测节点延迟。 [原版网页版商店](https://xbox.skydevil.xyz)

## 构建

在 Linux 上使用 `fakeroot` 和 OpenWrt 25.12 SDK 自带的主机端 APK 打包工具。包的内容是架构无关的脚本、配置和 LuCI 页面。

```sh
sh package/build.sh /path/to/openwrt-sdk/staging_dir/host/bin/apk
```

## 许可证

本项目的独立实现以 [GNU Affero General Public License v3.0 only（AGPL-3.0-only）](LICENSE) 发布。上游项目、节点数据、文档及外部服务适用各自的授权与条款。
