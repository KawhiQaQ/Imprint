-- 用户表
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 旅程表
CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    vision_text TEXT,
    destination TEXT,
    status TEXT CHECK(status IN ('planning', 'traveling', 'completed')),
    is_saved_to_shelf INTEGER DEFAULT 0,
    search_conditions JSON,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 行程表
CREATE TABLE IF NOT EXISTS itineraries (
    id TEXT PRIMARY KEY,
    trip_id TEXT UNIQUE REFERENCES trips(id),
    destination TEXT,
    total_days INTEGER,
    user_preferences JSON,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 行程节点表
CREATE TABLE IF NOT EXISTS travel_nodes (
    id TEXT PRIMARY KEY,
    itinerary_id TEXT REFERENCES itineraries(id),
    name TEXT,
    type TEXT CHECK(type IN ('attraction', 'restaurant', 'hotel', 'transport')),
    address TEXT,
    description TEXT,
    estimated_duration INTEGER,
    scheduled_time TEXT,
    day_index INTEGER,
    node_order INTEGER,
    verified BOOLEAN DEFAULT FALSE,
    verification_info TEXT,
    is_lit BOOLEAN DEFAULT FALSE,
    time_slot TEXT,
    activity TEXT,
    -- 节点状态相关字段
    node_status TEXT DEFAULT 'normal' CHECK(node_status IN ('normal', 'changed', 'unrealized', 'changed_original')),
    status_reason TEXT,
    parent_node_id TEXT REFERENCES travel_nodes(id),
    -- 扩展信息
    price_info TEXT,
    ticket_info TEXT,
    tips TEXT,
    -- 交通信息
    transport_mode TEXT,
    transport_duration INTEGER,
    transport_note TEXT,
    -- 大型景区起点标识
    is_starting_point BOOLEAN DEFAULT FALSE,
    scenic_area_name TEXT
);

-- 节点素材表
CREATE TABLE IF NOT EXISTS node_materials (
    id TEXT PRIMARY KEY,
    node_id TEXT REFERENCES travel_nodes(id),
    mood_emoji TEXT
);

-- 照片素材表
CREATE TABLE IF NOT EXISTS photo_materials (
    id TEXT PRIMARY KEY,
    material_id TEXT REFERENCES node_materials(id),
    url TEXT,
    upload_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    vision_analysis TEXT
);

-- 语音记录表
CREATE TABLE IF NOT EXISTS voice_recordings (
    id TEXT PRIMARY KEY,
    material_id TEXT REFERENCES node_materials(id),
    audio_url TEXT,
    upload_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    transcription TEXT
);

-- 日记片段表
CREATE TABLE IF NOT EXISTS diary_fragments (
    id TEXT PRIMARY KEY,
    trip_id TEXT REFERENCES trips(id),
    node_id TEXT REFERENCES travel_nodes(id),
    content TEXT,
    time_range TEXT,
    mood_emoji TEXT,
    weather TEXT,
    text_notes TEXT,
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_edited BOOLEAN DEFAULT FALSE
);

-- 回忆录表
CREATE TABLE IF NOT EXISTS travel_memoirs (
    id TEXT PRIMARY KEY,
    trip_id TEXT UNIQUE REFERENCES trips(id),
    title TEXT,
    cover_image_url TEXT,
    end_image_url TEXT,
    opening_text TEXT,
    closing_text TEXT,
    template_id TEXT,
    personality_report JSON,
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    share_url TEXT
);

-- 对话历史表
CREATE TABLE IF NOT EXISTS chat_history (
    id TEXT PRIMARY KEY,
    trip_id TEXT REFERENCES trips(id),
    role TEXT CHECK(role IN ('user', 'assistant')),
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引以提高查询性能
CREATE INDEX IF NOT EXISTS idx_trips_user_id ON trips(user_id);
CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);
CREATE INDEX IF NOT EXISTS idx_travel_nodes_itinerary_id ON travel_nodes(itinerary_id);
CREATE INDEX IF NOT EXISTS idx_travel_nodes_day_index ON travel_nodes(day_index);
CREATE INDEX IF NOT EXISTS idx_diary_fragments_trip_id ON diary_fragments(trip_id);
CREATE INDEX IF NOT EXISTS idx_chat_history_trip_id ON chat_history(trip_id);
