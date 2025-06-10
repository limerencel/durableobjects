import { DurableObject } from "cloudflare:workers";

export class ChatRoom implements DurableObject {
  state: DurableObjectState;
  env: Env;
  sessions: WebSocket[] = [];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader != "websocket") {
      return new Response("Expected a Websoket upgrade request", {
        status: 426,
      });
    }

    const [client, server] = Object.values(new WebSocketPair());
    await this.handleSession(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async handleSession(webSocket: WebSocket) {
    this.sessions.push(webSocket);
    webSocket.accept();
    webSocket.addEventListener("message", async (msg) => {
      console.log(`Received message: ${msg.data}`);
      await this.state.storage.put(`message: ${Date.now()}`, msg.data);
      this.broadcast(msg.data as string);
    });

    webSocket.addEventListener("close", (event) => {
      console.log(
        `Session closed. Code: ${event.code}, Reason: ${event.reason}`
      );
      this.sessions = this.sessions.filter((session) => session != webSocket);
      this.broadcast(`A user has left the room.`);
    });

    webSocket.addEventListener("error", (error) => {
      console.error("Websoket error: ", error);
    });
  }

  broadcast(message: string) {
    const formattedMessage = `[${new Date().toLocaleDateString()}] ${message}`;
    this.sessions.forEach((session) => {
      try {
        session.send(formattedMessage);
      } catch (error) {
        console.error("Failed to send messages to a session:", error);
        this.sessions = this.sessions.filter((s) => s !== session);
      }
    });
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Path 1: Root path "/"
    if (url.pathname == "/") {
      // Returns the HTML frontend
      return new Response(minimalisticFrontend, {
        headers: { "Content-type": "text/html" },
      });
    }

    // Path 2: Websocket path "/room/..."
    if (url.pathname.startsWith("/room/")) {
      const roomName = url.pathname.split("/")[2];
      if (!roomName) {
        return new Response("Please specify a room name. e.g., /room/my-rom", {
          status: 400,
        });
      }
      // create Durable Object and stub
      const id = env.CHAT_ROOM.idFromName(roomName);
      const stub = env.CHAT_ROOM.get(id);
      // forward websocket request to Durable Object
      return stub.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

const minimalisticFrontend = `
<!DOCTYPE html>
<html>
<head>
  <title>DO Chat</title>
  <style>
    body { font-family: sans-serif; display: flex; flex-direction: column; height: 95vh; }
    #messages { flex-grow: 1; border: 1px solid #ccc; padding: 10px; margin-bottom: 10px; overflow-y: scroll; }
    #form { display: flex; }
    #input { flex-grow: 1; padding: 5px; }
    button { padding: 5px; }
    .message { margin-bottom: 5px; }
    .server-message { color: gray; font-style: italic; }
  </style>
</head>
<body>
  <h1>Durable Object WebSocket Chat</h1>
  <p>Room: <b id="room-name"></b></p>
  <div id="messages"></div>
  <form id="form" action="">
    <input id="input" autocomplete="off" /><button>Send</button>
  </form>

  <script>
    const messages = document.getElementById('messages');
    const form = document.getElementById('form');
    const input = document.getElementById('input');
    const roomNameEl = document.getElementById('room-name');

    // 让用户输入房间名
    let roomName = prompt("Enter a room name:", "general");
    if (!roomName) roomName = "default";
    roomNameEl.textContent = roomName;

    // 根据当前协议 (http/https) 和域名，构建 WebSocket URL (ws/wss)
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = \`\${wsProtocol}//\${window.location.host}/room/\${roomName}\`;
    
    const ws = new WebSocket(wsUrl);

    function addMessage(content, type = 'message') {
      const item = document.createElement('div');
      item.className = type;
      item.textContent = content;
      messages.appendChild(item);
      messages.scrollTop = messages.scrollHeight; // 自动滚动到底部
    }

    ws.onopen = (event) => {
      addMessage('Connected to the chat room!', 'server-message');
    };

    ws.onmessage = (event) => {
      addMessage(event.data);
    };

    ws.onclose = (event) => {
      addMessage(\`Disconnected. Code: \${event.code}, Reason: \${event.reason}\`, 'server-message');
    };

    ws.onerror = (error) => {
      addMessage('An error occurred!', 'server-message');
      console.error('WebSocket Error:', error);
    };

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (input.value) {
        ws.send(input.value);
        addMessage(\`You: \${input.value}\`); // 本地回显
        input.value = '';
      }
    });
  </script>
</body>
</html>
`;
