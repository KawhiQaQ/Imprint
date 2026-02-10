import OSS from 'ali-oss';
import { v4 as uuidv4 } from 'uuid';

export interface OSSConfig {
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  endpoint?: string;
}

class OSSClient {
  private client: OSS | null = null;
  private initialized: boolean = false;

  private ensureInitialized(): void {
    if (this.initialized) return;
    
    const region = process.env.OSS_REGION;
    const accessKeyId = process.env.OSS_ACCESS_KEY_ID;
    const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET;
    const bucket = process.env.OSS_BUCKET;

    console.log('[OSSClient] 检查 OSS 配置:', { 
      region: !!region, 
      accessKeyId: !!accessKeyId, 
      accessKeySecret: !!accessKeySecret, 
      bucket: !!bucket 
    });

    if (region && accessKeyId && accessKeySecret && bucket) {
      this.client = new OSS({
        region,
        accessKeyId,
        accessKeySecret,
        bucket,
        endpoint: process.env.OSS_ENDPOINT,
      });
      console.log('[OSSClient] 阿里云 OSS 已启用, bucket:', bucket);
    } else {
      console.error('[OSSClient] 阿里云 OSS 配置不完整，请检查环境变量');
    }
    
    this.initialized = true;
  }

  isEnabled(): boolean {
    this.ensureInitialized();
    return this.client !== null;
  }

  /**
   * 上传文件到 OSS
   * @param buffer 文件内容
   * @param type 文件类型 (photo/audio)
   * @param extension 文件扩展名
   * @returns 公网可访问的 URL
   */
  async uploadFile(buffer: Buffer, type: 'photo' | 'audio', extension: string): Promise<string> {
    this.ensureInitialized();
    
    if (!this.client) {
      throw new Error('OSS client is not initialized. Please configure OSS_REGION, OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_BUCKET in .env');
    }

    const fileId = uuidv4();
    const objectName = `travel-planner/${type}s/${fileId}.${extension}`;

    try {
      const result = await this.client.put(objectName, buffer);
      console.log(`[OSSClient] 文件上传成功: ${result.url}`);
      return result.url;
    } catch (error) {
      console.error('[OSSClient] 文件上传失败:', error);
      throw error;
    }
  }

  /**
   * 删除 OSS 上的文件
   * @param url 文件的完整 URL
   */
  async deleteFile(url: string): Promise<void> {
    this.ensureInitialized();
    
    if (!this.client) {
      return;
    }

    try {
      // 从 URL 中提取 object name
      const urlObj = new URL(url);
      const objectName = urlObj.pathname.substring(1); // 移除开头的 /
      
      await this.client.delete(objectName);
      console.log(`[OSSClient] 文件删除成功: ${objectName}`);
    } catch (error) {
      console.error('[OSSClient] 文件删除失败:', error);
    }
  }

  /**
   * 获取文件的签名 URL（用于私有 bucket）
   * @param objectName 对象名称
   * @param expires 过期时间（秒），默认 1 小时
   */
  async getSignedUrl(objectName: string, expires: number = 3600): Promise<string> {
    this.ensureInitialized();
    
    if (!this.client) {
      throw new Error('OSS client is not initialized');
    }

    return this.client.signatureUrl(objectName, { expires });
  }
}

export const ossClient = new OSSClient();
