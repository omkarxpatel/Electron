/*
 * Spotify + lyrics fixtures for `npm run capture`.
 *
 * Injected alongside shim.js, ahead of the app bundle. Patches `fetch` so
 * every Spotify and lyrics request is answered locally.
 *
 * Fictional content on purpose. Screenshots go in a public README and on a
 * public site, and the alternative — capturing against the developer's real
 * account — puts their listening history, playlist names and profile into
 * both. This also makes captures reproducible: the same track is playing at
 * the same position on every run, so re-shooting after a UI change produces a
 * comparable image rather than whatever happened to be on.
 *
 * Album art is drawn here rather than linked, so a capture needs no network
 * and no Spotify CDN. PNG via canvas, not an SVG data URI: SVG taints a
 * canvas in some engines and the app samples the artwork to derive its
 * palette, which would silently fall back to the default theme.
 */
(() => {
  // ── Artwork ─────────────────────────────────────────────────────────────

  function cover(a, b, seedAngle) {
    const c = document.createElement('canvas');
    c.width = c.height = 320;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 320, 320);
    grd.addColorStop(0, a);
    grd.addColorStop(1, b);
    g.fillStyle = grd;
    g.fillRect(0, 0, 320, 320);
    // A few translucent arcs so palette extraction sees more than two stops.
    g.globalAlpha = 0.22;
    g.strokeStyle = '#fff';
    for (let i = 0; i < 5; i++) {
      g.lineWidth = 16 + i * 7;
      g.beginPath();
      g.arc(160 + Math.cos(seedAngle + i) * 60, 160 + Math.sin(seedAngle + i) * 60, 40 + i * 34, 0, Math.PI * 2);
      g.stroke();
    }
    return c.toDataURL('image/png');
  }

  const ART = [
    cover('#2b6cb0', '#0b1c33', 0.4),
    cover('#b03060', '#25060f', 1.6),
    cover('#1f7a5a', '#06201a', 2.7),
    cover('#7a4bd0', '#150a2b', 3.9),
    cover('#c2691f', '#2a1206', 5.1),
  ];
  const img = (i) => [{ url: ART[i % ART.length], width: 320, height: 320 }];

  // ── Catalogue ───────────────────────────────────────────────────────────

  const ARTISTS = [
    'Halcyon Drift', 'Neon Atlas', 'Violet Hours', 'The Long Signal',
    'Marisol Vega', 'Kestrel', 'Pale Observatory', 'Aster & Ives',
  ];
  const TITLES = [
    'Cassette Sunrise', 'Low Tide', 'Paper Lanterns', 'Second Wind',
    'Glasshouse', 'Northbound', 'Static Bloom', 'Winter Palette',
    'Slow Radio', 'Afterimage', 'Blue Hour', 'Tessellate',
    'Driftwood', 'Signal Fire', 'Quiet Machines', 'Undertow',
    'Halfway Home', 'Lanternlight', 'Open Water', 'Nightjar',
  ];

  const artist = (i) => ({
    id: `art${i}`,
    name: ARTISTS[i % ARTISTS.length],
    type: 'artist',
    uri: `spotify:artist:art${i}`,
    genres: ['dream pop', 'ambient', 'indietronica'],
    images: img(i),
  });

  const track = (i) => ({
    id: `trk${i}`,
    name: TITLES[i % TITLES.length],
    uri: `spotify:track:trk${i}`,
    type: 'track',
    duration_ms: 168000 + ((i * 17393) % 132000),
    popularity: 40 + ((i * 13) % 45),
    explicit: false,
    is_local: false,
    artists: [artist(i), ...(i % 5 === 0 ? [artist(i + 3)] : [])],
    album: {
      id: `alb${i % 5}`,
      name: ['Ceremony', 'Half Light', 'Wintering', 'Foxglove', 'Meridian'][i % 5],
      uri: `spotify:album:alb${i % 5}`,
      album_type: 'album',
      total_tracks: 11,
      release_date: `${2016 + (i % 9)}-0${1 + (i % 9)}-12`,
      images: img(i % 5),
      artists: [artist(i)],
    },
  });

  const TRACKS = Array.from({ length: 40 }, (_, i) => track(i));

  const PLAYLISTS = [
    ['pl1', 'Late Night Drive', 84],
    ['pl2', 'Focus, Deep', 126],
    ['pl3', 'Weekend Warmup', 47],
    ['pl4', 'Rain on Glass', 63],
    ['pl5', 'Kitchen Disco', 38],
    ['pl6', 'Long Haul', 152],
  ].map(([id, name, total], i) => ({
    id,
    name,
    uri: `spotify:playlist:${id}`,
    public: false,
    collaborative: false,
    description: '',
    images: img(i),
    owner: { id: 'demo', display_name: 'Demo Listener', uri: 'spotify:user:demo' },
    tracks: { total, href: `https://api.spotify.com/v1/playlists/${id}/tracks` },
  }));

  const NOW = {
    is_playing: true,
    progress_ms: 96000,
    timestamp: Date.now(),
    shuffle_state: true,
    repeat_state: 'context',
    currently_playing_type: 'track',
    device: { id: 'dev1', name: 'Demo Mac', type: 'Computer', volume_percent: 68, is_active: true },
    context: { type: 'playlist', uri: 'spotify:playlist:pl1' },
    item: TRACKS[2],
    actions: { disallows: {} },
  };

  const page = (items, total) => ({
    items,
    total: total ?? items.length,
    limit: items.length,
    offset: 0,
    next: null,
    previous: null,
    href: '',
  });

  // ── Router ──────────────────────────────────────────────────────────────

  function spotify(pathname, search) {
    const p = pathname.replace(/^\/v1/, '');
    if (p === '/me') {
      return { id: 'demo', display_name: 'Demo Listener', product: 'premium',
               images: img(3), uri: 'spotify:user:demo' };
    }
    if (p === '/me/player') return NOW;
    if (p === '/me/player/queue') return { currently_playing: TRACKS[2], queue: TRACKS.slice(3, 9) };
    if (p === '/me/player/recently-played') {
      return page(TRACKS.slice(5, 25).map((t) => ({ track: t, played_at: new Date().toISOString() })));
    }
    if (p === '/me/playlists') return page(PLAYLISTS, PLAYLISTS.length);
    if (p === '/me/tracks') return page(TRACKS.slice(0, 20).map((t) => ({ track: t, added_at: '2026-01-04T10:00:00Z' })), 214);
    if (p === '/me/albums') {
      return page(TRACKS.slice(0, 12).map((t) => ({ album: { ...t.album, tracks: page(TRACKS.slice(0, 11)) }, added_at: '2026-02-01T10:00:00Z' })), 38);
    }
    if (p === '/me/top/artists') return page(Array.from({ length: 10 }, (_, i) => artist(i)));
    if (p === '/me/top/tracks') return page(TRACKS.slice(0, 10));
    if (p === '/me/tracks/contains' || p === '/me/library/contains') {
      const n = (new URLSearchParams(search).get('ids') || '').split(',').length;
      return Array.from({ length: n }, (_, i) => i % 3 === 0);
    }
    if (/^\/playlists\/[^/]+\/(tracks|items)$/.test(p)) {
      const id = p.split('/')[2];
      const total = PLAYLISTS.find((x) => x.id === id)?.tracks.total ?? 40;
      return page(TRACKS.map((t) => ({ track: t, item: t, added_at: '2026-03-02T09:00:00Z' })), total);
    }
    if (/^\/playlists\/[^/]+$/.test(p)) {
      const id = p.split('/')[2];
      const pl = PLAYLISTS.find((x) => x.id === id) ?? PLAYLISTS[0];
      return { ...pl, tracks: page(TRACKS.map((t) => ({ track: t, item: t })), pl.tracks.total) };
    }
    if (/^\/albums\/[^/]+$/.test(p)) {
      return { ...TRACKS[0].album, tracks: page(TRACKS.slice(0, 11)) };
    }
    if (/^\/artists\/[^/]+\/top-tracks$/.test(p)) return { tracks: TRACKS.slice(0, 10) };
    if (/^\/artists\/[^/]+\/albums$/.test(p)) return page(TRACKS.slice(0, 8).map((t) => t.album));
    if (/^\/artists\/[^/]+$/.test(p)) return artist(1);
    if (p === '/search') {
      return { tracks: page(TRACKS.slice(0, 12)), artists: page([artist(0), artist(1)]),
               albums: page([TRACKS[0].album]), playlists: page(PLAYLISTS.slice(0, 3)) };
    }
    if (p === '/tracks') return { tracks: TRACKS.slice(0, 20) };
    return {};
  }

  const LRC = [
    [0, 'Turn the dial until the static clears'],
    [6, 'Headlights painting lines across the glass'],
    [13, "We were never going anywhere in particular"],
    [21, 'And that was rather the point'],
    [29, 'Hold the note a little longer'],
    [37, 'Let the evening take its time'],
  ].map(([t, x]) => `[${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}.00] ${x}`).join('\n');

  // ── fetch patch ─────────────────────────────────────────────────────────

  const realFetch = window.fetch.bind(window);
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    let u;
    try { u = new URL(url, location.href); } catch { return realFetch(input, init); }

    if (u.hostname === 'api.spotify.com') {
      const method = (init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
      // Mutations (play, seek, shuffle…) just succeed. Nothing reads the body.
      if (method !== 'GET') return new Response(null, { status: 204 });
      return json(spotify(u.pathname, u.search));
    }
    if (u.hostname === 'accounts.spotify.com') {
      return json({ access_token: 'capture-token', refresh_token: 'capture-refresh', expires_in: 3600 });
    }
    if (u.hostname === 'lrclib.net') {
      return json({ id: 1, syncedLyrics: LRC, plainLyrics: LRC.replace(/\[[^\]]+\]\s*/g, ''), instrumental: false });
    }
    if (u.hostname === 'api.lyrics.ovh') {
      return json({ lyrics: LRC.replace(/\[[^\]]+\]\s*/g, '') });
    }
    if (u.hostname === 'api.github.com') return json({});
    return realFetch(input, init);
  };
})();
