import Phaser from 'phaser';
import { generateDialogue } from '../net/LLMClient.js';
import { TILE_SIZE } from '../constants.js';

export class DialogueController {
  constructor(scene) {
    this.scene = scene;
  }

  processOverheardConversation({ speakerNpc, playerText = '', npcReply = '', topicEntity = null, playerId = '' }) {
    if (!speakerNpc || !topicEntity?.id) return;
    const scene = this.scene;
    const overhearers = this.findOverhearTargets(speakerNpc, topicEntity);
    if (overhearers.length === 0) return;

    const sentiment = this.analyzeOverheardSentiment(playerText, npcReply, topicEntity.name || '');
    if (sentiment.kind === 'neutral') return;
    const transcript = `${playerId || 'Player'}: ${playerText} | ${speakerNpc.getName?.() || 'NPC'}: ${npcReply}`.slice(0, 180);

    for (const heard of overhearers) {
      if (heard.kind === 'local_npc') {
        const targetNpc = heard.entity;
        targetNpc.addMemory(`Overheard ${transcript}`, 'dialogue', playerId || 'default', sentiment.importance);
        targetNpc.applyEmotionDeltas(sentiment.playerDeltas, playerId || 'default');
        if (speakerNpc?.id && speakerNpc !== targetNpc) {
          targetNpc.applyEmotionDeltas(sentiment.npcDeltas, `npc:${speakerNpc.id}`);
        }
        if (Math.random() < sentiment.interjectChance) {
          this.maybeInterjectOverheardConversation({
            overhearer: targetNpc,
            speakerNpc,
            playerText,
            npcReply,
            topicEntity,
            playerId: playerId || 'default',
            sentiment,
          });
        } else if (Math.random() < sentiment.replyChance) {
          targetNpc.showBubble(sentiment.localBubble, 2600, { silent: true });
        }
      } else if (heard.kind === 'remote_npc' && Math.random() < sentiment.replyChance) {
        heard.entity.showBubble(sentiment.remoteBubble, 2400);
      }
    }
  }

  findOverhearTargets(speakerNpc, topicEntity) {
    const scene = this.scene;
    const results = [];
    const heardRange = TILE_SIZE * 10;
    const inRange = (ent) => Phaser.Math.Distance.Between(speakerNpc.x, speakerNpc.y, ent.x, ent.y) <= heardRange;

    if (topicEntity.type === 'npc') {
      const local = scene.npcs.find((n) => `npc:${n.id}` === topicEntity.id && n !== speakerNpc && !n.isDead?.());
      if (local && inRange(local)) results.push({ kind: 'local_npc', entity: local });
      const remote = Object.values(scene._remoteNPCSprites || {}).find((r) => `npc:${r.npcId}` === topicEntity.id && !r.isDead?.());
      if (remote && inRange(remote)) results.push({ kind: 'remote_npc', entity: remote });
    } else if (topicEntity.type === 'player') {
      for (const rnpc of Object.values(scene._remoteNPCSprites || {})) {
        if (rnpc.ownerPid === topicEntity.id && !rnpc.isDead?.() && inRange(rnpc)) {
          results.push({ kind: 'remote_npc', entity: rnpc });
        }
      }
      for (const npc of scene.npcs) {
        if (npc !== speakerNpc && !npc.isDead?.() && inRange(npc) && npc.soul?.relationships?.[topicEntity.id]) {
          results.push({ kind: 'local_npc', entity: npc });
        }
      }
    }
    return results;
  }

  async maybeInterjectOverheardConversation({
    overhearer,
    speakerNpc,
    playerText,
    npcReply,
    topicEntity,
    playerId,
    sentiment,
  }) {
    const scene = this.scene;
    if (!overhearer || overhearer.isDead?.()) return;
    const key = `${overhearer.id}|${topicEntity.id}|${playerId}`;
    const now = Date.now();
    const last = scene._overhearInterjectCooldowns[key] ?? 0;
    if (now - last < 15000) return;
    scene._overhearInterjectCooldowns[key] = now;

    try {
      const soulCtx = overhearer.getSoulContext(playerId || 'default');
      soulCtx.nearby_entities = scene.chatBox?._buildNearbyContext(overhearer) || [];
      soulCtx.topic_entity = overhearer.getContextAboutEntity(topicEntity.id, topicEntity.name);
      soulCtx.system_note = [
        `You overheard ${playerId} talking with ${speakerNpc.getName?.() || 'another NPC'} about ${topicEntity.name}.`,
        'Give a single short interjection into the conversation.',
        'Keep it under 10 words.',
        'Do not describe actions or explain yourself.',
        'Only speak as the overhearing NPC.',
      ].join(' ');

      const prompt = `Overheard conversation:\n${playerId}: ${playerText}\n${speakerNpc.getName?.() || 'NPC'}: ${npcReply}\n\nInterject briefly.`;
      const data = await generateDialogue(soulCtx, prompt, {
        speakingPlayer: playerId || 'default',
        owner: scene.playerId || 'default',
      });

      const line = (data?.dialogue || '').trim();
      if (!line || line === '...') return;
      const actual = data.emotion_deltas ? overhearer.applyEmotionDeltas(data.emotion_deltas, playerId || 'default') : null;
      const deltaStr = scene._formatDeltas(actual);
      const bubbleText = deltaStr ? `${line}\n${deltaStr}` : line;
      overhearer.showBubble(bubbleText, deltaStr ? 7000 : 4500, { silent: true });
      scene.chatBox?._addLog(`${overhearer.getName()}: ${line}`, '#ffccaa');
      overhearer.addMemory(
        `I interrupted after overhearing talk about ${topicEntity.name}: "${line}"`,
        'dialogue',
        playerId || 'default',
        Math.min(0.9, sentiment.importance + 0.08),
      );
    } catch {
      overhearer.showBubble(sentiment.localBubble, 2200, { silent: true });
    }
  }

  analyzeOverheardSentiment(playerText, npcReply, topicName) {
    const text = `${playerText} ${npcReply}`.toLowerCase();
    const escapedName = String(topicName || '').toLowerCase();
    const directlyNamed = escapedName && text.includes(escapedName);
    if (!directlyNamed) return { kind: 'neutral' };

    const threat = /\b(kill|attack|hurt|smash|destroy|beat|rob|steal from)\b/i.test(text);
    const negative = /\b(hate|stupid|idiot|dumb|loser|trash|clanker|jerk|sucks?|thief|coward)\b/i.test(text) || threat;
    const positive = /\b(friend|ally|trust|like|good|nice|helpful|kind|brave|cool|best|loyal)\b/i.test(text);

    if (negative) {
      return {
        kind: 'negative',
        importance: threat ? 0.85 : 0.72,
        playerDeltas: { trust: -0.05, anger: 0.06, fear: threat ? 0.04 : 0.01 },
        npcDeltas: { trust: -0.02, anger: 0.03 },
        replyChance: threat ? 0.8 : 0.55,
        interjectChance: threat ? 0.45 : 0.25,
        localBubble: threat ? 'I heard that.' : 'Watch your mouth.',
        remoteBubble: threat ? 'Back off.' : 'I heard that.',
      };
    }
    if (positive) {
      return {
        kind: 'positive',
        importance: 0.62,
        playerDeltas: { trust: 0.04, anger: -0.02, fear: 0 },
        npcDeltas: { trust: 0.02, anger: -0.01 },
        replyChance: 0.35,
        interjectChance: 0.15,
        localBubble: 'Heh. Good.',
        remoteBubble: '...Noted.',
      };
    }
    return { kind: 'neutral' };
  }

  tryExecuteCoercedCommand(npc, text, fromPlayerId) {
    const scene = this.scene;
    const runner = scene._taskRunners.get(npc.id);
    if (!runner) return;
    const lower = text.toLowerCase();

    if (/\b(give|hand|drop|surrender)\b.*\b(log|wood|stuff|inventory|item|everything)\b/i.test(lower) ||
        /\b(give|hand\s+over|drop)\b.*\b(me|here)\b/i.test(lower)) {
      const logCount = npc.logs;
      if (logCount > 0) {
        npc.logs = 0;
        const conn = scene._conn;
        if (conn?.connected) {
          conn.send({ type: 'admin', field: 'logs', value: -logCount });
          conn.send({ type: 'drop_item', item: 'log', amount: logCount, x: npc.x, y: npc.y });
        }
        npc.showBubble(`F-fine! Take them! (dropped ${logCount} log${logCount > 1 ? 's' : ''})`, 5000, { silent: true });
        scene.chatBox?._addLog(`${npc.getName()} dropped ${logCount} log${logCount > 1 ? 's' : ''} out of fear of ${fromPlayerId}!`, '#ff8866');
        scene._conn?.send({
          type: 'chat_reply',
          to: fromPlayerId,
          npc_id: npc.id,
          npc_name: npc.getName(),
          reply: `*trembling* F-fine! Here! (dropped ${logCount} log${logCount > 1 ? 's' : ''})`,
          emotion_deltas: null,
        });
      } else {
        npc.showBubble('I don\'t have any logs!', 3000, { silent: true });
        scene._conn?.send({
          type: 'chat_reply',
          to: fromPlayerId,
          npc_id: npc.id,
          npc_name: npc.getName(),
          reply: 'I-I don\'t have anything! Please don\'t hurt me!',
          emotion_deltas: null,
        });
      }
      runner.setTasks([{ task: 'idle' }]);
      return;
    }
    if (/\b(stop|stay|wait|don't move|freeze)\b/i.test(lower)) {
      runner.setTasks([{ task: 'idle' }]);
      npc.showBubble('O-okay! I won\'t move!', 3000, { silent: true });
      scene.chatBox?._addLog(`${npc.getName()} froze in fear of ${fromPlayerId}`, '#ff8866');
      return;
    }
    if (/\b(follow|come\s+with|come\s+here)\b/i.test(lower)) {
      runner.setTasks([{ task: 'idle' }]);
      npc.showBubble('I-I can\'t leave my post...', 3000, { silent: true });
    }
  }
}
