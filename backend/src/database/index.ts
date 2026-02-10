import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (!db) {
    const dbPath = process.env.DATABASE_PATH || './data/travel-planner.db';
    const dbDir = path.dirname(dbPath);

    // Ensure database directory exists
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

/**
 * 运行数据库迁移，添加新字段
 */
function runMigrations(database: Database.Database): void {
  // 检查 travel_nodes 表是否有 time_slot 和 activity 字段
  const tableInfo = database.prepare("PRAGMA table_info(travel_nodes)").all() as Array<{ name: string }>;
  const columnNames = tableInfo.map(col => col.name);

  // 添加 time_slot 字段
  if (!columnNames.includes('time_slot')) {
    console.log('Adding time_slot column to travel_nodes table...');
    database.exec('ALTER TABLE travel_nodes ADD COLUMN time_slot TEXT');
  }

  // 添加 activity 字段
  if (!columnNames.includes('activity')) {
    console.log('Adding activity column to travel_nodes table...');
    database.exec('ALTER TABLE travel_nodes ADD COLUMN activity TEXT');
  }

  // 添加 is_starting_point 字段（标识是否是大型景区的起点位置）
  if (!columnNames.includes('is_starting_point')) {
    console.log('Adding is_starting_point column to travel_nodes table...');
    database.exec('ALTER TABLE travel_nodes ADD COLUMN is_starting_point INTEGER DEFAULT 0');
  }

  // 添加 scenic_area_name 字段（如果是起点，对应的景区名称）
  if (!columnNames.includes('scenic_area_name')) {
    console.log('Adding scenic_area_name column to travel_nodes table...');
    database.exec('ALTER TABLE travel_nodes ADD COLUMN scenic_area_name TEXT');
  }

  // 添加 price_info 字段（价格信息：餐厅人均、酒店房价、景点门票）
  if (!columnNames.includes('price_info')) {
    console.log('Adding price_info column to travel_nodes table...');
    database.exec('ALTER TABLE travel_nodes ADD COLUMN price_info TEXT');
  }

  // 添加 ticket_info 字段（门票/预约信息）
  if (!columnNames.includes('ticket_info')) {
    console.log('Adding ticket_info column to travel_nodes table...');
    database.exec('ALTER TABLE travel_nodes ADD COLUMN ticket_info TEXT');
  }

  // 添加 tips 字段（小贴士）
  if (!columnNames.includes('tips')) {
    console.log('Adding tips column to travel_nodes table...');
    database.exec('ALTER TABLE travel_nodes ADD COLUMN tips TEXT');
  }

  // 检查 trips 表是否有 is_saved_to_shelf 字段
  const tripsTableInfo = database.prepare("PRAGMA table_info(trips)").all() as Array<{ name: string }>;
  const tripsColumnNames = tripsTableInfo.map(col => col.name);

  if (!tripsColumnNames.includes('is_saved_to_shelf')) {
    console.log('Adding is_saved_to_shelf column to trips table...');
    database.exec('ALTER TABLE trips ADD COLUMN is_saved_to_shelf INTEGER DEFAULT 0');
  }

  // 检查 itineraries 表是否有 start_date 字段
  const itinerariesTableInfo = database.prepare("PRAGMA table_info(itineraries)").all() as Array<{ name: string }>;
  const itinerariesColumnNames = itinerariesTableInfo.map(col => col.name);

  if (!itinerariesColumnNames.includes('start_date')) {
    console.log('Adding start_date column to itineraries table...');
    database.exec('ALTER TABLE itineraries ADD COLUMN start_date TEXT');
  }

  // 添加交通信息字段
  if (!columnNames.includes('transport_mode')) {
    console.log('Adding transport_mode column to travel_nodes table...');
    database.exec('ALTER TABLE travel_nodes ADD COLUMN transport_mode TEXT');
  }

  if (!columnNames.includes('transport_duration')) {
    console.log('Adding transport_duration column to travel_nodes table...');
    database.exec('ALTER TABLE travel_nodes ADD COLUMN transport_duration INTEGER');
  }

  if (!columnNames.includes('transport_note')) {
    console.log('Adding transport_note column to travel_nodes table...');
    database.exec('ALTER TABLE travel_nodes ADD COLUMN transport_note TEXT');
  }

  // 检查 diary_fragments 表是否有 weather 和 text_notes 字段
  const diaryFragmentsTableInfo = database.prepare("PRAGMA table_info(diary_fragments)").all() as Array<{ name: string }>;
  const diaryFragmentsColumnNames = diaryFragmentsTableInfo.map(col => col.name);

  if (!diaryFragmentsColumnNames.includes('weather')) {
    console.log('Adding weather column to diary_fragments table...');
    database.exec('ALTER TABLE diary_fragments ADD COLUMN weather TEXT');
  }

  if (!diaryFragmentsColumnNames.includes('text_notes')) {
    console.log('Adding text_notes column to diary_fragments table...');
    database.exec('ALTER TABLE diary_fragments ADD COLUMN text_notes TEXT');
  }

  // 添加节点状态相关字段
  if (!columnNames.includes('node_status')) {
    console.log('Adding node_status column to travel_nodes table...');
    database.exec("ALTER TABLE travel_nodes ADD COLUMN node_status TEXT DEFAULT 'normal'");
  }

  if (!columnNames.includes('status_reason')) {
    console.log('Adding status_reason column to travel_nodes table...');
    database.exec('ALTER TABLE travel_nodes ADD COLUMN status_reason TEXT');
  }

  if (!columnNames.includes('parent_node_id')) {
    console.log('Adding parent_node_id column to travel_nodes table...');
    database.exec('ALTER TABLE travel_nodes ADD COLUMN parent_node_id TEXT');
  }

  // 检查 travel_memoirs 表是否有 opening_text 和 closing_text 字段
  const memoirsTableInfo = database.prepare("PRAGMA table_info(travel_memoirs)").all() as Array<{ name: string }>;
  const memoirsColumnNames = memoirsTableInfo.map(col => col.name);

  if (!memoirsColumnNames.includes('opening_text')) {
    console.log('Adding opening_text column to travel_memoirs table...');
    database.exec('ALTER TABLE travel_memoirs ADD COLUMN opening_text TEXT');
  }

  if (!memoirsColumnNames.includes('closing_text')) {
    console.log('Adding closing_text column to travel_memoirs table...');
    database.exec('ALTER TABLE travel_memoirs ADD COLUMN closing_text TEXT');
  }
}

export function initializeDatabase(): void {
  const database = getDatabase();
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');

  database.exec(schema);
  
  // 运行迁移
  runMigrations(database);
  
  console.log('Database initialized successfully');
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export default {
  getDatabase,
  initializeDatabase,
  closeDatabase,
};
