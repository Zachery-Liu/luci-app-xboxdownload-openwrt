'use strict';
'require view';
'require rpc';
'require ui';
'require poll';
'require xboxdownload_openwrt.speed as speedTest';
'require xboxdownload_openwrt.devices as devicePicker';
'require xboxdownload_openwrt.ipv6 as xboxIPv6';

const getStatus = rpc.declare({ object: 'xboxdownload_openwrt', method: 'status', expect: { '': {} } });
const configure = rpc.declare({
	object: 'xboxdownload_openwrt', method: 'configure',
	params: ['client', 'main_ip', 'legacy_ip', 'enabled', 'extra'], expect: { '': {} }
});
const clearLogs = rpc.declare({ object: 'xboxdownload_openwrt', method: 'clear_logs', expect: { '': {} } });
const extraKeys = ['upstream', 'global_ip', 'app_ip', 'ps_ip', 'ns_ip', 'ea_ip', 'battle_ip',
	'mode', 'filter_aaaa', 'log_mode', 'log_path', 'ipv6_dns', 'ipv6_block', 'ipv6_block_ip', 'ipv6_block_mac'];
const errors = {
	client: '请输入 1–8 个局域网设备 IPv4 地址，并确保它们和路由器地址不同。',
	cdn: 'CDN 节点必须是公网 IPv4 或 IPv6 地址。',
	upstream: '上游 DNS 必须是有效 IP 地址。',
	ipv6: '已配置 IPv6 CDN 节点，请先关闭 AAAA 过滤。',
	ipv6_device: '请从加速设备中选择 Xbox，并确认它的 MAC 地址。',
	ipv6_filter: '保留 IPv6 时，请先在高级设置中关闭「过滤已选设备的 AAAA 应答」。',
	ipv6_cdn: '关闭 Xbox 公网 IPv6 前，请把 Xbox COM、cn1、cn2 节点切换到 IPv4 或自动解析。',
	lan: '路由器的 lan 接口没有可用的 IPv4 地址。',
	lan_ipv6: 'LAN 暂无可用的 IPv6 链路本地地址，已尝试恢复原设置。',
	dns_upstream: '无法验证普通域名的 DNS 转发，已尝试恢复原设置。',
	start: '服务启动失败，已尝试恢复原设置。请查看系统日志。',
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
	'A download service stopped; system DNS restored': '加速监听已退出，设备已恢复使用系统 DNS。',
	'Could not activate nftables rules': '无法启用转发规则，设备继续使用系统 DNS。'
};

function notify(message) {
	ui.addNotification(null, E('p', {}, [message]), 'error');
}

function field(label, input, control) {
	return E('div', { class: 'xb-field' }, [
		E('label', { for: control || input.id }, [label]), input
	]);
}

function helpTooltip(id, label, description) {
	const button = E('button', {
		type: 'button', class: 'xb-help-button', 'aria-label': label,
		'aria-describedby': id
	}, ['?']);
	button.addEventListener('click', () => button.focus());
	return E('span', { class: 'xb-help' }, [
		button,
		E('span', { id: id, class: 'xb-tooltip', role: 'tooltip' }, [description])
	]);
}

function address(id, value, placeholder) {
	return E('input', {
		id: id, type: 'text', class: 'cbi-input-text',
		autocomplete: 'off', value: value || '', placeholder: placeholder || ''
	});
}

function select(id, value, choices) {
	const input = E('select', { id: id, class: 'cbi-input-select' }, choices.map(
		([key, label]) => E('option', { value: key }, [label])));
	input.value = value;
	return input;
}

function checkbox(id, value) {
	const input = E('input', { id: id, type: 'checkbox' });
	input.checked = value === '1';
	return input;
}

function drawLog(text) {
	const rows = text ? text.split('\n').map(line => line.split('\t')).filter(row => row.length === 4) : [];
	return E('table', { class: 'table' }, [
		E('thead', {}, [E('tr', { class: 'tr table-titles' },
			['时间', '客户端 IP', '请求', '域名 / 跳转'].map(label => E('th', { class: 'th', scope: 'col' }, [label])))]),
		E('tbody', {}, rows.length ? rows.map(([time, type, client, detail]) =>
			E('tr', { class: 'tr' }, [time, client, type, detail].map(value => E('td', { class: 'td' }, [value])))) :
			[E('tr', { class: 'tr' }, [E('td', { class: 'td', colspan: 4 }, ['暂无记录。'])])])
	]);
}

return view.extend({
	load: getStatus,
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	render: function(initial) {
		const nodeLabels = {
			main_ip: 'Xbox cn1 下载 IP', legacy_ip: 'Xbox cn2 下载 IP', global_ip: 'Xbox COM 下载 IP',
			app_ip: '微软商店 / Xbox 应用 IP', ps_ip: 'PlayStation 下载 IP', ns_ip: 'Nintendo Switch 下载 IP',
			ea_ip: 'EA 下载 IP', battle_ip: '战网国际服下载 IP'
		};
		const inputs = {};
		Object.keys(nodeLabels).forEach(key => { inputs[key] = address('xbox-' + key, initial[key], '自动解析'); });
		inputs.global_ip.placeholder = '留空按照服务模式处理';
		inputs.client = address('xbox-client', initial.client, '多个 IPv4 用逗号分隔');
		inputs.client.setAttribute('aria-label', '手动输入设备 IPv4');
		const devices = devicePicker.render(inputs.client);
		const ipv6 = xboxIPv6.render(devices, initial, helpTooltip('xbox-ipv6-help', 'IPv6 与下载加速',
			'保留 IPv6 时，请让 Xbox 使用路由器的 DNS。插件为配置了 IPv4 节点的下载域名返回 IPv4 地址，普通域名的 IPv6 解析照常。关闭公网 IPv6 时，请让 Xbox 使用路由器的 IPv4 DNS。'));
		inputs.upstream = address('xbox-upstream', initial.upstream, '使用路由器现有 DNS');
		inputs.mode = select('xbox-mode', initial.mode || 'redirect', [
			['redirect', 'DNS + HTTP 302'], ['dns', '仅 DNS 选点']
		]);
		inputs.filter_aaaa = checkbox('xbox-filter-aaaa', initial.filter_aaaa);
		inputs.filter_aaaa.setAttribute('aria-describedby', 'xbox-filter-aaaa-help');
		inputs.log_mode = select('xbox-log-mode', initial.log_mode || 'http', [
			['http', '仅 HTTP 302'], ['all', 'HTTP 302 和 DNS 查询'], ['off', '关闭']
		]);
		inputs.log_path = checkbox('xbox-log-path', initial.log_path);
		const status = E('strong', { class: 'xb-state', role: 'status' });
		const setup = E('p', { class: 'xb-muted' });
		const serviceError = E('p', { class: 'xb-error', role: 'status' });
		const log = E('div', { class: 'xb-log' });
		const primary = E('button', { class: 'btn xb-primary', type: 'button' });
		const stop = E('button', { class: 'btn', type: 'button' }, ['停止服务']);
		const saveOnly = E('button', { class: 'btn', type: 'button' }, ['保存设置']);
		const clear = E('button', { class: 'btn', type: 'button' }, ['清空插件日志']);
		const goSpeed = E('button', { class: 'btn', type: 'button' }, ['去测速选节点']);
		let state = initial;
		let updating = false;
		let shown;

		function updateControls() {
			const settings = fields();
			const defaults = { mode: 'redirect', filter_aaaa: '0', log_mode: 'http', log_path: '0', ipv6_dns: '1', ipv6_block: '0' };
			const dirty = Object.keys(settings).some(key => {
				const saved = state[key] || defaults[key] || '';
				if (key === 'client') {
					const normalize = value => Array.from(new Set(value.split(/[\s,，]+/).filter(Boolean))).join(',');
					return normalize(settings.client) !== normalize(saved);
				}
				return settings[key] !== saved;
			});
			const retryUpstream = state.running && !dirty && ['fallback', 'unavailable'].includes(state.upstream_state);
			primary.hidden = state.running && !dirty && !retryUpstream;
			primary.textContent = retryUpstream ? '重试上游 DNS' :
				state.running ? '保存设置' : state.enabled ? '重试启动' : '保存并启动';
			primary.disabled = updating || !state.router || !devices.selected().length;
			stop.hidden = !state.enabled;
			stop.disabled = updating;
			saveOnly.hidden = state.enabled || !dirty;
			saveOnly.disabled = updating;
			clear.disabled = updating || !state.log;
		}

		function update(data) {
			state = data;
			ipv6.update(data);
			devices.updateHits(data);
			status.textContent = data.running ? '服务运行中' : !data.enabled ? '服务已停止' :
				data.error ? '服务异常' : '服务正在启动';
			status.dataset.state = data.running ? 'running' : data.enabled ? 'pending' : 'stopped';
			const upstreamNotice = {
				fallback: '自定义上游 DNS 无响应，普通域名已切回系统 DNS，下载加速继续运行。',
				unavailable: 'DNS 上游无响应，普通域名可能无法解析。已配置的下载规则继续生效。'
			};
			serviceError.textContent = data.error ? serviceErrors[data.error] || data.error :
				data.running ? upstreamNotice[data.upstream_state] || '' : '';
			setup.textContent = data.router ? '路由器 IPv4 DNS ' + data.router +
				(data.running ? (data.http_running ? ' · DNS + HTTP 302' : ' · 仅 DNS 选点') : '') :
				'路由器的 lan 接口没有可用的 IPv4 地址。';
			if (shown !== data.log) {
				shown = data.log;
				log.replaceChildren(drawLog(data.log));
			}
			updateControls();
		}

		async function save(enabled, settings) {
			if (updating)
				return false;
			updating = true;
			update(state);
			try {
				const extra = Object.fromEntries(extraKeys.map(key => [key, settings[key] || '']));
				const response = await configure(settings.client, settings.main_ip, settings.legacy_ip, enabled,
					JSON.stringify(extra));
				if (response.error) {
					notify(errors[response.error] || '参数无效或服务暂时不可用。');
					return false;
				}
				update(await getStatus());
				return true;
			} catch (error) {
				notify('无法更新路由器设置。');
				return false;
			} finally {
				updating = false;
				update(state);
			}
		}

		function fields() {
			const settings = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [
				key, input.type === 'checkbox' ? input.checked ? '1' : '0' : input.value.trim()
			]));
			settings.client = settings.client.replace(/，/g, ',');
			return Object.assign(settings, ipv6.values());
		}

		primary.addEventListener('click', function() { save(1, fields()); });
		stop.addEventListener('click', function() { save(0, state); });
		saveOnly.addEventListener('click', function() { save(0, fields()); });
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

		const speed = speedTest.render(async function(group, ip) {
			const key = group + '_ip';
			const settings = Object.assign({}, state, { [key]: ip });
			if (!await save(state.enabled ? 1 : 0, settings) || state[key] !== ip)
				return false;
			inputs[key].value = ip;
			updateControls();
			return true;
		}, group => ({ ip: state[group + '_ip'], running: state.running }));
		const modeField = field('服务模式', inputs.mode);
		modeField.classList.add('xb-mode-field');

		const service = E('div', { 'data-tab': 'service', 'data-tab-title': '服务' }, [
			E('div', { class: 'xb-service-head' }, [
				E('div', {}, [status, setup, serviceError]),
				E('div', { class: 'xb-row' }, [primary, stop, saveOnly])
			]),
			E('div', { class: 'xb-service-grid' }, [
				E('section', { class: 'xb-section' }, [
					E('h3', { class: 'xb-device-heading' }, [
						E('label', { for: devices.control }, ['加速设备']),
						helpTooltip('xbox-device-name-help', '如何查看 Xbox 设备名称',
							'按手柄上的 Xbox 键，依次打开「档案和系统 → 设置 → 系统 → 主机信息 → 名称」。默认名称为 XBOX，改过名则以主机显示为准。')
					]),
					devices.element, ipv6.element
				]),
				E('section', { class: 'xb-section' }, [
					E('h3', {}, ['Xbox 下载线路']),
					E('div', { class: 'xb-fields' }, [
						modeField,
						field(nodeLabels.main_ip, inputs.main_ip),
						field(nodeLabels.legacy_ip, inputs.legacy_ip)
					]),
					goSpeed,
					E('details', { class: 'xb-details' }, [E('summary', {}, ['高级设置']),
						E('div', { class: 'xb-fields' }, [
							field('上游 DNS', inputs.upstream),
							...['global_ip', 'app_ip', 'ps_ip', 'ns_ip', 'ea_ip', 'battle_ip'].map(key => field(nodeLabels[key], inputs[key]))
						]),
						E('label', { class: 'xb-check', for: inputs.filter_aaaa.id }, [inputs.filter_aaaa, '过滤已选设备的 AAAA 应答']),
						E('p', { id: 'xbox-filter-aaaa-help', class: 'xb-muted' }, [
							'移除插件 DNS 应答中的 IPv6 地址，普通域名也受影响。使用「保留 IPv6，接管 DNS」时请保持关闭。'
						])
					])
				])
			]),
			E('section', { class: 'xb-section' }, [
				E('div', { class: 'xb-row xb-between xb-log-head' }, [
					E('h3', {}, ['最近日志 ', E('small', {}, ['最多 32 条'])]),
					E('div', { class: 'xb-row' }, [
						E('label', { class: 'xb-row', for: inputs.log_mode.id }, ['记录范围', inputs.log_mode]),
						E('label', { class: 'xb-check', for: inputs.log_path.id }, [inputs.log_path, '显示跳转路径（省略查询参数）']),
						clear
					])
				]), log
			])
		]);
		service.addEventListener('input', updateControls);
		service.addEventListener('change', updateControls);
		devices.element.addEventListener('xbox-devices-changed', updateControls);
		service.addEventListener('cbi-tab-active', devices.loadOnce);
		const tabs = E('div', {}, [service, speed]);
		const app = E('div', { class: 'xb-app' }, [
			E('link', { rel: 'stylesheet', href: L.resource('xboxdownload_openwrt/style.css') }),
			E('h2', { class: 'xb-title' }, ['Xbox 下载助手 ', E('small', {}, ['(OpenWrt)'])]),
			tabs
		]);
		// LuCI inserts the tab menu before the pane container in its parent.
		ui.tabs.initTabGroup(tabs.childNodes);
		goSpeed.addEventListener('click', function() {
			const tab = Array.from(app.querySelectorAll('.cbi-tabmenu a')).find(link => link.textContent.trim() === '测速');
			if (tab) tab.click();
		});
		update(initial);
		poll.add(function() {
			if (!updating && service.getAttribute('data-tab-active') === 'true')
				return getStatus().then(function(data) { if (!updating) update(data); });
		}, 10);
		return app;
	}
});
