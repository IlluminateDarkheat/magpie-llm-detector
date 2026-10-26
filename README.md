# Magpie LLM Detector

在 Magpie Web UI 中选择模型，点击「开始检测」，使用 [lmfpd-sdk](https://lm.ikale.io/docs/sdk/) 检测回答的 fingerprint。支持一个或多个模型、一个或多个 provider 下的全部模型，以及所有可用 provider 下的全部模型。也提供 Agent tools。

检测在 Magpie 已有的 Bun plugin host 中运行，通过你配置的 Magpie API 请求目标模型。无需新增 container、HTTP server、port mapping 或自定义 Magpie image。

## 安装

需要支持 plugin page、options bridge 和 Agent tools 的 Magpie，以及 Bun 1.4.2+。Magpie 自己管理 plugin host 的 Bun。当前页面接入按 Magpie 0.1.1564 对应的公开接口和源码实现。

本项目当前从文件夹安装。先在项目目录安装依赖：

```sh
bun install --frozen-lockfile
```

将整个项目文件夹（包含安装好的 `node_modules`）放进 Magpie 的持久化 volume，例如容器内 `/config/plugins/magpie-llm-detector`。依赖是纯 JavaScript。也可以在容器内该目录运行 `bun install --frozen-lockfile`，前提是 Bun 在 PATH 中。

在 Magpie Web UI 的「插件 → 添加插件」填写容器内路径：

```text
/config/plugins/magpie-llm-detector
```

或使用 CLI：

```sh
docker exec magpie magpie plugin add /config/plugins/magpie-llm-detector
```

文件夹插件就地加载，Magpie 不会替它安装 npm dependencies。目录必须允许容器用户写入 `page/generated/`；官方 image 的用户是 uid 65532。安装到已有 `/config` volume 可以随 container 重建保留。

包也支持作为 npm/git plugin 安装；发布后 Magpie 会安装 dependencies，入口无需 build 或 postinstall。

## 在 Magpie 页面中检测

1. 打开 sidebar 中的「模型 Fingerprint」。
2. 展开「Magpie API 设置」，填写 Base URL 和 gateway key，点击「保存并读取模型」。同一个 container 内的默认地址是 `http://127.0.0.1:3425/v1`；自定义 gateway port 时填写实际地址。
3. 选择「指定模型」「指定 provider 的全部模型」或「全部 provider 的全部模型」。模型和 provider 都支持多选、搜索和选择搜索结果。
4. 点击「开始检测」。页面显示每个 round 的进度、候选排名、probability 和 sample 错误；「取消检测」停止任务，已完成的结果保留。

Provider 的右键菜单还提供「检测 Fingerprint」，进入页面并选中该 provider。

模型目录来自配置地址的 `GET /models`，以完整的 `provider/model` ID 请求。全部模型指当前 gateway key 可见的已启用 text generation 模型；routing groups、bare aliases 和明确的非 text 模型不作为检测目标。多个 provider 与单独模型的并集会去重。账号池仍按 Magpie 的规则选择账号，不逐个检测账号。

默认每个模型执行一轮、每轮 3 个 challenge。模型 rounds 默认串行，每轮最多并发 3 个 challenge。高级参数可以设置 rounds、concurrency、challenge 数、strict、API、timeout、effort 和 service tier。`auto` 根据模型的 `native_endpoints` 选择 SDK 支持的 API；没有对应 API 时使用 Chat Completions，由 Magpie 转换协议。每轮独立展示 SDK 的结果，不合并或重算 probability。

SDK 在 backend 中直接调用：

```js
const detector = await loadDetector({ cache: referenceCache })
const result = await detector.detect({
  baseUrl: options.baseUrl,
  apiKey: options.apiKey,
  model: "provider/model",
  api: "chat_completions",
}, { signal, onSample })
```

项目固定使用 `lmfpd-sdk@0.2.0`。这个版本的第二个参数是 `{ signal, onSample }`，与旧版直接传 `AbortSignal` 的签名不同。

## Page 与 backend 如何通信

Magpie page 的 CSP 禁止 fetch，bridge 也没有通用 backend RPC。本插件组合使用已有接口：

1. 按钮用 `magpie.options.set()` 保存带唯一 ID 的 command。
2. Magpie 重载 plugin host；页面通过声明过的 `providers:list` read 触发 provider catalog 刷新，让 host 按需加载。
3. backend 领取 command，在 Bun 中请求 Magpie API 并调用 SDK。
4. backend 把不含凭据和原始回答的状态写成 `page/generated/state.js`。页面加载自己目录内的 script asset，由 Magpie 已有的文件服务提供。

**开始、取消、刷新目录或保存设置会触发共享 plugin host 重载。**Magpie 让旧 host 中正在返回的请求先完成；本插件用锁协调新旧 host。其他 plugin 的更改也可能中断正在运行的检测。每个 command 只领取一次，已开始而中断的任务标记为 `interrupted`，不会自动重新发送 challenge。普通进度刷新只读页面资源，不重载 host。

这不是 Magpie 承诺的专用任务 RPC，依赖当前 options、catalog 刷新和页面文件服务的行为。如果提交后 backend 时间不更新，打开「插件 → 已安装」触发 host 加载再返回。页面目录只读时，Agent tools 也会因无法发布状态而报错。

## Agent tools

将 Magpie 现有的 MCP 地址添加到 Agent：

```text
http://<magpie-host>:<现有端口>/mcp/magpie/tools
```

容器外使用有效的 gateway key。完整 tool 名可在 Magpie 已安装 plugin 行查看，通常如下：

| Tool | 用途 |
| --- | --- |
| `magpie-llm-detector_list_models` | 获取可检测的 provider 和模型，不发送 challenge |
| `magpie-llm-detector_start_detection` | 启动任务，立即返回 task ID |
| `magpie-llm-detector_get_detection` | 查询进度和结果；不填 taskId 列出历史任务 |
| `magpie-llm-detector_cancel_detection` | 取消正在运行的任务 |

`start_detection` 参数示例：

```json
{"models":["provider-a/model-x","provider-b/model-y"]}
```

```json
{"providers":["provider-a","provider-b"],"models":["provider-c/model-z"],"rounds":2}
```

```json
{"all":true}
```

用返回的 ID 查询：

```json
{"taskId":"返回的 taskId","details":true}
```

`details: true` 包含原始 challenge 和模型回答。任务不受单次 tool 55 秒 deadline 限制；tool 返回后任务继续运行。Agent tools 启动和取消任务不修改 plugin options，因此不触发 host 重载。

Plugin tools 使用配置的 detector gateway key 发出请求，目标范围和请求额度取决于这个 key。任何能调用此 plugin tools 的 Agent 都能使用这份权限；调用 tool 时的 key 不会自动替代 detector 的 key。

## 配置和数据

可在页面填写 Base URL / key，也可以在 plugin options 中设置：

```json
{
  "baseUrl":"http://127.0.0.1:3425/v1",
  "apiKeyEnv":"MAGPIE_DETECTOR_API_KEY"
}
```

`apiKey` 优先于 `apiKeyEnv`。环境变量由 Magpie container 提供；直接填入的 key 保存在 Magpie 的 `plugins.json` options 中，页面通过自己的 options bridge 读取。请使用专门的 gateway key。SDK 的 `dataSource` 可在 options 中指定 URL 或本地 reference data 目录；不填使用 SDK 官方来源和镜像。

- 私有任务、完整 sample、command 去重记录和 reference cache：`<Magpie 配置目录>/llm-detector/`。官方 Docker 通常是 `/config/magpie/llm-detector/`。
- 页面状态：plugin 目录的 `page/generated/state.js`，不含 key、Base URL、challenge 文本或原始回答；包含模型 ID、排名、sample 摘要和错误。它与所有 plugin page 资源一样，受 Magpie 页面 token 控制。
- reference data 首次下载由 SDK 处理，约几 MB。一个 batch 只加载一次，之后复用磁盘 cache。
- 历史任务不自动删除。需要清理时，先停止检测，再删除 `llm-detector/tasks/` 中相应 JSON。保留 `commands/`，防止 options 中仍保留的 command 被重复领取。
- `page/generated/` 被 Git 和 npm package 排除，避免打包运行数据。

Fingerprint 是参考库内的相似度排序，不是模型身份证明；库外模型也会得到最相似的候选。只有 SDK 的完整有效 scoring 且 calibration 有效时才有 probability，partial 保留 `null`。Magpie routing、fallback、middleware 和上游服务的行为仍会影响检测结果。

## 开发

```sh
bun install --frozen-lockfile
bun test
```

Unit tests 覆盖多目标选择、SDK 参数、任务取消、失败隔离、重载去重、中断恢复和页面数据脱敏。修改文件夹 plugin 后，在 Magpie 中关闭再开启。

参考：[SDK](https://lm.ikale.io/docs/sdk/) · [SDK API](https://lm.ikale.io/docs/sdk/api/) · [Magpie plugin](https://usemagpie.ai/docs/zh/plugins) · [Magpie Docker](https://usemagpie.ai/docs/zh/docker)
