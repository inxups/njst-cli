# njts-cli

写完发现自己信息已经被AI读完了，哎，跑路了，vpn，读取页面信息全部打通，后继者应该轻松很多...

南京特殊教育师范学院（NJTS）校园服务命令行工具，附一个 pi / Claude 风格的 skill 描述。

**只读。** 不实现任何写操作 —— 不缴费、不选课、不提交请假、不报修、不挂失。

```
njts schedule --http        # 我这学期课表
njts card balance           # 一卡通余额
njts power balance          # 宿舍电费
njts leave status           # 请假审批进度
```

```jsonc
// 2026-2027 学年第 1 学期
星期一
  3-5节   线性代数A           D310   教师甲    4-9周
  6-7节   思想道德与法治        D211   教师乙    4-13周
  8-10节  数字电路与逻辑设计     D213   教师戊    4-5周
  11-14节 军事理论            D204   教师庚    9-13周
…共 29 条
```

---

## 目录

- [能做什么 / 不能做什么](#能做什么--不能做什么)
- [安装](#安装)
- [用法](#用法)
- [它是怎么工作的](#它是怎么工作的)
- [隐私与安全](#隐私与安全)
- [已知限制](#已知限制)
- [开发](#开发)
- [免责声明](#免责声明)

---

## 能做什么 / 不能做什么

| 命令 | 作用 | 状态 |
|---|---|---|
| `card balance` / `card flow` | 一卡通余额、消费流水 | 可用 |
| `power list` / `power balance` / `power trend` | 宿舍电费余额与趋势 | 可用 |
| `leave status` | 请假审批进度（逐条的实际审批节点） | 可用 |
| `leave draft` | 请假草稿预览 | 可用（不提交） |
| `schedule --http` | **课表**（纯 HTTP，推荐） | 可用 |
| `whoami` / `status` | 统一身份认证会话、体检 | 可用 |
| `vpn login --via-cas` / `vpn status` | WebVPN 网关会话 | 可用 |
| `leave submit` | 提交请假 | **不实现** |
| `power topup` / `card pay` | 缴费、充值 | **不实现** |
| 选课、报修、挂失、阀控 | — | **不实现** |
| `grades` / `week` | 成绩、周次 | **未实现**（没抓到接口就不猜） |

写操作不是"还没做"，是**刻意不做**，并且有测试钉死（`test/safety.test.js` 断言源码里
不出现任何写接口）。

---

## 安装

要求 **Node.js ≥ 20**。**零第三方运行时依赖。**

> 为什么不是 18：代码用了 `Headers.getSetCookie()`（Node 19.7 起）。而每一处调用都带
> `?.` 守卫 —— 在 Node 18 上**不会报错**，只会静默收不到任何 cookie，表现成
> 「莫名其妙一直未登录」。所以工具对版本做**硬检查**：低于 20 直接拒绝启动并说明
> 原因（退出码 `7`），宁可坏得响亮。

```bash
unzip njts-cli.zip
cd njts-cli
node bin/njts.js --help
```

想全局用就把 `bin/njts.js` 软链到 `PATH` 里：

```bash
ln -s "$PWD/bin/njts.js" /usr/local/bin/njts
```

装进 pi：

```bash
node bin/njts.js skill install
```

### 环境变量

> **代理是自动的。** Node 的内置 `fetch` 默认**不读** `HTTP_PROXY` / `HTTPS_PROXY`
> —— 这点和 curl 不同，很容易误判成「网络不通」。而开关 `NODE_USE_ENV_PROXY` 只在
> 进程启动时生效，所以在代码里改无效。工具检测到有代理变量时，会**把自己重新拉起一次**
> 并带上这个开关，不需要你手动设。想强制直连就设 `NJTS_NO_PROXY=1`。

| 变量 | 作用 |
|---|---|
| `NJTS_HOME` | 配置与会话目录，默认 `~/.njts-cli`。放在别处（如容器里的可写目录）时用 |
| `NJTS_USER` / `NJTS_PASS` | 非交互环境下的凭据（可选，见「隐私」） |
| `NJTS_NO_PROXY=1` | 强制直连（有代理时工具默认自动走，见下） |

---

## 用法

### 登录

```bash
njts login            # 统一身份认证（RSA 模式），密码本地算，不落盘
njts vpn login --via-cas   # 用 CAS 票据换 WebVPN 网关会话
njts status           # 体检
```

一卡通用的是**另一套凭据**（学号 + 一卡通单独密码，不是统一身份认证密码）：

```bash
njts card login
```

### 课表

```bash
njts schedule --http                 # 纯 HTTP 全链，不需要浏览器（推荐）
```

`--http` 全链都是普通 HTTP 请求，**不启动浏览器、不依赖 JS**。

所有命令的 **stdout 恒为单个 JSON**（人看的摘要走 stderr），所以直接
`njts schedule --http | jq .data.courses` 就行。退出码是契约：
`2` 未登录 / `3` 登录失败 / `4` 网络 / `5` 服务端 / `6` 参数 / `7` 不支持。

### 一卡通 / 电费 / 请假

```bash
njts card balance
njts card flow --days 30
njts power list
njts power balance --room <房间号>
njts leave status
```

---

## 它是怎么工作的

### 三层门

从校外到教务数据，中间隔了三层：

```
① 统一身份认证 (CAS)      auth.njts.edu.cn        —— 公网可达
② WebVPN 网关             vpn.njts.edu.cn         —— 公网可达，发 TWFID 会话
③ 教务资源主机            jwxt-…-s.webvpn.njts.edu.cn:8118
                          门户 portal-…-s.webvpn.njts.edu.cn:8118
```

### 那一跳（最绕的一段）

校外的教务只在网关后面，而"门户 → 教务"的免密登录是**门户自己发起的**。
完整链（`src/gateway.js`）：

```
CAS 会话（公网 auth.njts.edu.cn）
  → 用 CAS 票据换网关会话 TWFID
  → 门户 portal-…-s:8118 走 CAS 票据链 → 200 主门户
  → GET /mobile/openModule.do?appName=<教务 appId>-pc
      → {"result":"1","data":"http://jwxt.njts.edu.cn/sso/Sudylogin"}
  → 把那个地址的 host 改写成网关主机（校外只有它能到）
  → 跟跳：CAS 票据 → /sso/Sudylogin → /jwglxt/ticketlogin?uid=… → 正方会话建立
  → POST /jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N253508 → 课表 JSON
```

两个反直觉的点，都是实测撞出来的：

1. **网关的 `TWFID` 是跨域有效的。** 直接发给资源主机就放行，
   不需要把 cookie 种在 `.webvpn.njts.edu.cn` 域上 —— 浏览器里那个域有 cookie，
   只是因为浏览器访问过那个域名。
2. **`webvpn.njts.edu.cn` 根本不需要。** 它的公网没有 A 记录（很多教程让你改 hosts），
   但 `vpn.njts.edu.cn` 是**同一台设备**，`https://vpn.njts.edu.cn/?redirect_uri=<目标>`
   照样返回选路页。

### 字段来源

课表数据的字段名**全部来自接口原文**，没有一个是猜的：

```
kcmc 课程名 / xm 教师 / xqj+ xqjmc 星期 / jcs 节次 / zcd 周次
cdmc 教室 / cdbh 教室全名 / lh 楼 / xqmc 校区
xf 学分 / zxs 总学时 / zhxs 周学时
jxb_id + jxbmc 教学班 / jxbzc 教学班组成 / kch 课程号
kclbmc 类别 / kcxz 性质 / khfsmc 考核方式 / xslxbj 标记
```

学年学期是从课表页**自己的下拉框**里读的（`<option value="2026" selected="selected">`），
不是写死的常量；读不到就报"没有证据"然后停手，不会发一个编出来的参数。

同样的原则贯穿整个项目：**接口名只能来自页面源码，参数只能来自页面控件，
表名自己找，字段名对不上就交真实字段清单。** 没有证据就不发请求。

---

## 隐私与安全

### 凭据

- 会话与凭据文件权限 **0600**，目录 **0700**。
- 密码不经过命令行参数、不进 shell 历史、不进日志。
- **统一身份认证密码默认不落盘** —— CAS 会话（TGT）过期后需要重新登录。
  一卡通的密码按协议需要本地加密存储（`card-credentials.json`，0600）。
- 在 agent 环境里可以用 skill 提供的弹窗让用户亲自输入密码，密码不进入模型上下文。

### 日志与诊断

- cookie **只报名字和域，不报值**。
- CAS ticket 自动脱敏成 `ticket=<脱敏>`，URL 里的敏感参数同样处理。
- 诊断报告不含调试入口地址。

### 测试样本

`test/fixtures/` 里的样本来自真实响应，但**姓名、学号、教师姓名已替换为占位符**，
其余字段一个字节没动。详见 [`test/fixtures/README.md`](test/fixtures/README.md)。

### 不会做的事

- 不关闭 TLS 校验，不绕过访问控制。
- 不伪造审批事由，不代替用户做任何决定。
- 只操作用户本人账号，不访问他人数据。
- 不对真实账号盲目重试登录（失败的登录尝试会被计数）。

---

## 已知限制

- **只对 NJTS 有效。** 网关地址、appId、接口路径都是这所学校的实测结果，
  换学校要重新逆向。
- **CAS 的 TGT 只有 2–3 小时**，过期后需要重新登录。
- **`njts status` 现在只看会话文件在不在**，文件在但票据已过期时仍会报 ok ——
  这是已知的假阳性，别拿它当"会话有效"的证据。*（待修）*
- 配置目录不可写时要设 `NJTS_HOME` 到可写目录 —— **这项还是手设的**。*（待修）*
- 成绩、周次未实现：**没抓到接口，就不猜。**

排错过程与每一次假阳性的复盘见 [`docs/NOTES.md`](docs/NOTES.md)。

---

## 开发

```bash
npm test          # node --test test/*.test.js
```

157 个用例，零第三方依赖（`test/vendor/crypto-js.min.js` 只作为加密的对照基准）。

改代码时请守住几条底线，它们是这个项目被踩出来的：

1. **HTTP 200 不等于成功。** 判定"拿到内容了"必须看正文特征
   （网关选路页、登录页、"请稍候"页都可能返回 200）。
2. **文本启发式只能提示，不能定生死。** 已经有三次假阳性是因为
   "页面里有某个词"而误判页面类型。
3. **读不到就报没有证据，不要静默给默认值。**
   （一个静默的默认值让我差点把"0 条课"报成"课表拿到了"。）
4. **样本必须诚实。** 可以编样本测解析器，但必须标明是编的。
5. **改完要跑真实入口**（`node bin/njts.js <子命令>`），不要只写个片段调同一个函数。
6. **变异验证**：把 bug 改回去，确认测试真的变红；抓不住的断言等于没测。

---

## 免责声明

本项目是**非官方的个人工具**，与南京特殊教育师范学院无任何隶属关系。

它只读取**使用者本人**在校园系统中已有的数据，全部操作等价于使用者自己在浏览器里
点开对应页面。请自行确认你的使用方式符合学校的信息系统管理规定。
作者不对因使用本工具造成的任何后果负责。

如果你代表学校并希望删除本项目，请联系作者。

## License

[MIT](LICENSE)
