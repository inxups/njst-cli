# 快速开始

> 五分钟从零到看见自己的课表。**不需要装浏览器，不需要改 hosts，不需要连 VPN 客户端。**

## 0. 你需要什么

- **Node.js ≥ 20** —— 检查一下：

  ```bash
  node --version
  ```

  低于 20 工具会直接拒绝启动并告诉你原因（代码用了 Node 19.7 才有的
  `Headers.getSetCookie()`，版本不够时会静默收不到 cookie，所以宁可不启动）。
  没有就去 <https://nodejs.org/> 下 LTS 版装上。

- **零第三方依赖** —— 不用 `npm install`，不用联网装包。

## 1. 解压，确认能跑

把 zip 解压到任意目录，在那个目录里打开终端：

```bash
node bin/njts.js help
```

看到 JSON 格式的命令总览就成了。之后想少打几个字，可以做个软链：

```bash
ln -s "$PWD/bin/njts.js" /usr/local/bin/njts     # 之后直接用 njts
```

下面的例子都写完整的 `njts`，没做软链就换成 `node bin/njts.js`。

## 2. 登录

校内的服务分两套凭据，**先登统一身份认证**：

```bash
njts login
```

会提示输入**学号**和**统一身份认证密码**。密码不会出现在命令行、不会进 shell 历史、
不会写日志，**默认也不落盘**。

> ⚠️ **失败了不要反复重试。** 连续失败会被计数，可能触发风控或锁号。
> 输错一次就停下来核对密码，隔一会儿再试。

登录状态存到 `~/.njts-cli/session.json`（权限 0600）。

### 用 CAS 票据打开网关（课表的前提）

```bash
njts vpn login --via-cas
```

这一步拿的是 WebVPN 网关的会话（`TWFID`），落在 `~/.njts-cli/vpn-session.json`。
**走的是 CAS 票据，不需要再输一次密码。**

> 会话是**会话级**的：CAS 的票据只有 **2–3 小时**。过期后重新跑一次上面两条命令即可。

## 3. 看课表

```bash
njts schedule --http
```

**这就是全部 —— 纯 HTTP，不启浏览器。** 输出长这样：

```
· 进门户…
· 门户里取教务入口…
· 门户 → 教务（免密 SSO）…
· 读课表页自己的学年/学期…
· 取课表（2026 学年 学期 3）…

===== 2026 学年 1 学期课表 =====
某同学 智能0000　学号 00000000

星期一
  3-5节    线性代数A           D310   教师甲   4-9周
  6-7节    思想道德与法治        D211   教师乙   4-13周
  8-10节   数字电路与逻辑设计     D213   教师戊   4-5周
  …
```

`·` 开头的进度行在 **stderr**，**stdout 恒为单个 JSON**，所以可以管道给别的工具：

```bash
njts schedule --http | jq '.data.courses[] | "\(.weekdayName) \(.sections) \(.name)"'
```

想换学年/学期？工具会**从课表页自己的下拉框里读**当前选中的那个，不需要你指定。
如果那一学期没有课，它会明确告诉你「一条课都没有」并让你去核对学年学期 ——
**不会把空列表当成成功**。

## 4. 其它数据

一卡通和电费用的是**另一套凭据**（学号 + 一卡通单独密码，和统一身份认证密码不同）：

```bash
njts card login
njts card balance          # 余额
njts card flow --days 30   # 消费流水

njts power list            # 宿舍电费
njts power balance
njts power trend --days 14 # 趋势（要继续跑几次攒快照）
```

请假进度（只读，不会提交任何申请）：

```bash
njts leave status
njts leave draft "周三下午发烧去医院，想请一天"   # 只生成草稿
```

**成绩还没实现** —— 接口没抓到，所以故意不猜。用户问起就直说还没做。

## 5. 装进 pi / Claude

```bash
njts skill install
```

把 `SKILL.md` 装到 pi 的 skills 目录，之后 agent 就能自己用这些命令。

---

## 出问题了怎么办

### 一律先跑体检

```bash
njts status
```

它会分别探 网络 / 统一身份认证 / 一卡通 / 办事大厅。

### `error.kind` 对照表

| kind | 含义 | 怎么办 |
|---|---|---|
| `unauthenticated` | 会话失效或没登 | `njts login`（教务）或 `njts card login`（一卡通） |
| `login` | 密码错 / 锁号 | **别重试**，核对凭据 |
| `network` | 不可达 | 看 `njts status` 是哪一段断了 |
| `service` | 上游异常或页面改版 | 把 `hint` 一起贴出来 |
| `input` | 参数错 | 按 hint 改 |
| `unsupported` | 未实现 / Node 版本不够 | 按 hint 处理 |

退出码：`0` 成功 / `2` 未登录 / `3` 登录失败 / `4` 网络 / `5` 服务端 / `6` 参数 / `7` 不支持。

### ⚠️ 一个已知的假阳性

**`njts status` 里的 `cas` 字段不可信** —— 它只看会话文件在不在，**票据过期了照样报
`ok: true`**。想判断会话到底有没有效，直接跑一次 `njts schedule --http` 看结果。

### 课表报「一个会话都没有」

`~/.njts-cli/session.json` 或 `vpn-session.json` 读不到。按顺序：

```bash
njts login
njts vpn login --via-cas
njts schedule --http
```

### 课表报「网关会话失效」

CAS 票据还在，网关那边的过期了。重跑 `njts vpn login --via-cas`。

### 报 `EPERM: process.cwd failed with error operation not permitted, uv_cwd`

**这是 macOS shell 的问题，不是本工具的**：终端当前目录已经失效（被删了或被覆盖了），
Node 连"自己在哪儿"都问不出来，**在跑代码之前就崩了**。

典型诱因：就在 `njts-cli` 目录里又跑了一次 `unzip -o njts-cli.zip`，把当前目录覆盖掉。

**修法**：

```bash
cd ~            # 先回到一个有效目录
cd ~/njts-cli   # 再进项目（换成你实际解压的位置）
pwd             # 能正常打印就对了
```

还是不行就**开一个新终端窗口**。也可以从 `cd ~` 之后一直用绝对路径：

```bash
node ~/njts-cli/bin/njts.js schedule --http
```

### 贴在反馈里的时候

贴命令的**完整 stdout JSON**（含 `error.kind` / `message` / `hint`）就够了。

**不要贴**密码，**不要贴** `~/.njts-cli/` 里的文件内容（那些是会话凭据）。

---
