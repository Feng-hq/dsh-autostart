# dsh-autostart · DSH 开机自启动

让 DeepSeek Harness 桌面版随 Windows 登录自动启动，并把这个偏好交给用户自己开关。

- **安装即开启**：bundle 插入时默认 `enabled: true`，插件激活后立即把登录项写入注册表。
- **开关位置**：设置 → 通用 → 「开机自启动」一行，带官方样式的开关；关掉会删除登录项，打开会重新写入。
- **不改动应用本体**：只维护当前用户的登录项
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `"<DeepSeek Harness.exe>"`，
  不使用计划任务、不申请管理员权限、不常驻后台进程。
- **状态以配置为准**：偏好保存在 `<profile>/dsh-autostart.config.json`；每次激活时按配置重新校准注册表。

## 实现

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| Host | `index.js` | 读写注册表登录项、持久化偏好、注册 `/plugins/dsh-autostart/{state,config}` 路由 |
| Browser | `client.js` | 在 `settings.general.item` 注册一行开关，可选语言（中文/英文） |

配置项：`enabled`（默认 `true`）、`exePath`（默认留空 = 自动取当前桌面进程的 `process.execPath`）。

## 卸载

在插件管理里卸载或停用前，请先把「开机自启动」关掉，插件会移除登录项；插件停用后不再运行任何逻辑。
没关就卸载的话，登录项会留在注册表里，可手动删除：

```powershell
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'DeepSeek Harness'
```

## 验证记录

- `GET /plugins/dsh-autostart/state` 报告 `active: true`，注册表值与可执行文件一致。
- 通过路由关掉开关 → 登录项立即消失；再打开 → 立即恢复。
- 绕过插件手工删除登录项后重新激活插件 → 自动补写（自愈）。
- `settings.general.item` 槽位里 `dsh-autostart` 已注册（order 95、active），即设置页真实出现这一行。
- 围栏：空请求体 400、外站 `Origin` 403；`node test/smoke.mjs` 全部通过（该测试使用独立的测试值名，不触碰真实登录项）。
- 尚未实测的部分：真实 Windows 注销/重启后的自动拉起（需重启才能观察，机制就是标准 HKCU Run）。
