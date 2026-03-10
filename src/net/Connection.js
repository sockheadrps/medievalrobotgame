// Connection.js — WebSocket client for multiplayer.
// Connects to the auxserver, sends player inputs, receives world state.

import { WS_URL } from '../config.js';

export class Connection {
  constructor(username, chatColor) {
    this.ws = null;
    this.myId = null;
    this.connected = false;
    this._username = username;
    this._chatColor = chatColor || '#cccccc';

    // Callbacks set by GameScene
    this.onWelcome = null;        // (data) => {}
    this.onState = null;          // (data) => {}
    this.onDisconnect = null;
    this.onError = null;          // (msg) => {}
    this.onChatIncoming = null;   // (data) => {}  — another player talks to our NPC
    this.onChatReply = null;      // (data) => {}  — reply from remote NPC we talked to

    // Input state — sent at fixed rate
    this._inputDirty = false;
    this._lastInput = { type: 'move', dx: 0, dy: 0, running: false };
    this._sendInterval = null;
  }

  connect() {
    this.ws = new WebSocket(WS_URL);

    this.ws.onopen = () => {
      console.log('[net] Connected, sending login...');
      // Send login message with username before anything else
      this.ws.send(JSON.stringify({ type: 'login', username: this._username, chatColor: this._chatColor }));
      this.connected = true;
      // Send input at 20Hz
      this._sendInterval = setInterval(() => this._flushInput(), 50);
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'welcome') {
          this.myId = data.your_id;
          console.log(`[net] Logged in as: ${this.myId}`);
          if (this.onWelcome) this.onWelcome(data);
        } else if (data.type === 'state') {
          if (this.onState) this.onState(data);
        } else if (data.type === 'chat_incoming') {
          if (this.onChatIncoming) this.onChatIncoming(data);
        } else if (data.type === 'chat_reply_incoming') {
          if (this.onChatReply) this.onChatReply(data);
        } else if (data.type === 'error') {
          console.error('[net] Server error:', data.message);
          if (this.onError) this.onError(data.message);
        }
      } catch (e) {
        console.warn('[net] Bad message:', e);
      }
    };

    this.ws.onclose = () => {
      console.log('[net] Disconnected');
      this.connected = false;
      if (this._sendInterval) clearInterval(this._sendInterval);
      if (this.onDisconnect) this.onDisconnect();
    };

    this.ws.onerror = (err) => {
      console.error('[net] WebSocket error:', err);
    };
  }

  /** Send movement input (called every frame by Player). */
  sendMove(dx, dy, running) {
    this._lastInput = { type: 'move', dx, dy, running };
    this._inputDirty = true;
  }

  /** Send a one-shot action. */
  send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  _flushInput() {
    if (!this._inputDirty || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(this._lastInput));
    this._inputDirty = false;
  }

  disconnect() {
    if (this._sendInterval) clearInterval(this._sendInterval);
    if (this.ws) this.ws.close();
  }
}
