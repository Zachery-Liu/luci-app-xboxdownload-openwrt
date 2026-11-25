'use strict';
'require view';
'require form';
'require rpc';
'require ui';
'require poll';
'require session';
'require xboxdownload_openwrt.speed as speedTest';
'require xboxdownload_openwrt.devices as devicePicker';
'require xboxdownload_openwrt.about as aboutPage';

const getStatus = rpc.declare({ object: 'xboxdownload_openwrt', method: 'status', reject: true });
const configure = rpc.declare({
	object: 'xboxdownload_openwrt', method: 'configure',
	params: ['client', 'main_ip', 'legacy_ip', 'enabled', 'extra', 'background'], reject: true
});
const configureStatus = rpc.declare({
	object: 'xboxdownload_openwrt', method: 'configure_status', params: ['job'], reject: true
});
const validateAddresses = rpc.declare({
	object: 'xboxdownload_openwrt', method: 'validate_addresses', params: ['kind', 'addresses'], reject: true
});
const clearLogs = rpc.declare({ object: 'xboxdownload_openwrt', method: 'clear_logs', expect: { '': {} } });
const extraKeys = ['upstream', 'probe_domain', 'global_ip', 'app_ip', 'ps_ip', 'ns_ip', 'ea_ip', 'battle_ip',
	'mode', 'filter_aaaa', 'log_mode', 'log_path', 'ipv6_devices', 'device_routes'];
const pendingKey = 'xboxdownload-openwrt.pending-settings';
const viewPath = 'admin/services/xboxdownload_openwrt';
const settingDefaults = { mode: 'redirect', filter_aaaa: '0', log_mode: 'http', log_path: '0' };
const dnsPauseNotices = {
	unavailable: '上游 DNS 探测失败，已撤下加速接管。设备使用系统 DNS，探测恢复后自动继续。',
	dns_unavailable: '本地 DNS 服务探测失败，已撤下加速接管。设备使用系统 DNS，探测恢复后自动继续。'
};

function dnsPaused(state) {
	return state.enabled && !state.running && Object.hasOwn(dnsPauseNotices, state.upstream_state);
}
const errors = {
	client: '请输入 1–8 个局域网设备 IPv4 地址，并确保它们和路由器地址不同。',
	client_subnet: '设备 IPv4 必须是路由器 LAN 子网内可用的主机地址。',
	lan_subnet: '无法读取路由器的 LAN IPv4 子网，请检查 LAN 状态。',
	cdn: 'CDN 节点必须是公网 IPv4 或 IPv6 地址。',
	cdn_family: 'Xbox cn1、cn2 线路请填写公网 IPv4 节点。',
	upstream: '上游 DNS 必须是有效 IP 地址。',
	probe_domain: '请输入有效的探测域名，例如 dns.example.com。',
	ipv6: '已配置 IPv6 CDN 节点，请先关闭 AAAA 过滤。',
	ipv6_device: '请检查加速设备的 IPv4 与 IPv6 策略。接管 DNS 或关闭公网 IPv6 时，需要填写设备的 MAC 地址。',
	ipv6_mac_duplicate: '同一个 MAC 地址只能配置一次 IPv6 策略，请检查加速设备列表。',
	ipv6_reload: '设备配置已升级，请刷新页面后再保存。',
	ipv6_filter: '保留 IPv6 的设备需要关闭其自定义线路的 AAAA 过滤。',
	ipv6_cdn: '关闭公网 IPv6 的设备只能在自定义线路中填写 IPv4 节点。',
	device_routes: '请检查设备的自定义线路，并确认设备仍在已选列表中。',
	lan: '路由器的 lan 接口没有可用的 IPv4 地址。',
	lan_ipv6: 'LAN 暂无可用的 IPv6 链路本地地址，已恢复原设置。',
	dns_upstream: '无法验证普通域名的 DNS 转发，已恢复原设置。',
	http_redirect: 'HTTP 302 跳转检查失败，已恢复原设置。',
	start: '服务启动失败，已恢复原设置。请查看系统日志。',
	stop: '无法确认服务已停止，已恢复原设置。',
	rollback: '无法恢复旧设置或服务。已撤下接管规则，请查看系统日志。',
	rollback_rules: '无法恢复旧设置或服务，也无法确认接管规则已撤下。请查看系统日志。',
	job_lost: '无法确认配置操作结果。请刷新服务状态后再试。',
	save: '保存设置失败。',
	busy: '配置正在更新，请稍后再试。'
};
const serviceErrors = {
	'LAN IPv4 unavailable': 'LAN 暂无 IPv4 地址。',
	'Invalid settings: lan_subnet': errors.lan_subnet,
	'Invalid settings: client_subnet': errors.client_subnet,
	'Invalid settings: cdn': errors.cdn,
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
	'Supervisor exited unexpectedly; system DNS restored': '监督进程异常退出，已撤下接管规则。',
	'Could not activate nftables rules': '无法启用转发规则，设备继续使用系统 DNS。'
};

function notify(message, style = 'error') {
	ui.addNotification(null, E('p', {}, [message]), style);
}

function showReadonlyValues(container, values) {
	for (const [index, value] of values.entries()) {
		const row = container.children[index] || container.appendChild(E('div', { class: 'xb-overview-value' }));
		if (row.textContent !== value) row.textContent = value;
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
		const active = value => value.toUpperCase().split(',').filter(row => !row.endsWith('//SYSTEM')).sort().join(',');
		return active(first) === active(second);
	}
	return first === second;
}

function settingsPatch(settings, original) {
	const patch = Object.fromEntries(Object.entries(settings).filter(([key, value]) =>
		!sameSetting(key, value, original[key])));
	if ('client' in patch || 'ipv6_devices' in patch || 'device_routes' in patch) {
		patch.client = settings.client;
		patch.ipv6_devices = settings.ipv6_devices;
	}
	return patch;
}

return view.extend({
	load: function() {
		const cached = session.getLocalData('menu');
		const oldEntry = cached?.children?.admin?.children?.services?.children?.xboxdownload_openwrt;
		if (oldEntry?.action?.type === 'view' || (oldEntry?.children && !oldEntry.children.about)) {
			ui.menu.flushCache();
			if (session.getLocalData('menu') == null) location.reload();
		}
		return getStatus();
	},
	handleSave: function() {
		return this.stageSettings();
	},
	handleReset: function() {
		return this.restoreSettings(true);
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
		const clear = E('button', { class: 'cbi-button cbi-button-remove', type: 'button',
			title: '仅重置此页显示，旧记录仍保留在系统日志中。' }, ['重置日志显示']);
		const options = {};
		function option(section, type, key, label, description) {
			const value = section.option(type, key, label, description);
			options[key] = value;
			return value;
		}
		const mode = option(downloads, form.ListValue, 'mode', '服务模式',
			'DNS + HTTP 302 可将 Xbox 的 HTTP 下载切到 CN 线路。仅 DNS 选点时，cn1、cn2 只影响对应的 .cn 域名，原始 .com 域名使用 Xbox com 下载 IP 或系统 DNS。');
		mode.default = 'redirect';
		mode.value('redirect', 'DNS + HTTP 302');
		mode.value('dns', '仅 DNS 选点');
		for (const [key, label] of Object.entries(nodeLabels)) {
			option(downloads, form.Value, key, label).placeholder = '自动解析';
		}
		option(downloads, form.Value, 'upstream', '上游 DNS').placeholder = '使用路由器现有 DNS';
		option(downloads, form.Value, 'probe_domain', 'DNS 探测域名',
			'可填写一个本网络允许解析且返回公网 IPv4 的域名。插件优先查询它，失败时再使用内置探针。').placeholder = '使用内置探针';
		option(downloads, form.Flag, 'filter_aaaa', '过滤已选设备的 AAAA 应答',
			'移除默认线路 DNS 应答中的 IPv6 地址。选择「保留 IPv6，接管 DNS」的设备仍会收到普通域名的 IPv6 地址。');
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

		const devices = await devicePicker.render(initial, validateAddresses, nodeLabels, () =>
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
			const retryUpstream = state.running && state.upstream_state === 'fallback';
			const hasStartDevices = hasDevices || Boolean(state.client);
			primary.hidden = (state.running && !retryUpstream) || dnsPaused(state);
			primary.textContent = retryUpstream ? '重试上游 DNS' : state.enabled ? '重试启动' : '启动服务';
			primary.disabled = updating || !state.router || !hasStartDevices;
			primary.title = hasStartDevices ? '' : '请先添加设备';
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
			showReadonlyValues(overviewIPv4, [data.router || '无可用地址']);
			showReadonlyValues(overviewIPv6, addresses.length ? addresses : ['无可用地址']);
			const route = { present: '已发现 IPv6 默认路由。', absent: '未发现 IPv6 默认路由。' };
			const announced = (data.lan_advertised_dns || '').split(/\s+/).filter(ip => ip.includes(':'));
			ipv6Help.dataset.tooltip = ipv6HelpText + (route[data.wan6_state] || '') +
				(announced.length ? '配置的 IPv6 通告 DNS 为 ' + announced.join('、') + '。' : '');
			ipv6Help.setAttribute('aria-description', ipv6Help.dataset.tooltip);
			const paused = dnsPaused(data);
			const serviceLabel = data.running ? '服务运行中' : paused ? '加速已暂停' : !data.enabled ? '服务已停止' :
				data.error ? '服务异常' : '服务正在启动';
			if (status.textContent !== serviceLabel) status.textContent = serviceLabel;
			status.dataset.state = data.running ? 'running' : data.enabled ? 'pending' : 'stopped';
			const notice = data.error ? serviceErrors[data.error] || data.error :
				!data.router ? '路由器的 LAN 接口没有可用的 IPv4 地址。' :
				paused ? dnsPauseNotices[data.upstream_state] :
				data.running && data.upstream_state === 'fallback' ?
					'自定义上游 DNS 无响应，普通域名已切回系统 DNS，下载加速继续运行。' : '';
			if (serviceError.textContent !== notice) serviceError.textContent = notice;
			if (shown !== data.log) {
				shown = data.log;
				const rows = (data.log || '').split('\n')
					.map(line => line.split('\t')).filter(row => row.length === 4)
					.map(([time, request, client, detail]) => [time, client, request, detail]);
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
			showReadonlyValues(overviewDevices, selected.map(({ ip, device }) =>
				device ? device.name + ' · ' + ip : ip));
		}

		async function save(enabled, patch = {}) {
			if (updating)
				return false;
			updating = true;
			update(state);
			speed.refresh();
			try {
				const extra = Object.fromEntries(extraKeys.filter(key => key in patch).map(key => [key, patch[key]]));
			let response = await configure(patch.client, patch.main_ip, patch.legacy_ip, enabled,
				JSON.stringify(extra), 1);
			const job = response?.job;
			if (typeof job === 'string') {
				const deadline = Date.now() + 120000;
				do {
					await new Promise(resolve => setTimeout(resolve, 500));
					response = await configureStatus(job);
				} while (response?.pending === true && Date.now() < deadline);
			}
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
				speed.refresh();
			}
		}

		function fields() {
			const settings = Object.fromEntries(Object.entries(widgets).map(([key, widget]) => [
				key, (widget.getValue() || '').trim()
			]));
			return Object.assign(settings, devices.values());
		}

		primary.addEventListener('click', async function() {
			if (updating || L.hasViewPermission() === false) return;
			if (Object.keys(settingsPatch(fields(), formBase)).length || speed.settingsChanged()) {
				notify('您还有未保存或未应用的内容。请先「保存并应用」或「复位」，再启动服务。', 'warning');
				return;
			}
			if (speed.isTesting()) {
				notify('请等待测速结束，或停止测速后再启动服务。', 'warning');
				return;
			}
			await save(1);
		});
		stop.addEventListener('click', async function() {
			if (updating || L.hasViewPermission() === false) return;
			speed.stopTest();
			await save(0);
		});
		function storePending(draft) {
			pending = draft;
			return session.setLocalData(pendingKey, draft);
		}
		function speedDraft() {
			const draft = speed.draftSettings();
			if (speed.validSettings(draft)) return draft;
			notify('整批流量上限请输入非负数字，最多 9 位小数。填 0 表示不限。');
			return null;
		}
		this.stageSettings = function() {
			if (updating || L.hasViewPermission() === false) return;
			const patch = settingsPatch(fields(), formBase);
			const speedSettings = speedDraft();
			if (!speedSettings) return;
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
		this.restoreSettings = function(discardDraft = false) {
			if (updating || L.hasViewPermission() === false) return;
			if (discardDraft) storePending(null);
			if (pending?.settings && !pending.patch)
				notify('旧版暂存草稿无法区分已修改的字段，已载入路由器当前设置，请重新核对。', 'warning');
			restoreFields(pending?.patch);
			speed.restoreDraft(pending?.speedSettings);
		};
		this.submitSettings = async function() {
			if (updating || L.hasViewPermission() === false) return;
			const settings = fields();
			const speedSettings = speedDraft();
			if (!speedSettings) return;
			const patch = settingsPatch(settings, formBase);
			const changed = Object.keys(patch).length > 0;
			if (!changed && !speed.settingsChanged(speedSettings)) {
				storePending(null);
				return;
			}
			if (speed.isTesting()) {
				notify('测速正在进行。请等待测速结束，或停止测速后再应用设置。', 'warning');
				return;
			}
			storePending({ patch, speedSettings });
			// Both LuCI apply actions use the plugin's configuration transaction.
			if (changed) {
				if (!await save(undefined, patch)) return;
				restoreFields(settingsPatch(fields(), settings));
			}
			const persisted = speed.applySettings(speedSettings);
			const remaining = settingsPatch(fields(), formBase);
			const remainingSpeed = speed.draftSettings();
			storePending(Object.keys(remaining).length || speed.settingsChanged(remainingSpeed) ?
				{ patch: remaining, speedSettings: remainingSpeed } : null);
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
				notify('重置日志显示失败。');
			} finally {
				updating = false;
				update(state);
			}
		});

		const speed = await speedTest.render(validateAddresses, function(group, ip) {
			widgets[group + '_ip'].setValue(ip);
			updateControls();
		}, function(group) {
			const key = group + '_ip';
			return { saved: state[key] || '', draft: (widgets[key].getValue() || '').trim(), running: state.running };
		}, () => updating);
		const toolbar = E('section', { class: 'cbi-section xb-row xb-service-head', 'aria-label': '服务状态' }, [
			E('div', {}, [status, serviceError]),
			E('div', { class: 'xb-row' }, [goDevices, primary, stop])
		]);
		const service = E('div', {}, [overviewForm, downloadForm]);
		const about = await aboutPage.render(L.resource('xboxdownload_openwrt/logo.svg'), () => {
			if (updating) return '请等待配置操作完成后再安装更新。';
			if (Object.keys(settingsPatch(fields(), formBase)).length || speed.settingsChanged())
				return '您还有未保存或未应用的内容。请先「保存并应用」或「复位」，再安装更新。';
			if (speed.isTesting()) return '请等待测速结束，或停止测速后再安装更新。';
			return '';
		});
		const pages = { service, devices: devices.element, speed: speed.element, logs: logForm, about };
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
			header.hidden = name === 'about';
			toolbar.hidden = name === 'about';
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
