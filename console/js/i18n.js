// Copy: Chinese first, English kept in the same shape. Short.
export const dict = {
  zh: {
    workers: '函数', new: '新建', deploy: '发布', deploying: '发布中', deployed: '已发布', copy: '复制', copied: '已复制',
    settings: '设置', editor: '代码', test: '测试', login: '登录', logout: '退出', register: '注册', email: '邮箱', password: '密码',
    loginTitle: '登录 funx', loginSub: '写一个 fetch 函数，发布就有网址。', noAccount: '没有账号？注册', haveAccount: '已有账号？登录',
    pwHint: '至少 10 位', mock: '示例数据 · 只存在本机', name: '名称', url: '网址', status: '状态', lastDeploy: '最近发布',
    running: '运行中', disabled: '已停用', pending: '未上线', empty: '还没有函数。', emptyCta: '写第一个',
    request: '请求', response: '响应', send: '发送', headers: '请求头', body: '请求体', resHeaders: '响应头',
    draft: '当前代码', live: '线上', draftHint: '在浏览器里运行编辑器里的代码，不用发布', liveHint: '请求已发布的网址',
    noResponse: '点「发送」看结果', ms: '毫秒', timeout: '超时（10 秒）', failed: '出错了', notDeployed: '还没发布',
    vars: '变量', secrets: '密钥', varsHint: '在代码里用 env.名称 读取。', secretsHint: '发布后只能改，不能再看到值。',
    add: '添加', save: '保存', saved: '已保存', remove: '删除', value: '值', keyName: '名称',
    danger: '停用和删除', disable: '停用', enable: '启用', disableHint: '停用后网址返回 403，可以随时启用。',
    deleteWorker: '删除函数', deleteHint: '网址、代码、变量和密钥一起删除，无法恢复。', typeName: '输入函数名确认', typeNameBefore: '输入函数名', typeNameAfter: '确认',
    namePh: '函数名', nameRule: '3–32 位小写字母、数字或 -', loginToDeploy: '登录后才能发布', back: '返回',
    logs: '日志', logsNA: '日志暂未开通', needLogin: '请先登录', open: '打开',
    setupTitle: '设置密码', setupSub: '设置后用这个邮箱和密码登录。', newPassword: '新密码', confirmPassword: '再输一次', pwMismatch: '两次输入不一样', setupSave: '设置并登录', checking: '正在检查链接',
    expiredTitle: '链接已失效', expiredSub: '这个链接已经用过或已过期（有效期 24 小时）。请找管理员重新发一个。', toLogin: '去登录',
  },
  en: {
    workers: 'Workers', new: 'New', deploy: 'Deploy', deploying: 'Deploying', deployed: 'Deployed', copy: 'Copy', copied: 'Copied',
    settings: 'Settings', editor: 'Code', test: 'Test', login: 'Log in', logout: 'Log out', register: 'Sign up', email: 'Email', password: 'Password',
    loginTitle: 'Log in to funx', loginSub: 'Write a fetch handler, deploy, get a URL.', noAccount: 'No account? Sign up', haveAccount: 'Have an account? Log in',
    pwHint: 'At least 10 characters', mock: 'Sample data · this browser only', name: 'Name', url: 'URL', status: 'Status', lastDeploy: 'Last deploy',
    running: 'Running', disabled: 'Disabled', pending: 'Not live', empty: 'No workers yet.', emptyCta: 'Write the first one',
    request: 'Request', response: 'Response', send: 'Send', headers: 'Headers', body: 'Body', resHeaders: 'Response headers',
    draft: 'Current code', live: 'Live', draftHint: 'Runs the editor code in your browser, no deploy needed', liveHint: 'Calls the deployed URL',
    noResponse: 'Press Send to see the result', ms: 'ms', timeout: 'Timed out (10 s)', failed: 'Failed', notDeployed: 'Not deployed yet',
    vars: 'Variables', secrets: 'Secrets', varsHint: 'Read them in code as env.NAME.', secretsHint: 'Write-only once saved.',
    add: 'Add', save: 'Save', saved: 'Saved', remove: 'Delete', value: 'Value', keyName: 'Name',
    danger: 'Disable and delete', disable: 'Disable', enable: 'Enable', disableHint: 'The URL answers 403 until you enable it again.',
    deleteWorker: 'Delete worker', deleteHint: 'Removes URL, code, variables and secrets. Cannot be undone.', typeName: 'Type the name to confirm', typeNameBefore: 'Type', typeNameAfter: 'to confirm',
    namePh: 'worker-name', nameRule: '3–32 lowercase letters, digits or -', loginToDeploy: 'Log in to deploy', back: 'Back',
    logs: 'Logs', logsNA: 'Logs are not available yet', needLogin: 'Please log in', open: 'Open',
    setupTitle: 'Set your password', setupSub: 'Then log in with this email and password.', newPassword: 'New password', confirmPassword: 'Repeat it', pwMismatch: 'The two entries differ', setupSave: 'Set and log in', checking: 'Checking the link',
    expiredTitle: 'This link has expired', expiredSub: 'It was already used or is more than 24 hours old. Ask an admin for a new one.', toLogin: 'Log in',
  },
};

const ls = globalThis.localStorage;
let lang = (ls && ls.getItem('funx.lang')) || ((globalThis.navigator?.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en');
export const t = (k) => (dict[lang] && dict[lang][k]) || dict.zh[k] || k;
export const getLang = () => lang;
export function setLang(l) { lang = l; ls?.setItem('funx.lang', l); if (globalThis.document) document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en'; }
setLang(lang);
