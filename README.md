# ⚛️ 第一性原理引擎 (First Principles Engine)

把目标或"随心所想"拆解到**不可再分**的第一性原理，并支持逐层递进推导、图谱可视化与整体总结的网页应用。

## 功能

以**目的链**的方式做第一性原理拆解（全程大白话）：

1. **输入与提取**
   - 🎯 **目标拆解**：输入一个目的（如"减肥""创业"），返回达成它**必须先达成的前置目的**（"先要…"）。
   - 📝 **随心所想**：粘贴一段散乱长文本，先判断你**真正想要什么**，再给出达成它的前置目的。

2. **递进推导（输入框常驻，可带补充文本）**
   - 每个节点下方**常驻**一个"补充输入框"：填写你的约束、背景、偏好后点「继续往前推」，模型会结合它生成更贴合你的下一层；**留空直接点按钮则按原样推导**。
   - 推导进行中按钮自动禁用（防止重复点击产生重复节点）。
   - 不断追问更前置的目的（A → 先达成 B → 再先达成 C …），直到你主动停止。

3. **会话级折叠（层次化展示）**
   - **每次输入 = 一条会话**，整条链默认折叠成一行摘要（标题 · 层数 · 节点数 · 时间），点击展开才能看到各层节点；多条会话互不干扰、可独立折叠/展开。
   - 正在推导的会话会自动展开，方便观察进度。

4. **记录与可视化**
   - 所有节点自动记录（localStorage 持久化，刷新不丢失）。
   - 🌌 **原理图谱**：SVG 树形可视化（滚轮缩放 / 拖拽平移 / 点击节点定位到卡片）。
   - 🗂 **记录列表**：按会话树状缩进展示，点击任意记录自动展开所属会话并定位。
   - 📋 **总结**：一键汇总整条目的链，概括"最终想达成什么、一步步要先达成什么"，并给出最该先做的第一件事。
   - ⬇ **导出**：全部记录导出为 Markdown 文件。

## 快速开始

要求：Node.js ≥ 18（自带 `fetch`）。

```bash
# 1. 配置 API Key（已内置在 config.json，也可用环境变量覆盖）
#    环境变量方式（优先级更高）：
#    export DEEPSEEK_API_KEY=sk-xxxx
#    export DEEPSEEK_MODEL=deepseek-v4-flash

# 2. 启动（零第三方依赖，无需 npm install）
node server.js

# 3. 打开浏览器
#    http://127.0.0.1:3000
```

## 配置

配置文件 `config.json`（已加入 `.gitignore`，不会提交）：

```json
{
  "apiKey": "sk-xxxxxxxx",
  "model": "deepseek-v4-flash",
  "baseUrl": "https://api.deepseek.com",
  "port": 3000
}
```

环境变量优先：`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`、`DEEPSEEK_BASE_URL`、`PORT`。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/derive` | `{text, mode: "goal"\|"text"\|"derive", context?, hint?}` → `{data: {label, principle, essence?, reasoning, keywords}, thinking}`（`hint` 为用户补充文本，会与推导结合） |
| POST | `/api/summarize` | `{nodes: [{label, principle, essence, depth, mode}]}` → `{data: {summary, themes, actions}}` |
| GET | `/api/health` | 健康检查，返回当前模型名 |

## 项目结构

```
server.js            # 零依赖 Node 后端：静态服务 + DeepSeek 代理
config.json          # API 配置（不入库）
public/
  index.html         # 页面结构
  style.css          # 深色科技风样式
  app.js             # 前端逻辑（状态 / API / 渲染 / 导出 / 持久化）
  tree.js            # SVG 树形图谱（自动布局 + 缩放平移）
```

## 安全提示

API Key 存放在 `config.json` 并由浏览器 → 后端 → DeepSeek 单向传递，前端页面不会暴露密钥；请勿将 `config.json` 提交到公开仓库。
