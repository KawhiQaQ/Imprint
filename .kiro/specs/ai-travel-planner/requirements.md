# Requirements Document

## Introduction

AI旅行规划+日记系统是一款将智能旅行规划与即时日记生成相结合的MVP产品。用户通过自然语言描述旅行愿景，系统利用DeepSeek大模型进行语义分析，推荐目的地并协作生成个性化行程。旅途中，用户可记录语音、照片等素材，系统调用Qwen-VL和DeepSeek即时生成精美日记片段。旅程结束后，系统整合所有内容生成电子手账和旅行人格报告，并通过通义万相生成独特封面图。

## Glossary

- **Travel_Planner**: 旅行规划系统，负责处理用户愿景输入、目的地推荐和行程规划
- **Diary_Generator**: 日记生成系统，负责将用户素材转化为精美日记片段
- **Vision_Input**: 用户输入的模糊旅行愿景描述
- **Destination_Card**: 目的地推荐卡片，包含封面图、推荐理由和景点标签
- **Itinerary_Board**: 行程白板，展示结构化的旅行路书
- **Travel_Node**: 行程中的单个景点或地点节点
- **Diary_Fragment**: 单个节点生成的日记片段
- **Travel_Memoir**: 最终生成的完整电子手账
- **Personality_Report**: 基于旅行数据生成的旅行人格报告
- **DeepSeek_API**: 用于语义分析和文本生成的大模型API
- **Qwen_VL_API**: 通义千问视觉版API，用于图片内容识别
- **Wanx_API**: 通义万相API，用于生成水彩风格封面图
- **Tavily_API**: 联网搜索API，用于验证景点和店铺真实性
- **Unsplash_API**: 高清图片API，用于获取目的地封面图

## Requirements

### Requirement 1: 愿景输入与语义分析

**User Story:** As a 用户, I want to 用自然语言描述我的旅行愿景, so that 系统能理解我的模糊需求并转化为具体搜索条件。

#### Acceptance Criteria

1. WHEN 用户在首页输入框提交愿景描述 THEN THE Travel_Planner SHALL 调用DeepSeek_API进行语义分析
2. WHEN DeepSeek_API返回分析结果 THEN THE Travel_Planner SHALL 提取地理特征、气候偏好、美食需求等搜索条件
3. IF 用户输入为空或无法解析 THEN THE Travel_Planner SHALL 返回友好的提示信息引导用户重新输入
4. WHEN 语义分析完成 THEN THE Travel_Planner SHALL 在3秒内返回结构化的搜索条件

### Requirement 2: 目的地推荐与灵感盲盒

**User Story:** As a 用户, I want to 看到符合我愿景的目的地推荐, so that 我能从中选择心仪的旅行地点。

#### Acceptance Criteria

1. WHEN 搜索条件生成完成 THEN THE Travel_Planner SHALL 推荐3至4个符合条件的候选城市
2. WHEN 展示目的地推荐 THEN THE Travel_Planner SHALL 以卡片形式呈现，每张Destination_Card包含Unsplash_API获取的高清封面图、推荐理由和热门景点标签
3. WHEN 用户点击"换一批"按钮 THEN THE Travel_Planner SHALL 排除当前选项并重新检索新的候选城市
4. WHEN 用户选定某个目的地 THEN THE Travel_Planner SHALL 记录选择并进入行程规划阶段
5. IF Unsplash_API调用失败 THEN THE Travel_Planner SHALL 使用默认占位图并继续展示推荐内容

### Requirement 3: 交互式行程规划

**User Story:** As a 用户, I want to 通过自然语言与AI协作规划行程, so that 我能获得符合个性化需求的详细路书。

#### Acceptance Criteria

1. WHEN 用户进入规划阶段 THEN THE Travel_Planner SHALL 展示"左侧对话、右侧白板"的双栏布局
2. WHEN 用户在对话区输入偏好（如"我不吃辣"） THEN THE Travel_Planner SHALL 调用DeepSeek_API理解需求并更新行程建议
3. WHEN 生成景点或餐厅推荐 THEN THE Travel_Planner SHALL 调用Tavily_API验证其真实性和营业状态
4. WHEN 行程更新 THEN THE Itinerary_Board SHALL 在右侧白板实时展示结构化路书
5. WHEN 用户手动编辑路书 THEN THE Itinerary_Board SHALL 保存用户的修改并同步更新
6. THE Itinerary_Board SHALL 支持按天分组展示行程节点

### Requirement 4: 节点素材记录

**User Story:** As a 用户, I want to 在旅行中随时记录语音和照片, so that 这些素材能被用于生成日记。

#### Acceptance Criteria

1. WHEN 用户到达某个Travel_Node THEN THE Diary_Generator SHALL 允许用户上传照片和录入语音
2. WHEN 用户上传素材 THEN THE Diary_Generator SHALL 自动记录上传时间戳
3. WHEN 用户录入语音 THEN THE Diary_Generator SHALL 调用语音转写服务将其转为文本
4. THE Diary_Generator SHALL 支持单个节点记录多张照片和多段语音
5. IF 素材上传失败 THEN THE Diary_Generator SHALL 提示用户重试并保留本地缓存

### Requirement 5: AI即时日记生成

**User Story:** As a 用户, I want to 点亮节点后立即看到AI生成的日记片段, so that 我能即时享受记录的乐趣。

#### Acceptance Criteria

1. WHEN 用户点击"点亮"按钮 THEN THE Diary_Generator SHALL 调用Qwen_VL_API识别照片内容
2. WHEN 图片识别完成 THEN THE Diary_Generator SHALL 将识别结果、语音转写文本和时间信息发送给DeepSeek_API
3. WHEN DeepSeek_API返回结果 THEN THE Diary_Generator SHALL 生成约100字的第一人称Diary_Fragment
4. WHEN Diary_Fragment生成完成 THEN THE Diary_Generator SHALL 立即展示给用户并支持即时修改
5. THE Diary_Fragment SHALL 包含图文并茂的排版，体现不同时间段的心情感受
6. IF Qwen_VL_API调用失败 THEN THE Diary_Generator SHALL 仅基于语音文本和时间生成日记片段

### Requirement 6: 旅行回忆录生成

**User Story:** As a 用户, I want to 旅行结束后获得一本精美的电子手账, so that 我能珍藏和分享这段旅行回忆。

#### Acceptance Criteria

1. WHEN 用户点击"完成旅程" THEN THE Diary_Generator SHALL 整合所有Diary_Fragment、照片和心情Emoji
2. WHEN 整合完成 THEN THE Diary_Generator SHALL 调用DeepSeek_API分析全程数据生成Personality_Report
3. THE Personality_Report SHALL 嵌入在Travel_Memoir的倒数第二页
4. WHEN 报告生成完成 THEN THE Diary_Generator SHALL 调用Wanx_API生成水彩风封面图和尾图
5. THE Travel_Memoir SHALL 使用预设的CSS模板进行排版（日系小清新、复古牛皮纸、极简黑白等3-4种）
6. WHEN Travel_Memoir生成完成 THEN THE Diary_Generator SHALL 提供下载和分享功能

### Requirement 7: 日记模板系统

**User Story:** As a 用户, I want to 选择不同风格的日记模板, so that 我的旅行回忆录能呈现我喜欢的视觉风格。

#### Acceptance Criteria

1. THE Travel_Memoir SHALL 提供3-4种预设CSS模板供用户选择
2. WHEN 用户选择模板 THEN THE Diary_Generator SHALL 将数据填入对应的HTML模板中渲染
3. THE 模板系统 SHALL 支持日系小清新、复古牛皮纸、极简黑白等风格
4. WHEN 切换模板 THEN THE Travel_Memoir SHALL 实时预览新模板效果

### Requirement 8: 数据持久化

**User Story:** As a 用户, I want to 我的旅行数据被安全保存, so that 我能随时查看和继续编辑我的旅程。

#### Acceptance Criteria

1. THE Travel_Planner SHALL 将用户的愿景、目的地选择和行程数据持久化存储
2. THE Diary_Generator SHALL 将所有素材和生成的日记片段持久化存储
3. WHEN 用户重新访问 THEN THE 系统 SHALL 恢复用户之前的旅程状态
4. THE 系统 SHALL 支持用户查看历史旅程列表
5. IF 存储操作失败 THEN THE 系统 SHALL 提示用户并提供重试选项
