'use strict';
'require baseclass';
'require form';
'require rpc';
'require ui';

const getHints = rpc.declare({ object: 'luci-rpc', method: 'getHostHints', expect: { '': {} }, reject: true });
const getLan = rpc.declare({ object: 'network.interface.lan', method: 'status', expect: { '': {} }, reject: true });

function ipNumber(address) {
	const octets = typeof address === 'string' && address.split('.');
	if (!octets || octets.length !== 4 ||
	    !octets.every(value => /^(0|[1-9]\d{0,2})$/.test(value) && Number(value) <= 255))
		return null;
	return octets.reduce((sum, value) => sum * 256 + Number(value), 0);
}

function lanDevices(hints, lan) {
	const interfaces = Array.isArray(lan['ipv4-address']) ? lan['ipv4-address'] : [];
	const routerIPs = new Set(interfaces.map(item => item.address));
	const subnets = interfaces.map(item => ({
		base: ipNumber(item.address), bits: item.mask == null || item.mask === '' ? NaN : Number(item.mask)
	}))
		.filter(item => item.base != null && Number.isInteger(item.bits) && item.bits >= 0 && item.bits <= 32)
		.map(item => {
			const size = 2 ** (32 - item.bits);
			return { first: Math.floor(item.base / size) * size, size: size };
		});
	const devices = new Map();
	Object.entries(hints).forEach(function([mac, hint]) {
		if (!hint || !/^(?:[\da-f]{2}:){5}[\da-f]{2}$/i.test(mac))
			return;
		const ips = Array.isArray(hint.ipaddrs) ? hint.ipaddrs : hint.ipv4;
		const ipv6 = Array.isArray(hint.ip6addrs) ? hint.ip6addrs : hint.ipv6;
		if (!Array.isArray(ips))
			return;
		for (const ip of ips) {
			const number = ipNumber(ip);
			if (number == null || number >= 224 * 2 ** 24 || /^(0|127|169\.254)\./.test(ip) ||
			    routerIPs.has(ip) || devices.has(ip) ||
			    !subnets.some(({ first, size }) => number >= first && number < first + size &&
			        (size <= 2 || (number !== first && number !== first + size - 1))))
				continue;
			const name = typeof hint.name === 'string' ? hint.name.trim() : '';
			devices.set(ip, {
				name: name || '未命名设备', mac: mac.toUpperCase(), number: number,
				ipv6: Array.isArray(ipv6) ? ipv6.filter(value => typeof value === 'string' && value.includes(':')) : []
			});
		}
	});
	return devices;
}

function latestRedirects(log) {
	const hits = new Map();
	for (const line of (log || '').split('\n')) {
		const [time, type, ip, detail] = line.split('\t');
		if (type !== 'HTTP 302' || !detail || hits.has(ip))
			continue;
		const domains = /^([a-z0-9.-]+) -> ([a-z0-9.-]+)(?:\/|$)/i.exec(detail);
		if (domains)
			hits.set(ip, time + ' · ' + domains[1] + ' → ' + domains[2]);
	}
	return hits;
}

const maxDevices = 8;
const modes = {
	system: '使用系统设置',
	dns: '保留 IPv6，接管 DNS',
	block: '关闭公网 IPv6'
};

function profiles(value) {
	const entries = new Map();
	for (const row of (value || '').split(',')) {
		const [ip, mac, mode] = row.split('/');
		if (ip && Object.hasOwn(modes, mode))
			entries.set(ip, { mode, mac: mac.toUpperCase() });
	}
	return entries;
}

function selectedDevices(settings, routeKeys) {
	const saved = profiles(settings.ipv6_devices);
	const entries = new Map((settings.client || '').split(/[\s,，]+/).filter(Boolean)
		.map(ip => [ip, saved.get(ip) || { mode: 'system', mac: '' }]));
	for (const row of (settings.device_routes || '').split(',')) {
		const [ip, ...values] = row.split('/');
		if (entries.has(ip) && values.length === routeKeys.length)
			entries.get(ip).route = Object.fromEntries(routeKeys.map((key, index) => [key, values[index]]));
	}
	return entries;
}

function button(label, style, description) {
	return E('button', {
		type: 'button', class: 'cbi-button cbi-button-' + style, 'aria-label': description
	}, [label]);
}

return baseclass.extend({
	render: async function(initial, validateAddresses, nodeLabels, deviceNameHelp) {
		const routeKeys = ['filter_aaaa', 'upstream', ...Object.keys(nodeLabels)];
		let entries = selectedDevices(initial, routeKeys);
		const table = new ui.Table(['设备', 'IPv4', 'MAC 地址', 'IPv6 策略', '操作'], { sortable: false });
		const tableNode = table.render();
		tableNode.setAttribute('aria-label', '加速设备');
		const add = button('新增设备', 'add');
		const count = E('span', { class: 'xb-muted' });
		const map = new form.JSONMap({ devices: {} });
		const section = map.section(form.NamedSection, 'devices', 'devices', '加速设备');
		section.option(form.DummyValue, '_table').render = () => E([
			E('div', { class: 'xb-device-table', tabindex: 0, role: 'region', 'aria-label': '设备列表' }, [tableNode]),
			E('div', { class: 'cbi-page-actions' }, [count, ' ', add])
		]);
		const element = await map.render();
		element.id = 'cbi-xboxdownload-devices';
		let discovered = new Map();
		let started = false;
		let pendingDiscovery = null;
		let discoveryError = '';
		let state = initial;

		function draw() {
			count.textContent = entries.size + ' / ' + maxDevices + ' 台';
			add.disabled = entries.size >= maxDevices;
			const rows = Array.from(entries, ([ip, profile]) => {
				const device = discovered.get(ip);
				const edit = button('编辑', 'edit', '编辑设备 ' + ip);
				const remove = button('移除', 'remove', '移除设备 ' + ip);
				edit.addEventListener('click', () => openEditor(ip));
				remove.addEventListener('click', () => {
					entries.delete(ip);
					draw();
				});
				const moved = profile.mac && device?.mac !== profile.mac &&
					Array.from(discovered).find(([address, item]) => address !== ip && item.mac === profile.mac)?.[0];
				const conflict = profile.mac && device?.mac && device.mac !== profile.mac;
				const address = moved ? E('span', {}, [ip, E('small', { class: 'xb-node' }, ['发现新地址 ' + moved + '，请编辑设备'])]) :
					conflict ? E('span', {}, [ip, E('small', { class: 'xb-node' }, ['MAC 不匹配，已跳过 IPv4 接管'])]) : ip;
				const policy = profile.route ? E('div', {}, [modes[profile.mode], E('small', { class: 'xb-node' }, ['自定义线路'])]) : modes[profile.mode];
				return [device?.name || '未命名设备', address, profile.mac || device?.mac || '—', policy,
					E('div', { class: 'xb-row' }, [edit, remove])];
			});
			table.update(rows, '尚未添加设备。').querySelectorAll('th[data-sortable-row]')
				.forEach(th => th.removeAttribute('data-sortable-row'));
			element.dispatchEvent(new CustomEvent('xbox-devices-changed'));
		}

		function refreshDevices() {
			if (!pendingDiscovery) {
				started = true;
				discoveryError = '';
				pendingDiscovery = Promise.all([getHints(), getLan()]).then(([hints, lan]) => {
					discovered = lanDevices(hints, lan);
				}).catch(() => {
					discoveryError = '读取局域网设备失败，可刷新或手动填写。';
				}).finally(() => {
					pendingDiscovery = null;
					draw();
				});
			}
			return pendingDiscovery;
		}

		async function openEditor(originalIP) {
			const editing = originalIP != null;
			if (!editing && entries.size >= maxDevices) return;
			const profile = entries.get(originalIP) || { mode: 'dns', mac: '' };
			const known = discovered.get(originalIP);
			const map = new form.JSONMap({ device: {
				ipv4: originalIP || '', ipv6: '未发现', mode: profile.mode, mac: profile.mac || known?.mac || '',
				routing: profile.route ? 'custom' : 'shared', filter_aaaa: '0', ...profile.route
			} });
			const section = map.section(form.NamedSection, 'device', 'device');
			const pickerOption = section.option(form.ListValue, 'host', '局域网设备');
			pickerOption.value('', '选择局域网设备');
			const addressOption = section.option(form.Value, 'ipv4', 'IPv4 地址',
				'IPv4 加速按此地址识别设备。建议在路由器的 DHCP 设置中为该设备保留此地址。');
			addressOption.placeholder = '例如 192.168.1.156';
			const address6Option = section.option(form.Value, 'ipv6', 'IPv6 地址');
			const modeOption = section.option(form.ListValue, 'mode', 'IPv6 策略');
			for (const [value, label] of Object.entries(modes)) modeOption.value(value, label);
			const macOption = section.option(form.Value, 'mac', 'MAC 地址');
			macOption.placeholder = 'AA:BB:CC:DD:EE:FF';
			const routingOption = section.option(form.ListValue, 'routing', '下载线路');
			routingOption.value('shared', '使用服务页设置');
			routingOption.value('custom', '自定义');
			const filterOption = section.option(form.ListValue, 'filter_aaaa', '过滤 AAAA 应答');
			filterOption.value('0', '关闭');
			filterOption.value('1', '开启');
			filterOption.depends({ routing: 'custom', mode: 'system' });
			filterOption.depends({ routing: 'custom', mode: 'block' });
			const routeOptions = Object.entries({ upstream: '上游 DNS', ...nodeLabels }).map(([key, label]) => {
				const value = section.option(form.Value, key, label);
				value.placeholder = key === 'upstream' ? '使用路由器现有 DNS' : '自动解析';
				value.depends('routing', 'custom');
				return [key, value];
			});

			const body = await map.render();
			body.classList.add('xb-device-editor');
			const control = (option, selector) => option.getUIElement('device').node.querySelector(selector);
			const picker = control(pickerOption, 'select');
			const address = control(addressOption, 'input');
			const address6 = control(address6Option, 'input');
			const mode = control(modeOption, 'select');
			const mac = control(macOption, 'input');
			const routing = control(routingOption, 'select');
			const filter = control(filterOption, 'select');
			const routeInputs = routeOptions.map(([key, option]) => [key, control(option, 'input')]);
			function routeSettings() {
				if (routing.value !== 'custom') return null;
				return { filter_aaaa: mode.value === 'dns' ? '0' : filter.value,
					...Object.fromEntries(routeInputs.map(([key, input]) => [key, input.value.trim()])) };
			}
			address.autocomplete = 'off';
			address6.readOnly = true;
			mac.autocomplete = 'off';
			mac.maxLength = 17;
			const refresh = button('刷新设备', 'action');
			const pickerField = picker.closest('.cbi-value-field');
			pickerField.classList.add('xb-device-picker');
			pickerField.append(deviceNameHelp(), refresh);
			const status = E('p', { class: 'xb-muted', role: 'status' });
			const note = E('p', { class: 'xb-muted', hidden: true });
			const error = E('p', { class: 'xb-error', role: 'alert' });
			const cancel = button('取消', 'neutral');
			const confirm = button(editing ? '确定' : '添加', 'positive');
			cancel.classList.add('btn');
			confirm.classList.add('btn');
			body.append(status, note, error);

			function drawChoices() {
				const choices = Array.from(discovered, ([ip, device]) => ({ ip, ...device }))
					.filter(device => device.ip === originalIP || !entries.has(device.ip))
					.sort((a, b) => a.number - b.number);
				const placeholder = pendingDiscovery ? '正在读取设备…' :
					choices.length ? '选择局域网设备' : '暂无可选设备';
				picker.replaceChildren(E('option', { value: '' }, [placeholder]),
					...choices.map(device => E('option', { value: device.ip }, [
						device.name + ' · ' + device.ip
					])));
				picker.value = choices.some(device => device.ip === address.value.trim()) ? address.value.trim() : '';
				picker.disabled = !!pendingDiscovery || choices.length === 0;
				refresh.disabled = !!pendingDiscovery;
				status.textContent = discoveryError;
			}

			function updateNote() {
				const ip = address.value.trim(), device = discovered.get(ip);
				const reports = [];
				const typedMac = mac.value.trim().replace(/-/g, ':').toUpperCase();
				if (device && typedMac && typedMac !== device.mac)
					reports.push('路由器记录的 MAC 为 ' + device.mac + '，请确认设备。');
				const ipv6 = device?.ipv6.find(value => /^[23][0-9a-f]{3}:/i.test(value)) || device?.ipv6[0];
				address6.value = ipv6 || '未发现';
				if (state.running && (state.client || '').split(',').includes(ip)) {
					reports.push('IPv4 加速已启用');
					const currentMode = profiles(state.ipv6_devices).get(ip)?.mode;
					if (currentMode === 'dns' && state.ipv6_dns_active)
						reports.push('IPv6 DNS 接管已启用');
					if (currentMode === 'block' && state.ipv6_block_active)
						reports.push('公网 IPv6 限制已启用');
					if (state.http_running && state.log_mode !== 'off') {
						const hit = latestRedirects(state.log).get(ip);
						if (hit) reports.push('最近 302 ' + hit);
					}
				}
				note.textContent = reports.join(' · ');
				note.hidden = !reports.length;
			}

			function loadChoices() {
				const loaded = refreshDevices();
				drawChoices();
				return loaded.then(() => { drawChoices(); updateNote(); });
			}

			picker.addEventListener('change', function() {
				address.value = picker.value;
				mac.value = discovered.get(picker.value)?.mac || '';
				error.textContent = '';
				updateNote();
			});
			address.addEventListener('input', function() {
				// A changed address needs its own MAC instead of the previous device's.
				if (address.value.trim() !== picker.value) {
					mac.value = discovered.get(address.value.trim())?.mac || '';
					drawChoices();
				}
				error.textContent = '';
				updateNote();
			});
			mode.addEventListener('change', function() { error.textContent = ''; updateNote(); });
			mac.addEventListener('input', function() { error.textContent = ''; updateNote(); });
			refresh.addEventListener('click', loadChoices);
			cancel.addEventListener('click', () => ui.hideModal());
			confirm.addEventListener('click', async function() {
				const ip = address.value.trim();
				const value = mac.value.trim().replace(/-/g, ':').toUpperCase();
				const policy = mode.value;
				const route = routeSettings();
				if (route && [route.main_ip, route.legacy_ip].some(value => value.includes(':'))) {
					error.textContent = 'Xbox cn1、cn2 线路请填写公网 IPv4 节点。';
					return;
				}
				if (route && Object.values(route).some(value => !/^[0-9a-f:.]*$/i.test(value))) {
					error.textContent = '请检查自定义线路里的 DNS 和 CDN IP 地址。';
					return;
				}
				if (ipNumber(ip) == null) {
					error.textContent = '请输入有效的设备 IPv4 地址，且与路由器地址不同。';
					address.focus();
					return;
				}
				if (ip !== originalIP && entries.has(ip)) {
					error.textContent = '此 IPv4 地址已添加。';
					address.focus();
					return;
				}
				if ((value || policy !== 'system') && (!/^[0-9A-F][02468ACE](?::[0-9A-F]{2}){5}$/.test(value) ||
				    value === '00:00:00:00:00:00')) {
					error.textContent = '当前 IPv6 策略需要有效的设备 MAC 地址。';
					mac.focus();
					return;
				}
				if (value && Array.from(entries).some(([otherIP, other]) =>
					otherIP !== originalIP && other.mac === value)) {
					error.textContent = '该 MAC 地址已用于另一台设备。';
					mac.focus();
					return;
				}
				if (ip !== originalIP) {
					confirm.disabled = true;
					let validation;
					try {
						validation = await validateAddresses('client', ip);
					} catch (failure) {
						validation = {};
					} finally {
						confirm.disabled = false;
					}
					if (!body.isConnected || !document.body.classList.contains('modal-overlay-active') ||
					    ip !== address.value.trim() || policy !== mode.value ||
					    JSON.stringify(route) !== JSON.stringify(routeSettings()) ||
					    value !== mac.value.trim().replace(/-/g, ':').toUpperCase())
						return;
					if (validation?.error !== '') {
						error.textContent = validation?.error === 'client_subnet' ?
							'请输入路由器 LAN 子网内可用的设备 IPv4 地址。' :
							validation?.error === 'client' ? '请输入有效的设备 IPv4 地址。' :
							'无法校验 LAN IPv4 子网，请检查 LAN 状态后重试。';
						address.focus();
						return;
					}
				}
				if (editing && originalIP !== ip) entries.delete(originalIP);
				entries.set(ip, { mode: policy, mac: value, route });
				ui.hideModal();
				draw();
			});
			const title = editing ? '编辑设备' : '新增设备';
			const dialog = ui.showModal(title, [
				body,
				E('div', { class: 'button-row' }, [cancel, ' ', confirm])
			], 'cbi-modal', 'xb-device-modal');
			dialog.setAttribute('role', 'dialog');
			dialog.setAttribute('aria-label', title);
			drawChoices();
			updateNote();
			if (!started) loadChoices();
			else if (pendingDiscovery) pendingDiscovery.then(() => { drawChoices(); updateNote(); });
		}

		add.addEventListener('click', () => openEditor());
		draw();
		return {
			element,
			openEditor,
			selected: function() {
				return Array.from(entries.keys()).filter(ip => ipNumber(ip) != null)
					.map(ip => ({ ip, device: discovered.get(ip) }));
			},
			values: function() {
				return {
					client: Array.from(entries.keys()).join(','),
					ipv6_devices: Array.from(entries, ([ip, { mode, mac }]) =>
						[ip, mac, mode].join('/')).join(','),
					device_routes: Array.from(entries).filter(([, profile]) => profile.route)
						.map(([ip, { route }]) => [ip, ...routeKeys.map(key => route[key])].join('/')).join(',')
				};
			},
			update: function(data) { state = data; },
			restoreDraft: function(settings) {
				entries = selectedDevices(settings, routeKeys);
				draw();
			},
			loadOnce: function() { if (!started) refreshDevices(); }
		};
	}
});
