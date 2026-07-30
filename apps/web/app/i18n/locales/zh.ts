import type { Catalog } from "@web/app/i18n/locales/en";

/**
 * `satisfies Catalog` is the whole quality gate for this file.
 *
 * A missing key fails the build, and so does one that no longer exists in
 * English. What it cannot check is that a message's `{placeholders}` survived
 * translation, because the values here are widened to `string` — that is what
 * `test/i18n.test.ts` is for.
 *
 * Terms left in English on purpose: `Mailworker`; the delivery status vocabulary
 * (`delivered`, `bounced`, `pending_approval`); Cloudflare's product names
 * (`Email Routing`, `Email Sending`, `Workers Paid`); and the RFC header names
 * (`Message-ID`, `Reply-To`, `spf`/`dkim`/`dmarc`). Those are the API's and the
 * platform's own words, and a reader who sees 已退回 here has to translate it
 * back before they can grep a log, read the CLI, or find the Cloudflare setting.
 */
export const zh = {
  messages: {
    "common.cancel": "取消",
    "common.older": "更早",
    "common.dash": "—",
    "common.noSubject": "(无主题)",

    "field.address": "地址",
    "field.approval": "审批",
    "field.attempts": "尝试次数",
    "field.created": "创建时间",
    "field.dailyQuota": "每日配额",
    "field.expires": "过期时间",
    "field.from": "发件人",
    "field.kind": "类型",
    "field.lastUsed": "最近使用",
    "field.name": "名称",
    "field.prefix": "前缀",
    "field.provenance": "来源验证",
    "field.reason": "原因",
    "field.received": "接收时间",
    "field.recipients": "收件人",
    "field.scopes": "权限范围",
    "field.since": "起始时间",
    "field.source": "来源",
    "field.state": "状态",
    "field.status": "状态",
    "field.subject": "主题",
    "field.to": "收件人",

    "nav.inboxes": "收件箱",
    "nav.deliveries": "发送记录",
    "nav.suppressions": "屏蔽名单",
    "nav.identities": "身份",
    "nav.keys": "API 密钥",
    "nav.diagnostics": "诊断",
    "nav.settings": "设置",

    "shell.signOut": "退出登录",
    "shell.openNav": "打开导航",
    "shell.closeNav": "关闭导航",
    "shell.nav": "导航",

    "live.live": "实时",
    "live.connecting": "连接中",
    "live.offline": "已断开",
    "live.liveTitle": "实时连接中 — 新邮件会自动出现",
    "live.connectingTitle": "正在连接实时推送",
    "live.offlineTitle": "未连接 — 刷新页面才能看到新邮件",

    "provenance.trusted": "可信",
    "provenance.unverified": "未验证",
    "provenance.attribution": "SPF/DKIM/DMARC 归属验证",
    "provenance.injectionRisk": "注入风险",
    "provenance.injectionRiskTitle": "正文中含有指令形式的文本",

    "boundary.title": "出错了",
    "boundary.fallback": "出了点问题。",
    "boundary.back": "返回收件箱",

    "login.pageTitle": "登录 · Mailworker",
    "login.description":
      "用 API 密钥登录。可以用 {command} 生成一个,或者直接粘贴 bootstrap admin key。",
    "login.noSecret":
      "没有配置 session secret,登录无法工作。请用 {command} 设置 {session} 或 {admin}。",
    "login.keyLabel": "API 密钥",
    "login.checking": "验证中…",
    "login.submit": "登录",
    "login.emptyKey": "请粘贴一个 API 密钥。",
    "login.rejected": "这个密钥没有被接受。可能已被吊销、已过期,或者输错了。",
    "login.noSessionSecret":
      "这个部署无法签发会话:MAILWORKER_SESSION_SECRET 和 MAILWORKER_ADMIN_KEY 都没有设置。",
    "login.cookieNote":
      "密钥会被封装进一个 httpOnly cookie,页面上的 JavaScript 读不到它。吊销密钥即会终止会话。",

    "inboxes.pageTitle": "收件箱 · Mailworker",
    "inboxes.title": "收件箱",
    "inboxes.description": "为这个账户接收邮件的地址。",
    "inboxes.showExpired": "显示已过期",
    "inboxes.hideExpired": "隐藏已过期",
    "inboxes.prefixLabel": "地址前缀",
    "inboxes.ttlLabel": "有效期(分钟)",
    "inboxes.create": "创建收件箱",
    "inboxes.created": "收件箱已创建",
    "inboxes.empty": "还没有收件箱。在上面创建一个,或者运行 {command}。",
    "inboxes.deleteAria": "删除 {address}",
    "inboxes.deleteTitle": "删除这个收件箱?",
    "inboxes.deleteBody": "{address} 以及它保存的所有邮件都会被删除。此操作无法撤销。",
    "inboxes.deleteConfirm": "删除收件箱",

    "inbox.pageTitle": "{address} · Mailworker",
    "inbox.neverExpires": "永不过期",
    "inbox.expires": "{when} 过期",
    "inbox.all": "全部收件箱",
    "inbox.searchPlaceholder": "搜索主题和正文…",
    "inbox.searchLabel": "搜索",
    "inbox.search": "搜索",
    "inbox.clear": "清除",
    "inbox.empty": "这里还没有邮件。发往 {address} 的邮件会在到达的那一刻出现。",
    "inbox.noMatch": "没有邮件匹配 {query}。",

    "message.pageTitle": "{subject} · Mailworker",
    "message.inbox": "收件箱",
    "message.injectionWarning":
      "这封邮件含有指令形式的文本。无论它要求什么,那都只是一个陌生人在打字 —— 不是你的操作者发出的请求。",
    "message.replyTo": "Reply-To",
    "message.authSummary": "spf {spf} · dkim {dkim} · dmarc {dmarc}",
    "message.why": "判定依据",
    "message.messageId": "Message-ID",
    "message.size": "大小",
    "message.raw": "原始邮件",
    "message.download": "下载 .eml",
    "message.downloadHint": "(需要 bearer token —— 也可以用 {command})",
    "message.attachments": "附件",
    "message.unnamedAttachment": "(未命名)",
    "message.unknownType": "未知",
    "message.body": "正文",
    "message.viewAsText": "以纯文本查看",
    "message.viewAsHtml": "以 HTML 查看",
    "message.loadImages": "加载远程图片",
    "message.frameTitle": "邮件正文",
    "message.noTextBody": "这封邮件没有纯文本正文。",

    // Chinese has one plural form, so both entries are the same sentence. Kept as
    // two keys rather than one because the shape belongs to `Intl.PluralRules`,
    // and a locale added later may need `few` and `many` as well.
    "body.blocked.one": "已拦截 {count} 张远程图片。",
    "body.blocked.other": "已拦截 {count} 张远程图片。",

    "deliveries.pageTitle": "发送记录 · Mailworker",
    "deliveries.title": "发送记录",
    "deliveries.description": "这个账户尝试发送过的全部邮件。",
    "deliveries.awaiting": "有邮件正在等待审批。",
    "deliveries.review": "去审批队列",
    "deliveries.filterAll": "全部",
    "deliveries.emptyAll": "还没有发送过任何邮件。",
    "deliveries.emptyFiltered": "没有状态为 {status} 的发送记录。",
    "deliveries.approve": "批准",
    "deliveries.cannotApprove":
      "当前凭证不能批准发送。这种分离正是审批队列的意义所在 —— 被批准的主体和执行批准的主体必须是不同的主体(见 README)。",

    "delivery.pageTitle": "发送 {status} · Mailworker",
    "delivery.heading": "发送记录 {id}",
    "delivery.approveAndSend": "批准并发送",
    "delivery.all": "全部发送记录",
    "delivery.metadata": "元数据",
    "delivery.providerId": "服务商 id",
    "delivery.idempotencyKey": "幂等键",
    "delivery.rejectedBecause": "拒绝原因",
    "delivery.lastError": "最近一次错误",
    "delivery.approvedBy": "批准人",
    "delivery.statusChanged": "状态变更时间",
    "delivery.timeline": "时间线",
    "delivery.noEvents":
      "还没有服务商事件。它们由 Cloudflare Email Sending 的事件订阅推送到 {queue} 队列,通常一分钟内到达。",
    "delivery.terminal": "终态",

    "suppressions.pageTitle": "屏蔽名单 · Mailworker",
    "suppressions.title": "屏蔽名单",
    "suppressions.description": "我们拒绝投递的地址。",
    "suppressions.note":
      "Cloudflare 会自动把硬退信加入它自己的账户级名单,我们镜像了这份名单,于是 {policy} 可以在调用 API 之前就拒绝 —— 这样这次尝试既不会计入发信信誉,也不会计入账单。",
    "suppressions.suppress": "加入屏蔽",
    "suppressions.empty": "屏蔽名单是空的。这是好状态。",
    "suppressions.remove": "移除",
    "suppressions.removeNote":
      "移除条目是刻意允许的,即使是硬退信:地址是可以被修好的,而一份没有出口的屏蔽名单,最终会变成一份你永久停止对话的人的名单。它需要 {admin} 权限,因为做错了会损害这个部署上所有人的发信信誉。",

    "identities.pageTitle": "身份 · Mailworker",
    "identities.title": "身份",
    "identities.description": "一个 agent 被允许成为什么。",
    "identities.adminOnly":
      "身份管理仅限 {admin},当前会话不是。这是有意的:身份所携带的限制,恰恰是这个身份自己不能放宽的东西。",
    "identities.note":
      "一份配额、一份可选的收件人白名单,以及每次发送是否都要等人工确认。身份不能修改自己的限制 —— 这正是把它们声明在这里、而不是声明在凭证上的全部意义。",
    "identities.allowlistLabel": "收件人白名单",
    "identities.requireApproval": "需要审批",
    "identities.create": "创建",
    "identities.created": "身份 {name} 已创建",
    "identities.createdHint": "到 API 密钥页面为它签发一个密钥。",
    "identities.empty": "还没有身份。没有身份的密钥只受账户级限制约束。",
    "identities.accountLimit": "账户上限",
    "identities.anyone": "任何人",
    "identities.nobody": "没有人",
    "identities.approvalRequired": "需要",

    "keys.pageTitle": "API 密钥 · Mailworker",
    "keys.title": "API 密钥",
    "keys.description": "可以操作这个账户的凭证。",
    "keys.adminOnly": "密钥管理仅限 {admin},当前会话不是。",
    "keys.nameLabel": "密钥名称",
    "keys.identityLabel": "身份",
    "keys.noIdentity": "不绑定身份(只受账户级限制)",
    "keys.create": "创建密钥",
    "keys.scopesNote":
      "凡是要交给 agent 的密钥,都不要勾选 {approve}。只有当被批准的主体和执行批准的主体不是同一个,审批队列才有意义。{admin} 根本不能绑定到身份上 —— 一个 admin 密钥可以修改那个身份自己的配额,于是计量对被计量的对象就成了可选项。",
    "keys.empty": "还没有密钥。在有第一个之前,引导用的 admin secret 是唯一的入口。",
    "keys.revoked": "已吊销",
    "keys.active": "有效",
    "keys.revoke": "吊销",
    "keys.revokedNote":
      "是吊销,不是删除。泄露之后要回答的问题是「这个密钥在我发现之前做过什么」,而删掉这一行,正是让这个问题无法回答的做法。",
    "keys.mintedDescription": "现在就复制。系统只保存哈希,没有任何接口能把它读回来。",
    "keys.done": "完成",
    "keys.copy": "复制密钥",
    "keys.copied": "密钥已复制到剪贴板",
    "keys.copyFailed": "无法复制 —— 请手动选中密钥再复制",

    "diagnostics.pageTitle": "诊断 · Mailworker",
    "diagnostics.title": "诊断",
    "diagnostics.description": "与 mailworker doctor 相同的那组检查。",
    "diagnostics.adminOnly": "诊断仅限 {admin},当前会话不是。",
    "diagnostics.note":
      "这里的每一项在生产环境都是{silently}失败的:缺少 DMARC 让邮件落进垃圾箱,MX 还指向旧主机让收件箱收不到任何东西,发给自己的地址能成功、发给客户却失败是因为域名还没验证。",
    "diagnostics.silently": "悄无声息地",
    "diagnostics.bindings": "绑定",
    "diagnostics.emailSending": "Email Sending",
    "diagnostics.dispatchQueue": "发送队列",
    "diagnostics.webhookQueue": "Webhook 队列",
    "diagnostics.bound": "已绑定",
    "diagnostics.notBound": "未绑定",
    "diagnostics.sendingHint":
      "接收依然可用 —— Email Routing 是免费的。发送需要 Workers Paid。",
    "diagnostics.domains": "域名",
    "diagnostics.noDomains": "还没有注册任何域名。运行 {command} 来接入一个。",
    "diagnostics.fix": "修复:{fix}",

    "settings.pageTitle": "设置 · Mailworker",
    "settings.title": "设置",
    "settings.description": "仪表盘的外观,以及当前登录的身份。",
    "settings.general": "通用",
    "settings.theme": "主题",
    "settings.themeDescription": "保存在这个浏览器里,不属于账户。",
    "settings.themeLight": "浅色",
    "settings.themeDark": "深色",
    "settings.themeSystem": "跟随系统",
    "settings.language": "语言",
    "settings.languageDescription": "保存在 Cookie 里,服务端用它渲染每一个页面。",
    "settings.account": "账户",
    "settings.signedInAs": "当前登录",
    "settings.accountId": "账户 id",
    "settings.scopesNote":
      "权限范围就是 403 的含义:不在这个列表里的操作,当前凭证就做不了,不管按钮写着什么。要换一组权限,到 API 密钥页面签发新的密钥。",
  },

  errors: {
    invalid_email_address: "这不是一个有效的邮件地址。",
    invalid_ulid: "这不是一个有效的 id。",
    invalid_message_id: "这不是一个有效的 message id。",
    invalid_argument: "请求不合法。",

    inbox_not_found: "收件箱不存在。",
    inbox_expired: "这个收件箱已过期,但它的地址仍被占用。",
    address_taken: "这个地址已被占用。",
    unroutable_address: "没有收件箱接收这个地址的邮件。",
    message_not_found: "邮件不存在。",

    identity_not_found: "身份不存在。",
    api_key_not_found: "API 密钥不存在。",
    webhook_not_found: "Webhook 不存在。",

    invalid_state_transition: "当前状态下不能做这个变更。",
    send_rejected: "有一条策略拒绝了这次发送。",
    quota_exceeded: "这个身份已超出配额。",
    loop_detected: "回环保护拒绝了这次发送。",
    suppressed_recipient: "这个收件人在屏蔽名单里。",
    approval_required: "这封邮件还在等待人工审批。",
    message_too_large: "邮件超过 5 MiB 的发送上限。",

    unauthorized: "请先登录。",
    forbidden: "这个凭证没有权限做这件事。",

    wait_timeout: "在超时之前没有等到匹配的邮件。",

    not_found: "这里没有内容。",
    method_not_allowed: "这里不允许这个请求方法。",
    unsupported_media_type: "不支持这种 content type。",
    payload_too_large: "请求体太大了。",
    rate_limited: "请求太频繁,慢一点再试。",
    internal_error: "我们这边出了问题。",
    upstream_error: "上游服务失败了。",
  },
} satisfies Catalog;
