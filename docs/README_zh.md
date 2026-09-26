# byokrouter-reasoning-effort

[English](../README.md) | **中文**

一个 OpenAI 兼容的反向代理，给请求**加上思考强度档位（`reasoning_effort`）**。
这样即使你用的 AI-IDE 根本不提供这个设置，你也能控制模型思考多深。

## 它解决的两个问题

### 问题一：客户端没有设置思考强度的入口

你用自己的 key（BYOK），网关也支持 `reasoning_effort`，但你正在用的 IDE：
不提供这个设置项；而且它的每模型配置**往往也改不了** —— 配置存在于它内嵌的
数据库里（应用会不断把你改的覆盖掉），或者被编译进了签名后的 bundle。

设置项无处安放。那就把它挪到**网络层**：把自定义模型的地址指向这个代理，
由代理按模型决定是否发送 `reasoning_effort`，其余请求原样转发。

### 问题二：真正发请求的可能不是你的客户端

有些 AI-IDE 的做法相当令人费解：它们**不是从你本机去调用模型**，而是把你填的
base_url 交给**发行商的服务器**，由那些服务器代替使用者发起请求。

这就意味着：能解决问题一的代理，**还必须让那台服务器访问得到** —— 于是
`127.0.0.1` 彻底行不通，无论你本地配得多正确。

```
只有问题一：  client ──► proxy ──► gateway ──► model
              绑回环地址即可

问题一 + 二： client ──► 发行商服务器 ──► proxy ──► gateway ──► model
              代理必须能被公网访问，因此需要：
                client token、来源白名单，以及对"暴露"这件事的明确取舍
              详见 docs/why-a-proxy.md
```

本仓库两者都覆盖：`src/` 是通用的核心（对应问题一），
[why-a-proxy.md](why-a-proxy.md) 讲怎么识别、诊断并决定问题二。

---

## 快速开始

```bash
git clone <this repo> && cd byokrouter-reasoning-effort

cp .env.example .env          # 然后编辑 .env
node bin/start.mjs            # 零依赖，只用 Node 标准库
```

`.env` 最少需要两项：

```ini
UPSTREAM_URL=https://your-gateway.example.com
UPSTREAM_API_KEY=<你的 key>
```

`bin/start.mjs` 会直接打印该粘贴到客户端里的内容：

```
------------------------------------------------------------------------
 paste these into the client
------------------------------------------------------------------------
  Base URL : http://127.0.0.1:8798/chat/completions
  API key  : <自动生成的 client token>
  Models   : 上游认识的任意模型 id，例如
               GLM-5.3-Flash
               DeepSeek-V4.1-Flash
  Tiers    : none | low | medium | high | xhigh | max   （null = 不发送）
  Status   : http://127.0.0.1:8798/_status   （仅本机）
------------------------------------------------------------------------
```

要求：**Node 18+**。不需要装任何包，没有构建步骤。

---

## 配置思考强度

`byokrouter.json`（**可以提交**，因为它不含密钥）：

```json
{
  "reasoning": {
    "default": "max",
    "models": {
      "GLM-5.3-Flash": "max",
      "DeepSeek-V4.1-Flash": "max",
      "Qwen3.8-Max": "medium",
      "Kimi-K3": "medium"
    }
  }
}
```

* `default` 作用于所有未单独列出的模型。
* `null` / `""` / `"default"` 表示**完全不发送 `reasoning_effort`**，也就是让
  上游用自己的默认值。这是表达"默认"的唯一诚实做法：它是一种**状态**，不是一个档位值。
* 合法档位：`none | low | medium | high | xhigh | max`。

改文件**运行中即可生效，不用重启**。也可以动态改：

```bash
curl -X POST http://127.0.0.1:8798/_control \
     -H 'content-type: application/json' \
     -d '{"model":"Kimi-K3","effort":"max"}'
```

运行时覆盖会存到 `.state/tiers.json`，重启后仍然有效。

> **档位名是相对于上游的，不是通用刻度。** `max` 表示"要求最多"，但具体含义由上游决定。
> 有些模型的**默认值甚至高于它的 `max` 档**。所以在信任任何档位前先实测：
> 方法和一个真实例子见 [reasoning-effort.md](reasoning-effort.md)，其中包括
> **`none` 会静默关闭思考并给出错误答案**这个陷阱。

---

## 配置项

优先级由高到低：**环境变量 → `.env` → `byokrouter.json` → 默认值**。

| 变量 | 作用 |
|---|---|
| `UPSTREAM_URL` | 上游网关地址（**必填**） |
| `UPSTREAM_API_KEY` | 上游 key（**必填**，除非用 keys 文件） |
| `REASONING_PROXY_BIND` | `127.0.0.1`（默认）或 `0.0.0.0` |
| `REASONING_PROXY_PORT` | 监听端口（默认 8798） |
| `REASONING_PROXY_CLIENT_TOKEN` | 客户端必须携带的 token；**非回环时必填** |
| `REASONING_PROXY_ADMIN_TOKEN` | 管理接口（仅本机）的额外 token |
| `REASONING_PROXY_ALLOWLIST` | 允许使用代理的来源前缀，逗号分隔 |
| `REASONING_PROXY_ALLOWLIST_STRICT` | `1` = 其他来源返回 403 |
| `REASONING_PROXY_TRUST_FORWARDED` | `1` = 依据 `x-forwarded-for` 判定白名单 |
| `REASONING_PROXY_NO_ADMIN` | `1` = 彻底移除 `/_status` 和 `/_control` |

JSON 配置里可以写 `${VAR}` 引用：

```json
{ "keys": { "default": "${UPSTREAM_API_KEY}" } }
```

这正是**让配置文件可以安全提交**的关键。未解析成功的引用会在启动时明确报错，
而不是等到后面收到一个莫名其妙的 401。

---

## 管理接口

默认仅限本机回环；若设置了 `REASONING_PROXY_ADMIN_TOKEN` 则还需要该 token。

| 接口 | 作用 |
|---|---|
| `GET /_status` | 当前档位、计数器、最近 20 条请求（模型、档位、来源地址） |
| `POST /_control` | `{"model":"<id>","effort":"<档位>\|null"}` 或 `{"default":"<档位>"}` |

最近请求日志是回答"我的客户端到底发了什么、从哪里发的"最快的方式 ——
它记录了来源地址和 `x-forwarded-for`。

---

## 安全

代理持有上游 API key，请把端口当作敏感资源对待。

* **非回环必须设置 client token。** 否则任何能访问到端口的人都能消耗你的额度 ——
  真的这么做时，代理会在启动时警告你。
* **`/_status` 与 `/_control` 永远仅限本机。** `/_control` 能改变发往上游的内容，
  绝不能让外部访问到。
* **token 比较使用恒定时间算法**，并且传入的 `authorization` 头会被**替换**成真实上游
  key，所以你的 client token 不会泄露给网关。
* **转发前会删除 `x-forwarded-for`**；你的网络拓扑不关网关的事。
* 当客户端从已知地址访问时，**用来源前缀做白名单**。若经过 NAT，请打开
  `REASONING_PROXY_TRUST_FORWARDED`，让白名单依据转发头判定，而不是路由器的地址。
* push 前跑 `node scan-secrets.mjs`：它会拦下密钥形态的字符串，以及你不希望公开的
  站点特定值。

`.env`、`keys.json`、`*.token`、`.state/` 都已在 `.gitignore` 中，不需要提交任何密钥。

---

## 最让人意外的一点

**客户端可能根本访问不到你的代理。**

有些客户端在**自己的服务器**上校验并调用自定义模型，而不是从你的机器发起。
这种情况下 `http://127.0.0.1:…` 永远不可能工作，而失败表现通常是一个笼统的 `500`，
或者厂商特有的 "origin error"，同时你的代理日志显示**零请求**。

一步诊断：在客户端做连通性测试时盯着计数器。**如果始终是 0，请求从未到达。**

可行方案，按推荐顺序：

1. 绑定到局域网（`--lan`），使用厂商服务器能访问到的地址
   （如果你的宽带有公网 IPv4/IPv6 地址，这条路可行）；
2. 把代理放到隧道后面（Cloudflare Tunnel、ngrok 等），并让隧道自带鉴权；
3. 放弃客户端内集成，改用在本机运行的其他工具来访问这个代理。

完整推理过程和取证方法见 [why-a-proxy.md](why-a-proxy.md)。

---

## 目录结构

```
src/proxy.mjs       代理本体（通用，仅标准库）
src/config.mjs      配置加载：env / .env / JSON，含 ${VAR} 展开
bin/start.mjs       跨平台启动器（打印客户端所需信息）
byokrouter.json     可提交的运行配置（档位、白名单、变量引用）
.env.example        gitignore 掉的 .env 的模板
scan-secrets.mjs    push 前的密钥扫描器
docs/               why-a-proxy / reasoning-effort / windows-gotchas
platforms/trae-windows/  可选适配层：Trae CN on Windows 的一键启动
```

核心与客户端无关。`platforms/` 存在的原因是：每个客户端都需要各自的变通办法，
详见 [platforms/trae-windows/README.md](../platforms/trae-windows/README.md)。

---

## 许可证

MIT —— 见 [LICENSE](../LICENSE)。
