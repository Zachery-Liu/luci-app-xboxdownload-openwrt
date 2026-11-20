'use strict';
'require baseclass';
'require rpc';

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
	const subnets = interfaces.map(item => ({ base: ipNumber(item.address), bits: Number(item.mask) }))
		.filter(item => item.base != null && Number.isInteger(item.bits) && item.bits > 0 && item.bits <= 32)
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
			if (number == null || routerIPs.has(ip) || devices.has(ip) ||
			    !subnets.some(net => number >= net.first && number < net.first + net.size))
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

return baseclass.extend({
	render: function(input) {
		const picker = E('select', {
			id: 'xbox-device-picker', class: 'cbi-input-select xb-device-picker'
		});
		const refresh = E('button', { type: 'button', class: 'btn' }, ['刷新设备']);
		const selected = E('ul', { class: 'xb-devices' });
		const status = E('span', { class: 'xb-muted', role: 'status' });
		const hitHint = E('p', { class: 'xb-muted', hidden: true }, ['开启 HTTP 302 日志后可查看下载命中。']);
		const element = E('div', {}, [
			selected, hitHint,
			E('div', { class: 'xb-row' }, [picker, refresh, status]),
			E('details', { class: 'xb-details' }, [E('summary', {}, ['手动输入 IPv4']), input])
		]);
		let devices = new Map();
		let hits = new Map();
		let tracked = new Set();
		const hitLabels = new Map();
		let started = false;
		let loading = false;

		function addresses() {
			return Array.from(new Set(input.value.split(/[\s,，]+/).filter(Boolean)));
		}

		function drawHit(ip, label) {
			label.hidden = !tracked.has(ip);
			const hit = hits.get(ip);
			label.textContent = hit ? '最近 302 ' + hit : '最近日志暂无 302 命中';
		}

		function updateHits(state) {
			const redirecting = state.running && state.http_running;
			const logging = state.log_mode !== 'off';
			hitHint.hidden = !redirecting || logging;
			tracked = redirecting && logging ? new Set((state.client || '').split(',')) : new Set();
			hits = tracked.size ? latestRedirects(state.log) : new Map();
			hitLabels.forEach((label, ip) => drawHit(ip, label));
		}

		function draw() {
			const current = addresses();
			const choices = Array.from(devices, ([ip, device]) => ({ ip, ...device }))
				.filter(device => !current.includes(device.ip))
				.sort((a, b) => a.number - b.number);
			picker.replaceChildren(E('option', { value: '' }, [
				loading ? '正在读取设备…' : choices.length ? '选择局域网设备' : '暂无可选设备'
			]), ...choices.map(device => E('option', { value: device.ip }, [
				device.name + ' · ' + device.ip + ' · ' + device.mac
			])));
			picker.disabled = loading || choices.length === 0;
			refresh.disabled = loading;
			hitLabels.clear();
			selected.replaceChildren(...current.map(function(ip) {
				const device = devices.get(ip);
				const hit = E('small', { class: 'xb-muted xb-device-hit' });
				hitLabels.set(ip, hit);
				drawHit(ip, hit);
				const remove = E('button', {
					type: 'button', class: 'btn cbi-button-remove', 'aria-label': '移除设备 ' + ip
				}, ['移除']);
				remove.addEventListener('click', function() {
					input.value = addresses().filter(value => value !== ip).join(',');
					status.textContent = '';
					draw();
				});
				return E('li', { class: 'xb-row xb-between' }, [
					E('div', {}, [
						E('strong', {}, [device ? device.name + ' · ' + ip : ip]),
						device ? E('small', { class: 'xb-muted' }, [device.mac]) : '',
						hit
					]),
					remove
				]);
			}));
			element.dispatchEvent(new CustomEvent('xbox-devices-changed'));
		}

		async function load() {
			if (loading) return;
			started = true;
			loading = true;
			status.textContent = '';
			draw();
			try {
				const [hints, lan] = await Promise.all([getHints(), getLan()]);
				devices = lanDevices(hints, lan);
				if (!devices.size)
					status.textContent = '路由器尚无可用的 LAN 设备记录。';
			} catch (error) {
				status.textContent = '读取设备失败，可刷新重试或手动输入。';
			} finally {
				loading = false;
				draw();
			}
		}

		picker.addEventListener('change', function() {
			const ip = picker.value;
			const current = addresses();
			if (!devices.has(ip) || current.includes(ip))
				return;
			if (current.length >= 8) {
				status.textContent = '最多选择 8 台设备。';
			} else {
				input.value = current.concat(ip).join(',');
				status.textContent = '';
			}
			draw();
		});
		input.addEventListener('input', function() { status.textContent = ''; draw(); });
		refresh.addEventListener('click', load);
		draw();
		return {
			element: element,
			control: picker.id,
			updateHits: updateHits,
			selected: function() {
				return addresses().filter(ip => ipNumber(ip) != null).map(ip => ({ ip, device: devices.get(ip) }));
			},
			loadOnce: function() { if (!started) load(); }
		};
	}
});
