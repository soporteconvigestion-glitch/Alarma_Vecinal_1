const DEFAULT_CHANNEL = 'cuadra-vecinos-seguros';
let eventSource = null;
let audioCtx = null;
let isSirenPlaying = false;
let sirenInterval = null;
let deferredPrompt;

// --- WAKE LOCK API (Evitar que la pantalla se apague) ---
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      console.log('Wake Lock activado: Pantalla no se apagará');
      
      wakeLock.addEventListener('release', () => {
        console.log('Wake Lock liberado');
      });
    }
  } catch (err) {
    console.log(`Error Wake Lock: ${err.name}, ${err.message}`);
  }
}

// Reactivar Wake Lock si el usuario cambia de pestaña y vuelve
document.addEventListener('visibilitychange', async () => {
  if (wakeLock !== null && document.visibilityState === 'visible') {
    requestWakeLock();
  }
});


const state = {
  name: localStorage.getItem('vecino_name') || '',
  house: localStorage.getItem('vecino_house') || '',
  channel: localStorage.getItem('vecino_channel') || DEFAULT_CHANNEL
};

// DOM Elements
const lblName = document.getElementById('lblName');
const lblLocation = document.getElementById('lblLocation');
const lblChannel = document.getElementById('lblChannel');
const statusDot = document.getElementById('statusDot');
const btnSettings = document.getElementById('btnSettings');
const btnChangeData = document.getElementById('btnChangeData');
const btnPanic = document.getElementById('btnPanic');
const btnTest = document.getElementById('btnTest');
const btnInstall = document.getElementById('btnInstall');

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

// Initialization
window.addEventListener('DOMContentLoaded', () => {
  // 1. Revisar si la app se abrió desde una notificación de ntfy
  const params = new URLSearchParams(window.location.search);
  if (params.get('sos') === '1') {
    mostrarAlertaRecibida({
      nombre: params.get('n') || 'Vecino',
      casa: params.get('c') || 'Desconocido',
      timestamp: params.get('t') || new Date().toLocaleTimeString()
    }, true); // Forzar sonido porque el usuario acaba de entrar a ver la emergencia
    // Limpiar la URL para que no vuelva a sonar al recargar
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  if (!state.name || !state.house) {
    abrirModal();
  } else {
    actualizarInterfaz();
    iniciarConexion();
    requestWakeLock();
  }

  // PWA Install Prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    btnInstall.style.display = 'flex';
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

btnSettings.addEventListener('click', abrirModal);
btnChangeData.addEventListener('click', abrirModal);

btnSaveData.addEventListener('click', () => {
  const nombre = inputName.value.trim();
  const casa = inputHouse.value.trim();
  const canal = inputChannel.value.trim() || DEFAULT_CHANNEL;

  if (!nombre || !casa) {
    alert('Ingresa tu nombre y número de casa o departamento.');
    return;
  }

  state.name = nombre;
  state.house = casa;
  state.channel = canal;

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

// Escuchar alertas en tiempo real vía SSE (Web nativa, sin requerir instalar app ntfy)
// Solo requiere que la pestaña/app esté viva.
function iniciarConexion() {
  if (eventSource) eventSource.close();

  statusDot.className = 'status-dot'; // gris
  
  const ntfyUrl = `https://ntfy.sh/${encodeURIComponent(state.channel)}/sse`;
  eventSource = new EventSource(ntfyUrl);

  eventSource.onopen = () => {
    statusDot.classList.add('connected');
  };

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.event === 'message') {
        // Extraer datos del texto de ntfy
        const lineas = data.message.split('\n');
        const n = lineas[0] ? lineas[0].replace('Vecino: ', '') : 'Desconocido';
        const c = lineas[1] ? lineas[1].replace('Lugar: ', '') : '';
        
        // LÓGICA ANTI-CAOS: Solo suena la web si estás mirando la pantalla. Si no, dejamos que ntfy suene.
        const estaEnPantalla = document.visibilityState === 'visible';
        
        mostrarAlertaRecibida({
          nombre: n,
          casa: c,
          timestamp: new Date().toLocaleTimeString()
        }, estaEnPantalla);
      }
    } catch (e) {}
  };

  eventSource.onerror = () => {
    statusDot.classList.remove('connected');
  };
}

// Envío de la alerta con manejo robusto
btnPanic.addEventListener('click', async () => {
  if (!state.name || !state.house) {
    abrirModal();
    return;
  }

  // Generar URL para que ntfy la abra al tocar la notificación
  const clickUrl = new URL(window.location.href.split('?')[0]);
  clickUrl.searchParams.set('sos', '1');
  clickUrl.searchParams.set('n', state.name);
  clickUrl.searchParams.set('c', state.house);
  clickUrl.searchParams.set('t', new Date().toLocaleTimeString());

  // Enviar comando JSON seguro a ntfy
  const payloadJson = {
      topic: state.channel,
      message: `Vecino: ${state.name}\nLugar: ${state.house}`,
      title: "🚨 EMERGENCIA VECINAL",
      priority: 4, // Prioridad Alta (evita el bucle infinito en Android)
      tags: ["rotating_light"],
      click: clickUrl.toString() // Abre la app al tocar
  };

  try {
    const res = await fetch('https://ntfy.sh/', {
      method: 'POST',
      body: JSON.stringify(payloadJson)
    });

    if (!res.ok) throw new Error(`Error red: ${res.status}`);
    
    // Mostramos feedback propio
    mostrarAlertaRecibida({
      nombre: state.name,
      casa: state.house,
      timestamp: new Date().toLocaleTimeString()
    }, true); 
    
  } catch (err) {
    console.error(err);
    alert('Verifica tu conexión a internet e intenta nuevamente.');
  }
});

// Sintetizador Web Audio API (No requiere archivos mp3 externos)
function reproducirTonoSAE() {
  if (isSirenPlaying) return; // BLOQUEO ANTI-DUPLICADOS: Asegura que el botón de Detener siempre funcione
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

      setTimeout(() => {
        try { osc1.stop(); osc2.stop(); osc1.disconnect(); osc2.disconnect(); } catch (e) {}
      }, 850);
    };

    playBurst();
    clearInterval(sirenInterval);
    sirenInterval = setInterval(playBurst, 1100);

    if ('vibrate' in navigator) navigator.vibrate([1000, 300, 1000, 300, 1000]);
  } catch (err) { console.error('Audio fail:', err); }
}

function detenerSirena() {
  isSirenPlaying = false;
  clearInterval(sirenInterval);
  if ('vibrate' in navigator) navigator.vibrate(0);
  alertOverlay.classList.add('hidden');
}

btnSilence.addEventListener('click', detenerSirena);

btnTest.addEventListener('click', () => {
  reproducirTonoSAE();
  mostrarAlertaRecibida({
    nombre: state.name || 'Prueba',
    casa: state.house || 'Mi Casa',
    timestamp: new Date().toLocaleTimeString()
  });
});

function mostrarAlertaRecibida(data) {
  reproducirTonoSAE();
  alertVictimHouse.textContent = `Lugar: ${data.casa || 'Desconocido'}`;
  document.getElementById('alertVictimName').innerText = `Vecino: ${data.nombre || 'Desconocido'}`;

  alertVictimName.textContent = `Vecino: ${data.nombre || 'Desconocido'}`;
  alertTimestamp.textContent = `Hora: ${data.timestamp || new Date().toLocaleTimeString()}`;
  alertOverlay.classList.remove('hidden');
}

// Botón de instalación
btnInstall.addEventListener('click', async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      btnInstall.style.display = 'none';
    }
    deferredPrompt = null;
  } else {
    alert("Para instalar en iPhone: presiona el ícono de compartir (cuadrado con flecha) y selecciona 'Agregar a inicio'. En Android usa los 3 puntos y 'Instalar aplicación'.");
  }
});
