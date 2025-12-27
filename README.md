<div align="center">
    <img src="frontend/horcrux-logo.svg" alt="Horcrux Logo" width="160">
    <h1>Horcrux</h1>
    <p><strong>Cool · Automated · Visualized</strong></p>
</div>

<div align="center">
    <a href="./README.md">🇺🇸 English</a> | <a href="./README-zh.md">🇨🇳 简体中文</a>
</div>

Horcrux is a modern container image synchronization tool designed to provide a secure, efficient, and visualized solution for cross-registry image synchronization. It combines an intuitive drag-and-drop workflow designer with a powerful background synchronization engine, making complex image migration tasks simple and controllable.

## 📦 Installation

### macOS

Download the `Horcrux.dmg` file from the [Releases](https://github.com/StartDT/Horcrux/releases) page, double-click to open it, and drag `Horcrux.app` to your Applications folder.

> Due to macOS Gatekeeper mechanisms, you may need to execute the following command to allow Horcrux to run:
> ```bash
> sudo xattr -cr /Applications/Horcrux.app
> ```

## ✨ Key Features

-   **🖥️ Core Dashboard**: Real-time monitoring of system status, task overview, and core metrics.
-   **🎨 Flow Designer**: Visual workflow designer. Quickly create synchronization pipelines by dragging and dropping Source and Target nodes.
-   **🔐 Auth Vault**: Secure credential management center. Centrally manages authentication information for various registries to ensure sensitive data security.
-   **📜 Sync History**: Detailed task history records. Provides complete logs and status tracking for every synchronization task.
-   **📱 Responsive Design**: Brand new optimized UI, perfectly adapting to desktop, tablet, and mobile devices.

## 🛠️ Development Guide

This project adopts the **Tauri + React (Frontend) + Go (Backend Sidecar)** architecture.

### Prerequisites

*   Node.js & pnpm
*   Go (>= 1.21)
*   Rust & Cargo (for Tauri build)

### Quick Start

1.  **Install Dependencies**:
    ```bash
    make install
    ```

2.  **Start Development Environment (Tauri + Sidecar)**:
    This is the recommended development mode, which starts both the frontend interface and the backend Sidecar service.
    ```bash
    make dev
    ```

3.  **Web-Only Development Mode**:
    If you only need to debug the frontend page layout, you can use this mode (backend functions are unavailable).
    ```bash
    make dev-web
    ```

### Build & Release

*   **Build Production Version**:
    ```bash
    make build
    ```

## 📖 Usage Guide

### How to Create a Sync Task?

1.  Enter the **Flow.Designer** page.
2.  **Add Nodes**:
    *   Click the first icon <kbd><Database /></kbd> in the top-left toolbar to add a **Source** (Source Registry).
    *   Click the third icon <kbd><ArrowRight /></kbd> to add a **Target** (Target Registry).
3.  **Configure Nodes**:
    *   Click on a node to configure the image address (e.g., `nginx:latest`) and authentication credentials in the right panel.
4.  **Connect & Execute**:
    *   The system will automatically identify Source and Target and establish a connection.
    *   Click **EXECUTE_SYNC** in the top right corner to start synchronization.
    *   Monitor real-time progress in the bottom right **Live_Task_Log**.

### Troubleshooting

*   Before executing sync, please ensure that the corresponding registry credentials have been added to `Auth.Vault` and tested successfully.
*   If synchronization fails, you can check the complete log of the historical task in the `Sync.History` page for troubleshooting at any time.
