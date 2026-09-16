# 逆向与排错笔记（NOTES）

> 这份文件是开发过程中的原始记录：WebVPN 三层的逆向过程、每一次假阳性的复盘、
> 踩过的坑。**面向公众的说明看 [README.md](../README.md)。**
> 里面的身份信息（姓名、学号、教师姓名）已替换为占位符。
>
> ⚠️ **这是过程记录，不是说明书 —— 里面有几条结论后来被实测推翻了**，已知至少这些：
>
> - 「过门必须靠浏览器跑 JS」→ **错的**，纯 HTTP 全链能走完（见 `src/gateway.js`）
> - 「资源会话要求 cookie 落在 `.webvpn.njts.edu.cn` 域上」→ **错的**，网关的 `TWFID` 跨域有效
> - 「`webvpn.njts.edu.cn` 是真门户，须钉 /etc/hosts」→ 那台公网无 A 记录，且**根本不需要用**
> - 「课表/成绩接口没抓到所以都不实现」→ 课表**已实现**（`njts schedule --http`），成绩仍未实现
>
> **以 README 和代码为准**；这里保留原文，是为了留下「当时为什么会这么想」。

---

# njts-cli

南京特殊教育师范学院（南特 / NJTS）校园命令行工具。**为 AI agent 与脚本设计**：stdout 恒为单个 JSON，退出码语义化。

> ⚠️ 只读工具。不实现缴费、选课、请假提交、挂失、门禁/阀控。这不是"还没做"，是设计边界，由 `test/safety.test.js` 用断言钉住。

## 能做什么

| 能力 | 命令 | 需要校内网 | 状态 |
|---|---|---|---|
| 一卡通余额 | `njts card balance` | ❌ | ✅ 已实现（实跑通） |
| 消费流水 | `njts card flow --days 30` | ❌ | ✅ 已实现（本账号无记录） |
| 宿舍电费（待缴项目） | `njts power list` | ❌ | ✅ 已实现（实跑通） |
| 电费趋势 | `njts power trend --days 14` | ❌ | ✅ 已实现 |
| 校园服务体检 | `njts status` | — | ✅ 已实现 |
| 课表 / 成绩 | `njts schedule` | ✅ | 🚧 未实现，走通 `vpn browser-login` 之后才能做（见下） |
| 请假审批进度 | `njts leave status` | ✅ | 🚧 实现完成但**本机不可达** |
| 浏览器补会话 | `njts vpn browser-login` | ✅ | 🆕 让真浏览器去跑门户的 JS（见「WebVPN 资源访问的边界」） |

### ⛔ 为什么课表/成绩/请假在本机永远取不到

它们要校内网络，唯一入口是 WebVPN；而**本机出口 IP 在境外**：

```
$ curl -s ipinfo.io/json
{ "ip": "5.175.245.64", "country": "DE", "city": "Niederzier",
  "org": "AS213850 Justin Harth" }
```

深信服网关的**登录策略拒绝境外 IP**，返回 `ErrorCode 20048: It fails to comply with the
login policy`。用户在国内用浏览器能正常登入，所以**账号没问题、密码也对**，是网络位置被拒。

已经排除的：客户端类型（zju-connect 隧道版与自实现网页版都给 20048）、UA、
`type=cs` 参数、`mitm`/`mitm_result` 字段名、RSA 密文长度（已验证 2048 位→512 hex 正确）。
**协议是对的，但登录策略在前一步就把请求拦了。**

不作的事：用国内代理伪装来源以绕开该策略——那是规避学校的访问控制。

`src/vpn.js` 的实现是完整的，将来在**一台国内设备**上跑 `njts vpn login` 即可直接用。

## 安装

```bash
node --version   # 需要 ≥ 18
cd njts-cli
node bin/njts.js help          # 直接跑
npm link                       # 或全局注册 njts 命令
```

零第三方运行时依赖（无 `dependencies`）。DES 是自己实现的——Node 24 因 OpenSSL 3 已禁用单 DES，见 `src/des.js` 顶部注释；WebSocket 客户端也是自己写的，理由见 `src/ws.js`。

## 快速开始

```bash
njts status                                      # 先体检：网络 / 登录态是否 OK
njts card login                                  # 学号 + 一卡通密码（与统一身份认证密码不同！）
njts card balance
njts power list                                  # 宿舍电费
njts login                                       # 统一身份认证（用于请假）
njts leave status
njts leave draft "周三下午发烧去医院，想请一天"     # 只出草稿，不提交
njts skill install                               # 把 SKILL.md 装进 pi
```

## 两套凭据是分开的

学校的一卡通没有跟统一身份认证打通，所以：

| 文件 | 用途 | 密码 |
|---|---|---|
| `~/.njts-cli/credentials.json`（0600） | 课表 / 成绩 / 请假 | 统一身份认证密码 |
| `~/.njts-cli/card-credentials.json`（0600） | 一卡通余额 / 电费 | **一卡通单独密码** |

一卡通密码失效不会连累其他功能。

## 输出契约

```jsonc
// 成功
{"ok": true, "data": { ... }}

// 失败
{"ok": false, "error": {"kind": "unauthenticated", "message": "...", "hint": "..."}}
```

| kind | exit | 含义 | agent 该做什么 |
|---|---|---|---|
| `unauthenticated` | 2 | 会话失效 | 让用户重新登录 |
| `login` | 3 | 登录失败（密码错/锁号） | **不重试**，让用户核对凭据 |
| `network` | 4 | 不可达 / 未连校内网 | 提示连校园网；**别无脑建议连 VPN**，本机上 VPN 也登不上（境外 IP 被拒） |
| `service` | 5 | 上游异常或页面改版 | 上报，不要编数据 |
| `input` | 6 | 参数错误 | 修正参数 |
| `unsupported` | 7 | 未实现或被安全策略禁用 | 直接说明不支持 |

## 学校系统的几个坑（已实测）

1. **ehall 只有 http**（`http://ehall.njts.edu.cn`）。浏览器 HTTPS-First 会先试 https，学校网关回一个 502 页面——Chrome 只在连接失败时才回退，看到 502 就以为"站点活着只是坏了"，永远试不到 http。本工具会把这个页面翻译成"请加 http://"。
2. **教务（jwxt）校外需要校内网络，而本机拿不到。** 公网直连固定 403；WebVPN 也进不去
   （出口 IP 在境外，网关登录策略拒绝，`20048`）。一卡通与 CAS 不需要，所以**这两条线完全正常**。
3. **网关 502 不能当权限问题**，见第 1 条。
4. **VPN 登录不要反复重试**——失败的尝试会被计数：IP 级风控（`ErrorCode 20041` / 握手响应
   `RndImg=1`）以及可能的账号级锁定。要查状态用 `njts vpn check`：它只做握手、**不提交凭据**，
   可以反复跑。`vpn login` 在 `RndImg=1` 时会拒绝提交，不会把情况弄得更糟。

## 开发

```bash
npm test                       # 90 个用例
node --test "test/*.test.js"   # 同上
NJTS_DEBUG=1 njts card balance # 打印请求细节
```

测试里有几个值得注意的：

- `test/des.test.js` —— DES/3DES 的固化参照向量，其中单 DES 那条是**公开的标准测试向量**，用来确认参照本身可信
- `test/rsa.test.js` —— CAS 的无填充裸 RSA：用本地生成的密钥对做**真实加解密往返**，并断言真实模数下密文恰好 256 字符（长度不对就说明 `chunkSize` 推导错了）
- `test/card.test.js` —— 锁住签名规则（**先签名再编码**、Md5Key 前有**尾竖线**、`ContentType` 不参与签名）
- **差分测试** —— `test/vendor/crypto-js.min.js` 是官方 CryptoJS 4.2.0 的副本，**仅用于测试**（不进入运行时依赖）。测试用它把前端那套流水线复刻一遍，再和本项目的实现逐字节对比。这是最有价值的一条：它验证的不是“我算得对不对”，而是“我是否和真正的客户端行为一致”
- `test/safety.test.js` —— 断言源码里不存在任何写接口调用
- `test/ws.test.js` —— WebSocket 帧编解码，拿 **RFC 6455 官方向量**逐字节比对（不拿自己的编码喂自己的解码：那样两边同时错、还能互补通过）
- `test/chromium.test.js` —— 对着一个**自建的假 CDP 服务器**跑完整链路（真握手、真帧、真 JSON-RPC）。真 Chrome 在 CI 里往往起不来（本机实测 seccomp 直接拦 AF_UNIX，Chrome 建不了 process singleton 就 abort），所以链路里属于"我们这边"的部分全部用假服务器验完。90 个用例。

## 协议来源

- 一卡通：浙江正元智慧「易通 easytong」v5.1.21.1031，**从 H5 前端 JS 源码逐行逆出**：`static/js/app.*.js` 的 axios 请求拦截器（签名/编码）、登录页 chunk（登录字段与 3DES 密钥）、`static/config.js`（常量）。未做任何爆破
- 请假：金智 WeCMP 官方 API 文档（`/wec-apis/leave/stu/query`）
- 统一身份认证：Apereo CAS + 苏迪主题；密码用 RSA 加密，公钥指数 `010001`、模数写在 `/cas/themes/sudy_njts/js/login.js` 里（源码硬编码，非动态下发）

## License

MIT

---

## WebVPN 资源访问的边界（2026-09-15 实测结论）

**结论先说：CLI 能登录 WebVPN 并拿到门户会话，但拿不到"资源会话"，所以课表 / 成绩走不通。最后一步只能由浏览器执行 JavaScript 完成。**

### 已经打通的

| 环节 | 状态 | 依据 |
|---|---|---|
| 真正的门户主机 | ✅ `https://webvpn.njts.edu.cn/portal/` | 深信服 SSL VPN 登录页；`vpn.njts.edu.cn` 是**另一个**门户，对本账号返回 20048「No virtual portal access」 |
| 网关真实 IP | ✅ `222.192.176.8` | 公网 DNS **无 A 记录**，必须钉解析（见下） |
| 网关 CAS 登录 | ✅ `njts vpn login` | `http://auth-njts-edu-cn-s.webvpn.njts.edu.cn:8118/cas/login?service=…vpn.njts.edu.cn/auth/cas_validate%3Fentry_id%3D1` |
| 门户 API（`/por/*`） | ✅ | `login_auth.csp`、`rclist.csp`（34KB 完整资源清单）、`conf.csp` 全部 200 |

### 拿不到的

访问任何资源主机（`xxx-njts-edu-cn-s.webvpn.njts.edu.cn:8118`）都会返回网关的**「请先登录」页**。它有两种形态，**都不代表成功**：

1. `302` → `https://webvpn.njts.edu.cn:443?redirect_uri=…`
2. **`200` + JS 跳转** → `https://webvpn.njts.edu.cn/portal?redirect_uri=…`
   ```js
   g_lines = [{url:"https://webvpn.njts.edu.cn/portal?redirect_uri=<原地址>",right:0}];
   gotoLines();
   ```
   ⚠️ 第二种会让只看状态码的实现**报出假 200**。`gate()` 现在会识别它（`GATE_LOGIN_PAGE`）并跟着跳一次，跳完仍是它，就如实抛 `unauthenticated`。

### 缺的那一块

访问资源需要网关**自己**的会话 cookie，落在 `.webvpn.njts.edu.cn` 域上：

```
TWFID（21 字符）  sudy_log_token（43 字符）  JSESSIONID  language
```

而 CAS 登录只把 `TWFID` 以 **host-only** 形式下在 `vpn.njts.edu.cn` 上（浏览器里能看到，实测抓链）：

```
① https://vpn.njts.edu.cn/auth/cas_validate?…       302   setCookie: TWFID(host-only)
② https://vpn.njts.edu.cn/portal/?data=…            200   setCookie: (无)
       #!/thirdparty_auth_judgment
```

**`vpn.njts.edu.cn` 的 host-only cookie 发不到 `jwxt-njts-edu-cn-s.webvpn.njts.edu.cn`。** 门户 SPA 随后会调用公开的只读初始化接口 `/por/login_auth.csp`，并在拿到 TWFID 后调用 `/por/update_session.csp`。CLI 现在会按这条已确认的 HTTP 链尝试同步，并在 `portal.sync` 中只报告状态码、错误和 cookie 名称；它仍不执行 JavaScript，也不输出任何 token/cookie 值。若该交换仍不能落下 `.webvpn.njts.edu.cn` 域 cookie，就如实保留 `unauthenticated`，不再猜测其它端点。

已试过并**失败**的补法（都会回来同样两枚 CAS 应用 cookie）：

```
http://vpn-njts-edu-cn-s.webvpn.njts.edu.cn:8118/portal/
http://webvpn-njts-edu-cn-s.webvpn.njts.edu.cn:8118/portal/
https://webvpn.njts.edu.cn/portal/
```

### 要跑 CLI 的话，先钉这一行

`webvpn.njts.edu.cn` **公网没有 A 记录**（2026-09-16 用公共 DoH 查证：Answer 为空，只有 SOA；
也会被 fake-ip 类代理污染成 `198.18.0.x`）：

```bash
echo "222.192.176.8 webvpn.njts.edu.cn" | sudo tee -a /etc/hosts
```

**但只需要钉这一个。** `*-s.webvpn.njts.edu.cn` 那一族是**有**公网 A 记录的，全都指向
`222.192.176.8`（同时也是 `vpn.njts.edu.cn` 的地址），不需要钉：

| 主机 | 公网 A 记录 |
|---|---|
| `vpn.njts.edu.cn` | ✅ `222.192.176.8` |
| `auth-njts-edu-cn-s.webvpn.njts.edu.cn` | ✅ `222.192.176.8` |
| `jwxt-njts-edu-cn-s.webvpn.njts.edu.cn` | ✅ `222.192.176.8` |
| `webvpn.njts.edu.cn` | ❌ 无（只有 SOA）—— 必须钉 |

`njts vpn browser-status` 会把这四个主机逐个查一遍并直接告诉你缺哪个，
不用自己猜“是没权限还是域名没解析”。

### CLI 侧拿不到的那一块，改由真浏览器补：`njts vpn browser-login`

既然缺的是**门户 SPA 的那段 JavaScript**，那就别再拿 HTTP 去模拟它 —— 让真正的浏览器去跑。

```bash
njts vpn browser-status              # 只探测：找没找到浏览器、调试端口通不通（可反复跑）
njts vpn browser-login               # 独立 profile 启一个 headless Chrome，把门户 JS 跑完
njts vpn browser-login --gui         # 开真窗口，**密码由你自己在浏览器里敲**，CLI 不接触凭据
njts vpn browser-peek                # 另开一个终端，看浏览器现在停在哪一页（只读）
njts vpn browser-close               # 关掉本工具启动的那个浏览器
njts vpn browser-close --purge       # 连 profile 一起删（下次要重新登录）
```

整份报告除了打到 stdout，**还会写到 `~/.njts-cli/last-browser-login.json`（0600）** ——
成功失败都写，所以下次追问“到底卡在哪一步”时不用重跑。想换路径用 `--out FILE`。
失败时错误 hint 会直接把那个路径告诉你。文件里没有密码、cookie 值和票据。

#### 登录入口：只有 CAS 那条路能走（2026-09-16 用户实测）

| 入口 | 结果 |
|---|---|
| `webvpn.njts.edu.cn` 门户的「账号登录」框 | ❌ 红字 **「用户不符合登录策略，禁止登录」**（就是 20048） |
| `auth-…-s.webvpn.njts.edu.cn:8118/cas/login?service=…`（**默认**） | ✅ 能登，票据 `ST-…` 会发出来 |

两个主机的分工（之前混在一起了）：

```
vpn.njts.edu.cn        ← CAS / 门户流程在这里（/auth/cas_validate、/portal/）
*.webvpn.njts.edu.cn   ← 资源代理在这里（网关会话 cookie 也落在它的域上）
```

#### 那段裸 XML **不是终点**

CAS 登完，浏览器会停在 `vpn.njts.edu.cn/auth/cas_validate?…&ticket=ST-…` 上，
看到的是**没样式的裸 XML**：

```xml
<ErrorCode>20021</ErrorCode><Result>1</Result>
<Message><![CDATA[ user had logged in ]]></Message>
```

⚠️ 早先版本把它当成致命错误直接报错了——**那是错的**。票据既然发出来了，
网关很可能已经把会话 cookie 下下来了，只是没给你跳转。所以现在：
把 `ErrorCode` / `Message` 记进报告的 `login.gatewayValidation`，
**然后主动继续**去门户（`vpn.njts.edu.cn/portal/`）再走一趟资源主机（jwxt）。
`--gui` 等待循环里也是这么干的。看 `steps` 里 `after-cas-xml:*` 那几步就知道走到哪了。

`classifyPage` 会把这段 XML 认成 `gate-cas-validate` 并把错误码抠出来放进 `reason`。

它做的事：驱动浏览器走完 `网关 CAS → 门户 SPA → 资源主机`，然后**只报告事实**：
每一步的 URL / 标题 / 页面类型、表单**字段名**、cookie 的**名字和域**、脱敏后的请求行。
结论只有一个判据：`.webvpn.njts.edu.cn` 域上到底有没有 `TWFID` / `sudy_log_token`。

#### 需要装什么

只需一个 Chrome 或 Chromium 本体。**不需要** Playwright / Puppeteer / chromedriver / Selenium，
也不需要任何 npm 依赖 —— CDP 是直接用自带代码说的（`src/ws.js` 是一个只够用的 WebSocket 客户端，
因为 Node 的全局 `WebSocket` 是 v21 才有的，而本包声明支持 >= 18）。

装了但不在默认位置（或想用 Edge / Brave）时：

```bash
NJTS_CHROMIUM="/Applications/Chromium.app/Contents/MacOS/Chromium" njts vpn browser-login
```

#### 边界（写进代码，不只是写在这里）

- 调试端口**只绑 127.0.0.1**；报告里永远不出现调试入口地址（那等于本机浏览器的完全控制权）。
- **独立 profile**（`~/.njts-cli/chromium-profile`，0700），不碰你日常浏览器的配置和 cookie。
- 参数表里**没有** `--no-sandbox`、`--disable-web-security`、`--ignore-certificate-errors`。
  少一个沙盒或关一次 TLS 校验都不行；`test/chromium.test.js` 把这条钉成了断言。
- cookie **只报名字和域**，值一律剥掉（连截断的都不给）。报告里也不会出现密码和 CAS 票据。
- 密码走浏览器自己的输入管线（`Input.insertText`），**不拼进任何被求值的 JS 源码**；
  提交靠**点按钮**（苏迪主题在提交时用 JS 做 RSA 加密，`form.submit()` 会绕过它，等于发明文）。
- 登录失败**不自动重试**；`--gui` 模式下密码完全不经过 CLI。
- 浏览器会话**不会**被导回纯 HTTP 那条路 —— 不搬运 cookie 值，那是"移植会话"。

#### 三层门，一层比一层里面的（2026-09-16 实测）

| 层 | 是什么 | 状态 |
|---|---|---|
| 1 | 校园网 / WebVPN | ✅ 已通（`vpn browser-login --gui`） |
| 2 | **正方自己的登录页** | ⏳ `jwxt open` 会在窗口里等你登 |
| 3 | 课表 / 成绩的数据接口 | 🚧 还没抓到，故意不猜 |

第 2 层是**第三套凭据**：跟统一身份认证、一卡通都不是一回事。
实测落点是 `/jwglxt/xtgl/login_slogin.html`，页面原文写着「初始密码均为证件号码后六位」，
标题「教学管理信息服务平台」，版本 **V-9.0**。

`njts jwxt open` 撞上它会**在窗口里等你登完**（默认 4 分钟，心跳会打出来），
判据只是**离开登录页**——不看表单内容、不碰你的教务密码。
不想等就加 `--no-wait`。

网关会把 `xxx-njts-edu-cn-s.webvpn…` **重写**成不带 `-s` 的形式
（实测正方登录页落在 `jwxt-njts-edu-cn.webvpn.njts.edu.cn:8118`），所以查 cookie 两种形状都要问。

#### 只有一个链接、零 XHR 的怪页面 = 地址拼错了

`jwxt open` 一度直接拼 `http://jwxt.njts.edu.cn/jwglxt/`（**原始域名**），
结果浏览器被丢到一个标题是学校名、菜单只有一个 `VPN` 链接、页面零 XHR 的怪页面上。
校外访问教务**必须走网关改写后的主机**，所以现在统一用 `gateUrl()` 算，不手写。
（同一类现象以后可以一句话认出来：**看着像目标页、但零 XHR** → 先怀疑地址没经过网关。）

### 没被验证过的东西，不要当成能用的

- `njts schedule` / `njts grades` / `njts week` —— **未实现**。正方教务的接口一次都没抓到，故意的。
- 上面 `browser-login` 这条链路里的**浏览器行为**没在本机验证过：本仓库的开发环境是个 seccomp 容器，
  Chrome 在里面连 `socket()` 都调不了（错误原文见 `~/.njts-cli/chromium-launch.log`）。
  属于"我们这边"的部分（握手、帧、分片、JSON-RPC、session 路由、脱敏）由 `test/chromium.test.js`
  对着自建的假 CDP 服务器全部验过；属于 Chrome 自己的那一段，要在真机器上跑一次 `vpn browser-status --launch` 才算数。
- `data/njts-terms.json` 是空的（校历、节次时间表都没拿到），所以 ICS 导出这条线是空的。

## 拿课表：cookie 移植（**首选**）

```bash
node bin/njts.js vpn browser-login --gui   # 浏览器只用来把门打开
node bin/njts.js schedule --http           # 取数走纯 HTTP
```

**浏览器负责它擅长的**（跑 JS、过跳转、建网关会话），**取数交给纯 HTTP**。

深信服 WebVPN 的登录态就是一组 cookie（`TWFID` / `sudy_log_token` /
`JSESSIONID` / `route`），落在 `.webvpn.njts.edu.cn` 及其子域上。用 CDP 的
`Storage.getCookies` 把它们原样读出来（**不需要挂到任何标签页上**），装进我们
自己的 CookieJar，再按网关规则拼业务地址（`gateUrl()`）、带上同样的 UA/Referer
发一次普通请求 —— 网关看到的就是"同一个已登录的浏览器"。

然后课表数据用**页面自己写的**那个接口拿：正方 V-9.0 的课表页 jqGrid 写着
`url: "xskbcx_cxXsKb.html?gnmkdm=N253508"`，POST 学年学期（`xnm`/`xqm`，
页面里的 `<select>` 自带当前值）就返回 `kbList`。当前学年学期是从页面解出来的，
不是我猜的。

### 这条路的边界（别再往里撞）

- **登录那一步仍然需要浏览器**：网关自身的 cookie 是门户 SPA 用 JS 下发的，
  纯 HTTP 复现不出来。
- 网关会话是**会话级** cookie，浏览器重启/超时后失效 → 重跑
  `vpn browser-login --gui`（不必重登 CAS）。
- `--http` 全程只读：没有写操作，也没有模拟点击、没有导航、不做浏览器级挂载。
  判定成功看**正文特征**，不看状态码。

### 我在这条路上交的学费

我为了让 CLI「扮演用户去点菜单」试了五六轮（CDP 模拟点击、隔离 world、主 world
重试、按页面参数替它导航……），全失败，还因为做了**浏览器级** `Target.setAutoAttach`
把用户自己正在用的页面卡死过一次。教训写在 `src/transplant.js` 开头。

`schedule --capture`（你在浏览器里点、我在旁边抓）保留着，作为**对方机制不明时的
兜底**：它只挂 `*.webvpn.njts.edu.cn` 上的页面，你自己在用的页面一律不碰。

### 网关的「请先登录」选路页（2026-09-16 实测）

`*.webvpn.njts.edu.cn` 上没有网关会话 cookie 时，深信服网关对**每一个**资源请求
都返回同一个 2100 行的选路页，**并在页面里写明去哪儿登录**：

```js
g_lines = [{src:"",url:"https://webvpn.njts.edu.cn/portal?redirect_uri=<你本来要去的地址>"}];
gotoLines();        //  →  window.location.href = url;
```

同一页里还有一条**被注释掉的**备选 `.../por/login_psw.csp?redirect_uri=...`
（账号密码登录；本账号在这条路上报 20048）。解析时要**先剥注释**再取生效的那条，
否则会取到注释里那条（已写成测试）。

识别标记是 `sf_ssl_ms_`（页面自己带的）。

**这不是故障，是一个状态**：`extractGatewayLogin()` 认出它 → 判定为
`gateway-login-required`，直接告诉用户去哪儿登录，不再让人肉读 7KB 正文。

顺带两条 cookie 事实：
- `TWFID` 是 **host-only 下在 `vpn.njts.edu.cn`** 上的，按 cookie 规范本来就不会
  发给 `*.webvpn.njts.edu.cn` —— 它不是"缺的那一个"。
- 网关会话要看的是 `.webvpn.njts.edu.cn` 上有没有网关自己下发的 cookie；
  只有 `CASTGC_-_auth.njts.edu.cn` / `SESSION_-_auth.njts.edu.cn` 时说明
  **CAS 登录了但网关会话没建起来**。

## 主力：Chromium（2026-09-16 定案）

```bash
node bin/njts.js vpn browser-login --gui     # 建立网关会话（会话级 cookie，失效就重跑）
node bin/njts.js schedule --auto [--pdf]     # 浏览器跑完全程
```

**为什么浏览器是主力**：这条链上每一关都是 JS 造的 —— 网关的选路、CAS 的跳转、
门户到教务的**免密 SSO** …… 纯 HTTP 复现不出来。已经实测卡在
"门户 → 教务"那一跳：网关会话建好了、教务入口也找到了，但跟着进去
仍然是正方自己的登录页（19621 字节，标题「教学管理信息服务平台」）。

| 命令 | 机制 | 状态 |
|---|---|---|
| `schedule --auto` | 浏览器：门户 → 点「教务系统」→ 直接导航课表页 | **主力** |
| `schedule --http` | 浏览器只登录取 cookie，取数走纯 HTTP | 卡在 SSO 那一跳，留作对照 |
| `schedule --capture` | 你在浏览器里点，我在旁边抓真实 XHR | 兜底（对方机制不明时用） |

我用无效实验骗过自己一次，记在这儿：我此前说「直接敲业务页地址会被弹回首页」，
**那是在正方根本没登录的时候测的** —— 那时候当然会被弹回去。
拿它当"实测"挡了好几轮。教训：**记录实测结论时，必须连当时的条件一起记。**

### 门户 → 教务的真实链路（2026-09-16 实测，全部来自页面/接口自述）

学校门户登录后，页面自己的接口给出 SSO 入口 —— **不是我们拼的地址**：

```
GET /mobile/openModule.do?...&appName=<教务 appName>-pc&sf_request_type=ajax
 → {"result":"1","reason":"","data":"http://jwxt.njts.edu.cn/sso/Sudylogin"}
```

门户首页能读到本人身份（`/ _web/portal/api/user/loginInfo.rst`）：

```
{"userId":100000000,"loginName":"00000000","userName":"某同学",
 "userDept":"某某某某学院","userStrategy":"students,anonymous"}
```

走完门户 → 教务之后，**确实落在正方首页**（`index_initMenu.html?jsdm=xs&_t=...&echarts=1`），
正文是「退出 功能菜单 我的应用 某同学 学生 某某某某学院 智能0000」。

**但直接导航课表页会被弹回 index_initMenu** —— 这次是在**已登录状态下**测的，
所以「业务页必须由正方自己的上下文打开」是成立的（此前那句是在没登录时测的，
结论对但依据是错的，属于侥幸）。正方首页的菜单是 `window.open` 开**新标签页**。
