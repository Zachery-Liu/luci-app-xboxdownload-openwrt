'use strict';
'require baseclass';
'require rpc';

const importNodes = rpc.declare({
	object: 'xboxdownload_openwrt', method: 'import_nodes',
	params: ['source', 'channel'], expect: { '': {} }
});
const probe = rpc.declare({
	object: 'xboxdownload_openwrt', method: 'probe',
	params: ['group', 'ip', 'timeout', 'sample', 'family', 'file', 'ping_only'], expect: { '': {} }
});

const sources = {
	akamai: ['Akamai IP (IPv4)', '', 4],
	preferred: ['Akamai 优选 IP (IPv4)', '', 4],
	akamai6: ['Akamai IP (IPv6)', '', 6],
	cn1: ['Xbox 游戏下载 IP (cn1)', 'main', 4],
	cn2: ['Xbox 游戏下载 IP (cn2)', 'legacy', 4],
	app: ['Xbox 应用下载 IP (cn)', 'app', 4],
	ps: ['PlayStation 游戏下载 IP (cn)', 'ps', 4]
};
const targets = {
	main: ['Xbox cn1', 'assets1.xboxlive.cn / Xbox 测试文件', 'Xbox cn1 测试文件'],
	legacy: ['Xbox cn2', 'dlassets.xboxlive.cn / Xbox One 游戏样本', 'Xbox One 游戏样本'],
	global: ['Xbox COM', 'xvcf1.xboxlive.com / Xbox 测试文件', 'Xbox COM 测试文件'],
	app: ['Xbox 应用 / 微软商店', 'Microsoft Store CDN / 在线获取应用样本', '微软商店应用样本'],
	ps: ['PlayStation', 'gst.prod.dl.playstation.net / PS 测试文件', 'PlayStation 测试文件'],
	ns: ['Nintendo Switch', 'ctest-dl-lp1.cdn.nintendo.net / Switch 测试文件', 'Switch 测试文件'],
	ea: ['EA', 'origin-a.akamaihd.net / EA 安装包样本', 'EA 安装包样本']
};
const cn1Files = [
	['default', 'Xbox 测试文件'],
	['halo', '光环无限（Xbox Series）'],
	['forza', '极限竞速：地平线 5（PC）'],
	['gears', '战争机器 5（PC）']
];
const akamaiSources = new Set(['akamai', 'preferred', 'akamai6']);
const regions = [
	['香港', /香港|HK,|Hong Kong/i],
	['台湾', /台湾|台灣|TW,|Taiwan/i],
	['日本', /日本|JP,|Japan/i],
	['韩国', /韩国|韓國|KR,|South Korea/i],
	['新加坡', /新加坡|SG,|Singapore/i]
];
const carriers = {
	电信: /电信|電信|Telecom/i,
	联通: /联通|聯通|Unicom/i,
	移动: /移动|移動|Mobile/i
};
const pageSize = 24;

function button(label, style) {
	return E('button', { class: 'btn' + (style ? ' ' + style : ''), type: 'button' }, [label]);
}

function select(label, options) {
	return E('select', { class: 'cbi-input-select', 'aria-label': label }, options.map(
		([value, name]) => E('option', { value: value }, [name])));
}

function addNode(nodes, ip, location) {
	if (nodes.has(ip)) {
		const node = nodes.get(ip);
		if (location)
			node.location = location;
		return false;
	}
	nodes.set(ip, { ip: ip, location: location, measurements: {} });
	return true;
}

function ipv4(value) {
	const parts = value.split('.');
	return parts.length === 4 && parts.every(part => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function nodeAddress(value) {
	return ipv4(value) || /^[23][0-9a-f]{3}:[0-9a-f:]{2,34}$/i.test(value);
}

function formatResult(result) {
	if (!result) return '待测速';
	if (result.ok && result.exit === 28) return '超时前样本';
	if (result.ok) return '可用';
	if (result.error === 'cdn') return '需要公网 IP';
	if (result.error === 'sample') return result.rtt ? '仅延迟（样本不可用）' : '样本不可用 · Ping 无响应';
	if (result.error) return '测速请求失败';
	if (result.exit === 28) return '超时';
	if (result.exit === 63) return '节点未按限量返回';
	if (result.code && result.code !== '000') return 'HTTP ' + result.code;
	return '连接失败';
}

function speedText(result) {
	return (Number(result.speed) / 1048576).toFixed(2) + ' MiB/s';
}

return baseclass.extend({
	render: function(applyNode, selectedNode) {
		const lists = new Map();
		const source = select('在线 IP 来源', Object.entries(sources).map(([key, data]) => [key, data[0]]));
		source.value = 'cn1';
		const channel = select('导入渠道', [['auto', 'GitHub（失败时用 jsDelivr）'], ['mirror', 'jsDelivr']]);
		const target = select('测速目标', Object.entries(targets).map(([key, data]) => [key, data[0]]));
		target.value = sources[source.value][1];
		const carrier = select('运营商', [['', '全部运营商'], ...Object.keys(carriers).map(name => [name, name])]);
		const region = select('地区', [['', '全部地区'], ...regions.map(([name]) => [name, name]), ['other', '其他地区']]);
		const query = E('input', {
			type: 'search', 'aria-label': '搜索位置或 IP', class: 'cbi-input-text',
			placeholder: '搜索位置或 IP'
		});
		const online = button('重新导入');
		const importState = E('span', { class: 'xb-muted', role: 'status' });
		const selectPage = button('本页全选');
		const selectAll = button('');
		const clear = button('清空勾选');
		const previous = button('上一页');
		const next = button('下一页');
		const counter = E('strong');
		const settingsSummary = E('span', { class: 'xb-muted' });
		const pager = E('span');
		const list = E('div', { class: 'xb-node-list' });
		const manual = E('textarea', {
			'aria-label': '手动添加 IP', class: 'cbi-input-textarea', rows: 2,
			placeholder: '粘贴 IPv4 或 IPv6，用空格、逗号或换行分隔。'
		});
		const add = button('添加 IP');
		const sample = E('code', { style: 'overflow-wrap:anywhere' });
		const file = select('测速文件', cn1Files);
		const fileField = E('label', { class: 'xb-field' }, ['测速文件', file]);
		const fixedFile = E('p', { class: 'xb-muted' }, ['测速文件 ', sample]);
		const timeout = select('单节点超时', [['3', '超时 3 秒'], ['5', '超时 5 秒'], ['10', '超时 10 秒']]);
		const limit = select('下载样本上限', [['auto', ''], ['1', '样本 1 MiB'], ['8', '样本 8 MiB'], ['32', '样本 32 MiB']]);
		const testDefault = button('测默认节点');
		const test = button('开始测速', 'xb-primary');
		const stop = button('停止测速');
		const best = button('', 'xb-primary');
		const fastest = E('div');
		const bestSummary = E('div', { class: 'xb-row xb-between xb-best', hidden: true }, [fastest, best]);
		const progress = E('p', { class: 'xb-progress', role: 'status' });
		let loading = false;
		let testing = false;
		let applying = '';
		let failedApply = null;
		let cancelled = false;
		let page = 0;
		let sort = '';
		let direction = -1;
		let firstVisit = true;

		function current() {
			if (!lists.has(source.value))
				lists.set(source.value, { nodes: new Map(), selected: new Set() });
			return lists.get(source.value);
		}

		function measurementKey() {
			return target.value === 'main' ? 'main:' + file.value : target.value;
		}

		function measurement(row) {
			return row.measurements[measurementKey()];
		}

		function pageRows() {
			const filter = query.value.trim().toLowerCase();
			const isAkamai = akamaiSources.has(source.value);
			const regionName = region.value;
			const carrierPattern = carriers[carrier.value];
			const rows = Array.from(current().nodes.values()).filter(function(row) {
				if (!row.ip) return true;
				if (!(row.ip + ' ' + row.location).toLowerCase().includes(filter)) return false;
				if (!isAkamai) return !carrierPattern || carrierPattern.test(row.location);
				if (!regionName) return true;
				const knownRegion = regions.find(([, pattern]) => pattern.test(row.location));
				return (knownRegion ? knownRegion[0] : 'other') === regionName;
			});
			if (sort) {
				rows.sort(function(a, b) {
					if (sort === 'location')
						return direction * a.location.localeCompare(b.location, 'zh-CN');
					if (sort === 'ip') {
						if (a.ip.includes(':') || b.ip.includes(':'))
							return direction * a.ip.localeCompare(b.ip);
						const number = ip => ip.split('.').reduce((sum, octet) => sum * 256 + Number(octet), 0);
						return direction * (number(a.ip) - number(b.ip));
					}
					const value = row => {
						const result = measurement(row);
						return result && (sort !== 'speed' || result.ok) && result[sort] !== '' &&
							result[sort] != null ? Number(result[sort]) : null;
					};
					const first = value(a);
					const second = value(b);
					if (first == null || second == null)
						return Number(first == null) - Number(second == null) ||
							Number(!measurement(a)) - Number(!measurement(b));
					return direction * (first - second);
				});
			} else {
				rows.sort((a, b) => Number(!!b.manual && !b.online) - Number(!!a.manual && !a.online));
			}
			const pages = Math.max(1, Math.ceil(rows.length / pageSize));
			page = Math.min(page, pages - 1);
			return { rows: rows.slice(page * pageSize, (page + 1) * pageSize), matches: rows, pages: pages };
		}

		function updateApplyButton(control, ip, saved, label, busy) {
			const isSaved = !!ip && ip === saved.ip;
			const failed = failedApply && failedApply.group === target.value && failedApply.ip === ip;
			const text = applying && applying === ip ? '应用中…' :
				isSaved ? saved.running ? '已应用' : '已保存' :
				failed ? '应用失败 · 重试' : label;
			control.textContent = text;
			control.disabled = busy || !ip || isSaved;
			control.title = isSaved && !saved.running ? '服务启动后生效' :
				text === '应用' ? '应用到 ' + targets[target.value][0] : text;
			control.setAttribute('aria-label', text === '应用' ? control.title : text);
		}

		function refreshControls(rows, matchCount) {
			const busy = testing || applying || loading;
			source.disabled = busy;
			channel.disabled = busy;
			carrier.hidden = akamaiSources.has(source.value);
			region.hidden = !carrier.hidden;
			target.disabled = busy || !!sources[source.value][1];
			online.disabled = busy;
			add.disabled = busy;
			timeout.disabled = busy;
			limit.disabled = busy;
			file.disabled = busy;
			test.disabled = busy || current().selected.size === 0;
			test.hidden = testing;
			testDefault.disabled = busy;
			const fastestResult = bestResult();
			bestSummary.hidden = !fastestResult || testing;
			if (fastestResult && !testing) {
				const node = current().nodes.get(fastestResult.ip);
				fastest.replaceChildren(
					E('strong', {}, [formatResult(fastestResult) === '超时前样本' ? '最快（超时前样本）' : '最快']),
					E('span', { class: 'xb-best-node' }, [fastestResult.ip]),
					node && node.location ? E('span', { class: 'xb-muted' }, [node.location]) : '',
					E('strong', { class: 'xb-rate' }, [speedText(fastestResult)])
				);
				updateApplyButton(best, fastestResult.ip, selectedNode(target.value),
					'应用到 ' + targets[target.value][0], busy);
			}
			stop.disabled = !testing || cancelled;
			stop.hidden = !testing;
			selectPage.disabled = busy || !rows.some(row => row.ip);
			selectAll.disabled = busy || matchCount === 0;
			const filtered = query.value.trim() || (region.hidden ? carrier.value : region.value);
			selectAll.textContent = (filtered ? '全选筛选结果' : '全选结果') + '（' + matchCount + '）';
			clear.disabled = busy || current().selected.size === 0;
			counter.textContent = '已选 ' + current().selected.size + ' 个节点';
			const sampleName = target.value === 'main' && file.value !== 'default' ?
				file.selectedOptions[0].textContent : targets[target.value][2];
			settingsSummary.textContent = '测试样本：' + sampleName + ' · 样本大小 ' +
				(limit.value === 'auto' ? defaultLimit() : limit.value) + ' MiB · 超时 ' + timeout.value + ' 秒';
		}

		function bestResult() {
			let bestNode = null;
			current().nodes.forEach(function(row) {
				const result = measurement(row);
				if (result && result.ok && result.ip && (!bestNode || Number(result.speed) > Number(bestNode.speed)))
					bestNode = result;
			});
			return bestNode;
		}

		async function useNode(result) {
			if (!result || !result.ip || applying || testing || loading)
				return;
			const group = target.value;
			const ip = result.ip;
			const name = targets[group][0];
			applying = ip;
			failedApply = null;
			progress.textContent = '正在应用 ' + ip + ' 到 ' + name + '…';
			renderTable();
			try {
				if (await applyNode(group, ip)) {
					progress.textContent = selectedNode(group).running ? '已应用 ' + ip + ' 到 ' + name :
						'已保存 ' + ip + ' 到 ' + name + '，服务启动后生效。';
				} else {
					failedApply = { group, ip };
					progress.textContent = '未能确认 ' + ip + ' 已应用，请重试。';
				}
			} finally {
				applying = '';
				renderTable();
			}
		}

		function renderTable() {
			const { rows, matches, pages } = pageRows();
			const matchCount = matches.length - Number(current().nodes.has(''));
			const saved = selectedNode(target.value);
			const busy = testing || applying || loading;
			const headings = [
				['选择'], ['节点', 'ip', 'location'], ['下载速度', 'speed'], ['TTL', 'ttl'], ['延迟', 'delay'], ['结果'], ['操作']
			];
			const header = headings.map(function([label, key, secondary]) {
				const attributes = { class: 'th', scope: 'col' };
				if (!key)
					return E('th', attributes, [label]);
				if (sort === key || sort === secondary)
					attributes['aria-sort'] = direction > 0 ? 'ascending' : 'descending';
				function sortButton(text, column) {
					const link = button(text + (sort === column ? direction > 0 ? ' ↑' : ' ↓' : ''), 'xb-sort');
					link.addEventListener('click', function() {
						direction = sort === column ? -direction : column === 'speed' ? -1 : 1;
						sort = column;
						page = 0;
						renderTable();
					});
					return link;
				}
				return E('th', attributes, [sortButton(label, key), secondary ? sortButton('地区', secondary) : '']);
			});
			const body = rows.map(function(row) {
				const result = measurement(row);
				const checkbox = E('input', { type: 'checkbox', 'aria-label': '选择 ' + row.ip });
				checkbox.checked = current().selected.has(row.ip);
				checkbox.disabled = testing || applying || loading;
				checkbox.addEventListener('change', function() {
					if (checkbox.checked) current().selected.add(row.ip);
					else current().selected.delete(row.ip);
					refreshControls(rows, matchCount);
				});
				const label = E('strong', { class: 'xb-ip', title: row.ip ? '双击测速' : '' }, [row.ip || (result && result.ip) || '默认节点']);
				label.addEventListener('dblclick', function() { run([row.ip]); });
				const actionIp = result && result.ok && result.ip || (row.ip === saved.ip ? row.ip : '');
				const use = button('');
				updateApplyButton(use, actionIp, saved, '应用', busy);
				use.addEventListener('click', function() { useNode(result); });
				const delay = result && result.delay != null ? result.delay + ' ms' : '';
				const received = result && result.ok && result.exit === 28 ?
					E('small', { class: 'xb-result-bytes xb-muted' }, ['实收 ' + (Number(result.bytes) / 1048576).toFixed(2) + ' MiB']) : '';
				const values = [
					row.ip ? checkbox : '—',
					E('div', { class: 'xb-node' }, [label, row.location ? E('small', { class: 'xb-muted' }, [row.location]) : '']),
					E('div', {}, [
						E('strong', { class: 'xb-rate' }, [result && result.ok ? speedText(result) : '—']),
						delay ? E('small', { class: 'xb-mobile-delay xb-muted' }, [delay]) : ''
					]),
					result && result.ttl ? result.ttl : '—', delay || '—',
					E('div', { class: result ? '' : 'xb-muted' }, [formatResult(result), received]),
					actionIp ? use : '—'
				];
				return E('tr', { class: 'tr' }, values.map(value => E('td', { class: 'td' }, [value])));
			});
			const empty = current().nodes.size ? '当前筛选没有匹配的节点。' : '在线导入列表，或手动添加候选 IP。';
			const scroll = list.scrollTop;
			list.replaceChildren(E('table', { class: 'table xb-node-table' }, [
				E('thead', {},
					[E('tr', { class: 'tr table-titles' }, header)]),
				E('tbody', {}, body.length ? body : [E('tr', { class: 'tr' }, [
					E('td', { class: 'td', colspan: headings.length }, [empty])
				])])
			]));
			list.scrollTop = scroll;
			pager.textContent = matches.length + ' 个节点 · ' + (page + 1) + ' / ' + pages + ' 页';
			previous.disabled = page === 0;
			next.disabled = page + 1 >= pages;
			refreshControls(rows, matchCount);
		}

		async function loadList() {
			if (loading || testing || applying)
				return;
			const entry = current();
			loading = true;
			importState.textContent = '正在导入 IP…';
			renderTable();
			try {
				const response = await importNodes(source.value, channel.value);
				if (response.error || !response.nodes)
					throw new Error('IP import failed');
				const origins = { github: 'GitHub', mirror: 'jsDelivr', stale: '旧缓存，在线刷新失败' };
				const imported = new Set();
				response.nodes.split('\n').forEach(function(line) {
					const [ip, location] = line.split('\t');
					if (nodeAddress(ip)) {
						addNode(entry.nodes, ip, location || '');
						imported.add(ip);
					}
				});
				entry.nodes.forEach(function(row, ip) {
					if (row.online && !row.manual && !imported.has(ip)) {
						entry.nodes.delete(ip);
						entry.selected.delete(ip);
					}
				});
				imported.forEach(ip => { entry.nodes.get(ip).online = true; });
				importState.textContent = '已导入 ' + imported.size + ' 个 IPv' + sources[source.value][2] +
					' 节点（' + (origins[response.origin] || '在线') + '）';
			} catch (error) {
				importState.textContent = '在线列表暂时不可用，可重试或手动添加。';
			} finally {
				loading = false;
				renderTable();
			}
		}

		async function run(ips) {
			if (testing || applying || loading || !ips.length)
				return;
			const entry = current();
			const group = target.value;
			const testFile = group === 'main' ? file.value : '';
			const key = measurementKey();
			const seconds = Number(timeout.value);
			const megabytes = limit.value === 'auto' ? defaultLimit() : Number(limit.value);
			testing = true;
			cancelled = false;
			renderTable();
			let done = 0;
			let serverBusy = false;
			let pingOnly = false;
			try {
				const batches = Math.ceil(ips.length / pageSize);
				for (let start = 0; start < ips.length && !cancelled && !serverBusy; start += pageSize) {
					const batch = batches > 1 ? ' · 第 ' + (start / pageSize + 1) + '/' + batches + ' 批' : '';
					for (const ip of ips.slice(start, start + pageSize)) {
						if (cancelled)
							break;
						const activity = pingOnly ? '微软商店样本暂不可用，本批仅测延迟 · ' : '';
						progress.textContent = activity + '正在测 ' + (ip || '默认节点') +
							'（' + (done + 1) + '/' + ips.length + '）' + batch;
						let result;
						try {
							result = await probe(group, ip, seconds, megabytes, sources[source.value][2], testFile, Number(pingOnly));
						} catch (error) {
							result = { error: 'request' };
						}
						if (result.error === 'probe_busy') {
							serverBusy = true;
							break;
						}
						pingOnly = pingOnly || (group === 'app' && result.error === 'sample');
						const bytes = Number(result.bytes);
						const validResponse = result.code === '200' || result.code === '206';
						result.ok = validResponse && bytes > 0 && (result.exit === 0 || result.exit === 28);
						result.delay = result.rtt ? Number(result.rtt) : Number(result.connect) > 0 ?
							Math.round(Number(result.connect) * 1000) : null;
						addNode(entry.nodes, ip, ip ? '' : '默认解析');
						entry.nodes.get(ip).measurements[key] = result;
						done++;
						renderTable();
					}
				}
				progress.textContent = serverBusy ? '路由器正在执行另一项测速，请稍后重试。' :
					(cancelled ? '已停止' : '测速完成') + ' · ' + done + '/' + ips.length +
					(pingOnly ? ' · 微软商店样本暂不可用，本批仅测延迟。再次开始将重新取样。' : '');
				if (!sort) {
					sort = 'speed';
					direction = -1;
					page = 0;
				}
			} finally {
				testing = false;
				renderTable();
			}
		}

		function defaultLimit() {
			return sources[source.value][1] ? 50 : 30;
		}

		function setTarget() {
			target.closest('.xb-field').hidden = !!sources[source.value][1];
			fileField.hidden = target.value !== 'main';
			fixedFile.hidden = target.value === 'main';
			limit.options[0].textContent = '原版样本 ' + defaultLimit() + ' MiB';
			sample.textContent = targets[target.value][1];
		}

		function resetPage() { page = 0; list.scrollTop = 0; renderTable(); }
		online.addEventListener('click', loadList);
		channel.addEventListener('change', loadList);
		source.addEventListener('change', function() {
			query.value = '';
			carrier.value = '';
			region.value = '';
			sort = '';
			progress.textContent = '';
			target.value = sources[source.value][1] || 'global';
			setTarget();
			resetPage();
			loadList();
		});
		target.addEventListener('change', function() { progress.textContent = ''; setTarget(); resetPage(); });
		file.addEventListener('change', function() { progress.textContent = ''; resetPage(); });
		timeout.addEventListener('change', renderTable);
		limit.addEventListener('change', renderTable);
		carrier.addEventListener('change', resetPage);
		region.addEventListener('change', resetPage);
		query.addEventListener('input', resetPage);
		previous.addEventListener('click', function() { page--; list.scrollTop = 0; renderTable(); });
		next.addEventListener('click', function() { page++; list.scrollTop = 0; renderTable(); });
		selectPage.addEventListener('click', function() {
			pageRows().rows.forEach(row => { if (row.ip) current().selected.add(row.ip); });
			renderTable();
		});
		selectAll.addEventListener('click', function() {
			const { selected } = current();
			selected.clear();
			pageRows().matches.forEach(row => { if (row.ip) selected.add(row.ip); });
			renderTable();
		});
		clear.addEventListener('click', function() { current().selected.clear(); renderTable(); });
		add.addEventListener('click', function() {
			const ips = Array.from(new Set(manual.value.trim().split(/[\s,，]+/).filter(Boolean)));
			if (!ips.length || ips.length > pageSize || !ips.every(nodeAddress)) {
				progress.textContent = '请粘贴 1–' + pageSize + ' 个有效的 IPv4 或 IPv6 地址。';
				return;
			}
			const entry = current();
			ips.forEach(function(ip) {
				addNode(entry.nodes, ip, '');
				entry.nodes.get(ip).manual = true;
				entry.selected.add(ip);
			});
			progress.textContent = '已勾选手动添加的 ' + ips.length + ' 个节点。';
			manual.value = '';
			resetPage();
		});
		test.addEventListener('click', function() { run(Array.from(current().selected)); });
		testDefault.addEventListener('click', function() { run(['']); });
		best.addEventListener('click', function() { useNode(bestResult()); });
		stop.addEventListener('click', function() {
			cancelled = true;
			stop.disabled = true;
			progress.textContent = '当前节点结束后停止。';
		});

		const panel = E('div', { 'data-tab': 'speed', 'data-tab-title': '测速' }, [
			E('section', { class: 'xb-section xb-speed-controls' }, [
				E('div', { class: 'xb-row' }, [source, channel, online, importState]),
				E('div', { class: 'xb-row' }, [query, carrier, region, selectPage, selectAll, clear]),
				E('div', { class: 'xb-row xb-between xb-test-bar' }, [
					E('div', { class: 'xb-row' }, [counter, settingsSummary]),
					E('div', { class: 'xb-row' }, [test, stop, testDefault])
				]),
				E('div', { class: 'xb-row xb-speed-options' }, [
					E('details', { class: 'xb-details' }, [E('summary', {}, ['测速设置']),
						E('div', { class: 'xb-fields' }, [
							E('label', { class: 'xb-field' }, ['测速目标', target]),
							fileField,
							E('label', { class: 'xb-field' }, ['样本大小', limit]),
							E('label', { class: 'xb-field' }, ['单节点超时', timeout])
						]),
						fixedFile
					]),
					E('details', { class: 'xb-details' }, [E('summary', {}, ['手动添加 IP']), E('div', { class: 'xb-row' }, [manual, add])])
				]),
				progress
			]),
			bestSummary,
			E('section', { class: 'xb-section xb-results' }, [
				list, E('div', { class: 'xb-row xb-paging' }, [previous, next, pager])
			])
		]);
		panel.addEventListener('cbi-tab-active', function() {
			if (firstVisit) {
				firstVisit = false;
				loadList();
			} else {
				renderTable();
			}
		});
		setTarget();
		renderTable();
		return panel;
	}
});
