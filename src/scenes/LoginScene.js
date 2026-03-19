// LoginScene — login / register screen with password, color picker, model selector.
// Auto-logs in returning users via localStorage.

import Phaser from 'phaser';
import { fetchModels, setModel, setNumCtx } from '../net/LLMClient.js';

import { API_BASE } from '../config.js';
const STORAGE_KEY = 'iron_anachronism_session';

const COLOR_OPTIONS = [
  { hex: '#ff6666', label: 'Red' },
  { hex: '#66aaff', label: 'Blue' },
  { hex: '#66ff66', label: 'Green' },
  { hex: '#ffaa44', label: 'Orange' },
  { hex: '#ff66ff', label: 'Pink' },
  { hex: '#ffff44', label: 'Yellow' },
  { hex: '#44ffdd', label: 'Cyan' },
  { hex: '#cc88ff', label: 'Purple' },
];

export default class LoginScene extends Phaser.Scene {
  constructor() {
    super('LoginScene');
  }

  init(data) {
    // Data passed from GameScene on logout
    this._prefill = data || {};
  }

  create() {
    const W = this.cameras.main.width;
    const H = this.cameras.main.height;

    // Start fetching models + server config in parallel
    this._modelList = [];
    this._modelIdx = 0;
    this._selectedModel = 'qwen2.5:3b';
    this._modelsFetched = false;
    this._devMode = false;

    // Check if server forces a model (dev mode)
    fetch(`${API_BASE}/game_config`).then(r => r.json()).then(cfg => {
      if (cfg.dev_mode && cfg.forced_model) {
        this._devMode = true;
        this._selectedModel = cfg.forced_model;
        if (cfg.num_ctx) setNumCtx(cfg.num_ctx);
        this._modelsFetched = true;
        if (this._modelLabel) {
          this._modelLabel.setText(`${cfg.forced_model} (dev)`).setColor('#88cc88');
        }
        if (this._modelSectionLabel) {
          this._modelSectionLabel.setText('LLM Model (set by server):');
        }
      }
    }).catch(() => {});

    fetchModels().then(models => {
      if (this._devMode) return; // server already forced a model
      this._modelsFetched = true;
      if (models.length > 0) {
        this._modelList = models;
        const prefIdx = models.findIndex(m => m.includes('qwen'));
        this._modelIdx = prefIdx >= 0 ? prefIdx : 0;
        this._selectedModel = models[this._modelIdx];
        if (this._modelLabel) this._modelLabel.setText(this._selectedModel);
      } else {
        if (this._modelLabel) this._modelLabel.setText('(Ollama not found)').setColor('#ff6666');
      }
    });

    // Try auto-login from saved session (skip if we came from logout)
    if (!this._prefill?.prefillUsername) {
      const saved = this._loadSession();
      if (saved) {
        this._autoLogin(saved);
        return;
      }
    }

    this._buildUI(W, H);
  }

  _buildUI(W, H) {
    // State — prefill from logout if available
    this._mode = 'login'; // 'login' or 'register'
    this._activeField = 'username'; // 'username' or 'password'
    this._username = this._prefill?.prefillUsername || '';
    this._password = this._prefill?.prefillPassword || '';
    this._selectedColor = COLOR_OPTIONS[0].hex;
    this._submitting = false;

    // Background
    this.add.rectangle(W / 2, H / 2, W, H, 0x0a0a1e);

    // Title
    this.add.text(W / 2, 40, 'IRON ANACHRONISM', {
      fontSize: '36px', color: '#ffcc44', fontStyle: 'bold',
    }).setOrigin(0.5);

    // ── Mode toggle ───────────────────────────────────────────────────────────
    this._modeLabel = this.add.text(W / 2, 80, '', {
      fontSize: '13px', color: '#8899aa',
    }).setOrigin(0.5);

    this._toggleBtn = this.add.text(W / 2, 98, '', {
      fontSize: '12px', color: '#66aaff',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    this._toggleBtn.on('pointerdown', () => {
      this._mode = this._mode === 'login' ? 'register' : 'login';
      this._updateModeUI();
    });

    // ── Username field ────────────────────────────────────────────────────────
    const fieldY = 135;
    this.add.text(W / 2 - 150, fieldY - 10, 'Username', {
      fontSize: '11px', color: '#8899aa',
    }).setOrigin(0, 1);

    this._userBg = this.add.rectangle(W / 2, fieldY, 300, 32, 0x1a1a3e)
      .setStrokeStyle(2, 0x4466aa).setInteractive({ useHandCursor: true });
    this._userBg.on('pointerdown', () => { this._activeField = 'username'; this._updateFields(); });

    this._userText = this.add.text(W / 2, fieldY, '|', {
      fontSize: '16px', color: '#ffffff',
    }).setOrigin(0.5);

    // ── Password field ────────────────────────────────────────────────────────
    const pwY = fieldY + 52;
    this.add.text(W / 2 - 150, pwY - 10, 'Password', {
      fontSize: '11px', color: '#8899aa',
    }).setOrigin(0, 1);

    this._pwBg = this.add.rectangle(W / 2, pwY, 300, 32, 0x1a1a3e)
      .setStrokeStyle(2, 0x333355).setInteractive({ useHandCursor: true });
    this._pwBg.on('pointerdown', () => { this._activeField = 'password'; this._updateFields(); });

    this._pwText = this.add.text(W / 2, pwY, '', {
      fontSize: '16px', color: '#ffffff',
    }).setOrigin(0.5);

    // ── Status text ───────────────────────────────────────────────────────────
    this._statusText = this.add.text(W / 2, pwY + 28, '', {
      fontSize: '12px', color: '#ff6666',
    }).setOrigin(0.5);

    // ── Color picker (only shown in register mode) ────────────────────────────
    const colorY = pwY + 55;
    this._colorLabel = this.add.text(W / 2, colorY, 'Pick your chat color:', {
      fontSize: '11px', color: '#8899aa',
    }).setOrigin(0.5);

    const swatchSize = 22;
    const gap = 6;
    const totalW = COLOR_OPTIONS.length * (swatchSize + gap) - gap;
    const startX = W / 2 - totalW / 2 + swatchSize / 2;
    this._swatches = [];

    COLOR_OPTIONS.forEach((opt, i) => {
      const sx = startX + i * (swatchSize + gap);
      const sy = colorY + 22;
      const colorNum = parseInt(opt.hex.slice(1), 16);

      const swatch = this.add.rectangle(sx, sy, swatchSize, swatchSize, colorNum)
        .setInteractive({ useHandCursor: true })
        .setStrokeStyle(2, 0x222244);

      swatch.on('pointerdown', () => {
        this._selectedColor = opt.hex;
        this._updateSwatchSelection();
      });

      this._swatches.push({ swatch, hex: opt.hex });
    });
    this._updateSwatchSelection();

    // ── LLM model selector ────────────────────────────────────────────────────
    const modelY = colorY + 55;
    this._modelSectionLabel = this.add.text(W / 2, modelY, 'LLM Model (local Ollama):', {
      fontSize: '11px', color: '#8899aa',
    }).setOrigin(0.5);

    this._modelLabel = this.add.text(W / 2, modelY + 20, this._modelsFetched ? this._selectedModel : 'Loading models...', {
      fontSize: '13px', color: '#aaddff', backgroundColor: '#1a1a3e',
      padding: { x: 8, y: 4 },
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });

    this._modelLabel.on('pointerdown', () => {
      if (this._devMode) return; // server controls the model
      if (this._modelList.length === 0) return;
      this._modelIdx = (this._modelIdx + 1) % this._modelList.length;
      this._selectedModel = this._modelList[this._modelIdx];
      this._modelLabel.setText(this._selectedModel);
    });

    // ── Submit button ─────────────────────────────────────────────────────────
    const btnY = modelY + 55;
    this._submitBtn = this.add.text(W / 2, btnY, '', {
      fontSize: '16px', color: '#ffffff', backgroundColor: '#2244aa',
      padding: { x: 20, y: 8 },
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    this._submitBtn.on('pointerdown', () => this._submit());

    // Hint
    this.add.text(W / 2, btnY + 35, 'Press ENTER or TAB to switch fields', {
      fontSize: '10px', color: '#556677',
    }).setOrigin(0.5);

    // ── Reset game button ──────────────────────────────────────────────────────
    const resetBtn = this.add.text(W / 2, btnY + 65, 'RESET GAME', {
      fontSize: '11px', color: '#aa4444', backgroundColor: '#1a1a1a',
      padding: { x: 12, y: 4 },
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    resetBtn.on('pointerdown', () => this._resetGame());

    // Keyboard input
    this.input.keyboard.on('keydown', this._onKey, this);

    this._updateModeUI();
    this._updateFields();
  }

  _updateModeUI() {
    const isRegister = this._mode === 'register';
    this._modeLabel.setText(isRegister ? 'Create a new account' : 'Log in to your account');
    this._toggleBtn.setText(isRegister ? 'Already have an account? Log in' : 'New player? Create account');
    this._submitBtn.setText(isRegister ? 'CREATE ACCOUNT' : 'LOG IN');

    // Show/hide color picker (only for register)
    this._colorLabel.setVisible(isRegister);
    for (const { swatch } of this._swatches) swatch.setVisible(isRegister);

    this._statusText.setText('');
  }

  _updateFields() {
    const isUser = this._activeField === 'username';
    this._userBg.setStrokeStyle(2, isUser ? 0x4466aa : 0x333355);
    this._pwBg.setStrokeStyle(2, isUser ? 0x333355 : 0x4466aa);
    this._userText.setText(this._username + (isUser ? '|' : ''));
    this._pwText.setText('•'.repeat(this._password.length) + (isUser ? '' : '|'));
  }

  _updateSwatchSelection() {
    for (const { swatch, hex } of this._swatches) {
      swatch.setStrokeStyle(hex === this._selectedColor ? 3 : 2, hex === this._selectedColor ? 0xffffff : 0x222244);
    }
  }

  _onKey(event) {
    if (this._submitting) return;

    if (event.key === 'Tab') {
      event.preventDefault();
      this._activeField = this._activeField === 'username' ? 'password' : 'username';
      this._updateFields();
      return;
    }
    if (event.key === 'Enter') { this._submit(); return; }

    const isUser = this._activeField === 'username';

    if (event.key === 'Backspace') {
      if (isUser) this._username = this._username.slice(0, -1);
      else this._password = this._password.slice(0, -1);
      this._updateFields();
      return;
    }

    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      if (isUser) {
        if (/^[a-zA-Z0-9_]$/.test(event.key) && this._username.length < 20) {
          this._username += event.key;
        }
      } else {
        if (this._password.length < 50) {
          this._password += event.key;
        }
      }
      this._updateFields();
    }
  }

  async _submit() {
    const username = this._username.trim();
    const password = this._password;

    if (username.length < 2) {
      this._statusText.setText('Username must be at least 2 characters').setColor('#ff6666');
      return;
    }
    if (password.length < 3) {
      this._statusText.setText('Password must be at least 3 characters').setColor('#ff6666');
      return;
    }

    this._submitting = true;
    this._statusText.setText('Connecting...').setColor('#aaddff');

    const endpoint = this._mode === 'register' ? '/register' : '/login';
    const body = this._mode === 'register'
      ? { username, password, chat_color: this._selectedColor }
      : { username, password };

    try {
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!data.ok) {
        this._statusText.setText(data.error || 'Failed').setColor('#ff6666');
        this._submitting = false;
        return;
      }

      // Use server-saved model if available, otherwise use local selection
      const serverModel = data.player?.llm_model;
      const model = serverModel || this._selectedModel;

      // Save session for auto-login (including model choice)
      const chatColor = data.player?.chat_color || this._selectedColor;
      this._saveSession(username, password, chatColor, model);

      setModel(model);

      // Persist model choice to server (fire-and-forget)
      fetch(`${API_BASE}/set_model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, model: this._selectedModel }),
      }).catch(() => {});

      this.scene.start('GameScene', {
        username,
        isNew: data.is_new,
        savedPlayer: data.player,
        chatColor,
      });
    } catch (e) {
      this._statusText.setText('Server not reachable').setColor('#ff6666');
      this._submitting = false;
    }
  }

  async _resetGame() {
    if (this._resetting) return;
    // Confirm with user
    if (!window.confirm('Reset the entire game? All player stats, NPCs, items, and world state will be wiped. Accounts are kept.')) {
      return;
    }
    this._resetting = true;
    this._statusText.setText('Resetting game...').setColor('#ffaa44');

    try {
      const res = await fetch(`${API_BASE}/reset_game`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        this._clearSession();
        this._statusText.setText('Game reset! Reloading...').setColor('#66ff66');
        this.time.delayedCall(1000, () => window.location.reload());
      } else {
        this._statusText.setText('Reset failed').setColor('#ff6666');
        this._resetting = false;
      }
    } catch (e) {
      this._statusText.setText('Server not reachable').setColor('#ff6666');
      this._resetting = false;
    }
  }

  async _autoLogin(session) {
    const W = this.cameras.main.width;
    const H = this.cameras.main.height;

    this.add.rectangle(W / 2, H / 2, W, H, 0x0a0a1e);
    this.add.text(W / 2, H / 2 - 40, 'IRON ANACHRONISM', {
      fontSize: '36px', color: '#ffcc44', fontStyle: 'bold',
    }).setOrigin(0.5);
    const status = this.add.text(W / 2, H / 2 + 10, `Logging in as ${session.username}...`, {
      fontSize: '14px', color: '#aaddff',
    }).setOrigin(0.5);

    // Log out link
    const logout = this.add.text(W / 2, H / 2 + 40, 'Not you? Click here to log out', {
      fontSize: '11px', color: '#667788',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    logout.on('pointerdown', () => {
      this._clearSession();
      this.scene.restart();
    });

    try {
      const res = await fetch(`${API_BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: session.username, password: session.password }),
      });
      const data = await res.json();

      if (!data.ok) {
        // Saved credentials are bad — clear and show login form
        this._clearSession();
        status.setText('Session expired. Please log in.').setColor('#ff6666');
        this.time.delayedCall(1500, () => {
          this.scene.restart();
        });
        return;
      }

      // In dev mode, use server-forced model; otherwise use account-saved or session model
      try {
        const cfgRes = await fetch(`${API_BASE}/game_config`);
        const cfg = await cfgRes.json();
        if (cfg.dev_mode && cfg.forced_model) {
          this._selectedModel = cfg.forced_model;
          if (cfg.num_ctx) setNumCtx(cfg.num_ctx);
        } else {
          const serverModel = data.player?.llm_model;
          this._selectedModel = serverModel || session.model || this._selectedModel;
        }
      } catch {
        const serverModel = data.player?.llm_model;
        this._selectedModel = serverModel || session.model || this._selectedModel;
      }
      setModel(this._selectedModel);

      this.scene.start('GameScene', {
        username: session.username,
        isNew: false,
        savedPlayer: data.player,
        chatColor: session.chatColor || '#cccccc',
      });
    } catch (e) {
      status.setText('Server not reachable. Retrying...').setColor('#ff6666');
      this.time.delayedCall(3000, () => this._autoLogin(session));
    }
  }

  _saveSession(username, password, chatColor, model) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ username, password, chatColor, model }));
    } catch { /* ignore */ }
  }

  _loadSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (s.username && s.password) return s;
    } catch { /* ignore */ }
    return null;
  }

  _clearSession() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }
}
