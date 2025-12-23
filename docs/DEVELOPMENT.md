# Development and Debugging Guide

This document provides a detailed guide on how to develop, debug, and build the Horcrux application using the project's Makefile.

本文档详细介绍了如何使用项目的 Makefile 进行 Horcrux 应用程序的开发、调试和构建。

---

## Command Overview / 命令概览

The project uses `make` to manage development tasks. Below are the available commands:
项目使用 `make` 来管理开发任务。以下是可用的命令：

| Command / 命令 | Description / 描述 |
| :--- | :--- |
| `make dev` | **Recommended**. Start the Tauri application in development mode with Sidecar support.<br>**推荐**。以开发模式启动 Tauri 应用程序，支持 Sidecar 后端。 |
| `make dev-web` | Start the web-only development environment (Frontend + Backend).<br>启动纯 Web 开发环境（前端 + 后端）。 |
| `make debug` | Start Tauri in debug mode with verbose logging and debug flags.<br>以调试模式启动 Tauri，包含详细日志和调试标志。 |
| `make build` | Build the production Tauri application (DMG/AppImage/Exe).<br>构建生产环境的 Tauri 应用程序。 |
| `make clean` | Clean all build artifacts and caches.<br>清理所有构建产物和缓存。 |

---

## Detailed Usage / 详细用法

### 1. Start Development / 启动开发

To start the full desktop application development environment:
启动完整的桌面应用开发环境：

```bash
make dev
```

**What it does / 执行动作:**
1. Compiles the Go backend for the current platform (Sidecar).
   为当前平台编译 Go 后端（Sidecar）。
2. Starts the Tauri development window.
   启动 Tauri 开发窗口。
3. Enables Hot Module Replacement (HMR) for frontend.
   启用前端热模块替换 (HMR)。

**Note / 注意:**
The backend is compiled once at startup. If you modify Go code, you must restart `make dev` to recompile the sidecar.
后端在启动时编译一次。如果修改了 Go 代码，必须重启 `make dev` 以重新编译 Sidecar。

### 2. Web-Only Development / Web 开发模式

If you only need to develop the web UI or debug backend logic without the desktop wrapper:
如果你只需要开发 Web UI 或调试后端逻辑，不需要桌面壳：

```bash
make dev-web
```

**What it does / 执行动作:**
1. Starts the Vite dev server (Frontend).
   启动 Vite 开发服务器（前端）。
2. Starts the Go backend with `air` for live reloading.
   使用 `air` 启动 Go 后端，支持热重载。
3. Available at `http://localhost:7626`.
   访问地址：`http://localhost:7626`。

### 3. Debugging / 调试

To debug issues specifically related to Tauri (Rust) or Sidecar communication:
调试 Tauri (Rust) 或 Sidecar 通信相关问题：

```bash
make debug
```

**What it does / 执行动作:**
*   Sets `RUST_LOG=debug` environment variable.
    设置 `RUST_LOG=debug` 环境变量。
*   Passes `--debug` flag to Tauri, enabling Rust debug symbols and devtools.
    传递 `--debug` 标志给 Tauri，启用 Rust 调试符号和开发者工具。

**Debugging Tips / 调试技巧:**
*   **Frontend**: Right-click in the app window and select "Inspect Element" to open Chrome DevTools.
    **前端**：在应用窗口右键点击选择 "Inspect Element" 打开 Chrome 开发者工具。
*   **Backend (Sidecar)**: Logs from the sidecar are printed to the terminal where `make dev` is running.
    **后端 (Sidecar)**：Sidecar 的日志会打印到运行 `make dev` 的终端。
*   **Rust**: Check the terminal output for panic messages or detailed Rust logs.
    **Rust**：查看终端输出的 panic 信息或详细 Rust 日志。

### 4. Build for Production / 生产构建

To create a distributable installer for your OS:
为当前操作系统创建可分发的安装包：

```bash
make build
```

**Output / 输出:**
*   **macOS**: `frontend/src-tauri/target/release/bundle/dmg/*.dmg`
*   **Windows**: `frontend/src-tauri/target/release/bundle/msi/*.msi`
*   **Linux**: `frontend/src-tauri/target/release/bundle/appimage/*.AppImage`

### 5. Clean / 清理

To remove all generated files and reset the environment:
移除所有生成的文件并重置环境：

```bash
make clean
```

---

## Common Issues / 常见问题

### 1. Sidecar binary not found / 找不到 Sidecar 二进制文件

**Error**: `resource path 'horcrux-backend-...' doesn't exist`

**Solution**:
Ensure `make dev` or `make build` is used, as they explicitly call `scripts/build_sidecar.sh`. If running `pnpm tauri dev` directly, you must run the build script manually first.
确保使用 `make dev` 或 `make build`，因为它们会显式调用 `scripts/build_sidecar.sh`。如果直接运行 `pnpm tauri dev`，必须先手动运行构建脚本。

### 2. Port 7626 already in use / 端口 7626 已被占用

**Solution**:
The Makefile attempts to detect a free port for Vite, but the Go backend defaults to 7626.
*   Kill the process occupying 7626: `lsof -i :7626 | xargs kill`
*   Or use `make dev-web` which handles port detection for Vite more flexibly.
Makefile 会尝试检测 Vite 的空闲端口，但 Go 后端默认使用 7626。
*   杀掉占用 7626 的进程。
*   或使用 `make dev-web`，它能更灵活地处理 Vite 端口检测。

### 3. Rust/Cargo errors / Rust/Cargo 错误

**Solution**:
*   Update Rust: `rustup update stable`
*   Clean build cache: `make clean`
*   更新 Rust：`rustup update stable`
*   清理构建缓存：`make clean`
