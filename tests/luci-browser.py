import json
import os
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
    elif method == 'configure':
        requests.append(args)
        state.update(json.loads(args['extra']))
        state.update({key: args[key] for key in ['client', 'main_ip', 'legacy_ip'] if key in args})
        if 'enabled' in args:
            state.update(enabled=bool(args['enabled']), running=bool(args['enabled']))
        data = {'error': ''}
    elif method == 'clear_logs':
        state['log'] = ''
    elif method == 'import_nodes':
        data = {'origin': 'github', 'nodes': '203.0.113.21\t示例节点'}
    elif method == 'probe':
        data = {'ip': args.get('ip', '203.0.113.20'), 'bytes': '52428800',
                'connect': '0.002', 'speed': '50000000', 'rtt': '2', 'ttl': '58', 'code': '206', 'exit': 0}
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


def field(page):
    return page.locator('.xb-app').get_by_label('Xbox cn1 下载 IP')


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel=os.environ.get('PLAYWRIGHT_CHANNEL'), headless=True)
    context = browser.new_context()

    # Exercise the primary LuCI workflow before simulating configuration failures.
    state, requests = initial.copy(), []
    smoke = context.new_page()
    serve_luci(smoke, bootstrap, state, requests, [])
    smoke.goto(base_url + '/devices')
    app = smoke.locator('.xb-app')
    app.get_by_role('button', name='新增设备').click()
    dialog = smoke.get_by_role('dialog', name='新增设备')
    dialog.get_by_label('局域网设备').select_option('192.168.1.155')
    dialog.get_by_role('button', name='添加', exact=True).click()
    expect(app.get_by_text('书房电脑', exact=True)).to_be_visible()
    smoke.locator('#tabmenu').get_by_role('link', name='测速', exact=True).click()
    app.get_by_role('checkbox', name='选择 203.0.113.21').check()
    app.get_by_role('button', name='开始测速').click()
    app.get_by_role('button', name='选用到 Xbox cn1').click()
    smoke.locator('#view > .cbi-page-actions').get_by_role('button', name='保存', exact=True).click()
    expect(smoke.get_by_text('已保存，等待应用。')).to_be_visible()
    assert not requests
    smoke.goto(base_url + '/service')
    expect(field(smoke)).to_have_value('203.0.113.21')
    for section in ('overview', 'downloads'):
        content = app.locator(f'#cbi-xboxdownload-{section} .cbi-section-node')
        assert content.evaluate("node => parseFloat(getComputedStyle(node).paddingBlockStart)") >= 8
    overview = app.locator('#cbi-xboxdownload-overview .cbi-section-node')
    assert overview.evaluate("node => parseFloat(getComputedStyle(node).paddingBlockEnd)") >= 8
    apply(smoke)
    expect(smoke.get_by_text('已保存并应用。')).to_be_visible()
    assert state['main_ip'] == '203.0.113.21' and '192.168.1.155' in state['client']
    print('PASS: add device, select a CDN, persist a draft across navigation and apply')
    state['log'] += '\n17:14:19\tDNS A\t192.168.1.155\tassets1.xboxlive.com'
    smoke.goto(base_url + '/logs')
    log = app.get_by_role('table')
    expect(log.get_by_role('columnheader')).to_have_text(['时间', '客户端 IP', '请求', '域名 / 跳转'])
    expect(log.get_by_role('row').filter(has_text='HTTP 302').get_by_role('cell')).to_have_text(
        ['17:14:20', '192.168.1.156', 'HTTP 302', 'assets1.xboxlive.com -> assets1.xboxlive.cn']
    )
    expect(log.get_by_role('row').filter(has_text='DNS A').get_by_role('cell')).to_have_text(
        ['17:14:19', '192.168.1.155', 'DNS A', 'assets1.xboxlive.com']
    )
    print('PASS: HTTP and DNS log records align with their column headings')
    smoke.close()

    state, requests = initial.copy(), []
    page = context.new_page()
    serve_luci(page, bootstrap, state, requests, [], 'menu-bootstrap')
    page.goto(base_url + '/service')
    field(page).fill('203.0.113.50')
    for fault in ('timeout', 'unconfirmed', 'not-written'):
        apply(page)
        expect(page.get_by_text('无法确认路由器设置已应用。请稍后重试。')).to_be_visible()
        expect(page.get_by_text('已保存并应用。')).to_have_count(0)
        assert state['main_ip'] == initial['main_ip']
        page.reload()
        expect(field(page)).to_have_value('203.0.113.50')
    fault = None
    apply(page)
    expect(page.get_by_text('已保存并应用。')).to_be_visible()
    assert state['main_ip'] == '203.0.113.50'
    print('PASS: ubus timeout, empty acknowledgement and readback mismatch preserve the reloadable draft')

    first, second = context.new_page(), context.new_page()
    for tab in (first, second):
        serve_luci(tab, bootstrap, state, requests, [], 'menu-bootstrap')
        tab.goto(base_url + '/service')
        expect(field(tab)).to_have_value('203.0.113.50')
    field(first).fill('203.0.113.51')
    apply(first)
    expect(first.get_by_text('已保存并应用。')).to_be_visible()
    second.locator('#tabmenu').get_by_role('link', name='日志', exact=True).click()
    second.locator('.xb-app').get_by_role('link', name='日志设置').click()
    second.get_by_label('记录范围').select_option('all')
    apply(second)
    expect(second.get_by_text('已保存并应用。')).to_be_visible()
    assert requests[-1] == {'extra': '{"log_mode":"all"}'}, requests[-1]
    assert state['main_ip'] == '203.0.113.51' and state['log_mode'] == 'all'
    second.locator('#tabmenu').get_by_role('link', name='服务', exact=True).click()
    expect(field(second)).to_have_value('203.0.113.51')
    print('PASS: a second tab changes logging without sending the older CDN or service state')
