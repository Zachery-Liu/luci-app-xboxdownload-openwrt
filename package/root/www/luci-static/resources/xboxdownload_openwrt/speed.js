'use strict';
'require baseclass';
'require form';
'require rpc';
'require ui';

const importNodes = rpc.declare({
	object: 'xboxdownload_openwrt', method: 'import_nodes',
	params: ['source', 'channel'], expect: { '': {} }
});
const probe = rpc.declare({
	object: 'xboxdownload_openwrt', method: 'probe',
	params: ['group', 'ip', 'timeout', 'sample', 'family', 'file', 'ping_only', 'max_bytes'], expect: { '': {} }
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
	global: ['Xbox com', 'xvcf1.xboxlive.com / Xbox 测试文件', 'Xbox com 测试文件'],
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
const settingsKey = 'xboxdownload-openwrt.speed-settings';
const bytesPerGB = 1000000000;
const bytesPerMiB = 1048576;

function batchBudgetBytes(value) {
	const match = typeof value === 'string' && /^(\d*)(?:\.(\d{1,9}))?$/.exec(value);
	if (!match || (!match[1] && !match[2]))
		return null;
	const bytes = Number(match[1]) * bytesPerGB + Number((match[2] || '').padEnd(9, '0'));
	return Number.isSafeInteger(bytes) ? bytes : null;
}

function trafficText(bytes) {
	return (bytes / bytesPerGB).toFixed(9).replace(/\.?0+$/, '') + ' GB';
}

function button(label, style) {
	return E('button', { class: 'cbi-button' + (style ? ' ' + style : ''), type: 'button' }, [label]);
}

function select(label, options) {
	const widget = new ui.Select(options[0][0], Object.fromEntries(options), { sort: options.map(([key]) => key) });
	const node = widget.render();
	const input = node.querySelector('select');
	input.setAttribute('aria-label', label);
	return { node, input };
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

function formatResult(result) {
	if (!result) return '待测速';
	if (result.ok && result.capped) return '预算限量样本';
	if (result.ok && result.shortSample) return '样本不足';
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
	return (Number(result.speed) / bytesPerMiB).toFixed(2) + ' MiB/s';
}

return baseclass.extend({
render: async function(validateAddresses, selectNode, selectedNode, configurationBusy) {
		const lists = new Map();
		const { node: sourceField, input: source } = select('在线 IP 来源', Object.entries(sources).map(([key, data]) => [key, data[0]]));
		source.value = 'cn1';
		const { node: channelField, input: channel } = select('导入渠道', [['auto', 'GitHub（失败时用 jsDelivr）'], ['mirror', 'jsDelivr']]);
		const { node: carrierField, input: carrier } = select('运营商', [['', '全部运营商'], ...Object.keys(carriers).map(name => [name, name])]);
		const { node: regionField, input: region } = select('地区', [['', '全部地区'], ...regions.map(([name]) => [name, name]), ['other', '其他地区']]);
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
		const sample = E('span', { class: 'xb-sample' });
		const testDefault = button('测默认节点');
		const test = button('开始测速', 'cbi-button-action');
		const stop = button('停止测速');
		const best = button('', 'cbi-button-apply');
		const fastest = E('div');
		const bestSummary = E('div', { class: 'xb-row xb-between xb-best', hidden: true }, [fastest, best]);
		const progress = E('p', { class: 'xb-progress', role: 'status' });
		let loading = false;
		let testing = false;
		let cancelled = false;
		let page = 0;
		let sort = '';
		let direction = -1;
		let firstVisit = true;

		function draftSettings() {
			return {
				...Object.fromEntries(Object.entries(settingsControls).map(([key, control]) => [key, control.value])),
				batchLimit: batchLimit.value.trim()
			};
		}

		function setDraftControls(settings) {
			for (const [name, control] of Object.entries(settingsControls)) {
				if (Array.from(control.options).some(option => option.value === settings?.[name]))
					control.value = settings[name];
			}
			if (batchBudgetBytes(settings?.batchLimit) !== null)
				batchLimit.value = settings.batchLimit;
		}

		function restoreDraft(settings = activeSettings) {
			batchLimit.value = activeSettings.batchLimit;
			setDraftControls(settings);
			setTarget();
			renderTable();
		}

		function settingsChanged(draft = draftSettings()) {
			return Object.keys(activeSettings).some(key => draft[key] !== activeSettings[key]);
		}

		function applySettings(draft) {
			if (!settingsChanged(draft)) {
				renderTable();
				return true;
			}
			activeSettings = draft;
			progress.textContent = '';
			resetPage();
			try {
				localStorage.setItem(settingsKey, JSON.stringify(draft));
				return true;
			} catch (error) {
				return false;
			}
		}

		function activeTarget() {
			return sources[source.value][1] || activeSettings.target;
		}

		function current() {
			if (!lists.has(source.value))
				lists.set(source.value, { nodes: new Map(), selected: new Set(), appSample: '' });
			return lists.get(source.value);
		}

		function sampleMiB() {
			return activeSettings.limit === 'auto' ? defaultLimit() : Number(activeSettings.limit);
		}

		function measurementKey(group) {
			const file = group === 'main' ? activeSettings.file : '';
			return [group, file, activeSettings.timeout, sampleMiB()].join(':');
		}

		function measurement(row) {
			const group = activeTarget();
			const result = row.measurements[measurementKey(group)];
			if (group === 'app' && result?.sample_id && result.sample_id !== current().appSample)
				return null;
			return result;
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
						return result && (sort !== 'speed' || result.rankable) && result[sort] !== '' &&
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

		function updateNodeButton(control, ip, selection, label, busy) {
			const picked = !!ip && ip === selection.draft;
			const text = picked ? ip !== selection.saved ? '待应用' : selection.running ? '已应用' : '已保存' : label;
			control.textContent = text;
			control.disabled = busy || !ip || picked;
			control.title = text === '已保存' ? '服务启动后生效' : text === '待应用' ? '保存并应用后生效' : text;
			control.setAttribute('aria-label', text === '选用' ? '选用节点 ' + ip : text);
		}

		function refreshControls(rows, matchCount) {
			const busy = testing || loading;
			const group = activeTarget();
			source.disabled = busy;
			channel.disabled = busy;
			carrierField.hidden = akamaiSources.has(source.value);
			regionField.hidden = !carrierField.hidden;
			target.disabled = busy || !!sources[source.value][1];
			online.disabled = busy;
			add.disabled = busy;
			timeout.disabled = busy;
			limit.disabled = busy;
			batchLimit.disabled = busy;
			file.disabled = busy;
			test.disabled = busy || configurationBusy() || current().selected.size === 0;
			test.hidden = testing;
			testDefault.disabled = busy || configurationBusy();
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
				updateNodeButton(best, fastestResult.ip, selectedNode(group), '选用到 ' + targets[group][0], busy);
			}
			stop.disabled = !testing || cancelled;
			stop.hidden = !testing;
			selectPage.disabled = busy || !rows.some(row => row.ip);
			selectAll.disabled = busy || matchCount === 0;
			const filtered = query.value.trim() || (regionField.hidden ? carrier.value : region.value);
			selectAll.textContent = (filtered ? '全选筛选结果' : '全选结果') + '（' + matchCount + '）';
			clear.disabled = busy || current().selected.size === 0;
			counter.textContent = '已选 ' + current().selected.size + ' 个节点';
			const sampleName = group === 'main' && activeSettings.file !== 'default' ?
				cn1Files.find(([id]) => id === activeSettings.file)[1] : targets[group][2];
			settingsSummary.textContent = '测试样本：' + sampleName + ' · 样本大小 ' +
				sampleMiB() + ' MiB · 超时 ' + activeSettings.timeout + ' 秒';
			const budget = batchBudgetBytes(activeSettings.batchLimit);
			if (budget)
				settingsSummary.textContent += ' · 整批上限 ' + trafficText(budget);
		}

		function bestResult() {
			let bestNode = null;
			current().nodes.forEach(function(row) {
				const result = measurement(row);
				if (result?.rankable && (!bestNode || Number(result.speed) > Number(bestNode.speed)))
					bestNode = result;
			});
			return bestNode;
		}

		function useNode(ip) {
			if (!ip || testing || loading)
				return;
			selectNode(activeTarget(), ip);
			renderTable();
		}

		function renderTable() {
			const { rows, matches, pages } = pageRows();
			const matchCount = matches.length - Number(current().nodes.has(''));
			const selection = selectedNode(activeTarget());
			const busy = testing || loading;
			const headings = [
				['选择'], ['节点', 'ip', 'location'], ['下载速度', 'speed'], ['TTL', 'ttl'],
				['ICMP 延迟', 'icmpMs'], ['TCP 建连', 'tcpMs'], ['结果'], ['操作']
			];
			const header = headings.map(function([label, key, secondary]) {
				if (!key)
					return label;
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
				return E('span', {}, [sortButton(label, key), secondary ? sortButton('地区', secondary) : '']);
			});
			const body = rows.map(function(row) {
				const result = measurement(row);
				const checkbox = E('input', { type: 'checkbox', 'aria-label': '选择 ' + row.ip });
				checkbox.checked = current().selected.has(row.ip);
				checkbox.disabled = busy;
				checkbox.addEventListener('change', function() {
					if (checkbox.checked) current().selected.add(row.ip);
					else current().selected.delete(row.ip);
					refreshControls(rows, matchCount);
				});
				const label = E('strong', { class: 'xb-ip', title: row.ip ? '双击测速' : '' }, [row.ip || (result && result.ip) || '默认节点']);
				label.addEventListener('dblclick', function() { run([row.ip]); });
				const actionIp = result && result.ok && result.ip ||
					(row.ip === selection.saved || row.ip === selection.draft ? row.ip : '');
				const use = button('');
				updateNodeButton(use, actionIp, selection, '选用', busy);
				use.addEventListener('click', function() { useNode(actionIp); });
				const icmpDelay = result?.icmpMs == null ? '' : result.icmpMs + ' ms';
				const tcpDelay = result?.tcpMs == null ? '' : result.tcpMs + ' ms';
				const received = result?.ok && (result.exit === 28 || result.capped || result.shortSample) ?
					E('small', { class: 'xb-result-bytes xb-muted' }, ['实收 ' + (Number(result.bytes) / bytesPerMiB).toFixed(2) + ' MiB']) : '';
				return [
					row.ip ? checkbox : '—',
					E('div', { class: 'xb-node' }, [label, row.location ? E('small', { class: 'xb-muted' }, [row.location]) : '']),
					E('div', {}, [
						E('strong', { class: 'xb-rate' }, [result && result.ok ? speedText(result) : '—']),
						icmpDelay ? E('small', { class: 'xb-mobile-delay xb-muted' }, ['ICMP ' + icmpDelay]) : '',
						tcpDelay ? E('small', { class: 'xb-mobile-delay xb-muted' }, ['TCP ' + tcpDelay]) : ''
					]),
					result && result.ttl ? result.ttl : '—', icmpDelay || '—', tcpDelay || '—',
					E('div', { class: result ? '' : 'xb-muted' }, [formatResult(result), received]),
					actionIp ? use : '—'
				];
			});
			const empty = current().nodes.size ? '当前筛选没有匹配的节点。' : '在线导入列表，或手动添加候选 IP。';
			const scroll = list.scrollTop;
			const table = new ui.Table(header, { classes: ['xb-node-table'], sortable: false });
			const tableNode = table.update(body, empty);
			// Sort the complete filtered list before drawing the current page.
			tableNode.querySelectorAll('th').forEach((th, index) => {
				th.removeAttribute('data-sortable-row');
				th.setAttribute('scope', 'col');
				if (sort && headings[index].slice(1).includes(sort))
					th.setAttribute('aria-sort', direction > 0 ? 'ascending' : 'descending');
			});
			list.replaceChildren(tableNode);
			list.scrollTop = scroll;
			pager.textContent = matches.length + ' 个节点 · ' + (page + 1) + ' / ' + pages + ' 页';
			previous.disabled = page === 0;
			next.disabled = page + 1 >= pages;
			refreshControls(rows, matchCount);
		}

		async function loadList() {
			if (loading || testing)
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
					if (ip) {
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
			if (testing || loading || configurationBusy() || !ips.length)
				return;
			const entry = current();
			const group = activeTarget();
			const testFile = group === 'main' ? activeSettings.file : '';
			const key = measurementKey(group);
			const seconds = Number(activeSettings.timeout);
			const megabytes = sampleMiB();
			const sampleBytes = megabytes * bytesPerMiB;
			const minimumBytes = Math.min(sampleBytes / 4, bytesPerMiB);
			const budget = batchBudgetBytes(activeSettings.batchLimit);
			testing = true;
			cancelled = false;
			renderTable();
			let done = 0;
			let serverBusy = false;
			let pingOnly = false;
			let downloaded = 0;
			let budgetStop = '';
			try {
				const batches = Math.ceil(ips.length / pageSize);
				for (let start = 0; start < ips.length && !cancelled && !serverBusy && !budgetStop; start += pageSize) {
					const batch = batches > 1 ? ' · 第 ' + (start / pageSize + 1) + '/' + batches + ' 批' : '';
					for (const ip of ips.slice(start, start + pageSize)) {
						if (cancelled || budgetStop)
							break;
						const activity = pingOnly ? '微软商店样本暂不可用，本批仅测延迟 · ' : '';
						progress.textContent = activity + '正在测 ' + (ip || '默认节点') +
							'（' + (done + 1) + '/' + ips.length + '）' + batch;
						let result;
						const maxBytes = budget ? Math.min(sampleBytes, budget - downloaded) : undefined;
						try {
							result = await probe(group, ip, seconds, megabytes, sources[source.value][2], testFile, Number(pingOnly), maxBytes);
						} catch (error) {
							result = { error: 'request' };
						}
						if (result.error === 'probe_busy') {
							serverBusy = true;
							break;
						}
						pingOnly = pingOnly || (group === 'app' && result.error === 'sample');
						const bytes = result.bytes == null || result.bytes === '' ? NaN : Number(result.bytes);
						if (budget) {
							if (!Number.isSafeInteger(bytes) || bytes < 0) {
								budgetStop = '无法确认本轮流量，已停止测速';
							} else {
								downloaded += bytes;
								if (downloaded >= budget && done + 1 < ips.length)
									budgetStop = '已达到整批流量上限';
							}
						}
						const validResponse = result.code === '200' || result.code === '206';
						const rate = Number(result.speed);
						result.ok = !result.error && validResponse && bytes > 0 && Number.isFinite(rate) &&
							(result.exit === 0 || result.exit === 28);
						result.capped = maxBytes != null && maxBytes < sampleBytes;
						result.shortSample = bytes < minimumBytes;
						result.rankable = result.ok && !!result.ip && rate > 0 && !result.shortSample && !result.capped &&
							(group !== 'app' || !!result.sample_id);
						const rtt = result.rtt ? Number(result.rtt) : NaN;
						result.icmpMs = Number.isFinite(rtt) && rtt >= 0 ? rtt : null;
						const connect = Number(result.connect);
						const lookup = Number(result.namelookup);
						result.tcpMs = Number.isFinite(connect) && connect > 0 && lookup >= 0 && connect >= lookup ?
							Math.round((connect - lookup) * 1000000) / 1000 : null;
						if (group === 'app' && result.sample_id)
							entry.appSample = result.sample_id;
						addNode(entry.nodes, ip, ip ? '' : '默认解析');
						entry.nodes.get(ip).measurements[key] = result;
						done++;
						renderTable();
					}
				}
				progress.textContent = serverBusy ? '路由器正在执行另一项测速，请稍后重试。' :
					(cancelled ? '已停止' : budgetStop || '测速完成') + ' · ' + done + '/' + ips.length +
					(budget ? ' · 已确认下载 ' + trafficText(downloaded) + ' / ' + trafficText(budget) : '') +
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
			const group = sources[source.value][1] || target.value;
			targetField.hidden = !!sources[source.value][1];
			fileField.hidden = group !== 'main';
			fixedFile.hidden = group === 'main';
			limit.options[0].textContent = '原版样本 ' + defaultLimit() + ' MiB';
			sample.textContent = targets[group][1];
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
			setTarget();
			resetPage();
			loadList();
		});
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
		add.addEventListener('click', async function() {
			if (loading || testing)
				return;
			const input = manual.value;
			const ips = Array.from(new Set(input.trim().toLowerCase().split(/[\s,，]+/).filter(Boolean)));
			if (!ips.length || ips.length > pageSize || ips.some(ip => ip.length > 39)) {
				progress.textContent = '请粘贴 1–' + pageSize + ' 个有效的 IPv4 或 IPv6 地址。';
				return;
			}
			if (['main', 'legacy'].includes(activeTarget()) && ips.some(ip => ip.includes(':'))) {
				progress.textContent = 'Xbox cn1、cn2 测速仅使用公网 IPv4 节点。';
				return;
			}
			const entry = current();
			loading = true;
			renderTable();
			try {
				const response = await validateAddresses('nodes', ips.join('\n'));
				if (response?.error === 'cdn') {
					progress.textContent = '请检查列表，所有节点都必须是有效的公网 CDN IP。';
					return;
				}
				if (response?.error !== '')
					throw new Error('Address validation failed');
				for (const ip of ips) {
					addNode(entry.nodes, ip, '');
					entry.nodes.get(ip).manual = true;
					entry.selected.add(ip);
				}
				progress.textContent = '已勾选手动添加的 ' + ips.length + ' 个节点。';
				if (manual.value === input) manual.value = '';
				resetPage();
			} catch (error) {
				progress.textContent = '暂时无法校验节点 IP，请重试。';
			} finally {
				loading = false;
				renderTable();
			}
		});
		test.addEventListener('click', function() { run(Array.from(current().selected)); });
		testDefault.addEventListener('click', function() { run(['']); });
		best.addEventListener('click', function() { useNode(bestResult()?.ip); });
		function stopTest() {
			if (!testing || cancelled) return;
			cancelled = true;
			stop.disabled = true;
			progress.textContent = '当前节点结束后停止。';
		}
		stop.addEventListener('click', stopTest);

		const nodes = E('div', {}, [
			E('div', { class: 'xb-speed-controls' }, [
				E('div', { class: 'xb-row' }, [sourceField, channelField, online, importState]),
				E('div', { class: 'xb-row' }, [query, carrierField, regionField, selectPage, selectAll, clear]),
				E('div', { class: 'xb-row xb-between xb-test-bar' }, [
					E('div', { class: 'xb-row' }, [counter, settingsSummary]),
					E('div', { class: 'xb-row' }, [test, stop, testDefault])
				]),
				E('details', { class: 'xb-details' }, [E('summary', {}, ['手动添加 IP']),
					E('div', { class: 'xb-row' }, [manual, add])
				]),
				progress
			]),
			bestSummary, list,
			E('div', { class: 'xb-row xb-paging' }, [previous, next, pager])
		]);
		const map = new form.JSONMap({ speed: {} });
		const section = map.section(form.NamedSection, 'speed', 'speed');
		section.tab('speed-nodes', '节点测速');
		section.tab('speed-settings', '测速设置');
		section.taboption('speed-nodes', form.DummyValue, '_nodes').render = () => nodes;
		function preference(key, label, choices) {
			const field = section.taboption('speed-settings', form.ListValue, key, label);
			for (const [value, text] of choices) field.value(value, text);
			return field;
		}
		const targetOption = preference('target', '测速目标', Object.entries(targets)
			.filter(([key]) => key !== 'main' && key !== 'legacy').map(([key, data]) => [key, data[0]]));
		targetOption.default = 'global';
		const fileOption = preference('file', '测速文件', cn1Files);
		section.taboption('speed-settings', form.DummyValue, 'fixed_file', '测速文件').renderWidget = () => sample;
		const limitOption = preference('limit', '样本大小', [['auto', '原版样本'], ['1', '样本 1 MiB'], ['8', '样本 8 MiB'], ['32', '样本 32 MiB']]);
		const timeoutOption = preference('timeout', '单节点超时', [['3', '超时 3 秒'], ['5', '超时 5 秒'], ['10', '超时 10 秒']]);
		const budgetOption = section.taboption('speed-settings', form.Value, 'batch_limit', '整批流量上限（GB）',
			'按每次测速的样本下载量计算。填 0 表示不限，可填写小数。');
		budgetOption.default = '0';
		const settingsForm = await map.render();
		const control = option => option.getUIElement('speed').node.querySelector('select');
		const target = control(targetOption);
		const file = control(fileOption);
		const limit = control(limitOption);
		const timeout = control(timeoutOption);
		const batchLimit = budgetOption.getUIElement('speed').node.querySelector('input');
		batchLimit.inputMode = 'decimal';
		const targetField = target.closest('.cbi-value');
		const fileField = file.closest('.cbi-value');
		const fixedFile = sample.closest('.cbi-value');
		const settingsControls = { target, file, timeout, limit };
		let stored;
		try { stored = JSON.parse(localStorage.getItem(settingsKey)); } catch (error) { /* Use defaults. */ }
		setDraftControls(stored);
		let activeSettings = draftSettings();
		target.addEventListener('change', setTarget);

		settingsForm.addEventListener('cbi-tab-active', function(event) {
			if (event.target !== settingsForm) return;
			if (firstVisit) {
				firstVisit = false;
				loadList();
			} else {
				renderTable();
			}
		});
		setTarget();
		renderTable();
		return {
			element: settingsForm, refresh: renderTable, draftSettings, restoreDraft, settingsChanged, applySettings,
			isTesting: () => testing, stopTest,
			validSettings: draft => batchBudgetBytes(draft.batchLimit) !== null
		};
	}
});
