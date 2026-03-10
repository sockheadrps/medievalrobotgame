// config.js — Runtime configuration for API/WS endpoints.
// In production, uses the current hostname. In dev, falls back to localhost.

const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

export const API_BASE = isDev
  ? 'http://127.0.0.1:8001'
  : `${window.location.protocol}//${window.location.host}`;

export const WS_URL = isDev
  ? 'ws://127.0.0.1:8001/ws'
  : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

export const OLLAMA_URL = isDev
  ? 'http://localhost:11434'
  : `${window.location.protocol}//${window.location.host}/ollama`;
