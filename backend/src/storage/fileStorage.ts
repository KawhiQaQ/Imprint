import fs from 'fs';
import path from 'path';
import { ossClient } from '../clients/ossClient';

export interface FileStorageConfig {
  basePath: string;
  photoDir: string;
  audioDir: string;
}

// 使用绝对路径，确保在任何工作目录下都能正确找到 uploads 文件夹
const defaultConfig: FileStorageConfig = {
  basePath: path.resolve(__dirname, '../../uploads'),
  photoDir: 'photos',
  audioDir: 'audio',
};

export class FileStorage {
  private config: FileStorageConfig;

  constructor(config: Partial<FileStorageConfig> = {}) {
    this.config = { ...defaultConfig, ...config };
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    const dirs = [
      this.config.basePath,
      path.join(this.config.basePath, this.config.photoDir),
      path.join(this.config.basePath, this.config.audioDir),
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * 检查是否使用 OSS 存储
   */
  isOSSEnabled(): boolean {
    return ossClient.isEnabled();
  }

  /**
   * 保存文件 - 必须使用 OSS
   */
  async saveFile(file: Buffer, type: 'photo' | 'audio', extension: string): Promise<string> {
    // 必须使用 OSS
    if (!ossClient.isEnabled()) {
      throw new Error('OSS is not configured. Please set OSS_REGION, OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_BUCKET in .env');
    }

    const ossUrl = await ossClient.uploadFile(file, type, extension);
    console.log(`[FileStorage] 文件已上传到 OSS: ${ossUrl}`);
    return ossUrl;
  }

  /**
   * 获取文件的公网可访问 URL
   * 如果是 OSS URL 直接返回，如果是本地路径则需要配合服务器地址
   */
  getPublicUrl(relativePath: string, serverBaseUrl?: string): string {
    // 如果已经是完整的 URL（OSS），直接返回
    if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
      return relativePath;
    }

    // 本地路径，需要拼接服务器地址
    if (serverBaseUrl) {
      return `${serverBaseUrl}${relativePath}`;
    }

    return relativePath;
  }

  async getFile(relativePath: string): Promise<Buffer> {
    // 如果是 OSS URL，不支持直接获取
    if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
      throw new Error('Cannot get file from OSS URL directly');
    }

    // 移除 /uploads/ 前缀（如果有）
    const cleanPath = relativePath.replace(/^\/uploads\//, '');
    const filePath = path.join(this.config.basePath, cleanPath);

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${relativePath}`);
    }

    return fs.promises.readFile(filePath);
  }

  async deleteFile(relativePath: string): Promise<void> {
    // 如果是 OSS URL，调用 OSS 删除
    if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
      await ossClient.deleteFile(relativePath);
      return;
    }

    // 移除 /uploads/ 前缀（如果有）
    const cleanPath = relativePath.replace(/^\/uploads\//, '');
    const filePath = path.join(this.config.basePath, cleanPath);

    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  }

  getFullPath(relativePath: string): string {
    // 如果是 OSS URL，直接返回
    if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
      return relativePath;
    }

    // 移除 /uploads/ 前缀（如果有）
    const cleanPath = relativePath.replace(/^\/uploads\//, '');
    return path.join(this.config.basePath, cleanPath);
  }
}

export const fileStorage = new FileStorage();
