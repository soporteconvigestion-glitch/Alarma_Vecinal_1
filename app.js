const DEFAULT_CHANNEL = 'cuadra-vecinos-seguros';
let eventSource = null;
let audioCtx = null;
let isSirenPlaying = false;
let sirenInterval = null;
let deferredPrompt;
let wakeLock = null;

// VARIABLES DEL BUCLE INFINITO
let rafagaInterval = null;
let isSendingSOS = false;

const state = {
  name: localStorage.getItem('vecino_name') || '',
  house: localStorage.getItem('vecino_house') || '',
  channel: localStorage.getItem('vecino_channel') || DEFAULT_CHANNEL
};

const lblName = document.getElementById('lblName');
const lblLocation = document.getElementById('lblLocation');
const lblChannel = document.getElementById('lblChannel');
const statusDot = document.getElementById('statusDot');
const btnSettings = document.getElementById('btnSettings');
const btnChangeData = document.getElementById('btnChangeData');
const btnPanic = document.getElementById('btnPanic');
const btnTest = document.getElementById('btnTest');
const btnInstall = document.getElementById('btnInstall'); // Puede ser null por el boton de WAV

const setupModal = document.getElementById('setupModal');
const inputName = document.getElementById('inputName');
const inputHouse = document.getElementById('inputHouse');
const inputChannel = document.getElementById('inputChannel');
const btnSaveData = document.getElementById('btnSaveData');

const alertOverlay = document.getElementById('alertOverlay');
const alertVictimHouse = document.getElementById('alertVictimHouse');
const alertVictimName = document.getElementById('alertVictimName');
const alertTimestamp = document.getElementById('alertTimestamp');
const btnSilence = document.getElementById('btnSilence');

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (err) {}
}
document.addEventListener('visibilitychange', async () => {
  if (wakeLock !== null && document.visibilityState === 'visible') requestWakeLock();
});

window.addEventListener('DOMContentLoaded', () => {
  // LÓGICA DE APAGADO REMOTO (Cuando el vecino receptor abre la notificación)
  const params = new URLSearchParams(window.location.search);
  if (params.get('sos') === '1') {
    mostrarAlertaRecibida({
      nombre: params.get('n') || 'Vecino',
      casa: params.get('c') || 'Desconocido',
      timestamp: params.get('t') || new Date().toLocaleTimeString()
    }, true);
    window.history.replaceState({}, document.title, window.location.pathname);
    
    // Alguien abrió la aplicación: ENVIAMOS ORDEN DE DETENER A TODA LA RED
    fetch(`https://ntfy.sh/${encodeURIComponent(state.channel)}`, { method: 'POST', body: 'CMD_STOP' });
  }

  if (!state.name || !state.house) {
    abrirModal();
  } else {
    actualizarInterfaz();
    iniciarConexion();
    requestWakeLock();
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if(btnInstall) btnInstall.style.display = 'flex';
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.log('SW Error:', err));
  }
});

function abrirModal() {
  inputName.value = state.name;
  inputHouse.value = state.house;
  inputChannel.value = state.channel;
  setupModal.classList.remove('hidden');
}

if(btnSettings) btnSettings.addEventListener('click', abrirModal);
if(btnChangeData) btnChangeData.addEventListener('click', abrirModal);

btnSaveData.addEventListener('click', () => {
  const nombre = inputName.value.trim();
  const casa = inputHouse.value.trim();
  const canal = inputChannel.value.trim() || DEFAULT_CHANNEL;

  if (!nombre || !casa) { alert('Ingresa tu nombre y casa.'); return; }

  state.name = nombre; state.house = casa; state.channel = canal;
  localStorage.setItem('vecino_name', nombre);
  localStorage.setItem('vecino_house', casa);
  localStorage.setItem('vecino_channel', canal);

  setupModal.classList.add('hidden');
  actualizarInterfaz();
  iniciarConexion();
  requestWakeLock();
});

function actualizarInterfaz() {
  lblName.textContent = state.name;
  lblLocation.textContent = state.house;
  lblChannel.textContent = state.channel;
}

// Resetea el botón pánico a su estado rojo original
function detenerEnvio() {
  isSendingSOS = false;
  if(rafagaInterval) clearInterval(rafagaInterval);
  document.querySelector('.text-main').innerText = "ACTIVAR ALARMA";
  document.querySelector('.text-sub').innerText = "PULSAR PARA AUXILIO";
  btnPanic.style.background = 'linear-gradient(145deg, #ef4444, #b91c1c)';
  btnPanic.style.borderColor = '#f87171';
}

function iniciarConexion() {
  if (eventSource) eventSource.close();
  statusDot.className = 'status-dot';
  
  const ntfyUrl = `https://ntfy.sh/${encodeURIComponent(state.channel)}/sse`;
  eventSource = new EventSource(ntfyUrl);

  eventSource.onopen = () => statusDot.classList.add('connected');

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.event === 'message') {
        
        // INTERCEPTAR EL COMANDO OCULTO PARA DETENER LA ALARMA
        if (data.message === 'CMD_STOP') {
          detenerSirena();
          detenerEnvio(); // Si yo estaba enviando la ráfaga, mi teléfono se detiene
          alertOverlay.classList.add('hidden');
          return;
        }

        const lineas = data.message.split('\n');
        const n = lineas[0] ? lineas[0].replace('Vecino: ', '') : 'Desconocido';
        const c = lineas[1] ? lineas[1].replace('Lugar: ', '') : '';
        const estaEnPantalla = document.visibilityState === 'visible';
        
        mostrarAlertaRecibida({ nombre: n, casa: c, timestamp: new Date().toLocaleTimeString() }, estaEnPantalla);
      }
    } catch (e) {}
  };
  eventSource.onerror = () => statusDot.classList.remove('connected');
}

btnPanic.addEventListener('click', async () => {
  if (!state.name || !state.house) { abrirModal(); return; }

  // 1. SI LA ALARMA YA ESTÁ ACTIVA, EL BOTÓN AHORA SIRVE PARA APAGARLA
  if (isSendingSOS) {
    detenerEnvio();
    detenerSirena();
    fetch(`https://ntfy.sh/${encodeURIComponent(state.channel)}`, { method: 'POST', body: 'CMD_STOP' });
    return;
  }

  // 2. INICIAR EL BUCLE (MODO ACTIVO)
  isSendingSOS = true;
  document.querySelector('.text-main').innerText = "DETENER ALARMA";
  document.querySelector('.text-sub').innerText = "TOCA PARA CANCELAR";
  
  // Cambiamos el color a naranja para que sepa que está emitiendo
  btnPanic.style.background = 'linear-gradient(145deg, #f59e0b, #b45309)';
  btnPanic.style.borderColor = '#fbbf24';

  mostrarAlertaRecibida({ nombre: state.name, casa: state.house, timestamp: new Date().toLocaleTimeString() }, true);

  const clickUrl = new URL(window.location.href.split('?')[0]);
  clickUrl.searchParams.set('sos', '1');
  clickUrl.searchParams.set('n', state.name);
  clickUrl.searchParams.set('c', state.house);
  clickUrl.searchParams.set('t', new Date().toLocaleTimeString());

  let contador = 1;
  const disparar = async () => {
    if (!isSendingSOS) return;
    
    // Tope de seguridad (100 disparos = ~13 minutos sonando) por si se cae el teléfono
    if (contador > 100) { detenerEnvio(); return; } 

    const payloadJson = {
        topic: state.channel,
        message: `Vecino: ${state.name}\nLugar: ${state.house}\n(Aviso continuo ${contador})`,
        title: "🚨 EMERGENCIA VECINAL",
        priority: 4,
        tags: ["rotating_light"],
        click: clickUrl.toString()
    };

    try { await fetch('https://ntfy.sh/', { method: 'POST', body: JSON.stringify(payloadJson) }); } 
    catch (err) { console.error(err); }
    contador++;
  };

  disparar(); // Dispara inmediatamente el aviso 1
  
  // Envía un aviso cada 8 segundos de forma infinita (hasta que lo detengan)
  rafagaInterval = setInterval(disparar, 8000); 
});

// Cuando alguien presiona "Detener Sirena" en la pantalla roja
btnSilence.addEventListener('click', () => {
  detenerSirena();
  alertOverlay.classList.add('hidden');
  
  // ENVIAR ORDEN DE APAGADO SILENCIOSO A TODA LA RED
  fetch(`https://ntfy.sh/${encodeURIComponent(state.channel)}`, { method: 'POST', body: 'CMD_STOP' });
});

function reproducirTonoSAE() {
  if (isSirenPlaying) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    isSirenPlaying = true;
    const playBurst = () => {
      if (!isSirenPlaying) return;
      const osc1 = audioCtx.createOscillator();
      const osc2 = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();

      osc1.type = 'sine'; osc2.type = 'sine';
      osc1.frequency.setValueAtTime(853, audioCtx.currentTime);
      osc2.frequency.setValueAtTime(960, audioCtx.currentTime);
      gainNode.gain.setValueAtTime(1.0, audioCtx.currentTime);

      osc1.connect(gainNode); osc2.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      osc1.start(); osc2.start();

      setTimeout(() => { try { osc1.stop(); osc2.stop(); osc1.disconnect(); osc2.disconnect(); } catch (e) {} }, 850);
    };

    playBurst();
    clearInterval(sirenInterval);
    sirenInterval = setInterval(playBurst, 1100);

    if ('vibrate' in navigator) navigator.vibrate([1000, 300, 1000, 300, 1000]);
  } catch (err) {}
}

function detenerSirena() {
  isSirenPlaying = false;
  clearInterval(sirenInterval);
  if ('vibrate' in navigator) navigator.vibrate(0);
  if(alertOverlay) alertOverlay.classList.add('hidden');
}

if(btnTest) {
  btnTest.addEventListener('click', () => {
    mostrarAlertaRecibida({ nombre: state.name || 'Prueba', casa: state.house || 'Mi Casa', timestamp: new Date().toLocaleTimeString() }, true);
  });
}

function mostrarAlertaRecibida(data, playSound = true) {
  if (playSound) reproducirTonoSAE();
  if(alertVictimHouse) alertVictimHouse.textContent = `Lugar: ${data.casa || 'Desconocido'}`;
  if(alertVictimName) alertVictimName.innerText = `Vecino: ${data.nombre || 'Desconocido'}`;
  if(alertTimestamp) alertTimestamp.textContent = `Hora: ${data.timestamp || new Date().toLocaleTimeString()}`;
  if(alertOverlay) alertOverlay.classList.remove('hidden');
}
