import { Router, Request, Response, NextFunction } from 'express';
import { visionService, VisionInput } from '../services/visionService';

const router = Router();

interface VisionAnalyzeRequest {
  text: string;
  userId?: string;
}

/**
 * Request validation middleware for vision analysis
 */
function validateVisionRequest(req: Request, res: Response, next: NextFunction): void {
  const { text } = req.body as VisionAnalyzeRequest;

  if (text === undefined || text === null) {
    res.status(400).json({
      success: false,
      error: '请求缺少必要的text字段',
    });
    return;
  }

  if (typeof text !== 'string') {
    res.status(400).json({
      success: false,
      error: 'text字段必须是字符串类型',
    });
    return;
  }

  next();
}

/**
 * POST /api/vision/analyze
 * Analyzes user's travel vision and extracts search conditions
 */
router.post('/analyze', validateVisionRequest, async (req: Request, res: Response) => {
  try {
    const { text, userId } = req.body as VisionAnalyzeRequest;

    const input: VisionInput = {
      text,
      userId: userId || 'anonymous',
    };

    const result = await visionService.analyzeVision(input);

    if (result.success) {
      res.json({
        success: true,
        conditions: result.conditions,
        rawAnalysis: result.rawAnalysis,
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.errorMessage,
      });
    }
  } catch (error) {
    console.error('Vision analysis error:', error);
    res.status(500).json({
      success: false,
      error: '分析服务暂时不可用，请稍后重试',
    });
  }
});

export default router;
