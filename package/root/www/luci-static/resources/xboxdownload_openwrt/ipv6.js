'use strict';
'require baseclass';

return baseclass.extend({
	render: function(devices, initial, help) {
		const mode = E('select', { id: 'xbox-ipv6-mode', class: 'cbi-input-select' }, [
			E('option', { value: 'system' }, ['使用系统设置']),
			E('option', { value: 'dns' }, ['保留 IPv6，接管 DNS']),
			E('option', { value: 'block' }, ['关闭所选 Xbox 的公网 IPv6'])
		]);
		mode.value = initial.ipv6_dns === '1' ? 'dns' : initial.ipv6_block === '1' ? 'block' : 'system';
		const target = E('select', {
			id: 'xbox-ipv6-target', class: 'cbi-input-select', 'aria-label': '应用 IPv6 设置的 Xbox'
		});
		const mac = E('input', {
			type: 'text', class: 'cbi-input-text', 'aria-label': 'Xbox MAC 地址',
			placeholder: 'AA:BB:CC:DD:EE:FF', maxlength: 17, autocomplete: 'off',
			value: initial.ipv6_block_mac || ''
		});
		const targetStatus = E('p', { class: 'xb-muted', role: 'status' });
		const routerStatus = E('p', { class: 'xb-muted', role: 'status' });
		const ruleStatus = E('p', { class: 'xb-muted', role: 'status' });
		let address = initial.ipv6_block_ip || '';

		function drawTarget() {
			const active = devices.selected().find(entry => entry.ip === address);
			const device = active && active.device;
			const publicAddress = device && device.ipv6.find(ip => /^[23][0-9a-f]{3}:/i.test(ip));
			let message = publicAddress ? '设备 IPv6：发现公网地址 ' + publicAddress :
				device && device.ipv6.length ? '设备 IPv6：仅发现本地地址' : '设备 IPv6：暂无记录';
			if (device && mac.value && mac.value.trim().toUpperCase().replace(/-/g, ':') !== device.mac)
				message += '。设备记录的 MAC 为 ' + device.mac + '，请确认选中的 Xbox。';
			targetStatus.textContent = message;
			targetStatus.hidden = !address;
			target.hidden = mode.value === 'system' || target.options.length < 3;
			mac.hidden = mode.value === 'system' || !address;
		}

		function syncTargets() {
			const selected = devices.selected();
			let active = selected.find(entry => entry.ip === address);
			if (!active) {
				if (address && mode.value === 'block') mode.value = 'system';
				active = selected.length === 1 ? selected[0] : null;
				address = active ? active.ip : '';
				mac.value = '';
			}
			if (active && active.device && !mac.value)
				mac.value = active.device.mac;
			target.replaceChildren(E('option', { value: '' }, ['选择 Xbox']), ...selected.map(entry =>
				E('option', { value: entry.ip }, [entry.device ? entry.device.name + ' · ' + entry.ip : entry.ip])));
			target.value = address;
			target.disabled = selected.length === 0;
			mode.disabled = selected.length === 0;
			drawTarget();
		}

		function update(state) {
			const routes = { present: '已发现默认路由', absent: '未发现默认路由', unknown: '暂时无法读取路由' };
			routerStatus.textContent = '路由器 IPv6：' + (routes[state.wan6_state] || routes.unknown);
			ruleStatus.textContent = state.ipv6_dns_active ? 'IPv6 DNS 接管已启用' :
				state.ipv6_block_active ? '公网 IPv6 限制已启用' :
				state.ipv6_dns === '1' && !state.ipv6_block_ip ? '选中 Xbox 并启动服务后，IPv6 DNS 接管生效。' :
				state.ipv6_dns === '1' || state.ipv6_block === '1' ? 'IPv6 设置将在服务启动后生效' : '';
		}

		target.addEventListener('change', function() {
			address = target.value;
			mac.value = '';
			syncTargets();
		});
		mode.addEventListener('change', function() {
			if (!address) syncTargets();
			drawTarget();
		});
		mac.addEventListener('input', drawTarget);
		devices.element.addEventListener('xbox-devices-changed', syncTargets);
		syncTargets();
		update(initial);

		return {
			element: E('div', { class: 'xb-ipv6' }, [
				E('div', { class: 'xb-row' }, [
					E('span', { class: 'xb-row' }, [E('label', { for: mode.id }, ['Xbox IPv6']), help]),
					mode, target, mac
				]),
				routerStatus, targetStatus, ruleStatus
			]),
			control: target.id,
			update: update,
			values: function() {
				return {
					ipv6_dns: mode.value === 'dns' ? '1' : '0',
					ipv6_block: mode.value === 'block' ? '1' : '0',
					ipv6_block_ip: mode.value !== 'system' ? address : '',
					ipv6_block_mac: mode.value !== 'system' ? mac.value.trim().replace(/-/g, ':') : ''
				};
			}
		};
	}
});
