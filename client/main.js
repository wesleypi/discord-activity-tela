import './style.css';
import { DiscordSDK } from '@discord/embedded-app-sdk';

// Dentro do Discord a página recebe ?frame_id=...&instance_id=...
// Fora dele (navegador comum) rodamos em modo "standalone" para testes locais.
const params = new URLSearchParams(location.search);
const inDiscord = params.has('frame_id');

// O proxy do Discord não suporta WebRTC, só WebSocket. Por isso a tela é
// gravada em pedaços (MediaRecorder) e repassada pelo servidor via WebSocket.
const MIME_CANDIDATES = [
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp8',
  'video/webm',
];
const CHUNK_MS = 250;
const MAX_LATENCY_S = 1.5;

const state = {
  me: { id: crypto.randomUUID(), name: 'local-' + Math.floor(Math.random() * 1000) },
  room: params.get('room') || 'local',
  ws: null,
  peers: new Map(), // id -> { name }
  sharerId: null,
  // Quem compartilha
  localStream: null,
  recorder: null,
  generation: 0,
  // Quem assiste
  player: null, // { mediaSource, sourceBuffer, queue }
  bytesReceived: 0,
};

document.querySelector('#app').innerHTML = `
  <h1>Teste de compartilhamento de tela</h1>
  <p class="mode"></p>
  <div class="buttons">
    <button id="share">Compartilhar tela</button>
    <button id="stop" disabled>Parar</button>
    <button id="copy">Copiar log</button>
  </div>
  <video id="video" autoplay playsinline muted controls></video>
  <p id="stats"></p>
  <h2>Participantes</h2>
  <ul id="peers"></ul>
  <h2>Diagnóstico</h2>
  <pre id="log"></pre>
`;

const $ = (sel) => document.querySelector(sel);
const video = $('#video');

function log(msg, level = 'info') {
  const line = `[${new Date().toLocaleTimeString()}] ${level === 'error' ? 'ERRO ' : level === 'ok' ? 'OK   ' : ''}${msg}`;
  $('#log').textContent += line + '\n';
  console[level === 'error' ? 'error' : 'log'](line);
}

function renderPeers() {
  const items = [...state.peers.entries()].map(([id, p]) => {
    const sharing = id === state.sharerId ? ' [compartilhando]' : '';
    return `<li>${escapeHtml(p.name)}${sharing}</li>`;
  });
  $('#peers').innerHTML = items.join('') || '<li>(ninguém além de você)</li>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---------- Diagnóstico do ambiente ----------

function runDiagnostics() {
  log(`Modo: ${inDiscord ? 'dentro do Discord' : 'standalone (fora do Discord)'}`);
  log(`Origem: ${location.origin}`);
  log(`User agent: ${navigator.userAgent}`);
  log(`Electron (app desktop): ${/Electron/i.test(navigator.userAgent) ? 'sim' : 'não'}`);
  log(`Dentro de iframe: ${window.self !== window.top ? 'sim' : 'não'}`);
  log(`Contexto seguro (HTTPS): ${window.isSecureContext ? 'sim' : 'não'}`);
  log(`navigator.mediaDevices.getDisplayMedia existe: ${typeof navigator.mediaDevices?.getDisplayMedia === 'function' ? 'sim' : 'não'}`);
  log(`MediaRecorder existe: ${typeof MediaRecorder === 'function' ? 'sim' : 'não'}`);
  log(`MediaSource existe: ${typeof MediaSource === 'function' ? 'sim' : 'não'}`);
  log(`Formato de gravação: ${pickMime() ?? 'nenhum suportado'}`);

  // Permissions Policy do iframe (só Chromium expõe essa API)
  const policy = document.permissionsPolicy || document.featurePolicy;
  if (policy?.allowsFeature) {
    for (const feature of ['display-capture', 'camera', 'microphone', 'autoplay']) {
      log(`Permissions Policy "${feature}": ${policy.allowsFeature(feature) ? 'permitido' : 'BLOQUEADO'}`);
    }
  } else {
    log('Permissions Policy: API não disponível neste navegador');
  }
}

function pickMime() {
  if (typeof MediaRecorder !== 'function') return null;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

// ---------- Discord SDK ----------

async function setupDiscord() {
  const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID;
  const discordSdk = new DiscordSDK(clientId);
  await discordSdk.ready();
  log('Discord SDK pronto', 'ok');
  log(`Plataforma: ${discordSdk.platform}, instanceId: ${discordSdk.instanceId}`);

  const { code } = await discordSdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify'],
  });

  const res = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const { access_token } = await res.json();
  const auth = await discordSdk.commands.authenticate({ access_token });
  log(`Autenticado como ${auth.user.username}`, 'ok');

  state.me.name = auth.user.global_name || auth.user.username;
  // Todos que estão na mesma instância da Activity caem na mesma sala
  state.room = discordSdk.instanceId;
}

// ---------- WebSocket ----------

function connectSocket() {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const qs = new URLSearchParams({ room: state.room, id: state.me.id, name: state.me.name });
    const ws = new WebSocket(`${proto}//${location.host}/api/ws?${qs}`);
    ws.binaryType = 'arraybuffer';
    state.ws = ws;

    ws.onopen = () => {
      log(`WebSocket conectado (sala ${state.room})`, 'ok');
      resolve();
    };
    ws.onerror = () => {
      log('Falha no WebSocket', 'error');
      reject(new Error('ws error'));
    };
    ws.onclose = () => log('WebSocket fechado', 'error');
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) handleChunk(ev.data);
      else handleMessage(JSON.parse(ev.data));
    };
  });
}

function send(msg) {
  state.ws?.readyState === WebSocket.OPEN && state.ws.send(JSON.stringify(msg));
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'peers':
      for (const p of msg.peers) state.peers.set(p.id, { name: p.name });
      state.sharerId = msg.sharerId;
      break;
    case 'peer-joined':
      state.peers.set(msg.id, { name: msg.name });
      log(`${msg.name} entrou`);
      // Quem chega precisa do cabeçalho do vídeo: reinicia a gravação
      if (state.localStream) startRecorder();
      break;
    case 'peer-left':
      log(`${state.peers.get(msg.id)?.name ?? msg.id} saiu`);
      state.peers.delete(msg.id);
      if (state.sharerId === msg.id) stopPlayer();
      break;
    case 'stream-start':
      // Só uma pessoa transmite por vez: quem começa por último assume
      if (state.localStream) stopShare();
      state.sharerId = msg.id;
      startPlayer(msg.mime);
      break;
    case 'stream-stop':
      if (state.sharerId === msg.id) state.sharerId = null;
      stopPlayer();
      break;
  }
  renderPeers();
}

// ---------- Quem compartilha ----------

async function startShare() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    log('getDisplayMedia não existe neste ambiente', 'error');
    return;
  }
  const mime = pickMime();
  if (!mime) {
    log('Este ambiente não grava vídeo WebM (MediaRecorder)', 'error');
    return;
  }
  try {
    log('Chamando getDisplayMedia...');
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    const [vt] = stream.getVideoTracks();
    const settings = vt.getSettings();
    log(`Captura OK: ${vt.label || '(sem rótulo)'} ${settings.width}x${settings.height}, áudio: ${stream.getAudioTracks().length > 0 ? 'sim' : 'não'}`, 'ok');

    stopPlayer();
    state.localStream = stream;
    video.srcObject = stream;
    vt.onended = stopShare;
    $('#share').disabled = true;
    $('#stop').disabled = false;
    startRecorder();
  } catch (err) {
    log(`getDisplayMedia falhou: ${err.name}: ${err.message}`, 'error');
    if (err.name === 'NotAllowedError') {
      log('NotAllowedError = o iframe/app bloqueou a captura ou você cancelou o seletor');
    } else if (err.name === 'NotSupportedError') {
      log('NotSupportedError = o ambiente (ex.: Electron sem handler) não suporta captura');
    }
  }
}

function startRecorder() {
  const generation = ++state.generation;
  if (state.recorder?.state === 'recording') state.recorder.stop();

  const mime = pickMime();
  const recorder = new MediaRecorder(state.localStream, {
    mimeType: mime,
    videoBitsPerSecond: 2_500_000,
  });
  state.recorder = recorder;

  // Pedaços de uma gravação antiga (já parada) são descartados
  recorder.ondataavailable = async (e) => {
    if (generation !== state.generation || e.data.size === 0) return;
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(await e.data.arrayBuffer());
  };
  recorder.onerror = (e) => log(`MediaRecorder: ${e.error?.name ?? 'erro'}`, 'error');

  send({ type: 'stream-start', mime });
  recorder.start(CHUNK_MS);
  log(`Transmitindo (${mime}, pedaços de ${CHUNK_MS} ms)`, 'ok');
}

function stopShare() {
  if (!state.localStream) return;
  state.generation++;
  if (state.recorder?.state === 'recording') state.recorder.stop();
  state.recorder = null;
  state.localStream.getTracks().forEach((t) => t.stop());
  state.localStream = null;
  video.srcObject = null;
  send({ type: 'stream-stop' });
  $('#share').disabled = false;
  $('#stop').disabled = true;
  log('Compartilhamento encerrado');
}

// ---------- Quem assiste ----------

function startPlayer(mime) {
  stopPlayer();
  if (typeof MediaSource !== 'function' || !MediaSource.isTypeSupported(mime)) {
    log(`Este ambiente não reproduz ${mime}`, 'error');
    return;
  }
  const mediaSource = new MediaSource();
  const player = { mediaSource, sourceBuffer: null, queue: [] };
  state.player = player;
  video.srcObject = null;
  video.src = URL.createObjectURL(mediaSource);

  mediaSource.addEventListener('sourceopen', () => {
    if (state.player !== player) return;
    const sb = mediaSource.addSourceBuffer(mime);
    sb.mode = 'sequence';
    sb.addEventListener('updateend', () => flushQueue(player));
    player.sourceBuffer = sb;
    flushQueue(player);
  });
  log(`Recebendo transmissão de ${state.peers.get(state.sharerId)?.name ?? '?'} (${mime})`, 'ok');
}

function stopPlayer() {
  if (!state.player) return;
  const { mediaSource } = state.player;
  state.player = null;
  if (mediaSource.readyState === 'open') {
    try {
      mediaSource.endOfStream();
    } catch {}
  }
  URL.revokeObjectURL(video.src);
  video.removeAttribute('src');
  video.load();
}

function handleChunk(buf) {
  if (!state.player) return; // ainda não recebeu o início da transmissão
  state.bytesReceived += buf.byteLength;
  state.player.queue.push(buf);
  flushQueue(state.player);
}

function flushQueue(player) {
  const sb = player.sourceBuffer;
  if (!sb || sb.updating || player.queue.length === 0) return;
  try {
    sb.appendBuffer(player.queue.shift());
  } catch (err) {
    log(`appendBuffer falhou: ${err.name}: ${err.message}`, 'error');
    return;
  }
  // Mantém o vídeo "ao vivo": pula para perto do fim se ficar atrasado
  const { buffered } = video;
  if (buffered.length) {
    const end = buffered.end(buffered.length - 1);
    if (end - video.currentTime > MAX_LATENCY_S) video.currentTime = end - 0.3;
  }
  if (video.paused) video.play().catch(() => {});
}

// Mostra a taxa de dados recebida e o atraso aproximado
setInterval(() => {
  if (!state.player) {
    $('#stats').textContent = '';
    return;
  }
  const kbps = Math.round((state.bytesReceived * 8) / 1000);
  state.bytesReceived = 0;
  const { buffered } = video;
  const lag = buffered.length ? buffered.end(buffered.length - 1) - video.currentTime : 0;
  $('#stats').textContent = `${kbps} kbit/s, atraso no buffer: ${lag.toFixed(1)} s`;
}, 1000);

$('#share').onclick = startShare;
$('#stop').onclick = stopShare;
$('#copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('#log').textContent);
    log('Log copiado', 'ok');
  } catch (err) {
    log(`Não foi possível copiar (${err.name}); selecione o texto manualmente`, 'error');
  }
};

// ---------- Início ----------

(async () => {
  $('.mode').textContent = inDiscord
    ? 'Rodando dentro do Discord'
    : 'Rodando fora do Discord (abra em duas abas para testar)';
  runDiagnostics();
  try {
    if (inDiscord) await setupDiscord();
    await connectSocket();
  } catch (err) {
    log(`Falha na inicialização: ${err.message}`, 'error');
  }
  renderPeers();
})();
