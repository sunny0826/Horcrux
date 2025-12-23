### **注意事项**
*   执行同步前，请确保已经在 `Auth.Vault` 中添加了对应的仓库凭证并测试通过。
*   如果同步失败，您可以随时在 `Sync.History` 页面查看历史任务的完整日志进行排查。

### **如何操作创建任务？**

请按照以下步骤在 `Flow.Designer` 中创建并运行您的同步任务：

1.  **添加节点**：
    *   点击左上角工具栏的第一个图标 <kbd><Database size={12} /></kbd> 添加 **Source**（源仓库）。
    *   点击第三个图标 <kbd><ArrowRight size={12} /></kbd> 添加 **Target**（目标仓库）。
2.  **配置节点数据**（**关键步骤**）：
    *   **点击 Source 节点**：在右侧面板的 **Image_Reference** 中输入源镜像（例如 `nginx:latest`），并选择对应的凭证。
    *   **点击 Target 节点**：在右侧面板输入目标镜像地址（例如 `registry.cn-hangzhou.aliyuncs.com/myrepo/nginx:latest`），并选择目标仓库凭证。
3.  **连接节点**（可选）：
    *   目前系统会自动寻找图中的 Source 和 Target 节点。您可以拖动锚点连线以方便视觉管理。
4.  **开始执行**：
    *   点击右上角的 **EXECUTE_SYNC**。
    *   观察右下角的 **Live_Task_Log**，同步完成后会有绿色 `SUCCESS` 标识。

您可以随时在 `Sync.History` 页面查看该任务的持久化记录和完整日志。