# Devin Fusion BYOK

一个 Devin 用户扩展：把你自己的模型 API（BYOK）接入 Devin 原生模型列表，并把两个模型组合成 Fusion 预设（Lead + Sidekick）使用。

- 不修改 Devin 应用本体，不需要重新签名，也不安装证书或改系统代理。
- 支持 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 三种接口。
- 第三方模型可以单独用，也可以和其他第三方模型或官方模型组合成 Fusion 预设。

## 安装

1. 从 [Releases](https://github.com/kuobibulaien/devin-fusion-byok/releases/latest) 下载 `devin-fusion-byok-<版本>.vsix`。
2. 在 Devin 命令面板运行 **Extensions: Install from VSIX…** 选择该文件，或在终端执行：

   ```bash
   /Applications/Devin.app/Contents/Resources/app/bin/devin-desktop --install-extension devin-fusion-byok-<版本>.vsix
   ```

3. 重载窗口（**Developer: Reload Window**）或新开一个 Devin 窗口。

之后可以在面板 **设置 → 插件更新** 里检查并一键安装新版本（目前仅 macOS）。

## 快速开始

点击右下角状态栏 **Fusion BYOK**，或在命令面板运行 **Fusion BYOK：控制面板**。

1. **模型** 页：添加供应商，填写名称、API 地址、密钥，选择接口类型。
   只填域名时会自动补 `/v1`；弹窗会显示实际请求地址。
2. 点 **导入模型**，勾选需要的模型后点 **导入**。
3. **预设** 页：点 **新建预设**，选择 Lead 和 Sidekick 模型及思考档位，保存。
4. 在 Devin 原生模型列表的 **我的 Fusion** 分组里选择预设。

保存后如果模型列表有变化，插件会自动新开一个对话让新列表生效（Devin 3.10 起只在新对话时刷新模型列表）。列表仍没更新时，可以点面板右上角的 **重启 Devin**。

## 功能

| 标签页 | 内容 |
| --- | --- |
| 预设 | 管理多个 Fusion 预设，设为默认、编辑、删除 |
| 模型 | 管理供应商和模型：启停、改显示名、上下文长度、思考档位 |
| 用量 | 本机请求统计：首字时间、输出速度、token 用量 |
| Goal（Beta） | `/goal` 命令的使用说明 |
| 设置 | 自动继续、预设可选模型、隐藏官方模型、插件更新 |

一些默认行为：

- 新模型默认上下文 272,000 tokens、最大输出 131,072 tokens，可逐个修改。
- GPT-5/6、o 系列、Claude Opus/Sonnet/Fable 4.6+ 自动提供 Low～Max 思考档位；实际是否生效取决于供应商。
- 选中的预设会被记住：Devin 把选择重置为官方 Fusion 时会自动恢复。
- 状态栏的 **上下文** 入口可以查看所选会话的上下文占用和最近请求的速度。

## Goal（Beta）

在 Devin 聊天框直接输入命令，让模型围绕一个目标一轮轮自动工作，直到它提交带证据的完成报告。

| 命令 | 作用 |
| --- | --- |
| `/goal <目标>` | 在当前对话启动目标，已有目标时替换 |
| `/goal` | 查看目标、状态、已运行轮数和最近进展 |
| `/goal pause` | 暂停 |
| `/goal resume` | 继续；到上限时再追加 10 轮 |
| `/goal clear` | 清除目标 |

- 把“怎样算做完”写进目标，例如：`/goal 让 test/auth 里的测试全部通过，并保持 lint 干净`。
- 模型每轮通过专用报告命令提交进展；报告“完成”并附证据后目标自动结束。只在回复里说“做完了”不算。
- 默认最多 10 轮，总共最多 100 轮。遇到权限确认、取消、连续两轮没有报告、连续三轮没有进展或窗口重载时会停下。
- 你中途插话后，等你这一轮结束，目标会自动继续。
- 每一轮都是正常计费的模型调用；空闲时查看和控制命令也会产生一次很短的回复。运行中查询状态直接由插件显示，不新增模型调用，也不打断原任务。

测试版：已用模拟连接做自动化测试，尚未在真实 Devin 窗口完成端到端验收，欢迎反馈。

## Fast Context MCP（实验性）

把 Devin 的三项检索能力提供给其他支持 MCP 的 Harness：

- `fast_context_search`：自然语言代码检索，返回相关文件、行号和代码片段（复用 Fast Context 接口，**不是普通关键词搜索**）；
- `web_search`：网页搜索，返回标题、地址和简短摘要；
- `web_read_url`：读取一个公开 https 网页的正文文字。

三项能力使用同一个 Devin 已登录账号，受账号与团队的网页搜索开关约束。

打开 **Fusion BYOK 控制面板 → Fast Context** 标签页，选择允许搜索的项目，点 **复制提示词** 发给目标 Harness 里的 Agent，它会按提示词把 `fusion-fast-context` 合并进自己的 MCP 配置并验证；也可以 **复制配置 JSON** 手动合并，或在命令面板运行 **Fusion BYOK：Fast Context MCP 接入配置**。不要覆盖其他服务。插件升级后需重新复制，以更新安装路径。

也可以直接使用源码入口：

```json
{
  "mcpServers": {
    "fusion-fast-context": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/devin-fusion-byok/src/fast-context/server.cjs",
        "--root",
        "/absolute/path/to/project"
      ]
    }
  }
}
```

- 需要 **Node.js 22.16+（推荐 24 LTS）** 和 ripgrep；自动查找 PATH 或 macOS Devin 自带的 ripgrep，也可通过 `FUSION_FAST_CONTEXT_RG` 指定其绝对路径。不依赖正在运行的 Devin 窗口。
- 提供 `fast_context_search`（`query`、`max_turns` 1–5、`max_results` 1–20、`include_content`）、`web_search`（`query`、`limit` 1–20、可选 `domain`）、`web_read_url`（`url`，仅 https）与 `fast_context_status`。默认最多三轮搜索、另一次最终答案请求；遇到模型格式错误，最多追加一次纠正请求，不猜测执行。每次代码搜索总时限 120 秒，同一 MCP 进程同一时间只接受一次代码搜索，支持取消；网页调用互不阻塞，各自最长约 60 秒。
- 网页搜索走官方接口；网页读取先由官方接口解析出最终地址，再在本机按同样的限制抓取正文并提取可读文字（不执行脚本、拒绝重定向、限制大小）。团队或账号关闭网页搜索时返回 `web_search_disabled`，不绕过。
- 面板「一键鉴权」会读取本机 Devin 登录，向官方服务确认账号登录、代码检索、网页搜索三项是否可用，只显示结论，不显示也不保存凭证。
- 使用本机 Devin 桌面的已有登录记录；也可由环境变量 `WINDSURF_API_KEY` 提供凭证。不把密钥写入生成的配置，不提供提取密钥工具。**使用官方账号权限及额度，不走 BYOK 供应商**；账号或团队禁用时直接报错。
- 问题、目录信息和选中的代码片段会发往官方服务。只搜索启动时指定的项目；可追加 `--exclude pattern`。默认遵守 ignore 规则，并排除常见凭证文件、依赖、构建产物、软链接和硬链接。**这不是秘密识别器**：不要选择包含敏感内容的项目，额外排除私有目录。
- 仅在内存中创建只读快照，不运行模型给出的 shell 命令，不写入项目。默认检查最多 3,000 个候选文件、8 MiB 文本、每文件 512 KiB、20 万行；被限制的结果明确标记 `partial`。读取失败、二进制等跳过数量另列。大仓库应选择更小的项目根目录。
- 检索是尽力而为，不保证找全；返回前核对文件内容与行号，修改代码前仍需自行复查。服务内部接口变化可能导致不兼容，错误不会伪装成“没找到”。

配置命令只打开一份未保存的 JSON，面板只把提示词或配置复制到剪贴板，插件本身不自动注册其他 Harness、不重启应用、不启动后台监听端口。单独运行的 MCP 由目标 Harness 管理，停用 VS Code 插件不会结束它；停用 MCP 请在目标 Harness 中移除或关闭该服务。

## 自动继续（默认关闭）

在 **设置** 页可分别开启：

- **服务商出错时自动重试**：遇到 “Provider response could not be completed” 或临时网络错误（429、5xx 等）时自动发送 `continue`，间隔 2～30 秒递增。
- **待办没做完时自动继续**：会话里还有未完成的 Plan/Todo 时自动发送 `continue`；待办没有变化就停止，避免空转。

两项都会产生额外的模型调用。

## 隐私与安全

- 密钥只保存在本机用户配置文件（权限 0600），面板不回显已保存的密钥。
- 模型发现和推理请求拒绝 HTTP 重定向，避免密钥和对话被转发到其它地址；请填写供应商的最终 API 地址。
- 日志只记录模型名、工具名和连接状态，不记录对话正文和密钥。
- 插件通过 `WINDSURF_API_SERVER_URL` 让 Devin CLI 连接本机服务；官方请求仍经正常 HTTPS 发往官方接口。
- 不会解锁账号本来没有的官方模型或权限。
- 更新检查只访问本仓库的 GitHub Releases，安装前校验文件大小、SHA-256 和包内身份，并需要你确认。

## 停用与卸载

先在命令面板运行 **Fusion BYOK：停用并恢复连接**，再卸载扩展。这会撤回模型注入，并把插件写过的 Devin 设置恢复原样（你之后自己改过的不动）。已开始的对话沿用原来的设置，停用后请新建对话。

## 已知限制

- 依赖 Devin 当前的内部接口，Devin 大版本更新后可能需要插件跟进。
- 图片输入对所有导入模型都声明为支持，实际能否处理取决于模型。
- 思考档位按模型 ID 规则提供，不是对供应商能力的检测。
- 一键更新和“重启 Devin”目前仅支持 macOS。

## 开发

```bash
npm test          # 运行测试
npm run package   # 生成 VSIX
npm run mcp:fast-context -- --root /absolute/project
```

Fast Context 真实接口验收（仅发送临时合成代码，可能消耗额度）：`FUSION_FAST_CONTEXT_LIVE=1 node scripts/fast-context-smoke.cjs`。

## 交流

作者活跃于 [LINUX DO · @koubibulaien](https://linux.do/u/koubibulaien)，欢迎交流和反馈问题。

## 许可

[MIT](LICENSE)。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
