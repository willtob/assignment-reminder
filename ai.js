// Answers free-form questions ("what's my grade in finance?") with OpenAI + moodle-mcp.
//
// How it works:
//   1. moodle-mcp (~/moodle-mcp/server.js) runs in the background as a child process.
//      We talk to it the way Claude does: one JSON message per line on its stdin/stdout ("MCP over stdio").
//   2. We send your question to OpenAI together with the list of Moodle tools.
//   3. If OpenAI asks for a tool (e.g. get_grades), we run it in moodle-mcp and send back the result.
//      This repeats until OpenAI answers in plain text, which bot.js sends to you on WhatsApp.

const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TIMEZONE } = require('./moodle');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_ROUNDS = 6;               // most tool-call rounds per question, so a confused model can't loop forever
const MAX_TOOL_RESULT = 20000;      // characters of each tool result sent to OpenAI (big course pages cost money)
const REMEMBERED_TURNS = 10;        // how many of your last messages + replies the AI remembers
const MCP_TIMEOUT_MS = 60000;       // give up on a Moodle tool after 60 seconds

// Tools we don't give the AI: they save files onto the computer running the bot,
// which is no use on WhatsApp.
const BLOCKED_TOOLS = ['get_file', 'download_course_files'];

// Settings (see config.example.json)
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const OPENAI_API_KEY = config.openai_api_key;
const OPENAI_MODEL = config.openai_model || 'gpt-5-mini';
const MOODLE_MCP_PATH = config.moodle_mcp_path || path.join(os.homedir(), 'moodle-mcp', 'server.js');

// The conversation so far: your messages and the AI's final answers (not the tool calls in between)
let conversation = [];


// ---------- moodle-mcp (MCP over stdio) ----------

let mcpProcess = null;              // the running moodle-mcp, or null if it isn't started yet
let mcpInstructions = '';           // moodle-mcp's own tips for using its tools
let mcpTools = [];                  // the tools moodle-mcp offers, already converted to OpenAI's format
let nextRequestId = 1;
const waitingRequests = new Map();  // request id -> { resolve, reject, timer } for requests not answered yet

// Sends one JSON-RPC request to moodle-mcp and waits for the answer with the same id
function mcpRequest(method, params) {
  const id = nextRequestId;
  nextRequestId = nextRequestId + 1;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waitingRequests.delete(id);
      reject(new Error('moodle-mcp took too long to answer ' + method));
    }, MCP_TIMEOUT_MS);
    waitingRequests.set(id, { resolve, reject, timer });
    mcpProcess.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params }) + '\n');
  });
}

// Starts moodle-mcp (only the first time, or again if it crashed) and asks it for its tools
async function startMoodleMcp() {
  if (mcpProcess) {
    return;
  }
  if (!fs.existsSync(MOODLE_MCP_PATH)) {
    throw new Error('moodle-mcp not found at ' + MOODLE_MCP_PATH + ' (set moodle_mcp_path in config.json)');
  }

  // stdin/stdout are piped to us; its error output goes straight to the terminal
  mcpProcess = spawn(process.execPath, [MOODLE_MCP_PATH], { stdio: ['pipe', 'pipe', 'inherit'] });

  // Every line moodle-mcp prints is one JSON answer. Hand it to whoever is waiting for that id.
  readline.createInterface({ input: mcpProcess.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      return; // not JSON, ignore it
    }
    const waiting = waitingRequests.get(message.id);
    if (!waiting) {
      return;
    }
    waitingRequests.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error) {
      waiting.reject(new Error('moodle-mcp: ' + message.error.message));
    } else {
      waiting.resolve(message.result);
    }
  });

  // If it stops, fail anything still waiting. The next question starts it again.
  mcpProcess.on('exit', (code) => {
    console.error('moodle-mcp stopped (exit code ' + code + ')');
    mcpProcess = null;
    for (const waiting of waitingRequests.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error('moodle-mcp stopped'));
    }
    waitingRequests.clear();
  });

  // The MCP handshake: "initialize", then "initialized", then we can ask for tools
  const info = await mcpRequest('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'whatsapp-bot', version: '1.0.0' },
  });
  mcpInstructions = info.instructions || '';
  mcpProcess.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const toolList = await mcpRequest('tools/list', {});
  mcpTools = [];
  for (const tool of toolList.tools) {
    if (BLOCKED_TOOLS.includes(tool.name)) {
      continue;
    }
    // MCP and OpenAI describe tools almost the same way; only the wrapping differs
    mcpTools.push({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    });
  }
  console.log('moodle-mcp started with ' + mcpTools.length + ' tools');
}

// Runs one moodle-mcp tool and returns its text output
async function callMoodleTool(name, args) {
  if (BLOCKED_TOOLS.includes(name)) {
    return 'Error: the tool ' + name + ' is not available here.';
  }
  const result = await mcpRequest('tools/call', { name: name, arguments: args });
  let text = '';
  for (const part of result.content || []) {
    if (part.type === 'text') {
      text = text + part.text;
    }
  }
  if (text.length > MAX_TOOL_RESULT) {
    text = text.slice(0, MAX_TOOL_RESULT) + '\n[... cut off, too long]';
  }
  return text;
}


// ---------- OpenAI ----------

function systemPrompt() {
  const now = new Date().toLocaleString('en-GB', { timeZone: TIMEZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return 'You are a WhatsApp assistant for a university student at ESADE. ' +
    'You can read their Moodle (eCampus) with the tools you are given; you cannot change anything in it. ' +
    'Always look things up with the tools instead of guessing. If the tools do not have the answer, say so. ' +
    'When asked what is due, always set include_overdue to true and mention overdue work first.\n\n' +
    'It is now ' + now + ' (' + TIMEZONE + ' time).\n\n' +
    'Write for a phone screen: short answers, a few lines, no tables and no headings. ' +
    'Use WhatsApp formatting only: *bold*, _italic_, and "• " for lists. Never use Markdown like **bold** or # headings. ' +
    'Include a Moodle link when it is useful.\n\n' +
    'Tips from the Moodle tools: ' + mcpInstructions;
}

// Sends the messages to OpenAI and returns its reply message (text, or a request to call tools)
async function callOpenAI(messages) {
  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OPENAI_MODEL, messages: messages, tools: mcpTools }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error('OpenAI error: ' + ((data.error && data.error.message) || JSON.stringify(data)));
  }
  return data.choices[0].message;
}

// Answers one question. Returns the text to send back on WhatsApp.
async function askAI(question) {
  if (!OPENAI_API_KEY) {
    throw new Error('openai_api_key is missing in config.json');
  }
  await startMoodleMcp();

  // What we send: instructions, the remembered conversation, then the new question
  const messages = [{ role: 'system', content: systemPrompt() }];
  for (const turn of conversation) {
    messages.push(turn);
  }
  messages.push({ role: 'user', content: question });

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const reply = await callOpenAI(messages);
    messages.push(reply);

    // No tool calls means this is the final answer
    if (!reply.tool_calls || reply.tool_calls.length === 0) {
      const answer = reply.content || '(no answer)';
      conversation.push({ role: 'user', content: question });
      conversation.push({ role: 'assistant', content: answer });
      // Keep only the last few turns (each turn is 2 messages: yours and the reply)
      if (conversation.length > REMEMBERED_TURNS * 2) {
        conversation = conversation.slice(conversation.length - REMEMBERED_TURNS * 2);
      }
      return answer;
    }

    // Run every tool OpenAI asked for and give it the results
    for (const toolCall of reply.tool_calls) {
      const name = toolCall.function.name;
      let args = {};
      try {
        args = JSON.parse(toolCall.function.arguments || '{}');
      } catch (error) {
        // leave args empty; the tool will say what's missing
      }
      console.log('  tool: ' + name + ' ' + JSON.stringify(args));

      let result;
      try {
        result = await callMoodleTool(name, args);
      } catch (error) {
        result = 'Error: ' + error.message;
      }
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
    }
  }

  return 'Sorry, that took too many steps. Try asking in a more specific way.';
}

// Forgets the conversation (the "reset" command)
function resetConversation() {
  conversation = [];
}

// Stops moodle-mcp so a --test run can exit
function stopMoodleMcp() {
  if (mcpProcess) {
    mcpProcess.removeAllListeners('exit'); // we're stopping it on purpose, so don't warn
    mcpProcess.kill();
    mcpProcess = null;
  }
}

module.exports = { askAI, resetConversation, stopMoodleMcp };
