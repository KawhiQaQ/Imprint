import React, { useState, useRef, useEffect } from 'react';
import type { ChatMessage } from '../../types';
import './ChatPanel.css';

export interface ChatPanelProps {
  messages: ChatMessage[];
  onSendMessage: (message: string) => void;
  isLoading: boolean;
  placeholder?: string;
}

// 快捷指令配置
const quickCommands = [
  { icon: '🍱', label: '推荐餐厅', message: '帮我推荐一些当地特色餐厅' },
  { icon: '🚗', label: '调整交通', message: '帮我优化一下交通安排' },
  { icon: '🌧️', label: '备选方案', message: '如果下雨有什么备选方案' },
];

const ChatPanel: React.FC<ChatPanelProps> = ({
  messages,
  onSendMessage,
  isLoading,
  placeholder = '输入您的偏好，如"我不吃辣"、"想多看自然风景"...',
}) => {
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Auto-resize textarea
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 120)}px`;
    }
  }, [inputValue]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedValue = inputValue.trim();
    if (trimmedValue && !isLoading) {
      onSendMessage(trimmedValue);
      setInputValue('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleQuickCommand = (message: string) => {
    if (!isLoading) {
      onSendMessage(message);
    }
  };

  const formatTime = (date: Date) => {
    const d = new Date(date);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="chat-panel">
      {/* 消息区域 */}
      <div className="chat-panel__messages" role="log" aria-live="polite">
        {messages.length === 0 ? (
          <div className="chat-panel__empty">
            <div className="chat-panel__empty-icon">📔</div>
            <p className="chat-panel__empty-text">
              您好！我是您的旅行伴侣。<br />
              告诉我您的偏好，我来帮您调整行程。
            </p>
          </div>
        ) : (
          messages.map((message, index) => (
            <div
              key={index}
              className={`chat-panel__message chat-panel__message--${message.role}`}
            >
              <div className="chat-panel__message-content">
                <div className="chat-panel__message-text">{message.content}</div>
                <div className="chat-panel__message-time">
                  {formatTime(message.timestamp)}
                </div>
              </div>
            </div>
          ))
        )}
        {isLoading && (
          <div className="chat-panel__message chat-panel__message--assistant chat-panel__message--loading">
            <div className="chat-panel__message-content">
              <div className="chat-panel__typing">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 底部输入区域 */}
      <div className="chat-panel__footer">
        {/* 快捷指令石 */}
        <div className="chat-panel__quick-commands">
          {quickCommands.map((cmd, index) => (
            <button
              key={index}
              className="chat-panel__quick-cmd"
              onClick={() => handleQuickCommand(cmd.message)}
              disabled={isLoading}
              type="button"
            >
              <span className="chat-panel__quick-cmd-icon">{cmd.icon}</span>
              <span className="chat-panel__quick-cmd-label">{cmd.label}</span>
            </button>
          ))}
        </div>

        {/* 输入框 */}
        <form className="chat-panel__input-area" onSubmit={handleSubmit}>
          <textarea
            ref={inputRef}
            className="chat-panel__input"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={isLoading}
            rows={1}
            aria-label="输入消息"
          />
          <button
            type="submit"
            className="chat-panel__send-btn"
            disabled={!inputValue.trim() || isLoading}
            aria-label="发送"
          >
            <span className="chat-panel__send-btn-text">发送</span>
          </button>
        </form>
      </div>
    </div>
  );
};

export default ChatPanel;
