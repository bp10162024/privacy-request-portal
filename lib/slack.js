const axios = require('axios');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_PRIVACY_CHANNEL_ID = process.env.SLACK_PRIVACY_CHANNEL_ID;

async function postMessage(text, blocks = null) {
  if (!SLACK_BOT_TOKEN || !SLACK_PRIVACY_CHANNEL_ID) {
    console.log('[Slack] skipped (no token/channel configured):', text);
    return;
  }
  try {
    const body = { channel: SLACK_PRIVACY_CHANNEL_ID, text };
    if (blocks) body.blocks = blocks;
    await axios.post('https://slack.com/api/chat.postMessage', body, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    });
  } catch (err) {
    console.error('[Slack] post failed:', err.response?.data || err.message);
  }
}

module.exports = { postMessage };
