'use strict';
'require view';
'require form';
'require rpc';
'require ui';
'require poll';
'require session';
'require xboxdownload_openwrt.speed as speedTest';
'require xboxdownload_openwrt.devices as devicePicker';

const getStatus = rpc.declare({ object: 'xboxdownload_openwrt', method: 'status', reject: true });
const configure = rpc.declare({
	object: 'xboxdownload_openwrt', method: 'configure',
	params: ['client', 'main_ip', 'legacy_ip', 'enabled', 'extra'], reject: true
});
const clearLogs = rpc.declare({ object: 'xboxdownload_openwrt', method: 'clear_logs', expect: { '': {} } });
const extraKeys = ['upstream', 'global_ip', 'app_ip', 'ps_ip', 'ns_ip', 'ea_ip', 'battle_ip',
	'mode', 'filter_aaaa', 'log_mode', 'log_path', 'ipv6_devices'];
const pendingKey = 'xboxdownload-openwrt.pending-settings';
const viewPath = 'admin/services/xboxdownload_openwrt';
const settingDefaults = { mode: 'redirect', filter_aaaa: '0', log_mode: 'http', log_path: '0' };
const errors = {
	client: '请输入 1–8 个局域网设备 IPv4 地址，并确保它们和路由器地址不同。',
	cdn: 'CDN 节点必须是公网 IPv4 或 IPv6 地址。',
	upstream: '上游 DNS 必须是有效 IP 地址。',
	ipv6: '已配置 IPv6 CDN 节点，请先关闭 AAAA 过滤。',
	ipv6_device: '请检查加速设备的 IPv4 与 IPv6 策略。接管 DNS 或关闭公网 IPv6 时，需要填写设备的 MAC 地址。',
	ipv6_mac_duplicate: '同一个 MAC 地址只能配置一次 IPv6 策略，请检查加速设备列表。',
	ipv6_reload: '设备配置已升级，请刷新页面后再保存。',
	ipv6_filter: '保留 IPv6 时，请先关闭「过滤已选设备的 AAAA 应答」。',
	ipv6_cdn: '关闭 Xbox 公网 IPv6 前，请把 Xbox com、cn1、cn2 节点切换到 IPv4 或自动解析。',
	lan: '路由器的 lan 接口没有可用的 IPv4 地址。',
	lan_ipv6: 'LAN 暂无可用的 IPv6 链路本地地址，已恢复原设置。',
	dns_upstream: '无法验证普通域名的 DNS 转发，已恢复原设置。',
	http_redirect: 'HTTP 302 跳转检查失败，已恢复原设置。',
	start: '服务启动失败，已恢复原设置。请查看系统日志。',
	stop: '无法确认服务已停止，已恢复原设置。',
	rollback: '无法恢复旧设置或服务。已撤下接管规则，请查看系统日志。',
	rollback_rules: '无法恢复旧设置或服务，也无法确认接管规则已撤下。请查看系统日志。',
	save: '保存设置失败。',
	busy: '配置正在更新，请稍后再试。'
};
const serviceErrors = {
	'LAN IPv4 unavailable': 'LAN 暂无 IPv4 地址。',
	'LAN IPv6 unavailable': 'LAN 暂无可用的 IPv6 链路本地地址。',
	'Could not start or verify DNS on port 15353': '无法验证 DNS 监听（15353），设备继续使用系统 DNS。',
	'Could not set DNS upstream': '无法加载 DNS 上游配置，设备使用系统 DNS。',
	'Could not forward ordinary DNS queries': '无法验证普通域名的 DNS 转发，加速启动失败，设备使用系统 DNS。',
	'Could not start or verify HTTP on port 18080': '无法验证 HTTP 监听（18080），设备继续使用系统 DNS。',
	'Could not verify HTTP 302 redirects': 'HTTP 302 跳转检查失败，已撤下加速接管规则。',
	'Could not remove interception rules': '无法撤下接管规则，请查看系统日志。',
	'Could not restore previous settings or service': '无法恢复旧设置或服务，已撤下接管规则。',
	'Could not restore previous settings or verify rule removal': '无法恢复旧设置或服务，也无法确认接管规则已撤下。',
	'A download service stopped; system DNS restored': '加速监听已退出，设备已恢复使用系统 DNS。',
	'Could not activate nftables rules': '无法启用转发规则，设备继续使用系统 DNS。'
};

function notify(message, style = 'error') {
	ui.addNotification(null, E('p', {}, [message]), style);
}

function showReadonlyValues(container, label, values) {
	for (const [index, value] of values.entries()) {
		const row = container.children[index] || container.appendChild(new ui.Textfield(value, { readonly: true }).render());
		const input = row.querySelector('input');
		input.setAttribute('aria-label', values.length > 1 ? label + ' ' + (index + 1) : label);
		if (input.value !== value) input.value = value;
	}
	while (container.children.length > values.length)
		container.lastElementChild.remove();
}

function settingsSection(name, title, initial) {
	const map = new form.JSONMap({ [name]: { ...initial } });
	return map.section(form.NamedSection, name, name, title);
}

async function renderSettings(section) {
	const node = await section.map.render();
	node.id = 'cbi-xboxdownload-' + section.section;
	return node;
}

function helpTooltip(label, description) {
	return E('button', {
		type: 'button', class: 'cbi-button cbi-button-neutral xb-help-button', 'aria-label': label,
		'data-tooltip': description, 'data-tooltip-style': 'xb-help-tooltip', 'aria-description': description
	}, ['?']);
}

function normalizeClients(value) {
	return Array.from(new Set(value.split(/[\s,，]+/).filter(Boolean))).join(',');
}

function sameSetting(key, first, second) {
	first ??= settingDefaults[key] || '';
	second ??= settingDefaults[key] || '';
	if (key === 'client') return normalizeClients(first) === normalizeClients(second);
	if (key === 'ipv6_devices') {
		const active = value => value.toUpperCase().split(',').filter(row => !row.endsWith('/SYSTEM')).sort().join(',');
		return active(first) === active(second);
	}
	return first === second;
}

function settingsPatch(settings, original) {
	const patch = Object.fromEntries(Object.entries(settings).filter(([key, value]) =>
		!sameSetting(key, value, original[key])));
	if ('client' in patch || 'ipv6_devices' in patch) {
		patch.client = settings.client;
		patch.ipv6_devices = settings.ipv6_devices;
	}
	return patch;
}

return view.extend({
	load: function() {
		const cached = session.getLocalData('menu');
		const oldEntry = cached?.children?.admin?.children?.services?.children?.xboxdownload_openwrt;
		if (oldEntry?.action?.type === 'view') {
			ui.menu.flushCache();
			if (session.getLocalData('menu') == null) location.reload();
		}
		return getStatus();
	},
	handleSave: function() {
		return this.stageSettings();
	},
	handleReset: function() {
		return this.restoreSettings();
	},
	handleSaveApply: function() {
		return this.submitSettings();
	},

	render: async function(initial) {
		const nodeLabels = {
			main_ip: 'Xbox cn1 下载 IP', legacy_ip: 'Xbox cn2 下载 IP', global_ip: 'Xbox com 下载 IP',
			app_ip: '微软商店 / Xbox 应用 IP', ps_ip: 'PlayStation 下载 IP', ns_ip: 'Nintendo Switch 下载 IP',
			ea_ip: 'EA 下载 IP', battle_ip: '战网国际服下载 IP'
		};
		const downloads = settingsSection('downloads', 'Xbox 下载线路', initial);
		const logSettings = settingsSection('logging', null, initial);
		const logTable = new ui.Table(['时间', '客户端 IP', '请求', '域名 / 跳转'], { sortable: false });
		const log = E('div', { class: 'xb-log' }, [logTable.render()]);
		const clear = E('button', { class: 'cbi-button cbi-button-remove', type: 'button' }, ['清空插件日志']);
		const options = {};
		function option(section, type, key, label, description) {
			const value = section.option(type, key, label, description);
			options[key] = value;
			return value;
		}
		const mode = option(downloads, form.ListValue, 'mode', '服务模式');
		mode.default = 'redirect';
		mode.value('redirect', 'DNS + HTTP 302');
		mode.value('dns', '仅 DNS 选点');
		for (const [key, label] of Object.entries(nodeLabels)) {
			option(downloads, form.Value, key, label).placeholder = '自动解析';
		}
		option(downloads, form.Value, 'upstream', '上游 DNS').placeholder = '使用路由器现有 DNS';
		option(downloads, form.Flag, 'filter_aaaa', '过滤已选设备的 AAAA 应答',
			'移除插件 DNS 应答中的 IPv6 地址，普通域名也受影响。使用「保留 IPv6，接管 DNS」时请保持关闭。');
		logSettings.tab('recent-logs', '最近日志');
		logSettings.tab('log-settings', '日志设置');
		const recentLogs = logSettings.taboption('recent-logs', form.DummyValue, '_recent_logs');
		recentLogs.render = () => E([
			log,
			E('div', { class: 'cbi-page-actions' }, [E('small', { class: 'xb-muted' }, ['最多 32 条']), ' ', clear])
		]);
		const logMode = logSettings.taboption('log-settings', form.ListValue, 'log_mode', '记录范围');
		logMode.default = 'http';
		logMode.value('http', '仅 HTTP 302');
		logMode.value('all', 'HTTP 302 和 DNS 查询');
		logMode.value('off', '关闭');
		options.log_mode = logMode;
		options.log_path = logSettings.taboption('log-settings', form.Flag, 'log_path', '显示跳转路径', '省略查询参数。');
		const [downloadForm, logForm] = await Promise.all([downloads, logSettings].map(renderSettings));
		const widgets = Object.fromEntries(Object.entries(options).map(([key, value]) => [
			key, value.getUIElement(value.section.section)
		]));
		const goSpeed = E('button', { class: 'cbi-button cbi-button-action', type: 'button' }, ['去测速选节点']);
		widgets.mode.node.parentElement.classList.add('xb-row');
		widgets.mode.node.after(goSpeed);

		const devices = await devicePicker.render(initial, () =>
			helpTooltip('如何查看 Xbox 设备名称',
				'按手柄上的 Xbox 键，依次打开「档案和系统 → 设置 → 系统 → 主机信息 → 名称」。默认名称为 XBOX，改过名则以主机显示为准。'));
		const status = E('strong', { class: 'xb-state', role: 'status' });
		const serviceError = E('p', { class: 'xb-error', role: 'status' });
		const primary = E('button', { class: 'cbi-button cbi-button-apply', type: 'button' });
		const stop = E('button', { class: 'cbi-button cbi-button-negative', type: 'button' }, ['停止服务']);
		const goDevices = E('button', { class: 'cbi-button cbi-button-add', type: 'button' }, ['添加设备']);
		const manageDevices = E('button', { class: 'cbi-button cbi-button-action', type: 'button' }, ['管理设备']);
		const overviewIPv4 = E('div', { class: 'xb-overview-values' });
		const overviewIPv6 = E('div', { class: 'xb-overview-values' });
		const overviewDevices = E('div', { class: 'xb-overview-values' });
		const overviewCount = E('span', { class: 'xb-muted' });
		const overviewEmpty = E('p', { class: 'xb-muted' }, ['尚未选择设备']);
		const overviewPending = E('small', { class: 'xb-muted', hidden: true }, ['设备选择待保存']);
		const ipv6HelpText = '使用加速时，请让 Xbox 使用路由器的 DNS。Xbox 实际收到的 DNS 以主机网络设置为准。';
		const ipv6Help = helpTooltip('IPv6 与下载加速', ipv6HelpText);
		const overview = settingsSection('overview', '总览', {});
		overview.option(form.DummyValue, '_ipv4', '路由器 IPv4 DNS').renderWidget = () => overviewIPv4;
		overview.option(form.DummyValue, '_ipv6', '路由器 IPv6 DNS').renderWidget = () =>
			E('div', { class: 'xb-row' }, [overviewIPv6, ipv6Help]);
		overview.option(form.DummyValue, '_devices', '已选设备').renderWidget = () => E([
			E('div', { class: 'xb-row' }, [overviewCount, overviewPending, manageDevices]),
			overviewEmpty, overviewDevices
		]);
		const overviewForm = await renderSettings(overview);
		overviewForm.classList.add('xb-overview');
		let state = initial;
		let formBase = initial;
		let pending = session.getLocalData(pendingKey);
		let updating = false;
		let shown;

		function updateControls() {
			const settings = fields();
			const hasDevices = devices.selected().length > 0;
			widgets.global_ip.setPlaceholder(settings.mode === 'dns' ? '留空使用系统 DNS' : '留空默认跳转到 CN 下载');
			const retryUpstream = state.running && ['fallback', 'unavailable'].includes(state.upstream_state);
			primary.hidden = state.running && !retryUpstream;
			primary.textContent = retryUpstream ? '重试上游 DNS' : state.enabled ? '重试启动' : '启动服务';
			primary.disabled = updating || !state.router || !state.client;
			primary.title = !state.client ? '请先添加设备并保存设置' : '';
			goDevices.hidden = hasDevices;
			manageDevices.hidden = !hasDevices;
			overviewPending.hidden = normalizeClients(settings.client) === normalizeClients(state.client || '');
			stop.hidden = !state.enabled;
			stop.disabled = updating;
			clear.disabled = updating || !state.log;
		}

		function update(data) {
			state = data;
			devices.update(data);
			const addresses = (data.lan_ipv6_dns || '').split(/\s+/).filter(Boolean);
			showReadonlyValues(overviewIPv4, '路由器 IPv4 DNS', [data.router || '无可用地址']);
			showReadonlyValues(overviewIPv6, '路由器 IPv6 DNS', addresses.length ? addresses : ['无可用地址']);
			const route = { present: '已发现 IPv6 默认路由。', absent: '未发现 IPv6 默认路由。' };
			const announced = (data.lan_advertised_dns || '').split(/\s+/).filter(ip => ip.includes(':'));
			ipv6Help.dataset.tooltip = ipv6HelpText + (route[data.wan6_state] || '') +
				(announced.length ? '配置的 IPv6 通告 DNS 为 ' + announced.join('、') + '。' : '');
			ipv6Help.setAttribute('aria-description', ipv6Help.dataset.tooltip);
			const serviceLabel = data.running ? '服务运行中' : !data.enabled ? '服务已停止' :
				data.error ? '服务异常' : '服务正在启动';
			if (status.textContent !== serviceLabel) status.textContent = serviceLabel;
			status.dataset.state = data.running ? 'running' : data.enabled ? 'pending' : 'stopped';
			const upstreamNotice = {
				fallback: '自定义上游 DNS 无响应，普通域名已切回系统 DNS，下载加速继续运行。',
				unavailable: 'DNS 上游无响应，普通域名可能无法解析。已配置的下载规则继续生效。'
			};
			const notice = data.error ? serviceErrors[data.error] || data.error :
				!data.router ? '路由器的 LAN 接口没有可用的 IPv4 地址。' :
				data.running ? upstreamNotice[data.upstream_state] || '' : '';
			if (serviceError.textContent !== notice) serviceError.textContent = notice;
			if (shown !== data.log) {
				shown = data.log;
				const rows = (data.log || '').split('\n').map(line => line.split('\t')).filter(row => row.length === 4);
				logTable.update(rows, '暂无记录。').querySelectorAll('th[data-sortable-row]')
					.forEach(th => th.removeAttribute('data-sortable-row'));
			}
			updateControls();
		}

		function updateDeviceOverview() {
			const selected = devices.selected();
			overviewCount.textContent = selected.length + ' 台';
			overviewCount.hidden = !selected.length;
			overviewEmpty.hidden = selected.length > 0;
			overviewDevices.hidden = !selected.length;
			showReadonlyValues(overviewDevices, '已选设备', selected.map(({ ip, device }) =>
				device ? device.name + ' · ' + ip : ip));
		}

		async function save(enabled, patch = {}) {
			if (updating)
				return false;
			updating = true;
			update(state);
			try {
				const extra = Object.fromEntries(extraKeys.filter(key => key in patch).map(key => [key, patch[key]]));
				const response = await configure(patch.client, patch.main_ip, patch.legacy_ip, enabled,
					JSON.stringify(extra));
				if (typeof response?.error !== 'string') throw new Error('Invalid configuration reply');
				if (response.error !== '') {
					notify(errors[response.error] || '参数无效或服务暂时不可用。');
					if (response.error === 'rollback' || response.error === 'rollback_rules')
						await getStatus().then(update, () => {});
					return false;
				}
				const saved = await getStatus();
				if (typeof saved?.enabled !== 'boolean' || (enabled != null && saved.enabled !== Boolean(enabled)) ||
					Object.entries(patch).some(([key, value]) => !sameSetting(key, value, saved[key])))
					throw new Error('Could not verify applied settings');
				update(saved);
				return true;
			} catch (error) {
				notify('无法确认路由器设置已应用。请稍后重试。');
				return false;
			} finally {
				updating = false;
				update(state);
			}
		}

		function fields() {
			const settings = Object.fromEntries(Object.entries(widgets).map(([key, widget]) => [
				key, (widget.getValue() || '').trim()
			]));
			return Object.assign(settings, devices.values());
		}

		primary.addEventListener('click', async function() {
			if (await save(1)) speed.refresh();
		});
		stop.addEventListener('click', async function() {
			if (await save(0)) speed.refresh();
		});
		function storePending(draft) {
			pending = draft;
			return session.setLocalData(pendingKey, draft);
		}
		this.stageSettings = function() {
			if (updating || L.hasViewPermission() === false) return;
			const patch = settingsPatch(fields(), formBase);
			const speedSettings = speed.draftSettings();
			if (!Object.keys(patch).length && !speed.settingsChanged(speedSettings)) {
				storePending(null);
				return;
			}
			const stored = storePending({ patch, speedSettings });
			notify(stored ? '已保存，等待应用。' : '修改已暂存在当前页面。', 'info');
		};
		function restoreFields(patch) {
			formBase = state;
			const settings = { ...state, ...patch };
			for (const [key, widget] of Object.entries(widgets))
				widget.setValue(settings[key] ?? settingDefaults[key] ?? '');
			devices.restoreDraft(settings);
		}
		this.restoreSettings = function() {
			if (updating || L.hasViewPermission() === false) return;
			if (pending?.settings && !pending.patch)
				notify('旧版暂存草稿无法区分已修改的字段，已载入路由器当前设置，请重新核对。', 'warning');
			restoreFields(pending?.patch);
			speed.restoreDraft(pending?.speedSettings);
		};
		this.submitSettings = async function() {
			if (updating || L.hasViewPermission() === false) return;
			const settings = fields();
			const speedSettings = speed.draftSettings();
			const patch = settingsPatch(settings, formBase);
			const changed = Object.keys(patch).length > 0;
			if (!changed && !speed.settingsChanged(speedSettings)) {
				storePending(null);
				return;
			}
			storePending({ patch, speedSettings });
			// Both LuCI apply actions use the plugin's configuration transaction.
			if (changed) {
				if (!await save(undefined, patch)) return;
				restoreFields(settingsPatch(fields(), settings));
			}
			const persisted = speed.applySettings(speedSettings);
			storePending(null);
			notify(persisted ? '已保存并应用。' : '测速设置仅在当前页面生效，浏览器无法保存。', 'info');
			updateControls();
		};
		clear.addEventListener('click', async function() {
			if (updating) return;
			updating = true;
			update(state);
			try {
				const response = await clearLogs();
				if (response.error) throw new Error(response.error);
				update(await getStatus());
			} catch (error) {
				notify('清空日志失败。');
			} finally {
				updating = false;
				update(state);
			}
		});

		const speed = await speedTest.render(function(group, ip) {
			widgets[group + '_ip'].setValue(ip);
			updateControls();
		}, function(group) {
			const key = group + '_ip';
			return { saved: state[key] || '', draft: (widgets[key].getValue() || '').trim(), running: state.running };
		});
		const toolbar = E('section', { class: 'cbi-section xb-row xb-service-head', 'aria-label': '服务状态' }, [
			E('div', {}, [status, serviceError]),
			E('div', { class: 'xb-row' }, [goDevices, primary, stop])
		]);
		const service = E('div', {}, [overviewForm, downloadForm]);
		const pages = { service, devices: devices.element, speed: speed.element, logs: logForm };
		const header = await new form.JSONMap({}, 'Xbox 下载助手', [
			'在 OpenWrt 上为选定设备加速 Xbox 下载。 ',
			E('a', {
				href: 'https://github.com/Zachery-Liu/luci-app-xboxdownload-openwrt/wiki',
				target: '_blank',
				rel: 'noopener noreferrer'
			}, ['使用说明'])
		]).render();
		header.id = 'cbi-xboxdownload-header';
		const title = header.querySelector('h2');
		const description = header.querySelector('.cbi-map-descr');
		title.classList.add('xb-title');
		title.append(' ', E('small', {}, '(OpenWrt)'));
		devices.element.addEventListener('xbox-devices-changed', function() {
			updateDeviceOverview();
			updateControls();
		});
		service.addEventListener('cbi-tab-active', () => {
			if (devices.selected().length) devices.loadOnce();
		});
		devices.element.addEventListener('cbi-tab-active', devices.loadOnce);
		const tabs = E('div', {}, Object.values(pages));
		tabs.addEventListener('input', updateControls);
		tabs.addEventListener('change', updateControls);
		const app = E('div', { class: 'xb-app' }, [
			E('link', { rel: 'stylesheet', href: L.resource('xboxdownload_openwrt/style.css') }),
			header, toolbar, tabs
		]);
		document.addEventListener('tooltip-open', function(event) {
			const tooltip = event.target;
			if (!tooltip.classList.contains('xb-help-tooltip')) return;
			const trigger = event.detail.target.getBoundingClientRect();
			const rightLimit = document.documentElement.clientWidth - tooltip.offsetWidth - 8;
			tooltip.style.left = Math.max(8, Math.min(trigger.left, rightLimit)) + window.scrollX + 'px';
		});
		const urls = Object.fromEntries(Object.keys(pages).map(name => [name, L.url(...viewPath.split('/'), name)]));
		const paths = new Map(Object.entries(urls).map(([name, url]) => [new URL(url, location.href).pathname, name]));
		let activePage;
		function openTab(name, push = true) {
			if (activePage === name) return;
			activePage = name;
			if (push) history.pushState(null, '', urls[name]);
			description.hidden = name !== 'service';
			for (const [key, pane] of Object.entries(pages)) pane.hidden = key !== name;
			for (const link of document.querySelectorAll('#tabmenu a[href]')) {
				const page = paths.get(link.pathname);
				if (!page) continue;
				link.closest('li')?.classList.toggle('active', page === name);
				if (page === name) link.setAttribute('aria-current', 'page');
				else link.removeAttribute('aria-current');
			}
			pages[name].dispatchEvent(new CustomEvent('cbi-tab-active', { detail: { tab: name } }));
		}
		// Keep draft edits and in-flight measurements when switching the native menu links in this tab.
		document.querySelector('#tabmenu')?.addEventListener('click', event => {
			const link = event.target.closest('a[href]');
			const name = link?.origin === location.origin && paths.get(link.pathname);
			if (!name || event.button || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
			event.preventDefault();
			openTab(name);
		});
		function showCurrentPage() {
			openTab(paths.get(location.pathname.replace(/\/$/, '')) || 'service', false);
		}
		window.addEventListener('popstate', showCurrentPage);
		goSpeed.addEventListener('click', function() {
			openTab('speed');
			speed.element.querySelector('[data-tab="speed-nodes"] > a')?.click();
		});
		goDevices.addEventListener('click', function() {
			openTab('devices');
			devices.openEditor();
		});
		manageDevices.addEventListener('click', () => openTab('devices'));
		if (pending && L.hasViewPermission() !== false) this.restoreSettings();
		updateDeviceOverview();
		update(initial);
		showCurrentPage();
		poll.add(function() {
			const snapshot = state;
			if (!updating)
				return getStatus().then(function(data) { if (!updating && state === snapshot) update(data); });
		}, 10);
		return app;
	}
});
