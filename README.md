# Mkg Web

MK 导演画布 Web 运行包。

## 环境要求

- Node.js 24 或更高版本
- npm
- FFmpeg / FFprobe（视频缩略图、代理和剪切功能需要）

首次运行先安装依赖：

```bash
npm install
```

## 快速开始（Windows）

直接双击 `start.bat`，或命令行运行：

```bat
cd /d <项目目录>
start.bat
```

启动后浏览器打开：**http://127.0.0.1:4080/**

也可以直接运行：

```bash
npm start
```

---

## 目录结构

```text
.
├─ start.bat            # 一键启动脚本
├─ scripts\start.mjs    # 跨平台启动入口与本地环境探测
├─ package.json         # Node.js 项目配置和运行脚本
├─ vendor\ftv-shared\   # 后端使用的本地共享包
├─ web\                 # 前端 SPA 构建产物
│   ├─ index.html
│   ├─ assets\          # JS/CSS 打包产物
│   ├─ models\ mediapipe\ motions\ rigs\ emotion-poses\   # 浏览器端模型/资源
├─ server\dist\         # 后端 Express 服务
├─ node_modules\        # 本地依赖，不提交到 Git
├─ runtime\             # 可选的本地 Node/FFmpeg，不提交到 Git
├─ data\                # 本地数据库，不提交到 Git
└─ uploads\             # 本地上传文件，不提交到 Git
```

`runtime/`、`node_modules/`、`data/` 和 `uploads/` 属于本地环境或用户数据，已通过 `.gitignore` 排除。`start.bat` 会依次查找 `runtime\node\node.exe`、旧版 `node-runtime.exe` 或系统 `node`。

---

## 验证结果（已实测）

| 检查项 | 结果 |
|---|---|
| `GET /health` | `{"ok":true,"service":"mk-server","ffmpeg":false,"ffprobe":false}` |
| `GET /`（首页） | HTTP 200，标题「MK 导演画布」 |
| `GET /assets/index-*.js` | HTTP 200（前端打包产物加载正常） |
| `GET /api/settings/generation-timeouts` | HTTP 200（后端 API 正常） |
| `GET /favicon_multi.ico` | HTTP 200（静态资源正常） |
| 深链接回退（如 `/any/route`） | HTTP 200（SPA 路由正常） |

---

## 可用范围与降级说明

核心功能（项目管理、角色/素材库、画布、历史资产、生成工作流接口等）**可直接使用**。
以下高级能力在本发行包中**原本就未随附对应脚本/外部程序**，因此会优雅降级（不影响启动与核心使用）：

| 功能 | 依赖 | 状态 |
|---|---|---|
| 文件缩略图、视频播放代理、裁剪/截取/智能切割、深度与音频分离 | FFmpeg / FFprobe | 启动脚本会自动识别 `runtime/ffmpeg/bin`，也可通过环境变量或 PATH 配置；未配置时仅该功能不可用 |
| 动作捕捉 / 导演视频导出（motion / director-video-export） | Python 工作脚本 `scripts/motion-worker/worker.py` 等 | 原发行包未包含这些脚本，对应导出功能暂不可用 |
| Blender / Photoshop / UE5 相关任务 | 对应桌面软件 | 原发行包未包含，对应功能暂不可用 |

> 说明：FFmpeg 是唯一「配置路径后即可用」的依赖，配置后即可恢复缩略图、视频代理与切割等能力。其余功能需要原项目的 Python 脚本与第三方软件，属于发行包本身未提供，并非转换导致。

---

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `4000` | 监听端口（脚本中设为 4080） |
| `MK_SERVER_HOST` | `127.0.0.1` | 绑定地址；`0.0.0.0` 可允许局域网/远程访问 |
| `MK_WEB_DIST_DIR` | 无（不托管前端） | 前端构建目录；本脚本已指向 `web` |
| `MK_DATA_DIR` | `server/../data` | SQLite 与运行时数据目录 |
| `MK_UPLOADS_DIR` | `server/../uploads` | 上传目录 |
| `MK_FFMPEG_PATH` / `MK_FFPROBE_PATH` | `ffmpeg` / `ffprobe` | 指定外部 FFmpeg 路径 |
| `MK_CORS_ORIGINS` | 无 | 逗号分隔的允许跨域来源（前端与后端不同源时才需要） |
| `MK_PUBLIC_ORIGIN` | 无 | 对外公开地址（反向代理 / 远程部署时使用） |

---

## 想做成「可被远程访问的网站」？

当前默认仅本机（`127.0.0.1`）可访问。若要让同局域网或公网访问：

1. 在 `start.bat` 中设置 `set MK_SERVER_HOST=0.0.0.0`；
2. 若前端与后端不同源（例如用 Nginx 反代或独立域名），设置 `MK_CORS_ORIGINS` 与 `MK_PUBLIC_ORIGIN`；
3. 在服务器上安装 FFmpeg；
4. 注意：动作捕捉 / 视频导出等仍依赖原项目未随附的 Python 脚本与第三方软件，远程部署同样不可用，除非把这些资产一并迁移。

---

## 停止服务

直接关闭运行 `start.bat` 的终端窗口即可；或在任务管理器中结束对应的 Node 进程。
（程序已注册 `SIGINT/SIGTERM` 优雅退出，会正常关闭数据库与后台任务。）
