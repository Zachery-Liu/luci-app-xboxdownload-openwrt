'use strict';
'require baseclass';
'require form';
'require rpc';
'require ui';

const authorProfile = 'https://github.com/Zachery-Liu';
const project = authorProfile + '/luci-app-xboxdownload-openwrt';
const object = 'xboxdownload_openwrt';
const checkUpdate = rpc.declare({ object, method: 'update_check', reject: true });
const updateStatus = rpc.declare({ object, method: 'update_status', reject: true });
const startUpdate = rpc.declare({ object, method: 'update_start', params: ['version'], reject: true });
const phases = {
	checking: '正在确认发布版本…',
	downloading: '正在下载安装包…',
	verifying: '正在验证安装包…',
	installing: '正在安装更新，请保持路由器通电…'
};
const errors = {
	network: '无法连接 GitHub 检查更新，请稍后再试。',
	metadata: '发布信息或安装包版本有误，请查看发布页。',
	version: '无法读取当前安装版本，请检查此插件的 APK 安装状态。',
	storage: '路由器无法为更新创建临时文件，请检查可用空间。',
	busy: '配置或更新正在处理中，请稍后再试。',
	changed: '可安装版本已变化，请重新检查更新。',
	download: '安装包下载失败，请检查路由器到 GitHub 的连接。',
	integrity: '安装包大小或 SHA-256 校验失败。',
	signature: '安装包未通过项目发布签名验证。',
	install: 'APK 安装失败，请查看路由器的 APK 日志。',
	service: '已更新安装包，但加速服务未恢复，请查看系统日志。',
	interrupted: '更新进程中断，请核对当前版本后重试。'
};

function button(label, style) {
	return E('button', { type: 'button', class: 'cbi-button cbi-button-' + style }, label);
}

function link(href, label) {
	return E('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label);
}

function showTime(element, timestamp, unavailable) {
	const seconds = Number(timestamp);
	const date = new Date(seconds * 1000);
	if (seconds > 0 && Number.isFinite(date.getTime())) {
		element.dateTime = date.toISOString();
		element.textContent = date.toLocaleString('zh-CN', { hour12: false });
	} else {
		element.removeAttribute('datetime');
		element.textContent = unavailable;
	}
}

async function renderOutput(name, title, label, initial, monospace = false) {
	const map = new form.JSONMap({ [name]: { output: initial } });
	const section = map.section(form.NamedSection, name, name, title);
	const field = section.option(form.TextValue, 'output');
	field.readonly = true;
	field.rows = 7;
	field.wrap = true;
	field.monospace = monospace;
	const panel = await map.render();
	panel.id = 'cbi-xboxdownload-' + name;
	panel.classList.add('xb-about-output');
	panel.hidden = true;
	const region = panel.querySelector('.cbi-section');
	region.setAttribute('role', 'region');
	region.setAttribute('aria-label', title);
	const textarea = panel.querySelector('textarea');
	textarea.setAttribute('aria-label', label);
	return { panel, textarea };
}

return baseclass.extend({
	render: async function(icon, installBlockReason) {
		const writable = L.hasViewPermission() !== false;
		const current = E('span', {}, '读取中…');
		const latest = E('span', {}, '点击检查更新');
		const installedAt = E('time', {}, '读取中…');
		const checkedAt = E('time', {}, '读取中…');
		const message = E('p', { role: 'status', 'aria-live': 'polite', hidden: true });
		const check = button('检查更新', 'action');
		const install = button('安装更新', 'apply');
		const reload = button('刷新页面', 'action');
		const [{ panel: releaseNotes, textarea: notes }, { panel: logs, textarea: output }] = await Promise.all([
			renderOutput('release-notes', '更新说明', '说明正文', ''),
			renderOutput('update-log', '更新日志', '安装输出', '等待安装输出…', true)
		]);
		const pane = E('div', { class: 'xb-about' }, [
			E('section', { class: 'cbi-section' }, [
				E('div', { class: 'xb-about-identity' }, [
					E('img', { src: icon, width: 56, height: 56, alt: '' }),
					E('div', { class: 'xb-about-project' }, [
						E('h2', { class: 'xb-about-name' }, 'Xbox 下载助手（OpenWrt）'),
						E('div', {}, ['作者 ', link(authorProfile, 'Zachery Liu')]),
						link(project, project)
					])
				])
			]),
			E('section', { class: 'cbi-section' }, [
				E('h3', {}, '插件更新'),
				E('dl', { class: 'xb-update-versions' }, [
					E('dt', {}, '当前版本'), E('dd', {}, current),
					E('dt', {}, '最新版本'), E('dd', {}, latest),
					E('dt', {}, '上次更新时间'), E('dd', {}, installedAt),
					E('dt', {}, '最近检查时间'), E('dd', {}, checkedAt)
				]),
				E('div', { class: 'xb-row xb-update-actions' }, [check, install, reload]),
				message
			]),
			logs, releaseNotes
		]);
		let release, busy = false, tracking = false, timer, failures = 0;
		let requiresReload = false;

		function showMessage(text) {
			message.textContent = text;
			message.hidden = !text;
		}

		function updateControls() {
			check.disabled = busy || tracking || requiresReload;
			install.hidden = !writable || !release?.available || requiresReload;
			install.disabled = busy || tracking;
			reload.hidden = !requiresReload;
			logs.hidden = !tracking;
		}

		async function refresh() {
			if (busy || timer) return;
			busy = true;
			updateControls();
			try {
				const state = await updateStatus();
				const wasTracking = tracking;
				current.textContent = state.current || '无法读取';
				showTime(installedAt, state.installed_at, '暂无记录');
				showTime(checkedAt, state.checked_at, '从未检查');
				if (state.log && output.value !== state.log) {
					const follow = output.scrollTop + output.clientHeight >= output.scrollHeight - 8;
					output.value = state.log;
					if (follow) output.scrollTop = output.scrollHeight;
				}
				failures = 0;
				tracking = Object.hasOwn(phases, state.phase);
				if (tracking) showMessage(phases[state.phase]);
				if (state.phase === 'done' && state.current === state.target) {
					requiresReload ||= wasTracking;
					showMessage(requiresReload ? '更新完成，请刷新页面加载新版本。' : '已更新到 ' + state.current + '。');
				}
				if (state.phase === 'failed') {
					requiresReload ||= wasTracking && !!state.target && state.current === state.target;
					showMessage(errors[state.error] || '更新失败，请重试。');
				}
				if (state.phase === 'idle' && wasTracking) showMessage('未能确认更新已启动，请重新检查。');
			} catch (error) {
				failures += 1;
				if (tracking && failures < 10) showMessage('正在重新连接 LuCI，安装继续在路由器上运行…');
				else {
					tracking = false;
					showMessage('暂时无法读取更新状态，请稍后刷新页面。');
				}
			} finally {
				busy = false;
				updateControls();
				if (tracking) timer = window.setTimeout(() => { timer = null; refresh(); }, 2000);
			}
		}

		check.addEventListener('click', async () => {
			busy = true;
			release = null;
			latest.textContent = '检查中…';
			releaseNotes.hidden = true;
			showMessage('');
			updateControls();
			try {
				const result = await checkUpdate();
				current.textContent = result.current || '无法读取';
				if (result.checked_at) showTime(checkedAt, result.checked_at, '从未检查');
				if (result.error) throw new Error(result.error);
				release = result;
				latest.replaceChildren(link(project + '/releases/tag/' + encodeURIComponent(result.tag), result.latest));
				notes.value = result.notes?.trim() || '该版本暂无更新说明。';
				releaseNotes.hidden = false;
				showMessage(result.available ? '发现可安装的更新。' : '当前版本已是最新。');
			} catch (error) {
				latest.textContent = '检查失败';
				showMessage(errors[error.message] || '检查更新失败，请稍后再试。');
			} finally {
				busy = false;
				updateControls();
			}
		});

		function canInstall() {
			const reason = installBlockReason();
			if (reason) ui.addNotification(null, E('p', {}, reason), 'warning');
			return !reason;
		}

		install.addEventListener('click', () => {
			if (!canInstall()) return;
			const target = release.latest;
			const cancel = button('取消', 'neutral');
			const confirm = button('确认安装', 'apply');
			cancel.addEventListener('click', () => ui.hideModal());
			confirm.addEventListener('click', async () => {
				ui.hideModal();
				if (!canInstall()) return;
				busy = true;
				tracking = true;
				updateControls();
				output.value = phases.checking;
				showMessage(phases.checking);
				try {
					const result = await startUpdate(target);
					if (result.error) {
						tracking = false;
						showMessage(errors[result.error] || '无法开始更新，请重试。');
						return;
					}
					release = null;
				} catch (error) {
					// rpcd can reload before the client has received the start response.
					release = null;
				} finally {
					busy = false;
					updateControls();
					if (tracking) refresh();
				}
			});
			ui.showModal('安装更新', [
				E('p', {}, '将安装版本 ' + target + '。加速服务和 LuCI 连接可能会短暂中断。'),
				E('div', { class: 'right' }, [cancel, ' ', confirm])
			]);
		});
		reload.addEventListener('click', () => location.reload());
		pane.addEventListener('cbi-tab-active', refresh);
		updateControls();
		return pane;
	}
});
