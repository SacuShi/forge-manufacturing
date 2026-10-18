'use strict';
// The AI advisor's saved conversation, per character.

const express = require('express');
const logger = require('../lib/logger');
const security = require('../forge-security');
const { dbAll, dbRun } = require('../lib/db');

const router = express.Router();

// CHAT HISTORY (Authenticated)

// Save chat message (authenticated)
// Note: verifyCharacterOwnership is intentionally omitted here — there is no :characterId
// route param, so it would always resolve NaN and return 403.  verifyEveToken is sufficient:
// the handler reads req.characterId from the token, not from the request body.
router.post('/api/save-message',
  security.apiLimiter,
  security.verifyEveToken,
  security.validateChatMessage,
  async (req, res) => {
    try {
      const { role, content, conversationId } = req.body;
      const characterId = req.characterId; // From verified token
      
      await dbRun(
        'INSERT INTO chat_history (character_id, role, content, conversation_id) VALUES (?, ?, ?, ?)',
        [characterId, role, content, conversationId || 'default']
      );
      
      res.json({ success: true });
    } catch (error) {
      logger.error('Save message error:', error);
      res.status(500).json({ error: 'Failed to save message' });
    }
  }
);

// Get chat history (authenticated, character must match token)
router.get('/api/chat-history/:characterId',
  security.apiLimiter,
  security.verifyEveToken,
  security.verifyCharacterOwnership,
  async (req, res) => {
    try {
      const characterId = req.characterId; // From verified token
      
      const messages = await dbAll(
        `SELECT role, content, timestamp 
         FROM chat_history 
         WHERE character_id = ? 
         ORDER BY timestamp DESC 
         LIMIT 200`,
        [characterId]
      );
      
      res.json(messages.reverse());
    } catch (error) {
      logger.error('Get history error:', error);
      res.status(500).json({ error: 'Failed to load history' });
    }
  }
);

// Clear chat history (authenticated)
router.delete('/api/chat-history/:characterId',
  security.apiLimiter,
  security.verifyEveToken,
  security.verifyCharacterOwnership,
  async (req, res) => {
    try {
      const characterId = req.characterId;

      await dbRun(
        'DELETE FROM chat_history WHERE character_id = ?',
        [characterId]
      );

      res.json({ success: true, message: 'Chat history cleared' });
    } catch (error) {
      logger.error('Clear history error:', error);
      res.status(500).json({ error: 'Failed to clear history' });
    }
  }
);

module.exports = router;
