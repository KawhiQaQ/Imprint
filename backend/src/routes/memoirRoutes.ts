import { Router, Request, Response } from 'express';
import { memoirService } from '../services/memoirService';
import { storageService } from '../services/storageService';

const router = Router();

/**
 * POST /api/trips/:tripId/complete
 * Complete a trip and generate travel memoir
 * Requirements: 6.1, 6.6
 */
router.post('/trips/:tripId/complete', async (req: Request, res: Response) => {
  try {
    const { tripId } = req.params;

    // Validate trip exists
    const trip = await storageService.getTrip(tripId);
    if (!trip) {
      return res.status(404).json({
        success: false,
        error: '旅程不存在',
      });
    }

    // Check if trip is already completed
    if (trip.status === 'completed') {
      // Return existing memoir
      const existingMemoir = await memoirService.getMemoir(tripId);
      if (existingMemoir) {
        return res.json({
          success: true,
          memoir: existingMemoir,
          message: '旅程已完成，返回已生成的回忆录',
        });
      }
    }

    // Generate memoir
    const memoir = await memoirService.generateMemoir(tripId);

    return res.json({
      success: true,
      memoir,
    });
  } catch (error) {
    console.error('Complete trip error:', error);
    const errorMessage = error instanceof Error ? error.message : '生成回忆录失败，请重试';
    return res.status(500).json({
      success: false,
      error: errorMessage,
    });
  }
});

/**
 * GET /api/trips/:tripId/memoir
 * Get memoir for a trip
 * Requirements: 6.1
 */
router.get('/trips/:tripId/memoir', async (req: Request, res: Response) => {
  try {
    const { tripId } = req.params;

    // Validate trip exists
    const trip = await storageService.getTrip(tripId);
    if (!trip) {
      return res.status(404).json({
        success: false,
        error: '旅程不存在',
      });
    }

    const memoir = await memoirService.getMemoir(tripId);
    if (!memoir) {
      return res.status(404).json({
        success: false,
        error: '回忆录尚未生成，请先完成旅程',
      });
    }

    return res.json({
      success: true,
      memoir,
    });
  } catch (error) {
    console.error('Get memoir error:', error);
    return res.status(500).json({
      success: false,
      error: '获取回忆录失败，请重试',
    });
  }
});

/**
 * PUT /api/trips/:tripId/memoir/template
 * Change memoir template
 * Requirements: 7.1, 7.4
 */
router.put('/trips/:tripId/memoir/template', async (req: Request, res: Response) => {
  try {
    const { tripId } = req.params;
    const { templateId } = req.body;

    if (!templateId || typeof templateId !== 'string') {
      return res.status(400).json({
        success: false,
        error: '请提供模板ID',
      });
    }

    // Validate trip exists
    const trip = await storageService.getTrip(tripId);
    if (!trip) {
      return res.status(404).json({
        success: false,
        error: '旅程不存在',
      });
    }

    // Get memoir
    const memoir = await memoirService.getMemoir(tripId);
    if (!memoir) {
      return res.status(404).json({
        success: false,
        error: '回忆录尚未生成，请先完成旅程',
      });
    }

    // Apply template and get rendered HTML
    const html = await memoirService.applyTemplate(memoir, templateId);

    return res.json({
      success: true,
      html,
      templateId,
    });
  } catch (error) {
    console.error('Change template error:', error);
    const errorMessage = error instanceof Error ? error.message : '切换模板失败，请重试';
    return res.status(500).json({
      success: false,
      error: errorMessage,
    });
  }
});

/**
 * GET /api/memoir-templates
 * Get all available memoir templates
 * Requirements: 7.1
 */
router.get('/memoir-templates', async (_req: Request, res: Response) => {
  try {
    const templates = await memoirService.getAvailableTemplates();

    return res.json({
      success: true,
      templates,
    });
  } catch (error) {
    console.error('Get templates error:', error);
    return res.status(500).json({
      success: false,
      error: '获取模板列表失败，请重试',
    });
  }
});

/**
 * GET /api/trips/:tripId/memoir/download
 * Download memoir as HTML
 * Requirements: 6.6
 */
router.get('/trips/:tripId/memoir/download', async (req: Request, res: Response) => {
  try {
    const { tripId } = req.params;

    // Validate trip exists
    const trip = await storageService.getTrip(tripId);
    if (!trip) {
      return res.status(404).json({
        success: false,
        error: '旅程不存在',
      });
    }

    // Get memoir
    const memoir = await memoirService.getMemoir(tripId);
    if (!memoir) {
      return res.status(404).json({
        success: false,
        error: '回忆录尚未生成，请先完成旅程',
      });
    }

    // Get template
    const templates = await memoirService.getAvailableTemplates();
    const template = templates.find(t => t.id === memoir.templateId) || templates[0];

    // Generate HTML
    const html = await memoirService.applyTemplate(memoir, template.id);

    // Set headers for download
    const filename = `${memoir.title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')}.html`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);

    return res.send(html);
  } catch (error) {
    console.error('Download memoir error:', error);
    return res.status(500).json({
      success: false,
      error: '下载回忆录失败，请重试',
    });
  }
});

/**
 * POST /api/trips/:tripId/memoir/share
 * Generate share URL for memoir
 * Requirements: 6.6
 */
router.post('/trips/:tripId/memoir/share', async (req: Request, res: Response) => {
  try {
    const { tripId } = req.params;

    // Validate trip exists
    const trip = await storageService.getTrip(tripId);
    if (!trip) {
      return res.status(404).json({
        success: false,
        error: '旅程不存在',
      });
    }

    // Get memoir
    const memoir = await memoirService.getMemoir(tripId);
    if (!memoir) {
      return res.status(404).json({
        success: false,
        error: '回忆录尚未生成，请先完成旅程',
      });
    }

    // Generate share URL
    const shareUrl = await memoirService.generateShareUrl(memoir.id);

    return res.json({
      success: true,
      shareUrl,
    });
  } catch (error) {
    console.error('Generate share URL error:', error);
    return res.status(500).json({
      success: false,
      error: '生成分享链接失败，请重试',
    });
  }
});

export default router;
