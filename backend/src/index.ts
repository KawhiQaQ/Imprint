import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { initializeDatabase } from './database';
import routes from './routes';

// 尝试多个可能的 .env 路径
const envPaths = [
  path.resolve(__dirname, '../.env'),      // 从 src 目录: backend/.env
  path.resolve(__dirname, '../../backend/.env'),  // 从根目录运行时
  path.resolve(process.cwd(), 'backend/.env'),    // 从根目录运行时
  path.resolve(process.cwd(), '.env'),            // 从 backend 目录运行时
];

for (const envPath of envPaths) {
  const result = dotenv.config({ path: envPath });
  if (!result.error) {
    console.log(`Loaded .env from: ${envPath}`);
    break;
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 静态文件服务 - 用于访问上传的照片和音频
const uploadsPath = path.resolve(__dirname, '../uploads');
console.log('Static files path:', uploadsPath);
app.use('/uploads', express.static(uploadsPath));

// Initialize database
initializeDatabase();

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Debug endpoint - check env vars (remove in production)
app.get('/debug/env', (_req, res) => {
  res.json({
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ? `${process.env.DEEPSEEK_API_KEY.substring(0, 8)}...` : 'NOT SET',
    DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || 'NOT SET',
    DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'NOT SET',
  });
});

// API routes
app.use('/api', routes);

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: '服务器内部错误，请稍后重试',
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
