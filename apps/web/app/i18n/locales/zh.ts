import type { Catalog } from "@web/app/i18n/locales/en";

/**
 * `satisfies Catalog` is the whole quality gate for this file.
 *
 * A missing key fails the build, and so does one that no longer exists in
 * English. What it cannot check is that a message's `{placeholders}` survived
 * translation, because the values here are widened to `string` — that is what
 * `test/i18n.test.ts` is for.
 *
 * Terms left in English on purpose: `Mailworker`, and the delivery status
 * vocabulary (`delivered`, `bounced`, `pending_approval`). Those are the API's
 * own words, and a reader who sees 已退回 here has to translate it back before
 * they can grep a log or read the CLI.
 */
export const zh = {
  messages: {
    "common.cancel": "取消",
    "common.older": "更早",
    "common.dash": "—",

    "nav.inboxes": "收件箱",
    "nav.deliveries": "发送记录",
    "nav.suppressions": "屏蔽名单",
    "nav.identities": "身份",
    "nav.keys": "API 密钥",
    "nav.diagnostics": "诊断",

    "shell.signOut": "退出登录",
    "shell.openNav": "打开导航",
    "shell.closeNav": "关闭导航",
    "shell.nav": "导航",
    "shell.themeToLight": "切换到浅色主题",
    "shell.themeToDark": "切换到深色主题",
    "shell.language": "语言",
    "shell.languageSwitch": "切换语言",

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
    "inboxes.kindLabel": "类型",
    "inboxes.ttlLabel": "有效期(分钟)",
    "inboxes.create": "创建收件箱",
    "inboxes.created": "收件箱已创建",
    "inboxes.empty": "还没有收件箱。在上面创建一个,或者运行 {command}。",
    "inboxes.colAddress": "地址",
    "inboxes.colKind": "类型",
    "inboxes.colExpires": "过期时间",
    "inboxes.colCreated": "创建时间",
    "inboxes.deleteAria": "删除 {address}",
    "inboxes.deleteTitle": "删除这个收件箱?",
    "inboxes.deleteBody": "{address} 以及它保存的所有邮件都会被删除。此操作无法撤销。",
    "inboxes.deleteConfirm": "删除收件箱",
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
