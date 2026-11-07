/* Runs before the stylesheet-dependent app boots: applies the cached theme so the
   first paint is not a white flash on a dark phone. No user data, no network. */
(function () {
  try {
    var stored = localStorage.getItem('khata.theme');
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = stored || (prefersDark ? 'dark' : 'light');
  } catch (error) {
    document.documentElement.dataset.theme = 'light';
  }
})();
