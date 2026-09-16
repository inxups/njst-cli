---
name: njts
description: 南京特殊教育师范学院（南特 / NJTS）校园服务查询：课表、一卡通余额与流水、宿舍电费、请假审批进度。当用户提到 南特、NJTS、南京特殊教育师范学院、一卡通、饭卡、电费、宿舍用电、课表、课程表、请假、销假 时使用。所有操作只读，不提交任何申请、不扣款。课表用 `njts schedule --http`（纯 HTTP 全链，不需要浏览器）；成绩仍未实现，用户问起要直说没做，不要凭记忆回答。
license: MIT
---

# njts —— 南特校园 CLI

## 何时用

用户问**自己的**课表、一卡通余额/流水、宿舍电费、请假审批进度时调用。**不要用它做任何写操作。**

用户问**成绩**时：本工具**还没有**这个命令。**直说还没做**，不要凭记忆回答。
课表**有**了（`njts schedule --http`），别再答"还没实现"。

## 前置条件

| 数据 | 怎么通 |
|---|---|
| 一卡通（余额/电费/流水） | 公网直连，**不需要 VPN** ✅ |
| 统一身份认证（`njts login` / `whoami`） | 公网直连 ✅ |
| 课表（教务） | **纯 HTTP 全链**，走 WebVPN 网关 ✅ |

### 课表：`njts schedule --http`

**不需要浏览器、不需要改 /etc/hosts、不需要用户做任何事。**

全链都是普通 HTTP 请求（见 `src/gateway.js` 的头注释）：

```
CAS 会话（公网 auth.njts.edu.cn）
  → 用 CAS 票据换网关会话 TWFID
  → 门户走 CAS 票据链 → 主门户
  → /mobile/openModule.do?appName=<教务 appId>-pc → {"data":"…/sso/Sudylogin"}
  → 把 host 改写成网关主机（*→ jwxt-…-s.webvpn.njts.edu.cn:8118）
  → 跟跳：CAS 票据 → /sso/Sudylogin → /jwglxt/ticketlogin → 正方会话建立
  → POST xskbcx_cxXsgrkb.html?gnmkdm=N253508 → 课表 JSON
```

会话依赖：`~/.njts-cli/session.json`（CAS）+ `~/.njts-cli/vpn-session.json`（网关 TWFID）。
**CAS 的 TGT 只有 2–3 小时**，过期后要重新 `njts login`。

> ⚠️ **`njts status` 的 cas 字段不可信。** 它只看会话文件在不在，票据过期了照样报 `ok: true`。
> 判断会话是否有效，直接跑一次 `njts schedule --http` 看结果，别拿 `status` 当证据。

## 命令表

```bash
njts status                          # 体检（注意上面那条：cas 字段会假阳性）
njts help                            # 命令总览

njts login                           # 统一身份认证登录（RSA 模式），必须在终端里手动跑
njts whoami                          # 当前登录的是谁
njts vpn login --via-cas             # 用 CAS 票据换网关会话（课表的前提）
njts vpn status                      # 网关会话状态

njts schedule --http                 # ★ 课表（纯 HTTP，不需要浏览器）
njts schedule --ics --from FILE      # 从本地 JSON 生成 ICS 日历

njts card login                      # 一卡通（学号 + 一卡通单独密码，与统一身份认证密码不同）
njts card balance                    # 余额
njts card flow --days 30             # 消费流水

njts power list                      # 宿舍电费：待缴项目与余额
njts power balance                   # 电费余额
njts power trend --days 14           # 趋势（需累积两次以上快照）

njts leave status                    # 请假申请与审批进度（只读）
njts leave draft "周三下午发烧去医院，想请一天"   # 生成草稿，不提交
njts leave services -q 请假           # 在办事大厅服务清单里搜服务

njts skill install                   # 把本文件装进 pi 的 skills 目录
```

### 未实现，别推荐给用户

```bash
njts grades                          # 成绩：接口一次都没抓到，故意不猜
njts week                            # 周次：同上
```

> 浏览器那套老路径（`--auto/--capture/--browser/--http-browser`、`jwxt open`、
> `vpn check/probe/url/browser-*`）**已经全部删除** —— 它们打的是
> `webvpn.njts.edu.cn`（公网无 A 记录，根本解析不出来）。
> 现在课表只有一条路：`njts schedule --http`；引用已删命令会得到 `input` 错误。

## 输出与错误

- stdout 恒为 `{"ok":true,"data":{…}}` 或 `{"ok":false,"error":{"kind","message","hint"}}`
- **失败时按 `error.kind` 决定动作，别看 message 猜**：

| kind | 含义 | 你该做什么 |
|---|---|---|
| `unauthenticated` | 会话失效或未登录 | 让用户跑 `njts login`（教务）或 `njts card login`（一卡通） |
| `login` | 登录失败（密码错/锁号） | **不要重试**，让用户核对凭据 |
| `network` | 不可达 | 跑 `njts status` 看哪一段断了。**别无脑说"连 VPN"** —— 课表不需要 VPN，需要的是有效会话 |
| `service` | 上游异常或页面改版 | 附 hint 告诉用户，**别自己编数据** |
| `input` | 参数错 | 修正参数 |
| `unsupported` | 未实现 / 被安全策略禁用 / Node 版本不够 | 直说，别绕路 |

退出码：`0` 成功 / `2` 未登录 / `3` 登录失败 / `4` 网络 / `5` 服务端 / `6` 参数 / `7` 不支持。

## 四条硬边界

1. **不提交任何东西**：请假只出草稿 + 查进度，没有 `leave submit`
2. **不扣款**：电费/充值只给余额与入口，不存在支付接口
3. **不伪造数据**：接口失败就报错。成绩没实现就直说没做，**不要凭记忆回答**
4. **只碰用户本人账号**，不访问他人数据

## 环境

- **Node ≥ 20**（用了 `Headers.getSetCookie()`）。低于这个版本工具会**直接拒绝启动**
  并说明原因 —— 不要绕过它，让用户升级 Node。
- 需要代理出网的环境：工具**自己会把 `NODE_USE_ENV_PROXY=1` 补上**并重启一次自己，
  不用手动设。想强制直连设 `NJTS_NO_PROXY=1`。
- 配置目录默认 `~/.njts-cli`（0600/0700）。目录不可写时用 `NJTS_HOME=<可写目录>`。
- 报告落盘：`last-schedule.json`（课表）。
  里面**没有密码、没有 cookie 值、没有 CAS 票据**（cookie 只有名字和域，ticket 自动脱敏）。

## 排查时的铁律

这个项目被假阳性坑过很多次，改代码或读结果时守住：

1. **HTTP 200 不等于成功。** 网关选路页、登录页、"请稍候"页都可能返回 200。
   判定"拿到内容了"必须看**正文特征**。
2. **文本启发式只能提示，不能定生死。** 已经三次因为"页面里有某个词"误判页面类型。
3. **读不到就报没有证据，不要静默给默认值。**
   （一个"第一个选项"的兜底让学年读成 2031，接口老实返回空列表，差点把"0 条课"报成成功。
   现在空列表一律不当成功。）
4. **没有证据就不发请求、不写常量。** 接口名只能来自页面源码，参数只能来自页面控件。
5. **样本必须诚实。** 可以编样本测解析器，但要标明是编的。
6. **改完跑真实入口**（`node bin/njts.js <子命令>`），别只写片段调同一个函数。
