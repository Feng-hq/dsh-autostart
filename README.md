# dsh-autostart · DSH 开机自启动

让 DeepSeek Harness 桌面版随 Windows 登录自动启动，并把这个偏好交给用户自己开关。

- **安装即开启**：bundle 插入时默认 `enabled: true`，插件激活后立即把登录项写入注册表。
- **开关位置**：设置 → 通用 → 「开机自启动」一行，带官方样式的开关；关掉会删除登录项，打开会重新写入。
- **不改动应用本体**：只维护当前用户的登录项
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `wscript.exe //nologo "<profile>\dsh-autostart\launch.vbs"`，
  不使用计划任务、不申请管理员权限。登录项指向插件生成的启动器（见下节），而不是 exe 本身。
- **状态以配置为准**：偏好保存在 `<profile>/dsh-autostart.config.json`；每次激活时按配置重新校准注册表。

## 为什么登录项指向一个启动器

DSH 桌面版启动时用 `--port 0` 让系统分配端口，再把结果 URL 交给 Electron 壳去 `fetch()` 换 cookie，
而 `fetch`（undici）会拒绝规范里的 blocked port（`bad port`）。本机的动态端口段是 1024–15000，
其中 17 个端口在名单里（1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665–6669, 6697, 10080），
所以约每 800 次开机就会有一次启动直接失败，弹出致命错误对话框。DSH 没有提供端口覆盖参数。

登录项因此指向生成的 `launch.vbs`（无窗口）→ `launch.ps1`：

1. 短暂占住那 17 个 blocked 端口，让本次启动不可能拿到它们（实测占住期间外部 bind 全部被拒，2000 次 `bind(0)` 抽样 0 命中）；
2. 启动 DeepSeek Harness，轮询到 DSH 进程已在 127.0.0.1 上监听后立刻释放端口；
3. 若进程早退且新崩溃报告里是 `bad port`，重试（最多 3 次）；单次失败率仅约 0.12%，重试一次几乎必成；
4. 全过程写 `<profile>\dsh-autostart\launch.log`，出问题可直接看。

已经有一个 DSH 在运行时不重复启动。想回到最朴素的写入方式，把 `launchMode` 设为 `direct`（此时登录项就是 `"<exe>"`）。

## 实现

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| Host | `index.js` | 读写注册表登录项、持久化偏好、注册 `/plugins/dsh-autostart/{state,config}` 路由 |
| Host | `launcher.js` | 生成 `launch.ps1` / `launch.vbs`、拼出登录项命令 |
| Browser | `client.js` | 在 `settings.general.item` 注册一行开关，可选语言（中文/英文） |

配置项：`enabled`（默认 `true`）、`exePath`（默认留空 = 自动取当前桌面进程的 `process.execPath`）、
`launchMode`（默认 `launcher`；`direct` = 登录项直接写 exe）。

## 卸载

在插件管理里卸载或停用前，请先把「开机自启动」关掉，插件会移除登录项；插件停用后不再运行任何逻辑。
没关就卸载的话，登录项会留在注册表里，可手动删除：

```powershell
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'DeepSeek Harness'
```

## 验证记录

- `GET /plugins/dsh-autostart/state` 报告 `active: true`，注册表值与插件期望的命令一致。
- 通过路由关掉开关 → 登录项立即消失；再打开 → 立即恢复。
- 绕过插件手工删除登录项后重新激活插件 → 自动补写（自愈）。
- `settings.general.item` 槽位里 `dsh-autostart` 已注册（order 95、active），即设置页真实出现这一行。
- 围栏：空请求体 400、外站 `Origin` 403；`node test/smoke.mjs` 全部通过（该测试使用独立的测试值名，不触碰真实登录项）。
- 启动器：逐个跑过三种真实场景——已有 DSH 在运行（不重复启动）、子进程立刻退出（重试 2 次后放弃）、
  子进程长时间启动（期间占住端口生效、外部 bind 被拒、退出后释放）；`launch.log` 记录完整。
- 装机后实测：登录项 = `wscript.exe //nologo "<profile>\dsh-autostart\launch.vbs"`，`state.launcher.ready=true`；
  `cscript //nologo launch.vbs` 语法检查通过并真的拉起 `launch.ps1`（日志逐行写入）；
  开关关掉再打开，登录项与配置文件同步往返一次，值逐字节一致。
- 尚未实测的部分：真实 Windows 注销/重启后的自动拉起（需重启才能观察，机制就是标准 HKCU Run）。
