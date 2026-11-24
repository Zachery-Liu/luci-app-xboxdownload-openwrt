# 安全政策 / Security policy

## 支持范围 / Supported versions

安全修复优先针对最新正式发布版本及 `main` 分支。旧版本可能需要升级后才能获得修复。请使用仓库 Releases 中的正式 APK。

Security fixes target the latest stable release and the main branch. Older releases may require an upgrade.

## 报告漏洞 / Reporting a vulnerability

请优先通过仓库 [Security → Report a vulnerability](https://github.com/Zachery-Liu/luci-app-xboxdownload-openwrt/security) 私下报告（如果 GitHub 提供该入口）。如果私密报告功能不可用，请先创建不含漏洞细节的 Issue，请维护者提供私下联系渠道。

Use GitHub private vulnerability reporting when available. If it is unavailable, open a minimal issue asking for a private contact channel; do not disclose exploit details in public issues or PRs.

建议提供 / Please include:

- 插件版本、OpenWrt 版本、硬件架构 / plugin and OpenWrt versions, architecture.
- 受影响功能、必要前提、复现步骤和影响 / affected component, prerequisites, reproduction and impact.
- 经脱敏的日志与配置 / sanitized logs and configuration.

不要提交密码、Token、私钥、下载授权链接或设备个人信息。请给予维护者合理的修复时间后再协调公开披露。本项目为个人开源维护，无法承诺固定响应或修复时限。

Do not include credentials, tokens, keys, signed download URLs or personal information. Allow reasonable time for remediation and coordinate disclosure. No fixed response or remediation SLA is promised.
