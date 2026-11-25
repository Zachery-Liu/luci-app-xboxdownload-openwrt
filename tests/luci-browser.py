import json
import os
from ipaddress import ip_address, ip_network
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

root = Path.cwd()
openwrt = Path(os.environ['OPENWRT_WWW'])
local = root / 'package/root/www'
html = '''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/theme.css">
<script src="/luci-static/resources/cbi.js"></script>
<script src="/luci-static/resources/luci.js"></script>
</head><body><div class="main-right"><main id="maincontent"><div class="container" id="view"></div></main></div>
<script>
window._ = message => ({'Save & Apply': '保存并应用', 'Apply unchecked': '应用（不检查）', 'Save': '保存', 'Reset': '复位', 'Dismiss': '关闭'})[message] || message;
document.addEventListener('luci-loaded', async () => {
    try {
        const ui = await L.require('ui');
        await ui.instantiateView('xboxdownload_openwrt');
    } catch (error) {
        window.testFailure = error.stack;
    }
});
window.L = new LuCI({
    scriptname: '/cgi-bin/luci', documentroot: '/www', resource: '/luci-static/resources',
    media: '/luci-static/bootstrap', ubuspath: '/ubus', sessionid: '00000000000000000000000000000000',
    pollinterval: 5, nodespec: {satisfied: true}, requestpath: []
});
</script></body></html>'''
initial = {
    'running': True, 'enabled': True, 'dns_running': True, 'http_running': True,
    'router': '192.168.1.1', 'mode': 'redirect', 'client': '192.168.1.156',
    'main_ip': '220.194.72.94', 'legacy_ip': '', 'log_mode': 'http', 'log_path': '0', 'filter_aaaa': '0',
    'lan_ipv6_dns': '2001:db8::1\nfdaa:9067:4831::1\nfe80::1', 'lan_advertised_dns': 'fdaa:9067:4831::1',
    'wan6_state': 'present', 'ipv6_devices': '192.168.1.156/02:00:00:00:00:56/dns',
    'ipv6_dns_active': True, 'log': '17:14:20\tHTTP 302\t192.168.1.156\tassets1.xboxlive.com -> assets1.xboxlive.cn'
}
hints = {
    '02:00:00:00:00:56': {'name': 'Xbox', 'ipaddrs': ['192.168.1.156'], 'ip6addrs': ['2001:db8::56']},
    '02:00:00:00:00:55': {'name': '书房电脑', 'ipaddrs': ['192.168.1.155'], 'ip6addrs': ['fe80::55']},
    '02:00:00:00:00:59': {'name': '仅 IPv4', 'ipaddrs': ['192.168.1.159'], 'ip6addrs': []}
}

def configure_reply(state, call, requests):
    import json
    object_name, method, args = (call.get('params') or [None, None, None, {}])[1:]
    data = {}
    if object_name == 'network.interface.lan':
        data = {'ipv4-address': [{'address': '192.168.1.1', 'mask': 24}]}
    elif method == 'getHostHints':
        data = hints
    elif method == 'status':
        data = state.copy()
    elif method == 'update_status':
        data = {'current': '1.2.0-r0', 'phase': 'idle', 'installed_at': 1700000000,
                'checked_at': state.get('_checked_at')}
        if state.get('_updates'):
            stages = state['_update_stages']
            phase = stages.pop(0) if stages else state.get('_update_outcome', 'done')
            if phase == 'reconnecting':
                return {'jsonrpc': '2.0', 'id': call.get('id'), 'result': [7]}
            data.update(phase=phase, target='1.2.1-r0', log='(1/1) Upgrading luci-app-xboxdownload-openwrt')
            if phase == 'done':
                data.update(current='1.2.1-r0', installed_at=1700000060)
            elif phase == 'failed':
                data['error'] = 'signature'
    elif method == 'update_check':
        state['_checked_at'] = 1700000030
        data = {'current': '1.2.0-r0', 'latest': '1.2.1-r0', 'tag': 'v1.2.1', 'available': True,
                'checked_at': state['_checked_at'], 'notes': '## 更新内容\n- 修复示例 <b>原文</b>'}
    elif method == 'update_start':
        state.setdefault('_updates', []).append(args['version'])
        state['_update_stages'] = ['installing', 'reconnecting']
    elif method == 'configure':
        background = args.pop('background', 0)
        requests.append(args)
        state.update(json.loads(args['extra']))
        state.update({key: args[key] for key in ['client', 'main_ip', 'legacy_ip'] if key in args})
        if 'enabled' in args:
            state.update(enabled=bool(args['enabled']), running=bool(args['enabled']))
        if background:
            state['_pending_apply'] = True
            data = {'job': 'test0001'}
        else:
            data = {'error': ''}
    elif method == 'configure_status':
        assert args['job'] == 'test0001'
        data = {'pending': True} if state.pop('_pending_apply', False) else {'error': ''}
    elif method == 'validate_addresses':
        if args['kind'] == 'client':
            host = ip_address(args['addresses'])
            lan = ip_network('192.168.1.0/24')
            data = {'error': '' if host in lan and str(host) not in
                    ('192.168.1.0', '192.168.1.1', '192.168.1.255') else 'client_subnet'}
        else:
            data = {'error': '' if all(ip_address(value).is_global for value in args['addresses'].splitlines())
                    else 'cdn'}
    elif method == 'clear_logs':
        state['log'] = ''
    elif method == 'import_nodes':
        data = {'origin': 'github', 'nodes': '93.184.216.21\t示例节点'}
    elif method == 'probe':
        state.setdefault('_probes', []).append(dict(args))
        maximum = args.get('max_bytes') or int(args.get('sample', 50)) * 1048576
        data = {'ip': args.get('ip', '93.184.216.20'), 'bytes': str(maximum),
                'connect': '0.002', 'namelookup': '0', 'speed': '50000000', 'rtt': '2',
                'ttl': '58', 'code': '206', 'exit': 0}
        data.update(state.get('_probe_results', {}).get(args.get('ip'), {}))
    elif method == 'access':
        data = {'access': True}
    return {'jsonrpc': '2.0', 'id': call.get('id'), 'result': [0, data]}

prefix = 'admin/services/xboxdownload_openwrt'
base_url = 'http://luci.test/cgi-bin/luci/' + prefix
menu_file = root / 'package/root/usr/share/luci/menu.d/luci-app-xboxdownload_openwrt.json'
menu = json.loads(menu_file.read_text(encoding='utf-8'))
children = {path.rsplit('/', 1)[1]: dict(page, satisfied=True) for path, page in menu.items() if path.startswith(prefix + '/')}
entry = dict(menu[prefix], satisfied=True, children=children)
tree = {'children': {'admin': {'satisfied': True, 'title': '管理', 'children': {'services': {'satisfied': True, 'title': '服务', 'children': {'xboxdownload_openwrt': entry}}}}}}

def serve_luci(page, theme, state, requests, loads, menu_script='menu-bootstrap'):
    def serve(route):
        path = urlparse(route.request.url).path
        if path.startswith('/cgi-bin/luci/' + prefix):
            loads.append(path)
            dispatch = path.removeprefix('/cgi-bin/luci/').split('/')
            if len(dispatch) == 3:
                dispatch += ['service']
            doc = html.replace('<body>', '<body><ul id="modemenu"></ul><ul id="topmenu"></ul><ul id="mainmenu"></ul>')
            doc = doc.replace('<div class="container" id="view">', '<div id="tabmenu"></div><div class="container" id="view">')
            doc = doc.replace("const ui = await L.require('ui');", f"const ui = await L.require('ui');\n        await L.require('{menu_script}');")
            doc = doc.replace("'Dismiss': '关闭'", "'Dismiss': '关闭', 'Edit': '编辑'")
            doc = doc.replace('requestpath: []', 'dispatchpath: ' + json.dumps(dispatch) + ', requestpath: ' + json.dumps(dispatch))
            return route.fulfill(content_type='text/html; charset=utf-8', body=doc)
        if path == '/cgi-bin/luci/admin/menu':
            return route.fulfill(json=tree)
        if path == '/ubus':
            call = route.request.post_data_json
            reply = lambda item: configure_reply(state, item, requests)
            return route.fulfill(json=[reply(item) for item in call] if isinstance(call, list) else reply(call))
        if path == '/theme.css':
            return route.fulfill(content_type='text/css', body=theme)
        if path == '/luci-static/resources/xboxdownload_openwrt/logo.svg':
            return route.fulfill(path=str(root / 'docs/assets/logo.svg'), content_type='image/svg+xml')
        for directory in [local, openwrt]:
            file = directory / path.lstrip('/')
            if file.is_file():
                return route.fulfill(path=str(file), content_type='text/javascript' if file.suffix == '.js' else None)
        return route.fulfill(status=404)
    page.route('http://luci.test/**', serve)


bootstrap = (openwrt / 'luci-static/bootstrap/cascade.css').read_text(encoding='utf-8')

normal_reply = configure_reply
fault = None


def configure_reply(state, call, requests):
    if call.get('params', [None, None, None])[2] == 'configure' and fault:
        result = {'timeout': [7], 'unconfirmed': [0, {}], 'not-written': [0, {'error': ''}]}[fault]
        return {'jsonrpc': '2.0', 'id': call['id'], 'result': result}
    return normal_reply(state, call, requests)


def apply(page):
    page.locator('#view > .cbi-page-actions .cbi-button-apply').click(position={'x': 25, 'y': 15})


def hold_rpc(page, method):
    pending = []

    def intercept(route):
        request = route.request.post_data_json
        calls = request if isinstance(request, list) else [request]
        if any((call.get('params') or [None, None, None])[2] == method for call in calls):
            pending.append(route)
        else:
            route.fallback()

    page.route(lambda url: urlparse(url).path == '/ubus', intercept)
    return pending


def field(page):
    return page.locator('.xb-app').get_by_label('Xbox cn1 下载 IP')


def check_mobile_service(browser, theme):
    ipv6 = ['fd12:3456:789a:bcde:0123:4567:89ab:cdef', '2001:db8:1234:5678:9abc:def0:1111:2222', 'fe80::1']
    state = dict(initial, lan_ipv6_dns='\n'.join(ipv6))
    device = hints['02:00:00:00:00:56']
    device_name = device['name']
    page = browser.new_page(viewport={'width': 320, 'height': 900}, is_mobile=True, has_touch=True)
    device['name'] = 'PLAYSTATION-LIVING-ROOM-CONSOLE-WITH-A-LONG-NAME.lan'
    try:
        serve_luci(page, theme, state, [], [])
        page.goto(base_url + '/service')
        overview = page.locator('#cbi-xboxdownload-overview')
        downloads = page.locator('#cbi-xboxdownload-downloads')
        expect(overview.get_by_role('button', name='管理设备')).to_be_visible()
        values = [state['router'], *ipv6, f"{device['name']} · {state['client']}"]
        for value in values:
            expect(overview.get_by_text(value, exact=True)).to_be_visible()
        help_sizes = {}
        for width in (320, 412):
            page.set_viewport_size({'width': width, 'height': 900})
            for section in (overview, downloads):
                assert section.evaluate('section => section.scrollWidth <= section.clientWidth'), (width, section)
                assert section.locator('.cbi-value').evaluate_all('''rows => rows.every(row => {
                    const title = row.querySelector('.cbi-value-title').getBoundingClientRect();
                    const field = row.querySelector('.cbi-value-field').getBoundingClientRect();
                    return field.top >= title.bottom && Math.abs(field.left - title.left) <= 1;
                })'''), (width, section)
            assert overview.locator('.xb-overview-value').evaluate_all(
                'values => values.every(value => value.scrollWidth <= value.clientWidth)')
            help_button = overview.get_by_role('button', name='IPv6 与下载加速').bounding_box()
            assert help_button and help_button['width'] == help_button['height'] >= 24, help_button
            help_sizes[width] = help_button['width']
        overview.get_by_role('button', name='管理设备').click()
        expect(page.locator('.xb-device-table').get_by_text(device['name'], exact=True)).to_be_visible()
        page.get_by_role('button', name='新增设备').click()
        device_help = page.get_by_role('dialog', name='新增设备').get_by_role('button', name='如何查看 Xbox 设备名称')
        for width, size in help_sizes.items():
            page.set_viewport_size({'width': width, 'height': 900})
            box = device_help.bounding_box()
            assert box and box['width'] == box['height'] == size, (width, box)
            assert 0 <= box['x'] <= width - size, (width, box)
    finally:
        device['name'] = device_name
        page.close()


def check_about(browser, theme):
    page = browser.new_page(viewport={'width': 320, 'height': 800})
    state = initial.copy()
    loads = []
    serve_luci(page, theme, state, [], loads)
    page.goto(base_url + '/service')
    page.locator('#tabmenu').get_by_role('link', name='关于', exact=True).click()
    about = page.locator('.xb-about')
    project = 'https://github.com/Zachery-Liu/luci-app-xboxdownload-openwrt'
    logs = about.locator('#cbi-xboxdownload-update-log')
    notes = about.get_by_role('region', name='更新说明')
    timestamps = about.locator('time')
    expect(about.get_by_role('heading', name='Xbox 下载助手（OpenWrt）')).to_be_visible()
    expect(about.get_by_role('link', name='Zachery Liu')).to_have_attribute('href', 'https://github.com/Zachery-Liu')
    expect(about.get_by_role('link', name=project, exact=True)).to_have_attribute('href', project)
    expect(about.get_by_text('1.2.0-r0', exact=True)).to_be_visible()
    expect(timestamps.nth(0)).to_have_attribute('datetime', '2023-11-14T22:13:20.000Z')
    expect(timestamps.nth(1)).to_have_text('从未检查')
    expect(logs).to_be_hidden()
    assert about.locator('img').evaluate('image => image.complete && image.naturalWidth > 0')
    assert about.evaluate('pane => pane.scrollWidth === pane.clientWidth')
    assert len(loads) == 1
    about.get_by_role('button', name='检查更新').click()
    expect(about.get_by_role('link', name='1.2.1-r0')).to_be_visible()
    expect(timestamps.nth(1)).to_have_attribute('datetime', '2023-11-14T22:13:50.000Z')
    expect(notes.get_by_role('heading', name='更新说明')).to_be_visible()
    notes_body = notes.get_by_role('textbox', name='说明正文')
    expect(notes_body).to_have_value('## 更新内容\n- 修复示例 <b>原文</b>')
    expect(notes_body).to_have_attribute('readonly', '')
    assert about.evaluate('pane => pane.scrollWidth === pane.clientWidth')
    expect(logs).to_be_hidden()
    about.get_by_role('button', name='安装更新').click()
    modal = page.get_by_role('dialog')
    expect(modal.get_by_text('将安装版本 1.2.1-r0', exact=False)).to_be_visible()
    modal.get_by_role('button', name='取消').click()
    assert '_updates' not in state
    expect(logs).to_be_hidden()
    state['_update_outcome'] = 'failed'
    about.get_by_role('button', name='安装更新').click()
    modal.get_by_role('button', name='确认安装').click()
    expect(logs).to_be_visible()
    expect(about.get_by_text('安装包未通过项目发布签名验证。')).to_be_visible()
    expect(logs).to_be_hidden()
    state['_update_outcome'] = 'done'
    about.get_by_role('button', name='检查更新').click()
    about.get_by_role('button', name='安装更新').click()
    modal.get_by_role('button', name='确认安装').click()
    expect(about.get_by_text('正在安装更新', exact=False)).to_be_visible()
    expect(logs.get_by_role('heading', name='更新日志')).to_be_visible()
    log_body = logs.get_by_role('textbox', name='安装输出')
    expect(log_body).to_have_value('(1/1) Upgrading luci-app-xboxdownload-openwrt')
    expect(log_body).to_have_attribute('readonly', '')
    expect(about.get_by_text('正在重新连接 LuCI', exact=False)).to_be_visible()
    expect(logs).to_be_visible()
    expect(about.get_by_text('更新完成', exact=False)).to_be_visible()
    expect(logs).to_be_hidden()
    assert state['_updates'] == ['1.2.1-r0', '1.2.1-r0']
    about.get_by_role('button', name='刷新页面').click()
    expect(about.get_by_text('已更新到 1.2.1-r0。')).to_be_visible()
    expect(timestamps.nth(0)).to_have_attribute('datetime', '2023-11-14T22:14:20.000Z')
    expect(timestamps.nth(1)).to_have_attribute('datetime', '2023-11-14T22:13:50.000Z')
    expect(about.get_by_role('button', name='检查更新')).to_be_enabled()
    page.close()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel=os.environ.get('PLAYWRIGHT_CHANNEL'), headless=True)
    check_mobile_service(browser, bootstrap)
    print('PASS: phone-width service fields fit and display full DNS addresses and device names')
    check_about(browser, bootstrap)
    print('PASS: About shows update times and release notes directly, confirms upgrades and reconnects during installation')
    context = browser.new_context()

    # Exercise the primary LuCI workflow before simulating configuration failures.
    state, requests = initial.copy(), []
    smoke = context.new_page()
    serve_luci(smoke, bootstrap, state, requests, [])
    smoke.goto(base_url + '/devices')
    app = smoke.locator('.xb-app')
    app.get_by_role('button', name='新增设备').click()
    dialog = smoke.get_by_role('dialog', name='新增设备')
    dialog.get_by_label('IPv4 地址', exact=True).fill('192.168.2.155')
    dialog.get_by_label('IPv6 策略').select_option('system')
    dialog.get_by_role('button', name='添加', exact=True).click()
    expect(dialog.get_by_text('请输入路由器 LAN 子网内可用的设备 IPv4 地址。')).to_be_visible()
    dialog.get_by_label('局域网设备').select_option('192.168.1.155')
    dialog.get_by_label('IPv6 策略').select_option('dns')
    dialog.get_by_role('button', name='添加', exact=True).click()
    expect(app.get_by_text('书房电脑', exact=True)).to_be_visible()
    smoke.locator('#tabmenu').get_by_role('link', name='测速', exact=True).click()
    app.locator('summary').filter(has_text='手动添加 IP').click()
    app.get_by_label('手动添加 IP', exact=True).fill('93.184.216.22, 198.18.0.1')
    app.get_by_role('button', name='添加 IP', exact=True).click()
    expect(app.get_by_text('请检查列表，所有节点都必须是有效的公网 CDN IP。')).to_be_visible()
    expect(app.get_by_role('checkbox', name='选择 93.184.216.22')).to_have_count(0)
    app.get_by_label('手动添加 IP', exact=True).fill('93.184.216.22')
    app.get_by_role('button', name='添加 IP', exact=True).click()
    expect(app.get_by_role('checkbox', name='选择 93.184.216.22')).to_be_checked()
    app.get_by_role('button', name='清空勾选').click()
    print('PASS: LuCI rejects an off-LAN device and validates the complete manual CDN list before adding')
    app.get_by_role('checkbox', name='选择 93.184.216.21').check()
    app.get_by_role('button', name='开始测速').click()
    app.get_by_role('button', name='选用到 Xbox cn1').click()
    smoke.locator('#view > .cbi-page-actions').get_by_role('button', name='保存', exact=True).click()
    expect(smoke.get_by_text('已保存，等待应用。')).to_be_visible()
    assert not requests
    smoke.goto(base_url + '/service')
    expect(field(smoke)).to_have_value('93.184.216.21')
    for section in ('overview', 'downloads'):
        content = app.locator(f'#cbi-xboxdownload-{section} .cbi-section-node')
        assert content.evaluate("node => parseFloat(getComputedStyle(node).paddingBlockStart)") >= 8
    overview = app.locator('#cbi-xboxdownload-overview .cbi-section-node')
    assert overview.evaluate("node => parseFloat(getComputedStyle(node).paddingBlockEnd)") >= 8
    apply(smoke)
    expect(smoke.get_by_text('已保存并应用。')).to_be_visible()
    assert state['main_ip'] == '93.184.216.21' and '192.168.1.155' in state['client']
    print('PASS: add device, select a CDN, persist a draft across navigation and apply')
    state['log'] += '\n17:14:19\tDNS A\t192.168.1.155\tassets1.xboxlive.com'
    state['log'] += '\n17:14:18\tDNS SRV\tfe80::56\tassets-srvs.xboxlive.com'
    smoke.goto(base_url + '/logs')
    log = app.get_by_role('table')
    expect(log.get_by_role('columnheader')).to_have_text(['时间', '客户端 IP', '请求', '域名 / 跳转'])
    expect(log.get_by_role('row').filter(has_text='HTTP 302').get_by_role('cell')).to_have_text(
        ['17:14:20', '192.168.1.156', 'HTTP 302', 'assets1.xboxlive.com -> assets1.xboxlive.cn']
    )
    expect(log.get_by_role('row').filter(has_text='DNS A').get_by_role('cell')).to_have_text(
        ['17:14:19', '192.168.1.155', 'DNS A', 'assets1.xboxlive.com']
    )
    expect(log.get_by_role('row').filter(has_text='DNS SRV').get_by_role('cell')).to_have_text(
        ['17:14:18', 'fe80::56', 'DNS SRV', 'assets-srvs.xboxlive.com']
    )
    print('PASS: HTTP and DNS log records align with their column headings')

    state.update(running=False, dns_running=False, http_running=False, upstream_state='unavailable')
    smoke.goto(base_url + '/service')
    expect(app.get_by_text('加速已暂停', exact=True)).to_be_visible()
    expect(app.get_by_text('上游 DNS 探测失败', exact=False)).to_be_visible()
    expect(app.get_by_role('button', name='重试启动')).to_be_hidden()
    expect(app.get_by_role('button', name='停止服务')).to_be_visible()
    state['upstream_state'] = 'dns_unavailable'
    expect(app.get_by_text('本地 DNS 服务探测失败', exact=False)).to_be_visible(timeout=15000)
    state.update(running=True, dns_running=True, http_running=True, upstream_state='normal')
    expect(app.get_by_text('服务运行中', exact=True)).to_be_visible(timeout=15000)
    expect(app.get_by_text('加速已暂停', exact=True)).to_be_hidden()
    print('PASS: the service page shows both DNS pause reasons and updates after automatic recovery')
    smoke.close()

    budget_context = browser.new_context()
    budget_page = budget_context.new_page()
    budget_state = initial.copy()
    budget_state['_probe_results'] = {'93.184.216.22': {'speed': '90000000'}}
    serve_luci(budget_page, bootstrap, budget_state, [], [])
    budget_page.goto(base_url + '/speed')
    budget_app = budget_page.locator('.xb-app')
    budget_app.get_by_role('link', name='测速设置').click()
    budget = budget_app.get_by_label('整批流量上限（GB）')
    expect(budget).to_have_value('0')
    budget.fill('-1')
    apply(budget_page)
    expect(budget_page.get_by_text('整批流量上限请输入非负数字', exact=False)).to_be_visible()
    budget.fill('0.002')
    budget_app.get_by_label('样本大小').select_option('1')
    apply(budget_page)
    budget_page.reload()
    budget_app.get_by_role('link', name='测速设置').click()
    expect(budget).to_have_value('0.002')
    budget_app.get_by_role('link', name='节点测速').click()
    budget_app.locator('summary').filter(has_text='手动添加 IP').click()
    budget_app.get_by_label('手动添加 IP', exact=True).fill('93.184.216.21, 93.184.216.22, 93.184.216.23')
    budget_app.get_by_role('button', name='添加 IP', exact=True).click()
    expect(budget_app.get_by_role('checkbox', name='选择 93.184.216.23')).to_be_checked()
    budget_app.get_by_role('button', name='开始测速').click()
    expect(budget_app.get_by_text('已达到整批流量上限 · 2/3 · 已确认下载 0.002 GB / 0.002 GB')).to_be_visible()
    assert [call['max_bytes'] for call in budget_state['_probes']] == [1048576, 951424]
    expect(budget_app.get_by_text('预算限量样本')).to_be_visible()
    expect(budget_app.locator('.xb-best-node')).to_have_text('93.184.216.21')
    budget_app.get_by_role('link', name='测速设置').click()
    budget.fill('0')
    apply(budget_page)
    budget_app.get_by_role('link', name='节点测速').click()
    budget_app.get_by_role('button', name='开始测速').click()
    expect(budget_app.get_by_text('测速完成 · 3/3')).to_be_visible()
    assert len(budget_state['_probes']) == 5 and all(not call.get('max_bytes') for call in budget_state['_probes'][2:])
    print('PASS: the optional budget persists, caps the last sample and defaults to unlimited')

    budget_state['_probe_results'] = {
        '93.184.216.21': {'bytes': '250000', 'speed': '990000000', 'exit': 28,
                         'rtt': '', 'connect': '0.040', 'namelookup': '0.005'},
        '93.184.216.22': {'speed': '5000000', 'rtt': '35', 'connect': '0.004', 'namelookup': '0.001'},
        '93.184.216.23': {'speed': '4000000', 'rtt': '5', 'connect': '0.050', 'namelookup': '0.001'}
    }
    budget_app.get_by_role('button', name='开始测速').click()
    expect(budget_app.get_by_text('样本不足')).to_be_visible()
    expect(budget_app.locator('.xb-best-node')).to_have_text('93.184.216.22')
    table = budget_app.locator('.xb-node-table')
    with_ping = table.get_by_role('row').filter(has_text='93.184.216.22')
    without_ping = table.get_by_role('row').filter(has_text='93.184.216.21')
    expect(with_ping.get_by_role('cell').nth(4)).to_have_text('35 ms')
    expect(with_ping.get_by_role('cell').nth(5)).to_have_text('3 ms')
    expect(without_ping.get_by_role('cell').nth(4)).to_have_text('—')
    expect(without_ping.get_by_role('cell').nth(5)).to_have_text('35 ms')
    table.get_by_role('button', name='ICMP 延迟').click()
    expect(table.get_by_role('row').nth(1)).to_contain_text('93.184.216.23')
    table.get_by_role('button', name='TCP 建连').click()
    expect(table.get_by_role('row').nth(1)).to_contain_text('93.184.216.22')
    budget_page.set_viewport_size({'width': 460, 'height': 900})
    expect(table.get_by_role('columnheader', name='ICMP 延迟')).to_be_hidden()
    expect(with_ping.get_by_text('ICMP 35 ms', exact=True)).to_be_visible()
    expect(with_ping.get_by_text('TCP 3 ms', exact=True)).to_be_visible()
    budget_page.set_viewport_size({'width': 1280, 'height': 900})
    print('PASS: short samples stay out of ranking, and ICMP and TCP display and sort separately')

    for label, changed, original in (
        ('单节点超时', '5', '3'), ('样本大小', '8', '1'), ('测速文件', 'halo', 'default')
    ):
        budget_app.get_by_role('link', name='测速设置').click()
        budget_app.get_by_label(label, exact=True).select_option(changed)
        apply(budget_page)
        budget_app.get_by_role('link', name='节点测速').click()
        expect(table.get_by_text('待测速', exact=True)).to_have_count(3)
        expect(budget_app.locator('.xb-best')).to_be_hidden()
        budget_app.get_by_role('link', name='测速设置').click()
        budget_app.get_by_label(label, exact=True).select_option(original)
        apply(budget_page)
        budget_app.get_by_role('link', name='节点测速').click()
        expect(budget_app.locator('.xb-best-node')).to_have_text('93.184.216.22')

    budget_state['_probe_results'] = {
        '93.184.216.21': {'sample_id': 'old', 'speed': '99000000'},
        '93.184.216.22': {'sample_id': 'new', 'speed': '5000000'}
    }
    budget_app.get_by_label('在线 IP 来源').select_option('app')
    expect(table.get_by_role('checkbox', name='选择 93.184.216.21')).to_be_visible()
    if not budget_app.get_by_label('手动添加 IP', exact=True).is_visible():
        budget_app.locator('summary').filter(has_text='手动添加 IP').click()
    budget_app.get_by_label('手动添加 IP', exact=True).fill('93.184.216.21, 93.184.216.22')
    budget_app.get_by_role('button', name='添加 IP', exact=True).click()
    expect(table.get_by_role('checkbox', name='选择 93.184.216.22')).to_be_checked()
    budget_app.get_by_role('button', name='开始测速').click()
    expect(budget_app.locator('.xb-best-node')).to_have_text('93.184.216.22')
    expect(table.get_by_role('row').filter(has_text='93.184.216.21').get_by_text('待测速', exact=True)).to_be_visible()
    budget_context.close()
    print('PASS: ranking is isolated by file, sample size, timeout, and the actual store sample')

    coordination_state, coordination_requests = initial.copy(), []
    coordination = context.new_page()
    serve_luci(coordination, bootstrap, coordination_state, coordination_requests, [])
    waiting_probes = hold_rpc(coordination, 'probe')
    waiting_config = hold_rpc(coordination, 'configure')
    coordination.goto(base_url + '/service')
    field(coordination).fill('93.184.216.42')
    coordination.locator('#tabmenu').get_by_role('link', name='测速', exact=True).click()
    app = coordination.locator('.xb-app')
    app.locator('summary').filter(has_text='手动添加 IP').click()
    app.get_by_label('手动添加 IP', exact=True).fill('93.184.216.21, 93.184.216.22')
    app.get_by_role('button', name='添加 IP', exact=True).click()
    expect(app.get_by_role('checkbox', name='选择 93.184.216.22')).to_be_checked()
    begin = app.get_by_role('button', name='开始测速')
    begin.click()
    apply(coordination)
    expect(coordination.get_by_text('测速正在进行。请等待测速结束，或停止测速后再应用设置。')).to_be_visible()
    assert not waiting_config and not coordination_requests
    stop_service = app.get_by_role('button', name='停止服务')
    stop_service.click()
    expect(app.get_by_text('当前节点结束后停止。')).to_be_visible()
    expect(stop_service).to_be_disabled()
    assert len(waiting_probes) == 1
    waiting_probes.pop().fallback()
    expect(app.get_by_text('已停止 · 1/2', exact=True)).to_be_visible()
    assert not waiting_probes and len(coordination_state['_probes']) == 1
    expect(begin).to_be_disabled()
    assert len(waiting_config) == 1
    waiting_config.pop().fallback()
    expect(begin).to_be_enabled()
    expect(app.get_by_text('服务已停止', exact=True)).to_be_visible()
    assert coordination_requests == [{'enabled': 0, 'extra': '{}'}], coordination_requests
    coordination.locator('#tabmenu').get_by_role('link', name='服务', exact=True).click()
    expect(field(coordination)).to_have_value('93.184.216.42')
    assert coordination_state['main_ip'] == initial['main_ip']
    coordination.close()
    print('PASS: apply waits for the batch, stopping service cancels remaining probes and retains the draft')

    start_state = dict(initial, enabled=False, running=False, dns_running=False, http_running=False,
                       client='', ipv6_devices='')
    start_requests = []
    start_context = browser.new_context()
    start_page = start_context.new_page()
    serve_luci(start_page, bootstrap, start_state, start_requests, [])
    start_page.goto(base_url + '/devices')
    start_app = start_page.locator('.xb-app')
    expect(start_app.get_by_role('button', name='启动服务')).to_be_disabled()
    start_app.get_by_role('button', name='新增设备').click()
    dialog = start_page.get_by_role('dialog', name='新增设备')
    dialog.get_by_label('局域网设备').select_option('192.168.1.156')
    dialog.get_by_label('IPv6 策略').select_option('dns')
    dialog.get_by_role('button', name='添加', exact=True).click()
    start_page.locator('#tabmenu').get_by_role('link', name='服务', exact=True).click()
    field(start_page).fill('93.184.216.42')
    start_page.locator('#tabmenu').get_by_role('link', name='测速', exact=True).click()
    start_app.get_by_role('link', name='测速设置').click()
    start_budget = start_app.get_by_label('整批流量上限（GB）')
    start_budget.fill('1.5')
    start = start_app.get_by_role('button', name='启动服务')
    expect(start).to_be_enabled()
    start.click()
    warning = start_page.get_by_text('您还有未保存或未应用的内容。请先「保存并应用」或「复位」，再启动服务。')
    expect(warning).to_be_visible()
    assert not start_state['enabled'] and not start_state['client'] and not start_requests
    footer = start_page.locator('#view > .cbi-page-actions')
    footer.get_by_role('button', name='保存', exact=True).click()
    start_page.reload()
    start_app.get_by_role('link', name='测速设置').click()
    expect(start_budget).to_have_value('1.5')
    start_page.locator('#tabmenu').get_by_role('link', name='服务', exact=True).click()
    expect(field(start_page)).to_have_value('93.184.216.42')
    start.click()
    expect(warning).to_be_visible()
    assert not start_requests
    apply(start_page)
    expect(start_page.get_by_text('已保存并应用。')).to_be_visible()
    assert start_requests == [{'client': '192.168.1.156', 'main_ip': '93.184.216.42',
                               'extra': '{"ipv6_devices":"192.168.1.156/02:00:00:00:00:56/dns"}'}], start_requests
    assert not start_state['enabled']
    field(start_page).fill('93.184.216.43')
    footer.get_by_role('button', name='保存', exact=True).click()
    footer.get_by_role('button', name='复位', exact=True).click()
    expect(field(start_page)).to_have_value('93.184.216.42')
    start_page.reload()
    expect(field(start_page)).to_have_value('93.184.216.42')
    start_page.locator('#tabmenu').get_by_role('link', name='测速', exact=True).click()
    start_app.get_by_role('link', name='测速设置').click()
    expect(start_budget).to_have_value('1.5')
    start_budget.fill('2')
    start.click()
    expect(warning).to_be_visible()
    assert len(start_requests) == 1
    footer.get_by_role('button', name='复位', exact=True).click()
    expect(start_budget).to_have_value('1.5')
    start.click()
    expect(start_app.get_by_text('服务运行中', exact=True)).to_be_visible()
    assert start_requests[-1] == {'enabled': 1, 'extra': '{}'}, start_requests
    start_context.close()
    print('PASS: start prompts for dirty or staged drafts, apply and reset are explicit, and start sends only enabled')

    device_state, device_requests = initial.copy(), []
    profile_page = context.new_page()
    serve_luci(profile_page, bootstrap, device_state, device_requests, [])
    profile_page.goto(base_url + '/devices')
    edit = profile_page.get_by_role('button', name='编辑设备 192.168.1.156')
    edit.click()
    profile = profile_page.get_by_role('dialog', name='编辑设备')
    routing = profile.get_by_label('下载线路', exact=True)
    node = profile.get_by_label('Xbox com 下载 IP', exact=True)
    upstream = profile.get_by_label('上游 DNS', exact=True)
    expect(routing).to_have_value('shared')
    expect(node).to_be_hidden()
    routing.select_option('custom')
    upstream.fill('8.8.8.8')
    cn1 = profile.get_by_label('Xbox cn1 下载 IP', exact=True)
    cn1.fill('2606:4700::1111')
    profile.get_by_role('button', name='确定', exact=True).click()
    expect(profile.get_by_role('alert')).to_have_text('Xbox cn1、cn2 线路请填写公网 IPv4 节点。')
    cn1.fill('')
    node.fill('2606:4700::1111')
    profile.get_by_role('button', name='确定', exact=True).click()
    expect(profile_page.get_by_text('自定义线路', exact=True)).to_be_visible()
    apply(profile_page)
    expect(profile_page.get_by_text('已保存并应用。')).to_be_visible()
    assert device_state['device_routes'] == '192.168.1.156/0/8.8.8.8///2606:4700::1111/////'
    assert device_state['main_ip'] == initial['main_ip']
    profile_page.reload()
    edit.click()
    expect(upstream).to_have_value('8.8.8.8')
    expect(node).to_have_value('2606:4700::1111')
    routing.select_option('shared')
    profile.get_by_role('button', name='确定', exact=True).click()
    apply(profile_page)
    expect(profile_page.get_by_text('已保存并应用。')).to_be_visible()
    assert device_state['device_routes'] == ''
    profile_page.close()
    print('PASS: LuCI edits, reloads and clears custom device routes independently of service defaults')

    state, requests = initial.copy(), []
    page = context.new_page()
    serve_luci(page, bootstrap, state, requests, [], 'menu-bootstrap')
    page.goto(base_url + '/service')
    field(page).fill('93.184.216.50')
    for fault in ('timeout', 'unconfirmed', 'not-written'):
        apply(page)
        expect(page.get_by_text('无法确认路由器设置已应用。请稍后重试。')).to_be_visible()
        expect(page.get_by_text('已保存并应用。')).to_have_count(0)
        assert state['main_ip'] == initial['main_ip']
        page.reload()
        expect(field(page)).to_have_value('93.184.216.50')
    fault = None
    apply(page)
    expect(page.get_by_text('已保存并应用。')).to_be_visible()
    assert state['main_ip'] == '93.184.216.50'
    print('PASS: ubus timeout, empty acknowledgement and readback mismatch preserve the reloadable draft')

    first, second = context.new_page(), context.new_page()
    for tab in (first, second):
        serve_luci(tab, bootstrap, state, requests, [], 'menu-bootstrap')
        tab.goto(base_url + '/service')
        expect(field(tab)).to_have_value('93.184.216.50')
    field(first).fill('93.184.216.51')
    apply(first)
    expect(first.get_by_text('已保存并应用。')).to_be_visible()
    second.locator('#tabmenu').get_by_role('link', name='日志', exact=True).click()
    second.locator('.xb-app').get_by_role('link', name='日志设置').click()
    second.get_by_label('记录范围').select_option('all')
    apply(second)
    expect(second.get_by_text('已保存并应用。')).to_be_visible()
    assert requests[-1] == {'extra': '{"log_mode":"all"}'}, requests[-1]
    assert state['main_ip'] == '93.184.216.51' and state['log_mode'] == 'all'
    second.locator('#tabmenu').get_by_role('link', name='服务', exact=True).click()
    expect(field(second)).to_have_value('93.184.216.51')
    print('PASS: a second tab changes logging without sending the older CDN or service state')
