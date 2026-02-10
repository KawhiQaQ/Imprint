import { deepseekClient, DeepSeekClient, ChatMessage } from '../clients/deepseekClient';
import { SearchConditions } from './storageService';

export interface VisionInput {
  text: string;
  userId: string;
}

// Re-export SearchConditions for convenience
export type { SearchConditions };

export interface VisionAnalysisResult {
  success: boolean;
  conditions: SearchConditions;
  rawAnalysis: string;
  errorMessage?: string;
}

interface ValidationResult {
  valid: boolean;
  error?: string;
}

const MAX_VISION_TEXT_LENGTH = 500;

export class VisionService {
  private getClient(): DeepSeekClient {
    return deepseekClient;
  }

  /**
   * Validates vision input text
   */
  validateVisionInput(text: string): ValidationResult {
    if (!text || text.trim().length === 0) {
      return { valid: false, error: '请输入您的旅行愿景' };
    }
    if (text.length > MAX_VISION_TEXT_LENGTH) {
      return { valid: false, error: `描述过长，请精简至${MAX_VISION_TEXT_LENGTH}字以内` };
    }
    return { valid: true };
  }

  /**
   * Analyzes user's travel vision and extracts search conditions
   */
  async analyzeVision(input: VisionInput): Promise<VisionAnalysisResult> {
    // Validate input
    const validation = this.validateVisionInput(input.text);
    if (!validation.valid) {
      return {
        success: false,
        conditions: this.getEmptyConditions(),
        rawAnalysis: '',
        errorMessage: validation.error,
      };
    }

    try {
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: this.getSystemPrompt(),
        },
        {
          role: 'user',
          content: input.text.trim(),
        },
      ];

      const response = await this.getClient().chatWithJson<SearchConditions>(messages);
      const conditions = this.normalizeConditions(response);

      // Validate that at least one field has content
      if (!this.hasValidContent(conditions)) {
        return {
          success: false,
          conditions: this.getEmptyConditions(),
          rawAnalysis: JSON.stringify(response),
          errorMessage: '无法从您的描述中提取有效信息，请尝试更详细地描述您的旅行愿景',
        };
      }

      return {
        success: true,
        conditions,
        rawAnalysis: JSON.stringify(response),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '分析服务暂时不可用，请稍后重试';
      return {
        success: false,
        conditions: this.getEmptyConditions(),
        rawAnalysis: '',
        errorMessage,
      };
    }
  }

  private getSystemPrompt(): string {
    return `你是一个旅行规划专家。请分析以下用户的旅行愿景描述，提取关键信息。

请以JSON格式返回以下信息（不要包含任何其他文字，只返回JSON）：
{
  "geographicFeatures": ["地理特征数组，如雪山、海滩、森林、古镇等"],
  "climatePreference": "气候偏好，如温暖、凉爽、四季分明等",
  "foodPreferences": ["美食需求数组，如米线、海鲜、火锅等"],
  "activityTypes": ["活动类型数组，如观光、美食、购物、户外运动等"],
  "budgetLevel": "预算级别，如经济、中等、高端（可选）",
  "travelStyle": "旅行风格，如休闲、探险、文化、浪漫（可选）"
}

注意：
1. 如果用户没有明确提到某个字段，请根据上下文合理推断，或留空数组/空字符串
2. 地理特征应该是具体的自然或人文景观特点
3. 活动类型应该反映用户想要的旅行体验
4. 只返回JSON，不要有任何解释文字`;
  }

  private getEmptyConditions(): SearchConditions {
    return {
      geographicFeatures: [],
      climatePreference: '',
      foodPreferences: [],
      activityTypes: [],
    };
  }

  private normalizeConditions(raw: Partial<SearchConditions>): SearchConditions {
    return {
      geographicFeatures: Array.isArray(raw.geographicFeatures) ? raw.geographicFeatures.filter(Boolean) : [],
      climatePreference: typeof raw.climatePreference === 'string' ? raw.climatePreference : '',
      foodPreferences: Array.isArray(raw.foodPreferences) ? raw.foodPreferences.filter(Boolean) : [],
      activityTypes: Array.isArray(raw.activityTypes) ? raw.activityTypes.filter(Boolean) : [],
      budgetLevel: typeof raw.budgetLevel === 'string' ? raw.budgetLevel : undefined,
      travelStyle: typeof raw.travelStyle === 'string' ? raw.travelStyle : undefined,
    };
  }

  private hasValidContent(conditions: SearchConditions): boolean {
    return (
      conditions.geographicFeatures.length > 0 ||
      conditions.climatePreference !== '' ||
      conditions.foodPreferences.length > 0 ||
      conditions.activityTypes.length > 0
    );
  }
}

export const visionService = new VisionService();
