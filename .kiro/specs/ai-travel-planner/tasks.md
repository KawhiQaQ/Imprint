# Implementation Plan: AI旅行规划+日记系统

## Overview

本实现计划采用渐进式开发策略，从项目基础设施开始，逐步构建核心服务、API层和前端界面。优先实现核心AI功能（愿景分析、目的地推荐、日记生成），确保MVP快速可用。

## Tasks

- [x] 1. 项目初始化与基础设施
  - [x] 1.1 初始化项目结构
    - 创建monorepo结构：`/backend`（Node.js + Express）和 `/frontend`（React + TypeScript）
    - 配置TypeScript、ESLint、Prettier
    - 设置package.json和依赖管理
    - _Requirements: 8.1_

  - [x] 1.2 配置数据库和存储
    - 创建SQLite数据库初始化脚本
    - 实现所有表的创建（users, trips, itineraries, travel_nodes, node_materials, photo_materials, voice_recordings, diary_fragments, travel_memoirs, chat_history）
    - 配置文件存储目录结构
    - _Requirements: 8.1, 8.2_

  - [x] 1.3 配置外部API客户端
    - 创建环境变量配置（.env.example）
    - 实现DeepSeek API客户端基础类
    - 实现Qwen-VL API客户端基础类
    - 实现Wanx API客户端基础类
    - 实现Unsplash API客户端基础类
    - 实现Tavily API客户端基础类
    - _Requirements: 1.1, 2.2, 3.3, 5.1, 6.4_

- [x] 2. 存储服务实现
  - [x] 2.1 实现StorageService核心方法
    - 实现Trip CRUD操作（createTrip, getTrip, updateTrip, getUserTrips）
    - 实现Itinerary持久化（saveItinerary, getItinerary）
    - 实现DiaryFragment持久化（saveDiaryFragment, getDiaryFragments）
    - 实现文件存储（saveFile, getFile）
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [ ]* 2.2 编写StorageService属性测试
    - **Property 6: Data Persistence Round-Trip**
    - **Validates: Requirements 3.5, 8.1, 8.2, 8.3**

  - [ ]* 2.3 编写StorageService单元测试
    - 测试数据库连接失败处理
    - 测试并发写入处理
    - _Requirements: 8.5_

- [x] 3. 愿景分析服务实现
  - [x] 3.1 实现VisionService
    - 实现analyzeVision方法
    - 编写DeepSeek愿景分析Prompt
    - 实现SearchConditions解析逻辑
    - 实现输入验证（空输入、超长输入）
    - _Requirements: 1.1, 1.2, 1.3_

  - [ ]* 3.2 编写VisionService属性测试
    - **Property 1: Vision Analysis Completeness**
    - **Validates: Requirements 1.1, 1.2**

  - [x] 3.3 实现愿景分析API端点
    - POST /api/vision/analyze
    - 添加请求验证中间件
    - 添加错误处理
    - _Requirements: 1.1, 1.2, 1.3_

- [x] 4. Checkpoint - 确保所有测试通过
  - 运行所有测试，确保愿景分析功能正常
  - 如有问题请询问用户

- [x] 5. 目的地推荐服务实现
  - [x] 5.1 实现DestinationService
    - 实现recommendDestinations方法
    - 编写DeepSeek目的地推荐Prompt
    - 实现Unsplash图片获取（fetchCoverImage）
    - 实现排除城市逻辑
    - 实现Unsplash失败时的默认图片降级
    - _Requirements: 2.1, 2.2, 2.3, 2.5_

  - [ ]* 5.2 编写DestinationService属性测试
    - **Property 2: Destination Recommendation Count and Completeness**
    - **Property 3: Destination Exclusion Correctness**
    - **Validates: Requirements 2.1, 2.2, 2.3**

  - [x] 5.3 实现目的地API端点
    - POST /api/destinations/recommend
    - POST /api/destinations/select
    - _Requirements: 2.1, 2.4_

  - [ ]* 5.4 编写Trip状态转换属性测试
    - **Property 4: Trip State Transition**
    - **Validates: Requirements 2.4**

- [x] 6. 行程规划服务实现
  - [x] 6.1 实现ItineraryService核心方法
    - 实现generateItinerary方法
    - 编写DeepSeek行程生成Prompt
    - 实现updateWithPreference方法（对话式更新）
    - 实现Tavily验证（verifyNode）
    - 实现手动更新节点（manualUpdateNode）
    - _Requirements: 3.2, 3.3, 3.5, 3.6_

  - [ ]* 6.2 编写ItineraryService属性测试
    - **Property 5: Itinerary Day Grouping**
    - **Validates: Requirements 3.6**

  - [x] 6.3 实现行程API端点
    - GET /api/trips/:tripId/itinerary
    - POST /api/trips/:tripId/itinerary/chat
    - PUT /api/trips/:tripId/itinerary/nodes/:nodeId
    - POST /api/trips/:tripId/itinerary/nodes/:nodeId/verify
    - _Requirements: 3.2, 3.3, 3.5_

- [x] 7. Checkpoint - 确保所有测试通过
  - 运行所有测试，确保规划功能正常
  - 如有问题请询问用户

- [x] 8. 日记生成服务实现
  - [x] 8.1 实现DiaryService素材上传
    - 实现uploadPhoto方法
    - 实现uploadVoice方法
    - 实现自动时间戳记录
    - 实现语音转写（transcribeVoice）
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [ ]* 8.2 编写素材上传属性测试
    - **Property 7: Material Upload Timestamp**
    - **Property 8: Multi-Material Support**
    - **Validates: Requirements 4.2, 4.4**

  - [x] 8.3 实现DiaryService日记生成
    - 实现analyzePhoto方法（调用Qwen-VL）
    - 实现generateDiaryFragment方法
    - 编写DeepSeek日记生成Prompt
    - 实现Qwen-VL失败时的降级生成
    - 实现updateFragment方法
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6_

  - [ ]* 8.4 编写日记生成属性测试
    - **Property 9: Diary Fragment Length Constraint**
    - **Property 10: Diary Fragment Edit Round-Trip**
    - **Validates: Requirements 5.3, 5.4**

  - [x] 8.5 实现日记API端点
    - POST /api/trips/:tripId/nodes/:nodeId/photos
    - POST /api/trips/:tripId/nodes/:nodeId/voice
    - POST /api/trips/:tripId/nodes/:nodeId/light
    - PUT /api/diary-fragments/:fragmentId
    - GET /api/trips/:tripId/diary-fragments
    - _Requirements: 4.1, 5.1, 5.4_

- [x] 9. 回忆录服务实现
  - [x] 9.1 实现MemoirService核心方法
    - 实现generateMemoir方法
    - 实现generatePersonalityReport方法
    - 编写DeepSeek人格报告Prompt
    - 实现generateCoverImage方法（调用Wanx）
    - 实现generateEndImage方法（调用Wanx）
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [ ]* 9.2 编写回忆录属性测试
    - **Property 11: Memoir Fragment Inclusion**
    - **Property 12: Memoir Structure Completeness**
    - **Validates: Requirements 6.1, 6.3, 6.5**

  - [x] 9.3 实现模板系统
    - 创建3-4种CSS模板（日系小清新、复古牛皮纸、极简黑白）
    - 实现applyTemplate方法
    - 实现getAvailableTemplates方法
    - _Requirements: 7.1, 7.2, 7.3_

  - [ ]* 9.4 编写模板渲染属性测试
    - **Property 13: Template Rendering Data Integrity**
    - **Validates: Requirements 7.2**

  - [x] 9.5 实现回忆录API端点
    - POST /api/trips/:tripId/complete
    - GET /api/trips/:tripId/memoir
    - PUT /api/trips/:tripId/memoir/template
    - GET /api/memoir-templates
    - _Requirements: 6.1, 6.6, 7.1, 7.4_

- [x] 10. Checkpoint - 确保所有后端测试通过
  - 运行所有后端测试
  - 如有问题请询问用户

- [x] 11. 前端基础设施
  - [x] 11.1 初始化React项目
    - 使用Vite创建React + TypeScript项目
    - 配置路由（React Router）
    - 配置状态管理
    - 配置API客户端（axios）
    - _Requirements: 所有前端相关_

  - [x] 11.2 创建通用组件和样式
    - 创建基础UI组件（Button, Input, Card, Loading）
    - 配置全局样式和主题
    - 创建响应式布局基础
    - _Requirements: 所有前端相关_

- [x] 12. 首页与愿景输入
  - [x] 12.1 实现HomePage和VisionInput组件
    - 创建极简首页布局
    - 实现愿景输入框组件
    - 实现提交和加载状态
    - 连接愿景分析API
    - _Requirements: 1.1, 1.3_

- [x] 13. 目的地选择页
  - [x] 13.1 实现DestinationPage和DestinationCard组件
    - 创建目的地选择页面布局
    - 实现DestinationCard组件（封面图、推荐理由、标签）
    - 实现"换一批"功能
    - 实现目的地选择和跳转
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 14. 行程规划页
  - [x] 14.1 实现PlanningPage双栏布局
    - 创建左侧对话面板（ChatPanel）
    - 创建右侧行程白板（ItineraryBoard）
    - 实现对话消息发送和接收
    - _Requirements: 3.1, 3.2_

  - [x] 14.2 实现ItineraryBoard组件
    - 实现按天分组展示
    - 实现节点拖拽排序
    - 实现节点编辑功能
    - 实现验证状态显示
    - _Requirements: 3.4, 3.5, 3.6_

- [x] 15. Checkpoint - 确保规划流程可用
  - 测试愿景→目的地→行程的完整流程
  - 如有问题请询问用户

- [x] 16. 旅行执行页
  - [x] 16.1 实现TravelingPage和NodeRecorder组件
    - 创建旅行执行页面布局
    - 实现节点列表展示
    - 实现NodeRecorder组件（照片上传、语音录制）
    - 实现"点亮"按钮和日记生成
    - _Requirements: 4.1, 4.2, 4.3, 5.1_

  - [x] 16.2 实现DiaryFragment组件
    - 实现日记片段展示
    - 实现即时编辑功能
    - 实现心情Emoji选择
    - _Requirements: 5.4, 5.5_

- [x] 17. 回忆录页面
  - [x] 17.1 实现MemoirPage和MemoirViewer组件
    - 创建回忆录查看页面
    - 实现模板选择器（TemplateSelector）
    - 实现回忆录渲染展示
    - 实现人格报告展示
    - _Requirements: 6.3, 7.1, 7.4_

  - [x] 17.2 实现分享和下载功能
    - 实现回忆录下载（HTML/PDF）
    - 实现分享链接生成
    - _Requirements: 6.6_

- [x] 18. 历史旅程页
  - [x] 18.1 实现HistoryPage
    - 创建历史旅程列表页面
    - 实现旅程卡片展示
    - 实现旅程状态筛选
    - 实现继续/查看功能
    - _Requirements: 8.3, 8.4_

  - [ ]* 18.2 编写用户旅程历史属性测试
    - **Property 14: User Trip History Completeness**
    - **Validates: Requirements 8.4**

- [x] 19. 最终集成与优化
  - [x] 19.1 端到端流程测试
    - 测试完整的愿景→目的地→行程→日记→回忆录流程
    - 修复发现的问题
    - _Requirements: 所有_

  - [x] 19.2 错误处理和用户体验优化
    - 添加全局错误边界
    - 优化加载状态展示
    - 添加操作反馈提示
    - _Requirements: 1.3, 2.5, 4.5, 5.6, 8.5_

- [-] 20. Final Checkpoint - 确保所有测试通过
  - 运行所有测试（单元测试、属性测试）
  - 确保MVP功能完整可用
  - 如有问题请询问用户

## Notes

- 标记 `*` 的任务为可选任务，可跳过以加快MVP开发
- 每个任务都引用了具体的需求条款以确保可追溯性
- Checkpoint任务用于阶段性验证，确保增量开发的稳定性
- 属性测试验证通用正确性属性，单元测试验证具体示例和边界情况
