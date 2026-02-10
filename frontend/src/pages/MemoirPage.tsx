import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Button, Loading, MemoirViewer, TemplateSelector } from '../components';
import { memoirApi, tripApi } from '../api';
import type { TravelMemoir, MemoirTemplate, Trip } from '../types';
import './MemoirPage.css';

const MemoirPage: React.FC = () => {
  const { tripId } = useParams<{ tripId: string }>();
  const [memoir, setMemoir] = useState<TravelMemoir | null>(null);
  const [templates, setTemplates] = useState<MemoirTemplate[]>([]);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isChangingTemplate, setIsChangingTemplate] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTemplateSelector, setShowTemplateSelector] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);

  // Load memoir and templates
  useEffect(() => {
    const loadData = async () => {
      if (!tripId) return;

      setIsLoading(true);
      setError(null);

      try {
        // Load templates first
        const templatesResponse = await memoirApi.getTemplates();
        // API returns { success: true, templates: [...] }
        const templatesData = templatesResponse.data as unknown as { success: boolean; templates: MemoirTemplate[] };
        setTemplates(templatesData.templates || []);

        // Try to load existing memoir
        try {
          const memoirResponse = await memoirApi.get(tripId);
          // API returns { success: true, memoir: {...} }
          const memoirData = memoirResponse.data as unknown as { success: boolean; memoir: TravelMemoir };
          setMemoir(memoirData.memoir || null);
        } catch {
          // Memoir doesn't exist yet, that's okay
          setMemoir(null);
        }

        // Load trip info
        const tripResponse = await tripApi.getTrip(tripId);
        setTrip(tripResponse.data);
      } catch (err) {
        console.error('Failed to load data:', err);
        setError('加载数据失败，请稍后重试');
      } finally {
        setIsLoading(false);
      }
    };

    loadData();
  }, [tripId]);

  // Generate memoir
  const handleGenerateMemoir = useCallback(async () => {
    if (!tripId) return;

    setIsGenerating(true);
    setError(null);

    try {
      const response = await memoirApi.complete(tripId);
      // API returns { success: true, memoir: {...} }
      const data = response.data as unknown as { success: boolean; memoir: TravelMemoir };
      setMemoir(data.memoir);
    } catch (err) {
      console.error('Failed to generate memoir:', err);
      setError('生成回忆录失败，请确保您已记录了旅行日记');
    } finally {
      setIsGenerating(false);
    }
  }, [tripId]);

  // Change template
  const handleTemplateChange = useCallback(async (templateId: string) => {
    if (!tripId || !memoir) return;

    setIsChangingTemplate(true);

    try {
      await memoirApi.changeTemplate(tripId, templateId);
      setMemoir((prev) => prev ? { ...prev, templateId } : null);
      setShowTemplateSelector(false);
    } catch (err) {
      console.error('Failed to change template:', err);
      setError('切换模板失败，请稍后重试');
    } finally {
      setIsChangingTemplate(false);
    }
  }, [tripId, memoir]);

  // Generate share URL
  const handleShare = useCallback(async () => {
    if (!tripId) return;

    setIsSharing(true);
    setError(null);

    try {
      const response = await memoirApi.generateShareUrl(tripId);
      const fullShareUrl = `${window.location.origin}${response.data.shareUrl}`;
      setShareUrl(fullShareUrl);
      setShowShareModal(true);
    } catch (err) {
      console.error('Failed to generate share URL:', err);
      setError('生成分享链接失败，请稍后重试');
    } finally {
      setIsSharing(false);
    }
  }, [tripId]);

  // Copy share URL to clipboard
  const handleCopyShareUrl = useCallback(async () => {
    if (!shareUrl) return;

    try {
      await navigator.clipboard.writeText(shareUrl);
      setError(null);
      // Show success feedback
      const originalUrl = shareUrl;
      setShareUrl('已复制到剪贴板！');
      setTimeout(() => setShareUrl(originalUrl), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
      setError('复制失败，请手动复制链接');
    }
  }, [shareUrl]);

  // Download memoir as HTML
  const handleDownload = useCallback(() => {
    if (!tripId) return;

    const downloadUrl = memoirApi.getDownloadUrl(tripId);
    window.open(downloadUrl, '_blank');
  }, [tripId]);

  // Get current template
  const currentTemplate = templates.find((t) => t.id === memoir?.templateId) || templates[0];

  // Loading state
  if (isLoading) {
    return (
      <div className="page memoir-page">
        <div className="memoir-page__loading">
          <Loading size="lg" />
          <p className="memoir-page__loading-text">加载中...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error && !memoir) {
    return (
      <div className="page memoir-page">
        <div className="memoir-page__error">
          <span className="memoir-page__error-icon">😢</span>
          <p className="memoir-page__error-text">{error}</p>
          <Button variant="primary" onClick={() => window.location.reload()}>
            重新加载
          </Button>
        </div>
      </div>
    );
  }

  // No memoir yet - show generation prompt
  if (!memoir) {
    return (
      <div className="page memoir-page">
        <div className="memoir-page__header">
          <div className="memoir-page__header-left">
            <Link to={tripId ? `/traveling/${tripId}` : '/'} className="memoir-page__back-link">
              ← 返回旅行
            </Link>
            <h1 className="memoir-page__title">
              {trip?.destination || '旅行'}回忆录
            </h1>
          </div>
        </div>

        <div className="memoir-page__generate-prompt">
          <div className="memoir-page__generate-card">
            <span className="memoir-page__generate-icon">📖</span>
            <h2 className="memoir-page__generate-title">生成您的旅行回忆录</h2>
            <p className="memoir-page__generate-description">
              将您的旅行日记整合成一本精美的电子迹录，包含旅行人格分析和独特的水彩风封面。
            </p>
            <Button
              variant="primary"
              size="lg"
              onClick={handleGenerateMemoir}
              isLoading={isGenerating}
            >
              {isGenerating ? '正在生成...' : '开始生成回忆录'}
            </Button>
            {isGenerating && (
              <p className="memoir-page__generate-hint">
                正在分析您的旅行数据并生成个性化内容，请稍候...
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Show memoir
  return (
    <div className="page memoir-page">
      <div className="memoir-page__header">
        <div className="memoir-page__header-left">
          <Link to="/" className="memoir-page__back-link">
            ← 返回首页
          </Link>
          <h1 className="memoir-page__title">{memoir.title}</h1>
        </div>
        <div className="memoir-page__header-right">
          <Link to={`/traveling/${tripId}`}>
            <Button variant="outline">
              📝 查看原始日记
            </Button>
          </Link>
          <Button
            variant="outline"
            onClick={() => setShowTemplateSelector(!showTemplateSelector)}
          >
            🎨 切换模板
          </Button>
          <Button
            variant="outline"
            onClick={handleShare}
            isLoading={isSharing}
          >
            🔗 分享
          </Button>
          <Button
            variant="primary"
            onClick={handleDownload}
          >
            📥 下载
          </Button>
        </div>
      </div>

      {/* Share Modal */}
      {showShareModal && (
        <div className="memoir-page__modal-overlay" onClick={() => setShowShareModal(false)}>
          <div className="memoir-page__modal" onClick={(e) => e.stopPropagation()}>
            <div className="memoir-page__modal-header">
              <h3>分享回忆录</h3>
              <button
                className="memoir-page__modal-close"
                onClick={() => setShowShareModal(false)}
              >
                ×
              </button>
            </div>
            <div className="memoir-page__modal-body">
              <p className="memoir-page__share-hint">复制以下链接分享给朋友：</p>
              <div className="memoir-page__share-url-container">
                <input
                  type="text"
                  className="memoir-page__share-url-input"
                  value={shareUrl || ''}
                  readOnly
                />
                <Button variant="primary" size="sm" onClick={handleCopyShareUrl}>
                  复制
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Template Selector Panel */}
      {showTemplateSelector && (
        <div className="memoir-page__template-panel">
          <TemplateSelector
            templates={templates}
            selectedTemplateId={memoir.templateId}
            onSelect={handleTemplateChange}
            isLoading={isChangingTemplate}
          />
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="memoir-page__error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      {/* Memoir Content */}
      <div className="memoir-page__content">
        {currentTemplate && (
          <MemoirViewer memoir={memoir} template={currentTemplate} />
        )}
      </div>
    </div>
  );
};

export default MemoirPage;
