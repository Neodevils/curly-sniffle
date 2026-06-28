      window.__fireWaterIsAbortError = (error) => {
        return error?.name === "AbortError" || String(error?.message || error).toLowerCase().includes("aborted");
      };

      window.addEventListener(
        "unhandledrejection",
        (event) => {
          if (window.__fireWaterIsAbortError(event.reason)) {
            event.preventDefault();
          }
        },
        true
      );

      window.addEventListener(
        "error",
        (event) => {
          const message = String(event.message || event.error?.message || "");
          if (message.includes("Could not find a View Model linked to Artboard BaseGlowRemapped")) {
            event.preventDefault();
          }
        },
        true
      );

      const BLOCKED_FLASH_URL_HOSTS = new Set(["server.cpmstar.com"]);
      const nativeFetch = window.fetch.bind(window);
      const emptySwfResponse = () =>
        new Response(new Uint8Array(), {
          status: 200,
          headers: {
            "content-type": "application/x-shockwave-flash"
          }
        });

      function blockedFlashUrl(input) {
        const rawUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input instanceof Request
                ? input.url
                : input?.url || String(input || "");

        try {
          return BLOCKED_FLASH_URL_HOSTS.has(new URL(rawUrl, window.location.href).hostname);
        } catch {
          return rawUrl.includes("server.cpmstar.com");
        }
      }

      window.fetch = (input, init) => {
        if (blockedFlashUrl(input)) {
          return Promise.resolve(emptySwfResponse());
        }

        return nativeFetch(input, init);
      };

      window.RufflePlayer = window.RufflePlayer || {};
      window.RufflePlayer.config = {
        autoplay: "on",
        unmuteOverlay: "hidden",
        contextMenu: false,
        letterbox: "fullscreen",
        scale: "showAll",
        allowScriptAccess: true,
        warnOnUnsupportedContent: true
      };
