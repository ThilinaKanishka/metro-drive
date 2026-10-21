/**
 * On-screen buttons for touch devices. Hold-buttons (data-key) map onto the
 * Input's virtual state; tap-buttons (data-action) fire one-shot actions.
 */
export function setupTouchControls(input) {
  const isTouch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  const root = document.getElementById('touch');
  if (!isTouch) return false;

  document.body.classList.add('touch');
  root.classList.remove('hidden');

  root.querySelectorAll('button[data-key]').forEach((btn) => {
    const key = btn.dataset.key;
    const press = (e) => {
      e.preventDefault();
      btn.setPointerCapture?.(e.pointerId);
      input.virtual[key] = true;
      btn.classList.add('active');
    };
    const release = (e) => {
      e.preventDefault();
      input.virtual[key] = false;
      btn.classList.remove('active');
    };
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('lostpointercapture', release);
  });

  root.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      input.emit(btn.dataset.action);
    });
  });

  // Block long-press context menus while steering.
  root.addEventListener('contextmenu', (e) => e.preventDefault());
  return true;
}
