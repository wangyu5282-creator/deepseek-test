# DeepSeek Chat Application

一个基于 DeepSeek API 的对话应用，支持流式输出、联网搜索和思维链展示。

## 功能特性

- 💬 流式对话体验
- 🔍 联网搜索功能
- 🧠 思维链可视化
- 📊 Token 使用统计
- 🔐 口令访问保护
- ⚡ 多模型切换（v4-flash / v4-pro）
- 🎯 推理强度调节（low / high / max）

## 技术栈

**前端：** React + Vite  
**后端：** Node.js + Express  
**API：** DeepSeek AI

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/wangyu5282-creator/deepseek-test.git
cd deepseek-test
```

### 2. 配置后端

```bash
cd server
npm install
```

创建 `.env` 文件：

```env
DEEPSEEK_API_KEY=your_api_key_here
ACCESS_PASSWORD=your_password_here
PORT=3001
```

启动后端：

```bash
npm start
```

### 3. 配置前端

```bash
cd ../web
npm install
```

创建 `.env` 文件：

```env
VITE_API_BASE=http://localhost:3001
```

启动前端：

```bash
npm run dev
```

访问 http://localhost:5173

## 部署到生产环境

### 方案 A：Vercel（推荐）

1. Fork 本项目到你的 GitHub
2. 在 Vercel 导入项目
3. 配置环境变量：
   - `DEEPSEEK_API_KEY`
   - `ACCESS_PASSWORD`（可选）
4. 部署完成

### 方案 B：Railway

1. 在 Railway 创建新项目
2. 连接 GitHub 仓库
3. 添加环境变量
4. 自动部署

### 方案 C：自建服务器

```bash
# 构建前端
cd web
npm run build

# 后端提供静态文件
cd ../server
# 修改 index.js 添加静态文件服务
npm start
```

## 环境变量说明

### 后端环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `DEEPSEEK_API_KEY` | ✅ | DeepSeek API 密钥 |
| `ACCESS_PASSWORD` | ❌ | 访问口令（不设置则无需登录） |
| `PORT` | ❌ | 服务端口（默认 3001） |
| `DEEPSEEK_BASE_URL` | ❌ | API 地址（默认官方地址） |

### 前端环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `VITE_API_BASE` | ✅ | 后端 API 地址 |

## 获取 DeepSeek API Key

1. 访问 [DeepSeek 开放平台](https://platform.deepseek.com/)
2. 注册/登录账号
3. 进入控制台创建 API Key
4. 复制密钥到环境变量

## 项目结构

```
deepseek-chat/
├── server/          # 后端服务
│   ├── index.js     # Express 服务器
│   ├── package.json
│   └── .env.example
├── web/             # 前端应用
│   ├── src/
│   │   ├── App.jsx  # 主应用组件
│   │   └── storage.js
│   ├── package.json
│   └── .env.example
└── README.md
```

## License

MIT
