// Classic script: runs even if the Preact module fails to load or execute.
(function () {
  var shown = false;
  function showFailure() {
    var root = document.getElementById("root");
    if (shown || !root || root.firstElementChild) return;
    shown = true;
    var box = document.createElement("div");
    box.id = "rendererLoadFailure";
    box.setAttribute("role", "alert");
    box.style.cssText = "max-width:40rem;margin:12vh auto;padding:16px 20px;border:1px solid #c62828;border-radius:8px;font:14px/1.5 system-ui,sans-serif";
    box.textContent = "OpenSand could not start the new interface. Reload this window. If it keeps failing, restart OpenSand with OPENSAND_RENDERER=legacy to use the classic interface.";
    document.body.appendChild(box);
  }
  addEventListener("error", showFailure, true);
  addEventListener("unhandledrejection", showFailure);
  setTimeout(showFailure, 4000);
})();
