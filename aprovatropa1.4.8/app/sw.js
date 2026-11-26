/* Service worker do Rumo à Posse.
   Regras de segurança:
   - guarda no cache APENAS arquivos do próprio app (mesma origem) e a biblioteca pública do Supabase;
   - NUNCA guarda respostas de autenticação ou de dados (supabase.co, Google, etc.);
   - páginas são sempre buscadas na rede primeiro (login e atualizações sempre atuais). */
const V = 'rumo-posse-v13';
const LIB_SUPABASE = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './js/onboarding.js', './js/busca-online.js', './icons/icon-192.png', './icons/icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c =>
    Promise.all(SHELL.map(u => c.add(u).catch(() => null)))
      .then(() => fetch(LIB_SUPABASE, { mode: 'no-cors' }).then(r => c.put(LIB_SUPABASE, r)).catch(() => null))
  ).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const mesma = url.origin === self.location.origin;
  // autenticação e dados nunca passam pelo cache
  if (!mesma && e.request.url !== LIB_SUPABASE) return;
  if (url.hostname.endsWith('supabase.co') || url.pathname.includes('/auth/')) return;
  const navegacao = e.request.mode === 'navigate';
  if (navegacao) {
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok && mesma) caches.open(V).then(c => c.put('./index.html', res.clone()));
      return res;
    }).catch(() => caches.match('./index.html')));
    return;
  }
  // rede primeiro: a versão nova chega ao recarregar; o cache só é usado sem internet
  e.respondWith(fetch(e.request).then(res => {
    if (res && res.ok && mesma) caches.open(V).then(c => c.put(e.request, res.clone()));
    return res;
  }).catch(() => caches.match(e.request)));
});
