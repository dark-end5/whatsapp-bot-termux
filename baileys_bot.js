const makeWASocket = require('@adiwajshing/baileys').default;
const { useSingleFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@adiwajshing/baileys');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
require('dotenv').config();

const { state, saveState } = useSingleFileAuthState('./auth_state.json');

// --- Command system configuration ---
const PAGE_SIZE = 10; // commands per menu page

// Generate ~80 placeholder commands (cmd1..cmd80) with descriptions
const commands = [];
for (let i = 1; i <= 80; i++) {
  const name = `cmd${i}`;
  commands.push({
    name,
    description: `Placeholder command #${i} — performs a mock action.`,
    category: (i <= 20) ? 'general' : (i <= 40) ? 'session' : (i <= 60) ? 'utility' : 'extra',
    handler: async (sock, jid, args) => {
      // Example handler: reply with a mock result
      await sendText(sock, jid, `Executed ${name} (mock). Args: ${args.join(' ')}`);
    }
  });
}

// Add a few named helpful commands (menu/help/ping)
commands.push({
  name: 'menu',
  description: 'Show the commands menu. Usage: "menu" or "menu 2"',
  category: 'help',
  handler: async (sock, jid, args) => {
    const page = Math.max(1, parseInt(args[0]) || 1);
    await sendMenuPage(sock, jid, page);
  }
});
commands.push({
  name: 'help',
  description: 'Show help for a command. Usage: "help cmd42"',
  category: 'help',
  handler: async (sock, jid, args) => {
    const target = args[0];
    if (!target) return sendText(sock, jid, 'Usage: help <command_name>');
    const cmd = commands.find(c => c.name.toLowerCase() === target.toLowerCase());
    if (!cmd) return sendText(sock, jid, `Command not found: ${target}`);
    return sendText(sock, jid, `*${cmd.name}*\nCategory: ${cmd.category}\n${cmd.description}`);
  }
});
commands.push({
  name: 'ping',
  description: 'Check bot responsiveness',
  category: 'help',
  handler: async (sock, jid, args) => {
    return sendText(sock, jid, 'PONG');
  }
});

// Helper: find command by message text
function findCommand(word) {
  if (!word) return null;
  const w = word.replace(/^\/+|^!+/, '').toLowerCase();
  return commands.find(c => c.name.toLowerCase() === w);
}

async function sendMenuPage(sock, jid, page = 1) {
  const total = commands.length;
  const pages = Math.ceil(total / PAGE_SIZE);
  const p = Math.min(Math.max(1, page), pages);
  const start = (p - 1) * PAGE_SIZE;
  const slice = commands.slice(start, start + PAGE_SIZE);

  let text = `Commands (page ${p}/${pages})\n`;
  text += '-----------------------------\n';
  for (const cmd of slice) {
    text += `*${cmd.name}* — ${cmd.description}\n`;
  }
  text += '\nSend "menu <n>" to view another page. Send "help <command>" for details.';
  await sendText(sock, jid, text);
}

// ---------------- Baileys bot core ----------------
async function startSock() {
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log('using WA version', version, 'isLatest?', isLatest);

  const sock = makeWASocket({ auth: state, version });

  sock.ev.on('creds.update', saveState);

  sock.ev.on('connection.update', (update) => {
    if (update.qr) {
      console.log('QR RECEIVED, scan with WhatsApp app:');
      qrcode.generate(update.qr, { small: true });
    }
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect && lastDisconnect.error && lastDisconnect.error.output) ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
      console.log('connection closed due to', lastDisconnect?.error?.toString(), ', reconnecting', shouldReconnect);
      if (shouldReconnect) startSock();
    } else if (connection === 'open') {
      console.log('connected');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
    const msg = m.messages[0];
    if (!msg.message) return;
    if (msg.key && msg.key.remoteJid === 'status@broadcast') return; // ignore status updates

    const from = msg.key.remoteJid; // includes @s.whatsapp.net
    const isGroup = from.endsWith('@g.us');
    if (isGroup) return; // ignore groups for this bot

    // Extract text body from different possible message types
    const messageContent =
      (msg.message.conversation) ||
      (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) ||
      (msg.message.imageMessage && msg.message.imageMessage.caption) ||
      '';

    const text = messageContent.trim();
    if (!text) return;

    // Command parsing: allow prefixes / or !, or bare command words like 'menu' or 'cmd1'
    const parts = text.split(/\s+/);
    const first = parts[0];
    const args = parts.slice(1);

    // Check for explicit commands first
    let cmd = null;
    if (first.startsWith('/') || first.startsWith('!')) {
      cmd = findCommand(first);
    } else {
      // also accept bare command names
      cmd = findCommand(first);
    }

    if (cmd) {
      try {
        await cmd.handler(sock, from, args);
      } catch (e) {
        console.error('Command handler error', e);
        await sendText(sock, from, 'Command failed with error.');
      }
      return;
    }

    // If not a command, fallback to pair-code extraction: "PAIR 1234" or just "1234"
    const codeMatch = text.match(/(?:PAIR\s*)?([0-9A-Za-z\-]{3,})/i);
    if (codeMatch) {
      const code = codeMatch[1];
      // call mock pairing backend
      const PAIR_API = (process.env.PAIR_API_URL || 'http://localhost:4000').replace(/\/$/, '');
      try {
        const resp = await axios.post(`${PAIR_API}/verify`, { code, phone: from }, { timeout: 5000 });
        if (resp.data && resp.data.success) {
          const peer = resp.data.peer || 'your partner';
          const connectUrl = resp.data.connectUrl;
          const reply = connectUrl ? `Pairing succeeded! You're connected with ${peer}. Join here: ${connectUrl}` : `Pairing succeeded! You're connected with ${peer}.`;
          await sendText(sock, from, reply);
        } else {
          const reason = (resp.data && resp.data.message) || 'Invalid or expired code.';
          await sendText(sock, from, `Pairing failed: ${reason}`);
        }
      } catch (err) {
        console.error('Error calling pair backend', err?.response?.data || err.message || err);
        await sendText(sock, from, 'Pairing service is unavailable. Please try again later.');
      }
      return;
    }

    // Unrecognized: show short help hint
    await sendText(sock, from, 'I did not understand. Send "menu" to see available commands or send your PAIR code.');
  });
}

async function sendText(sock, jid, text) {
  try {
    await sock.sendMessage(jid, { text });
  } catch (err) {
    console.error('sendText error', err?.toString());
  }
}

startSock().catch((e) => console.error('Baileys start failed', e));
