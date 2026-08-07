# gft-mcp

把你在 [GFT（Git for Thought）](https://gitforthought.com) 确认过的**思维脉络**接给任何 AI agent——
Claude Code、Cursor，或任何支持 MCP 的工具。

> **用它们的 token，走 GFT 的规则。** 对话发生在你的 agent 里，思考资产沉淀在你的图上。

- 🗺 **读**：agent 直接读到你已想通的判断、还悬着的问题、已否决的方向
- ✍️ **写**：聊完说一句「存一下」，本场新判断增量长进图（只生长，不改写历史）
- 📬 **知情**：每次写入当场回执「加了什么」，新节点带未读标记，点开即消——不靠常驻视觉标
- 🔒 **零转手**：本包不调用任何 AI、不产生任何 token 消耗——推理全部由你的 agent 用你自己的额度完成

---

## 快速开始

### Claude Code 用户（最推荐）：装 plugin，一步全齐

```
/plugin marketplace add CoralLips/gft-mcp
/plugin install gft@gft-mcp
```

装完重启，你会得到：
- `/gft:list`、`/gft:login` —— **程序直答，秒回、零 token**（UserPromptSubmit hook 拦截，不经过模型）
- `/gft:link 图名`、`/gft:save` —— 把图接进对话 / 把新判断存回图（AI 命令）
- MCP server 自动配好，无需再手动 `claude mcp add`

### 方式一（推荐）：把这段话贴给你的 AI

```
请帮我安装 GFT 思维脉络的 MCP server：
把名为 "gft" 的 server 加进我的用户级 MCP 配置，
command 是 npx、args 是 ["-y", "gft-mcp"]
（Claude Code 可直接跑: claude mcp add -s user gft -- npx -y gft-mcp；
 其他工具写各自的 MCP 配置文件）。
配好后提醒我重启生效；重启后我说「登录 GFT」完成授权即可。
```

### 方式二：一行命令（Claude Code）

```bash
claude mcp add -s user gft -- npx -y gft-mcp
```

### 方式三：手动配置

把这段加进你的 MCP 配置文件（Claude Code：`.mcp.json`；Cursor：`.cursor/mcp.json`）：

```json
{ "mcpServers": { "gft": { "command": "npx", "args": ["-y", "gft-mcp"] } } }
```

**配置零凭证、所有人相同**——登录在下一步，凭证只落在你本机 `~/.gft-mcp/`。

需要 Node.js ≥ 20。配完重启你的 agent 生效。

---

## 登录

对 agent 说「**登录 GFT**」（或用 `/gft:login` 命令）——它会跑：

```bash
npx gft-mcp --login-web
```

浏览器自动打开 GFT 授权页 → 点一下「**授权接入**」→ 完成。
密码不经过任何对话或终端；agent 拿到的是**独立**凭证，你浏览器里的登录不受影响。

还没有 GFT 账号？先去 [gitforthought.com](https://gitforthought.com) 聊一段、生成第一张思维脉络。

---

## 用法

装好后你的 agent 自动获得四个命令（MCP prompts，Claude Code 里也可用 `/gft:*` 短名）：

| 命令 | 干什么 |
|---|---|
| `list` | 列出你的思维脉络（名字·条数·各线新鲜度） |
| `link` | 把当前对话链接到一张图（之后读写默认走它） |
| `save` | 把本场对话的新判断增量存回图 |
| `login` | 检查凭证 / 发起网页授权 |

不用命令也行，直接说人话：

> 「列一下我的 GFT 脉络」「带上『产品定位』那张图」「把刚才聊的存进脉络」

### ⚡ 零 AI 快速通道（不花 token、不等模型）

查名单、看图这类**纯程序动作**可以完全绕开 AI——终端直跑：

```bash
npx gft-mcp list           # 瞬回脉络名单
npx gft-mcp read 图名       # 输出某张图全文
npx gft-mcp login          # 网页授权登录
```

Claude Code 用户的妙用：在输入框用 **`!` 前缀**跑（如 `! npx gft-mcp read 产品定位`），
输出直接进入对话上下文——**等于零 token 完成"链接"**。
（`save` 没有零 AI 通道——从对话抽取判断本来就是模型的工作。）

写入规则由 GFT 端校验把关：只收用户真说过的判断、旧节点不可改写、时序不可倒挂——出格的提交会被打回并说明原因。

---

## 排错

| 现象 | 处理 |
|---|---|
| 提示未登录 / 登录失效 | 说「登录 GFT」或跑 `npx gft-mcp --login-web` |
| 浏览器没自动打开 | 手动访问命令输出里的 URL |
| agent 里看不到 gft server | 配置后要**重启** agent；检查 `npx -y gft-mcp` 在终端能否启动 |
| 提示还没有脉络 | 先去 gitforthought.com 生成第一张图 |
| 自检 | `npx gft-mcp --check --list`（终端直跑，零 AI） |

---

## 给开发者

- 本包**零 AI 调用**：server 只做「验 / 存 / 供」（校验、增量合并、供图），抽取规则随 `read(for_update)` 下发，由你的 agent 用自己的模型执行
- 判据随包走：`node selftest.mjs`（78 条，零网络零 API）
- 在 GFT 仓库内运行时自动切换本地开发环境（授权页指 `localhost:3000`）；`GFT_WEB_URL` / `GFT_SUPABASE_URL` / `GFT_SUPABASE_ANON_KEY` 环境变量可覆盖一切默认值
- ⚠ 改 `map.mjs` 的 `isOpen()` 必须同步 GFT 画布口径，先跑判据

MIT License · [gitforthought.com](https://gitforthought.com)
