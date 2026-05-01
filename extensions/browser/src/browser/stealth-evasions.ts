// Stealth evasions for headless Chromium connected via CDP.
//
// Headless Chromium (even with `--headless=new`) exposes telltales that
// commercial anti-bot stacks fingerprint trivially: navigator.webdriver
// is true, window.chrome.runtime is missing, navigator.plugins is empty,
// hardwareConcurrency reports 1, etc. We patch each via document-init
// scripts applied to every context after connectOverCDP.
//
// Source-of-truth for the patch set is the community-maintained
// puppeteer-extra-plugin-stealth evasions (MIT, github.com/berstend/
// puppeteer-extra). We hand-roll equivalents here rather than ship the
// plugin as a dependency for three reasons:
//
//   1. We need them to apply to a connectOverCDP-attached browser, not
//      a Playwright-launched one. The plugin's lifecycle hooks expect
//      launch-time integration; the connect path doesn't fire all hooks
//      cleanly. Hand-rolled scripts work uniformly via addInitScript.
//   2. The full plugin pulls in puppeteer-extra core and per-evasion
//      modules — ~60 files for what we actually need (~150 LOC).
//   3. We want the evasion set to be visible in the soft-fork rather
//      than buried in node_modules — anti-bot detection drift is real
//      and we want code review on every patch, not a `^` range bump.
//
// Maintenance cadence is documented in
// designs/browser-residential-proxy.md §Stealth-plugin maintenance:
// quarterly review against bot.sannysoft.com + reactive updates on
// regression reports.
//
// ── Critical companion ─────────────────────────────────────────────
// Beyond these document-init scripts, Chromium must be launched with
// `--disable-blink-features=AutomationControlled` (see chrome.ts
// buildOpenClawChromeLaunchArgs). That flag removes the C++-level
// AutomationControlled blink feature that exposes navigator.webdriver
// before any JS runs. Without that flag, navigator.webdriver appears
// briefly true on initial page parse before our init script runs —
// enough for a server-side script-tag check to detect.

const STEALTH_INIT_SCRIPT = `
(() => {
  // Helper: defineProperty with try/catch so a single failed evasion
  // doesn't abort the rest. Anti-bot pages sometimes pre-define some
  // of these properties as non-configurable; we silently skip those.
  const safeDefine = (obj, prop, descriptor) => {
    try {
      Object.defineProperty(obj, prop, descriptor);
    } catch {
      // Property already non-configurable; nothing to do.
    }
  };

  // ── 1. navigator.webdriver — the chief telltale ──
  // Headless sets this to true. Real Chrome leaves it undefined.
  // Even with --disable-blink-features=AutomationControlled, some
  // Chromium versions still expose it; defensive override here.
  safeDefine(Navigator.prototype, 'webdriver', { get: () => undefined });

  // ── 2. window.chrome.* — must exist on real Chrome ──
  // Headless doesn't populate these; anti-bot checks for their presence.
  if (!window.chrome) {
    safeDefine(window, 'chrome', { value: {}, writable: true, configurable: true });
  }
  // chrome.runtime: empty object suffices for "is it there" checks.
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
      OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
      PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
      PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
      PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WINDOWS: 'win' },
      RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
    };
  }
  // chrome.app: present on desktop Chrome; missing in headless.
  if (!window.chrome.app) {
    window.chrome.app = {
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      getDetails: () => null,
      getIsInstalled: () => false,
      isInstalled: false,
    };
  }
  // chrome.csi(): legacy timing API still probed by older anti-bot scripts.
  if (typeof window.chrome.csi !== 'function') {
    window.chrome.csi = function () {
      return {
        onloadT: Date.now(),
        pageT: performance.now(),
        startE: Date.now() - 100,
        tran: 15,
      };
    };
  }
  // chrome.loadTimes(): deprecated but still probed.
  if (typeof window.chrome.loadTimes !== 'function') {
    window.chrome.loadTimes = function () {
      return {
        commitLoadTime: Date.now() / 1000 - 1,
        connectionInfo: 'h2',
        finishDocumentLoadTime: Date.now() / 1000 - 0.5,
        finishLoadTime: Date.now() / 1000 - 0.4,
        firstPaintAfterLoadTime: 0,
        firstPaintTime: Date.now() / 1000 - 0.3,
        navigationType: 'Other',
        npnNegotiatedProtocol: 'h2',
        requestTime: Date.now() / 1000 - 1.2,
        startLoadTime: Date.now() / 1000 - 1.1,
        wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
      };
    };
  }

  // ── 3. navigator.plugins — empty in headless ──
  // Real desktop Chrome exposes a non-empty PluginArray (PDF Viewer at
  // minimum). Anti-bot treats length=0 as a strong headless signal.
  // Build a fake PluginArray that returns realistic items.
  const pluginData = [
    { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
  ];
  const fakePlugins = pluginData.map((p) => Object.assign(Object.create(Plugin.prototype), p));
  fakePlugins.forEach((plugin) => {
    plugin[0] = Object.assign(Object.create(MimeType.prototype), {
      type: 'application/pdf',
      suffixes: 'pdf',
      description: 'Portable Document Format',
      enabledPlugin: plugin,
    });
    plugin.length = 1;
    plugin.item = (i) => plugin[i];
    plugin.namedItem = (name) => (plugin[0].type === name ? plugin[0] : null);
  });
  const pluginArray = Object.create(PluginArray.prototype);
  fakePlugins.forEach((plugin, i) => {
    pluginArray[i] = plugin;
    pluginArray[plugin.name] = plugin;
  });
  Object.defineProperty(pluginArray, 'length', { get: () => fakePlugins.length });
  pluginArray.item = (i) => pluginArray[i];
  pluginArray.namedItem = (name) => pluginArray[name];
  pluginArray.refresh = () => {};
  safeDefine(Navigator.prototype, 'plugins', { get: () => pluginArray });

  // ── 4. navigator.languages — empty array in headless ──
  // Real Chrome reports the user's preferred language list.
  safeDefine(Navigator.prototype, 'languages', { get: () => ['en-US', 'en'] });

  // ── 5. navigator.permissions.query — wrong state in headless ──
  // Headless returns 'denied' for notifications even when API is available.
  // Real Chrome returns 'prompt' in default state. Patch the Permissions
  // API so notifications/clipboard checks behave like real Chrome.
  if (navigator.permissions && navigator.permissions.query) {
    const originalQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (parameters) => {
      if (parameters && parameters.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission, name: 'notifications', onchange: null });
      }
      return originalQuery(parameters);
    };
  }

  // ── 6. navigator.hardwareConcurrency — reports 1 in headless ──
  // Real desktop Chrome reports the actual core count, typically 4-16.
  // 8 is a defensible middle ground that doesn't reveal the actual
  // VM CPU shape.
  safeDefine(Navigator.prototype, 'hardwareConcurrency', { get: () => 8 });

  // ── 7. navigator.deviceMemory — undefined in headless ──
  // Modern Chrome exposes this as 0.25/0.5/1/2/4/8 (rounded for privacy).
  safeDefine(Navigator.prototype, 'deviceMemory', { get: () => 8 });

  // ── 8. navigator.vendor — usually correct but defensive override ──
  safeDefine(Navigator.prototype, 'vendor', { get: () => 'Google Inc.' });

  // ── 9. WebGL.vendor / WebGL.renderer ──
  // Headless reports 'Google Inc.' / 'Google SwiftShader' (the software
  // rasterizer). Real Chrome on a real GPU reports the actual hardware.
  // Spoof to a common Intel UHD configuration so the fingerprint
  // matches a typical consumer machine rather than a server. Apply to
  // both WebGL and WebGL2 contexts; the param ids 37445/37446 are
  // UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL.
  const patchWebGLContext = (proto) => {
    if (!proto || !proto.getParameter) return;
    const original = proto.getParameter;
    proto.getParameter = function (parameter) {
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return original.call(this, parameter);
    };
  };
  if (typeof WebGLRenderingContext !== 'undefined') patchWebGLContext(WebGLRenderingContext.prototype);
  if (typeof WebGL2RenderingContext !== 'undefined') patchWebGLContext(WebGL2RenderingContext.prototype);

  // ── 10. iframe.contentWindow proxy ──
  // Headless leaves a few tells in cross-origin iframes; the most
  // common is HTMLIFrameElement.prototype.contentWindow returning a
  // window with undefined chrome.app. We patched chrome.app above on
  // the top window, but iframes get fresh contexts. Hooking into the
  // iframe attach lifecycle is non-trivial from JS; an alternative
  // patch is to override the prototype's getter to return a Proxy that
  // re-applies our patches on access. For v1 we accept the residual
  // iframe gap — most anti-bot checks happen on the top window.

  // ── 11. window.outerWidth / outerHeight — 0 in headless ──
  // Real browsers report the OS window dimensions, including chrome
  // (browser UI). Match innerWidth/Height when 0 (won't be perfect for
  // sites that compare outer > inner, but acceptable).
  if (!window.outerWidth) safeDefine(window, 'outerWidth', { get: () => window.innerWidth });
  if (!window.outerHeight) safeDefine(window, 'outerHeight', { get: () => window.innerHeight + 85 });
})();
`.trim();

export const STEALTH_EVASIONS_SCRIPT: string = STEALTH_INIT_SCRIPT;
