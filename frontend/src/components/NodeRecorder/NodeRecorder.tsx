import React, { useState, useRef, useCallback, useEffect } from 'react';
import type { TravelNode, PhotoMaterial } from '../../types';
import { Button } from '../Button';
import './NodeRecorder.css';

// 常用心情 - 平铺展示（两行16个）
const MOOD_EMOJIS = [
  { emoji: '😊', label: '开心' },
  { emoji: '🥰', label: '幸福' },
  { emoji: '😎', label: '酷' },
  { emoji: '🤩', label: '惊喜' },
  { emoji: '😌', label: '放松' },
  { emoji: '😋', label: '美味' },
  { emoji: '🤔', label: '思考' },
  { emoji: '😢', label: '感动' },
  { emoji: '💪', label: '充实' },
  { emoji: '❤️', label: '喜爱' },
  { emoji: '😴', label: '疲惫' },
  { emoji: '🤗', label: '温暖' },
  { emoji: '😇', label: '满足' },
  { emoji: '🥳', label: '庆祝' },
  { emoji: '🫠', label: '放空' },
  { emoji: '🥹', label: '感慨' },
];

// 常用天气 - 平铺展示（两行16个）
const WEATHER_OPTIONS = [
  { emoji: '☀️', label: '晴' },
  { emoji: '⛅', label: '多云' },
  { emoji: '☁️', label: '阴' },
  { emoji: '🌧️', label: '雨' },
  { emoji: '⛈️', label: '雷雨' },
  { emoji: '🌨️', label: '雪' },
  { emoji: '🌬️', label: '风' },
  { emoji: '🌫️', label: '雾' },
  { emoji: '🌈', label: '彩虹' },
  { emoji: '🌙', label: '夜晚' },
  { emoji: '🌤️', label: '晴间多云' },
  { emoji: '🌦️', label: '阵雨' },
  { emoji: '❄️', label: '寒冷' },
  { emoji: '🌞', label: '炎热' },
  { emoji: '🌊', label: '潮湿' },
  { emoji: '🍃', label: '微风' },
];

export interface TimedNote {
  content: string;
}

export interface NodeRecorderProps {
  node: TravelNode;
  photos: PhotoMaterial[];
  textNotes: TimedNote[];
  selectedMood?: string;
  selectedWeather?: string;
  onPhotoUpload: (file: File, time: string) => void;
  onPhotoDelete?: (photoId: string) => void;
  onTextNote: (note: TimedNote) => void;
  onTextNoteDelete?: (index: number) => void;
  onMoodSelect: (emoji: string) => void;
  onWeatherSelect: (weather: string) => void;
  onLight: () => void;
  onRegenerate?: () => void;
  onChangeItinerary?: (newDestination: string, changeReason: string) => void;
  onMarkUnrealized?: (reason: string, moodEmoji?: string, weather?: string) => void;
  isLit: boolean;
  isLoading?: boolean;
  destination?: string; // 目的地城市，用于导航和搜索
}


const NodeRecorder: React.FC<NodeRecorderProps> = ({
  node,
  photos,
  textNotes,
  selectedMood,
  selectedWeather,
  onPhotoUpload,
  onPhotoDelete,
  onTextNote,
  onTextNoteDelete,
  onMoodSelect,
  onWeatherSelect,
  onLight,
  onRegenerate,
  onChangeItinerary,
  onMarkUnrealized,
  isLit,
  isLoading = false,
  destination = '',
}) => {
  const [textInput, setTextInput] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);
  const [showLightGlow, setShowLightGlow] = useState(false);
  
  // 印章动画状态
  const [stampingWeather, setStampingWeather] = useState<string | null>(null);
  const [stampingMood, setStampingMood] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  
  // Modal states
  const [showChangeModal, setShowChangeModal] = useState(false);
  const [newDestination, setNewDestination] = useState('');
  const [changeReason, setChangeReason] = useState('');
  const [showUnrealizedModal, setShowUnrealizedModal] = useState(false);
  const [unrealizedReason, setUnrealizedReason] = useState('');
  const [unrealizedMood, setUnrealizedMood] = useState<string | undefined>();
  const [unrealizedWeather, setUnrealizedWeather] = useState<string | undefined>();
  const [showUnrealizedMoodPicker, setShowUnrealizedMoodPicker] = useState(false);
  const [showUnrealizedWeatherPicker, setShowUnrealizedWeatherPicker] = useState(false);
  const [showStamp, setShowStamp] = useState(false);
  const [isEntering, setIsEntering] = useState(true);
  
  // 弹窗语音录入状态
  const [isRecordingChange, setIsRecordingChange] = useState(false);
  const [isRecordingUnrealized, setIsRecordingUnrealized] = useState(false);
  const changeRecognitionRef = useRef<any>(null);
  const unrealizedRecognitionRef = useRef<any>(null);

  // 天气印章点击
  const handleWeatherStamp = useCallback((emoji: string) => {
    setStampingWeather(emoji);
    onWeatherSelect(emoji);
    setTimeout(() => setStampingWeather(null), 300);
  }, [onWeatherSelect]);

  // 心情印章点击
  const handleMoodStamp = useCallback((emoji: string) => {
    setStampingMood(emoji);
    onMoodSelect(emoji);
    setTimeout(() => setStampingMood(null), 300);
  }, [onMoodSelect]);

  // 入场动画 - 切换节点时重置状态
  useEffect(() => {
    setIsEntering(true);
    setShowStamp(false); // 重置印章动画状态
    setShowLightGlow(false);
    const timer = setTimeout(() => setIsEntering(false), 50);
    return () => clearTimeout(timer);
  }, [node.id]);

  const getCurrentTime = () => {
    const now = new Date();
    return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
  };

  const handlePhotoClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    // 只允许1张照片
    if (photos.length >= 1) {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      return;
    }
    const files = e.target.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (file.type.startsWith('image/')) {
        onPhotoUpload(file, '');
      }
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [photos.length, onPhotoUpload]);

  // 拖拽处理
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    // 只允许1张照片
    if (photos.length >= 1) {
      return;
    }
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (file.type.startsWith('image/')) {
        // 直接上传照片，使用当前时间
        onPhotoUpload(file, getCurrentTime());
      }
    }
  }, [photos.length, onPhotoUpload]);

  const startVoiceInput = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('您的浏览器不支持语音识别功能，请使用Chrome浏览器');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onstart = () => {
      setIsRecording(true);
      setIsTranscribing(true);
    };

    recognition.onresult = (event: any) => {
      const result = event.results[event.results.length - 1];
      if (result.isFinal || !recognition.interimResults) {
        const transcript = result[0].transcript;
        setTextInput(prev => prev + transcript);
      }
    };

    recognition.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error);
      setIsRecording(false);
      setIsTranscribing(false);
      if (event.error === 'not-allowed') {
        alert('请允许麦克风权限以使用语音输入');
      }
    };

    recognition.onend = () => {
      setIsRecording(false);
      setIsTranscribing(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, []);

  const stopVoiceInput = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsRecording(false);
    setIsTranscribing(false);
  }, []);

  // 变更原因语音输入
  const startChangeVoiceInput = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('您的浏览器不支持语音识别功能');
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onstart = () => setIsRecordingChange(true);
    recognition.onresult = (event: any) => {
      const transcript = event.results[event.results.length - 1][0].transcript;
      setChangeReason(prev => prev + transcript);
    };
    recognition.onerror = () => setIsRecordingChange(false);
    recognition.onend = () => setIsRecordingChange(false);
    changeRecognitionRef.current = recognition;
    recognition.start();
  }, []);

  const stopChangeVoiceInput = useCallback(() => {
    if (changeRecognitionRef.current) {
      changeRecognitionRef.current.stop();
      changeRecognitionRef.current = null;
    }
    setIsRecordingChange(false);
  }, []);

  // 未实现原因语音输入
  const startUnrealizedVoiceInput = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('您的浏览器不支持语音识别功能');
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onstart = () => setIsRecordingUnrealized(true);
    recognition.onresult = (event: any) => {
      const transcript = event.results[event.results.length - 1][0].transcript;
      setUnrealizedReason(prev => prev + transcript);
    };
    recognition.onerror = () => setIsRecordingUnrealized(false);
    recognition.onend = () => setIsRecordingUnrealized(false);
    unrealizedRecognitionRef.current = recognition;
    recognition.start();
  }, []);

  const stopUnrealizedVoiceInput = useCallback(() => {
    if (unrealizedRecognitionRef.current) {
      unrealizedRecognitionRef.current.stop();
      unrealizedRecognitionRef.current = null;
    }
    setIsRecordingUnrealized(false);
  }, []);

  const handleTextSubmit = useCallback(() => {
    if (textInput.trim()) {
      onTextNote({ content: textInput.trim() });
      setTextInput('');
    }
  }, [textInput, onTextNote]);

  // 处理变更行程确认
  const handleChangeConfirm = useCallback(() => {
    if (newDestination.trim() && changeReason.trim() && onChangeItinerary) {
      onChangeItinerary(newDestination.trim(), changeReason.trim());
      setShowChangeModal(false);
      setNewDestination('');
      setChangeReason('');
    }
  }, [newDestination, changeReason, onChangeItinerary]);

  // 处理未实现确认
  const handleUnrealizedConfirm = useCallback(() => {
    if (unrealizedReason.trim() && onMarkUnrealized) {
      onMarkUnrealized(unrealizedReason.trim(), unrealizedMood, unrealizedWeather);
      setShowUnrealizedModal(false);
      setUnrealizedReason('');
      setUnrealizedMood(undefined);
      setUnrealizedWeather(undefined);
    }
  }, [unrealizedReason, unrealizedMood, unrealizedWeather, onMarkUnrealized]);

  // 点亮动画 - 红色印章效果
  const handleLightClick = useCallback(() => {
    setShowLightGlow(true);
    setShowStamp(true);
    onLight();
    setTimeout(() => setShowLightGlow(false), 1500);
  }, [onLight]);

  // 打开地图导航
  const handleOpenNavigation = useCallback(() => {
    const keyword = destination 
      ? `${destination}${node.name}` 
      : node.name;
    const url = `https://uri.amap.com/search?keyword=${encodeURIComponent(keyword)}&city=${encodeURIComponent(destination)}`;
    window.open(url, '_blank');
  }, [destination, node.name]);

  // 打开详情搜索
  const handleOpenDetails = useCallback(() => {
    const searchQuery = destination 
      ? `${destination} ${node.name} 攻略` 
      : `${node.name} 攻略`;
    const url = `https://www.baidu.com/s?wd=${encodeURIComponent(searchQuery)}`;
    window.open(url, '_blank');
  }, [destination, node.name]);

  // 判断节点是否可操作
  const isNodeDisabled = node.nodeStatus === 'changed_original';
  const hasNewContent = photos.length > 0 || textNotes.length > 0;
  const canLight = (photos.length > 0 || textNotes.length > 0) && selectedMood && selectedWeather;


  return (
    <div className={`node-recorder ${isLit ? 'node-recorder--lit' : ''} ${isNodeDisabled ? 'node-recorder--disabled' : ''} ${showLightGlow ? 'node-recorder--glowing' : ''} ${isEntering ? 'node-recorder--entering' : 'node-recorder--entered'}`}>
      {/* 光晕效果层 */}
      {showLightGlow && <div className="node-recorder__glow-overlay" />}
      
      {/* ========== A. 顶部：仪式感操作区 ========== */}
      <header className="node-recorder__ritual-header">
        <div className="node-recorder__title-section">
          <div className="node-recorder__title-row">
            <h2 className="node-recorder__main-title">{node.name}</h2>
            {/* 红色印章 - 仅在已点亮时显示 */}
            {isLit && (
              <div className={`node-recorder__stamp ${showStamp ? 'node-recorder__stamp--animating' : ''}`}>
                <span className="node-recorder__stamp-text">到此一游</span>
              </div>
            )}
          </div>
          <span className="node-recorder__time-moment">{node.scheduledTime}</span>
          {node.nodeStatus === 'changed' && (
            <span className="node-recorder__status-tag node-recorder__status-tag--changed">🔄 变更</span>
          )}
          {node.nodeStatus === 'unrealized' && (
            <span className="node-recorder__status-tag node-recorder__status-tag--unrealized">⏭️ 未实现</span>
          )}
          
          {/* 快捷操作按钮 - 导航和详情 */}
          <div className="node-recorder__quick-actions">
            <button
              className="node-recorder__action-btn"
              onClick={handleOpenNavigation}
              title="在地图中查看位置"
            >
              📍 地图导航
            </button>
            <button
              className="node-recorder__action-btn"
              onClick={handleOpenDetails}
              title="搜索更多攻略信息"
            >
              🔗 查看详情
            </button>
          </div>
        </div>
        
        {/* 点亮书签 - 右上角书签风格 */}
        {!isNodeDisabled && (
          <div className="node-recorder__bookmark-area">
            {!isLit ? (
              <button
                className={`node-recorder__bookmark ${canLight ? 'node-recorder__bookmark--ready' : ''}`}
                onClick={handleLightClick}
                disabled={isLoading || !canLight}
                title={!canLight ? '请添加照片或文字、选择心情和天气后点亮' : '点亮此刻'}
              >
                <svg className="node-recorder__bookmark-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                </svg>
                <span className="node-recorder__bookmark-label">
                  {isLoading ? '...' : '点亮'}
                </span>
              </button>
            ) : (
              <div className="node-recorder__bookmark node-recorder__bookmark--lit">
                <svg className="node-recorder__bookmark-icon" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1">
                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                </svg>
                <span className="node-recorder__bookmark-label">已点亮</span>
              </div>
            )}
          </div>
        )}
      </header>

      {/* ========== 天气与心情印章区 ========== */}
      {!isNodeDisabled && (
        <div className="node-recorder__stamps-area">
          {/* 天气印章行 */}
          <div className="node-recorder__stamp-row">
            <span className="node-recorder__stamp-label">天气</span>
            <div className="node-recorder__stamp-options">
              {WEATHER_OPTIONS.map(({ emoji, label }) => (
                <button
                  key={emoji}
                  className={`node-recorder__stamp-btn ${selectedWeather === emoji ? 'node-recorder__stamp-btn--selected' : ''} ${stampingWeather === emoji ? 'node-recorder__stamp-btn--stamping' : ''}`}
                  onClick={() => handleWeatherStamp(emoji)}
                  title={label}
                >
                  <span className="node-recorder__stamp-emoji">{emoji}</span>
                </button>
              ))}
            </div>
          </div>
          
          {/* 心情印章行 */}
          <div className="node-recorder__stamp-row">
            <span className="node-recorder__stamp-label">心情</span>
            <div className="node-recorder__stamp-options">
              {MOOD_EMOJIS.map(({ emoji, label }) => (
                <button
                  key={emoji}
                  className={`node-recorder__stamp-btn ${selectedMood === emoji ? 'node-recorder__stamp-btn--selected' : ''} ${stampingMood === emoji ? 'node-recorder__stamp-btn--stamping' : ''}`}
                  onClick={() => handleMoodStamp(emoji)}
                  title={label}
                >
                  <span className="node-recorder__stamp-emoji">{emoji}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 变更/未实现原因 */}
      {node.statusReason && (
        <div className="node-recorder__status-reason">
          <span className="node-recorder__status-reason-label">
            {node.nodeStatus === 'changed' ? '变更原因：' : 
             node.nodeStatus === 'unrealized' ? '未实现原因：' : ''}
          </span>
          {node.statusReason}
        </div>
      )}

      {/* ========== B. 核心记录区 ========== */}
      {!isNodeDisabled && (
        <div className="node-recorder__journal-area">
          {/* Hero Image 照片区 - 拍立得风格 */}
          <div 
            className={`node-recorder__hero-photo ${isDragging ? 'node-recorder__hero-photo--dragging' : ''} ${photos.length > 0 ? 'node-recorder__hero-photo--has-photo' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {photos.length > 0 ? (
              /* 已上传状态：拍立得装裱效果 */
              <div className="node-recorder__polaroid">
                <div className="node-recorder__polaroid-frame">
                  <img src={photos[0].url} alt="" />
                </div>
                {/* 悬停更换蒙层 */}
                <div className="node-recorder__polaroid-overlay" onClick={handlePhotoClick}>
                  <span className="node-recorder__polaroid-change-text">更换图片</span>
                </div>
                {/* 删除按钮 */}
                {onPhotoDelete && (
                  <button
                    className="node-recorder__polaroid-delete"
                    onClick={() => onPhotoDelete(photos[0].id)}
                    title="移除照片"
                  >
                    ×
                  </button>
                )}
              </div>
            ) : (
              /* 空状态：虚位以待的画布 */
              <div className="node-recorder__empty-canvas" onClick={handlePhotoClick}>
                <div className="node-recorder__empty-inner">
                  <svg className="node-recorder__empty-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="6" y="10" width="36" height="28" rx="2" />
                    <circle cx="16" cy="22" r="4" />
                    <path d="M6 32 L18 24 L26 30 L36 20 L42 26" />
                  </svg>
                  <span className="node-recorder__empty-text">定格此刻的高光画面</span>
                </div>
              </div>
            )}
            
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="node-recorder__file-input"
            />
          </div>

          {/* 文字记录列表 */}
          {textNotes.length > 0 && (
            <div className="node-recorder__notes-list">
              {textNotes.map((note, index) => (
                <div key={index} className="node-recorder__note-item">
                  <span className="node-recorder__note-content">{note.content}</span>
                  {onTextNoteDelete && (
                    <button
                      className="node-recorder__note-delete"
                      onClick={() => onTextNoteDelete(index)}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 文字日记输入区 */}
          <div className="node-recorder__text-area">
            <div className="node-recorder__text-editor">
              <div className="node-recorder__text-header">
                <span>📝 记录此刻</span>
              </div>
              <div className="node-recorder__textarea-container">
                <textarea
                  className="node-recorder__textarea"
                  placeholder="写下你此刻的感受..."
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  rows={2}
                />
                <button
                  className={`node-recorder__voice-btn ${isRecording ? 'node-recorder__voice-btn--recording' : ''}`}
                  onClick={isRecording ? stopVoiceInput : startVoiceInput}
                  disabled={isTranscribing && !isRecording}
                  title="语音输入"
                >
                  {isRecording ? '⏹️' : '🎤'}
                </button>
              </div>
              {isRecording && (
                <div className="node-recorder__recording-indicator">
                  🔴 正在录音...
                </div>
              )}
              <div className="node-recorder__text-actions">
                <Button variant="secondary" size="sm" onClick={() => { 
                  setTextInput(''); 
                  stopVoiceInput();
                }}>清空</Button>
                <Button variant="primary" size="sm" onClick={handleTextSubmit} disabled={!textInput.trim()}>保存</Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========== C. 底部：功能栏 ========== */}
      {!isLit && !isNodeDisabled && (
        <footer className="node-recorder__footer">
          <button 
            className="node-recorder__footer-link"
            onClick={() => setShowChangeModal(true)}
            disabled={isLoading}
          >
            变更行程
          </button>
          <button 
            className="node-recorder__footer-link"
            onClick={() => setShowUnrealizedModal(true)}
            disabled={isLoading}
          >
            未实现
          </button>
        </footer>
      )}

      {/* 已点亮时的重新生成按钮 */}
      {isLit && !isNodeDisabled && (
        <div className="node-recorder__regenerate-area">
          <Button
            variant="primary"
            size="sm"
            onClick={onRegenerate}
            disabled={isLoading || !hasNewContent}
          >
            {isLoading ? '生成中...' : '🔄 重新生成日记'}
          </Button>
        </div>
      )}


      {/* 变更行程弹窗 */}
      {showChangeModal && (
        <div className="node-recorder__modal-overlay">
          <div className="node-recorder__modal">
            <div className="node-recorder__modal-header">
              <h3>🔄 变更行程</h3>
              <button 
                className="node-recorder__modal-close"
                onClick={() => { setShowChangeModal(false); setNewDestination(''); setChangeReason(''); stopChangeVoiceInput(); }}
              >
                ×
              </button>
            </div>
            <div className="node-recorder__modal-body">
              <div className="node-recorder__modal-field">
                <label>原计划目的地</label>
                <div className="node-recorder__modal-original">{node.name}</div>
              </div>
              <div className="node-recorder__modal-field">
                <label>新目的地名称 *</label>
                <input
                  type="text"
                  placeholder="请输入变更后的目的地"
                  value={newDestination}
                  onChange={(e) => setNewDestination(e.target.value)}
                />
              </div>
              <div className="node-recorder__modal-field">
                <label>变更原因 *</label>
                <div className="node-recorder__modal-textarea-wrap">
                  <textarea
                    placeholder="请说明变更行程的原因..."
                    value={changeReason}
                    onChange={(e) => setChangeReason(e.target.value)}
                    rows={3}
                  />
                  <button
                    className={`node-recorder__modal-voice-btn ${isRecordingChange ? 'node-recorder__modal-voice-btn--recording' : ''}`}
                    onClick={isRecordingChange ? stopChangeVoiceInput : startChangeVoiceInput}
                    type="button"
                    title="语音输入"
                  >
                    {isRecordingChange ? '■' : '🎙'}
                  </button>
                </div>
              </div>
            </div>
            <div className="node-recorder__modal-footer">
              <Button 
                variant="secondary" 
                size="sm" 
                onClick={() => { setShowChangeModal(false); setNewDestination(''); setChangeReason(''); stopChangeVoiceInput(); }}
              >
                取消
              </Button>
              <Button 
                variant="primary" 
                size="sm" 
                onClick={handleChangeConfirm}
                disabled={!newDestination.trim() || !changeReason.trim() || isLoading}
              >
                {isLoading ? '处理中...' : '确认变更'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 未实现弹窗 */}
      {showUnrealizedModal && (
        <div className="node-recorder__modal-overlay">
          <div className="node-recorder__modal">
            <div className="node-recorder__modal-header">
              <h3>⏭️ 标记为未实现</h3>
              <button 
                className="node-recorder__modal-close"
                onClick={() => { 
                  setShowUnrealizedModal(false); 
                  setUnrealizedReason(''); 
                  setUnrealizedMood(undefined);
                  setUnrealizedWeather(undefined);
                  stopUnrealizedVoiceInput();
                }}
              >
                ×
              </button>
            </div>
            <div className="node-recorder__modal-body">
              <div className="node-recorder__modal-field">
                <label>原计划目的地</label>
                <div className="node-recorder__modal-original">{node.name}</div>
              </div>
              <div className="node-recorder__modal-field">
                <label>未实现原因 *</label>
                <div className="node-recorder__modal-textarea-wrap">
                  <textarea
                    placeholder="请说明未能实现的原因..."
                    value={unrealizedReason}
                    onChange={(e) => setUnrealizedReason(e.target.value)}
                    rows={3}
                  />
                  <button
                    className={`node-recorder__modal-voice-btn ${isRecordingUnrealized ? 'node-recorder__modal-voice-btn--recording' : ''}`}
                    onClick={isRecordingUnrealized ? stopUnrealizedVoiceInput : startUnrealizedVoiceInput}
                    type="button"
                    title="语音输入"
                  >
                    {isRecordingUnrealized ? '■' : '🎙'}
                  </button>
                </div>
              </div>
              <div className="node-recorder__modal-field">
                <label>天气（可选）</label>
                <button
                  className="node-recorder__modal-select-btn"
                  onClick={() => setShowUnrealizedWeatherPicker(!showUnrealizedWeatherPicker)}
                >
                  {unrealizedWeather ? (
                    <>
                      {WEATHER_OPTIONS.find(w => w.emoji === unrealizedWeather)?.emoji}
                      {' '}
                      {WEATHER_OPTIONS.find(w => w.emoji === unrealizedWeather)?.label}
                    </>
                  ) : '选择天气'}
                </button>
                {showUnrealizedWeatherPicker && (
                  <div className="node-recorder__modal-picker">
                    {WEATHER_OPTIONS.map(({ emoji, label }) => (
                      <button
                        key={emoji}
                        className={`node-recorder__modal-picker-item ${unrealizedWeather === emoji ? 'node-recorder__modal-picker-item--selected' : ''}`}
                        onClick={() => {
                          setUnrealizedWeather(emoji);
                          setShowUnrealizedWeatherPicker(false);
                        }}
                      >
                        {emoji} {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="node-recorder__modal-field">
                <label>心情（可选）</label>
                <button
                  className="node-recorder__modal-select-btn"
                  onClick={() => setShowUnrealizedMoodPicker(!showUnrealizedMoodPicker)}
                >
                  {unrealizedMood ? (
                    <>
                      {unrealizedMood}
                      {' '}
                      {MOOD_EMOJIS.find(m => m.emoji === unrealizedMood)?.label}
                    </>
                  ) : '选择心情'}
                </button>
                {showUnrealizedMoodPicker && (
                  <div className="node-recorder__modal-picker node-recorder__modal-picker--mood">
                    {MOOD_EMOJIS.map(({ emoji, label }) => (
                      <button
                        key={emoji}
                        className={`node-recorder__modal-picker-item ${unrealizedMood === emoji ? 'node-recorder__modal-picker-item--selected' : ''}`}
                        onClick={() => {
                          setUnrealizedMood(emoji);
                          setShowUnrealizedMoodPicker(false);
                        }}
                      >
                        {emoji} {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="node-recorder__modal-footer">
              <Button 
                variant="secondary" 
                size="sm" 
                onClick={() => { 
                  setShowUnrealizedModal(false); 
                  setUnrealizedReason(''); 
                  setUnrealizedMood(undefined);
                  setUnrealizedWeather(undefined);
                }}
              >
                取消
              </Button>
              <Button 
                variant="primary" 
                size="sm" 
                onClick={handleUnrealizedConfirm}
                disabled={!unrealizedReason.trim() || isLoading}
              >
                {isLoading ? '处理中...' : '确认'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default NodeRecorder;
