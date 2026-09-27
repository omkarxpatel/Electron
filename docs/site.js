// Copy buttons. The install flow hinges on people running shell commands
// correctly, so make it impossible to mis-select one.
document.querySelectorAll('.code').forEach((block) => {
  const btn = block.querySelector('.copy');
  const code = block.querySelector('code');
  if (!btn || !code) return;
  btn.addEventListener('click', async () => {
    // innerText, not textContent: it respects the line breaks <pre> renders,
    // and drops nothing — the `.cmt` spans are real text the user may want.
    try {
      await navigator.clipboard.writeText(code.innerText.trim());
      btn.textContent = 'Copied';
      btn.classList.add('done');
    } catch {
      btn.textContent = 'Press ⌘C';
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(code);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('done');
    }, 1800);
  });
});

// Offer the right build first. navigator.platform is deprecated but still the
// only thing that distinguishes Apple Silicon from Intel in Safari, and a
// wrong guess here just means the generic label stays.
(() => {
  const note = document.querySelector('.hero-note');
  if (!note) return;
  const ua = navigator.userAgent || '';
  if (!/Mac/.test(ua)) return;
  let arm = null;
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) arm = /Apple (M\d|GPU)/i.test(String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)));
  } catch { /* leave the generic text in place */ }
  if (arm === null) return;
  const which = arm ? 'arm64' : 'x64';
  const chip = arm ? 'Apple Silicon' : 'Intel';
  note.innerHTML =
    'Looks like you\'re on <strong>' + chip + '</strong> — take the <code>' + which +
    '</code> build. Read <a href="#install">the install steps</a> first: the app is ' +
    'unsigned, and macOS needs one extra command.';
})();
