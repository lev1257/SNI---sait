(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const ui = {
    themeButton: $("themeButton"), themeLabel: $("themeLabel"),
    play: $("playButton"), prev: $("prevButton"), next: $("nextButton"),
    title: $("currentTitle"), author: $("currentAuthor"), number: $("trackNumber"),
    seek: $("seek"), volume: $("volume"), currentTime: $("currentTime"),
    totalTime: $("totalTime"), vinyl: $("vinyl"), list: $("tracklist"),
    search: $("searchInput"), genre: $("genreFilter"), status: $("pageStatus"),
    prevPage: $("prevPage"), nextPage: $("nextPage")
  };

  const adjectives = ["A Quiet","After the","Almost","Amber","Another","At Dusk","Before the","Between","Blue","Borrowed","Calm","Certain","Close to","December","Distant","Early","Empty","Evening","Faint","First","Floating","For a While","Golden","Hidden","In Stillness","Into the","Late","Lightly","Little","Long","Lost","Low","Midnight","Near","New","Nocturne","Northern","November","Of the","On the","Open","Pale","Passing","Patient","Quietly","Soft","Somewhere","Still","Tender","The Last"];
  const nouns = ["Air","Arrival","Atlas","Blue Hour","Chamber","Circle","Clouds","Distance","Doorway","Echo","Elsewhere","Evening","Field","Figure","Garden","Glass","Harbour","Interval","Island","Light","Memory","Morning","Motion","Night","Ocean","Orchard","Passage","Room","Silence","Slow Tide","Snow","Space","Stone","Study","Summer","Threshold","Window","Winter","World"];
  const genres = ["Ambient","Piano","Electronic","Minimal","Cinematic"];
  const roots = [45,47,48,50,52,43,40,55,46,49,51,53];
  const scales = [[0,2,4,7,9],[0,3,5,7,10],[0,2,5,7,9],[0,3,5,8,10],[0,2,4,7,11]];
  const durations = [164,178,192,205,218,231,246,260,174,199];
  const authors = ["MAISON Studio"];
  const TOTAL = 200, PAGE_SIZE = 20;
  let current = 0, page = 0, filtered = [], playing = false;
  let audio = null, master = null, analyser = null, bus = null, scheduler = null;
  let startedAt = 0, pausedAt = 0, raf = 0, waveRaf = 0;

  const tracks = Array.from({length: TOTAL}, (_, i) => {
    const a = adjectives[i % adjectives.length];
    const b = nouns[(i * 17 + Math.floor(i / adjectives.length) * 7) % nouns.length];
    const title = `${a} ${b}`;
    const genre = genres[(i * 7 + Math.floor(i / 5)) % genres.length];
    const rootNote = roots[(i * 5 + Math.floor(i / 3)) % roots.length];
    const scale = scales[(i * 3 + Math.floor(i / 7)) % scales.length];
    const seed = i + 37;
    return {
      id: i, title, author: authors[0], genre,
      duration: durations[(i * 3 + Math.floor(i / 9)) % durations.length],
      bpm: 44 + (i * 13 % 29), root: rootNote, scale, seed,
      color: (i * 29) % 360
    };
  });

  const fmt = (seconds) => {
    seconds = Math.max(0, Math.floor(seconds || 0));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const currentTrack = () => tracks[current];

  function setTheme(theme) {
    root.dataset.theme = theme;
    ui.themeLabel.textContent = theme === "ivoire" ? "Ivoire" : "Onyx";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === "ivoire" ? "#fbfaf7" : "#101010";
    try { localStorage.setItem("maison-theme-v2", theme); } catch (_) {}
  }
  ui.themeButton.addEventListener("click", () => setTheme(root.dataset.theme === "ivoire" ? "onyx" : "ivoire"));

  function filteredTracks() {
    const q = ui.search.value.trim().toLowerCase();
    const genre = ui.genre.value;
    return tracks.filter(t =>
      (genre === "all" || t.genre === genre) &&
      (!q || `${t.title} ${t.author} ${t.genre}`.toLowerCase().includes(q))
    );
  }

  function renderList() {
    filtered = filteredTracks();
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    const start = page * PAGE_SIZE;
    const visible = filtered.slice(start, start + PAGE_SIZE);
    ui.list.innerHTML = visible.map((t, idx) => `
      <li>
        <button class="track-row${t.id === current ? " active" : ""}" type="button" data-track="${t.id}" aria-label="Воспроизвести ${t.title}">
          <span class="track-number">${String(t.id + 1).padStart(3, "0")}</span>
          <span class="track-info">
            <span class="track-name">${t.title}</span>
            <span class="track-author">${t.author}</span>
          </span>
          <span class="track-style">${t.genre}</span>
          <span class="track-duration">${fmt(t.duration)}</span>
        </button>
      </li>`).join("");
    ui.status.textContent = filtered.length
      ? `${String(start + 1).padStart(2,"0")} — ${String(Math.min(start + PAGE_SIZE, filtered.length)).padStart(2,"0")} / ${filtered.length}`
      : "Ничего не найдено";
    ui.prevPage.disabled = page === 0;
    ui.nextPage.disabled = page >= pages - 1;
  }

  function updateTrackInfo() {
    const t = currentTrack();
    ui.title.textContent = t.title;
    ui.author.textContent = `${t.author} · ${t.genre} · Original generative piece`;
    ui.number.textContent = `PIECE ${String(t.id + 1).padStart(3,"0")} / ${TOTAL}`;
    ui.totalTime.textContent = fmt(t.duration);
    ui.seek.max = t.duration;
    ui.seek.value = 0;
    ui.seek.style.setProperty("--progress", "0%");
    ui.currentTime.textContent = "0:00";
    ui.vinyl.style.setProperty("--hue", `${t.color}deg`);
    document.querySelectorAll(".track-row").forEach(el => el.classList.toggle("active", Number(el.dataset.track) === current));
  }

  const waveCanvas = $("vinylWave");
  const waveCtx = waveCanvas ? waveCanvas.getContext("2d") : null;
  let waveWidth = 0, waveHeight = 0, waveFrame = 0;

  function resizeWave() {
    if (!waveCanvas || !waveCtx) return;
    const rect = waveCanvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    waveWidth = Math.max(1, rect.width);
    waveHeight = Math.max(1, rect.height);
    waveCanvas.width = Math.round(waveWidth * dpr);
    waveCanvas.height = Math.round(waveHeight * dpr);
    waveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawElectricWave(time) {
    if (!waveCtx || !waveWidth || !waveHeight) return;
    const ctx = waveCtx;
    const cx = waveWidth / 2, cy = waveHeight / 2;
    const radius = waveWidth * .315;
    ctx.clearRect(0, 0, waveWidth, waveHeight);
    const bins = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    if (bins) analyser.getByteFrequencyData(bins);
    const energy = bins ? bins.reduce((sum, value) => sum + value, 0) / bins.length / 255 : .18;

    for (let layer = 0; layer < 3; layer++) {
      ctx.beginPath();
      const points = 260;
      for (let i = 0; i <= points; i++) {
        const angle = i / points * Math.PI * 2;
        const bin = bins ? bins[(i * 3 + layer * 17) % bins.length] / 255 : .2;
        const jitter = Math.sin(i * (2.1 + layer * .43) + time * .0024) * (3 + energy * 8)
          + Math.sin(i * 5.7 - time * .003 + layer) * (1.5 + bin * 8)
          + Math.sin(i * .31 + time * .0012 * (layer + 1)) * 3;
        const spark = Math.pow(Math.max(0, Math.sin(i * 12.989 + time * .006 + layer * 4.2)), 18) * 9;
        const r = radius + layer * 13 + jitter + spark;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = layer === 0 ? `rgba(255,91,111,${.48 + energy * .32})` : layer === 1 ? `rgba(185,34,57,${.35 + energy * .3})` : `rgba(255,190,177,${.16 + energy * .2})`;
      ctx.lineWidth = layer === 0 ? 1.35 : .8;
      ctx.shadowColor = "#f12c4e";
      ctx.shadowBlur = layer === 0 ? 11 : 5;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // Short, irregular electrical sparks around the waveform.
    for (let i = 0; i < 18; i++) {
      const seed = Math.sin(i * 91.73 + Math.floor(time / 90) * 17.1) * 43758.5453;
      const random = seed - Math.floor(seed);
      const angle = random * Math.PI * 2;
      const inner = radius - 8 + random * 12;
      const outer = inner + 5 + (i % 4) * 4;
      const bend = (random - .5) * 13;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      ctx.lineTo(cx + Math.cos(angle + bend * .012) * (inner + outer) / 2, cy + Math.sin(angle + bend * .012) * (inner + outer) / 2);
      ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
      ctx.strokeStyle = `rgba(255,${70 + Math.floor(random * 80)},${90 + Math.floor(random * 70)},${.2 + random * .55})`;
      ctx.lineWidth = .7 + random * .8;
      ctx.shadowColor = "#ff294d";
      ctx.shadowBlur = 8;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
  }

  function animateElectricWave() {
    if (!playing) return;
    waveFrame = performance.now();
    drawElectricWave(waveFrame);
    waveRaf = requestAnimationFrame(animateElectricWave);
  }

  if (waveCanvas) {
    resizeWave();
    window.addEventListener("resize", resizeWave, {passive:true});
    drawElectricWave(0);
  }

  function renderPlayState() {
    root.classList.toggle("is-playing", playing);
    ui.play.setAttribute("aria-label", playing ? "Пауза" : "Воспроизвести");
    if (playing) animateElectricWave();
    else { cancelAnimationFrame(waveRaf); drawElectricWave(0); }
  }

  function renderPageForTrack(id) {
    const index = filtered.findIndex(t => t.id === id);
    if (index >= 0) {
      page = Math.floor(index / PAGE_SIZE);
      renderList();
    }
  }

  function selectTrack(id, autoplay = true) {
    current = (id + TOTAL) % TOTAL;
    renderPageForTrack(current);
    updateTrackInfo();
    if (autoplay) startPlayback(0);
  }

  function ensureAudio() {
    if (audio) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    audio = new AC();
    master = audio.createGain();
    master.gain.value = Number(ui.volume.value) / 100;
    const compressor = audio.createDynamicsCompressor();
    compressor.threshold.value = -22;
    compressor.knee.value = 18;
    compressor.ratio.value = 3;
    analyser = audio.createAnalyser();
    analyser.fftSize = 256;
    master.connect(compressor);
    compressor.connect(analyser);
    analyser.connect(audio.destination);
  }

  const mtof = n => 440 * Math.pow(2, (n - 69) / 12);
  const seeded = (n) => {
    let x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };

  function stopCurrentBus() {
    if (scheduler) clearInterval(scheduler);
    scheduler = null;
    if (bus) {
      const old = bus;
      old.gain.gain.cancelScheduledValues(audio.currentTime);
      old.gain.gain.setTargetAtTime(0, audio.currentTime, .22);
      setTimeout(() => { try { old.gain.disconnect(); } catch (_) {} }, 1100);
      bus = null;
    }
  }

  function playTone(freq, when, length, peak, type, destination, pan = 0) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, when);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(Math.max(.0002, peak), when + Math.min(1.2, length * .25));
    gain.gain.setTargetAtTime(.0001, when + length * .55, Math.max(.12, length * .2));
    if (audio.createStereoPanner) {
      const p = audio.createStereoPanner();
      p.pan.value = pan;
      osc.connect(gain); gain.connect(p); p.connect(destination);
    } else { osc.connect(gain); gain.connect(destination); }
    osc.start(when);
    osc.stop(when + length + 1.5);
  }

  function makeChord(t, when, step) {
    const scale = t.scale;
    const base = t.root + (step % 4 === 1 ? -5 : step % 4 === 3 ? 2 : 0);
    const intervals = [0, scale[2], scale[4], 12, scale[2] + 12];
    intervals.forEach((semi, j) => {
      const f = mtof(base + semi);
      playTone(f, when, 8.5 + seeded(t.seed + step + j) * 4, .018 + (j === 0 ? .018 : 0), j % 2 ? "triangle" : "sine", bus.input, (j - 2) * .13);
    });
  }

  function makeNote(t, when, step) {
    const degree = t.scale[Math.floor(seeded(t.seed * 2 + step) * t.scale.length)];
    const octave = seeded(t.seed + step * 3) > .78 ? 24 : 12;
    const freq = mtof(t.root + degree + octave);
    playTone(freq, when, 2.5 + seeded(step + t.seed) * 2.5, .025, "sine", bus.input, seeded(step * 4 + t.seed) * 1.4 - .7);
  }

  function scheduleAudio() {
    if (!audio || !bus || !playing) return;
    const t = currentTrack();
    const elapsed = audio.currentTime - startedAt;
    const beat = 60 / t.bpm;
    const chordDuration = beat * 8;
    const target = audio.currentTime + .45;
    while (pausedAt < target) {
      const step = Math.floor((pausedAt - startedAt) / chordDuration);
      if (step >= 0 && Math.abs(((pausedAt - startedAt) % chordDuration)) < .08) makeChord(t, pausedAt, step);
      const noteStep = Math.floor((pausedAt - startedAt) / (beat * 1.5));
      if (noteStep >= 0 && seeded(t.seed + noteStep * 11) > .3 && Math.abs(((pausedAt - startedAt) % (beat * 1.5))) < .08) {
        makeNote(t, pausedAt, noteStep);
      }
      pausedAt += .08;
    }
    if (elapsed >= t.duration) selectTrack((current + 1) % TOTAL);
    updateProgress();
  }

  function startPlayback(offset = 0) {
    ensureAudio();
    audio.resume();
    stopCurrentBus();
    const input = audio.createGain();
    const gain = audio.createGain();
    gain.gain.setValueAtTime(.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(1, audio.currentTime + .8);
    input.connect(gain);
    const delay = audio.createDelay(1);
    delay.delayTime.value = .34;
    const feedback = audio.createGain();
    feedback.gain.value = .22;
    const filter = audio.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 2200;
    input.connect(delay);
    delay.connect(filter);
    filter.connect(feedback);
    feedback.connect(delay);
    filter.connect(gain);
    gain.connect(master);
    bus = { input, gain };
    startedAt = audio.currentTime - offset;
    pausedAt = startedAt;
    playing = true;
    renderPlayState();
    scheduler = setInterval(scheduleAudio, 80);
    scheduleAudio();
    animateProgress();
  }

  function pausePlayback() {
    if (!audio || !playing) return;
    playing = false;
    renderPlayState();
    audio.suspend();
    if (scheduler) clearInterval(scheduler);
    scheduler = null;
    cancelAnimationFrame(raf);
  }

  function togglePlayback() {
    if (playing) pausePlayback();
    else if (audio && bus) {
      audio.resume();
      playing = true;
      renderPlayState();
      scheduler = setInterval(scheduleAudio, 80);
      animateProgress();
    } else startPlayback(0);
  }

  function updateProgress() {
    const t = currentTrack();
    const elapsed = playing && audio ? Math.max(0, audio.currentTime - startedAt) : Number(ui.seek.value);
    const pos = Math.min(t.duration, elapsed);
    if (document.activeElement !== ui.seek) ui.seek.value = pos;
    ui.seek.style.setProperty("--progress", `${(Number(ui.seek.value) / t.duration) * 100}%`);
    ui.currentTime.textContent = fmt(Number(ui.seek.value));
  }

  function animateProgress() {
    if (!playing) return;
    updateProgress();
    raf = requestAnimationFrame(animateProgress);
  }

  ui.play.addEventListener("click", togglePlayback);
  // Space toggles playback, except while the user is typing or operating a control.
  document.addEventListener("keydown", event => {
    if (event.code !== "Space" || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
    const target = event.target;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    event.preventDefault();
    togglePlayback();
  });
  ui.next.addEventListener("click", () => selectTrack(current + 1));
  ui.prev.addEventListener("click", () => selectTrack(current - 1));
  ui.list.addEventListener("click", e => {
    const row = e.target.closest("[data-track]");
    if (row) selectTrack(Number(row.dataset.track));
  });
  ui.seek.addEventListener("input", () => {
    const value = Number(ui.seek.value);
    ui.seek.style.setProperty("--progress", `${value / Number(ui.seek.max) * 100}%`);
    ui.currentTime.textContent = fmt(value);
  });
  ui.seek.addEventListener("change", () => {
    if (playing) startPlayback(Number(ui.seek.value));
  });
  ui.volume.addEventListener("input", () => {
    if (master && audio) master.gain.setTargetAtTime(Number(ui.volume.value) / 100, audio.currentTime, .08);
  });
  ui.search.addEventListener("input", () => { page = 0; renderList(); });
  ui.genre.addEventListener("change", () => { page = 0; renderList(); });
  ui.prevPage.addEventListener("click", () => { page--; renderList(); });
  ui.nextPage.addEventListener("click", () => { page++; renderList(); });

  // Gentle reveal on scroll; elements remain visible if IntersectionObserver is unavailable.
  const revealItems = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: .12, rootMargin: "0px 0px -35px 0px" });
    revealItems.forEach(el => observer.observe(el));
  } else revealItems.forEach(el => el.classList.add("visible"));

  $("year").textContent = new Date().getFullYear();
  setTheme(root.dataset.theme || "onyx");
  filtered = tracks;
  renderList();
  updateTrackInfo();
})();
