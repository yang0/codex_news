# codex-webui-rs (v0.2.0)

Rust 版 Codex WebUI 后端。  
前端在网页输入提示词，后端通过 `CODEX_TUI_CONTROL_LISTEN` 控制真实 `codex-news` TUI 交互。

## 当前架构

- `backend mode`: `tui-control`（不是 `app-server`）
- `WebSocket`: `/ws`
- `静态页面`: `public/`
- `TUI 拉起策略`:
  - 默认服务启动时就预拉起 TUI
  - 首个 Web 会话优先复用预拉起实例
  - 预拉起失败时自动回退到首次请求懒加载

## 依赖关系

本程序不内置 Codex 二进制，运行时需要可用的 `codex-news`。

- 必需: `codex-webui-rs.exe`
- 必需: `codex-news.exe`（通过 `CODEX_COMMAND` 指定，或能在默认路径/PATH 找到）

## 运行方式

### 1) 开发运行

```powershell
cd E:\projectHome\codex_news\codex-webui-rs
cargo run
```

默认地址: `http://127.0.0.1:8787`

### 2) 二进制运行

先在可编译环境构建一次:

```powershell
cargo build
```

之后可直接运行:

```powershell
.\target\debug\codex-webui-rs.exe
```

## 常用环境变量

- `HOST`: 默认 `127.0.0.1`
- `PORT`: 默认 `8787`
- `CODEX_COMMAND`: Codex 可执行文件路径，建议用绝对路径
- `CODEX_CWD`: Codex 工作目录，默认当前目录
- `CODEX_ARGS` / `CODEX_TUI_ARGS`: 启动 Codex 的附加参数
- `CODEX_WEBUI_STATIC_DIR`: 静态页面目录，默认 `public`
- `PRESTART_TUI_ON_SERVER_START`: 默认 `1`（预拉起 TUI），可设 `0` 关闭
- `EXIT_SERVER_ON_TUI_EXIT`: 默认 `0`，设 `1` 后在 TUI `/exit` 时同时退出 Web 服务
- `RUST_LOG`: 日志级别，默认 `codex_webui_rs=info`

## Windows 设置示例

PowerShell:

```powershell
$env:PORT="8879"
$env:CODEX_COMMAND="E:\projectHome\codex_news\codex-rs\target\debug\codex-news.exe"
$env:CODEX_CWD="E:\projectHome\codex_news"
$env:EXIT_SERVER_ON_TUI_EXIT="1"
cargo run
```

cmd:

```cmd
set PORT=8879
set CODEX_COMMAND=E:\projectHome\codex_news\codex-rs\target\debug\codex-news.exe
set CODEX_CWD=E:\projectHome\codex_news
set EXIT_SERVER_ON_TUI_EXIT=1
cargo run
```

## 常见问题

### 1) `failed to bind 127.0.0.1:8879`

端口被占用，先结束占用进程或换端口。

PowerShell:

```powershell
Get-NetTCPConnection -LocalPort 8879 -State Listen -ErrorAction SilentlyContinue |
Select-Object -ExpandProperty OwningProcess -Unique |
ForEach-Object { Stop-Process -Id $_ -Force }
```

### 2) 为什么 `cargo run` 后看起来停在日志行

这是正常的，服务已进入常驻监听。  
默认会在服务启动时直接拉起 TUI。

### 3) 为什么有时预拉起失败

如果标准输入不是终端（例如后台重定向运行），`codex-news` 可能报 `stdin is not a terminal`。  
此时后端会自动回退到 Web 首次连接时再拉起 TUI。

