# <img src="frontend/horcrux-logo.svg" alt="Horcrux Logo" width="30"> Horcrux



Horcrux 是一个现代化的容器镜像同步工具，旨在提供安全、高效且可视化的跨仓库镜像同步解决方案。它结合了直观的拖拽式工作流设计器和强大的后台同步引擎，让复杂的镜像迁移任务变得简单可控。

## 📦 安装

### macOS

在 Release 页面下载 Horcrux.dmg 文件后，双击打开，将 Horcrux.app 拖动到 Applications 文件夹即可。

> 由于 macOS 的 Gatekeeper 机制，需要执行以下命令来允许 Horcrux 运行：
> ```bash
> sudo xattr -cr /Applications/Horcrux.app
> ```

## ✨ 主要特性

-   **🖥️ Core Dashboard**: 实时监控系统状态、任务运行概览及核心指标。
-   **🎨 Flow Designer**: 可视化工作流设计器。支持通过拖拽 Source（源）和 Target（目标）节点快速创建同步管道。
-   **🔐 Auth Vault**: 安全的凭证管理中心。集中管理各类 Registry 的认证信息，确保敏感数据安全。
-   **📜 Sync History**: 详尽的任务历史记录。提供每一次同步任务的完整日志和状态追踪。
-   **📱 响应式设计**: 全新优化的 UI，完美适配桌面端、平板和移动端设备。

## 🛠️ 开发指南

本项目采用 Tauri + React (Frontend) + Go (Backend Sidecar) 架构。

### 环境要求

*   Node.js & pnpm
*   Go (>= 1.21)
*   Rust & Cargo (用于 Tauri 构建)

### 快速开始

1.  **安装依赖**:
    ```bash
    make install
    ```

2.  **启动开发环境 (Tauri + Sidecar)**:
    这是推荐的开发模式，会同时启动前端界面和后端 Sidecar 服务。
    ```bash
    make dev
    ```

3.  **仅 Web 开发模式**:
    如果您只需要调试前端页面布局，可以使用此模式（此时后端功能不可用）。
    ```bash
    make dev-web
    ```

### 构建与发布

*   **构建生产版本**:
    ```bash
    make build
    ```

## 📖 使用指南

### 如何创建同步任务？

1.  进入 **Flow.Designer** 页面。
2.  **添加节点**：
    *   点击左上角工具栏的第一个图标 <kbd><Database /></kbd> 添加 **Source**（源仓库）。
    *   点击第三个图标 <kbd><ArrowRight /></kbd> 添加 **Target**（目标仓库）。
3.  **配置节点**:
    *   点击节点，在右侧面板配置镜像地址（如 `nginx:latest`）和认证凭证。
4.  **连接与执行**:
    *   系统会自动识别 Source 和 Target 并建立连接。
    *   点击右上角的 **EXECUTE_SYNC** 开始同步。
    *   在右下角 **Live_Task_Log** 观察实时进度。

### 遇到问题？

*   执行同步前，请确保已经在 `Auth.Vault` 中添加了对应的仓库凭证并测试通过。
*   如果同步失败，您可以随时在 `Sync.History` 页面查看历史任务的完整日志进行排查。
