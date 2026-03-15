// ==UserScript==
// @name         B站先知
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  看视频前先知道值不值得看。AI自动分析字幕，主页封面直出评级+概述+关键点，进度条标注时间轴
// @author       Original Author + AI Enhanced
// @match        *://www.bilibili.com/*
// @match        *://bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.bilibili.com
// @connect      api.openai.com
// @connect      api.deepseek.com
// @connect      openrouter.ai
// @connect      *
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function() {
  'use strict';

  // ============================================================
  // 模块1: 配置管理
  // ============================================================
  const Config = {
    defaults: {
      // LLM配置
      llm: {
        endpoint: 'https://api.openai.com/v1/chat/completions',
        apiKey: '',
        model: 'gpt-4o-mini',
        maxTokens: 1500,
        temperature: 0.7,
        promptVersion: 'v1',
        targetLang: 'zh',
        stream: true
      },
      // 触发配置
      trigger: {
        mode: 'hover',      // hover | click
        hoverDelay: 800,    // 悬浮延迟(ms)
        autoPreload: false, // 是否自动预加载
        autoPreloadConcurrency: 2, // 自动预加载并发数
        cancelOnMouseLeave: true
      },
      // 显示配置
      display: {
        showInHomepage: true,
        showInSearch: true,
        showInPopular: true,
        showInSpace: true,
        onlyShowWithCC: true
      },
      // 缓存配置
      cache: {
        ttl: 7 * 24 * 60 * 60 * 1000  // 7天
      }
    },

    get(key) {
      const value = GM_getValue(key);
      if (value === undefined) {
        // 支持嵌套键，如 'llm.endpoint'
        const keys = key.split('.');
        let result = this.defaults;
        for (const k of keys) {
          result = result?.[k];
        }
        return result;
      }
      return value;
    },

    set(key, value) {
      GM_setValue(key, value);
    },

    getAll() {
      return {
        llm: {
          endpoint: this.get('llm.endpoint'),
          apiKey: this.get('llm.apiKey'),
          model: this.get('llm.model'),
          maxTokens: this.get('llm.maxTokens'),
          temperature: this.get('llm.temperature'),
          promptVersion: this.get('llm.promptVersion'),
          targetLang: this.get('llm.targetLang'),
          stream: this.get('llm.stream')
        },
        trigger: {
          mode: this.get('trigger.mode'),
          hoverDelay: this.get('trigger.hoverDelay'),
          autoPreload: this.get('trigger.autoPreload'),
          autoPreloadConcurrency: this.get('trigger.autoPreloadConcurrency') || 2,
          cancelOnMouseLeave: this.get('trigger.cancelOnMouseLeave')
        },
        display: {
          showInHomepage: this.get('display.showInHomepage'),
          showInSearch: this.get('display.showInSearch'),
          showInPopular: this.get('display.showInPopular'),
          showInSpace: this.get('display.showInSpace'),
          onlyShowWithCC: this.get('display.onlyShowWithCC')
        },
        cache: {
          ttl: this.get('cache.ttl')
        }
      };
    }
  };

  // ============================================================
  // 模块2: IndexedDB缓存
  // ============================================================
  const CacheDB = {
    dbName: 'BilibiliAISummary',
    storeName: 'summariesV2',
    db: null,

    async init() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(this.dbName, 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          this.db = request.result;
          resolve();
        };
        request.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            const store = db.createObjectStore(this.storeName, { keyPath: 'cacheKey' });
            store.createIndex('bvid', 'bvid', { unique: false });
            store.createIndex('timestamp', 'timestamp', { unique: false });
          }
        };
      });
    },

    async get(cacheKey) {
      return new Promise((resolve, reject) => {
        if (!this.db) return resolve(null);
        const tx = this.db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const request = store.get(cacheKey);
        request.onsuccess = () => {
          const data = request.result;
          if (data && Date.now() - data.timestamp < Config.get('cache.ttl')) {
            resolve(data);
          } else {
            resolve(null);  // 过期或不存在
          }
        };
        request.onerror = () => reject(request.error);
      });
    },

    async set(entry) {
      return new Promise((resolve, reject) => {
        if (!this.db) return resolve();
        const tx = this.db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.put({ ...entry, timestamp: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    async clear() {
      return new Promise((resolve, reject) => {
        if (!this.db) return resolve();
        const tx = this.db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  };

  // ============================================================
  // 模块3: LLM调用 (OpenAI兼容格式)
  // ============================================================
  class PipelineError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'PipelineError';
      this.code = code;
    }
  }

  const ErrorCode = {
    CONFIG_INVALID: 'CONFIG_INVALID',
    NETWORK_ERROR: 'NETWORK_ERROR',
    TIMEOUT: 'TIMEOUT',
    API_ERROR: 'API_ERROR',
    RATE_LIMIT: 'RATE_LIMIT',
    NO_SUBTITLE: 'NO_SUBTITLE',
    SUBTITLE_EMPTY: 'SUBTITLE_EMPTY',
    ABORTED: 'ABORTED',
    UNSUPPORTED: 'UNSUPPORTED'
  };

  const LLM = {
    isPrivateIPv4(hostname) {
      const parts = hostname.split('.').map((x) => Number(x));
      if (parts.length !== 4 || parts.some((x) => Number.isNaN(x) || x < 0 || x > 255)) {
        return false;
      }

      const [a, b] = parts;
      if (a === 10) return true;
      if (a === 127) return true;
      if (a === 169 && b === 254) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 100 && b >= 64 && b <= 127) return true;
      return false;
    },

    isPrivateHost(hostname) {
      const lower = (hostname || '').toLowerCase();
      if (!lower) return false;
      if (lower === 'localhost' || lower === '::1') return true;
      if (this.isPrivateIPv4(lower)) return true;
      if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')) return true;
      if (lower.endsWith('.local') || lower.endsWith('.lan') || lower.endsWith('.internal')) return true;
      return false;
    },

    isValidEndpoint(urlText) {
      try {
        const url = new URL(urlText);
        if (url.protocol === 'https:') return true;
        if (url.protocol !== 'http:') return false;
        return this.isPrivateHost(url.hostname);
      } catch {
        return false;
      }
    },

    extractTextContent(content) {
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .map((part) => {
            if (typeof part === 'string') return part;
            if (part && typeof part.text === 'string') return part.text;
            if (part && typeof part.content === 'string') return part.content;
            return '';
          })
          .join('')
          .trim();
      }
      return '';
    },

    normalizeResponseText(payload) {
      if (!payload || typeof payload !== 'object') {
        throw new PipelineError(ErrorCode.API_ERROR, '模型返回格式异常');
      }
      if (payload.error) {
        const status = payload.error?.code;
        if (status === 'rate_limit_exceeded') {
          throw new PipelineError(ErrorCode.RATE_LIMIT, payload.error?.message || '请求过于频繁');
        }
        throw new PipelineError(ErrorCode.API_ERROR, payload.error?.message || '模型服务异常');
      }

      const primary = payload.choices?.[0]?.message?.content;
      const choicesText = this.extractTextContent(primary);
      if (choicesText) return choicesText;

      if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
        return payload.output_text.trim();
      }

      throw new PipelineError(ErrorCode.API_ERROR, '模型未返回可用内容');
    },

    parseSummary(content) {
      const rawPreview = typeof content === 'string' && content.length > 0
        ? (content.length > 200 ? content.slice(0, 200) + '…' : content)
        : '暂无可用总结';
      const fallback = {
        overview: rawPreview,
        rating: '一般',
        ratingReason: '内容解析异常，以下为原始输出',
        keyPoints: [],
        warning: '无',
        chapters: []
      };

      const normalizeChapters = (chapters) => {
        if (!Array.isArray(chapters)) return [];

        const toSeconds = (value) => {
          if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
            return Math.floor(value);
          }
          if (typeof value !== 'string') return null;
          const text = value.trim();
          if (!text) return null;
          if (/^\d+$/.test(text)) return Number(text);

          const parts = text.split(':').map((item) => Number(item));
          if (parts.some((item) => Number.isNaN(item) || item < 0)) return null;
          if (parts.length === 2) return parts[0] * 60 + parts[1];
          if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
          return null;
        };

        const toLabel = (seconds) => {
          const total = Math.max(0, Math.floor(seconds));
          const h = Math.floor(total / 3600);
          const m = Math.floor((total % 3600) / 60);
          const s = total % 60;
          if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
          return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        };

        return chapters
          .map((item) => {
            if (!item || typeof item !== 'object') return null;
            const second = toSeconds(item.time ?? item.timestamp ?? item.second);
            if (second === null) return null;
            const title = typeof item.title === 'string'
              ? item.title.trim()
              : (typeof item.note === 'string' ? item.note.trim() : '关键片段');
            return {
              time: toLabel(second),
              second,
              title: title || '关键片段'
            };
          })
          .filter(Boolean)
          .sort((a, b) => a.second - b.second)
          .slice(0, 6);
      };

      try {
        // 支持 ```json ... ``` 代码块包裹
        const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        const rawJson = codeBlockMatch ? codeBlockMatch[1].trim() : content;
        const jsonMatch = rawJson.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return fallback;
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          overview: typeof parsed.overview === 'string' ? parsed.overview : fallback.overview,
          rating: ['值得看', '一般', '不值得'].includes(parsed.rating) ? parsed.rating : '一般',
          ratingReason: typeof parsed.ratingReason === 'string' ? parsed.ratingReason : fallback.ratingReason,
          keyPoints: Array.isArray(parsed.keyPoints)
            ? parsed.keyPoints.filter((item) => typeof item === 'string').slice(0, 5)
            : [],
          warning: typeof parsed.warning === 'string' ? parsed.warning : '无',
          chapters: normalizeChapters(parsed.chapters)
        };
      } catch {
        return fallback;
      }
    },

    requestOnce(config, payload, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new PipelineError(ErrorCode.ABORTED, '请求已取消'));
          return;
        }

        let req;
        const onAbort = () => {
          try {
            req?.abort?.();
          } catch (error) {
            console.warn('[B站AI总结] 取消请求失败:', error?.message || error);
          }
          reject(new PipelineError(ErrorCode.ABORTED, '请求已取消'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        req = GM_xmlhttpRequest({
          method: 'POST',
          url: config.endpoint,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`
          },
          data: JSON.stringify(payload),
          timeout: 60000,
          onload: (response) => {
            signal?.removeEventListener('abort', onAbort);
            try {
              const data = JSON.parse(response.responseText || '{}');
              if (response.status >= 400) {
                const errMsg = data?.error?.message || `HTTP ${response.status}`;
                const code = response.status === 429 ? ErrorCode.RATE_LIMIT : ErrorCode.API_ERROR;
                reject(new PipelineError(code, errMsg));
                return;
              }
              resolve(this.normalizeResponseText(data));
            } catch {
              reject(new PipelineError(ErrorCode.API_ERROR, '解析模型响应失败'));
            }
          },
          onerror: () => {
            signal?.removeEventListener('abort', onAbort);
            reject(new PipelineError(ErrorCode.NETWORK_ERROR, '模型网络请求失败'));
          },
          ontimeout: () => {
            signal?.removeEventListener('abort', onAbort);
            reject(new PipelineError(ErrorCode.TIMEOUT, '模型请求超时'));
          }
        });
      });
    },

    extractDeltaText(payload) {
      const deltaContent = payload?.choices?.[0]?.delta?.content;
      const deltaText = this.extractTextContent(deltaContent);
      if (deltaText) return deltaText;

      if (typeof payload?.delta?.text === 'string' && payload.delta.text) {
        return payload.delta.text;
      }

      return '';
    },

    requestStream(config, payload, signal, onToken) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new PipelineError(ErrorCode.ABORTED, '请求已取消'));
          return;
        }

        let req;
        let offset = 0;
        let sseBuffer = '';
        let fullText = '';
        let tokenReceived = false;
        let settled = false;

        const settleReject = (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };

        const settleResolve = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };

        const makeStreamError = (code, message) => {
          const err = new PipelineError(code, message);
          err.streamTokenReceived = tokenReceived;
          return err;
        };

        const onAbort = () => {
          try {
            req?.abort?.();
          } catch (error) {
            console.warn('[B站AI总结] 取消流式请求失败:', error?.message || error);
          }
          settleReject(makeStreamError(ErrorCode.ABORTED, '请求已取消'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        const consumeSSE = (newText) => {
          sseBuffer += newText;
          const frames = sseBuffer.split(/\r?\n\r?\n/);
          sseBuffer = frames.pop() || '';

          for (const frame of frames) {
            const lines = frame.split(/\r?\n/);
            const dataLines = [];
            for (const line of lines) {
              if (!line) continue;
              if (line.startsWith(':')) continue;
              if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trimStart());
              }
            }
            if (dataLines.length === 0) continue;

            const dataText = dataLines.join('\n').trim();
            if (!dataText || dataText === '[DONE]') continue;

            const payloadChunk = JSON.parse(dataText);
            if (payloadChunk?.error) {
              const isRateLimit = payloadChunk.error?.code === 'rate_limit_exceeded';
              const code = isRateLimit ? ErrorCode.RATE_LIMIT : ErrorCode.API_ERROR;
              throw makeStreamError(code, payloadChunk.error?.message || '模型流式响应错误');
            }

            const token = this.extractDeltaText(payloadChunk);
            if (token) {
              tokenReceived = true;
              fullText += token;
              onToken?.(token, fullText);
            }
          }
        };

        req = GM_xmlhttpRequest({
          method: 'POST',
          url: config.endpoint,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`
          },
          data: JSON.stringify(payload),
          timeout: 120000,
          onprogress: (response) => {
            const text = response.responseText || '';
            const newText = text.slice(offset);
            offset = text.length;
            if (!newText) return;
            try {
              consumeSSE(newText);
            } catch (error) {
              try {
                req?.abort?.();
              } catch (abortError) {
                console.warn('[B站AI总结] 中断流式请求失败:', abortError?.message || abortError);
              }
              signal?.removeEventListener('abort', onAbort);
              if (error instanceof PipelineError) {
                settleReject(error);
                return;
              }
              settleReject(makeStreamError(ErrorCode.API_ERROR, '解析流式分片失败'));
            }
          },
          onload: (response) => {
            signal?.removeEventListener('abort', onAbort);
            try {
              if (response.status >= 400) {
                const data = JSON.parse(response.responseText || '{}');
                const errMsg = data?.error?.message || `HTTP ${response.status}`;
                const code = response.status === 429 ? ErrorCode.RATE_LIMIT : ErrorCode.API_ERROR;
                settleReject(makeStreamError(code, errMsg));
                return;
              }

              const remaining = (response.responseText || '').slice(offset);
              if (remaining) {
                consumeSSE(remaining);
              }

              if (sseBuffer.trim()) {
                const leftover = sseBuffer
                  .split(/\r?\n/)
                  .filter((line) => line.startsWith('data:'))
                  .map((line) => line.slice(5).trimStart())
                  .join('\n')
                  .trim();
                if (leftover && leftover !== '[DONE]') {
                  const payloadChunk = JSON.parse(leftover);
                  const token = this.extractDeltaText(payloadChunk);
                  if (token) {
                    tokenReceived = true;
                    fullText += token;
                    onToken?.(token, fullText);
                  }
                }
                sseBuffer = '';
              }

              if (fullText.trim()) {
                settleResolve(fullText.trim());
                return;
              }

              const data = JSON.parse(response.responseText || '{}');
              settleResolve(this.normalizeResponseText(data));
            } catch (error) {
              if (error instanceof PipelineError) {
                settleReject(error);
                return;
              }
              settleReject(makeStreamError(ErrorCode.API_ERROR, '解析流式响应失败'));
            }
          },
          onerror: () => {
            signal?.removeEventListener('abort', onAbort);
            settleReject(makeStreamError(ErrorCode.NETWORK_ERROR, '模型网络请求失败'));
          },
          ontimeout: () => {
            signal?.removeEventListener('abort', onAbort);
            settleReject(makeStreamError(ErrorCode.TIMEOUT, '模型请求超时'));
          }
        });
      });
    },

    async summarize(subtitleText, videoTitle, videoDesc = '', options = {}) {
      const { signal, onToken } = options;
      const config = Config.getAll().llm;

      if (!config.apiKey) {
        throw new PipelineError(ErrorCode.CONFIG_INVALID, '请先在设置中配置API Key');
      }

      if (!this.isValidEndpoint(config.endpoint)) {
        throw new PipelineError(ErrorCode.CONFIG_INVALID, 'API端点无效：支持HTTPS；HTTP仅允许本机或内网地址');
      }

      // 截断过长的字幕
      const maxChars = 15000;  // 约7500 tokens
      const truncatedSubtitle = subtitleText.length > maxChars
        ? subtitleText.slice(0, maxChars) + '...(内容过长已截断)'
        : subtitleText;

      const prompt = `你是一个视频内容评估助手。用户正在浏览B站主页，需要快速判断视频是否值得观看。

## 视频信息
标题：${videoTitle}
简介：${videoDesc || '无'}

## 字幕内容
${truncatedSubtitle}

## 任务
请生成一个简洁的观看建议，严格按照以下JSON格式输出（不要有任何多余文字）：

{
  "overview": "用1-2句话概括视频核心内容",
  "rating": "值得看/一般/不值得",
  "ratingReason": "一句话说明理由",
  "keyPoints": ["关键点1", "关键点2", "关键点3"],
  "warning": "标题党/广告多/内容水/无（如果视频质量正常填无）",
  "chapters": [
    {"time": "00:45", "title": "核心问题抛出"},
    {"time": "03:20", "title": "关键方法讲解"},
    {"time": "07:10", "title": "结论与建议"}
  ]
}

补充要求：
- chapters 按时间升序，time 使用 mm:ss 或 hh:mm:ss
- chapters 必须输出 3-6 个关键节点，title 简洁（<=16字）；即使字幕没有明确章节，也要根据内容走向归纳出关键转折点
- 只有视频时长极短（<60秒）或字幕内容极少时才可返回空数组`;

      const payload = {
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: config.maxTokens,
        temperature: config.temperature,
        stream: Boolean(config.stream)
      };

      const maxAttempts = 2;
      let lastError;
      let streamMode = Boolean(config.stream);
      for (let i = 0; i < maxAttempts; i += 1) {
        try {
          const raw = streamMode
            ? await this.requestStream(config, { ...payload, stream: true }, signal, onToken)
            : await this.requestOnce(config, { ...payload, stream: false }, signal);
          return this.parseSummary(raw);
        } catch (error) {
          lastError = error;
          if (streamMode
              && error instanceof PipelineError
              && error.code === ErrorCode.API_ERROR
              && !error.streamTokenReceived) {
            streamMode = false;
            continue;
          }
          if (error instanceof PipelineError && [ErrorCode.RATE_LIMIT, ErrorCode.CONFIG_INVALID, ErrorCode.ABORTED].includes(error.code)) {
            throw error;
          }
        }
      }

      throw lastError || new PipelineError(ErrorCode.API_ERROR, '模型请求失败');
    }
  };

  // ============================================================
  // 模块4: B站API封装
  // ============================================================
  const BiliAPI = {
    normalizeAbortError(error) {
      const message = String(error?.message || '');
      if (error?.name === 'AbortError' || /aborted/i.test(message)) {
        throw new PipelineError(ErrorCode.ABORTED, '请求已取消');
      }
      throw error;
    },

    fetchJson(url, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new PipelineError(ErrorCode.ABORTED, '请求已取消'));
          return;
        }
        let req;
        const onAbort = () => {
          try { req?.abort?.(); } catch(e) {}
          reject(new PipelineError(ErrorCode.ABORTED, '请求已取消'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        req = GM_xmlhttpRequest({
          method: 'GET',
          url,
          responseType: 'json',
          timeout: 15000,
          onload: (resp) => {
            signal?.removeEventListener('abort', onAbort);
            if (resp.status >= 400) {
              reject(new PipelineError(ErrorCode.NETWORK_ERROR, `请求失败: ${resp.status}`));
              return;
            }
            try {
              const data = typeof resp.response === 'object' ? resp.response : JSON.parse(resp.responseText);
              resolve(data);
            } catch(e) {
              reject(new PipelineError(ErrorCode.API_ERROR, '解析响应失败'));
            }
          },
          onerror: () => {
            signal?.removeEventListener('abort', onAbort);
            reject(new PipelineError(ErrorCode.NETWORK_ERROR, 'B站API请求失败'));
          },
          ontimeout: () => {
            signal?.removeEventListener('abort', onAbort);
            reject(new PipelineError(ErrorCode.TIMEOUT, 'B站API请求超时'));
          }
        });
      });
    },

    async fetchJsonLegacy(url, signal) {
      try {
        const response = await fetch(url, { credentials: 'include', signal });
        if (!response.ok) {
          throw new PipelineError(ErrorCode.NETWORK_ERROR, `请求失败: ${response.status}`);
        }
        return response.json();
      } catch (error) {
        this.normalizeAbortError(error);
      }
    },

    // 通过bvid获取视频信息（包含cid）
    async getVideoInfo(bvid, signal) {
      const url = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
      const data = await this.fetchJson(url, signal);
      if (data.code !== 0) {
        throw new PipelineError(ErrorCode.API_ERROR, data.message || '获取视频信息失败');
      }
      return data.data;  // { cid, aid, title, desc, duration, ... }
    },

    // 获取字幕列表
    async getSubtitleList(bvid, cid, signal, aid) {
      const url = `https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=${cid}`;
      const data = await this.fetchJson(url, signal);
      if (data.code !== 0) {
        return this.getSubtitleListFallback(cid, signal, aid);
      }
      return data.data?.subtitle || { count: 0, subtitles: [] };
    },

    async getSubtitleListFallback(cid, signal, aid) {
      if (!aid) {
        throw new PipelineError(ErrorCode.UNSUPPORTED, '无法获取字幕：缺少视频aid');
      }
      const url = `https://api.bilibili.com/x/v2/dm/view?type=1&oid=${cid}&pid=${aid}`;
      const data = await this.fetchJson(url, signal);
      return data.data?.subtitle || { count: 0, subtitles: [] };
    },

    // 获取字幕内容
    getSubtitleContent(subtitleUrl, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new PipelineError(ErrorCode.ABORTED, '请求已取消'));
          return;
        }
        let req;
        const onAbort = () => {
          try { req?.abort?.(); } catch(e) {}
          reject(new PipelineError(ErrorCode.ABORTED, '请求已取消'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        req = GM_xmlhttpRequest({
          method: 'GET',
          url: subtitleUrl,
          responseType: 'json',
          timeout: 15000,
          onload: (resp) => {
            signal?.removeEventListener('abort', onAbort);
            if (resp.status >= 400) {
              reject(new PipelineError(ErrorCode.NETWORK_ERROR, `字幕请求失败: ${resp.status}`));
              return;
            }
            try {
              const data = typeof resp.response === 'object' ? resp.response : JSON.parse(resp.responseText);
              resolve(data.body || []);
            } catch(e) {
              reject(new PipelineError(ErrorCode.API_ERROR, '解析字幕失败'));
            }
          },
          onerror: () => {
            signal?.removeEventListener('abort', onAbort);
            reject(new PipelineError(ErrorCode.NETWORK_ERROR, '字幕请求失败'));
          },
          ontimeout: () => {
            signal?.removeEventListener('abort', onAbort);
            reject(new PipelineError(ErrorCode.TIMEOUT, '字幕请求超时'));
          }
        });
      });
    },

    // 将字幕转为纯文本
    subtitleToText(subtitleBody) {
      return subtitleBody.map(item => item.content).join(' ');
    }
  };

  // ============================================================
  // 模块X: 自动批量预加载队列
  // ============================================================
  const PreloadQueue = {
    queue: [],
    running: new Set(),
    done: new Set(),
    total: 0,
    completed: 0,
    _workers: 0,
    _statusEl: null,

    isEnabled() {
      return Config.get('trigger.autoPreload') === true;
    },

    getConcurrency() {
      return Math.max(1, Math.min(5, Config.get('trigger.autoPreloadConcurrency') || 2));
    },

    enqueue(bvid, card) {
      if (!this.isEnabled()) { console.log('[PreloadQueue] enqueue: disabled'); return; }
      if (!card.isConnected) return;
      if (this.done.has(bvid)) return;
      if (this.running.has(bvid)) { console.log('[PreloadQueue] skip running:', bvid); return; }
      if (this.queue.some(i => i.bvid === bvid)) { console.log('[PreloadQueue] skip in-queue:', bvid); return; }
      // 已有内存缓存结果则跳过
      if (HomePageEnhancer.lastSummaryByBvid && HomePageEnhancer.lastSummaryByBvid.has(HomePageEnhancer.buildSummaryMemoKey(bvid))) {
        console.log('[PreloadQueue] skip cached:', bvid); return;
      }
      console.log('[PreloadQueue] enqueue OK:', bvid);
      this.queue.push({ bvid, card });
      this.total++;
    },

    prioritize(bvid) {
      const idx = this.queue.findIndex(i => i.bvid === bvid);
      if (idx > 0) {
        const [item] = this.queue.splice(idx, 1);
        this.queue.unshift(item);
      }
    },

    _tick() {
      while (this._workers < this.getConcurrency() && this.queue.length > 0) {
        const item = this.queue.shift();
        if (this.done.has(item.bvid) || this.running.has(item.bvid)) { continue; }
        this._workers++;
        this._runOne(item);
      }
    },

    async _runOne(item) {
      this.running.add(item.bvid);
      console.log('[PreloadQueue] start', item.bvid, '| running:', this.running.size, '| queue:', this.queue.length);
      try {
        const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000));
        await Promise.race([
          HomePageEnhancer.triggerSummary(item.bvid, item.card, { silent: true }),
          timeoutPromise
        ]);
      } catch(e) {
        console.error('[PreloadQueue] error:', item.bvid, e);
      } finally {
        this.running.delete(item.bvid);
        this.done.add(item.bvid);
        this.completed++;
        this._workers--;
        console.log('[PreloadQueue] done', item.bvid, '| completed:', this.completed, '/', this.total);
        this._updateStatus();
        this._tick();
      }
    },

    schedule(cards) {
      if (!this.isEnabled()) return;
      cards.forEach(card => {
        const bvid = HomePageEnhancer.extractBvid(card);
        if (bvid) this.enqueue(bvid, card);
      });
      this._tick();
    },

    scheduleFromPage() {
      if (!this.isEnabled()) { console.log('[PreloadQueue] scheduleFromPage: disabled, skip'); return; }
      const selectors = [
        '.bili-video-card', '.bili-video-card-recommend',
        '.video-card', '.rank-item', '.small-item',
        '[data-mod="recommend_list"] .feed-card', '.bili-video-card__wrap'
      ];
      const cards = [];
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(card => cards.push(card));
      });
      // 去重（同一元素可能匹配多个选择器）
      const seen = new Set();
      const unique = cards.filter(c => { if (seen.has(c)) return false; seen.add(c); return true; });
      const bvids = unique.map(card => HomePageEnhancer.extractBvid(card)).filter(Boolean);
      console.log('[PreloadQueue] scheduleFromPage: found', unique.length, 'cards,', bvids.length, 'with bvid, queue before:', this.queue.length);
      this.schedule(unique);
      console.log('[PreloadQueue] scheduleFromPage: queue after:', this.queue.length, 'total:', this.total);
    },

    reset() {
      this.queue = [];
      this.running.clear();
      this.done.clear();
      this.total = 0;
      this.completed = 0;
      this._workers = 0;
      HomePageEnhancer.processingBvids?.clear();
    },

    _updateStatus() {
      if (!this._statusEl) {
        this._statusEl = document.getElementById('preload-status');
      }
      if (!this._statusEl) return;
      if (this._workers > 0 || this.queue.length > 0) {
        this._statusEl.textContent = `分析中 ${this.completed}/${this.total}`;
      } else if (this.completed > 0) {
        this._statusEl.textContent = `已完成 ${this.completed}/${this.total}`;
      }
    }
  };

  // ============================================================
  // 模块5: 主页卡片增强
  // ============================================================
  const HomePageEnhancer = {
    // 页面类型检测
    getPageType() {
      const path = location.pathname;
      if (path === '/' || path === '/index.html') return 'homepage';
      if (path.startsWith('/search')) return 'search';
      if (path.startsWith('/v/popular')) return 'popular';
      if (path.startsWith('/space')) return 'space';
      if (path.includes('/video/')) return 'video';
      if (path.includes('/bangumi/play/')) return 'bangumi';
      return 'other';
    },

    // 检查当前页面是否启用
    isEnabledForPage() {
      const pageType = this.getPageType();
      const display = Config.getAll().display;
      switch (pageType) {
        case 'homepage': return display.showInHomepage;
        case 'search': return display.showInSearch;
        case 'popular': return display.showInPopular;
        case 'space': return display.showInSpace;
        default: return false;
      }
    },

    // 视频卡片选择器
    cardSelectors: [
      '.bili-video-card',           // 主页推荐
      '.bili-video-card-recommend', // 旧版主页
      '.video-card',                // 搜索结果
      '.rank-item',                 // 排行榜
      '.small-item',                // 空间页
      '[data-mod="recommend_list"] .feed-card', // 新版主页
      '.bili-video-card__wrap'      // 新版结构
    ],

    // 从卡片提取bvid
    extractBvid(card) {
      // 方法1: 从链接提取
      const link = card.querySelector('a[href*="video/BV"], a[href*="BV"]');
      if (link) {
        const match = link.href.match(/BV[a-zA-Z0-9]+/);
        if (match) return match[0];
      }

      // 方法2: 从data属性提取
      if (card.dataset.bvid) return card.dataset.bvid;

      // 方法3: 从任何包含bvid的属性提取
      const bvidEl = card.querySelector('[data-bvid]');
      if (bvidEl) return bvidEl.dataset.bvid;

      return null;
    },

    // 从卡片提取标题
    extractTitle(card) {
      const titleEl = card.querySelector('.bili-video-card__info--tit, .title, h3, .video-title');
      return titleEl?.title || titleEl?.textContent?.trim() || '';
    },

    // 处理状态管理
    processingCards: new WeakSet(),
    processingBvids: new Set(),
    manuallyClosedCards: new WeakSet(),
    hoverTimers: new WeakMap(),
    lastSummaryByBvid: new Map(),
    requestSeq: 0,
    activeRequests: new WeakMap(),
    inFlightJobs: new Map(),
    ccAvailabilityCache: new Map(),
    ccProbeInFlight: new Map(),
    ccProbeTTL: 6 * 60 * 60 * 1000,

    safeAppend(parent, child) {
      if (!parent || !child) return false;
      if (!(parent instanceof Element || parent instanceof DocumentFragment)) return false;
      if (parent instanceof Element && !parent.isConnected) return false;
      parent.appendChild(child);
      return true;
    },

    createSubtitleFingerprint(subtitleBody) {
      const sample = subtitleBody.slice(0, 80).map((item) => item.content || '').join('|');
      let hash = 5381;
      for (let i = 0; i < sample.length; i += 1) {
        hash = ((hash << 5) + hash) ^ sample.charCodeAt(i);
      }
      return (hash >>> 0).toString(16);
    },

    buildCacheKey({ bvid, cid, subtitleFingerprint, model, promptVersion, targetLang }) {
      return [bvid, cid, subtitleFingerprint, model, promptVersion, targetLang].join(':');
    },

    buildSummaryMemoKey(bvid) {
      const llm = Config.getAll().llm;
      return [bvid, llm.model, llm.promptVersion, llm.targetLang].join(':');
    },

    startCardRequest(card) {
      this.cancelCardRequest(card);
      const controller = new AbortController();
      const requestId = ++this.requestSeq;
      this.activeRequests.set(card, { requestId, controller });
      return { requestId, controller };
    },

    cancelCardRequest(card) {
      const state = this.activeRequests.get(card);
      if (state?.controller) {
        try {
          state.controller.abort();
        } catch (error) {
          console.warn('[B站AI总结] 中止卡片请求失败:', error?.message || error);
        }
      }
    },

    clearHoverTimer(card) {
      const timer = this.hoverTimers.get(card);
      if (timer) {
        clearTimeout(timer);
        this.hoverTimers.delete(card);
      }
    },

    canAutoOpen(card) {
      return !this.manuallyClosedCards.has(card);
    },

    setDismissedVisual(card, dismissed) {
      const btn = card.querySelector('.ai-summary-btn');
      if (!btn) return;
      btn.classList.toggle('ai-dismissed', dismissed);
      btn.title = dismissed ? '已关闭，点击AI可重新打开' : 'AI总结';
    },

    isLatestRequest(card, requestId) {
      return this.activeRequests.get(card)?.requestId === requestId;
    },

    getOrCreateInFlight(cacheKey, factory) {
      if (this.inFlightJobs.has(cacheKey)) {
        return this.inFlightJobs.get(cacheKey);
      }
      const job = factory().finally(() => {
        this.inFlightJobs.delete(cacheKey);
      });
      this.inFlightJobs.set(cacheKey, job);
      return job;
    },

    async hasCCSubtitle(bvid) {
      const now = Date.now();
      const cached = this.ccAvailabilityCache.get(bvid);
      if (cached && now - cached.timestamp < this.ccProbeTTL) {
        return cached.hasCC;
      }

      if (this.ccProbeInFlight.has(bvid)) {
        return this.ccProbeInFlight.get(bvid);
      }

      const job = (async () => {
        try {
          const videoInfo = await BiliAPI.getVideoInfo(bvid);
          const subtitleList = await BiliAPI.getSubtitleList(bvid, videoInfo.cid, undefined, videoInfo.aid);
          const hasCC = Array.isArray(subtitleList?.subtitles) && subtitleList.subtitles.length > 0;
          this.ccAvailabilityCache.set(bvid, { hasCC, timestamp: Date.now() });
          return hasCC;
        } catch (error) {
          console.warn('[B站AI总结] 探测CC字幕失败:', bvid, error?.message || error);
          this.ccAvailabilityCache.set(bvid, { hasCC: false, timestamp: Date.now() });
          return false;
        }
      })().finally(() => {
        this.ccProbeInFlight.delete(bvid);
      });

      this.ccProbeInFlight.set(bvid, job);
      return job;
    },

    mapErrorToMessage(error) {
      const rawMessage = String(error?.message || '');
      if (error?.name === 'AbortError' || /aborted/i.test(rawMessage)) {
        return '请求已取消，悬浮可重试';
      }

      if (error instanceof PipelineError) {
        switch (error.code) {
          case ErrorCode.NO_SUBTITLE:
            return '该视频无可用CC字幕';
          case ErrorCode.SUBTITLE_EMPTY:
            return '字幕内容过短，无法总结';
          case ErrorCode.RATE_LIMIT:
            return '请求过于频繁，请稍后再试';
          case ErrorCode.CONFIG_INVALID:
            return error.message;
          case ErrorCode.TIMEOUT:
            return '请求超时，请重试';
          case ErrorCode.ABORTED:
            return '请求已取消，悬浮可重试';
          case ErrorCode.UNSUPPORTED:
            return error.message || '当前视频暂不支持字幕总结';
          default:
            return error.message || '请求失败，请重试';
        }
      }
      return error?.message || '请求失败，请重试';
    },

    // 为卡片添加总结按钮
    async enhanceCard(card) {
      const bvid = this.extractBvid(card);
      if (!bvid) return;

      const displayConfig = Config.getAll().display;

      // 避免重复处理
      if (card.dataset.aiEnhanced === 'true' || card.dataset.aiEnhancing === 'true') return;
      if (displayConfig.onlyShowWithCC && card.dataset.aiEnhanced === 'skip-no-cc') return;
      card.dataset.aiEnhancing = 'true';

      if (displayConfig.onlyShowWithCC) {
        const hasCC = await this.hasCCSubtitle(bvid);
        if (!hasCC) {
          card.dataset.aiEnhanced = 'skip-no-cc';
          delete card.dataset.aiEnhancing;
          return;
        }
      }

      card.dataset.aiEnhanced = 'true';
      delete card.dataset.aiEnhancing;

      // 创建AI按钮
      const btn = this.createAIButton(bvid);
      this.insertButton(card, btn);

      // 设置悬浮触发
      const triggerConfig = Config.getAll().trigger;
      let hoverTimer = null;

      if (triggerConfig.mode === 'hover') {
        card.addEventListener('mouseenter', () => {
          if (!this.canAutoOpen(card)) {
            return;
          }
          // 进度条：200ms后显示，动画时长=hoverDelay-200ms
          this.startHoverProgress(card, triggerConfig.hoverDelay);
          hoverTimer = setTimeout(() => {
            this.triggerSummary(bvid, card);
          }, triggerConfig.hoverDelay);
          this.hoverTimers.set(card, hoverTimer);
        });
        card.addEventListener('mouseleave', (event) => {
          this.clearHoverProgress(card);
          this.clearHoverTimer(card);

          const nextTarget = event.relatedTarget;
          if (nextTarget instanceof Node && card.contains(nextTarget)) {
            return;
          }

          setTimeout(() => {
            if (!card.matches(':hover')) {
              this.hideOverlay(card);
              if (triggerConfig.cancelOnMouseLeave) {
                this.cancelCardRequest(card);
              }
            }
          }, 150);
        });

        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.manuallyClosedCards.delete(card);
          this.setDismissedVisual(card, false);
          this.triggerSummary(bvid, card, { force: true });
        });
      } else {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.manuallyClosedCards.delete(card);
          this.setDismissedVisual(card, false);
          this.triggerSummary(bvid, card, { force: true });
        });
      }
    },

    // 创建AI按钮
    createAIButton(bvid) {
      const btn = document.createElement('div');
      btn.className = 'ai-summary-btn';
      btn.dataset.bvid = bvid;
      btn.title = 'AI总结';
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
        </svg>
        <span>AI</span>
      `;
      return btn;
    },

    // 插入按钮到卡片
    insertButton(card, btn) {
      // 尝试多个可能的容器
      const containers = [
        card.querySelector('.bili-video-card__info--bottom'),
        card.querySelector('.bili-video-card__info'),
        card.querySelector('.video-card__info'),
        card.querySelector('.info'),
        card
      ];

      for (const container of containers) {
        if (container && container.isConnected) {
          container.style.position = 'relative';
          if (this.safeAppend(container, btn)) {
            return;
          }
        }
      }

      if (card?.isConnected) {
        card.style.position = 'relative';
        this.safeAppend(card, btn);
      }
    },

    // 触发总结
    async triggerSummary(bvid, card, options = {}) {
      const { force = false, silent = false } = options;
      if (silent && !card.isConnected) return;

      let summaryEl = this.getCardPopup(card);

      if (!summaryEl) {
        summaryEl = this.createSummaryPopup(bvid, card);
      }
      if (!force && !silent && !this.canAutoOpen(card)) return;
      // 用户悬停时把该 bvid 提升到队列优先
      if (!force && !silent) PreloadQueue.prioritize(bvid);

      // overlay 已显示且有内容时不重复渲染（silent模式不检查overlay）
      if (!force && !silent) {
        const cover = this.getCoverEl(card);
        const overlayEl = cover?.querySelector('.ai-cover-overlay');
        if (overlayEl?.classList.contains('ai-cover-overlay--visible') && !overlayEl?.classList.contains('ai-ov--loading')) return;
      }

      const memoKey = this.buildSummaryMemoKey(bvid);
      const memoSummary = this.lastSummaryByBvid.get(memoKey);
      if (memoSummary) {
        if (force) {
          // 点击按钮：打开完整 portal popup
          document.querySelectorAll(`.ai-summary-popup[data-bvid="${bvid}"]`).forEach(el => {
            if (el !== summaryEl) el.style.display = 'none';
          });
          this.renderSummary(summaryEl, memoSummary, bvid, card);
          summaryEl.style.display = 'block';
          this.adjustPopupPosition(summaryEl, card);
        } else {
          // 悬停：显示封面遮罩
          this.renderOverlaySummary(card, memoSummary, bvid);
        }
        return;
      }

      // force=true（手动点击）时清除 processingCards 守卫，允许重新触发
      if (force) {
        this.processingCards.delete(card);
        this.processingBvids.delete(bvid);
      }

      if (!silent && this.processingCards.has(card)) return;

      // 同一 bvid 已在另一张卡片上请求中：silent直接跳过，否则轮询等待
      if (this.processingBvids.has(bvid)) {
        if (silent) return;
        if (!force && !silent) this.renderOverlayLoading(card);
        const waitStart = Date.now();
        const pollTimer = setInterval(() => {
          if (this.manuallyClosedCards.has(card)) { clearInterval(pollTimer); this.hideOverlay(card); return; }
          const memo = this.lastSummaryByBvid.get(memoKey);
          if (memo) {
            clearInterval(pollTimer);
            if (!force) this.renderOverlaySummary(card, memo, bvid);
            return;
          }
          if (!this.processingBvids.has(bvid)) {
            clearInterval(pollTimer);
            this.hideOverlay(card);
            return;
          }
          if (Date.now() - waitStart > 10000) {
            clearInterval(pollTimer);
            this.hideOverlay(card);
          }
        }, 300);
        return;
      }

      this.processingCards.add(card);
      this.processingBvids.add(bvid);
      const { requestId, controller } = this.startCardRequest(card);
      const signal = controller.signal;

      const title = this.extractTitle(card);

      // 悬停：overlay loading；点击：portal loading
      if (!force) {
        if (!silent) this.renderOverlayLoading(card);
      } else {
        this.renderLoading(summaryEl, card, 'AI分析中...');
        summaryEl.style.display = 'block';
        this.adjustPopupPosition(summaryEl, card);
      }


      try {
        if (silent) console.log('[AI总结][silent] step1: getVideoInfo', bvid);
        const videoInfo = await BiliAPI.getVideoInfo(bvid, signal);
        if (silent) console.log('[AI总结][silent] step2: getSubtitleList', bvid, 'cid=', videoInfo.cid);
        const cid = videoInfo.cid;

        const subtitleList = await BiliAPI.getSubtitleList(bvid, cid, signal, videoInfo.aid);
        if (silent) console.log('[AI总结][silent] step3: subtitleList', bvid, 'count=', subtitleList.subtitles?.length);

        if (!subtitleList.subtitles || subtitleList.subtitles.length === 0) {
          throw new PipelineError(ErrorCode.NO_SUBTITLE, '该视频无CC字幕');
        }

        // 优先选择中文字幕
        const preferredSubtitle = subtitleList.subtitles.find(s =>
          s.lan.includes('zh') || s.lan_doc.includes('中文')
        ) || subtitleList.subtitles[0];

        if (silent) console.log('[AI总结][silent] step4: getSubtitleContent', bvid, preferredSubtitle.subtitle_url);
        const subtitleBody = await BiliAPI.getSubtitleContent(preferredSubtitle.subtitle_url, signal);
        if (silent) console.log('[AI总结][silent] step5: subtitleText len=', subtitleBody?.length, bvid);
        const subtitleText = BiliAPI.subtitleToText(subtitleBody);

        if (!subtitleText || subtitleText.length < 10) {
          throw new PipelineError(ErrorCode.SUBTITLE_EMPTY, '字幕内容为空');
        }

        const llmConfig = Config.getAll().llm;
        const subtitleFingerprint = this.createSubtitleFingerprint(subtitleBody);
        if (silent) console.log('[AI总结][silent] step6: CacheDB.get', bvid);
        const cacheKey = this.buildCacheKey({
          bvid,
          cid,
          subtitleFingerprint,
          model: llmConfig.model,
          promptVersion: llmConfig.promptVersion,
          targetLang: llmConfig.targetLang
        });

        const cached = await CacheDB.get(cacheKey);
        if (cached) {
          if (this.isLatestRequest(card, requestId)) {
            if (!this.manuallyClosedCards.has(card)) {
              this.lastSummaryByBvid.set(memoKey, cached.summary);
              if (force) {
                this.renderSummary(summaryEl, cached.summary, bvid, card);
                summaryEl.style.display = 'block';
                this.adjustPopupPosition(summaryEl, card);
              } else {
                this.renderOverlaySummary(card, cached.summary, bvid);
              }
            }
          }
          return;
        }

        let latestStreamText = '';
        let streamTimer = null;
        const scheduleStreamRender = () => {
          if (streamTimer) return;
          streamTimer = setTimeout(() => {
            streamTimer = null;
            if (!this.isLatestRequest(card, requestId)) return;
            if (this.manuallyClosedCards.has(card)) return;
            if (force && summaryEl.style.display === 'none') return;
            if (!latestStreamText.trim()) return;
            if (force) {
              this.renderStreaming(summaryEl, latestStreamText, card);
            }
          }, 80);
        };

        if (silent) console.log('[AI总结][silent] step7: LLM.summarize start', bvid, 'stream=', llmConfig.stream);
        const summary = llmConfig.stream
          ? await LLM.summarize(subtitleText, title, videoInfo.desc, {
              signal,
              onToken: (_, fullText) => {
                latestStreamText = fullText;
                scheduleStreamRender();
              }
            })
          : await this.getOrCreateInFlight(cacheKey, () =>
              LLM.summarize(subtitleText, title, videoInfo.desc, { signal })
            );
        if (silent) console.log('[AI总结][silent] step8: LLM done', bvid);

        if (streamTimer) {
          clearTimeout(streamTimer);
          streamTimer = null;
        }

        if (!this.isLatestRequest(card, requestId)) return;
        if (this.manuallyClosedCards.has(card)) return;

        // 6. 缓存结果
        await CacheDB.set({
          cacheKey,
          bvid,
          cid,
          summary,
          videoTitle: title,
          model: llmConfig.model,
          promptVersion: llmConfig.promptVersion,
          targetLang: llmConfig.targetLang,
          subtitleFingerprint
        });

        // 7. 渲染结果
        this.lastSummaryByBvid.set(memoKey, summary);
        try { GM_setValue("ai_sum_" + bvid, JSON.stringify(summary)); } catch(e) {}
        if (force) {
          this.renderSummary(summaryEl, summary, bvid, card);
          summaryEl.style.display = 'block';
          this.adjustPopupPosition(summaryEl, card);
        } else {
          this.renderOverlaySummary(card, summary, bvid);
        }

      } catch (error) {
        if (error instanceof PipelineError && error.code === ErrorCode.ABORTED) {
          this.hideOverlay(card);
          return;
        }

        const message = this.mapErrorToMessage(error);
        if (message && this.isLatestRequest(card, requestId)) {
          if (force) {
            this.renderError(summaryEl, message, card);
            summaryEl.style.display = 'block';
            this.adjustPopupPosition(summaryEl, card);
          } else {
            this.hideOverlay(card);
          }
        }
      } finally {
        this.processingCards.delete(card);
        this.processingBvids.delete(bvid);
        if (this.isLatestRequest(card, requestId)) {
          this.activeRequests.delete(card);
        }
      }
    },

    // 获取或创建卡片唯一ID
    getCardId(card) {
      if (!card.dataset.aiCardId) {
        card.dataset.aiCardId = Math.random().toString(36).slice(2);
      }
      return card.dataset.aiCardId;
    },

    // 创建总结弹窗（portal模式，挂到body）
    createSummaryPopup(bvid, card) {
      const popup = document.createElement('div');
      popup.className = 'ai-summary-popup';
      popup.dataset.bvid = bvid;
      popup.dataset.cardId = this.getCardId(card);
      document.body.appendChild(popup);
      return popup;
    },

    // 从body查找关联卡片的popup
    getCardPopup(card) {
      const cardId = card.dataset.aiCardId;
      if (!cardId) return null;
      return document.body.querySelector(`.ai-summary-popup[data-card-id="${cardId}"]`);
    },

    // 渲染总结结果
    renderSummary(el, summary, bvid, card) {
      el.classList.remove('loading');

      const ratingClass = {
        '值得看': 'rating-good',
        '一般': 'rating-normal',
        '不值得': 'rating-bad'
      }[summary.rating] || 'rating-normal';

      const warningIcon = summary.warning && summary.warning !== '无'
        ? `<span class="ai-warning" title="${summary.warning}">⚠️</span>`
        : '';

      el.innerHTML = `
        <div class="ai-summary-content">
          <div class="ai-header">
            <svg class="ai-icon-svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
            <span class="ai-title">AI 速览</span>
            ${warningIcon}
            <button class="ai-copy-btn" type="button" title="复制总结">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
            </button>
            <button class="ai-close" type="button">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
          </div>
          <div class="ai-overview">${summary.overview}</div>
          <div class="ai-rating ${ratingClass}">
            <span class="ai-rating-label">${summary.rating}</span>
            <span class="ai-rating-reason">${summary.ratingReason}</span>
          </div>
          ${summary.keyPoints && summary.keyPoints.length > 0 ? `
            <div class="ai-keypoints">
              <div class="ai-section-label">关键点</div>
              <ul>${summary.keyPoints.map(p => `<li>${p}</li>`).join('')}</ul>
            </div>
          ` : ''}
          ${summary.chapters && summary.chapters.length > 0 ? `
            <div class="ai-chapters">
              <div class="ai-section-label">时间节点</div>
              <div class="ai-chapters-grid">
                ${summary.chapters.map((c) => `
                  <button class="ai-chapter-link" type="button" data-second="${c.second}">
                    <span class="ai-chapter-time">${c.time}</span>
                    <span class="ai-chapter-title">${c.title}</span>
                  </button>
                `).join('')}
              </div>
            </div>
          ` : ''}
          ${summary.warning && summary.warning !== '无' ? `
            <div class="ai-warning-text">⚠️ ${summary.warning}</div>
          ` : ''}
        </div>
      `;
      this.bindChapterLinks(el, bvid);
      this.bindCloseHandler(el, card);
      this.bindCopyHandler(el, summary);
      if (card) this.showRatingBadge(card, summary.rating);
    },

    bindChapterLinks(el, bvid) {
      const links = el.querySelectorAll('.ai-chapter-link');
      if (!links.length) return;
      links.forEach((btn) => {
        btn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const second = Number(btn.dataset.second || 0);
          const safeSecond = Number.isFinite(second) && second >= 0 ? Math.floor(second) : 0;
          const url = `https://www.bilibili.com/video/${bvid}?t=${safeSecond}`;
          window.open(url, '_blank', 'noopener');
        });
      });
    },

    renderStreaming(el, fullText, card) {
      el.classList.remove('loading');
      const existedPreview = el.querySelector('.ai-streaming-preview');
      if (existedPreview) {
        existedPreview.textContent = fullText;
        return;
      }

      el.innerHTML = `
        <div class="ai-summary-content ai-streaming">
          <div class="ai-header">
            <svg class="ai-icon-svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
            <span class="ai-title">AI 速览</span>
            <span class="ai-generating-dot"></span>
            <button class="ai-close" type="button">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
          </div>
          <div class="ai-streaming-status">正在生成...</div>
          <div class="ai-overview ai-streaming-preview"></div>
        </div>
        /* ===== AI Full Modal ===== */
        .ai-fm-mask {
          position: fixed; inset: 0; z-index: 999999;
          background: rgba(0,0,0,.72);
          display: flex; align-items: center; justify-content: center;
          backdrop-filter: blur(6px);
          animation: aiFadeIn .18s ease;
        }
        .ai-fm-box {
          width: min(520px, 92vw); max-height: 80vh;
          background: linear-gradient(160deg, rgba(18,22,30,.97) 0%, rgba(10,14,20,.99) 100%);
          border: 1px solid rgba(255,255,255,.12); border-radius: 16px;
          box-shadow: 0 8px 40px rgba(0,0,0,.6);
          display: flex; flex-direction: column; overflow: hidden;
          font-family: "PingFang SC","HarmonyOS_Regular","Helvetica Neue","Microsoft YaHei",sans-serif;
        }
        .ai-fm-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 16px 18px 12px; border-bottom: 1px solid rgba(255,255,255,.08); flex-shrink: 0;
        }
        .ai-fm-rating { font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px; text-shadow: 0 1px 6px rgba(0,0,0,.8); }
        .ai-fm-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
        .ai-fm-close {
          background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.15);
          color: rgba(255,255,255,.7); border-radius: 50%; width: 28px; height: 28px;
          cursor: pointer; font-size: 13px; display: flex; align-items: center; justify-content: center;
          transition: background .15s;
        }
        .ai-fm-close:hover { background: rgba(255,255,255,.22); color: #fff; }
        .ai-fm-body {
          flex: 1; overflow-y: auto; padding: 14px 18px;
          scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.2) transparent;
        }
        .ai-fm-overview {
          font-size: 14px; color: rgba(255,255,255,.9); line-height: 1.7;
          margin: 0 0 12px; text-shadow: 0 1px 3px rgba(0,0,0,.5);
        }
        .ai-fm-section {
          font-size: 11px; color: rgba(255,255,255,.45); letter-spacing: .08em;
          text-transform: uppercase; margin: 12px 0 6px;
        }
        .ai-fm-kp { margin: 0 0 4px; padding-left: 0; list-style: none; }
        .ai-fm-kp li {
          font-size: 13px; color: rgba(255,255,255,.82); line-height: 1.6;
          padding: 3px 0 3px 14px; position: relative;
          text-shadow: 0 1px 2px rgba(0,0,0,.4);
        }
        .ai-fm-kp li::before { content: "•"; position: absolute; left: 0; color: rgba(255,255,255,.4); }
        .ai-fm-chaps { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px; }
        .ai-fm-chap {
          display: flex; align-items: center; gap: 5px;
          background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.15);
          border-radius: 20px; padding: 4px 10px; cursor: pointer;
          transition: background .15s;
        }
        .ai-fm-chap:hover { background: rgba(255,255,255,.2); }
        .ai-fm-chap-time { font-size: 11px; color: rgba(255,255,255,.55); }
        .ai-fm-chap-title { font-size: 12px; color: rgba(255,255,255,.85); }
        .ai-fm-reason {
          font-size: 12px; color: rgba(255,255,255,.55); line-height: 1.6;
          margin: 12px 0 0; padding: 10px 12px;
          background: rgba(255,255,255,.06); border-radius: 8px;
          border-left: 2px solid rgba(255,255,255,.2);
        }
        .ai-fm-footer {
          display: flex; align-items: center; justify-content: space-between;
          padding: 12px 18px; border-top: 1px solid rgba(255,255,255,.08); flex-shrink: 0; gap: 8px;
        }
        .ai-fm-copy {
          font-size: 12px; padding: 6px 14px;
          background: rgba(255,255,255,.12); color: rgba(255,255,255,.85);
          border: 1px solid rgba(255,255,255,.2); border-radius: 20px;
          cursor: pointer; transition: background .15s;
        }
        .ai-fm-copy:hover { background: rgba(255,255,255,.22); }
        .ai-fm-open {
          font-size: 12px; padding: 6px 14px;
          background: rgba(0,174,236,.25); color: rgba(255,255,255,.9);
          border: 1px solid rgba(0,174,236,.4); border-radius: 20px;
          text-decoration: none; transition: background .15s;
        }
        .ai-fm-open:hover { background: rgba(0,174,236,.4); }
        /* ===== Chapter Markers ===== */
        .ai-chapter-markers {
          position: absolute;
          inset: 0;
          pointer-events: none;
          z-index: 5;
        }
        .ai-chapter-marker {
          position: absolute;
          top: 0;
          height: 100%;
          pointer-events: auto;
          cursor: pointer;
          z-index: 10;
        }
        .ai-chapter-marker-line {
          width: 2px;
          height: 100%;
          background: rgba(0,174,236,.9);
          box-shadow: 0 0 4px rgba(0,174,236,.6);
          transform: translateX(-50%);
        }
        .ai-chapter-marker-label {
          position: absolute;
          bottom: calc(100% + 6px);
          left: 50%;
          transform: translateX(-50%);
          white-space: nowrap;
          font-size: 11px;
          background: rgba(0,0,0,.85);
          color: #fff;
          padding: 3px 8px;
          border-radius: 4px;
          opacity: 1;
          pointer-events: none;
          z-index: 10;
        }
        .ai-chapter-marker-label::after {
          content: "";
          position: absolute;
          top: 100%;
          left: 50%;
          transform: translateX(-50%);
          border: 5px solid transparent;
          border-top: 5px solid rgba(0,0,0,.85);
        }
        .ai-chapter-marker:hover .ai-chapter-marker-label,
        .bpx-player-progress-area:hover .ai-chapter-marker-label {
          opacity: 1;
        }
        .bpx-player-progress-area:hover .ai-chapter-marker-label {
          opacity: 1;
        }

      `;
      const preview = el.querySelector('.ai-streaming-preview');
      if (preview) {
        preview.textContent = fullText;
      }
      this.bindCloseHandler(el, card);
    },

    // 渲染错误
    renderError(el, message, card) {
      el.classList.remove('loading');
      el.innerHTML = `
        <div class="ai-summary-content ai-error">
          <div class="ai-header">
            <svg class="ai-icon-svg" viewBox="0 0 24 24" width="14" height="14" fill="#c62828"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
            <span class="ai-title">获取失败</span>
            <button class="ai-close" type="button"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
          </div>
          <div class="ai-error-msg">${message}</div>
        </div>
      `;
      this.bindCloseHandler(el, card);
    },

    renderIdle(el, message = '等待触发分析', card) {
      el.classList.remove('loading');
      el.innerHTML = `
        <div class="ai-summary-content ai-idle">
          <div class="ai-header">
            <svg class="ai-icon-svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
            <span class="ai-title">AI 速览</span>
            <button class="ai-close" type="button"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
          </div>
          <div class="ai-error-msg">${message}</div>
        </div>
      `;
      this.bindCloseHandler(el, card);
    },

    renderLoading(el, card, message = 'AI分析中...') {
      el.classList.add('loading');
      el.innerHTML = `
        <div class="ai-summary-content ai-idle">
          <div class="ai-header">
            <svg class="ai-icon-svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
            <span class="ai-title">AI 速览</span>
            <span class="ai-generating-dot"></span>
            <button class="ai-close" type="button"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
          </div>
          <div class="ai-loading"><span></span>${message}</div>
        </div>
      `;
      this.bindCloseHandler(el, card);
    },

    // 复制总结到剪贴板
    bindCopyHandler(el, summary) {
      const btn = el.querySelector('.ai-copy-btn');
      if (!btn) return;
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const lines = [];
        if (summary.overview) lines.push(summary.overview);
        if (summary.rating) lines.push(`评分：${summary.rating} - ${summary.ratingReason || ''}`);
        if (summary.keyPoints && summary.keyPoints.length > 0) {
          lines.push('关键点：');
          summary.keyPoints.forEach(p => { lines.push(`• ${p}`); });
        }
        const text = lines.join('\n');
        navigator.clipboard.writeText(text).then(() => {
          btn.textContent = '✅';
          setTimeout(() => { btn.textContent = '📋'; }, 1500);
        }).catch(() => {
          btn.textContent = '❌';
          setTimeout(() => { btn.textContent = '📋'; }, 1500);
        });
      });
    },

    // 在卡片缩略图上显示评分徽章
    // 获取封面容器
    getCoverEl(card) {
      return card.querySelector('.bili-video-card__image--wrap, .cover-picture, .video-cover, .b-img__inner, a.cover') || null;
    },

    // 获取或创建封面遮罩
    getOrCreateOverlay(card) {
      const cover = this.getCoverEl(card);
      if (!cover) return null;
      let overlay = cover.querySelector('.ai-cover-overlay');
      if (!overlay) {
        cover.style.position = cover.style.position || 'relative';
        overlay = document.createElement('div');
        overlay.className = 'ai-cover-overlay';
        cover.appendChild(overlay);
      }
      return overlay;
    },

    // 隐藏封面遮罩
    hideOverlay(card) {
      const cover = this.getCoverEl(card);
      if (!cover) return;
      const overlay = cover.querySelector('.ai-cover-overlay');
      if (overlay) overlay.classList.remove('ai-cover-overlay--visible');
    },

    // 渲染 loading 遮罩
    renderOverlayLoading(card) {
      const overlay = this.getOrCreateOverlay(card);
      if (!overlay) return;
      overlay.innerHTML = `
        <div class="ai-ov-loading">
          <span class="ai-ov-spinner"></span>
          <span class="ai-ov-loading-text">AI 分析中</span>
        </div>
      `;
      overlay.classList.add('ai-cover-overlay--visible');
    },

    // 渲染结果遮罩（根据封面高度自适应内容密度）
    renderOverlaySummary(card, summary, bvid) {
      const overlay = this.getOrCreateOverlay(card);
      if (!overlay) return;
      const cover = this.getCoverEl(card);
      const coverH = cover ? cover.offsetHeight : 0;

      const ratingColorMap = { '值得看': '#4caf50', '一般': '#ff9800', '不值得': '#f44336' };
      const ratingColor = ratingColorMap[summary.rating] || '#ff9800';

      // 根据封面高度决定内容密度
      const showOverview = coverH >= 90;
      const showKeyPoints = coverH >= 120;
      const showChapters = coverH >= 140;
      const maxKeyPoints = coverH >= 160 ? 3 : 2;
      const maxChapters = 4;

      const keyPointsHtml = showKeyPoints && summary.keyPoints && summary.keyPoints.length > 0
        ? `<div class="ai-ov-keypoints">${summary.keyPoints.slice(0, maxKeyPoints).map(p => `<div class="ai-ov-kp">• ${p}</div>`).join('')}</div>`
        : '';

      const chaptersHtml = showChapters && summary.chapters && summary.chapters.length > 0
        ? `<div class="ai-ov-chapters">${summary.chapters.slice(0, maxChapters).map(c => { const t = c.title && c.title.length > 14 ? c.title.slice(0, 14) + '…' : (c.title || ''); return `<button class="ai-ov-chap" type="button" data-bvid="${bvid}" data-second="${c.second}"><span class="ai-ov-chap-time" style="color:${ratingColor}">${c.time}</span><span class="ai-ov-chap-title">${t}</span></button>`; }).join('')}</div>`
        : '';

      overlay.innerHTML = `
        <div class="ai-ov-content">
          <div class="ai-ov-top-row">
            <div class="ai-ov-rating" style="color:${ratingColor}">${summary.rating}</div>

          </div>
          ${showOverview ? `<div class="ai-ov-overview">${summary.overview}</div>` : ''}
          ${keyPointsHtml}
          ${chaptersHtml}

        </div>
      `;
      overlay.classList.add('ai-cover-overlay--visible');

      // overlay 消失后显示评级徽章
      this.showRatingBadge(card, summary.rating);

      // 绑定章节跳转
      overlay.querySelectorAll('.ai-ov-chap').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          const sec = Number(btn.dataset.second || 0);
          window.open(`https://www.bilibili.com/video/${btn.dataset.bvid}?t=${sec}`, '_blank', 'noopener');
        });
      });

      // 绑定展开/全文按钮 → 打开完整 portal popup
            // 绑定复制按钮
      const copyBtn = overlay.querySelector('.ai-ov-btn-copy');
      if (copyBtn) {
        copyBtn.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          const parts = [];
          parts.push(`评级：${summary.rating}`);
          if (summary.overview) parts.push(`\n概述：${summary.overview}`);
          if (summary.keyPoints && summary.keyPoints.length) parts.push(`\n关键点：\n${summary.keyPoints.map(p => `• ${p}`).join('\n')}`);
          if (summary.chapters && summary.chapters.length) parts.push(`\n时间节点：\n${summary.chapters.map(c => `${c.time} ${c.title}`).join('\n')}`);
          const text = parts.join('');
          navigator.clipboard.writeText(text).then(() => {
            copyBtn.textContent = '✓';
            setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
          }).catch(() => {
            copyBtn.textContent = '失败';
            setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
          });
        });
      }
    },

    showFullPopup(bvid, card, summary) {
      let popup = this.getCardPopup(card);
      if (!popup) popup = this.createSummaryPopup(bvid, card);
      this.renderSummary(popup, summary, bvid, card);
      // portal popup 关闭不影响 overlay 悬停，重绑 close handler
      this.bindCloseHandler(popup, card, { portalOnly: true });
      popup.style.display = 'block';
      this.adjustPopupPosition(popup, card);
    },

    showAIFullModal(bvid, card, summary) {
      console.log("[AI总结] showAIFullModal called", bvid, !!summary);
      // remove existing modal
      const existing = document.querySelector('.ai-fm-mask');
      if (existing) existing.remove();

      const ratingColorMap = { '值得看': '#4caf50', '一般': '#ff9800', '不值得': '#f44336' };
      const dotColorMap = { '值得看': '#52c41a', '一般': '#faad14', '不值得': '#ff4d4f' };
      const rc = ratingColorMap[summary.rating] || '#ff9800';
      const dc = dotColorMap[summary.rating] || '#faad14';

      const kpHtml = summary.keyPoints && summary.keyPoints.length
        ? '<div class="ai-fm-section">关键点</div><ul class="ai-fm-kp">' +
          summary.keyPoints.map(p => '<li>' + p + '</li>').join('') + '</ul>'
        : '';

      const chapHtml = summary.chapters && summary.chapters.length
        ? '<div class="ai-fm-section">时间节点</div><div class="ai-fm-chaps">' +
          summary.chapters.map(c =>
            '<button class="ai-fm-chap" data-second="' + c.second + '" data-bvid="' + bvid + '">' +
            '<span class="ai-fm-chap-time">' + c.time + '</span>' +
            '<span class="ai-fm-chap-title">' + c.title + '</span></button>'
          ).join('') + '</div>'
        : '';

      const reasonHtml = summary.ratingReason
        ? '<p class="ai-fm-reason">' + summary.ratingReason + '</p>'
        : '';

      const mask = document.createElement('div');
      mask.className = 'ai-fm-mask';
      mask.innerHTML = `
        <div class="ai-fm-box">
          <div class="ai-fm-header">
            <div class="ai-fm-rating" style="color:${rc}">
              <span class="ai-fm-dot" style="background:${dc}"></span>
              ${summary.rating}
            </div>
            <button class="ai-fm-close" type="button">✕</button>
          </div>
          <div class="ai-fm-body">
            ${summary.overview ? '<p class="ai-fm-overview">' + summary.overview + '</p>' : ''}
            ${kpHtml}
            ${chapHtml}
            ${reasonHtml}
          </div>
          <div class="ai-fm-footer">
            <button class="ai-fm-copy" type="button">复制全文</button>
            <a class="ai-fm-open" href="https://www.bilibili.com/video/${bvid}" target="_blank" rel="noopener">打开视频 ↗</a>
          </div>
        </div>
      `;
      document.body.appendChild(mask);

      // close on mask click
      mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
      mask.querySelector('.ai-fm-close').addEventListener('click', () => mask.remove());

      // chapter jump
      mask.querySelectorAll('.ai-fm-chap').forEach(btn => {
        btn.addEventListener('click', () => {
          const sec = Number(btn.dataset.second || 0);
          window.open('https://www.bilibili.com/video/' + btn.dataset.bvid + '?t=' + sec, '_blank', 'noopener');
          mask.remove();
        });
      });

      // copy
      mask.querySelector('.ai-fm-copy').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const parts = [];
        if (summary.rating) parts.push('评级：' + summary.rating);
        if (summary.overview) parts.push('概述：' + summary.overview);
        if (summary.keyPoints && summary.keyPoints.length) parts.push('关键点：\n' + summary.keyPoints.map(p => '• ' + p).join('\n'));
        if (summary.ratingReason) parts.push('评价理由：' + summary.ratingReason);
        navigator.clipboard.writeText(parts.join('\n\n')).then(() => {
          btn.textContent = '已复制';
          setTimeout(() => { btn.textContent = '复制全文'; }, 1500);
        });
      });
    },

    // 渲染 idle/error 遮罩
    renderOverlayIdle(card, message) {
      const overlay = this.getOrCreateOverlay(card);
      if (!overlay) return;
      overlay.innerHTML = `<div class="ai-ov-idle">${message}</div>`;
      overlay.classList.add('ai-cover-overlay--visible');
    },

    showRatingBadge(card, rating) {
      const existing = card.querySelector('.ai-rating-badge');
      if (existing) existing.remove();
      const map = { '值得看': { cls: 'badge-good', text: '✓ 值得看' }, '一般': { cls: 'badge-normal', text: '~ 一般' }, '不值得': { cls: 'badge-bad', text: '✕ 不值得' } };
      const info = map[rating];
      if (!info) return;
      // 找缩略图容器
      const thumb = card.querySelector('.bili-video-card__image--wrap, .cover-picture, .video-cover, .b-img__inner, a.cover');
      const anchor = thumb || card;
      const badge = document.createElement('div');
      badge.className = `ai-rating-badge ${info.cls}`;
      badge.textContent = info.text;
      anchor.style.position = anchor.style.position || 'relative';
      anchor.appendChild(badge);
    },

    // 悬停进度条
    startHoverProgress(card, totalDelay) {
      this.clearHoverProgress(card);
      const progressDelay = 200;
      const animDuration = Math.max(totalDelay - progressDelay, 100);
      const timer = setTimeout(() => {
        if (!card.querySelector('.ai-hover-progress')) {
          const bar = document.createElement('div');
          bar.className = 'ai-hover-progress';
          bar.style.animationDuration = animDuration + 'ms';
          const thumb = card.querySelector('.bili-video-card__image--wrap, .cover-picture, .video-cover, .b-img__inner, a.cover') || card;
          thumb.style.position = thumb.style.position || 'relative';
          thumb.appendChild(bar);
        }
      }, progressDelay);
      card._hoverProgressTimer = timer;
    },

    clearHoverProgress(card) {
      if (card._hoverProgressTimer) {
        clearTimeout(card._hoverProgressTimer);
        card._hoverProgressTimer = null;
      }
      const bar = card.querySelector('.ai-hover-progress');
      if (bar) bar.remove();
    },

    // 弹窗位置自适应：底部空间不足时向上弹出
    // 计算并应用 portal popup 的 fixed 坐标
    _applyPopupCoords(popup, card) {
      const cardRect = card.getBoundingClientRect();
      const viewportH = window.innerHeight;
      const viewportW = window.innerWidth;
      const popupW = Math.min(320, viewportW - 16);
      const spaceBelow = viewportH - cardRect.bottom;
      const spaceAbove = cardRect.top;

      popup.style.position = 'fixed';
      popup.style.width = popupW + 'px';
      popup.style.maxWidth = popupW + 'px';

      // 水平：左对齐卡片，右边不超出视口
      let left = cardRect.left;
      if (left + popupW > viewportW - 8) left = viewportW - popupW - 8;
      if (left < 8) left = 8;
      popup.style.left = left + 'px';

      // 垂直：优先向下，空间不足则向上
      const maxH = 480;
      if (spaceBelow >= 160 || spaceBelow >= spaceAbove) {
        popup.style.top = (cardRect.bottom + 6) + 'px';
        popup.style.bottom = 'auto';
        popup.style.maxHeight = Math.min(spaceBelow - 12, maxH) + 'px';
      } else {
        popup.style.bottom = (viewportH - cardRect.top + 6) + 'px';
        popup.style.top = 'auto';
        popup.style.maxHeight = Math.min(spaceAbove - 12, maxH) + 'px';
      }
    },

    adjustPopupPosition(popup, card) {
      this._applyPopupCoords(popup, card);

      // 绑定 scroll/resize 跟随（每个popup只绑一次）
      if (!popup._portalBound) {
        popup._portalBound = true;

        const onScroll = () => {
          if (popup.style.display === 'none') return;
          this._applyPopupCoords(popup, card);
        };
        const onResize = () => {
          if (popup.style.display === 'none') return;
          this._applyPopupCoords(popup, card);
        };
        window.addEventListener('scroll', onScroll, { passive: true, capture: true });
        window.addEventListener('resize', onResize, { passive: true });
        popup._portalCleanup = () => {
          window.removeEventListener('scroll', onScroll, { capture: true });
          window.removeEventListener('resize', onResize);
        };

        // 卡片滚出视口自动关闭
        const observer = new IntersectionObserver((entries) => {
          if (!entries[0].isIntersecting && popup.style.display !== 'none') {
            popup.style.display = 'none';
          }
        }, { threshold: 0.1 });
        observer.observe(card);
        popup._portalObserver = observer;
      }
    },

    bindCloseHandler(el, card, opts = {}) {
      const closeBtn = el.querySelector('.ai-close');
      if (!closeBtn) return;
      closeBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.clearHoverTimer(card);
        // portal popup 关闭只隐藏弹窗，不阻止后续 overlay 悬停
        if (!opts.portalOnly) {
          this.manuallyClosedCards.add(card);
          this.setDismissedVisual(card, true);
          this.cancelCardRequest(card);
        }
        el.classList.remove('loading');
        el.style.display = 'none';
      }, { once: true });
    },

    // 扫描并增强所有卡片
    scanAndEnhance() {
      if (!this.isEnabledForPage()) return;

      for (const selector of this.cardSelectors) {
        const cards = document.querySelectorAll(selector);
        cards.forEach(card => this.enhanceCard(card));
      }
      // 自动批量预加载
      PreloadQueue.scheduleFromPage();
    },

    // 初始化观察器
    initObserver() {
      let scanTimer = null;
      const observer = new MutationObserver((mutations) => {
        if (scanTimer) return;
        scanTimer = setTimeout(() => {
          scanTimer = null;
          this.scanAndEnhance();
        }, 100);

        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // 检查新增节点是否是卡片或包含卡片
              for (const selector of this.cardSelectors) {
                if (node.matches?.(selector)) {
                  this.enhanceCard(node);
                }
                node.querySelectorAll?.(selector).forEach(card => this.enhanceCard(card));
              }
            }
          }
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    },

    // 初始化
    async init() {
      await CacheDB.init();

      if (this.isEnabledForPage()) {
        this.addStyles();
        this.scanAndEnhance();
        this.initObserver();
      }
    },

    // 添加样式
    addStyles() {
      if (document.getElementById('ai-summary-styles')) return;

      const style = document.createElement('style');
      style.id = 'ai-summary-styles';
      style.textContent = `
        /* AI按钮样式 */
        .ai-summary-btn {
          position: absolute;
          right: 6px;
          bottom: 6px;
          display: flex;
          align-items: center;
          gap: 3px;
          padding: 3px 8px;
          background: rgba(0, 174, 236, 0.92);
          color: white;
          border-radius: 20px;
          font-size: 11px;
          font-weight: 500;
          cursor: pointer;
          opacity: 0;
          transition: opacity 0.2s, transform 0.15s;
          z-index: 10;
          font-family: "PingFang SC", "HarmonyOS_Regular", "Helvetica Neue", "Microsoft YaHei", sans-serif;
          letter-spacing: 0.3px;
          backdrop-filter: blur(2px);
        }

        .ai-summary-btn:hover {
          transform: scale(1.05);
          background: rgba(0, 161, 214, 1);
        }

        .ai-summary-btn.ai-dismissed {
          background: rgba(120, 120, 120, 0.88);
        }

        .ai-summary-btn.ai-dismissed span {
          opacity: 0.95;
        }

        .bili-video-card:hover .ai-summary-btn,
        .bili-video-card-recommend:hover .ai-summary-btn,
        .video-card:hover .ai-summary-btn,
        .small-item:hover .ai-summary-btn,
        .feed-card:hover .ai-summary-btn {
          opacity: 1;
        }

        /* 总结弹窗样式 */
        .ai-summary-popup {
          display: none;
          position: fixed;
          z-index: 99999;
          background: #fff;
          border-radius: 12px;
          box-shadow: 0 2px 16px rgba(0,0,0,.12), 0 0 0 1px rgba(0,0,0,.04);
          overflow-y: auto;
          animation: aiFadeIn 0.18s ease;
          font-family: "PingFang SC", "HarmonyOS_Regular", "Helvetica Neue", "Microsoft YaHei", sans-serif;
        }

        @keyframes aiFadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        .ai-summary-content {
          padding: 14px;
          font-size: 13px;
          line-height: 1.6;
          color: #18191c;
        }

        .ai-header {
          display: flex;
          align-items: center;
          gap: 5px;
          margin-bottom: 10px;
          padding-bottom: 9px;
          border-bottom: 1px solid #e3e5e7;
        }

        .ai-icon-svg {
          color: #00aeec;
          flex-shrink: 0;
        }

        .ai-title {
          font-size: 13px;
          font-weight: 600;
          color: #00aeec;
          flex: 1;
          letter-spacing: 0.2px;
        }

        .ai-generating-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #00aeec;
          animation: aiPulse 1.2s ease-in-out infinite;
          flex-shrink: 0;
        }

        @keyframes aiPulse {
          0%,100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.3; transform: scale(0.7); }
        }

        .ai-warning {
          font-size: 13px;
          flex-shrink: 0;
        }

        .ai-copy-btn, .ai-close {
          background: none;
          border: none;
          cursor: pointer;
          color: #9499a0;
          padding: 2px 4px;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          border-radius: 4px;
          transition: color 0.15s, background 0.15s;
        }

        .ai-copy-btn:hover, .ai-close:hover {
          color: #18191c;
          background: #f1f2f3;
        }

        .ai-overview {
          margin-bottom: 10px;
          color: #18191c;
          font-size: 13px;
          line-height: 1.65;
        }

        .ai-rating {
          display: flex;
          align-items: baseline;
          gap: 6px;
          padding: 7px 10px;
          border-radius: 6px;
          margin-bottom: 10px;
          font-size: 12px;
          border-left: 3px solid transparent;
        }

        .rating-good {
          background: #f0faf0;
          border-left-color: #23ac38;
          color: #1a7a28;
        }

        .rating-normal {
          background: #fff8ee;
          border-left-color: #f5a623;
          color: #a06700;
        }

        .rating-bad {
          background: #fff2f0;
          border-left-color: #e53935;
          color: #b71c1c;
        }

        .ai-rating-label {
          font-weight: 700;
          font-size: 12px;
        }

        .ai-rating-reason {
          font-size: 12px;
          opacity: 0.85;
          line-height: 1.5;
        }

        .ai-keypoints {
          font-size: 12px;
          color: #61666d;
          margin-bottom: 8px;
        }

        .ai-keypoints-title {
          font-size: 11px;
          font-weight: 600;
          color: #9499a0;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 5px;
        }

        .ai-keypoints ul {
          margin: 0;
          padding: 0;
          list-style: none;
        }

        .ai-keypoints li {
          padding: 3px 0 3px 12px;
          position: relative;
          line-height: 1.55;
          color: #18191c;
          font-size: 12px;
        }

        .ai-keypoints li::before {
          content: '';
          position: absolute;
          left: 2px;
          top: 9px;
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: #00aeec;
        }

        .ai-warning-text {
          margin-top: 8px;
          padding: 6px 10px;
          background: #fff8e6;
          border-radius: 6px;
          border-left: 3px solid #f5a623;
          font-size: 12px;
          color: #a06700;
        }

        .ai-chapters {
          margin-top: 8px;
          font-size: 12px;
        }

        .ai-chapters-title {
          font-size: 11px;
          font-weight: 600;
          color: #9499a0;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 6px;
        }

        .ai-section-label {
          font-size: 11px;
          font-weight: 600;
          color: #9499a0;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 6px;
        }

        .ai-chapters-grid {
          display: flex;
          flex-wrap: wrap;
          gap: 5px;
        }

        .ai-chapter-link {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          border: 1px solid #e3e5e7;
          background: #f6f7f8;
          color: #61666d;
          border-radius: 20px;
          font-size: 11px;
          line-height: 1.4;
          padding: 3px 8px;
          cursor: pointer;
          transition: background 0.15s, border-color 0.15s;
          font-family: "PingFang SC", "HarmonyOS_Regular", "Microsoft YaHei", sans-serif;
        }
        .ai-chapter-time { color: #00aeec; font-weight: 600; font-size: 10px; }
        .ai-chapter-title { color: #61666d; }

        .ai-chapter-link:hover {
          background: #e8f7fd;
          border-color: #b3dff5;
          color: #00aeec;
        }
        .ai-chapter-link:hover .ai-chapter-title { color: #00aeec; }

        .ai-loading {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 16px 14px;
          color: #9499a0;
          font-size: 12px;
        }

        .ai-loading span {
          display: inline-block;
          width: 14px;
          height: 14px;
          border: 2px solid #e3e5e7;
          border-top-color: #00aeec;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
          flex-shrink: 0;
        }

        @keyframes spin { to { transform: rotate(360deg); } }

        .ai-streaming-status {
          font-size: 11px;
          color: #9499a0;
          padding: 0 14px 8px;
        }

        .ai-error { background: #fff8f8; }
        .ai-error-msg { color: #c62828; font-size: 12px; line-height: 1.6; }

        /* 评分徽章 - 毛玻璃 */
        .ai-rating-badge {
          position: absolute;
          top: 6px;
          left: 6px;
          z-index: 99;
          padding: 2px 8px;
          border-radius: 20px;
          font-size: 11px;
          font-weight: 600;
          line-height: 1.7;
          pointer-events: none;
          white-space: nowrap;
          backdrop-filter: blur(6px);
          -webkit-backdrop-filter: blur(6px);
          font-family: "PingFang SC", "HarmonyOS_Regular", "Microsoft YaHei", sans-serif;
        }
        .badge-good  { background: rgba(0,180,80,.75); color: #fff; }
        .badge-normal { background: rgba(245,124,0,.75); color: #fff; }
        .badge-bad   { background: rgba(198,40,40,.75); color: #fff; }

        /* 悬停进度条 */
        @keyframes ai-progress-fill {
          from { width: 0%; }
          to   { width: 100%; }
        }
        .ai-hover-progress {
          position: absolute;
          bottom: 0;
          left: 0;
          height: 3px;
          width: 0%;
          background: #00a1d6;
          border-radius: 0 0 4px 4px;
          z-index: 100;
          pointer-events: none;
          animation: ai-progress-fill linear forwards;
        }

        /* 复制按钮 */
        .ai-copy-btn {
          background: none;
          border: none;
          cursor: pointer;
          padding: 2px 4px;
          font-size: 13px;
          line-height: 1;
          opacity: 0.6;
          transition: opacity 0.15s;
        }
        .ai-copy-btn:hover { opacity: 1; }

        /* 封面遮罩 overlay */
        .ai-cover-overlay {
          position: absolute;
          inset: 0;
          z-index: 20;
          border-radius: inherit;
          overflow: hidden;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.2s ease;
          background: linear-gradient(to top,
            rgba(0,0,0,.95) 0%,
            rgba(0,0,0,.78) 40%,
            rgba(0,0,0,.38) 100%);
          display: flex;
          flex-direction: column;
          justify-content: flex-end;
          padding: 8px;
          box-sizing: border-box;
          font-family: "PingFang SC", "HarmonyOS_Regular", "Helvetica Neue", "Microsoft YaHei", sans-serif;
        }
        .ai-cover-overlay--visible { opacity: 1; pointer-events: auto; }
        .ai-ov-top-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 4px;
          gap: 4px;
        }
        .ai-ov-top-btns {
          display: flex;
          gap: 3px;
          flex-shrink: 0;
          margin-right: 22px;
        }
        .ai-ov-btn {
          font-size: 10px;
          padding: 2px 8px;
          background: rgba(255,255,255,.22);
          color: rgba(255,255,255,.95);
          border: 1px solid rgba(255,255,255,.38);
          border-radius: 8px;
          cursor: pointer;
          line-height: 1.6;
          transition: background .15s;
          white-space: nowrap;
        }
        .ai-ov-btn:hover { background: rgba(255,255,255,.42); border-color: rgba(255,255,255,.6); }
        .ai-ov-rating {
          font-size: 13px;
          font-weight: 700;
          color: #fff;
          margin-bottom: 0;
          display: flex;
          align-items: center;
          gap: 5px;
          text-shadow: 0 1px 4px rgba(0,0,0,.9), 0 0 6px rgba(0,0,0,.7);
        }
        .ai-ov-rating-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
        .ai-ov-rating-dot.good { background: #52c41a; }
        .ai-ov-rating-dot.normal { background: #faad14; }
        .ai-ov-rating-dot.bad { background: #ff4d4f; }
        .ai-ov-overview {
          font-size: 11px;
          color: rgba(255,255,255,.88);
          line-height: 1.5;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          margin-bottom: 5px;
          text-shadow: 0 1px 4px rgba(0,0,0,.9), 0 0 8px rgba(0,0,0,.6);
        }
        .ai-ov-keypoints { margin-bottom: 5px; }
        .ai-ov-kp {
          font-size: 10px;
          color: rgba(255,255,255,.78);
          line-height: 1.4;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .ai-ov-chapters { display: flex; flex-direction: column; gap: 2px; margin-bottom: 5px; }
        .ai-ov-chap-time { font-size: 10px; font-weight: 600; color: #7ecfef; min-width: 36px; flex-shrink: 0; font-variant-numeric: tabular-nums; }
        .ai-ov-chap-title { font-size: 11px; color: rgba(255,255,255,.85); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
        .ai-ov-chap {
          display: flex;
          align-items: center;
          gap: 6px;
          background: rgba(255,255,255,.1);
          border: none;
          border-radius: 4px;
          padding: 3px 6px;
          cursor: pointer;
          width: 100%;
          text-align: left;
          transition: background 0.15s;
          overflow: hidden;
        }
        .ai-ov-chap:hover { background: rgba(255,255,255,.22); }
        .ai-ov-expand {
          position: absolute;
          right: 8px;
          bottom: 8px;
          font-size: 10px;
          color: rgba(255,255,255,.7);
          background: rgba(0,0,0,.35);
          border: 1px solid rgba(255,255,255,.2);
          border-radius: 8px;
          padding: 2px 8px;
          cursor: pointer;
          backdrop-filter: blur(4px);
          transition: background 0.15s, color 0.15s;
          z-index: 2;
        }
        .ai-ov-expand:hover { background: rgba(255,255,255,.2); color: #fff; border-color: rgba(255,255,255,.4); }
        .ai-cover-overlay.ai-ov--loading {
          background: rgba(0,0,0,.45);
          justify-content: center;
          align-items: center;
        }
        .ai-ov-loading { display: flex; flex-direction: column; align-items: center; gap: 6px; }
        .ai-ov-spinner {
          width: 20px; height: 20px;
          border: 2px solid rgba(255,255,255,.25);
          border-top-color: #00aeec;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }
        .ai-ov-loading-text { font-size: 11px; color: rgba(255,255,255,.8); }

        /* 暗色模式 - 跟进B站暗色色板 */
        @media (prefers-color-scheme: dark) {
          .ai-summary-popup {
            background: #18191c;
            box-shadow: 0 2px 12px rgba(0,0,0,.4);
          }
          .ai-summary-content { color: #e3e5e7; }
          .ai-header { border-bottom-color: #303030; }
          .ai-title { color: #00aeec; }
          .ai-icon-svg { color: #00aeec; }
          .ai-overview { color: #c9d0d8; }
          .ai-copy-btn, .ai-close { color: #61666d; }
          .ai-copy-btn:hover, .ai-close:hover { color: #e3e5e7; background: rgba(255,255,255,.08); }
          .ai-section-label { color: #9499a0; }
          .rating-good { border-left-color: #4caf50; background: rgba(76,175,80,.1); color: #81c784; }
          .rating-normal { border-left-color: #ff9800; background: rgba(255,152,0,.1); color: #ffb74d; }
          .rating-bad { border-left-color: #f44336; background: rgba(244,67,54,.1); color: #e57373; }
          .ai-keypoint-item { color: #c9d0d8; }
          .ai-keypoint-item::before { color: #00aeec; }
          .ai-chapters-grid { gap: 5px; }
          .ai-chapter-link { background: #1f2937; border-color: #303a47; color: #9499a0; }
          .ai-chapter-time { color: #00aeec; }
          .ai-chapter-title { color: #9499a0; }
          .ai-chapter-link:hover { background: #1a3040; border-color: #00aeec; }
          .ai-chapter-link:hover .ai-chapter-title { color: #00aeec; }
          .ai-error { background: rgba(198,40,40,.1); }
          .ai-error-msg { color: #ef9a9a; }
          .ai-loading { color: #61666d; }
          .ai-loading span { border-color: #303030; border-top-color: #00aeec; }
          .ai-streaming-status { color: #61666d; }
          .ai-warning-text { background: rgba(255,152,0,.1); color: #ffb74d; border-left-color: #ff9800; }
        }
      `;
      const mountTarget = document.head || document.documentElement;
      if (mountTarget) {
        mountTarget.appendChild(style);
      }
    }
  };

  // ============================================================
  // 模块6: 设置面板
  // ============================================================
  const SettingsPanel = {
    create() {
      if (!document.body) {
        setTimeout(() => this.create(), 50);
        return;
      }

      const panel = document.createElement('div');
      panel.id = 'ai-summary-settings';
      panel.innerHTML = `
        <div class="settings-overlay" onclick="this.parentElement.remove()"></div>
        <div class="settings-content">
          <div class="settings-header">
            <h3>🤖 B站AI总结 设置</h3>
            <button class="settings-close" onclick="this.parentElement.parentElement.parentElement.remove()">✕</button>
          </div>
          <div class="settings-body">
            <div class="settings-section">
              <h4>LLM配置</h4>
              <div class="settings-row">
                <label>API端点</label>
                <input type="text" id="setting-endpoint" placeholder="https://api.openai.com/v1/chat/completions" />
              </div>
              <div class="settings-row">
                <label>API Key</label>
                <input type="password" id="setting-apikey" placeholder="sk-xxx" />
              </div>
              <div class="settings-row">
                <label>模型</label>
                <input type="text" id="setting-model" placeholder="gpt-4o-mini" />
              </div>
              <div class="settings-row">
                <label>最大Tokens</label>
                <input type="number" id="setting-maxtokens" placeholder="1000" />
              </div>
              <div class="settings-row checkbox-row">
                <label><input type="checkbox" id="setting-stream" checked /> 启用流式展示（更快看到内容）</label>
              </div>
            </div>

            <div class="settings-section">
              <h4>触发设置</h4>
              <div class="settings-row">
                <label>触发方式</label>
                <select id="setting-trigger">
                  <option value="hover">悬浮触发</option>
                  <option value="click">点击触发</option>
                </select>
              </div>
              <div class="settings-row" id="hover-delay-row">
                <label>悬浮延迟(ms)</label>
                <input type="number" id="setting-hoverdelay" placeholder="800" />
              </div>
              <div class="settings-row checkbox-row" id="hover-cancel-row">
                <label><input type="checkbox" id="setting-cancel-on-leave" checked /> 悬浮移出时取消请求</label>
              </div>
              <div class="settings-row checkbox-row">
                <label><input type="checkbox" id="setting-autopreload" /> 自动批量总结（按页面顺序逐个分析）</label>
              </div>
              <div class="settings-row" id="autopreload-concurrency-row" style="display:none">
                <label>并发数（1-5）</label>
                <input type="number" id="setting-autopreload-concurrency" placeholder="2" min="1" max="5" />
              </div>
              <div class="settings-row" id="autopreload-status-row" style="display:none">
                <label>进度</label>
                <span id="preload-status" style="font-size:12px;color:#00a1d6">等待开始</span>
              </div>
            </div>

            <div class="settings-section">
              <h4>显示位置</h4>
              <div class="settings-row checkbox-row">
                <label><input type="checkbox" id="setting-homepage" checked /> 主页推荐</label>
              </div>
              <div class="settings-row checkbox-row">
                <label><input type="checkbox" id="setting-search" checked /> 搜索结果</label>
              </div>
              <div class="settings-row checkbox-row">
                <label><input type="checkbox" id="setting-popular" checked /> 热门/排行榜</label>
              </div>
              <div class="settings-row checkbox-row">
                <label><input type="checkbox" id="setting-space" checked /> 用户空间</label>
              </div>
              <div class="settings-row checkbox-row">
                <label><input type="checkbox" id="setting-only-cc" checked /> 仅对有CC字幕的视频显示入口（默认）</label>
              </div>
            </div>

            <div class="settings-section">
              <h4>缓存管理</h4>
              <div class="settings-row">
                <label>缓存有效期(天)</label>
                <input type="number" id="setting-cachettl" placeholder="7" />
              </div>
              <div class="settings-row">
                <button id="setting-clearcache" class="settings-btn danger">清除所有缓存</button>
              </div>
            </div>
          </div>
          <div class="settings-footer">
            <button id="setting-save" class="settings-btn primary">保存设置</button>
            <button onclick="this.parentElement.parentElement.parentElement.remove()" class="settings-btn">取消</button>
          </div>
        </div>
      `;

      this.addStyles();
      this.loadValues(panel);
      this.bindEvents(panel);

      document.body.appendChild(panel);
    },

    addStyles() {
      if (document.getElementById('ai-summary-settings-styles')) return;

      const style = document.createElement('style');
      style.id = 'ai-summary-settings-styles';
      style.textContent = `
        #ai-summary-settings {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 999999;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }

        .settings-overlay {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.5);
        }

        .settings-content {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 480px;
          max-height: 80vh;
          background: white;
          border-radius: 12px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }

        .settings-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px 20px;
          background: #00a1d6;
          color: white;
        }

        .settings-header h3 {
          margin: 0;
          font-size: 16px;
        }

        .settings-close {
          background: none;
          border: none;
          color: white;
          font-size: 18px;
          cursor: pointer;
          opacity: 0.8;
        }

        .settings-close:hover {
          opacity: 1;
        }

        .settings-body {
          flex: 1;
          overflow-y: auto;
          padding: 16px 20px;
        }

        .settings-section {
          margin-bottom: 20px;
        }

        .settings-section h4 {
          margin: 0 0 12px 0;
          font-size: 14px;
          color: #333;
          border-bottom: 1px solid #eee;
          padding-bottom: 8px;
        }

        .settings-row {
          margin-bottom: 12px;
        }

        .settings-row label {
          display: block;
          margin-bottom: 4px;
          font-size: 13px;
          color: #666;
        }

        .settings-row input[type="text"],
        .settings-row input[type="password"],
        .settings-row input[type="number"],
        .settings-row select {
          width: 100%;
          padding: 8px 12px;
          border: 1px solid #ddd;
          border-radius: 6px;
          font-size: 13px;
          box-sizing: border-box;
        }

        .settings-row input:focus,
        .settings-row select:focus {
          outline: none;
          border-color: #00a1d6;
        }

        .checkbox-row label {
          display: flex;
          align-items: center;
          gap: 8px;
          cursor: pointer;
        }

        .checkbox-row input[type="checkbox"] {
          width: 16px;
          height: 16px;
        }

        .settings-footer {
          display: flex;
          justify-content: flex-end;
          gap: 12px;
          padding: 16px 20px;
          background: #f5f5f5;
          border-top: 1px solid #eee;
        }

        .settings-btn {
          padding: 8px 20px;
          border: none;
          border-radius: 6px;
          font-size: 13px;
          cursor: pointer;
          transition: background 0.2s;
        }

        .settings-btn.primary {
          background: #00a1d6;
          color: white;
        }

        .settings-btn.primary:hover {
          background: #0090c3;
        }

        .settings-btn.danger {
          background: #e53935;
          color: white;
        }

        .settings-btn.danger:hover {
          background: #c62828;
        }

        @media (prefers-color-scheme: dark) {
          .settings-content {
            background: #2a2a2a;
            color: #e0e0e0;
          }

          .settings-section h4 {
            color: #e0e0e0;
            border-bottom-color: #444;
          }

          .settings-row label {
            color: #aaa;
          }

          .settings-row input,
          .settings-row select {
            background: #1a1a1a;
            border-color: #444;
            color: #e0e0e0;
          }

          .settings-footer {
            background: #1a1a1a;
            border-top-color: #444;
          }
        }
      `;
      const mountTarget = document.head || document.documentElement;
      if (mountTarget) {
        mountTarget.appendChild(style);
      }
    },

    loadValues(panel) {
      const config = Config.getAll();

      panel.querySelector('#setting-endpoint').value = config.llm.endpoint || '';
      panel.querySelector('#setting-apikey').value = config.llm.apiKey || '';
      panel.querySelector('#setting-model').value = config.llm.model || '';
      panel.querySelector('#setting-maxtokens').value = config.llm.maxTokens || '';
      panel.querySelector('#setting-stream').checked = config.llm.stream !== false;
      panel.querySelector('#setting-trigger').value = config.trigger.mode || 'hover';
      panel.querySelector('#setting-hoverdelay').value = config.trigger.hoverDelay || '';
      panel.querySelector('#setting-cancel-on-leave').checked = config.trigger.cancelOnMouseLeave !== false;
      const autoPreload = config.trigger.autoPreload;
      panel.querySelector('#setting-autopreload').checked = autoPreload;
      panel.querySelector('#autopreload-concurrency-row').style.display = autoPreload ? 'block' : 'none';
      panel.querySelector('#autopreload-status-row').style.display = autoPreload ? 'block' : 'none';
      panel.querySelector('#setting-autopreload-concurrency').value = config.trigger.autoPreloadConcurrency || 2;
      panel.querySelector('#setting-homepage').checked = config.display.showInHomepage;
      panel.querySelector('#setting-search').checked = config.display.showInSearch;
      panel.querySelector('#setting-popular').checked = config.display.showInPopular;
      panel.querySelector('#setting-space').checked = config.display.showInSpace;
      panel.querySelector('#setting-only-cc').checked = config.display.onlyShowWithCC !== false;
      panel.querySelector('#setting-cachettl').value = (config.cache.ttl || 604800000) / 86400000;
    },

    bindEvents(panel) {
      // 触发方式切换
      panel.querySelector('#setting-trigger').addEventListener('change', (e) => {
        const delayRow = panel.querySelector('#hover-delay-row');
        const cancelRow = panel.querySelector('#hover-cancel-row');
        const isHover = e.target.value === 'hover';
        delayRow.style.display = isHover ? 'block' : 'none';
        cancelRow.style.display = isHover ? 'block' : 'none';
      });

      const triggerEl = panel.querySelector('#setting-trigger');
      const initialHover = triggerEl.value === 'hover';
      panel.querySelector('#hover-delay-row').style.display = initialHover ? 'block' : 'none';
      panel.querySelector('#hover-cancel-row').style.display = initialHover ? 'block' : 'none';

      // 自动预加载开关
      panel.querySelector('#setting-autopreload').addEventListener('change', (e) => {
        const on = e.target.checked;
        panel.querySelector('#autopreload-concurrency-row').style.display = on ? 'block' : 'none';
        panel.querySelector('#autopreload-status-row').style.display = on ? 'block' : 'none';
      });

      // 保存
      panel.querySelector('#setting-save').addEventListener('click', () => {
        const currentConfig = Config.getAll();
        const endpointValue = panel.querySelector('#setting-endpoint').value.trim();
        if (!LLM.isValidEndpoint(endpointValue)) {
          alert('API端点无效：支持HTTPS；HTTP仅允许本机或内网地址');
          return;
        }

        const modelValue = panel.querySelector('#setting-model').value.trim();

        Config.set('llm.endpoint', endpointValue);
        Config.set('llm.apiKey', panel.querySelector('#setting-apikey').value);
        Config.set('llm.model', modelValue);
        Config.set('llm.maxTokens', parseInt(panel.querySelector('#setting-maxtokens').value) || 1500);
        Config.set('llm.stream', panel.querySelector('#setting-stream').checked);
        Config.set('trigger.mode', panel.querySelector('#setting-trigger').value);
        Config.set('trigger.hoverDelay', parseInt(panel.querySelector('#setting-hoverdelay').value) || 800);
        Config.set('trigger.cancelOnMouseLeave', panel.querySelector('#setting-cancel-on-leave').checked);
        const newAutoPreload = panel.querySelector('#setting-autopreload').checked;
        Config.set('trigger.autoPreload', newAutoPreload);
        Config.set('trigger.autoPreloadConcurrency', Math.min(5, Math.max(1, parseInt(panel.querySelector('#setting-autopreload-concurrency').value) || 2)));
        if (newAutoPreload) { PreloadQueue.reset(); PreloadQueue.scheduleFromPage(); }
        Config.set('display.showInHomepage', panel.querySelector('#setting-homepage').checked);
        Config.set('display.showInSearch', panel.querySelector('#setting-search').checked);
        Config.set('display.showInPopular', panel.querySelector('#setting-popular').checked);
        Config.set('display.showInSpace', panel.querySelector('#setting-space').checked);
        Config.set('display.onlyShowWithCC', panel.querySelector('#setting-only-cc').checked);
        Config.set('cache.ttl', (parseInt(panel.querySelector('#setting-cachettl').value) || 7) * 86400000);

        if (currentConfig.llm.endpoint !== endpointValue || currentConfig.llm.model !== modelValue) {
          CacheDB.clear().catch((error) => {
            console.warn('[B站AI总结] 清理缓存失败:', error?.message || error);
          });
        }

        // 显示 toast 提示
        const toast = document.createElement('div');
        toast.textContent = '✓ 设置已保存';
        toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#18191c;color:#fff;padding:8px 20px;border-radius:20px;font-size:13px;z-index:999999;box-shadow:0 2px 12px rgba(0,0,0,.3);transition:opacity 0.3s;font-family:PingFang SC,sans-serif;';
        document.body.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 1800);
        panel.remove();
      });

      // 清除缓存
      panel.querySelector('#setting-clearcache').addEventListener('click', async () => {
        if (confirm('确定要清除所有缓存吗？')) {
          await CacheDB.clear();
          alert('缓存已清除！');
        }
      });
    }
  };

  // ============================================================
  // 模块7: 原有播放页字幕功能 (保留原有代码核心)
  // ============================================================

  // ============================================================
  // Chapter Marker — 视频页进度条章节标记
  // ============================================================
  const ChapterMarker = {
    _injected: false,
    _url: '',

    getBvid() {
      const m = location.pathname.match(/\/video\/(BV[\w]+)/);
      return m ? m[1] : null;
    },

    async waitFor(selector, timeout = 8000) {
      const t0 = Date.now();
      return new Promise((resolve, reject) => {
        const check = () => {
          const el = document.querySelector(selector);
          if (el) return resolve(el);
          if (Date.now() - t0 > timeout) return reject(new Error('timeout: ' + selector));
          requestAnimationFrame(check);
        };
        check();
      });
    },

    async init() {
      this._url = location.href;
      await this.inject();
      // SPA 路由监听
      const orig = history.pushState.bind(history);
      history.pushState = (...args) => { orig(...args); setTimeout(() => this.onNav(), 300); };
      window.addEventListener('popstate', () => setTimeout(() => this.onNav(), 300));
    },

    onNav() {
      if (location.href === this._url) return;
      this._url = location.href;
      this._injected = false;
      const pageType = HomePageEnhancer.getPageType();
      if (pageType === 'video' || pageType === 'bangumi') {
        setTimeout(() => this.inject(), 800);
      }
    },

    _cssInjected: false,

    injectCSS() {
      if (this._cssInjected) return;
      if (document.getElementById('ai-chapter-css')) { this._cssInjected = true; return; }
      const s = document.createElement('style');
      s.id = 'ai-chapter-css';
      s.textContent = [
        '.ai-chapter-markers { position: absolute; inset: 0; z-index: 5; }',
        '.ai-chapter-marker { position: absolute; top: 0; height: 100%; cursor: pointer; }',
        '.ai-chapter-marker-line { width: 2px; height: 100%; background: rgba(0,174,236,.9); box-shadow: 0 0 4px rgba(0,174,236,.5); pointer-events: none; opacity: 1; }',
        '.ai-chapter-marker-label { position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%); white-space: nowrap; font-size: 11px; font-weight: 500; background: rgba(0,0,0,.85); color: #fff; padding: 3px 8px; border-radius: 4px; opacity: 1; pointer-events: none; z-index: 10; }',
        '.ai-chapter-marker-label::after { content: ""; position: absolute; top: 100%; left: 50%; transform: translateX(-50%); border: 5px solid transparent; border-top: 5px solid rgba(0,0,0,.85); }',
        '.ai-chapter-marker:hover .ai-chapter-marker-label { opacity: 1; }',
        '.bpx-player-progress-area:hover .ai-chapter-marker-label { opacity: 1; }'
      ].join('\n');
      document.head.appendChild(s);
      this._cssInjected = true;
    },

    async inject() {
      this.injectCSS();
      if (this._injected) return;
      const bvid = this.getBvid();
      if (!bvid) return;

      let summary;
      try {
        const raw = GM_getValue('ai_sum_' + bvid);
        if (!raw) {
          console.log('[ChapterMarker] no cache, fetching for', bvid);
          try {
            const fetched = await SummaryUI.triggerSummary(bvid, null, { silent: true, force: false });
            if (fetched) { raw = JSON.stringify(fetched); GM_setValue('ai_sum_' + bvid, raw); }
          } catch(fe) { console.log('[ChapterMarker] fetch err', fe); }
          if (!raw) { console.log('[ChapterMarker] no summary for', bvid); return; }
        }
        summary = JSON.parse(raw);
      } catch(e) { console.log('[ChapterMarker] parse err', e); return; }

      if (!summary.chapters || !summary.chapters.length) return;

      let progressWrap;
      try {
        progressWrap = await this.waitFor('.bpx-player-progress-wrap');
      } catch(e) { console.log('[ChapterMarker] progress bar not found'); return; }

      const video = document.querySelector('video');
      if (!video) return;

      const getDuration = () => new Promise(resolve => {
        if (video.duration && isFinite(video.duration)) return resolve(video.duration);
        video.addEventListener('loadedmetadata', () => resolve(video.duration), { once: true });
        setTimeout(() => resolve(video.duration || 0), 3000);
      });
      const duration = await getDuration();
      if (!duration) return;

      // remove old
      progressWrap.querySelector('.ai-chapter-markers')?.remove();

      const container = document.createElement('div');
      container.className = 'ai-chapter-markers';

      summary.chapters.forEach(ch => {
        const pct = Math.min(99, (ch.second / duration) * 100);
        const marker = document.createElement('div');
        marker.className = 'ai-chapter-marker';
        marker.style.left = pct + '%';
        marker.dataset.second = ch.second;
        marker.innerHTML = '<div class="ai-chapter-marker-line"></div>' +
          '<div class="ai-chapter-marker-label">' + ch.time + ' ' + ch.title + '</div>';
        marker.style.pointerEvents = 'auto';
        marker.style.cursor = 'pointer';
        marker.addEventListener('click', (e) => {
          e.stopPropagation();
          const video = document.querySelector('video');
          if (video) video.currentTime = ch.second;
        });
        container.appendChild(marker);
      });

      // mount to progress bar itself
      const progressBar = progressWrap.querySelector('.bpx-player-progress') || progressWrap;
      progressBar.style.position = 'relative';
      progressBar.appendChild(container);
      this._injected = true;
      console.log('[ChapterMarker] injected', summary.chapters.length, 'markers for', bvid);
    }
  };
  const PlayerSubtitleHelper = {
    // 这里保留原有的字幕下载功能
    // 从原cc.js中提取核心逻辑

    async init() {
      const pageType = HomePageEnhancer.getPageType();
      if (pageType !== 'video' && pageType !== 'bangumi') return;
      console.log('[B站AI总结] 播放页字幕功能已加载');
      await ChapterMarker.init();
    }
  };

  // ============================================================
  // 主入口
  // ============================================================
  async function main() {
    console.log('[B站AI总结] 脚本已加载');

    // 注册设置菜单
    GM_registerMenuCommand('⚙️ AI总结设置', () => SettingsPanel.create());

    // 初始化主页增强
    await HomePageEnhancer.init();

    // 初始化播放页功能
    await PlayerSubtitleHelper.init();
  }

  // 全局未处理Promise错误监听
  window.addEventListener('unhandledrejection', e => {
    console.error('[AI总结] unhandled rejection:', e.reason, e.reason && e.reason.stack);
  });
  // 启动
  main().catch(e => console.error('[AI总结] main error:', e));

})();
