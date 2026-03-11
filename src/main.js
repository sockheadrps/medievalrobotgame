import Phaser from 'phaser';
import LoginScene from './scenes/LoginScene.js';
import GameScene from './scenes/GameScene.js';

const HUD_SCALE = 0.7;
const TOP_HUD_MARGIN = Math.round(190 * HUD_SCALE);
const RIGHT_HUD_MARGIN = 360;
const MAP_VIEW_WIDTH = 1280;
const MAP_VIEW_HEIGHT = 960;

const config = {
  type: Phaser.AUTO,
  backgroundColor: '#1a1a2e',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: MAP_VIEW_WIDTH + RIGHT_HUD_MARGIN,
    height: MAP_VIEW_HEIGHT + TOP_HUD_MARGIN,
  },
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { y: 0 },
      debug: false
    }
  },
  scene: [LoginScene, GameScene]
};

new Phaser.Game(config);
