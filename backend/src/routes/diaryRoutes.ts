import { Router, Request, Response } from 'express';
import multer from 'multer';
import { diaryService } from '../services/diaryService';
import { storageService } from '../services/storageService';

const router = Router();

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max
  },
  fileFilter: (_req, file, cb) => {
    // Allow images and audio files
    const allowedMimes = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'audio/wav',
      'audio/mp3',
      'audio/mpeg',
      'audio/webm',
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('不支持的文件格式'));
    }
  },
});

/**
 * POST /api/trips/:tripId/nodes/:nodeId/photos
 * Upload a photo for a travel node
 * Requirements: 4.1
 */
router.post(
  '/trips/:tripId/nodes/:nodeId/photos',
  upload.single('photo'),
  async (req: Request, res: Response) => {
    try {
      const { nodeId } = req.params;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: '请上传照片文件',
        });
      }

      // Validate node exists
      const node = await diaryService.getTravelNode(nodeId);
      if (!node) {
        return res.status(404).json({
          success: false,
          error: '节点不存在',
        });
      }

      const photo = await diaryService.uploadPhoto(
        nodeId,
        req.file.buffer,
        req.file.mimetype
      );

      return res.json({
        success: true,
        photo,
      });
    } catch (error) {
      console.error('Photo upload error:', error);
      return res.status(500).json({
        success: false,
        error: '照片上传失败，请重试',
      });
    }
  }
);

/**
 * POST /api/trips/:tripId/nodes/:nodeId/voice
 * Upload a voice recording for a travel node
 * Requirements: 4.1
 */
router.post(
  '/trips/:tripId/nodes/:nodeId/voice',
  upload.single('voice'),
  async (req: Request, res: Response) => {
    try {
      const { nodeId } = req.params;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: '请上传语音文件',
        });
      }

      // Validate node exists
      const node = await diaryService.getTravelNode(nodeId);
      if (!node) {
        return res.status(404).json({
          success: false,
          error: '节点不存在',
        });
      }

      const voice = await diaryService.uploadVoice(
        nodeId,
        req.file.buffer,
        req.file.mimetype
      );

      return res.json({
        success: true,
        voice,
      });
    } catch (error) {
      console.error('Voice upload error:', error);
      return res.status(500).json({
        success: false,
        error: '语音上传失败，请重试',
      });
    }
  }
);

/**
 * POST /api/trips/:tripId/nodes/:nodeId/light
 * Light up a node and generate diary fragment
 * Requirements: 5.1
 */
router.post(
  '/trips/:tripId/nodes/:nodeId/light',
  async (req: Request, res: Response) => {
    try {
      const { tripId, nodeId } = req.params;
      const { moodEmoji, textNotes, weather, timeRange } = req.body;

      console.log('[DiaryRoutes] 点亮节点请求:', { tripId, nodeId });

      // Validate node exists
      const node = await diaryService.getTravelNode(nodeId);
      if (!node) {
        return res.status(404).json({
          success: false,
          error: '节点不存在',
        });
      }

      // Check if node is already lit
      if (node.isLit) {
        // Return existing fragment
        const fragments = await diaryService.getDiaryFragments(tripId);
        const existingFragment = fragments.find((f) => f.nodeId === nodeId);
        if (existingFragment) {
          const materials = await diaryService.getNodeMaterials(nodeId);
          console.log('[DiaryRoutes] 节点已点亮，返回现有数据:', { 
            nodeId, 
            photosCount: materials?.photos.length || 0,
            photos: materials?.photos.map(p => ({ id: p.id, url: p.url, visionAnalysis: p.visionAnalysis }))
          });
          return res.json({
            success: true,
            fragment: {
              ...existingFragment,
              nodeName: node.name,
              photos: materials?.photos.map((p) => ({
                id: p.id,
                url: p.url,
                uploadTime: p.uploadTime,
                visionAnalysis: p.visionAnalysis,
                isAiGenerated: p.visionAnalysis === 'AI_GENERATED',
              })) || [],
            },
            message: '该节点已点亮',
          });
        }
      }

      // Get node materials
      let materials = await diaryService.getNodeMaterials(nodeId);
      console.log('[DiaryRoutes] 获取节点素材:', { 
        nodeId, 
        hasMaterials: !!materials,
        photosCount: materials?.photos.length || 0,
        photos: materials?.photos.map(p => ({ id: p.id, url: p.url, visionAnalysis: p.visionAnalysis }))
      });
      
      // If no materials, create empty materials
      if (!materials) {
        materials = {
          id: '',
          nodeId,
          moodEmoji: moodEmoji || undefined,
          photos: [],
          voiceRecordings: [],
          textNotes: textNotes || [],
        };
      } else {
        // Add text notes to materials
        materials.textNotes = textNotes || [];
      }

      // Update mood emoji if provided
      if (moodEmoji) {
        await diaryService.updateMoodEmoji(nodeId, moodEmoji);
        materials.moodEmoji = moodEmoji;
      }

      // Generate diary fragment with weather and time info
      const fragment = await diaryService.generateDiaryFragment(
        node,
        tripId,
        materials,
        weather,
        timeRange
      );

      // 检查是否有用户上传的照片（排除AI生成的图像）
      const userPhotos = materials.photos.filter(p => !p.visionAnalysis?.startsWith('AI_GENERATED'));
      let aiGeneratedImageUrl: string | undefined;
      let aiImageOrientation: 'portrait' | 'landscape' | undefined;

      // 如果没有用户上传的照片，自动生成AI图像（随机横版或竖版）
      if (userPhotos.length === 0) {
        console.log('[DiaryRoutes] 节点没有用户上传的照片，自动生成AI图像');
        try {
          const aiResult = await diaryService.generateAiImage(
            nodeId,
            fragment.content,
            node.name,
            node.description,
            weather,
            moodEmoji
          );
          aiGeneratedImageUrl = aiResult.url;
          aiImageOrientation = aiResult.orientation;
          console.log('[DiaryRoutes] AI图像生成成功:', aiGeneratedImageUrl, '方向:', aiImageOrientation);
        } catch (aiError) {
          // AI图像生成失败不影响日记生成，只记录错误
          console.error('[DiaryRoutes] AI图像生成失败，继续返回日记:', aiError);
        }
      }

      // 重新获取materials以包含可能新生成的AI图像
      const updatedMaterials = await diaryService.getNodeMaterials(nodeId);

      // Return enriched fragment with nodeName and photos
      return res.json({
        success: true,
        fragment: {
          ...fragment,
          nodeName: node.name,
          photos: updatedMaterials?.photos.map((p) => ({
            id: p.id,
            url: p.url,
            uploadTime: p.uploadTime,
            visionAnalysis: p.visionAnalysis,
            isAiGenerated: p.visionAnalysis?.startsWith('AI_GENERATED'),
            aiImageOrientation: p.visionAnalysis?.includes('LANDSCAPE') ? 'landscape' : p.visionAnalysis?.includes('PORTRAIT') ? 'portrait' : undefined,
          })) || [],
        },
        aiGeneratedImageUrl,
        aiImageOrientation,
      });
    } catch (error) {
      console.error('Light node error:', error);
      return res.status(500).json({
        success: false,
        error: '日记生成失败，请重试',
      });
    }
  }
);

/**
 * POST /api/trips/:tripId/nodes/:nodeId/regenerate
 * Regenerate diary fragment for an already lit node with new materials
 * Requirements: 5.1
 */
router.post(
  '/trips/:tripId/nodes/:nodeId/regenerate',
  async (req: Request, res: Response) => {
    try {
      const { tripId, nodeId } = req.params;
      const { moodEmoji, textNotes, weather, timeRange } = req.body;

      // Validate node exists
      const node = await diaryService.getTravelNode(nodeId);
      if (!node) {
        return res.status(404).json({
          success: false,
          error: '节点不存在',
        });
      }

      // Get node materials
      let materials = await diaryService.getNodeMaterials(nodeId);
      
      // If no materials, create empty materials
      if (!materials) {
        materials = {
          id: '',
          nodeId,
          moodEmoji: moodEmoji || undefined,
          photos: [],
          voiceRecordings: [],
          textNotes: textNotes || [],
        };
      } else {
        // Add text notes to materials
        materials.textNotes = textNotes || [];
      }

      // Update mood emoji if provided
      if (moodEmoji) {
        await diaryService.updateMoodEmoji(nodeId, moodEmoji);
        materials.moodEmoji = moodEmoji;
      }

      // Regenerate diary fragment with weather and time info
      const fragment = await diaryService.regenerateDiaryFragment(
        node,
        tripId,
        materials,
        weather,
        timeRange
      );

      // 检查是否有用户上传的照片（排除AI生成的图像）
      const userPhotos = materials.photos.filter(p => !p.visionAnalysis?.startsWith('AI_GENERATED'));
      let aiGeneratedImageUrl: string | undefined;
      let aiImageOrientation: 'portrait' | 'landscape' | undefined;

      // 如果没有用户上传的照片，自动生成AI图像（随机横版或竖版）
      if (userPhotos.length === 0) {
        console.log('[DiaryRoutes] 重新生成：节点没有用户上传的照片，自动生成AI图像');
        try {
          const aiResult = await diaryService.generateAiImage(
            nodeId,
            fragment.content,
            node.name,
            node.description,
            weather,
            moodEmoji
          );
          aiGeneratedImageUrl = aiResult.url;
          aiImageOrientation = aiResult.orientation;
          console.log('[DiaryRoutes] AI图像生成成功:', aiGeneratedImageUrl, '方向:', aiImageOrientation);
        } catch (aiError) {
          // AI图像生成失败不影响日记生成，只记录错误
          console.error('[DiaryRoutes] AI图像生成失败，继续返回日记:', aiError);
        }
      }

      // 重新获取materials以包含可能新生成的AI图像
      const updatedMaterials = await diaryService.getNodeMaterials(nodeId);

      // Return enriched fragment with nodeName and photos
      return res.json({
        success: true,
        fragment: {
          ...fragment,
          nodeName: node.name,
          photos: updatedMaterials?.photos.map((p) => ({
            id: p.id,
            url: p.url,
            uploadTime: p.uploadTime,
            visionAnalysis: p.visionAnalysis,
            isAiGenerated: p.visionAnalysis?.startsWith('AI_GENERATED'),
            aiImageOrientation: p.visionAnalysis?.includes('LANDSCAPE') ? 'landscape' : p.visionAnalysis?.includes('PORTRAIT') ? 'portrait' : undefined,
          })) || [],
        },
        aiGeneratedImageUrl,
        aiImageOrientation,
      });
    } catch (error) {
      console.error('Regenerate node error:', error);
      return res.status(500).json({
        success: false,
        error: '重新生成日记失败，请重试',
      });
    }
  }
);

/**
 * PUT /api/diary-fragments/:fragmentId
 * Update diary fragment content and mood emoji
 * Requirements: 5.4, 5.5
 */
router.put(
  '/diary-fragments/:fragmentId',
  async (req: Request, res: Response) => {
    try {
      const { fragmentId } = req.params;
      const { content, moodEmoji } = req.body;

      if (!content || typeof content !== 'string') {
        return res.status(400).json({
          success: false,
          error: '请提供日记内容',
        });
      }

      const fragment = await diaryService.updateFragment(fragmentId, content, moodEmoji);

      if (!fragment) {
        return res.status(404).json({
          success: false,
          error: '日记片段不存在',
        });
      }

      // Enrich fragment with node name and photos
      const node = await diaryService.getTravelNode(fragment.nodeId);
      const materials = await diaryService.getNodeMaterials(fragment.nodeId);

      return res.json({
        success: true,
        fragment: {
          ...fragment,
          nodeName: node?.name || '未知地点',
          photos: materials?.photos.map((p) => ({
            id: p.id,
            url: p.url,
            uploadTime: p.uploadTime,
            visionAnalysis: p.visionAnalysis,
          })) || [],
        },
      });
    } catch (error) {
      console.error('Update fragment error:', error);
      return res.status(500).json({
        success: false,
        error: '更新失败，请重试',
      });
    }
  }
);

/**
 * GET /api/trips/:tripId/diary-fragments
 * Get all diary fragments for a trip
 * Requirements: 5.4
 */
router.get(
  '/trips/:tripId/diary-fragments',
  async (req: Request, res: Response) => {
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

      const fragments = await diaryService.getDiaryFragments(tripId);
      
      // Enrich fragments with node name and photos
      const enrichedFragments = await Promise.all(
        fragments.map(async (fragment) => {
          const node = await diaryService.getTravelNode(fragment.nodeId);
          const materials = await diaryService.getNodeMaterials(fragment.nodeId);
          
          return {
            ...fragment,
            nodeName: node?.name || '未知地点',
            photos: materials?.photos.map((p) => ({
              id: p.id,
              url: p.url,
              uploadTime: p.uploadTime,
              visionAnalysis: p.visionAnalysis,
              isAiGenerated: p.visionAnalysis?.startsWith('AI_GENERATED'),
              aiImageOrientation: p.visionAnalysis?.includes('LANDSCAPE') ? 'landscape' : p.visionAnalysis?.includes('PORTRAIT') ? 'portrait' : undefined,
            })) || [],
          };
        })
      );

      return res.json({
        success: true,
        fragments: enrichedFragments,
      });
    } catch (error) {
      console.error('Get fragments error:', error);
      return res.status(500).json({
        success: false,
        error: '获取日记失败，请重试',
      });
    }
  }
);

/**
 * GET /api/trips/:tripId/nodes/:nodeId/materials
 * Get all materials for a node
 */
router.get(
  '/trips/:tripId/nodes/:nodeId/materials',
  async (req: Request, res: Response) => {
    try {
      const { nodeId } = req.params;

      const materials = await diaryService.getNodeMaterials(nodeId);

      return res.json({
        success: true,
        materials: materials || {
          nodeId,
          photos: [],
          voiceRecordings: [],
        },
      });
    } catch (error) {
      console.error('Get materials error:', error);
      return res.status(500).json({
        success: false,
        error: '获取素材失败，请重试',
      });
    }
  }
);

/**
 * POST /api/trips/:tripId/nodes/:nodeId/change
 * Change itinerary - mark original node as changed and create a new node
 * 变更行程：将原节点标记为已变更，并创建一个新的变更节点
 */
router.post(
  '/trips/:tripId/nodes/:nodeId/change',
  async (req: Request, res: Response) => {
    try {
      const { tripId, nodeId } = req.params;
      const { newDestination, changeReason } = req.body;

      if (!newDestination || !changeReason) {
        return res.status(400).json({
          success: false,
          error: '请提供新目的地和变更原因',
        });
      }

      // Validate node exists
      const node = await diaryService.getTravelNode(nodeId);
      if (!node) {
        return res.status(404).json({
          success: false,
          error: '节点不存在',
        });
      }

      // Check if node is already lit or has special status
      if (node.isLit && node.nodeStatus !== 'normal') {
        return res.status(400).json({
          success: false,
          error: '该节点已被处理，无法变更',
        });
      }

      const result = await diaryService.changeItinerary(
        nodeId,
        newDestination,
        changeReason,
        tripId
      );

      return res.json({
        success: true,
        originalNode: result.originalNode,
        newNode: result.newNode,
        newNodeDescription: result.newNodeDescription,
      });
    } catch (error) {
      console.error('Change itinerary error:', error);
      return res.status(500).json({
        success: false,
        error: '变更行程失败，请重试',
      });
    }
  }
);

/**
 * POST /api/trips/:tripId/nodes/:nodeId/unrealized
 * Mark node as unrealized and generate diary fragment
 * 标记节点为未实现，并生成相应的日记片段
 */
router.post(
  '/trips/:tripId/nodes/:nodeId/unrealized',
  async (req: Request, res: Response) => {
    try {
      const { tripId, nodeId } = req.params;
      const { reason, moodEmoji, weather } = req.body;

      if (!reason) {
        return res.status(400).json({
          success: false,
          error: '请提供未实现原因',
        });
      }

      // Validate node exists
      const node = await diaryService.getTravelNode(nodeId);
      if (!node) {
        return res.status(404).json({
          success: false,
          error: '节点不存在',
        });
      }

      // Check if node is already lit or has special status
      if (node.isLit) {
        return res.status(400).json({
          success: false,
          error: '该节点已被点亮，无法标记为未实现',
        });
      }

      const result = await diaryService.markAsUnrealized(
        nodeId,
        reason,
        tripId,
        moodEmoji,
        weather
      );

      // 为未实现节点生成 AI 图像
      let aiGeneratedImageUrl: string | undefined;
      let aiImageOrientation: 'portrait' | 'landscape' | undefined;
      
      console.log('[DiaryRoutes] 未实现节点，自动生成AI图像');
      try {
        const aiResult = await diaryService.generateAiImage(
          nodeId,
          result.fragment.content,
          node.name,
          node.description,
          weather,
          moodEmoji
        );
        aiGeneratedImageUrl = aiResult.url;
        aiImageOrientation = aiResult.orientation;
        console.log('[DiaryRoutes] AI图像生成成功:', aiGeneratedImageUrl, '方向:', aiImageOrientation);
      } catch (aiError) {
        console.error('[DiaryRoutes] AI图像生成失败，继续返回日记:', aiError);
      }

      // 重新获取materials以包含可能新生成的AI图像
      const updatedMaterials = await diaryService.getNodeMaterials(nodeId);

      return res.json({
        success: true,
        node: result.node,
        fragment: {
          ...result.fragment,
          nodeName: node.name,
          nodeStatus: 'unrealized',
          statusReason: reason,
          photos: updatedMaterials?.photos.map((p) => ({
            id: p.id,
            url: p.url,
            uploadTime: p.uploadTime,
            visionAnalysis: p.visionAnalysis,
            isAiGenerated: p.visionAnalysis?.startsWith('AI_GENERATED'),
            aiImageOrientation: p.visionAnalysis?.includes('LANDSCAPE') ? 'landscape' : p.visionAnalysis?.includes('PORTRAIT') ? 'portrait' : undefined,
          })) || [],
        },
        aiGeneratedImageUrl,
        aiImageOrientation,
      });
    } catch (error) {
      console.error('Mark unrealized error:', error);
      return res.status(500).json({
        success: false,
        error: '标记未实现失败，请重试',
      });
    }
  }
);

/**
 * POST /api/trips/:tripId/nodes/:nodeId/light-changed
 * Light up a changed node and generate diary fragment
 * 点亮变更后的节点并生成日记片段
 */
router.post(
  '/trips/:tripId/nodes/:nodeId/light-changed',
  async (req: Request, res: Response) => {
    try {
      const { tripId, nodeId } = req.params;
      const { moodEmoji, textNotes, weather, timeRange } = req.body;

      // Validate node exists
      const node = await diaryService.getTravelNode(nodeId);
      if (!node) {
        return res.status(404).json({
          success: false,
          error: '节点不存在',
        });
      }

      // Check if this is a changed node
      if (node.nodeStatus !== 'changed') {
        return res.status(400).json({
          success: false,
          error: '该节点不是变更节点',
        });
      }

      // Get node materials
      let materials = await diaryService.getNodeMaterials(nodeId);
      
      if (!materials) {
        materials = {
          id: '',
          nodeId,
          moodEmoji: moodEmoji || undefined,
          photos: [],
          voiceRecordings: [],
          textNotes: textNotes || [],
        };
      } else {
        materials.textNotes = textNotes || [];
      }

      // Update mood emoji if provided
      if (moodEmoji) {
        await diaryService.updateMoodEmoji(nodeId, moodEmoji);
        materials.moodEmoji = moodEmoji;
      }

      // Generate diary fragment for changed node
      const fragment = await diaryService.generateChangedNodeDiary(
        node,
        tripId,
        materials,
        weather,
        timeRange
      );

      // 检查是否有用户上传的照片
      const userPhotos = materials.photos.filter(p => !p.visionAnalysis?.startsWith('AI_GENERATED'));
      let aiGeneratedImageUrl: string | undefined;
      let aiImageOrientation: 'portrait' | 'landscape' | undefined;

      // 如果没有用户上传的照片，自动生成AI图像
      if (userPhotos.length === 0) {
        console.log('[DiaryRoutes] 变更节点没有用户上传的照片，自动生成AI图像');
        try {
          const aiResult = await diaryService.generateAiImage(
            nodeId,
            fragment.content,
            node.name,
            node.description,
            weather,
            moodEmoji
          );
          aiGeneratedImageUrl = aiResult.url;
          aiImageOrientation = aiResult.orientation;
          console.log('[DiaryRoutes] AI图像生成成功:', aiGeneratedImageUrl, '方向:', aiImageOrientation);
        } catch (aiError) {
          console.error('[DiaryRoutes] AI图像生成失败，继续返回日记:', aiError);
        }
      }

      // 重新获取materials以包含可能新生成的AI图像
      const updatedMaterials = await diaryService.getNodeMaterials(nodeId);

      return res.json({
        success: true,
        fragment: {
          ...fragment,
          nodeName: node.name,
          nodeStatus: 'changed',
          statusReason: node.statusReason,
          photos: updatedMaterials?.photos.map((p) => ({
            id: p.id,
            url: p.url,
            uploadTime: p.uploadTime,
            visionAnalysis: p.visionAnalysis,
            isAiGenerated: p.visionAnalysis?.startsWith('AI_GENERATED'),
            aiImageOrientation: p.visionAnalysis?.includes('LANDSCAPE') ? 'landscape' : p.visionAnalysis?.includes('PORTRAIT') ? 'portrait' : undefined,
          })) || [],
        },
        aiGeneratedImageUrl,
        aiImageOrientation,
      });
    } catch (error) {
      console.error('Light changed node error:', error);
      return res.status(500).json({
        success: false,
        error: '点亮变更节点失败，请重试',
      });
    }
  }
);

/**
 * POST /api/trips/:tripId/nodes/:nodeId/generate-ai-image
 * Generate AI image for a diary fragment without photos
 * 为没有照片的日记片段生成AI图像
 */
router.post(
  '/trips/:tripId/nodes/:nodeId/generate-ai-image',
  async (req: Request, res: Response) => {
    try {
      const { nodeId } = req.params;
      const { diaryContent, weather, moodEmoji } = req.body;

      // Validate node exists
      const node = await diaryService.getTravelNode(nodeId);
      if (!node) {
        return res.status(404).json({
          success: false,
          error: '节点不存在',
        });
      }

      if (!diaryContent) {
        return res.status(400).json({
          success: false,
          error: '请提供日记内容',
        });
      }

      // Generate AI image (randomly portrait or landscape)
      const result = await diaryService.generateAiImage(
        nodeId,
        diaryContent,
        node.name,
        node.description,
        weather,
        moodEmoji
      );

      return res.json({
        success: true,
        imageUrl: result.url,
        orientation: result.orientation,
        isAiGenerated: true,
      });
    } catch (error) {
      console.error('Generate AI image error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'AI图像生成失败，请重试',
      });
    }
  }
);

export default router;
